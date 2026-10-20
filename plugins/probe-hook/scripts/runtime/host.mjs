// MiniMax Code 0.6.12 native hook adapter. The MCP process has no caller
// authority; only a native hook payload plus validated materialization does.
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { iterateDirectory } from './directory.mjs';
import { RuntimeError, withRegularDescriptor, safeAbsolutePath, safeSessionId } from './storage.mjs';
import { checkJsonShape, isPlainObject, MAX_RPC_LINE_BYTES } from './transport.mjs';

export const MAX_HOOK_OUTPUT_BYTES = 60 * 1024;
export const RECEIPT_MAX_AGE_MS = 60 * 1000;
export const RECEIPT_CLOCK_SKEW_MS = 5 * 1000;
const EVENTS = new Set(['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'SubagentStart', 'SubagentStop', 'Stop', 'PreCompact', 'PostCompact', 'PermissionRequest']);
const CONTEXT_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'SubagentStart', 'SubagentStop', 'Stop']);

function reject(code, message) { throw new RuntimeError(code, message, { status: 'rejected' }); }
function token(value, name, optional = false) {
  if (optional && (value === undefined || value === null)) return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value)) {
    reject('INVALID_IDENTITY', `The native ${name} is invalid.`);
  }
  return value;
}
function pluginName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) reject('INVALID_PLUGIN', 'The plugin identifier is invalid.');
  return value;
}

export async function readHookPayload({ input = process.stdin } = {}) {
  const chunks = [];
  let size = 0;
  for await (const part of input) {
    const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += bytes.length;
    if (size > MAX_RPC_LINE_BYTES) {
      input.destroy?.(); reject('HOOK_INPUT_TOO_LARGE', 'The native hook payload exceeds 1 MiB.');
    }
    chunks.push(bytes);
  }
  let payload;
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))); }
  catch { reject('HOOK_INPUT_INVALID', 'The native hook payload is not valid JSON.'); }
  checkJsonShape(payload);
  if (!isPlainObject(payload) || !EVENTS.has(payload.hook_event_name)) reject('HOOK_EVENT_INVALID', 'The native hook event is unsupported.');
  return payload;
}

/** A materialized native hook path is the only hook data-root authority. */
export function resolvePluginDataRoot(plugin, { lane = 'hook', env = process.env } = {}) {
  pluginName(plugin);
  if (lane === 'hook') {
    const pluginDataDir = safeAbsolutePath(env.PLUGIN_DATA);
    const suffix = `/v2/plugin-data/hooks/${plugin}`;
    if (!pluginDataDir.endsWith(suffix)) throw new RuntimeError('PLUGIN_DATA_UNSUPPORTED', 'The native plugin data materialization is unsupported.', { path: pluginDataDir });
    const dataDir = pluginDataDir.slice(0, -suffix.length) || '/';
    if (join(dataDir, 'v2', 'plugin-data', 'hooks', plugin) !== pluginDataDir) throw new RuntimeError('PLUGIN_DATA_UNSUPPORTED', 'The native plugin data materialization is unsupported.', { path: pluginDataDir });
    return { pluginDataDir, dataDir };
  }
  if (lane === 'mcp') {
    const dataDir = safeAbsolutePath(env.MINIMAX_DATA_DIR);
    return { dataDir, pluginDataDir: join(dataDir, 'v2', 'plugin-data', 'hooks', plugin) };
  }
  throw new RuntimeError('UNSUPPORTED_LANE', 'The diagnostic data-root lane is unsupported.');
}

export function resolveHookIdentity(payload, plugin, { env = process.env } = {}) {
  if (!isPlainObject(payload) || !EVENTS.has(payload.hook_event_name)) reject('HOOK_EVENT_INVALID', 'The native hook event is unsupported.');
  const event = payload.hook_event_name;
  const identity = { event, plugin: pluginName(plugin), sessionId: safeSessionId(payload.session_id),
    workspaceDir: safeAbsolutePath(payload.cwd), turnId: token(payload.turn_id, 'turn_id', true),
    toolUseId: token(payload.tool_use_id, 'tool_use_id', true),
    agentId: token(payload.agent_id, 'agent_id', true), agentType: token(payload.agent_type, 'agent_type', true),
    ...resolvePluginDataRoot(plugin, { env }) };
  if (['PreToolUse', 'PostToolUse'].includes(event) && (!identity.turnId || !identity.toolUseId)) reject('INVALID_IDENTITY', 'A tool hook requires native turn_id and tool_use_id.');
  if (['Stop', 'SubagentStop', 'UserPromptSubmit'].includes(event) && !identity.turnId) reject('INVALID_IDENTITY', 'This native hook requires turn_id.');
  if ((identity.agentId === null) !== (identity.agentType === null)) reject('INVALID_IDENTITY', 'The native agent identity is incomplete.');
  return identity;
}

/** Domain owners persist this value under their own session mutation lock. */
export function resolveWorkspaceBinding(existingBinding, identity, lineage = null) {
  let initialWorkspaceDir = identity.workspaceDir;
  let currentWorkspaceDir = identity.workspaceDir;
  let agentId = null;
  let agentType = null;
  if (existingBinding !== null && existingBinding !== undefined) {
    try {
      if (!isPlainObject(existingBinding) || safeSessionId(existingBinding.sessionId) !== identity.sessionId) throw new Error('identity');
      initialWorkspaceDir = safeAbsolutePath(existingBinding.initialWorkspaceDir);
      currentWorkspaceDir = safeAbsolutePath(existingBinding.currentWorkspaceDir);
      agentId = token(existingBinding.agentId, 'stored agent_id', true);
      agentType = token(existingBinding.agentType, 'stored agent_type', true);
      if ((agentId === null) !== (agentType === null)) throw new Error('role');
    } catch { throw new RuntimeError('BINDING_UNAVAILABLE', 'The stored session binding is invalid; it cannot establish caller or role.'); }
    if (currentWorkspaceDir !== identity.workspaceDir) {
      if (lineage?.currentVerified !== true || lineage.current?.sessionId !== identity.sessionId ||
          lineage.current?.workspaceDir !== identity.workspaceDir) {
        throw new RuntimeError('WORKSPACE_BINDING_CONFLICT', 'The hook workspace changed without a matching current native session row.');
      }
      currentWorkspaceDir = identity.workspaceDir;
    }
  }
  if (identity.agentId !== null) { agentId = identity.agentId; agentType = identity.agentType; }
  return { sessionId: identity.sessionId, initialWorkspaceDir, currentWorkspaceDir, agentId, agentType };
}

function decodeNativeRow(row, requestedId) {
  if (!row || row.session_id !== requestedId || row.columnar_version !== 3) throw new RuntimeError('NATIVE_SESSION_UNAVAILABLE', 'The exact current native session row is unavailable.');
  const sessionId = safeSessionId(row.session_id);
  const parentSessionId = row.parent_session_id === null ? null : safeSessionId(row.parent_session_id);
  if (parentSessionId === sessionId) throw new RuntimeError('NATIVE_LINEAGE_INVALID', 'Native session metadata contains self-parent linkage.');
  const workspaceDir = safeAbsolutePath(row.workspace_dir);
  if (typeof row.agent_name !== 'string' || !row.agent_name.isWellFormed() || !row.agent_name.length || row.agent_name.length > 200 || /[\x00-\x1f\x7f]/.test(row.agent_name) ||
      !Number.isSafeInteger(row.created_at_ms) || row.created_at_ms < 0 ||
      !(row.history_relative_dir === null || typeof row.history_relative_dir === 'string' && row.history_relative_dir.length <= 4096 && row.history_relative_dir.isWellFormed() && !/[\x00-\x1f\x7f]/.test(row.history_relative_dir))) {
    throw new RuntimeError('NATIVE_ROW_INVALID', 'The current native session row has an unsupported shape.');
  }
  return { sessionId, parentSessionId, workspaceDir, agentName: row.agent_name,
    createdAtMs: row.created_at_ms, historyRelativeDir: row.history_relative_dir };
}

function regularDescriptors() {
  const descriptors = new Map();
  let count = 0;
  try {
    for (const entry of iterateDirectory('/proc/self/fd')) {
      if (++count > 4096) throw new RuntimeError('NATIVE_DESCRIPTOR_LIMIT', 'The native reader descriptor inventory is unavailable.');
      if (!/^\d+$/.test(entry.name)) continue;
      const fd = Number(entry.name);
      try {
        const stat = fs.fstatSync(fd, { bigint: true });
        if (stat.isFile()) descriptors.set(fd, stat);
      } catch (error) { if (error.code !== 'EBADF') throw error; }
    }
    return descriptors;
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError('NATIVE_DESCRIPTOR_UNAVAILABLE', 'The native reader descriptor inventory is unavailable.',
      { systemCode: error.code, cause: error });
  }
}

/** Reads at most current + direct parent using one read-only V2 transaction. */
export async function readNativeLineage(identity) {
  const path = join(identity.dataDir, 'v2', 'sqlite', 'runtime-state.sqlite');
  let database;
  let current;
  try {
    const result = await withRegularDescriptor(path, async pinned => {
      const { DatabaseSync } = await import('node:sqlite');
      const previous = regularDescriptors();
      database = new DatabaseSync(`/proc/self/fd/${pinned.fd}`, { readOnly: true });
      // SQLite canonicalizes procfd paths. Check the actual newly opened file
      // description too: pathname preflight or readOnly alone cannot bind it.
      const opened = [...regularDescriptors()].filter(([fd]) => !previous.has(fd));
      if (!opened.some(([, stat]) => stat.dev === pinned.stat.dev && stat.ino === pinned.stat.ino)) {
        throw new RuntimeError('NATIVE_DB_CHANGED', 'SQLite did not open the safely pinned native database inode.', { path });
      }
      database.exec('PRAGMA busy_timeout = 500; PRAGMA query_only = ON; BEGIN;');
    const columns = database.prepare('PRAGMA table_info(local_runtime_sessions)').all();
    const expected = { session_id: 'TEXT', parent_session_id: 'TEXT', workspace_dir: 'TEXT', agent_name: 'TEXT',
      created_at_ms: 'INTEGER', columnar_version: 'INTEGER', history_relative_dir: 'TEXT' };
    // The native key is session_id alone. A composite key could admit several
    // current rows for one session and make query.get choose an arbitrary parent.
    const primaryKey = columns.filter(column => column.pk > 0);
    if (columns.length > 128 || !Object.entries(expected).every(([name, type]) => columns.some(column => column.name === name && column.type.toUpperCase() === type)) ||
        primaryKey.length !== 1 || primaryKey[0].name !== 'session_id' || primaryKey[0].pk !== 1) {
      throw new RuntimeError('NATIVE_SCHEMA_UNSUPPORTED', 'The native V2 metadata schema is unsupported.', { path });
    }
    const query = database.prepare('SELECT session_id, parent_session_id, workspace_dir, agent_name, created_at_ms, history_relative_dir, columnar_version FROM local_runtime_sessions WHERE session_id = ? AND columnar_version = 3');
    const candidate = decodeNativeRow(query.get(identity.sessionId), identity.sessionId);
    if (candidate.workspaceDir !== identity.workspaceDir) throw new RuntimeError('NATIVE_WORKSPACE_MISMATCH', 'The current native session workspace does not match the trusted hook cwd.', { path });
    current = candidate;
    const parent = current.parentSessionId === null ? null : decodeNativeRow(query.get(current.parentSessionId), current.parentSessionId);
    if (parent?.parentSessionId === current.sessionId) throw new RuntimeError('NATIVE_LINEAGE_INVALID', 'Native session metadata contains circular direct linkage.', { path });
    database.exec('COMMIT;');
      return { status: 'ok', currentVerified: true, current, parent, path };
    });
    if (result === null) throw new RuntimeError('NATIVE_DB_ABSENT', 'The native V2 metadata database is absent.', { path });
    return result;
  } catch (error) {
    return { status: 'unavailable', code: error instanceof RuntimeError ? error.code : 'NATIVE_METADATA_UNAVAILABLE', path,
      currentVerified: current !== undefined, ...(current ? { current } : {}) };
  } finally {
    if (database) {
      try { database.exec('ROLLBACK;'); } catch { /* Already committed or no transaction. */ }
      database.close();
    }
  }
}

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  reject('INVALID_ARGUMENTS', 'Validated arguments must be JSON values.');
}

export function argumentDigest(args) {
  checkJsonShape(args);
  return createHash('sha256').update(canonicalJson(args)).digest('hex');
}

export function createPendingReceipt(plugin, operation, args, { now = Date.now(), receiptId = randomUUID() } = {}) {
  pluginName(plugin); token(operation, 'operation');
  const receipt = { receiptVersion: 1, status: 'pending_host_commit', plugin, operation, receiptId,
    createdAt: now, inputDigest: argumentDigest(args) };
  checkReceiptShape(receipt);
  return { content: [{ type: 'text', text: `PENDING_HOST_COMMIT ${plugin}/${operation} receipt=${receiptId}. This is not a successful read or write. The matching native hook automatically appends the definitive outcome to this tool result. If it is missing, this operation remains unresolved. Continue the authorized task or finish the response; no separate confirmation, read-back or retry is required.` }],
    structuredContent: receipt };
}

function checkReceiptShape(receipt) {
  const fields = ['receiptVersion', 'status', 'plugin', 'operation', 'receiptId', 'createdAt', 'inputDigest'];
  if (!isPlainObject(receipt) || Object.keys(receipt).length !== fields.length || !fields.every(key => Object.hasOwn(receipt, key)) ||
      receipt.receiptVersion !== 1 || receipt.status !== 'pending_host_commit' ||
      typeof receipt.receiptId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(receipt.receiptId) ||
      !Number.isSafeInteger(receipt.createdAt) || receipt.createdAt < 0 ||
      typeof receipt.inputDigest !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.inputDigest)) {
    reject('RECEIPT_INVALID', 'The pending operation receipt is malformed or unsupported.');
  }
  pluginName(receipt.plugin); token(receipt.operation, 'receipt operation');
}

export function validateReceiptShape(receipt) { checkReceiptShape(receipt); return receipt; }

/** Expiry is deliberately separate: check a durable completion/pending record first. */
export function assertReceiptFresh(receipt, { now = Date.now() } = {}) {
  checkReceiptShape(receipt);
  if (receipt.createdAt > now + RECEIPT_CLOCK_SKEW_MS) reject('RECEIPT_FUTURE', 'The pending receipt has an unsupported future timestamp; this invocation did not execute.');
  if (now - receipt.createdAt > RECEIPT_MAX_AGE_MS + RECEIPT_CLOCK_SKEW_MS) {
    reject('RECEIPT_EXPIRED', 'This invocation did not execute because its unrecorded receipt expired. This does not establish whether an earlier invocation committed.');
  }
}

export function validatePendingReceipt(payload, plugin, { tools, validateCall, server = plugin }) {
  if (payload.hook_event_name !== 'PostToolUse') return null;
  const operation = tools.find(tool => payload.tool_name === `mcp__${server}__${tool.name}`)?.name;
  if (!operation) return null;
  const response = payload.tool_response;
  const details = response?.details;
  const mcp = details?.mcp;
  if (!isPlainObject(response) || !isPlainObject(details) || !isPlainObject(mcp) ||
      details.plugin !== plugin || details.server !== server || details.tool !== operation ||
      response.isError === true || response.is_error === true || details.isError === true ||
      response.error !== undefined || mcp.error !== undefined || mcp.isError !== undefined && mcp.isError !== false) {
    reject('RECEIPT_PROVENANCE_INVALID', 'The native tool result does not establish a successful matching MCP receipt.');
  }
  const receipt = mcp.structuredContent;
  checkReceiptShape(receipt);
  if (receipt.plugin !== plugin || receipt.operation !== operation) reject('RECEIPT_MISMATCH', 'The receipt plugin or operation does not match native provenance.');
  const args = validateCall(operation, payload.tool_input);
  if (argumentDigest(args) !== receipt.inputDigest) reject('RECEIPT_ARGUMENT_MISMATCH', 'The receipt digest does not match the validated native tool arguments.');
  return { receipt, args, operation };
}

export function formatDefinitiveResult(receipt, outcome, text = '') {
  checkReceiptShape(receipt);
  const status = typeof outcome === 'string' ? outcome : outcome?.status;
  if (typeof status !== 'string' || !/^[a-z_]{1,48}$/.test(status)) reject('RESULT_INVALID', 'The definitive operation status is invalid.');
  return `[${receipt.plugin} definitive operation result]\noperation=${receipt.operation} receipt=${receipt.receiptId} status=${status}\n${text}`;
}

function hookEnvelope(event, text, { decision, reason } = {}) {
  if (!EVENTS.has(event)) reject('HOOK_EVENT_INVALID', 'The native hook event is unsupported.');
  if (typeof text !== 'string' || !text.isWellFormed()) reject('HOOK_OUTPUT_INVALID', 'Hook context must be valid Unicode text.');
  if (decision !== undefined) {
    if (!['Stop', 'SubagentStop'].includes(event) || decision !== 'block' || typeof reason !== 'string' || !reason.isWellFormed() || !reason.length) {
      reject('HOOK_DECISION_INVALID', 'The native continuation decision is invalid.');
    }
    return { decision, reason, ...(text ? { hookSpecificOutput: { hookEventName: event, additionalContext: text } } : {}) };
  }
  if (text && !CONTEXT_EVENTS.has(event)) reject('HOOK_CONTEXT_UNSUPPORTED', 'This native event does not support additionalContext.');
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}

export function hookOutputByteLength(event, text, options = {}) {
  return Buffer.byteLength(JSON.stringify(hookEnvelope(event, text, options)) + '\n');
}

export function emitHookResult(event, text, { output = process.stdout, decision, reason } = {}) {
  if (!text && decision === undefined) return { status: 'empty', bytes: 0 };
  const line = JSON.stringify(hookEnvelope(event, text, { decision, reason })) + '\n';
  if (Buffer.byteLength(line) >= MAX_HOOK_OUTPUT_BYTES) reject('HOOK_OUTPUT_TOO_LARGE', 'The complete native hook envelope exceeds its 60 KiB byte budget.');
  output.write(line);
  return { status: 'emitted', bytes: Buffer.byteLength(line) };
}
