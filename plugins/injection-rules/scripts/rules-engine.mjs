#!/usr/bin/env node
/**
 * injection-rules — standing-rule injector for MiniMax Code.
 *
 * Contract with the host (verified on mcode 0.6.12):
 *   - invoked as a command hook for SessionStart and UserPromptSubmit;
 *   - the event payload arrives as JSON on stdin;
 *   - the model-visible answer must be the envelope
 *     {"hookSpecificOutput":{"hookEventName":"<Event>","additionalContext":"..."}}
 *     (a flat {"additionalContext": ...} is rejected with HOOK_INVALID_OUTPUT);
 *   - nothing is printed when there is nothing to inject.
 *
 * Behaviour (mirrors the pi/omo rule set semantics):
 *   SessionStart      -> bodies of every applicable rule whose send_on_start is not false;
 *   UserPromptSubmit  -> reminder suffixes: remind.every_input fires on every prompt,
 *                        remind.every_n_turns fires when the session turn counter is a multiple of N.
 *
 * Rules are read from the user rules dir (authoritative) over the package's bundled
 * rules dir (defaults); a rule with the same name in the user dir wins.
 *
 * The engine never breaks a session: any failure logs and exits silently.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const USER_RULES_DIR = join(homedir(), '.minimax', 'rules');
const BUNDLED_RULES_DIR = process.env.PLUGIN_ROOT ? join(process.env.PLUGIN_ROOT, 'rules') : '';
const STATE_DIR = process.env.PLUGIN_DATA || join(homedir(), '.minimax', 'injection-rules-state');
const TURNS_FILE = join(STATE_DIR, 'turns.json');
const LOG_FILE = join(STATE_DIR, 'engine.log');
// mcode's top-level agent name; a hook payload carries no agent identity, so role
// exclusions ("!role") can only match this value. The shipped rule set uses "*" only.
const AGENT_NAME = process.env.MINIMAX_AGENT_NAME || 'mavis';
const MAX_TRACKED_SESSIONS = 40;

function log(message) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`);
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

function listRuleFiles(dir) {
  if (!dir || !existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.json') && !name.startsWith('_'))
      .sort();
  } catch {
    return [];
  }
}

function parseRule(path) {
  try {
    const rule = JSON.parse(readFileSync(path, 'utf8'));
    if (!rule || typeof rule.name !== 'string' || typeof rule.body !== 'string') return null;
    if (!Array.isArray(rule.apply) || rule.apply.length === 0) return null;
    return rule;
  } catch {
    return null;
  }
}

function loadRules() {
  const byName = new Map();
  for (const dir of [BUNDLED_RULES_DIR, USER_RULES_DIR]) {
    for (const file of listRuleFiles(dir)) {
      const rule = parseRule(join(dir, file));
      if (rule) byName.set(rule.name, rule);
    }
  }
  return [...byName.values()];
}

function applies(rule) {
  const selectors = rule.apply.map((value) => String(value));
  const agent = AGENT_NAME.toLowerCase();
  if (selectors.some((selector) => selector.startsWith('!') && selector.slice(1).toLowerCase() === agent)) {
    return false;
  }
  return selectors.includes('*') || selectors.some((selector) => selector.toLowerCase() === agent);
}

function loadTurns() {
  try {
    const parsed = JSON.parse(readFileSync(TURNS_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveTurns(turns) {
  try {
    const entries = Object.entries(turns).sort((a, b) => (b[1].updated || 0) - (a[1].updated || 0));
    const trimmed = Object.fromEntries(entries.slice(0, MAX_TRACKED_SESSIONS));
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(TURNS_FILE, `${JSON.stringify(trimmed, null, 2)}\n`);
  } catch (error) {
    log(`state write failed: ${error && error.message}`);
  }
}

function startupText(rules) {
  const bodies = rules
    .filter((rule) => rule.send_on_start !== false)
    .map((rule) => String(rule.body).trim())
    .filter(Boolean);
  if (bodies.length === 0) return '';
  return [
    '[standing-rules] The rules below are active for this session. Their full reminder text is',
    'delivered periodically by the same injector; treat the bodies as standing requirements.',
    '',
    bodies.join('\n\n'),
  ].join('\n');
}

function reminderText(rules, turn) {
  const parts = [];
  for (const rule of rules) {
    const remind = rule.remind;
    if (!remind || typeof remind !== 'object') continue;
    const suffix = typeof remind.suffix === 'string' ? remind.suffix.trim() : '';
    if (!suffix) continue;
    const cadence = Number(remind.every_n_turns);
    if (remind.every_input === true) {
      parts.push(suffix);
      continue;
    }
    if (Number.isInteger(cadence) && cadence > 0 && turn % cadence === 0) {
      parts.push(suffix);
    }
  }
  return parts.join('\n\n');
}

function emit(eventName, text) {
  if (!text) return;
  process.stdout.write(
    `${JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext: text } })}\n`,
  );
}

function main() {
  const payload = readPayload();
  const eventName = String(payload.hook_event_name || '');
  const sessionId = String(payload.session_id || 'unknown');
  const rules = loadRules().filter(applies);
  if (rules.length === 0) {
    log(`${eventName} session=${sessionId} no applicable rules`);
    return;
  }

  if (eventName === 'SessionStart') {
    const text = startupText(rules);
    log(
      `${eventName} session=${sessionId} bodies=[${rules
        .filter((rule) => rule.send_on_start !== false)
        .map((rule) => rule.name)
        .join(',')}] chars=${text.length}`,
    );
    emit(eventName, text);
    return;
  }

  if (eventName === 'UserPromptSubmit') {
    const turns = loadTurns();
    const previous = Number(turns[sessionId] && turns[sessionId].turn) || 0;
    const turn = previous + 1;
    turns[sessionId] = { turn, updated: Date.now() };
    saveTurns(turns);

    const text = reminderText(rules, turn);
    const fired = rules
      .filter((rule) => {
        const remind = rule.remind;
        if (!remind || typeof remind !== 'object') return false;
        if (!(typeof remind.suffix === 'string' && remind.suffix.trim())) return false;
        if (remind.every_input === true) return true;
        const cadence = Number(remind.every_n_turns);
        return Number.isInteger(cadence) && cadence > 0 && turn % cadence === 0;
      })
      .map((rule) => rule.name);
    log(`${eventName} session=${sessionId} turn=${turn} fired=[${fired.join(',')}] chars=${text.length}`);
    emit(eventName, text);
    return;
  }

  log(`${eventName} session=${sessionId} ignored (no injection path for this event)`);
}

try {
  main();
} catch (error) {
  log(`fatal: ${error && error.stack ? error.stack : error}`);
}