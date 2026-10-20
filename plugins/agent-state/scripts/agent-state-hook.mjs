#!/usr/bin/env node
// The native hook is the only session owner. The corresponding stateless MCP
// receipt remains visibly pending unless this hook supplies a definitive result.
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readHookPayload, resolveHookIdentity, readNativeLineage,
  validatePendingReceipt, formatDefinitiveResult, emitHookResult,
} from './runtime/host.mjs';
import { boundedDiagnostic } from './runtime/storage.mjs';
import { PLUGIN, TOOLS, validateCall } from './agent-state-core.mjs';
import {
  withGuideSession, executeGuideOperation, recoverPendingOperations,
} from './agent-state-store.mjs';
import {
  prepareGuideDelivery, markGuideDelivery, deliverySettings,
} from './agent-state-delivery.mjs';

const EVENTS = new Set(['SessionStart', 'SubagentStart', 'UserPromptSubmit', 'PostToolUse']);
function errorCode(error) {
  return typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/u.test(error.code) ? error.code : 'GUIDE_UNAVAILABLE';
}
function diagnose(identity, code, { operation, location } = {}) {
  boundedDiagnostic(code, {
    plugin: PLUGIN, sessionId: identity?.sessionId, operation, location,
    ...(identity?.pluginDataDir ? { logDirectory: join(identity.pluginDataDir, 'logs') } : {}),
  });
}

export function outcomeText(outcome) {
  if (outcome.committed) {
    return `Reusable guide committed: file index ${outcome.note_id}; original ${outcome.path}. ${outcome.replayed ? 'This is the recorded outcome of this invocation; no duplicate guide was written. ' : ''}${outcome.status === 'partial' || outcome.recoveryRequired ? `The file is committed, but receipt/durability bookkeeping needs attention (${outcome.code}); derived delivery will be retried. ` : ''}Continue the next authorized task action.`;
  }
  if (outcome.notAdmitted) return `This invocation did not execute: ${outcome.code}. An unknown expired or future receipt cannot initiate a save; this says nothing about whether an earlier invocation committed.`;
  if (outcome.pending) return `Save outcome is uncertain (${outcome.code}). Its retained recovery record prevents duplicate or conflicting writes. Original target: ${outcome.path}. No new save is claimed; recovery will be retried.`;
  if (outcome.code === 'INTERRUPTED_SAVE_NOT_RETAINED') return 'The interrupted save did not leave the intended file in place. Recovery did not repeat the mutation or create another guide; no historical commit claim is made.';
  return `Guide save ${outcome.status}: ${outcome.code}.${outcome.path ? ` Relevant original location: ${outcome.path}.` : ''} No successful save is claimed for this invocation.`;
}

export async function handleGuideHook(payload, { env = process.env, emit = emitHookResult } = {}) {
  if (!EVENTS.has(payload.hook_event_name)) return { status: 'ignored' };
  const identity = resolveHookIdentity(payload, PLUGIN, { env });
  const lineage = await readNativeLineage(identity);
  const ownOperation = TOOLS.find((tool) => payload.tool_name === `mcp__${PLUGIN}__${tool.name}`)?.name ?? null;
  let request = null;
  let receiptError = null;
  try { request = validatePendingReceipt(payload, PLUGIN, { tools: TOOLS, validateCall }); }
  catch (error) {
    receiptError = error;
    diagnose(identity, errorCode(error), { operation: ownOperation });
  }
  let prefix = '';
  let outcome = null;
  try {
    return await withGuideSession(identity, lineage, async (context) => {
      if (request) {
        try { outcome = executeGuideOperation(context, request); }
        catch (error) {
          outcome = { status: 'unavailable', committed: false, code: errorCode(error), path: error.path };
        }
        prefix = formatDefinitiveResult(request.receipt, outcome, outcomeText(outcome));
        diagnose(identity, outcome.code ?? 'GUIDE_OPERATION_COMPLETED', { operation: request.operation, location: outcome.path });
      } else {
        const unresolved = recoverPendingOperations(context);
        if (unresolved.length) diagnose(identity, unresolved[0].code, { location: unresolved[0].path });
      }
      if (receiptError) {
        prefix = `[agent-state definitive operation result]\noperation=${ownOperation} receipt=unverified status=rejected\nThis invocation did not execute: ${errorCode(receiptError)}. The native result did not provide a valid matching pending receipt; no successful save is claimed.`;
      }
      const delivery = prepareGuideDelivery(context, payload, {
        prefix, ownTool: ownOperation !== null, successfulSave: outcome?.committed === true,
        settings: deliverySettings(env),
      });
      if (!delivery.collection.complete) {
        const issue = delivery.collection.issues[0];
        diagnose(identity, issue?.code ?? 'GUIDE_COLLECTION_PARTIAL', { location: issue?.path });
      }
      if (delivery.error) diagnose(identity, errorCode(delivery.error), { location: delivery.error.path });
      // Persist completed-tool cadence before output. A failure here affects
      // mechanical delivery, not an already committed original guide file.
      try { context.persist(); }
      catch (error) {
        context.state.delivery.refreshDue = true;
        delivery.snapshotDelivered = false;
        delivery.status = 'unavailable';
        delivery.text = `${prefix}${prefix ? '\n\n' : ''}[agent-state delivery unavailable: ${errorCode(error)}]\nThe original guide files are retained at ${context.dir}. Mechanical delivery state could not be recorded; refresh will be retried. A separately committed save remains committed.`;
        diagnose(identity, errorCode(error), { location: error.path });
      }
      emit(payload.hook_event_name, delivery.text);
      if (delivery.snapshotDelivered) {
        markGuideDelivery(context, delivery);
        try { context.persist(); }
        catch (error) { diagnose(identity, 'GUIDE_DELIVERY_STATE_RETRY', { location: error.path }); }
      }
      return { status: 'handled', outcome, deliveryStatus: delivery.status, text: delivery.text };
    });
  } catch (error) {
    diagnose(identity, errorCode(error), { operation: ownOperation, location: error.path });
    if (request && !prefix) {
      outcome = { status: 'unavailable', committed: false, code: errorCode(error) };
      prefix = formatDefinitiveResult(request.receipt, outcome,
        `This invocation could not access its session store (${outcome.code}). Its save result is unavailable; no successful save is claimed by this hook failure.`);
    }
    const unavailable = `[agent-state unavailable: ${errorCode(error)}]\n${outcome?.committed
      ? 'The separately reported guide file remains committed; this subsequent hook step could not finish. Delivery will be retried.'
      : 'Original guide files are retained. This hook failure does not establish a successful save; retain the pending result and retry when the reported storage/binding issue is resolved.'}`;
    // The native tool's original pending text remains intact. This context
    // reports the failure without claiming to rewrite the host's isError flag.
    emit(payload.hook_event_name, prefix ? `${prefix}\n\n${unavailable}` : unavailable);
    return { status: 'unavailable', code: errorCode(error), outcome };
  }
}

async function main() {
  let payload;
  try {
    payload = await readHookPayload();
    await handleGuideHook(payload);
  } catch (error) {
    diagnose(null, errorCode(error));
    if (payload && EVENTS.has(payload.hook_event_name)) {
      emitHookResult(payload.hook_event_name, `[agent-state unavailable: ${errorCode(error)}]\nThe hook could not establish trusted session storage. No successful save is claimed.`);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
