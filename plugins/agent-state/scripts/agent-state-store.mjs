// agent-state-store.mjs — durable reusable-guide store for the agent-state plugin.
//
// A "guide" is a reusable micro-skill: a procedure, a verified environment
// fact, a diagnostic recipe, an observed failure mode. It is NOT task state —
// the canonical task lives in control-task.
//
// Guides are files under the session directory, so they survive compaction and
// process restarts. Writes are atomic (tmp + rename) and serialized per
// session, so a guide is never observed half-written.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_TITLE_CHARS = 200;
export const MAX_NOTE_BODY_BYTES = 128 * 1024;
export const MAX_ANCHOR_BYTES = 80000;
export const MAX_INJECT_BYTES = 80000;

export const SAVE_CATEGORIES = [
  'reusable procedures',
  'verified tool/API/environment facts and source locations',
  'diagnostic and verification recipes',
  'observed failure modes and pitfalls',
  'proven fixes and workarounds',
  'rejected approaches with evidence',
  'reusable decision criteria and trade-offs',
].join('; ');

export const POLICY = [
  'This ledger is the DEVELOPMENT pass at compaction time, not a notepad: the growth an agent produces while working is written down as reusable micro-skills that survive into future actions.',
  `Save ONLY reusable micro-skills and knowledge for future actions: ${SAVE_CATEGORIES}.`,
  'Arbitrary notes, current status, progress and TASK CONTEXT do not belong here. The task itself — its description, requirements, task-specific rules and source-of-truth paths — lives in control_task_set; working state stays in conversation context ONLY.',
  'Capture applicability, procedure, pitfalls, evidence and verification; never save an unverified explanation as established knowledge.',
  'Never persist current execution state in any durable artifact reinjected into context. Control-task stores the whole task and is updated only after user messages.',
  'Never store current task goals, progress, status or next-step reports here; those stay in conversation context ONLY.',
  'Save or edit individual files with agent_state_note, using an existing note_id to edit. Do not recursively summarize the folder.',
  'The tool owns saving; no separate confirmation or read-back call is required. After saving, immediately continue the next authorized task action.',
  'Compaction is managed by the runtime. Never stop, defer work or wait because compaction may be approaching. After compaction, previous context-usage estimates and forecasts are expired; resume unfinished work.',
  'Context size alone is not evidence of tool failure. Only actual tool-call/result records establish execution; invocations or results written inside assistant text/thinking do not.',
  'Agent-written guides are derived advice, not sources of requirements, exclusions, permissions or complete coverage.',
  'Check applicability against original user/project sources and do not let a guide narrow the current task or carry task-specific interpretations/verdicts into independent review.',
].join(' ');

export const SAVE_REMINDER = [
  `YOU MUST SAVE IMPORTANT REUSABLE GUIDES NOW using agent_state_note: ${SAVE_CATEGORIES}.`,
  'This is the development pass at compaction: capture what you learned as reusable micro-skills, not task notes or status — the task lives in control_task_set.',
  'Capture applicability, procedure, pitfalls, evidence and verification. Save new important guides or edit the relevant existing file; keep current task state in conversation context ONLY.',
  'No separate confirmation or read-back call is required. THEN CONTINUE THE TASK IMMEDIATELY; do not wait for compaction.',
].join(' ');

// The state dir must resolve identically for every process that touches the
// store, and the two sides get different environments:
//   - hooks are spawned with PLUGIN_DATA = <dataDir>/v2/plugin-data/hooks/<name>;
//   - MiniMax-format plugin MCP servers receive their `env` block verbatim, so
//     a "${PLUGIN_DATA}/..." placeholder there is never expanded and no
//     PLUGIN_DATA is injected.
// So the location is resolved in one place, in this order:
//   1. AGENT_STATE_STATE_DIR, when it is a real path (a "${...}" placeholder
//      is not a path and is ignored);
//   2. the host-injected PLUGIN_DATA (hook side);
//   3. the host's own plugin data dir layout, derived from the data dir and the
//      plugin name (MCP-server side).
export function stateRoot() {
  const override = (process.env.AGENT_STATE_STATE_DIR || '').trim();
  if (override && !override.includes('${')) {
    return resolve(override);
  }
  const pluginData = (process.env.PLUGIN_DATA || '').trim();
  if (pluginData && isAbsolute(pluginData)) {
    return resolve(join(pluginData, 'agent-state'));
  }
  return resolve(join(dataDir(), 'v2', 'plugin-data', 'hooks', pluginName(), 'agent-state'));
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

export function sessionDir(sessionId) {
  return join(stateRoot(), 'sessions', safeSessionId(sessionId));
}

export function safeSessionId(value) {
  const id = String(value ?? '').trim();
  if (!id || id.length > 128 || !/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new Error(`invalid session id: ${JSON.stringify(id)}`);
  }
  return id;
}

export function activePointerPath() {
  return join(stateRoot(), 'active.json');
}

export function readActiveSession() {
  const file = activePointerPath();
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed.sessionId === 'string' ? parsed.sessionId : null;
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
    mkdirSync(stateRoot(), { recursive: true });
    writeFileSync(
      activePointerPath(),
      `${JSON.stringify({ sessionId: id, at: new Date().toISOString() }, null, 2)}\n`,
      'utf8',
    );
    return true;
  } catch {
    return false;
  }
}

const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/;

export function isWellFormedText(value) {
  return !LONE_SURROGATE.test(value);
}

export class InvalidArgumentsError extends Error {}

function requireObject(args, allowed) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new InvalidArgumentsError('arguments must be an object');
  }
  const unknown = Object.keys(args).find((key) => !allowed.includes(key));
  if (unknown) throw new InvalidArgumentsError(`unknown argument: ${unknown}`);
}

function validText(value, name, limit) {
  if (typeof value !== 'string' || !value.trim() || !isWellFormedText(value)) {
    throw new InvalidArgumentsError(`${name} must be non-empty valid UTF-8 text`);
  }
  if (Buffer.byteLength(value) > limit) {
    throw new InvalidArgumentsError(`${name} exceeds ${limit} bytes`);
  }
}

export function validateNoteArguments(args) {
  requireObject(args, ['title', 'body', 'shared', 'note_id']);
  validText(args.title, 'title', 800);
  validText(args.body, 'body', MAX_NOTE_BODY_BYTES);
  if (args.title.length > MAX_TITLE_CHARS || /[\x00-\x1f\x7f]/.test(args.title)) {
    throw new InvalidArgumentsError('invalid title length/header control character');
  }
  if (args.shared !== undefined && typeof args.shared !== 'boolean') {
    throw new InvalidArgumentsError('shared must be boolean');
  }
  if (
    args.note_id !== undefined &&
    (typeof args.note_id !== 'string' ||
      !isWellFormedText(args.note_id) ||
      !args.note_id.endsWith('.md') ||
      args.note_id !== basename(args.note_id) ||
      /[\\/\x00-\x1f\x7f]/.test(args.note_id) ||
      Buffer.byteLength(args.note_id) > 255)
  ) {
    throw new InvalidArgumentsError('note_id must be an existing own .md file index, not a path');
  }
  return {
    title: args.title.trim(),
    body: args.body,
    shared: args.shared === true,
    noteId: args.note_id,
    bodyHash: sha256Hex(args.body.trimEnd()),
  };
}

export function validateCheckpointArguments(args) {
  requireObject(args, ['content']);
  validText(args.content, 'content', MAX_ANCHOR_BYTES);
  return { content: args.content, bodyHash: sha256Hex(args.content.trimEnd()) };
}

export function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function slugifyTitle(title) {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .replace(/-+$/g, '') || 'note'
  );
}

export function renderNoteFile(record) {
  return `shared: ${record.shared ? 'true' : 'false'}\ntitle: ${record.title}\nupdated: ${new Date().toISOString()}\n---\n${record.body.trimEnd()}\n`;
}

export function bodyOf(content) {
  const lines = content.split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (/^\s*shared\s*:/i.test(lines[i] ?? '')) {
    i++;
    while (/^\s*(title|updated)\s*:/i.test(lines[i] ?? '')) i++;
    if (lines[i]?.trim() === '---') i++;
  }
  return lines.slice(i).join('\n').trimEnd();
}

function atomicWrite(file, contents) {
  mkdirSync(resolve(file, '..'), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, contents, 'utf8');
  renameSync(tmp, file);
}

/**
 * Save one guide. Creating picks a slug name; editing requires the exact
 * existing note_id of this session.
 */
export function commitNote(sessionId, record) {
  const dir = sessionDir(sessionId);
  let name = record.noteId;
  if (name) {
    const existing = join(dir, name);
    if (!existsSync(existing)) {
      throw new Error('note_id does not exist in this session');
    }
  } else {
    const slug = slugifyTitle(record.title);
    const existingNames = existsSync(dir)
      ? readdirSync(dir).filter((n) => n.endsWith('.md'))
      : [];
    for (let n = 1; n <= 99; n += 1) {
      const candidate = `${slug}${n === 1 ? '' : `-${n}`}.md`;
      const file = join(dir, candidate);
      let sameBody = false;
      if (existsSync(file)) {
        try {
          sameBody = sha256Hex(bodyOf(readFileSync(file, 'utf8'))) === record.bodyHash;
        } catch {
          sameBody = false;
        }
      }
      if (!existsSync(file) || sameBody) {
        name = candidate;
        break;
      }
    }
    if (!name) {
      throw new Error('guide title collision limit reached; use an existing note_id');
    }
    if (!existingNames.includes(name) && existingNames.length >= 512) {
      throw new Error('guide file count bound reached');
    }
  }
  const file = join(dir, name);
  atomicWrite(file, renderNoteFile(record));
  return { note_id: name, path: file };
}

export function readGuides(sessionId) {
  const dir = sessionDir(sessionId);
  if (!existsSync(dir)) return [];
  const files = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.md')) continue;
    const file = join(dir, name);
    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const head = content.split('\n').slice(0, 4).join('\n');
    const shared = /^\s*shared\s*:\s*true/im.test(head);
    const titleMatch = /^\s*title\s*:\s*(.+)$/im.exec(head);
    files.push({
      name,
      path: file,
      title: titleMatch ? titleMatch[1].trim() : null,
      shared,
      content,
      bytes: Buffer.byteLength(content, 'utf8'),
    });
  }
  return files;
}

export function digestOf(files) {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(JSON.stringify([file.path, file.name, file.shared, file.title, file.bytes, file.content]));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function utf8Prefix(value, limit) {
  const buffer = Buffer.from(value);
  let end = Math.max(0, Math.min(buffer.length, Math.floor(limit)));
  while (end > 0 && end < buffer.length && (buffer[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return buffer.subarray(0, end).toString('utf8');
}

/**
 * Assemble the guide body within a UTF-8 byte budget. Every cut or skipped
 * file keeps its full path in the footer, so a truncated delivery never loses
 * the locator.
 */
export function buildInjection({ files, maxBytes = MAX_INJECT_BYTES, preamble = '' }) {
  const cap = Math.min(MAX_INJECT_BYTES, Math.floor(maxBytes));
  if (!Number.isFinite(cap) || cap < 1) throw new Error('invalid injection limits');
  const heading = (file) =>
    `\n\nFile ${file.name}${file.title ? `: ${file.title}` : ''}\n${file.path}\n`;
  const footer = (omitted) =>
    '\n\nINJECTION TRUNCATED. Original files retained; read these full paths when needed:\n' +
    omitted.map((file) => file.path).join('\n');
  let available = cap - Buffer.byteLength(preamble, 'utf8') - Buffer.byteLength(footer(files), 'utf8');
  if (available < 0) return preamble + footer(files);
  let text = preamble;
  const omitted = [];
  for (const file of files) {
    const head = heading(file);
    if (available <= Buffer.byteLength(head, 'utf8')) {
      omitted.push(file);
      continue;
    }
    const body = utf8Prefix(file.content, available - Buffer.byteLength(head, 'utf8'));
    const part = head + body;
    text += part;
    available -= Buffer.byteLength(part, 'utf8');
    if (Buffer.byteLength(body, 'utf8') < file.bytes) omitted.push(file);
  }
  const result = text + footer(omitted);
  if (Buffer.byteLength(result, 'utf8') > cap) throw new Error('injection exceeded byte limit');
  return result;
}
