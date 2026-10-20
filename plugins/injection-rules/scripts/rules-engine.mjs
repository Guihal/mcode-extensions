#!/usr/bin/env bun
/**
 * Standing rules for MiniMax Code's MINIMAX-format command hooks (0.6.12).
 *
 * SessionStart, including source=compact, and SubagentStart deliver full bodies.
 * UserPromptSubmit delivers input/cadence reminders; PostToolUse delivers only
 * every_tool reminders. The host appends PostToolUse context to successful AND
 * failed tool results. PostCompact itself cannot accept additionalContext.
 *
 * User rules override bundled defaults by name. stdout is reserved for the host
 * envelope; a broken rule/state store must not block tools or hide other rules.
 */
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync,
  statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const USER_RULES_DIR = join(homedir(), '.minimax', 'rules');
const BUNDLED_RULES_DIR = process.env.PLUGIN_ROOT ? join(process.env.PLUGIN_ROOT, 'rules') : '';
const STATE_DIR = process.env.PLUGIN_DATA || join(homedir(), '.minimax', 'injection-rules-state');
const LOG_FILE = join(STATE_DIR, 'engine.log');
const EVENTS = new Set(['SessionStart', 'SubagentStart', 'UserPromptSubmit', 'PostToolUse']);
const MAX_DIAGNOSTICS = 10;
let diagnosticCount = 0;

function diagnostic(code, detail = '') {
  if (diagnosticCount++ >= MAX_DIAGNOSTICS) return;
  // Do not copy prompts, tool arguments/results, or parser error excerpts to logs.
  const line = `[injection-rules] ${code}${detail ? ` ${JSON.stringify(String(detail).slice(0, 200))}` : ''}\n`;
  try { process.stderr.write(line); } catch { /* diagnostics are best effort */ }
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > 128 * 1024) {
      renameSync(LOG_FILE, `${LOG_FILE}.previous`);
    }
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}`);
  } catch { /* stderr remains available when the state directory is not writable */ }
}

function readPayload() {
  try {
    const raw = readFileSync(0, 'utf8');
    const value = raw ? JSON.parse(raw) : null;
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch { /* never log raw input */ }
  diagnostic('INVALID_PAYLOAD');
  return null;
}

function listRuleFiles(dir) {
  if (!dir || !existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.json') && !name.startsWith('_'))
      .sort();
  } catch {
    diagnostic('RULE_DIRECTORY_UNREADABLE', dir);
    return [];
  }
}

function loadRules() {
  const byName = new Map();
  for (const dir of [BUNDLED_RULES_DIR, USER_RULES_DIR]) {
    for (const file of listRuleFiles(dir)) {
      try {
        const rule = JSON.parse(readFileSync(join(dir, file), 'utf8'));
        if (!rule || typeof rule.name !== 'string' || !rule.name.trim()
          || typeof rule.body !== 'string' || !Array.isArray(rule.apply)
          || !rule.apply.length || rule.apply.some((selector) => typeof selector !== 'string')) {
          diagnostic('INVALID_RULE', file);
          continue;
        }
        byName.set(rule.name, rule);
      } catch {
        diagnostic('RULE_UNREADABLE_OR_INVALID', file);
      }
    }
  }
  return [...byName.values()];
}

function applies(rule, agentName, unknownIdentity) {
  const selectors = rule.apply.map((selector) => selector.toLowerCase());
  if (unknownIdentity) {
    return rule.send_on_start !== false && rule.send_on_subagent !== false
      && selectors.includes('*') && !selectors.some((selector) => selector.startsWith('!'));
  }
  return !selectors.includes(`!${agentName}`)
    && (selectors.includes('*') || selectors.includes(agentName));
}

function validTurn(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function sessionFilename(sessionId) {
  return `${createHash('sha256').update(sessionId).digest('hex')}.json`;
}

function writeState(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch { /* renamed already, or storage unavailable */ }
  }
}

function rememberIdentity(sessionId, identity) {
  if (!sessionId) return diagnostic('AGENT_IDENTITY_NOT_SAVED');
  try {
    writeState(join(STATE_DIR, 'agent-identities', sessionFilename(sessionId)), identity);
  } catch {
    diagnostic('AGENT_IDENTITY_NOT_SAVED');
  }
}

function rememberedIdentity(sessionId) {
  if (!sessionId) return null;
  const path = join(STATE_DIR, 'agent-identities', sessionFilename(sessionId));
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if ((value?.kind === 'main' || value?.kind === 'subagent')
      && typeof value.agentName === 'string' && value.agentName.trim()) return value;
  } catch { /* diagnose without copying state contents */ }
  diagnostic('AGENT_IDENTITY_UNREADABLE');
  return null;
}

function resolveIdentity(payload, eventName, sessionId) {
  // 0.6.12 preserves agent_type on child start/tool events but strips it from
  // SessionStart(compact). Save lifecycle identities to restore the same rule
  // set. Tool hooks always have enough host metadata and need no state I/O.
  const payloadAgent = typeof payload.agent_type === 'string' ? payload.agent_type.trim().toLowerCase() : '';
  let identity;
  if (payloadAgent) {
    identity = { kind: 'subagent', agentName: payloadAgent };
    if (eventName === 'SubagentStart') rememberIdentity(sessionId, identity);
  } else if (eventName === 'PostToolUse' || (eventName === 'SessionStart' && payload.source === 'startup')) {
    // A normal main-agent event has no agent_type in the verified host contract.
    identity = { kind: 'main', agentName: (process.env.MINIMAX_AGENT_NAME || 'mavis').toLowerCase() };
    if (eventName === 'SessionStart') rememberIdentity(sessionId, identity);
  } else if (eventName !== 'SubagentStart') {
    identity = rememberedIdentity(sessionId);
  }
  if (!identity) diagnostic('AGENT_IDENTITY_UNKNOWN_GENERIC_RULES_ONLY');
  return identity;
}

function nextPromptCount(sessionId) {
  if (!sessionId) {
    diagnostic('PROMPT_CADENCE_SKIPPED_NO_SESSION');
    return null;
  }
  // The host serializes accepted user prompts within one session. Separate files
  // prevent concurrent sessions from overwriting each other's counters. Tool
  // hooks never read/write these files. Hash IDs instead of using them as paths.
  const countersDir = join(STATE_DIR, 'prompt-counts');
  const path = join(countersDir, sessionFilename(sessionId));
  let previous = 0;
  try {
    if (existsSync(path)) {
      const state = JSON.parse(readFileSync(path, 'utf8'));
      if (!validTurn(state?.turn)) throw new Error('invalid counter');
      previous = state.turn;
    } else {
      // Keep a previously installed engine's cadence on the first new prompt.
      const legacyPath = join(STATE_DIR, 'turns.json');
      if (existsSync(legacyPath)) {
        const legacy = JSON.parse(readFileSync(legacyPath, 'utf8'));
        const turn = Object.hasOwn(legacy ?? {}, sessionId) ? legacy[sessionId]?.turn : undefined;
        if (validTurn(turn)) previous = turn;
      }
    }
    if (previous >= Number.MAX_SAFE_INTEGER) throw new Error('counter overflow');
    const turn = previous + 1;
    writeState(path, { turn });
    return turn;
  } catch {
    // No invented/reset counter after corrupted state or a failed write. Input
    // reminders still fire; only the cadence that could not be established skips.
    diagnostic('PROMPT_CADENCE_STATE_UNAVAILABLE');
    return null;
  }
}

function startupText(rules, isSubagent) {
  const flag = isSubagent ? 'send_on_subagent' : 'send_on_start';
  const bodies = rules.filter((rule) => rule[flag] !== false)
    .map((rule) => rule.body.trim()).filter(Boolean);
  return bodies.length ? [
    '[standing-rules] Active standing requirements. Apply them within the actual instruction hierarchy.',
    ...bodies,
  ].join('\n\n') : '';
}

function reminderText(rules, eventName, turn) {
  return rules.filter((rule) => {
    const remind = rule.remind;
    if (!remind || typeof remind !== 'object') return false;
    if (eventName === 'PostToolUse') return remind.every_tool === true;
    if (remind.every_input === true) return true;
    const cadence = Number(remind.every_n_turns);
    return turn !== null && Number.isSafeInteger(cadence) && cadence > 0 && turn % cadence === 0;
  }).map((rule) => typeof rule.remind.suffix === 'string' ? rule.remind.suffix.trim() : '')
    .filter(Boolean).join('\n\n');
}

function main() {
  const payload = readPayload();
  if (!payload || !EVENTS.has(payload.hook_event_name)) return;
  const eventName = payload.hook_event_name;
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id.trim() : '';
  const identity = resolveIdentity(payload, eventName, sessionId);
  const isSubagent = identity?.kind === 'subagent';
  const rules = loadRules().filter((rule) => applies(rule, identity?.agentName, !identity)
    && (!isSubagent || rule.send_on_subagent !== false));
  if (!rules.length) return;

  let text;
  if (eventName === 'SessionStart' || eventName === 'SubagentStart') {
    text = startupText(rules, isSubagent);
  } else {
    const turn = eventName === 'UserPromptSubmit' ? nextPromptCount(sessionId) : null;
    text = reminderText(rules, eventName, turn);
  }
  if (text) process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: { hookEventName: eventName, additionalContext: text },
  })}\n`);
}

try { main(); } catch { diagnostic('ENGINE_ERROR'); }
