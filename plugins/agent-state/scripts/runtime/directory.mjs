// Bun 1.4.3's fs.Dir and Glob materialize whole directories before yielding.
// Keep this boundary to synchronous glibc directory calls with bounded buffers.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { endianness } from 'node:os';
import { getSystemErrorName } from 'node:util';

const require = createRequire(import.meta.url);
let native;

function directoryError(code, message, { cause, ...details } = {}) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code, ...details });
}

function loadNative() {
  if (native) return native;
  if (!process.versions.bun || process.platform !== 'linux' || process.arch !== 'x64' || endianness() !== 'LE') {
    throw directoryError('DIRECTORY_RUNTIME_UNSUPPORTED', 'The native directory reader requires Bun on Linux x64 little endian with glibc.');
  }
  let library;
  try {
    // Loading only on enumeration keeps shared imports valid in the Node host
    // harness. There is no Node or eager-directory execution fallback.
    const { dlopen, read, toArrayBuffer } = require('bun:ffi');
    library = dlopen('libc.so.6', {
      gnu_get_libc_version: { args: [], returns: 'cstring' },
      opendir: { args: ['cstring'], returns: 'ptr' },
      readdir64: { args: ['ptr'], returns: 'ptr' },
      closedir: { args: ['ptr'], returns: 'i32' },
      __errno_location: { args: [], returns: 'ptr' },
    });
    if (!/^2\.\d+(?:\.\d+)*$/.test(String(library.symbols.gnu_get_libc_version()))) {
      throw directoryError('DIRECTORY_RUNTIME_UNSUPPORTED', 'The native directory reader requires the supported GNU libc ABI.');
    }
    native = { library, symbols: library.symbols, read, toArrayBuffer };
    return native;
  } catch (error) {
    try { library?.close(); } catch { /* Preserve the capability failure. */ }
    if (error.code === 'DIRECTORY_RUNTIME_UNSUPPORTED') throw error;
    throw directoryError('DIRECTORY_RUNTIME_UNAVAILABLE', 'The native directory reader could not load its required libc symbols.', { cause: error });
  }
}

function systemError(operation, path, errno) {
  let code;
  try { code = getSystemErrorName(-errno); } catch { code = 'EIO'; }
  return directoryError(code, 'The native directory operation failed.', { errno, syscall: operation, path });
}

class DirectoryEntry {
  #type;
  #stat;
  constructor(name, type, stat) { this.name = name; this.#type = type; this.#stat = stat; }
  #is(type, method) { return this.#stat ? this.#stat[method]() : this.#type === type; }
  isFIFO() { return this.#is(1, 'isFIFO'); }
  isCharacterDevice() { return this.#is(2, 'isCharacterDevice'); }
  isDirectory() { return this.#is(4, 'isDirectory'); }
  isBlockDevice() { return this.#is(6, 'isBlockDevice'); }
  isFile() { return this.#is(8, 'isFile'); }
  isSymbolicLink() { return this.#is(10, 'isSymbolicLink'); }
  isSocket() { return this.#is(12, 'isSocket'); }
}

function copyEntry(api, pointer, path) {
  // Verified against glibc 2.39 Linux x64 headers: dirent64 has uint64 inode
  // and offset, uint16 reclen at 16, uint8 type at 18, then name at 19.
  const length = api.read.u16(pointer, 16);
  if (length < 20) throw directoryError('EIO', 'The native directory record has an invalid length.', { path });
  // uint16 bounds this copy to 65535 bytes. Do not assume sizeof(dirent64)
  // bounds records on every filesystem, or retain memory owned by readdir64.
  const record = Buffer.from(new Uint8Array(api.toArrayBuffer(pointer, 0, length)));
  const end = record.indexOf(0, 19);
  if (end <= 19) throw directoryError('EIO', 'The native directory record has an invalid name.', { path });
  const name = record.toString('utf8', 19, end);
  if (name === '.' || name === '..') return null;
  const type = record[18];
  // The caller retains its pinned parent. lstat preserves symlink identity
  // when the filesystem does not supply d_type, as a filesystem Dirent does.
  const stat = type === 0 ? fs.lstatSync(Buffer.concat([Buffer.from(`${path}/`), record.subarray(19, end)])) : null;
  return new DirectoryEntry(name, type, stat);
}

/** The caller owns safe/pinned paths and its entry limit; no pointer escapes. */
export function* iterateDirectory(path) {
  if (typeof path !== 'string' || !path.isWellFormed() || path.length > 8192 || path.includes('\0')) {
    throw directoryError('EINVAL', 'The native directory path is not a bounded C string.');
  }
  const api = loadNative();
  const errnoPointer = api.symbols.__errno_location();
  if (!errnoPointer) throw directoryError('DIRECTORY_RUNTIME_UNAVAILABLE', 'The native directory reader could not access errno.');
  const errno = new Int32Array(api.toArrayBuffer(errnoPointer, 0, 4));
  errno[0] = 0;
  const directory = api.symbols.opendir(path);
  if (!directory) throw systemError('opendir', path, api.read.i32(errnoPointer));
  let failed = false;
  try {
    for (;;) {
      errno[0] = 0;
      const pointer = api.symbols.readdir64(directory);
      if (!pointer) {
        const code = api.read.i32(errnoPointer);
        if (code) throw systemError('readdir64', path, code);
        return;
      }
      const entry = copyEntry(api, pointer, path);
      if (entry) yield entry;
    }
  } catch (error) { failed = true; throw error; }
  finally {
    const result = api.symbols.closedir(directory);
    if (result !== 0 && !failed) throw systemError('closedir', path, api.read.i32(errnoPointer));
  }
}
