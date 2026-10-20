// Budget the whole encoded hook response. Canonical text is complete or supplied
// by an exact original locator; it is never silently clipped or summarized.
import { formatDefinitiveResult, hookOutputByteLength } from './runtime/host.mjs';
import { RuntimeError } from './runtime/storage.mjs';
import { TASK_CONTENT_GUIDANCE, TASK_REVIEW_GUIDANCE, TASK_INPUT_GUIDANCE, TASK_COMPACT_GUIDANCE, TASK_WORKFLOW_GUIDANCE } from './control-task-core.mjs';

export const MAX_TASK_CONTEXT_CHARS = 20000;
const ENCODED_CONTEXT_BUDGET = 58 * 1024;
const MARKER = '<!-- control-task:v2 -->';
const PROVENANCE = `Internal derived task anchor, not a new user message. Original instructions and their actual priority govern. Never rebuild the canonical body from a compacted summary or automatically rewrite it from observed prompts. ${TASK_CONTENT_GUIDANCE}`;
const INPUT_PROVENANCE = 'Input provenance: native UserPromptSubmit hook observations only. The host does not expose final acceptance, human provenance or a unique per-input identity. Every occurrence is retained, including identical same-turn steering; a hook replay may conservatively add an observation. This is not an exact-once accepted-human-message count.';

function contextBudget(event, statePath) {
  if (!['SessionStart', 'SubagentStart', 'UserPromptSubmit'].includes(event)) return MAX_TASK_CONTEXT_CHARS;
  // Native beginTurn merges a restore and a prompt observation before applying
  // one context limit. Share one task reservation across those two outputs.
  // Ordinary paths leave 16k for restoration and 4k for fresh input metadata. Longer
  // stable session paths shift room to the prompt's complete original locator.
  // This is a pure allocation, not a delivered-input or task-body dedup record.
  const promptBudget = Math.min(10000, Math.max(4000, (statePath?.length ?? 0) + 1800));
  return event === 'UserPromptSubmit' ? promptBudget : MAX_TASK_CONTEXT_CHARS - promptBudget;
}

function fits(event, prefix, text, maxChars) {
  return prefix.length + text.length <= maxChars && hookOutputByteLength(event, prefix + text) < ENCODED_CONTEXT_BUDGET;
}

export function renderSnapshot(view, { event = 'SessionStart', prefix = '' } = {}) {
  const maxChars = contextBudget(event, view.statePath);
  const fitsSnapshot = (text) => fits(event, prefix, text, maxChars);
  const inputGuidance = event === 'UserPromptSubmit' ? TASK_INPUT_GUIDANCE : '';
  if (view.status === 'unavailable') {
    const text = [MARKER, 'ACTIVE TASK — UNAVAILABLE', PROVENANCE,
      `Task storage or delivery is unavailable (${view.errorCode || 'TASK_UNAVAILABLE'}). Existing files remain retained; absence was not established.`,
      ...(view.statePath ? [`Canonical state location: ${view.statePath}`] : []),
      'No task body or review count is inferred from the failure.',
      inputGuidance,
      TASK_WORKFLOW_GUIDANCE,
    ].filter(Boolean).join('\n\n');
    return fitsSnapshot(text) ? text : [MARKER, 'ACTIVE TASK — UNAVAILABLE', 'Existing state is retained; identity or the full state locator could not be delivered.', inputGuidance, TASK_WORKFLOW_GUIDANCE].filter(Boolean).join('\n');
  }
  const historical = (view.latestRevision !== undefined && view.latestRevision !== view.revision) ||
    (view.latestInputRevision !== undefined && view.latestInputRevision !== view.inputRevision) ||
    (view.latestReviewedInputRevision !== undefined && view.latestReviewedInputRevision !== view.reviewedInputRevision);
  const historicalNotice = historical ? `This is the recorded operation snapshot; current taskRevision=${view.latestRevision}, inputRevision=${view.latestInputRevision}, reviewedInputRevision=${view.latestReviewedInputRevision}. The old outcome below is not a claim of current review coverage. control_task_get exposes the current task and optional review metadata when needed.` : '';
  const head = [MARKER, view.status === 'current' ? `${historical ? 'RECORDED TASK SNAPSHOT' : 'CANONICAL TASK'} — revision ${view.revision}` : 'ACTIVE TASK — NOT SET', PROVENANCE,
    `taskRevision=${view.revision}; inputRevision=${view.inputRevision}; reviewedInputRevision=${view.reviewedInputRevision}; unreviewed=${view.unreviewed}.`,
    historicalNotice,
    view.status === 'current' ? `Complete original canonical body: ${view.bodyLocator}` : 'The complete enduring task can be recorded with control_task_set; transient progress stays in the conversation.',
    view.indexStatus === 'current' ? `Complete task/input locator index: ${view.indexPath}` : `Derived locator index unavailable; the authoritative canonical record retains every archive range and active record: ${view.statePath}`,
    'Revision locators are stable logical selectors: find the matching revision in active arrays, or resolve its archive range in the canonical file/index. They are not array offsets.',
    INPUT_PROVENANCE,
    TASK_REVIEW_GUIDANCE,
    inputGuidance,
    view.unreviewed > 0 ? `Optional review metadata has not covered observed input revisions ${view.reviewedInputRevision + 1} through ${view.inputRevision}. Originals are available through control_task_get({inputFromRevision:${view.reviewedInputRevision + 1},inputLimit:20}) or the exact index when needed. This advisory count does not require a read or confirmation for unchanged steering.` : 'Recorded review metadata covers the stated observation range; this does not certify that every requirement was extracted correctly.',
    TASK_WORKFLOW_GUIDANCE,
  ].filter(Boolean);
  let text = head.join('\n\n');
  if (!fitsSnapshot(text)) {
    // Long supported paths can consume almost the entire envelope. Keep a
    // single authoritative path which includes all body and input ranges.
    text = [MARKER, `Task status=${view.status}; revision=${view.revision}; inputRevision=${view.inputRevision}; reviewedInputRevision=${view.reviewedInputRevision}; unreviewed=${view.unreviewed}.`, historicalNotice, PROVENANCE,
      `Complete canonical body and all raw-input archive ranges are retained at: ${view.statePath}`,
      view.indexStatus === 'current' ? `Complete locator index: ${view.indexPath}` : 'The derived locator index is unavailable; the canonical file retains the originals.', INPUT_PROVENANCE,
      TASK_REVIEW_GUIDANCE,
      inputGuidance,
      TASK_WORKFLOW_GUIDANCE,
    ].filter(Boolean).join('\n\n');
  }
  if (view.status === 'current') {
    const full = `${text}\n\n[BEGIN VERBATIM CANONICAL TASK]\n${view.taskBody}\n[END VERBATIM CANONICAL TASK]`;
    if (fitsSnapshot(full)) text = full;
    else text += '\n\nThe complete canonical body is omitted from this response because its allocated hook/context budget cannot carry it. Its exact original locator is available above when needed; no truncated substitute is provided.';
  }
  const records = view.inputRecords ?? [];
  if (records.length) {
    let included = 0;
    for (const input of records) {
      const locator = `\n\nObserved input revision ${input.inputRevision}; original: ${input.locator}`;
      const withLocator = text + locator;
      if (!fitsSnapshot(withLocator + '\nSome requested text or locators are omitted here; use the complete locator index/canonical archive ranges above.')) break;
      text = withLocator;
      included += 1;
      if (typeof input.text === 'string' && input.text.length < MAX_TASK_CONTEXT_CHARS) {
        const raw = `${text}\nObserved turn=${input.turnId ?? 'unavailable'}; provenance=native-UserPromptSubmit-observation.\nRaw prompt text (JSON string): ${JSON.stringify(input.text)}`;
        if (fitsSnapshot(raw + '\nSome requested text or locators are omitted here; use the complete locator index/canonical archive ranges above.')) text = raw;
        else text += '\nRaw text retained at the original locator; it does not fit this response.';
      } else text += '\nRaw text retained at the original locator; it is omitted under the event read/output budget.';
    }
    if (included < records.length) text += '\n\nSome requested input locators are omitted here; every locator is recoverable from the complete index or canonical archive ranges above.';
  }
  if (!fitsSnapshot(text)) {
    // Failure is explicit. Keep the complete original path, not a clipped body.
    text = [MARKER, `Task status=${view.status}; revision=${view.revision}; inputRevision=${view.inputRevision}; reviewedInputRevision=${view.reviewedInputRevision}; unreviewed=${view.unreviewed}.`, historicalNotice,
      `Complete canonical body and raw-input ranges: ${view.statePath}`,
      `Text omitted under the allocated hook/context budget. ${TASK_COMPACT_GUIDANCE}`,
      inputGuidance,
      view.unreviewed > 0 ? `Original input revisions ${view.reviewedInputRevision + 1} through ${view.inputRevision} remain available. Review metadata is optional and only records inputs actually considered.` : '',
    ].filter(Boolean).join('\n');
  }
  if (!fitsSnapshot(text)) throw new RuntimeError('TASK_DELIVERY_LIMIT', 'The complete task/raw-input locator cannot fit its allocated context; original state remains retained', { path: view.statePath });
  return text;
}

export function renderOperation(receipt, result) {
  const { outcome, view, replayed } = result;
  const details = [outcome.message ?? '', outcome.code ? `code=${outcome.code}` : '',
    `Recorded outcome: taskRevision=${outcome.revision}; inputRevision=${outcome.inputRevision}; reviewedInputRevision=${outcome.reviewedInputRevision}; unreviewed=${outcome.unreviewed}.`,
    replayed ? 'Retained completed receipt replayed. This invocation did not apply the operation again.' : '',
    view.indexStatus === 'unavailable' ? 'The operation outcome above is retained; derived locator-index delivery is unavailable and can refresh on a later hook.' : '',
    view.status === 'unavailable' ? 'The recorded operation outcome remains authoritative, but the requested text snapshot is unavailable; no complete-read claim is made for that text.' : '',
  ].filter(Boolean).join('\n');
  const prefix = `${formatDefinitiveResult(receipt, outcome, details)}\n\n`;
  return prefix + renderSnapshot(view, { event: 'PostToolUse', prefix });
}
