// Original Markdown is the guide authority. This module owns locked own-file
// mutations, bounded collection and the mechanical receipt/recovery journal.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  RuntimeError, readRegular, inspectRegular, decodeRecord, listDirectory,
  safeSessionId, withSessionLock, atomicWrite,
} from './runtime/storage.mjs';
import { assertReceiptFresh, resolveWorkspaceBinding, validateReceiptShape } from './runtime/host.mjs';
import {
  PLUGIN, CHECKPOINT_ID, validNoteId, noteRecord, slugifyTitle,
  renderNoteFile, sha256Hex,
} from './agent-state-core.mjs';

export const MAX_GUIDES_PER_SESSION = 512;
export const MAX_COLLECTED_GUIDES = 1024;
export const MAX_GUIDE_HASH_BYTES = 256 * 1024;
export const MAX_EVENT_HASH_BYTES = 256 * 1024 * 1024;
export const MAX_GUIDE_PREFIX_BYTES = 80000;
export const MAX_OPERATION_RECORDS = 1024;
export const MAX_STATE_BYTES = 2 * 1024 * 1024;
export const STATE_FILENAME = '.agent-state.json';
export const INDEX_FILENAME = '.guide-locators.json';
const HASH = /^[a-f0-9]{64}$/u;
const OPERATIONS = new Set(['agent_state_note', 'agent_state_checkpoint']);
const OUTCOME_STATUSES = new Set(['committed', 'unchanged', 'rejected', 'unavailable', 'partial', 'uncertain']);
const validId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/u.test(value);
const safeCode = (error) => typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/u.test(error.code) ? error.code : 'GUIDE_STORAGE_UNAVAILABLE';
function metadataPrefix(value, limit) {
  const prefix = value.slice(0, limit);
  return prefix.isWellFormed() ? prefix : prefix.slice(0, -1);
}

export function stateRoot(identity) {
  if (identity.plugin !== PLUGIN || typeof identity.pluginDataDir !== 'string') {
    throw new RuntimeError('GUIDE_IDENTITY_UNAVAILABLE', 'trusted guide plugin identity is required');
  }
  return join(identity.pluginDataDir, 'agent-state');
}

export function sessionDir(identity, sessionId = identity.sessionId) {
  return join(stateRoot(identity), 'sessions', safeSessionId(sessionId));
}

export function parseHeader(content) {
  const empty = { shared: false, title: null, updated: null };
  const lines = content.split('\n');
  const first = lines.findIndex((line) => line.trim());
  if (first < 0) return empty;
  const flag = /^\s*shared\s*:\s*(true|false)\s*$/iu.exec(lines[first]);
  if (!flag) return empty;
  const result = { ...empty, shared: flag[1].toLowerCase() === 'true' };
  for (let i = first + 1; i < Math.min(lines.length, first + 6); i += 1) {
    const title = /^\s*title\s*:\s*(.+?)\s*$/iu.exec(lines[i]);
    const updated = /^\s*updated\s*:\s*(.+?)\s*$/iu.exec(lines[i]);
    if (title) result.title = metadataPrefix(title[1], 200);
    else if (updated) result.updated = metadataPrefix(updated[1], 100);
    else break;
  }
  return result;
}

export function bodyOf(content) {
  const lines = content.split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i += 1;
  if (/^\s*shared\s*:\s*(true|false)\s*$/iu.test(lines[i] ?? '')) {
    i += 1;
    while (/^\s*(title|updated)\s*:/iu.test(lines[i] ?? '')) i += 1;
    if (lines[i]?.trim() === '---') i += 1;
  }
  return lines.slice(i).join('\n').trimEnd();
}

export function sessionFileNames(dir) {
  const entries = listDirectory(dir, 4096) ?? [];
  const names = entries.filter((entry) => !entry.name.startsWith('.') && entry.name.endsWith('.md') && !entry.isDirectory())
    .map((entry) => entry.name).sort();
  if (names.length > MAX_GUIDES_PER_SESSION) {
    throw new RuntimeError('GUIDE_FILE_COUNT_LIMIT', 'session exceeds 512 guide files', { path: dir });
  }
  return names;
}

function inspectGuide(file, prefixBytes = MAX_GUIDE_PREFIX_BYTES) {
  return inspectRegular(file, { prefixBytes, maxHashBytes: MAX_GUIDE_HASH_BYTES });
}

function emptyDelivery() {
  return {
    basis: 'completed_post_tool_use_v1', epoch: 0, completedOtherCalls: 0,
    lastDigest: null, lastPresentationKey: null, refreshDue: true, seenTools: [],
  };
}

function validateState(state, identity) {
  if (!state || state.version !== 1 || state.sessionId !== identity.sessionId || !state.binding ||
      !Array.isArray(state.operations) || state.operations.length > MAX_OPERATION_RECORDS) {
    throw new RuntimeError('GUIDE_STATE_INVALID', 'guide mechanical state is invalid');
  }
  const d = state.delivery;
  if (!d || d.basis !== 'completed_post_tool_use_v1' || !Number.isSafeInteger(d.epoch) || d.epoch < 0 ||
      !Number.isSafeInteger(d.completedOtherCalls) || d.completedOtherCalls < 0 ||
      !(d.lastDigest === null || HASH.test(d.lastDigest)) ||
      !(d.lastPresentationKey === null || HASH.test(d.lastPresentationKey)) || typeof d.refreshDue !== 'boolean' ||
      !Array.isArray(d.seenTools) || d.seenTools.length > 1024 || d.seenTools.some((v) => typeof v !== 'string' || !HASH.test(v))) {
    throw new RuntimeError('GUIDE_STATE_INVALID', 'guide delivery state is invalid');
  }
  const toolIds = new Set();
  const receiptIds = new Set();
  for (const op of state.operations) {
    if (!op || !validId(op.toolUseId) || !validId(op.receiptId) || !HASH.test(op.inputDigest) ||
        !OPERATIONS.has(op.operation) || !Number.isSafeInteger(op.createdAt) || op.createdAt < 0 ||
        !['pending', 'completed'].includes(op.state) || toolIds.has(op.toolUseId) || receiptIds.has(op.receiptId)) {
      throw new RuntimeError('GUIDE_STATE_INVALID', 'guide receipt journal is invalid');
    }
    try {
      validateReceiptShape({ receiptVersion: 1, status: 'pending_host_commit', plugin: PLUGIN,
        operation: op.operation, receiptId: op.receiptId, createdAt: op.createdAt, inputDigest: op.inputDigest });
    } catch { throw new RuntimeError('GUIDE_STATE_INVALID', 'guide persisted receipt is invalid'); }
    toolIds.add(op.toolUseId); receiptIds.add(op.receiptId);
    if (op.state === 'pending') {
      if (!validNoteId(op.note_id) || !HASH.test(op.intendedDigest) ||
          !(op.beforeDigest === null || HASH.test(op.beforeDigest)) || typeof op.beforeMissing !== 'boolean') {
        throw new RuntimeError('GUIDE_STATE_INVALID', 'guide pending target is invalid');
      }
    } else if (!op.outcome || !OUTCOME_STATUSES.has(op.outcome.status) || typeof op.outcome.committed !== 'boolean' ||
        (op.outcome.note_id !== undefined && !validNoteId(op.outcome.note_id)) ||
        (op.outcome.committed && (!validNoteId(op.outcome.note_id) || !['committed', 'unchanged', 'partial'].includes(op.outcome.status))) ||
        typeof op.outcome.code !== 'string' || !/^[A-Z0-9_]{1,80}$/u.test(op.outcome.code) ||
        !Number.isSafeInteger(op.completedAt) || op.completedAt < 0) {
      throw new RuntimeError('GUIDE_STATE_INVALID', 'guide completed outcome is invalid');
    }
  }
  return state;
}

function loadState(dir, identity, lineage) {
  const file = join(dir, STATE_FILENAME);
  const old = readRegular(file, MAX_STATE_BYTES);
  let state;
  if (!old) {
    state = { version: 1, sessionId: identity.sessionId, binding: null, operations: [], delivery: emptyDelivery() };
  } else {
    try { state = validateState(JSON.parse(decodeRecord(old)), identity); }
    catch (error) {
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError('GUIDE_STATE_INVALID', 'guide mechanical state is unreadable', { path: file });
    }
  }
  state.binding = resolveWorkspaceBinding(state.binding, identity, lineage);
  return state;
}

export async function withGuideSession(identity, lineage, action) {
  const dir = sessionDir(identity);
  return withSessionLock(dir, async () => {
    const state = loadState(dir, identity, lineage);
    const context = {
      identity, lineage, dir, state,
      persist() {
        const bytes = Buffer.from(`${JSON.stringify(state)}\n`);
        if (bytes.length > MAX_STATE_BYTES) {
          throw new RuntimeError('GUIDE_STATE_LIMIT', 'guide mechanical state bound reached', { path: join(dir, STATE_FILENAME) });
        }
        return atomicWrite(join(dir, STATE_FILENAME), bytes);
      },
    };
    return action(context);
  });
}

function materializeOutcome(context, outcome) {
  return { ...outcome, ...(outcome.note_id ? { path: join(context.dir, outcome.note_id) } : {}) };
}

function completeOperation(context, operation, outcome, now) {
  operation.state = 'completed';
  operation.completedAt = now;
  operation.outcome = outcome;
  delete operation.beforeDigest;
  delete operation.beforeMissing;
  delete operation.intendedDigest;
  delete operation.note_id;
  if (outcome.committed) context.state.delivery.refreshDue = true;
}

// Recovery runs before admission/expiry/reclamation and before another save can
// overwrite a pending target. It observes the authoritative file, never repeats
// a mutation. Unknown content leaves the pending record retained and blocks saves.
export function recoverPendingOperations(context, now = Date.now()) {
  const unresolved = [];
  let changed = false;
  for (const operation of context.state.operations) {
    if (operation.state !== 'pending') continue;
    const file = join(context.dir, operation.note_id);
    let current;
    try { current = inspectGuide(file, 0); }
    catch (error) {
      unresolved.push({ code: safeCode(error), path: file });
      continue;
    }
    if (current?.hashComplete && current.hash === operation.intendedDigest) {
      completeOperation(context, operation, { status: 'committed', committed: true, note_id: operation.note_id, code: 'GUIDE_SAVE_RECOVERED' }, now);
      changed = true;
    } else if ((!current && operation.beforeMissing) ||
        (current?.hashComplete && operation.beforeDigest !== null && current.hash === operation.beforeDigest)) {
      completeOperation(context, operation, { status: 'unavailable', committed: false, code: 'INTERRUPTED_SAVE_NOT_RETAINED' }, now);
      changed = true;
    } else {
      unresolved.push({ code: 'GUIDE_RECOVERY_CONFLICT', path: file });
    }
  }
  if (changed) {
    try { context.persist(); }
    catch {
      context.recoveryPersistFailed = true;
      unresolved.push({ code: 'GUIDE_RECOVERY_JOURNAL_UNAVAILABLE', path: join(context.dir, STATE_FILENAME) });
    }
  }
  return unresolved;
}

function selectTarget(context, record) {
  const names = sessionFileNames(context.dir);
  let name = record.note_id;
  let before;
  if (record.checkpoint) {
    name = CHECKPOINT_ID;
    before = inspectGuide(join(context.dir, name), MAX_GUIDE_HASH_BYTES);
  } else if (name) {
    before = inspectGuide(join(context.dir, name), MAX_GUIDE_HASH_BYTES);
    if (!before) {
      throw new RuntimeError('GUIDE_NOTE_NOT_FOUND', 'note_id is not an existing own regular guide', { status: 'rejected' });
    }
  } else {
    const slug = slugifyTitle(record.title);
    for (let i = 1; i <= 99; i += 1) {
      const candidate = `${slug}${i === 1 ? '' : `-${i}`}.md`;
      const current = inspectGuide(join(context.dir, candidate), MAX_GUIDE_HASH_BYTES);
      if (!current || (current.hashComplete && sha256Hex(bodyOf(decodeRecord(current))) === record.bodyHash)) {
        name = candidate; before = current; break;
      }
    }
    if (!name) {
      throw new RuntimeError('GUIDE_TITLE_COLLISION_LIMIT', 'title collision limit reached; use an exact own note_id', { status: 'rejected' });
    }
  }
  if (!before && !names.includes(name) && names.length >= MAX_GUIDES_PER_SESSION) {
    throw new RuntimeError('GUIDE_FILE_COUNT_LIMIT', 'session has reached 512 guide files', { status: 'rejected', path: context.dir });
  }
  return { name, before };
}

function rejected(error) {
  return { status: error?.status === 'rejected' ? 'rejected' : 'unavailable', committed: false, code: safeCode(error) };
}

export function executeGuideOperation(context, { receipt, operation, args }, now = Date.now()) {
  const unresolved = recoverPendingOperations(context, now);
  const toolUseId = context.identity.toolUseId;
  if (!validId(toolUseId)) throw new RuntimeError('GUIDE_TOOL_ID_UNAVAILABLE', 'trusted tool-use identity is required');
  const old = context.state.operations.find((item) => item.toolUseId === toolUseId || item.receiptId === receipt.receiptId);
  if (old) {
    if (old.toolUseId !== toolUseId || old.receiptId !== receipt.receiptId || old.inputDigest !== receipt.inputDigest || old.operation !== operation || old.createdAt !== receipt.createdAt) {
      return { status: 'rejected', committed: false, code: 'GUIDE_RECEIPT_REUSE_CONFLICT' };
    }
    if (old.state === 'completed') return {
      ...materializeOutcome(context, old.outcome), replayed: true,
      ...(context.recoveryPersistFailed ? { status: old.outcome.committed ? 'partial' : 'unavailable', recoveryRequired: true } : {}),
    };
    return { status: 'uncertain', committed: false, code: 'GUIDE_RECOVERY_CONFLICT', path: join(context.dir, old.note_id), pending: true };
  }
  if (unresolved.length) {
    return { status: 'unavailable', committed: false, code: 'GUIDE_PENDING_RECOVERY_REQUIRED', path: unresolved[0].path };
  }
  try { assertReceiptFresh(receipt, { now }); }
  catch (error) { return { ...rejected(error), code: safeCode(error), notAdmitted: true }; }
  // Only expired completed records can be reclaimed, and only when capacity
  // requires it. Pending records have already been recovered or blocked above.
  if (context.state.operations.length >= MAX_OPERATION_RECORDS) {
    context.state.operations = context.state.operations.filter((item) =>
      item.state !== 'completed' || now - item.createdAt <= 65000);
  }
  if (context.state.operations.length >= MAX_OPERATION_RECORDS) {
    return { status: 'unavailable', committed: false, code: 'GUIDE_OPERATION_LIMIT' };
  }
  const entry = { toolUseId, receiptId: receipt.receiptId, inputDigest: receipt.inputDigest, operation, createdAt: receipt.createdAt, state: 'pending' };
  let target;
  let contents;
  try {
    const record = noteRecord(operation, args);
    target = selectTarget(context, record);
    contents = renderNoteFile(record, now);
  } catch (error) {
    completeOperation(context, entry, rejected(error), now);
    context.state.operations.push(entry);
    context.persist();
    return materializeOutcome(context, entry.outcome);
  }
  entry.note_id = target.name;
  entry.beforeDigest = target.before?.hashComplete ? target.before.hash : null;
  entry.beforeMissing = !target.before;
  entry.intendedDigest = sha256Hex(contents);
  context.state.operations.push(entry);
  // The chosen target must be recoverable before the authoritative file changes.
  context.persist();
  const file = join(context.dir, target.name);
  let outcome;
  try {
    const result = atomicWrite(file, contents);
    outcome = { status: result.status, committed: true, note_id: target.name, code: 'GUIDE_SAVED' };
  } catch (error) {
    if (error?.committed) {
      try {
        const current = inspectGuide(file, 0);
        if (current?.hashComplete && current.hash === entry.intendedDigest) {
          outcome = { status: 'partial', committed: true, note_id: target.name, code: 'GUIDE_COMMITTED_WITH_DURABILITY_WARNING' };
        }
      } catch { /* The pending record remains the recovery authority. */ }
      if (!outcome) return { status: 'uncertain', committed: false, code: 'GUIDE_WRITE_REQUIRES_RECOVERY', path: file, pending: true };
    } else outcome = rejected(error);
  }
  completeOperation(context, entry, outcome, now);
  try { context.persist(); }
  catch {
    return { ...materializeOutcome(context, outcome), status: outcome.committed ? 'partial' : 'unavailable', code: 'GUIDE_RECEIPT_REFRESH_FAILED', recoveryRequired: true };
  }
  return materializeOutcome(context, outcome);
}

// The native adapter supplies one current child/parent snapshot. No cached
// parent, model field, shared cwd, history scan or global pointer is consulted.
export function collectGuides(identity, lineage) {
  const files = [];
  const issues = [];
  let hashedBytes = 0;
  const collect = (sessionId, origin, sharedOnly) => {
    const dir = sessionDir(identity, sessionId);
    let names;
    try { names = sessionFileNames(dir); }
    catch (error) { issues.push({ code: safeCode(error), path: dir, origin }); return; }
    for (const name of names) {
      const file = join(dir, name);
      let record;
      try {
        record = inspectGuide(file);
        if (!record) throw new RuntimeError('GUIDE_DISAPPEARED', 'guide disappeared during collection');
        hashedBytes += record.hashComplete ? record.size : 0;
        if (hashedBytes > MAX_EVENT_HASH_BYTES) throw new RuntimeError('GUIDE_EVENT_HASH_LIMIT', 'guide event hash bound reached');
        const content = decodeRecord(record);
        const header = parseHeader(content);
        if (sharedOnly && !header.shared) continue;
        files.push({
          name, path: file, origin, sessionId, ...header, content, bytes: record.size,
          hash: record.hashComplete ? record.hash : null, hashComplete: record.hashComplete,
          partial: record.partial, status: record.hashComplete ? 'available' : 'freshness_unavailable',
        });
        if (!record.hashComplete) issues.push({ code: 'GUIDE_FILE_HASH_LIMIT', path: file, origin });
      } catch (error) {
        // An unreadable parent header cannot grant sharing. Reveal only the
        // already-verified parent directory, never an unverified private note
        // locator. Own unreadable originals retain their exact file locators.
        issues.push({ code: safeCode(error), path: sharedOnly ? dir : file, origin });
        if (!sharedOnly) files.push({ name, path: file, origin, sessionId, shared: false, title: null, updated: null, content: '', bytes: record?.size ?? null, hash: null, hashComplete: false, partial: true, status: 'unavailable' });
      }
    }
  };
  collect(identity.sessionId, 'own', false);
  if (lineage?.status === 'ok' && lineage.currentVerified === true && lineage.current?.sessionId === identity.sessionId && lineage.current.workspaceDir === identity.workspaceDir) {
    const parentId = lineage.current.parentSessionId;
    if (parentId && lineage.parent?.sessionId === parentId && parentId !== identity.sessionId) collect(parentId, 'parent', true);
    else if (parentId) issues.push({ code: 'GUIDE_PARENT_UNAVAILABLE', path: sessionDir(identity, parentId), origin: 'parent' });
  } else {
    issues.push({ code: lineage?.code ?? 'NATIVE_LINEAGE_UNAVAILABLE', path: lineage?.path ?? identity.pluginDataDir, origin: 'lineage' });
  }
  if (files.length > MAX_COLLECTED_GUIDES) throw new RuntimeError('GUIDE_COLLECTION_LIMIT', 'guide collection exceeds 1024 files');
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(JSON.stringify([file.path, file.name, file.shared, file.title, file.bytes, file.hash, file.hashComplete]));
    hash.update('\0');
  }
  const complete = issues.length === 0 && files.every((file) => file.hashComplete);
  const contentFingerprint = hash.digest('hex');
  const presentationKey = sha256Hex(JSON.stringify([
    complete, contentFingerprint,
    files.filter((file) => !file.hashComplete).map((file) => [file.path, file.bytes, sha256Hex(file.content)]),
    issues.map((issue) => [issue.code, issue.path]),
  ]));
  return { files, issues, complete, digest: complete ? contentFingerprint : null, presentationKey, hashedBytes };
}
