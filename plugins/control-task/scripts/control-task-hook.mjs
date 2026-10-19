#!/usr/bin/env node
/**
 * control-task hook — maintains the active-session pointer and re-injects the
 * durable canonical task into every model call.
 *
 * Contract with the host (verified on mcode 0.6.12):
 *   - invoked as a command hook for SessionStart and UserPromptSubmit;
 *   - the event payload arrives as JSON on stdin and carries `session_id`;
 *   - the model-visible answer is the envelope
 *     {"hookSpecificOutput":{"hookEventName":"<Event>","additionalContext":"..."}};
 *   - nothing is printed when there is nothing to inject.
 *
 * The pointer is what lets the MCP tool find the session it belongs to: the
 * MCP `tools/call` payload carries no session identity.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  resolveControlTask,
  writeActiveSession,
} from './control-task-store.mjs';

function log(message) {
  try {
    process.stderr.write(`[control-task] ${message}\n`);
  } catch {
    /* logging must never break the session */
  }
}

function readPayload() {
  try {
    const raw = readFileSync(0, 'utf8');
    return raw ? JSON.parse(raw) : {};
  } catch (error) {
    log(`stdin parse failed: ${error && error.message}`);
    return {};
  }
}

function emit(eventName, text) {
  if (!text) return;
  process.stdout.write(
    `${JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext: text } })}\n`,
  );
}

function anchorText(taskBody) {
  return [
    '<!-- control-task:v1 -->',
    'Internal task anchor, not a user message. Original user messages govern. Update control-task only after actual user input; never persist progress, status, checks or next steps.',
    '',
    taskBody,
  ].join('\n');
}

function main() {
  const payload = readPayload();
  const eventName = String(payload.hook_event_name || '');
  const sessionId = String(payload.session_id || '');
  if (!sessionId) {
    log(`${eventName} payload has no session_id`);
    return;
  }
  writeActiveSession(sessionId);

  const resolution = resolveControlTask(sessionId);
  if (resolution.status === 'unavailable') {
    log(`${eventName} session=${sessionId} store unavailable: ${resolution.error}`);
    return;
  }
  if (resolution.status === 'uninitialized') {
    log(`${eventName} session=${sessionId} no canonical task yet`);
    return;
  }
  const text = anchorText(resolution.taskBody);
  log(`${eventName} session=${sessionId} injected chars=${text.length}`);
  emit(eventName, text);
}

try {
  main();
} catch (error) {
  log(`fatal: ${error && error.stack ? error.stack : error}`);
}
