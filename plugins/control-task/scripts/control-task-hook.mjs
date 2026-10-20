#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import {
  readHookPayload, resolveHookIdentity, readNativeLineage,
  validatePendingReceipt, formatDefinitiveResult, emitHookResult,
} from './runtime/host.mjs';
import { boundedDiagnostic, RuntimeError } from './runtime/storage.mjs';
import { TOOLS, validateCall } from './control-task-core.mjs';
import { ControlTaskStore } from './control-task-store.mjs';
import { renderOperation, renderSnapshot } from './control-task-render.mjs';
import { completedStopBoundary } from './control-task-checkpoint.mjs';

export async function handleHook(payload, { env = process.env, output = process.stdout, stderr = process.stderr, storeOptions = {} } = {}) {
  const event = payload.hook_event_name;
  const isStop = ['Stop', 'SubagentStop'].includes(event);
  let identity;
  let store;
  let pending;
  try {
    if (event === 'PostToolUse') {
      pending = validatePendingReceipt(payload, 'control-task', { tools: TOOLS, validateCall });
      if (!pending) return;
    } else if (!['SessionStart', 'SubagentStart', 'UserPromptSubmit', 'Stop', 'SubagentStop'].includes(event)) return;
    if (isStop && !completedStopBoundary(payload)) return;
    identity = resolveHookIdentity(payload, 'control-task', { env });
    const lineage = await readNativeLineage(identity);
    store = new ControlTaskStore(identity, { lineage, ...storeOptions });
    if (isStop) {
      const decision = await store.checkpoint(payload.stop_hook_active === true);
      if (decision.reason) await boundedDiagnostic(decision.code, { plugin: 'control-task', sessionId: identity.sessionId, operation: decision.reason, location: store.paths.checkpoint, logDirectory: join(identity.pluginDataDir, 'control-task', 'logs') }, { stderr });
      // Native pxn treats Stop additionalContext as a continuation too. Spent
      // budgets must be diagnostics only, never a fresh context prompt.
      if (decision.block) emitHookResult(event, '', { output, decision: 'block', reason: decision.message });
      return;
    }
    let text;
    if (pending) text = renderOperation(pending.receipt, await store.execute(pending.receipt, pending.args));
    else {
      const view = event === 'UserPromptSubmit' ? await store.capturePrompt(payload.prompt) : await store.snapshot();
      text = renderSnapshot(view, { event });
      if (view.indexStatus === 'unavailable') await boundedDiagnostic(view.deliveryCode || 'TASK_INDEX_UNAVAILABLE', { plugin: 'control-task', sessionId: identity.sessionId, location: store.paths.index, logDirectory: join(identity.pluginDataDir, 'control-task', 'logs') }, { stderr });
    }
    emitHookResult(event, text, { output });
  } catch (error) {
    const code = error instanceof RuntimeError ? error.code : 'CONTROL_TASK_INTERNAL';
    await boundedDiagnostic(code, { plugin: 'control-task', sessionId: identity?.sessionId, operation: pending?.operation, location: error.path || store?.paths.state, logDirectory: identity ? join(identity.pluginDataDir, 'control-task', 'logs') : undefined }, { stderr });
    if (isStop) return; // Never continue without durable, verified accounting.
    const view = { status: 'unavailable', errorCode: code, statePath: store?.paths.state || error.path };
    let text;
    if (pending) {
      const status = error.committed ? 'uncertain' : error.status === 'rejected' ? 'rejected' : 'unavailable';
      const message = [
        `code=${code}`,
        error.committed ? 'The canonical file replacement occurred, but final durability is uncertain. The retained receipt may be retried to recover its recorded outcome; do not repeat the mutation under a new logical operation.' : 'This hook did not commit the requested task mutation. A previous invocation may have a retained outcome; this failure does not establish that no earlier commit occurred.',
        error instanceof RuntimeError ? error.message : 'The control-task operation could not complete.',
        error.recoveryPath ? `Prepared recovery artifact retained: ${error.recoveryPath}` : '',
      ].filter(Boolean).join('\n');
      const prefix = `${formatDefinitiveResult(pending.receipt, { status }, message)}\n\n`;
      text = prefix + renderSnapshot(view, { event, prefix });
    } else if (event === 'PostToolUse') {
      text = `[control-task operation rejected]\ncode=${code}\nThe tool result did not establish a valid matching pending receipt. This hook did not execute a session operation.`;
    } else text = renderSnapshot(view, { event });
    emitHookResult(event, text, { output });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await handleHook(await readHookPayload()); }
  catch (error) { await boundedDiagnostic(error instanceof RuntimeError ? error.code : 'HOOK_INPUT_INVALID', { plugin: 'control-task' }); }
}
