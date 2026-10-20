// Only deterministic task-state debt can request a native stop continuation.
// Tool names and the mere existence of later output are not verification proof.
import { TASK_CONTENT_GUIDANCE, TASK_REVIEW_GUIDANCE } from './control-task-core.mjs';
export const RUN_CONTINUATION_LIMIT = 1;
export const SESSION_CONTINUATION_LIMIT = 3;
export const EVIDENCE_REMINDER = 'Verification reminder: assess the relevant observed behavior and its actual errors before claiming completion. A tool name, a successful command, or an unrelated later observation does not prove correctness. State a concrete unverified outcome when a required check cannot run.';

const MESSAGES = {
  'task-uninitialized': `No canonical task is set. Record the complete enduring task with control_task_set before settling. ${TASK_CONTENT_GUIDANCE}`,
  'task-unavailable': 'The canonical task cannot be read or trusted. Preserve the original state and report its concrete recovery blocker; do not reconstruct or replace it from a summary.',
  'input-unreviewed': `Raw native prompt observations remain unreviewed. Read their original locations. ${TASK_CONTENT_GUIDANCE} ${TASK_REVIEW_GUIDANCE} Confirmation requires the exact current input revision.`,
};

export function pendingBlocker(view) {
  if (view.status === 'uninitialized') return 'task-uninitialized';
  if (view.status === 'unavailable') return 'task-unavailable';
  if (view.status === 'current' && view.unreviewed > 0) return 'input-unreviewed';
  return null;
}

export function validateBudget(value, sessionId) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1 || value.sessionId !== sessionId || !Array.isArray(value.runs) || value.runs.length > SESSION_CONTINUATION_LIMIT) throw new Error('Invalid continuation budget');
  const ids = new Set();
  for (const run of value.runs) {
    if (!run || typeof run !== 'object' || typeof run.turnId !== 'string' || !run.turnId || run.turnId.length > 256 || !run.turnId.isWellFormed() || /[\x00-\x1f\x7f]/u.test(run.turnId) || ids.has(run.turnId) || !Object.hasOwn(MESSAGES, run.reason) || typeof run.at !== 'string' || !Number.isFinite(Date.parse(run.at))) throw new Error('Invalid run continuation record');
    ids.add(run.turnId);
  }
  return value;
}

export function evaluateCheckpoint({ status, unreviewed = 0, budget, turnId, stopHookActive = false }) {
  const reason = pendingBlocker({ status, unreviewed });
  if (!reason) return { block: false, reason: null };
  if (typeof turnId !== 'string' || !turnId) return { block: false, reason, code: 'CHECKPOINT_RUN_UNAVAILABLE', message: `${MESSAGES[reason]} Trusted turn identity is unavailable; no unaccounted continuation was granted.` };
  const runSpent = budget.runs.some((entry) => entry.turnId === turnId);
  if (stopHookActive || runSpent || budget.runs.length >= SESSION_CONTINUATION_LIMIT) return {
    block: false, reason, code: 'CHECKPOINT_BUDGET_SPENT',
    message: `${MESSAGES[reason]} The obligation is still pending. Continuation limit: this run ${runSpent ? 1 : 0}/${RUN_CONTINUATION_LIMIT}, session ${budget.runs.length}/${SESSION_CONTINUATION_LIMIT}${stopHookActive ? '; native stop_hook_active loop guard is set' : ''}.`,
  };
  return { block: true, reason, code: 'CHECKPOINT_CONTINUE', message: `${MESSAGES[reason]} This is the single permitted continuation for this run (${budget.runs.length + 1}/${SESSION_CONTINUATION_LIMIT} in this session).` };
}

export function completedStopBoundary(payload) {
  if (!['Stop', 'SubagentStop'].includes(payload?.hook_event_name)) return false;
  // Native 0.6.12 emits these callbacks only from the completed model-loop
  // branch. These extra fields are not native outcome evidence; refuse an
  // explicitly errored/cancelled synthetic or future envelope defensively.
  if (payload.outcome !== undefined && payload.outcome !== 'completed') return false;
  if (payload.aborted === true || payload.is_error === true || ['error', 'aborted', 'cancelled', 'canceled'].includes(payload.stop_reason)) return false;
  return true;
}
