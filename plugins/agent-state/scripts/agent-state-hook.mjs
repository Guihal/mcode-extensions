#!/usr/bin/env node
/**
 * agent-state hook — re-delivers the session's reusable guides into context and
 * reminds the model to save new ones at the configured cadence.
 *
 * Contract with the host (verified on mcode 0.6.12):
 *   - invoked as a command hook for SessionStart and UserPromptSubmit;
 *   - the event payload arrives as JSON on stdin and carries `session_id`;
 *   - the model-visible answer is the envelope
 *     {"hookSpecificOutput":{"hookEventName":"<Event>","additionalContext":"..."}};
 *   - nothing is printed when there is nothing to inject.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  POLICY,
  SAVE_REMINDER,
  buildInjection,
  digestOf,
  readActiveSession,
  readGuides,
  stateRoot,
  writeActiveSession,
} from './agent-state-store.mjs';

const REMIND_EVERY = Number(process.env.AGENT_STATE_REMIND_EVERY || 10);
const MAX_INJECT = Number(process.env.AGENT_STATE_MAX_INJECT_BYTES || 80000);

function log(message) {
  try {
    process.stderr.write(`[agent-state] ${message}\n`);
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

function turnCounterPath(sessionId) {
  return join(stateRoot(), `turns-${sessionId}.json`);
}

function bumpTurn(sessionId) {
  const file = turnCounterPath(sessionId);
  let turns = 0;
  try {
    turns = Number(JSON.parse(readFileSync(file, 'utf8')).turns) || 0;
  } catch {
    turns = 0;
  }
  turns += 1;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ turns })}\n`, 'utf8');
  } catch (error) {
    log(`turn counter write failed: ${error && error.message}`);
  }
  return turns;
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

  const files = readGuides(sessionId);
  const digest = digestOf(files);
  const parts = [];
  if (files.length > 0) {
    const body = buildInjection({
      files,
      maxBytes: MAX_INJECT,
      preamble: `[agent-state: session guide files]\n[agent-state ledger sha256=${digest}]\n${POLICY}\n\n`,
    });
    parts.push(body);
  }
  const turns = bumpTurn(sessionId);
  if (Number.isInteger(REMIND_EVERY) && REMIND_EVERY > 0 && turns % REMIND_EVERY === 0) {
    parts.push(SAVE_REMINDER);
  }
  const text = parts.join('\n');
  if (!text) {
    log(`${eventName} session=${sessionId} files=0 turns=${turns} nothing to inject`);
    return;
  }
  log(`${eventName} session=${sessionId} files=${files.length} turns=${turns} chars=${text.length}`);
  emit(eventName, text);
}

try {
  main();
} catch (error) {
  log(`fatal: ${error && error.stack ? error.stack : error}`);
}
