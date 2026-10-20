// One session lock and one atomic record own task, input and receipt changes.
// Immutable archives retain primary text. The independent checkpoint file owns
// only continuation accounting, so an invalid task cannot reset its loop budget.
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import * as storage from './runtime/storage.mjs';
import { assertReceiptFresh, resolveWorkspaceBinding, validateReceiptShape } from './runtime/host.mjs';
import { decideOperation, parseTaskBody, validText, validateCall, TOOLS } from './control-task-core.mjs';
import { evaluateCheckpoint, validateBudget } from './control-task-checkpoint.mjs';

export { MAX_TASK_BODY, parseTaskBody } from './control-task-core.mjs';
export const STORE_VERSION = 2;
export const STORE_LIMITS = Object.freeze({ maxStateBytes: 16 * 1024 * 1024, archiveThreshold: 12 * 1024 * 1024, maxArchiveBytes: 16 * 1024 * 1024, maxArchives: 64, maxOperations: 1024 });
const MAX_PROMPT_BYTES = 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/u;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const natural = (v) => Number.isSafeInteger(v) && v >= 0;
const timestamp = (v) => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const encode = (value) => Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
const failure = (code, message, path, extra = {}) => new storage.RuntimeError(code, message, { path, ...extra });

export function taskPaths(identity) {
  const id = storage.safeSessionId(identity.sessionId);
  const directory = join(identity.pluginDataDir, 'control-task', 'sessions', id);
  return { directory, state: `${directory}.json`, legacy: join(directory, 'legacy.json'), index: join(directory, 'input-locations.json'), checkpoint: join(directory, 'checkpoint.json') };
}
function emptyState(identity, lineage) {
  return { schemaVersion: STORE_VERSION, sessionId: identity.sessionId, binding: resolveWorkspaceBinding(null, identity, lineage), taskRevision: 0, inputRevision: 0, reviewedInputRevision: 0, revisions: [], inputs: [], archives: [], operations: [], legacyBackup: null };
}
function validRevision(entry) {
  return object(entry) && natural(entry.revision) && entry.revision > 0 && parseTaskBody(entry.taskBody).ok && timestamp(entry.at) &&
    typeof entry.mutationId === 'string' && entry.mutationId.length > 0 && entry.mutationId.length <= 128 &&
    validText(entry.reason) && entry.reason.length <= 1024 && natural(entry.reviewedInputRevision);
}
function validInput(entry) {
  return object(entry) && natural(entry.inputRevision) && entry.inputRevision > 0 &&
    typeof entry.observationId === 'string' && entry.observationId.length > 0 && entry.observationId.length <= 128 &&
    validText(entry.text) && Buffer.byteLength(entry.text, 'utf8') <= MAX_PROMPT_BYTES && timestamp(entry.at) &&
    (entry.turnId === null || (validText(entry.turnId) && entry.turnId.length > 0 && entry.turnId.length <= 256 && !/[\x00-\x1f\x7f]/u.test(entry.turnId))) &&
    entry.provenance === 'native-UserPromptSubmit-observation';
}
function validReceipt(receipt) {
  try {
    // Admission age never invalidates a retained completed operation.
    validateReceiptShape(receipt);
    return receipt.plugin === 'control-task' && TOOLS.some((tool) => tool.name === receipt.operation);
  } catch { return false; }
}
function validOperation(entry, taskRevision, inputRevision) {
  const result = entry?.outcome;
  return object(entry) && entry.state === 'completed' && validReceipt(entry.receipt) &&
    validText(entry.toolUseId) && entry.toolUseId.length > 0 && entry.toolUseId.length <= 256 && !/[\x00-\x1f\x7f]/u.test(entry.toolUseId) && Number.isSafeInteger(entry.completedAt) && entry.completedAt >= 0 &&
    object(result) && ['committed', 'unchanged', 'rejected', 'current', 'not_set'].includes(result.status) &&
    natural(result.revision) && result.revision <= taskRevision && natural(result.inputRevision) && result.inputRevision <= inputRevision &&
    natural(result.reviewedInputRevision) && result.reviewedInputRevision <= result.inputRevision && result.unreviewed === result.inputRevision - result.reviewedInputRevision &&
    (result.message === undefined || (validText(result.message) && result.message.length <= 1024)) &&
    (result.code === undefined || (typeof result.code === 'string' && /^[A-Z_]{1,80}$/u.test(result.code))) &&
    (result.inputFromRevision === undefined || (natural(result.inputFromRevision) && result.inputFromRevision > 0)) &&
    (result.inputLimit === undefined || (natural(result.inputLimit) && result.inputLimit >= 1 && result.inputLimit <= 32));
}

// Validate every active record plus archive range identities. Archived text is
// digest-verified when read; the exact range locators bound lookup after restart.
function validateState(state, identity, limits) {
  const bad = () => { throw failure('TASK_STATE_INVALID', 'The canonical task record is invalid; preserve it for explicit recovery'); };
  if (!object(state) || state.schemaVersion !== STORE_VERSION || state.sessionId !== identity.sessionId || !object(state.binding)) bad();
  if (!natural(state.taskRevision) || !natural(state.inputRevision) || !natural(state.reviewedInputRevision) || state.reviewedInputRevision > state.inputRevision) bad();
  if (!Array.isArray(state.revisions) || !Array.isArray(state.inputs) || !Array.isArray(state.archives) || !Array.isArray(state.operations)) bad();
  if (state.archives.length > limits.maxArchives || state.operations.length > limits.maxOperations) bad();
  let revision = 0;
  let inputRevision = 0;
  const files = new Set();
  for (const archive of state.archives) {
    if (!object(archive) || !/^archive-[a-f0-9]{64}\.json$/u.test(archive.file) || !HASH.test(archive.digest) || archive.file !== `archive-${archive.digest}.json` || files.has(archive.file)) bad();
    files.add(archive.file);
    if (!natural(archive.bytes) || archive.bytes < 1 || archive.bytes > limits.maxArchiveBytes) bad();
    for (const key of ['revisionFrom', 'revisionTo', 'inputFrom', 'inputTo']) if (!natural(archive[key])) bad();
    if (archive.revisionFrom === 0 ? archive.revisionTo !== 0 : archive.revisionFrom !== revision + 1 || archive.revisionTo < archive.revisionFrom) bad();
    if (archive.inputFrom === 0 ? archive.inputTo !== 0 : archive.inputFrom !== inputRevision + 1 || archive.inputTo < archive.inputFrom) bad();
    if (archive.revisionFrom === 0 && archive.inputFrom === 0) bad();
    if (archive.revisionTo) revision = archive.revisionTo;
    if (archive.inputTo) inputRevision = archive.inputTo;
  }
  for (const entry of state.revisions) if (!validRevision(entry) || entry.revision !== ++revision || entry.reviewedInputRevision > state.inputRevision) bad();
  for (const entry of state.inputs) if (!validInput(entry) || entry.inputRevision !== ++inputRevision) bad();
  if (revision !== state.taskRevision || inputRevision !== state.inputRevision || (state.taskRevision > 0 && !state.revisions.length)) bad();
  const ids = new Set();
  const receipts = new Set();
  for (const entry of state.operations) {
    if (!validOperation(entry, state.taskRevision, state.inputRevision) || ids.has(entry.toolUseId) || receipts.has(entry.receipt.receiptId)) bad();
    ids.add(entry.toolUseId); receipts.add(entry.receipt.receiptId);
  }
  if (state.legacyBackup !== null && (!object(state.legacyBackup) || state.legacyBackup.file !== 'legacy.json' || !HASH.test(state.legacyBackup.digest) || !natural(state.legacyBackup.bytes) || state.legacyBackup.bytes > limits.maxStateBytes)) bad();
  return state;
}
function summary(state) {
  return { status: state.taskRevision ? 'current' : 'uninitialized', taskBody: state.revisions.at(-1)?.taskBody ?? null, revision: state.taskRevision, inputRevision: state.inputRevision, reviewedInputRevision: state.reviewedInputRevision, unreviewed: state.inputRevision - state.reviewedInputRevision };
}

export class ControlTaskStore {
  constructor(identity, { lineage = null, io = {}, now = Date.now, limits = {} } = {}) {
    this.identity = identity; this.lineage = lineage; this.io = { ...storage, ...io }; this.now = now; this.paths = taskPaths(identity);
    this.limits = { ...STORE_LIMITS, ...limits };
    for (const [key, value] of Object.entries(this.limits)) if (!Object.hasOwn(STORE_LIMITS, key) || !Number.isSafeInteger(value) || value < 1 || value > STORE_LIMITS[key]) throw failure('INVALID_STORE_LIMIT', 'Invalid internal task store limit');
    if (this.limits.archiveThreshold > this.limits.maxStateBytes) throw failure('INVALID_STORE_LIMIT', 'Archive threshold exceeds the state limit');
  }
  async locked(action) { return this.io.withSessionLock(this.paths.directory, action); }

  async read() {
    const record = await this.io.readRegular(this.paths.state, this.limits.maxStateBytes);
    if (!record) return { state: emptyState(this.identity, this.lineage), needsWrite: true, legacy: null };
    let raw;
    try { raw = JSON.parse(this.io.decodeRecord(record)); }
    catch { throw failure('TASK_STATE_INVALID', 'The canonical task file is empty, invalid JSON or invalid UTF-8', this.paths.state); }
    if (object(raw) && raw.schemaVersion === undefined) {
      if (raw.sessionId !== this.identity.sessionId || !parseTaskBody(raw.taskBody).ok || !timestamp(raw.updatedAt)) throw failure('LEGACY_TASK_INVALID', 'Legacy task body, identity or timestamp is invalid', this.paths.state);
      const state = emptyState(this.identity, this.lineage);
      state.taskRevision = 1;
      state.revisions.push({ revision: 1, taskBody: raw.taskBody, at: raw.updatedAt, reason: 'Preserve the existing destination task without normalization', reviewedInputRevision: 0, mutationId: `legacy-${hash(record.bytes)}` });
      state.legacyBackup = { file: 'legacy.json', digest: hash(record.bytes), bytes: record.bytes.length };
      return { state, needsWrite: true, legacy: record.bytes };
    }
    const state = validateState(raw, this.identity, this.limits);
    const binding = resolveWorkspaceBinding(state.binding, this.identity, this.lineage);
    const needsWrite = JSON.stringify(binding) !== JSON.stringify(state.binding);
    state.binding = binding;
    for (const archive of state.archives) {
      const archived = await this.io.readRegular(join(this.paths.directory, archive.file), 0, { prefix: true });
      if (!archived || archived.size !== archive.bytes) throw failure('TASK_ARCHIVE_UNAVAILABLE', 'A retained task/input archive is missing or changed', join(this.paths.directory, archive.file));
    }
    if (state.legacyBackup) {
      const backup = await this.io.readRegular(this.paths.legacy, 0, { prefix: true });
      if (!backup || backup.size !== state.legacyBackup.bytes) throw failure('LEGACY_BACKUP_UNAVAILABLE', 'The exact legacy backup is missing or changed', this.paths.legacy);
    }
    return { state, needsWrite, legacy: null };
  }

  async immutable(path, bytes) {
    const written = await this.io.writeExclusive(path, bytes);
    if (written.status === 'exists') {
      const existing = await this.io.readRegular(path, Math.max(this.limits.maxStateBytes, this.limits.maxArchiveBytes));
      if (!existing || !existing.bytes.equals(bytes)) throw failure('IMMUTABLE_RECORD_CONFLICT', 'An immutable task recovery file has different bytes', path);
    }
  }

  async archive(state) {
    // Keep the latest full canonical body and raw input in the active file.
    // A content-addressed old prefix is identical on retry after interruption.
    const segment = { schemaVersion: 1, sessionId: state.sessionId, revisions: [], inputs: [] };
    let size = encode(segment).length;
    const target = Math.min(this.limits.maxArchiveBytes, Math.max(512, Math.floor(this.limits.maxStateBytes * 0.65)));
    for (const key of ['revisions', 'inputs']) {
      for (const entry of state[key].slice(0, -1)) {
        const entrySize = encode(entry).length + 1;
        if (size + entrySize > target) break;
        segment[key].push(entry); size += entrySize;
      }
    }
    if (!segment.revisions.length && !segment.inputs.length) throw failure('TASK_STORAGE_LIMIT', 'Active task state cannot grow within its bounded archive capacity', this.paths.state, { status: 'rejected' });
    const bytes = encode(segment);
    if (bytes.length > this.limits.maxArchiveBytes) throw failure('TASK_STORAGE_LIMIT', 'Task archive exceeds its byte limit', this.paths.directory, { status: 'rejected' });
    const digest = hash(bytes);
    const file = `archive-${digest}.json`;
    const archivePath = join(this.paths.directory, file);
    const entries = (await this.io.listDirectory(this.paths.directory, 4096)) ?? [];
    const archives = entries.filter((entry) => /^archive-.*\.json$/u.test(entry.name));
    if (state.archives.length >= this.limits.maxArchives || (!archives.some((entry) => entry.name === file) && archives.length >= this.limits.maxArchives)) throw failure('TASK_STORAGE_LIMIT', 'The session archive limit is reached; original data was retained', this.paths.directory, { status: 'rejected' });
    await this.immutable(archivePath, bytes);
    state.archives.push({ file, digest, bytes: bytes.length, revisionFrom: segment.revisions[0]?.revision ?? 0, revisionTo: segment.revisions.at(-1)?.revision ?? 0, inputFrom: segment.inputs[0]?.inputRevision ?? 0, inputTo: segment.inputs.at(-1)?.inputRevision ?? 0 });
    state.revisions.splice(0, segment.revisions.length); state.inputs.splice(0, segment.inputs.length);
    return archivePath;
  }

  indexFor(state) {
    return {
      schemaVersion: 1, sessionId: state.sessionId, taskRevision: state.taskRevision, inputRevision: state.inputRevision, canonicalFile: this.paths.state, baseDirectory: this.paths.directory,
      currentBody: state.taskRevision ? `${this.paths.state}#taskRevision=${state.taskRevision}` : null,
      inputs: [
        ...state.archives.filter((item) => item.inputFrom).map((item) => ({ from: item.inputFrom, to: item.inputTo, file: item.file, jsonPointer: '/inputs', digest: item.digest })),
        ...(state.inputs.length ? [{ from: state.inputs[0].inputRevision, to: state.inputRevision, file: `../${state.sessionId}.json`, jsonPointer: '/inputs' }] : []),
      ],
      revisions: [
        ...state.archives.filter((item) => item.revisionFrom).map((item) => ({ from: item.revisionFrom, to: item.revisionTo, file: item.file, jsonPointer: '/revisions', digest: item.digest })),
        ...(state.revisions.length ? [{ from: state.revisions[0].revision, to: state.taskRevision, file: `../${state.sessionId}.json`, jsonPointer: '/revisions' }] : []),
      ],
      locatorRule: 'Files resolve relative to baseDirectory. Array index equals requested revision minus the range from value. Stable canonical #taskRevision=N / #inputRevision=N locators select the matching active revision or its archive range; they are not array offsets. The canonical record is authoritative if this derived index is stale.',
      provenance: 'Native UserPromptSubmit hook observations; final acceptance, human provenance and exact-once capture are unavailable.',
    };
  }
  async refreshIndex(state) {
    try {
      const bytes = encode(this.indexFor(state));
      if (bytes.length > 128 * 1024) throw failure('TASK_INDEX_LIMIT', 'Task locator index exceeds its bound', this.paths.index);
      await this.io.atomicWrite(this.paths.index, bytes);
      return { indexPath: this.paths.index, indexStatus: 'current' };
    } catch (error) { return { indexPath: null, indexStatus: 'unavailable', deliveryCode: error.code || 'TASK_INDEX_UNAVAILABLE' }; }
  }
  async persist(loaded, state) {
    if (loaded.legacy) {
      try { await this.immutable(this.paths.legacy, loaded.legacy); }
      catch (error) {
        // A committed backup is not a committed canonical task replacement.
        error.recoveryPath = this.paths.legacy; error.committed = false;
        error.status = 'unavailable'; error.phase = 'legacy-backup-preparation';
        throw error;
      }
    }
    let bytes = encode(state);
    let preparedArchive = null;
    while (bytes.length > this.limits.archiveThreshold) {
      try { preparedArchive = await this.archive(state); }
      catch (error) {
        if (error.committed) { error.recoveryPath = error.path; error.committed = false; error.status = 'unavailable'; }
        error.phase = 'archive-preparation-canonical-unchanged';
        throw error;
      }
      bytes = encode(state);
    }
    if (bytes.length > this.limits.maxStateBytes) throw failure('TASK_STORAGE_LIMIT', 'Active task record exceeds its byte limit', this.paths.state, { status: 'rejected' });
    try { await this.io.atomicWrite(this.paths.state, bytes); }
    catch (error) {
      if (preparedArchive && !error.committed) { error.recoveryPath = preparedArchive; error.phase = 'archive-written-canonical-unchanged'; }
      throw error;
    }
    return this.refreshIndex(state);
  }

  async loadArchive(archive) {
    const path = join(this.paths.directory, archive.file);
    const record = await this.io.readRegular(path, this.limits.maxArchiveBytes);
    if (!record || record.bytes.length !== archive.bytes || hash(record.bytes) !== archive.digest) throw failure('TASK_ARCHIVE_UNAVAILABLE', 'Retained primary task/input archive failed integrity verification', path);
    let segment;
    try { segment = JSON.parse(this.io.decodeRecord(record)); }
    catch { throw failure('TASK_ARCHIVE_UNAVAILABLE', 'Retained primary archive has invalid text or JSON', path); }
    if (!object(segment) || segment.schemaVersion !== 1 || segment.sessionId !== this.identity.sessionId || !Array.isArray(segment.revisions) || !Array.isArray(segment.inputs)) throw failure('TASK_ARCHIVE_UNAVAILABLE', 'Retained primary archive has an invalid schema', path);
    for (const [key, from, to, id, valid] of [['revisions', archive.revisionFrom, archive.revisionTo, 'revision', validRevision], ['inputs', archive.inputFrom, archive.inputTo, 'inputRevision', validInput]]) {
      if (segment[key].length !== (from ? to - from + 1 : 0) || segment[key].some((entry, index) => !valid(entry) || entry[id] !== from + index)) throw failure('TASK_ARCHIVE_UNAVAILABLE', 'Retained primary archive has invalid revision ranges', path);
    }
    return segment;
  }
  async view(state, range = {}, at = summary(state)) {
    const result = { ...at, statePath: this.paths.state, indexPath: this.paths.index, indexStatus: 'unknown', inputRecords: [], latestRevision: state.taskRevision, latestInputRevision: state.inputRevision, latestReviewedInputRevision: state.reviewedInputRevision };
    let revision = state.revisions.find((item) => item.revision === at.revision);
    if (!revision && at.revision) {
      const archived = state.archives.find((item) => item.revisionFrom && item.revisionFrom <= at.revision && item.revisionTo >= at.revision);
      if (!archived) throw failure('TASK_REVISION_UNAVAILABLE', 'Recorded task revision is unavailable', this.paths.state);
      revision = (await this.loadArchive(archived)).revisions[at.revision - archived.revisionFrom];
    }
    if (revision) result.bodyLocator = `${this.paths.state}#taskRevision=${at.revision}`;
    result.taskBody = revision?.taskBody ?? null; result.status = at.revision ? 'current' : 'uninitialized';
    if (range.inputFromRevision !== undefined && range.inputFromRevision <= at.inputRevision) {
      const end = Math.min(at.inputRevision, range.inputFromRevision + (range.inputLimit ?? 20) - 1);
      const cache = new Map();
      let archiveBytes = 0;
      for (let current = range.inputFromRevision; current <= end; current += 1) {
        let input = state.inputs.find((entry) => entry.inputRevision === current);
        const locator = `${this.paths.state}#inputRevision=${current}`;
        if (!input) {
          const archived = state.archives.find((entry) => entry.inputFrom && entry.inputFrom <= current && entry.inputTo >= current);
          if (!archived) throw failure('TASK_INPUT_UNAVAILABLE', 'A recorded raw input has no primary locator', this.paths.state);
          if (!cache.has(archived.file) && archiveBytes + archived.bytes <= this.limits.maxArchiveBytes) { cache.set(archived.file, await this.loadArchive(archived)); archiveBytes += archived.bytes; }
          input = cache.get(archived.file)?.inputs[current - archived.inputFrom];
        }
        result.inputRecords.push(input ? { ...input, locator } : { inputRevision: current, locator, textStatus: 'locator-only-event-read-budget' });
      }
    }
    return result;
  }
  async operationView(state, range, at, delivery) {
    try { return { ...await this.view(state, range, at), ...delivery }; }
    catch (error) { return { status: 'unavailable', statePath: this.paths.state, errorCode: error.code || 'TASK_VIEW_UNAVAILABLE', latestRevision: state.taskRevision, ...delivery }; }
  }
  async snapshot(range = {}) {
    return this.locked(async () => {
      const loaded = await this.read();
      const delivery = loaded.needsWrite ? await this.persist(loaded, loaded.state) : await this.refreshIndex(loaded.state);
      return { ...await this.view(loaded.state, range), ...delivery };
    });
  }
  async capturePrompt(text) {
    if (!validText(text) || Buffer.byteLength(text, 'utf8') > MAX_PROMPT_BYTES) throw failure('PROMPT_INVALID', 'Native prompt observation is invalid or exceeds its byte limit', this.paths.state);
    return this.locked(async () => {
      const loaded = await this.read();
      const state = loaded.state;
      if (state.inputRevision >= Number.MAX_SAFE_INTEGER) throw failure('INPUT_REVISION_LIMIT', 'Input revision counter is exhausted', this.paths.state, { status: 'rejected' });
      state.inputRevision += 1;
      state.inputs.push({ inputRevision: state.inputRevision, observationId: randomUUID(), text, at: new Date(this.now()).toISOString(), turnId: this.identity.turnId, provenance: 'native-UserPromptSubmit-observation' });
      const delivery = await this.persist(loaded, state);
      return { ...await this.view(state), ...delivery };
    });
  }
  async execute(receipt, args) {
    validateCall(receipt.operation, args);
    if (!this.identity.toolUseId) throw failure('TOOL_ID_UNAVAILABLE', 'A trusted logical tool-use identity is required', this.paths.state);
    return this.locked(async () => {
      const loaded = await this.read();
      const state = loaded.state;
      const known = state.operations.find((entry) => entry.toolUseId === this.identity.toolUseId || entry.receipt.receiptId === receipt.receiptId);
      if (known) {
        if (known.toolUseId !== this.identity.toolUseId || known.receipt.receiptId !== receipt.receiptId || known.receipt.operation !== receipt.operation || known.receipt.inputDigest !== receipt.inputDigest) throw failure('OPERATION_ID_REUSE', 'A logical tool-use or receipt identity was reused with different receipt/arguments; this invocation did not execute', this.paths.state, { status: 'rejected' });
        const delivery = loaded.needsWrite ? await this.persist(loaded, state) : await this.refreshIndex(state);
        return { outcome: known.outcome, view: await this.operationView(state, known.outcome, known.outcome, delivery), replayed: true };
      }
      // Retained completions win over admission expiry. Unknown expired receipts
      // cannot initiate work and cannot establish that no earlier commit exists.
      assertReceiptFresh(receipt, { now: this.now() });
      if (state.operations.length >= this.limits.maxOperations) state.operations = state.operations.filter((entry) => {
        try { assertReceiptFresh(entry.receipt, { now: this.now() }); return true; }
        catch (error) { return error.code !== 'RECEIPT_EXPIRED'; }
      });
      if (state.operations.length >= this.limits.maxOperations) throw failure('OPERATION_STORAGE_LIMIT', 'Retained operation receipts reached their bound; this invocation did not execute', this.paths.state, { status: 'rejected' });
      const decision = decideOperation(summary(state), receipt.operation, args);
      if (decision.status === 'committed') {
        if (decision.taskBody !== undefined) { state.taskRevision += 1; state.revisions.push({ revision: state.taskRevision, taskBody: decision.taskBody, at: new Date(this.now()).toISOString(), mutationId: receipt.receiptId, reason: args.reason, reviewedInputRevision: decision.reviewedInputRevision }); }
        state.reviewedInputRevision = decision.reviewedInputRevision;
      }
      const current = summary(state);
      const outcome = { status: decision.status, ...(decision.code ? { code: decision.code } : {}), ...(decision.message ? { message: decision.message } : {}), revision: current.revision, inputRevision: current.inputRevision, reviewedInputRevision: current.reviewedInputRevision, unreviewed: current.unreviewed, ...(args.inputFromRevision !== undefined ? { inputFromRevision: args.inputFromRevision, inputLimit: args.inputLimit ?? 20 } : {}) };
      state.operations.push({ state: 'completed', toolUseId: this.identity.toolUseId, receipt, completedAt: this.now(), outcome });
      // Task mutation and completed receipt share exactly one atomic replacement.
      const delivery = await this.persist(loaded, state);
      return { outcome, view: await this.operationView(state, args, undefined, delivery), replayed: false };
    });
  }
  async checkpoint(stopHookActive = false) {
    return this.locked(async () => {
      let current;
      try { current = summary((await this.read()).state); }
      catch (error) { current = { status: 'unavailable', errorCode: error.code || 'TASK_UNAVAILABLE' }; }
      const record = await this.io.readRegular(this.paths.checkpoint, 32 * 1024);
      let budget;
      if (record) {
        try { budget = validateBudget(JSON.parse(this.io.decodeRecord(record)), this.identity.sessionId); if (!object(budget.binding)) throw new Error('binding'); }
        catch { throw failure('CHECKPOINT_BUDGET_UNAVAILABLE', 'Continuation accounting is invalid; no unaccounted continuation was granted', this.paths.checkpoint); }
        budget.binding = resolveWorkspaceBinding(budget.binding, this.identity, this.lineage);
      } else budget = { schemaVersion: 1, sessionId: this.identity.sessionId, binding: resolveWorkspaceBinding(null, this.identity, this.lineage), runs: [] };
      const decision = evaluateCheckpoint({ ...current, budget, turnId: this.identity.turnId, stopHookActive });
      if (decision.block) {
        budget.runs.push({ turnId: this.identity.turnId, at: new Date(this.now()).toISOString(), reason: decision.reason });
        // Failed or uncertain accounting never grants an unaccounted block.
        await this.io.atomicWrite(this.paths.checkpoint, encode(budget));
      }
      return decision;
    });
  }
}
