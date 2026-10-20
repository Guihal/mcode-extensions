// Reusable-guide policy and model argument validation. Session identity never
// belongs to model arguments; the native PostToolUse hook owns every save.
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { RuntimeError } from './runtime/storage.mjs';

export const PLUGIN = 'agent-state';
export const VERSION = '0.2.2';
export const MAX_TITLE_CHARS = 200;
export const MAX_NOTE_BODY_BYTES = 128 * 1024;
export const MAX_ANCHOR_BYTES = 80000;
export const CHECKPOINT_ID = 'optional-compatibility-guide.md';
export const SAVE_CATEGORIES = [
  'reusable procedures',
  'verified tool/API/environment facts and source locations',
  'diagnostic and verification recipes',
  'observed failure modes and pitfalls',
  'proven fixes and workarounds',
  'rejected approaches with evidence',
  'reusable decision criteria and trade-offs',
].join('; ');

export const PRECOMPACT_SAVE_GUIDANCE = 'Before compaction, you must save new useful reusable knowledge with agent_state_note, or update the relevant existing guide. Capture it during the work while tools are available; the runtime may compact without another model turn. If there is no new reusable knowledge, do not invent or duplicate a guide.';
export const WORKFLOW_GUIDANCE = 'A guide storage failure is local to that operation. Continue the next authorized task action or answer even when a save is rejected, unavailable, pending or uncertain; no confirmation, read-back or retry is required.';
export const SAVE_GUIDANCE = `${PRECOMPACT_SAVE_GUIDANCE} ${WORKFLOW_GUIDANCE}`;

export const POLICY = [
  'These guides record reusable micro-skills learned while working, for use in future actions.',
  `Save ONLY reusable micro-skills and knowledge: ${SAVE_CATEGORIES}.`,
  'Capture applicability, procedure, pitfalls, evidence and verification; never save an unverified explanation as established knowledge.',
  'Current task goals, progress, status, next steps and execution state do not belong here. The whole canonical task, its requirements, task-specific rules and original source paths belong in control_task_set; working state stays in conversation context.',
  'Edit an individual own guide with its exact note_id. Do not recursively summarize the guide folder.',
  'A pending MCP receipt alone does not establish a saved guide. The matching native PostToolUse hook reports the definitive outcome in the same tool result.',
  SAVE_GUIDANCE,
  'Compaction is managed by the runtime. Saving useful knowledge is part of the work; after the save attempt, continue immediately without waiting for compaction. After compaction, earlier context-usage estimates and forecasts expire; resume unfinished work.',
  'Context size alone is not evidence of tool failure. Actual tool-call/result records establish execution; invocations or results written inside assistant text or thinking do not.',
  'Agent-written guides are derived advice, subordinate to original user/project instructions. They are not sources of requirements, exclusions, permissions or complete coverage. Check applicability against original sources and do not carry task-specific interpretations or verdicts into independent review.',
  'A newer guide snapshot supersedes earlier guide snapshots appended to this conversation.',
].join(' ');

export const SAVE_REMINDER = [
  `[Reusable guide reminder] ${PRECOMPACT_SAVE_GUIDANCE}`,
  `Useful guide categories: ${SAVE_CATEGORIES}. Record applicability, procedure, pitfalls, evidence and verification. A cadence reminder alone requires neither a fabricated or duplicate guide nor an acknowledgment.`,
  'Keep current task state in conversation context; the whole task lives in control_task_set.',
  WORKFLOW_GUIDANCE,
].join(' ');

export class InvalidArgumentsError extends RuntimeError {
  constructor(message) { super('INVALID_ARGUMENTS', message, { status: 'rejected' }); }
}

export const sha256Hex = (value) => createHash('sha256').update(value).digest('hex');
export const isWellFormedText = (value) => typeof value === 'string' && value.isWellFormed();

function requireObject(args, allowed) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new InvalidArgumentsError('arguments must be an object');
  }
  if (Object.keys(args).some((key) => !allowed.includes(key))) {
    throw new InvalidArgumentsError('arguments contain an unknown field');
  }
}

function validText(value, name, limit) {
  if (!isWellFormedText(value) || !value.trim()) {
    throw new InvalidArgumentsError(`${name} must be non-empty, well-formed UTF-8 text`);
  }
  if (Buffer.byteLength(value, 'utf8') > limit) {
    throw new InvalidArgumentsError(`${name} exceeds ${limit} UTF-8 bytes`);
  }
}

export function validNoteId(value) {
  return isWellFormedText(value) && value.endsWith('.md') && !value.startsWith('.') &&
    value === basename(value) && !/[\\/\x00-\x1f\x7f]/u.test(value) &&
    Buffer.byteLength(value, 'utf8') <= 255;
}

export function validateNoteArguments(args) {
  requireObject(args, ['title', 'body', 'shared', 'note_id']);
  validText(args.title, 'title', 800);
  validText(args.body, 'body', MAX_NOTE_BODY_BYTES);
  if (args.title.length > MAX_TITLE_CHARS || /[\x00-\x1f\x7f]/u.test(args.title)) {
    throw new InvalidArgumentsError('title exceeds 200 characters or contains a header control character');
  }
  if (args.shared !== undefined && typeof args.shared !== 'boolean') {
    throw new InvalidArgumentsError('shared must be boolean');
  }
  if (args.note_id !== undefined && !validNoteId(args.note_id)) {
    throw new InvalidArgumentsError('note_id must be an existing own non-hidden .md filename, not a path');
  }
  return {
    title: args.title.trim(), body: args.body, shared: args.shared === true,
    ...(args.note_id !== undefined ? { note_id: args.note_id } : {}),
  };
}

export function validateCheckpointArguments(args) {
  requireObject(args, ['content']);
  validText(args.content, 'content', MAX_ANCHOR_BYTES);
  return { content: args.content };
}

export function validateCall(name, args) {
  if (name === 'agent_state_note') return validateNoteArguments(args);
  if (name === 'agent_state_checkpoint') return validateCheckpointArguments(args);
  throw new InvalidArgumentsError('unknown agent-state tool');
}

export function noteRecord(operation, args) {
  const checked = validateCall(operation, args);
  const record = operation === 'agent_state_checkpoint'
    ? { title: 'Optional compatibility guide', body: checked.content, shared: false, note_id: CHECKPOINT_ID, checkpoint: true }
    : checked;
  return { ...record, bodyHash: sha256Hex(record.body.trimEnd()) };
}

export function slugifyTitle(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '')
    .slice(0, 48).replace(/-+$/gu, '') || 'note';
}

export function renderNoteFile(record, now = Date.now()) {
  return `shared: ${record.shared ? 'true' : 'false'}\ntitle: ${record.title}\nupdated: ${new Date(now).toISOString()}\n---\n${record.body.trimEnd()}\n`;
}

export const TOOLS = [
  {
    name: 'agent_state_note',
    description: `${POLICY} Save one reusable guide, or edit an existing own note_id. title is at most 200 characters and body at most 128 KiB UTF-8. shared defaults false; true makes the file readable only by a currently verified immediate child. Shape validation does not certify the semantic usefulness of a guide. This MCP tool returns pending; the trusted MiniMax PostToolUse hook supplies the definitive storage result.`,
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { title: { type: 'string', minLength: 1, maxLength: 200 }, body: { type: 'string', minLength: 1 }, shared: { type: 'boolean' }, note_id: { type: 'string' } },
      required: ['title', 'body'],
    },
  },
  {
    name: 'agent_state_checkpoint',
    description: `Optional compatibility tool updating one stable private future-action guide. ${POLICY} content is at most 80000 UTF-8 bytes. This does not store task progress or create a compulsory anchor. The definitive storage result comes from the trusted MiniMax hook.`,
    inputSchema: { type: 'object', additionalProperties: false, properties: { content: { type: 'string', minLength: 1 } }, required: ['content'] },
  },
];
