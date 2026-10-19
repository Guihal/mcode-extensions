// control-task-store.mjs — shared durable store for the control-task plugin.
//
// The canonical task is per session and file-backed, so it survives compaction
// and a process restart. The store is the single source of truth; nothing is
// replayed from a transcript.
//
// Fail-closed: a corrupt store file settles as "unavailable" and mutations are
// rejected downstream. An absent or empty file settles as "uninitialized".

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_TASK_BODY = 12000;

// The state dir must resolve identically for every process that touches the
// store, and the two sides get different environments:
//   - hooks are spawned with PLUGIN_DATA = <dataDir>/v2/plugin-data/hooks/<name>;
//   - MiniMax-format plugin MCP servers receive their `env` block verbatim, so
//     a "${PLUGIN_DATA}/..." placeholder there is never expanded and no
//     PLUGIN_DATA is injected.
// So the location is resolved in one place, in this order:
//   1. CONTROL_TASK_STATE_DIR, when it is a real path (a "${...}" placeholder
//      is not a path and is ignored);
//   2. the host-injected PLUGIN_DATA (hook side);
//   3. the host's own plugin data dir layout, derived from the data dir and the
//      plugin name (MCP-server side).

export function stateDir() {
  const override = (process.env.CONTROL_TASK_STATE_DIR || '').trim();
  if (override && !override.includes('${')) {
    return resolve(override);
  }
  const pluginData = (process.env.PLUGIN_DATA || '').trim();
  if (pluginData && isAbsolute(pluginData)) {
    return resolve(join(pluginData, 'control-task'));
  }
  return resolve(join(dataDir(), 'v2', 'plugin-data', 'hooks', pluginName(), 'control-task'));
}

function dataDir() {
  const fromEnv = (process.env.MINIMAX_DATA_DIR || '').trim();
  return fromEnv && isAbsolute(fromEnv) ? fromEnv : join(process.env.HOME || '.', '.minimax');
}

/** Plugin name as the host sanitizes it: manifest name first, plugin dir name second. */
function pluginName() {
  if (!cachedPluginName) {
    const root = dirname(dirname(fileURLToPath(import.meta.url)));
    cachedPluginName = sanitizeName(manifestName(root) || basename(root));
  }
  return cachedPluginName;
}

let cachedPluginName = null;

function manifestName(root) {
  try {
    const parsed = JSON.parse(readFileSync(join(root, '.minimax-plugin', 'plugin.json'), 'utf8'));
    return typeof parsed.name === 'string' ? parsed.name : null;
  } catch {
    return null;
  }
}

function sanitizeName(name) {
  return String(name).replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 80) || 'plugin';
}

export function sessionsDir() {
  return join(stateDir(), 'sessions');
}

export function activePointerPath() {
  return join(stateDir(), 'active.json');
}

export function sessionFile(sessionId) {
  return join(sessionsDir(), `${safeSessionId(sessionId)}.json`);
}

/** Session ids become file names, so they must be a single safe path segment. */
export function safeSessionId(value) {
  const id = String(value ?? '').trim();
  if (!id || id.length > 128 || !/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new Error(`invalid session id: ${JSON.stringify(id)}`);
  }
  return id;
}

export function parseTaskBody(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, error: 'taskBody must be a non-empty string' };
  }
  if (raw.length > MAX_TASK_BODY) {
    return { ok: false, error: `taskBody exceeds ${MAX_TASK_BODY} characters` };
  }
  return { ok: true, value: raw };
}

/**
 * Resolve the durable task for one session.
 * @returns {{status:'uninitialized'|'current'|'unavailable', taskBody?:string, error?:string}}
 */
export function resolveControlTask(sessionId) {
  let id;
  try {
    id = safeSessionId(sessionId);
  } catch (error) {
    return { status: 'unavailable', error: error.message };
  }
  const file = sessionFile(id);
  if (!existsSync(file)) return { status: 'uninitialized' };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return { status: 'unavailable', error: `corrupt store file: ${error.message}` };
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.taskBody !== 'string') {
    return { status: 'unavailable', error: 'corrupt store file: missing taskBody' };
  }
  return { status: 'current', taskBody: parsed.taskBody, updatedAt: parsed.updatedAt };
}

function atomicWrite(file, contents) {
  mkdirSync(resolve(file, '..'), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, contents, 'utf8');
  renameSync(tmp, file);
}

/**
 * Replace the whole canonical task for a session.
 * @returns {{ok:true, noteId:string} | {ok:false, error:string}}
 */
export function appendRevision(sessionId, taskBody) {
  let id;
  try {
    id = safeSessionId(sessionId);
  } catch (error) {
    return { ok: false, error: error.message };
  }
  const file = sessionFile(id);
  try {
    atomicWrite(
      file,
      `${JSON.stringify({ sessionId: id, taskBody, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    );
    return { ok: true, noteId: id };
  } catch (error) {
    return { ok: false, error: `durability unproven (${error.message})` };
  }
}

/**
 * The session the model is currently talking to. The MCP tool call carries no
 * session identity, so the hook maintains this pointer: it is refreshed on every
 * SessionStart and UserPromptSubmit of the live session.
 */
export function readActiveSession() {
  const file = activePointerPath();
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed && typeof parsed.sessionId === 'string') return parsed.sessionId;
    return null;
  } catch {
    return null;
  }
}

export function writeActiveSession(sessionId) {
  let id;
  try {
    id = safeSessionId(sessionId);
  } catch {
    return false;
  }
  try {
    atomicWrite(
      activePointerPath(),
      `${JSON.stringify({ sessionId: id, at: new Date().toISOString() }, null, 2)}\n`,
    );
    return true;
  } catch {
    return false;
  }
}
