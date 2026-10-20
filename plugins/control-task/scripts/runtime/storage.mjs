// Canonical shared Linux storage boundary. Generated plugin copies are made by
// scripts/sync-plugin-runtime.mjs; edit this source, never an installed copy.
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';

export const MAX_STORAGE_BYTES = 16 * 1024 * 1024;
export const MAX_DIAGNOSTIC_BYTES = 512;
export const MAX_LOG_BYTES = 128 * 1024;

export class RuntimeError extends Error {
  constructor(code, message, { status = 'unavailable', path, committed = false, phase,
    retryable = false, systemCode, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'RuntimeError';
    Object.assign(this, { code, status, committed, retryable });
    if (path !== undefined) this.path = path;
    if (phase !== undefined) this.phase = phase;
    if (systemCode !== undefined) this.systemCode = systemCode;
  }
}

export function safeSessionId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,200}$/.test(value) || value === '.' || value === '..') {
    throw new RuntimeError('INVALID_IDENTITY', 'Invalid native session identifier.', { status: 'rejected' });
  }
  return value;
}

export function safeAbsolutePath(value) {
  if (typeof value !== 'string' || !value.isWellFormed() || value.length > 8192 ||
      !isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value) || value.split('/').includes('..')) {
    throw new RuntimeError('UNSAFE_PATH', 'An absolute, bounded path without traversal is required.');
  }
  return normalize(value);
}

function storageError(error, code, path, extra = {}) {
  if (error instanceof RuntimeError && !Object.hasOwn(extra, 'committed')) return error;
  return new RuntimeError(code, extra.committed
    ? 'The file replacement occurred, but its final durability or verification is uncertain.'
    : 'The storage operation could not complete.', {
    path, systemCode: typeof error?.code === 'string' ? error.code : undefined, ...extra, cause: error,
  });
}

// Linux has no openat API in Node. Resolve each directory relative to a pinned
// descriptor through procfs, with O_NOFOLLOW at every step. A rename or symlink
// replacement cannot redirect subsequent file access to another directory.
function openDirectory(directory, create = false) {
  const path = safeAbsolutePath(directory);
  let fd;
  try {
    fd = fs.openSync('/', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    for (const part of path.split('/').filter(Boolean)) {
      const next = `/proc/self/fd/${fd}/${part}`;
      if (create) {
        try { fs.mkdirSync(next, { mode: 0o700 }); fs.fsyncSync(fd); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      const child = fs.openSync(next, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      fs.closeSync(fd);
      fd = child;
    }
    return fd;
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    if (!create && error.code === 'ENOENT') return null;
    throw storageError(error, ['ELOOP', 'ENOTDIR'].includes(error.code) ? 'UNSAFE_DIRECTORY' : 'DIRECTORY_UNAVAILABLE', path);
  }
}

export function safeDirectory(directory) {
  const fd = openDirectory(directory, true);
  fs.closeSync(fd);
}

export function existingDirectory(directory) {
  const fd = openDirectory(directory);
  if (fd === null) return false;
  fs.closeSync(fd);
  return true;
}

function boundedSize(value, maximum = MAX_STORAGE_BYTES) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RuntimeError('INVALID_BOUND', 'The storage byte bound is invalid.', { status: 'rejected' });
  }
  return value;
}

function openRegularAt(directoryFd, name, location) {
  let fd;
  try {
    fd = fs.openSync(`/proc/self/fd/${directoryFd}/${name}`,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile()) throw new RuntimeError('NOT_REGULAR_FILE', 'The storage entry is not a regular file.', { path: location });
    return { fd, stat };
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    if (error.code === 'ENOENT') return null;
    throw storageError(error, error.code === 'ELOOP' ? 'UNSAFE_FILE' : 'FILE_UNAVAILABLE', location);
  }
}

function unchangedStat(before, after) {
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => before[key] === after[key]);
}

function inspectAt(directoryFd, name, location, { prefixBytes, maxHashBytes, prefix, hash }) {
  const opened = openRegularAt(directoryFd, name, location);
  if (opened === null) return null;
  const { fd, stat } = opened;
  try {
    if (stat.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new RuntimeError('FILE_TOO_LARGE', 'The file size is unsupported.', { path: location });
    const size = Number(stat.size);
    if (!prefix && size > prefixBytes) throw new RuntimeError('FILE_TOO_LARGE', 'The file exceeds the bounded read size.', { path: location });
    const bytes = Buffer.alloc(Math.min(size, prefixBytes));
    const hashComplete = hash && size <= maxHashBytes;
    const hasher = hashComplete ? createHash('sha256') : null;
    const readBytes = hashComplete ? size : bytes.length;
    const chunk = Buffer.alloc(Math.min(readBytes, 64 * 1024));
    let offset = 0;
    while (offset < readBytes) {
      const count = fs.readSync(fd, chunk, 0, Math.min(chunk.length, readBytes - offset), offset);
      if (!count) throw new RuntimeError('FILE_CHANGED', 'The file changed during its bounded read.', { path: location, retryable: true });
      if (offset < bytes.length) chunk.copy(bytes, offset, 0, Math.min(count, bytes.length - offset));
      hasher?.update(chunk.subarray(0, count));
      offset += count;
    }
    if (!unchangedStat(stat, fs.fstatSync(fd, { bigint: true }))) {
      throw new RuntimeError('FILE_CHANGED', 'The file changed during its bounded read.', { path: location, retryable: true });
    }
    return { bytes, size, partial: bytes.length < size,
      ...(hash ? { hash: hasher?.digest('hex') ?? null, hashComplete } : {}) };
  } finally { fs.closeSync(fd); }
}

function withFileParent(path, action, create = false) {
  const location = safeAbsolutePath(path);
  const fd = openDirectory(dirname(location), create);
  if (fd === null) return null;
  try { return action(fd, basename(location), location); }
  finally { fs.closeSync(fd); }
}

/** null means ENOENT only. Every unsafe/unreadable/oversized file throws. */
export function readRegular(path, limit = MAX_STORAGE_BYTES, { prefix = false } = {}) {
  boundedSize(limit);
  return withFileParent(path, (fd, name, location) => inspectAt(fd, name, location,
    { prefixBytes: limit, maxHashBytes: 0, prefix, hash: false }));
}

/** Keep the safely opened inode alive through an asynchronous native adapter. */
export async function withRegularDescriptor(path, action) {
  const location = safeAbsolutePath(path);
  const directoryFd = openDirectory(dirname(location));
  if (directoryFd === null) return null;
  let opened;
  try {
    opened = openRegularAt(directoryFd, basename(location), location);
    if (opened === null) return null;
    return await action({ ...opened, path: location });
  } finally {
    if (opened) fs.closeSync(opened.fd);
    fs.closeSync(directoryFd);
  }
}

/** One stable descriptor supplies both prefix bytes and a bounded full digest. */
export function inspectRegular(path, { prefixBytes = 128 * 1024, maxHashBytes = 256 * 1024 } = {}) {
  boundedSize(prefixBytes);
  boundedSize(maxHashBytes);
  return withFileParent(path, (fd, name, location) => inspectAt(fd, name, location,
    { prefixBytes, maxHashBytes, prefix: true, hash: true }));
}

export function decodeRecord(record) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(record.bytes, { stream: record.size > record.bytes.length }); }
  catch (error) { throw new RuntimeError('INVALID_UTF8', 'The stored file is not valid UTF-8.', { cause: error }); }
}

export function listDirectory(path, limit = 4096) {
  boundedSize(limit, 4096);
  const fd = openDirectory(path);
  if (fd === null) return null;
  let directory;
  try {
    directory = fs.opendirSync(`/proc/self/fd/${fd}`);
    const entries = [];
    let entry;
    while ((entry = directory.readSync()) !== null) {
      if (entries.length === limit) throw new RuntimeError('DIRECTORY_LIMIT', 'The directory exceeds the entry bound.', { path });
      entries.push(entry);
    }
    return entries;
  } catch (error) { throw storageError(error, 'DIRECTORY_UNAVAILABLE', path); }
  finally { directory?.closeSync(); fs.closeSync(fd); }
}

function contentBytes(content) {
  if (typeof content === 'string' && !content.isWellFormed()) {
    throw new RuntimeError('INVALID_UTF8', 'A string contains an unpaired surrogate.', { status: 'rejected' });
  }
  if (typeof content !== 'string' && !Buffer.isBuffer(content) && !(content instanceof Uint8Array)) {
    throw new RuntimeError('INVALID_BYTES', 'File content must be text or bytes.', { status: 'rejected' });
  }
  if (typeof content === 'string' && Buffer.byteLength(content) > MAX_STORAGE_BYTES ||
      typeof content !== 'string' && content.byteLength > MAX_STORAGE_BYTES) {
    throw new RuntimeError('FILE_TOO_LARGE', 'The write exceeds the storage byte bound.', { status: 'rejected' });
  }
  return Buffer.isBuffer(content) ? content : Buffer.from(content);
}

function durableWrite(path, content, exclusive) {
  const bytes = contentBytes(content);
  const digest = createHash('sha256').update(bytes).digest('hex');
  return withFileParent(path, (directoryFd, name, location) => {
    const current = inspectAt(directoryFd, name, location,
      { prefixBytes: MAX_STORAGE_BYTES, maxHashBytes: 0, prefix: false, hash: false });
    if (exclusive && current !== null) return { status: 'exists', path: location, digest: createHash('sha256').update(current.bytes).digest('hex') };
    if (current?.bytes.equals(bytes)) return { status: 'unchanged', path: location, digest };
    const temporaryName = `.${name}.${process.pid}.${randomUUID()}.tmp`;
    const parent = `/proc/self/fd/${directoryFd}`;
    const temporary = `${parent}/${temporaryName}`;
    let fd;
    let committed = false;
    try {
      fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      // Refuse a destination changed to a symlink/special entry while preparing.
      inspectAt(directoryFd, name, location, { prefixBytes: MAX_STORAGE_BYTES, maxHashBytes: 0, prefix: false, hash: false });
      if (exclusive) {
        try { fs.linkSync(temporary, `${parent}/${name}`); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const existing = inspectAt(directoryFd, name, location, { prefixBytes: MAX_STORAGE_BYTES, maxHashBytes: 0, prefix: false, hash: false });
          if (!existing) throw new RuntimeError('FILE_CHANGED', 'The exclusive destination changed concurrently.', { path: location, retryable: true });
          return { status: 'exists', path: location, digest: createHash('sha256').update(existing.bytes).digest('hex') };
        }
      } else fs.renameSync(temporary, `${parent}/${name}`);
      committed = true;
      fs.fsyncSync(directoryFd);
      const verified = inspectAt(directoryFd, name, location,
        { prefixBytes: MAX_STORAGE_BYTES, maxHashBytes: 0, prefix: false, hash: false });
      if (!verified?.bytes.equals(bytes)) throw new RuntimeError('WRITE_VERIFICATION_FAILED', 'The replaced file could not be verified.', { path: location });
      return { status: 'committed', path: location, digest };
    } catch (error) {
      throw storageError(error, committed ? 'WRITE_UNCERTAIN' : 'WRITE_FAILED', location,
        { committed, status: committed ? 'uncertain' : 'unavailable', phase: committed ? 'after_rename' : 'before_rename' });
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      // Cleanup is derived state. Failure must not rewrite a committed outcome.
      try { fs.unlinkSync(temporary); } catch { /* A leftover private temp is not canonical data. */ }
    }
  }, true);
}

export function atomicWrite(path, bytes) { return durableWrite(path, bytes, false); }
export function writeExclusive(path, bytes) { return durableWrite(path, bytes, true); }

/** Cooperating writers retain the flock through the inherited open description. */
export async function withSessionLock(directory, action) {
  const directoryFd = openDirectory(directory, true);
  let fd;
  try {
    try {
      fd = fs.openSync(`/proc/self/fd/${directoryFd}/.mutex`,
        fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
      if (!fs.fstatSync(fd).isFile()) throw new RuntimeError('LOCK_UNSAFE', 'The session lock is not a regular file.', { path: directory });
      await new Promise((resolve, reject) => {
        const child = spawn('/usr/bin/flock', ['-x', '-w', '2', '-E', '75', '3'],
          { stdio: ['ignore', 'ignore', 'ignore', fd], timeout: 2500, killSignal: 'SIGKILL' });
        child.once('error', error => reject(new RuntimeError('LOCK_UNAVAILABLE', 'The util-linux flock helper could not run.', { path: directory, cause: error })));
        child.once('close', code => code === 0 ? resolve() : reject(new RuntimeError(code === 75 ? 'LOCK_BUSY' : 'LOCK_UNAVAILABLE',
          code === 75 ? 'Session storage is busy; retry the operation.' : 'The session lock helper did not acquire the lock.',
          { path: directory, retryable: code === 75 })));
      });
    } catch (error) { throw storageError(error, 'LOCK_UNAVAILABLE', directory); }
    return await action();
  } finally { if (fd !== undefined) fs.closeSync(fd); fs.closeSync(directoryFd); }
}

function shortField(value, limit) {
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '?').slice(0, limit) : undefined;
}

export function diagnosticRecord(code, context = {}) {
  const record = { at: new Date().toISOString(), code: shortField(code, 64),
    plugin: shortField(context.plugin, 40), sessionId: shortField(context.sessionId, 96),
    operation: shortField(context.operation, 64), location: shortField(context.location, 160) };
  // JSON escaping and multibyte metadata count toward the complete 512-byte line.
  while (Buffer.byteLength(JSON.stringify(record) + '\n') > MAX_DIAGNOSTIC_BYTES) {
    const longest = ['location', 'sessionId', 'operation', 'plugin'].sort((a, b) => (record[b]?.length ?? 0) - (record[a]?.length ?? 0))[0];
    if (!record[longest]) break;
    record[longest] = record[longest].slice(0, -1);
  }
  return JSON.stringify(record) + '\n';
}

export async function appendBoundedLog(directory, name, line) {
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(name) || name === '.' || name === '..' ||
      typeof line !== 'string' || !line.isWellFormed() || Buffer.byteLength(line) > MAX_DIAGNOSTIC_BYTES) {
    throw new RuntimeError('INVALID_DIAGNOSTIC', 'The diagnostic record exceeds its bounded format.', { status: 'rejected' });
  }
  return withSessionLock(directory, () => {
    const path = join(directory, name);
    const previous = readRegular(path, MAX_LOG_BYTES);
    let bytes = previous?.bytes ?? Buffer.alloc(0);
    if (bytes.length + Buffer.byteLength(line) > MAX_LOG_BYTES) {
      atomicWrite(`${path}.previous`, bytes);
      bytes = Buffer.alloc(0);
    }
    return atomicWrite(path, Buffer.concat([bytes, Buffer.from(line)]));
  });
}

/** Best effort metadata only. A diagnostic failure never masks its caller. */
export async function boundedDiagnostic(code, context = {}, { stderr = process.stderr } = {}) {
  const line = diagnosticRecord(code, context);
  try { stderr?.write(line); } catch { /* A closed stderr is not operation failure. */ }
  if (!context.logDirectory) return { status: 'stderr_only' };
  try {
    const result = await appendBoundedLog(context.logDirectory, 'runtime.log', line);
    return { ...result, status: 'recorded' };
  } catch (error) { return { status: 'stderr_only', code: error.code ?? 'DIAGNOSTIC_UNAVAILABLE', path: error.path }; }
}
