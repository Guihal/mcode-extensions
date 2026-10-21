// Pure control-task contracts. Transport and trusted identity live in runtime/.
import { RuntimeError } from './runtime/storage.mjs';

export const VERSION = '0.2.3';
export const MAX_TASK_BODY = 12000;
export const MAX_REASON = 1024;
export const MAX_PATCH_OPERATIONS = 128;
export const MAX_INPUT_RANGE = 32;
export const TASK_CONTENT_GUIDANCE = 'Record the complete enduring task: requested outcome; all applicable explicit requirements; grounded implicit (implied) requirements with their basis and source; constraints, result and acceptance conditions, task-specific rules and source-of-truth references. Keep inferred requirements identified as inferences, not explicit user commands. Keep material unresolved assumptions visibly tentative/open, with their basis or missing evidence; storing a guess does not make it authoritative. Preserve faithful user result conditions and grounded derived conditions with their basis; never replace them with a narrower completion checklist. The model identifies and writes requirements; the plugin records the supplied body and optional review metadata. Shape validation and review counters do not certify semantic completeness.';
export const TASK_REVIEW_GUIDANCE = 'When an original input materially changes the durable definition, update it with set/patch using the whole current task and the relevant original input. Preserve all earlier requirements and qualifications that still apply; change only what the authoritative clarification actually changes or cancels. Optional reviewedInputRevision records only the inputs actually considered. Unchanged steering needs no task call or confirmation; control_task_confirm is optional bookkeeping. An observation alone does not authorize a rewrite or an unsupported inference.';
export const TASK_INPUT_GUIDANCE = 'ОБЯЗАТЕЛЬНО ОБНОВИ ТРЕБОВАНИЯ, УСЛОВИЯ, ИЛИ ЗАДАЧУ ПОСЛЕ СООБЩЕНИЯ ПОЛЬЗОВАТЕЛЯ. After this user message, you MUST use control_task_set/control_task_patch to add, change or remove durable requirements that the original message adds, changes or cancels, preserving all earlier requirements and qualifications that still apply. Include grounded implied requirements with their basis. If no durable requirement changes, no invented edit, confirmation or read is required.';
export const TASK_WORKFLOW_GUIDANCE = 'If task capture, updating or restoration fails or its outcome is pending, rejected, unavailable or uncertain, continue the authorized work or deliver the report. No separate confirmation, read-back, retry or repair is required to proceed after that failure. Report only observed storage outcomes.';
export const TASK_COMPACT_GUIDANCE = `Preserve explicit and grounded implied requirements with basis/source, constraints, result conditions and references. Keep inferences identified and unresolved assumptions tentative with their basis or missing evidence. Retain earlier applicable requirements and qualifications when an original input materially changes the task. Use set/patch for changes; unchanged steering needs no task call or confirmation. Original instructions govern; optional review metadata does not certify semantic completeness. ${TASK_WORKFLOW_GUIDANCE}`;

const integer = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const reason = { type: 'string', minLength: 1, maxLength: MAX_REASON };
const taskText = { type: 'string', minLength: 1, maxLength: MAX_TASK_BODY };
const patchText = { type: 'string', maxLength: MAX_TASK_BODY };
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
export const TOOLS = [
  {
    name: 'control_task_get',
    description: `Read this session's complete model-authored durable canonical task, its qualifications and source references, task revision and advisory input/review metadata. Optional inputFromRevision and inputLimit expose raw native prompt observations and exact original locators when needed. Observations are not proof of human provenance or final host acceptance. The matching trusted PostToolUse result reports the operation outcome in the same native tool response. ${TASK_WORKFLOW_GUIDANCE}`,
    inputSchema: object({
      inputFromRevision: { ...integer, minimum: 1 },
      inputLimit: { type: 'integer', minimum: 1, maximum: MAX_INPUT_RANGE },
    }),
  },
  {
    name: 'control_task_set',
    description: `Replace the WHOLE durable task for this session when its definition materially changes. ${TASK_CONTENT_GUIDANCE} ${TASK_REVIEW_GUIDANCE} Store the enduring definition, not progress, a current step, tool outcomes, a plan or a summary. Stored agent text is derived advice and never overrides original instructions or their priority. reason is optional. Omitting reviewedInputRevision leaves review metadata unchanged. Identical content adds no body revision; explicitly supplied review coverage can advance in this same call. A pending MCP receipt is not a committed write. ${TASK_WORKFLOW_GUIDANCE}`,
    inputSchema: object({ taskBody: taskText, reason, reviewedInputRevision: integer }, ['taskBody']),
  },
  {
    name: 'control_task_patch',
    description: `Apply anchored add/replace/remove operations atomically to the current canonical task while preserving unaffected requirements. ${TASK_CONTENT_GUIDANCE} ${TASK_REVIEW_GUIDANCE} expectedRevision must match the current task revision. Each match/after must match exactly one trimmed line after CRLF normalization; missing or ambiguous anchors reject only this patch. add appends when after is omitted. A successful material edit stores a full new revision. reason is optional. Optional reviewedInputRevision covers only the observed inputs explicitly considered; a later concurrent input remains unreviewed. A valid patch with unchanged content can record supplied review coverage without adding a body revision. The matching trusted hook reports this operation's outcome. ${TASK_WORKFLOW_GUIDANCE}`,
    inputSchema: object({
      expectedRevision: { ...integer, minimum: 1 },
      operations: { type: 'array', minItems: 1, maxItems: MAX_PATCH_OPERATIONS, items: { anyOf: [
        object({ op: { const: 'replace', type: 'string' }, match: taskText, text: patchText }, ['op', 'match', 'text']),
        object({ op: { const: 'remove', type: 'string' }, match: taskText }, ['op', 'match']),
        object({ op: { const: 'add', type: 'string' }, text: patchText, after: taskText }, ['op', 'text']),
      ] } },
      reason,
      reviewedInputRevision: integer,
    }, ['expectedRevision', 'operations']),
  },
  {
    name: 'control_task_confirm',
    description: `Optional compatibility tool for recording review metadata without changing the task body. ${TASK_REVIEW_GUIDANCE} reviewedInputRevision must equal the current observed-input revision; stale or future values leave metadata unchanged. reason is optional. Confirmation neither certifies semantic completeness nor establishes accepted human-message provenance. The matching trusted hook reports this operation's outcome. ${TASK_WORKFLOW_GUIDANCE}`,
    inputSchema: object({ reviewedInputRevision: integer, reason }, ['reviewedInputRevision']),
  },
];

function invalid(message) {
  throw new RuntimeError('INVALID_ARGUMENT', message, { status: 'rejected' });
}
function fields(value, allowed, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('arguments must be an object');
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid('unknown argument field');
  if (required.some((key) => !Object.hasOwn(value, key))) invalid('missing required argument');
}
export function validText(value) {
  return typeof value === 'string' && value.isWellFormed();
}
function string(value, name, max, nonempty = false) {
  if (!validText(value)) invalid(`${name} must be valid Unicode text`);
  if (value.length > max) invalid(`${name} exceeds ${max} characters`);
  if (nonempty && !value.trim()) invalid(`${name} must be non-empty`);
}
function count(value, name, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(`${name} must be an integer from ${minimum} to ${maximum}`);
}
export function parseTaskBody(value) {
  try {
    string(value, 'taskBody', MAX_TASK_BODY, true);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export function validateCall(name, args) {
  if (name === 'control_task_get') {
    fields(args, ['inputFromRevision', 'inputLimit']);
    if (args.inputFromRevision !== undefined) count(args.inputFromRevision, 'inputFromRevision', 1);
    if (args.inputLimit !== undefined) {
      count(args.inputLimit, 'inputLimit', 1, MAX_INPUT_RANGE);
      if (args.inputFromRevision === undefined) invalid('inputLimit requires inputFromRevision');
    }
  } else if (name === 'control_task_set') {
    fields(args, ['taskBody', 'reason', 'reviewedInputRevision'], ['taskBody']);
    string(args.taskBody, 'taskBody', MAX_TASK_BODY, true);
  } else if (name === 'control_task_patch') {
    fields(args, ['expectedRevision', 'operations', 'reason', 'reviewedInputRevision'], ['expectedRevision', 'operations']);
    count(args.expectedRevision, 'expectedRevision', 1);
    if (!Array.isArray(args.operations) || args.operations.length < 1 || args.operations.length > MAX_PATCH_OPERATIONS) invalid(`operations must contain 1 to ${MAX_PATCH_OPERATIONS} entries`);
    let size = 0;
    for (const op of args.operations) {
      if (op?.op === 'add') fields(op, ['op', 'text', 'after'], ['op', 'text']);
      else if (op?.op === 'replace') fields(op, ['op', 'match', 'text'], ['op', 'match', 'text']);
      else if (op?.op === 'remove') fields(op, ['op', 'match'], ['op', 'match']);
      else invalid('unknown patch operation');
      for (const key of ['match', 'after', 'text']) {
        if (op[key] === undefined) continue;
        string(op[key], `operation ${key}`, MAX_TASK_BODY, key !== 'text');
        if (key !== 'text' && /[\r\n]/u.test(op[key])) invalid('patch anchors must be single lines');
        size += Buffer.byteLength(op[key], 'utf8');
      }
    }
    if (size > 128 * 1024) invalid('combined patch text exceeds 128 KiB');
  } else if (name === 'control_task_confirm') {
    fields(args, ['reviewedInputRevision', 'reason'], ['reviewedInputRevision']);
  } else invalid('unknown control-task operation');
  if (args.reason !== undefined) string(args.reason, 'reason', MAX_REASON, true);
  if (args.reviewedInputRevision !== undefined) count(args.reviewedInputRevision, 'reviewedInputRevision');
  return args;
}

export function applyPatch(body, operations) {
  let lines = body.replace(/\r\n/gu, '\n').split('\n');
  const initial = lines.join('\n');
  for (let index = 0; index < operations.length; index += 1) {
    const op = operations[index];
    const anchor = op.op === 'add' ? op.after : op.match;
    let at = lines.length - 1;
    if (anchor !== undefined) {
      const hits = [];
      for (let i = 0; i < lines.length; i += 1) if (lines[i].trim() === anchor.trim()) hits.push(i);
      if (hits.length !== 1) return { ok: false, error: `operation ${index + 1}: ${hits.length ? 'anchor is ambiguous' : 'no line matches the anchor'}` };
      [at] = hits;
    }
    if (op.op === 'remove') lines.splice(at, 1);
    else if (op.op === 'replace') lines.splice(at, 1, ...op.text.replace(/\r\n/gu, '\n').split('\n'));
    else lines.splice(at + 1, 0, ...op.text.replace(/\r\n/gu, '\n').split('\n'));
  }
  const result = lines.join('\n');
  return { ok: true, body: result === initial ? body : result };
}

// Pure mutation decision. Storage applies it and records its receipt atomically.
export function decideOperation(view, operation, args) {
  const reject = (code, message) => ({ status: 'rejected', code, message });
  if (operation === 'control_task_get') return { status: view.status === 'current' ? 'current' : 'not_set' };
  if (args.reviewedInputRevision !== undefined && args.reviewedInputRevision > view.inputRevision) return reject('FUTURE_INPUT_REVISION', 'reviewedInputRevision exceeds the current observed-input revision');
  if (operation === 'control_task_confirm') {
    if (view.status !== 'current') return reject('TASK_NOT_SET', 'No canonical task is set; optional confirmation did not change state');
    if (args.reviewedInputRevision !== view.inputRevision) return reject('STALE_INPUT_REVISION', `reviewedInputRevision does not match current observed-input revision ${view.inputRevision}; review metadata is unchanged`);
    if (view.reviewedInputRevision === view.inputRevision) return { status: 'unchanged', code: 'ALREADY_REVIEWED', message: 'A review was already recorded for this input revision; task unchanged' };
    return { status: 'committed', reviewedInputRevision: view.inputRevision, message: 'Observed-input review decision recorded; task body unchanged' };
  }
  let taskBody = args.taskBody;
  if (operation === 'control_task_patch') {
    if (view.status !== 'current') return reject('TASK_NOT_SET', 'No canonical task is set; this patch did not change state');
    if (args.expectedRevision !== view.revision) return reject('STALE_TASK_REVISION', `expectedRevision does not match current revision ${view.revision}; this patch did not change state`);
    const patched = applyPatch(view.taskBody, args.operations);
    if (!patched.ok) return reject('PATCH_ANCHOR', patched.error);
    taskBody = patched.body;
  }
  const parsed = parseTaskBody(taskBody);
  if (!parsed.ok) return reject('INVALID_TASK_BODY', parsed.error);
  const reviewedInputRevision = Math.max(view.reviewedInputRevision, args.reviewedInputRevision ?? view.reviewedInputRevision);
  if (view.taskBody === taskBody) return reviewedInputRevision > view.reviewedInputRevision
    ? { status: 'committed', code: 'REVIEW_RECORDED', reviewedInputRevision, message: 'Supplied observed-input review metadata recorded; task body unchanged' }
    : { status: 'unchanged', code: 'IDENTICAL_TASK', message: 'Task body and review metadata unchanged; no further task call is needed' };
  if (view.revision >= Number.MAX_SAFE_INTEGER) return reject('REVISION_LIMIT', 'Task revision counter is exhausted');
  return {
    status: 'committed', taskBody,
    reviewedInputRevision,
    message: 'Full canonical task revision committed',
  };
}
