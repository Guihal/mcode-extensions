#!/usr/bin/env bun
/**
 * system-status hook entrypoint.
 *
 * Contract with the host: read the JSON payload from stdin, print exactly one
 * JSON envelope on stdout. The hook must never fail loudly — a broken source
 * degrades to "н/д" and a missing source never counts as resource pressure.
 */

import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { classify, formatStatus, parseLoadavg, parseMeminfo } from './status-core.mjs';

const EVENTS = new Set(['SessionStart', 'SubagentStart', 'UserPromptSubmit', 'PostToolUse']);
const MEMINFO_PATH = '/proc/meminfo';
const LOADAVG_PATH = '/proc/loadavg';
const DOCKER_TIMEOUT_MS = 2000;
/** Deliver the snapshot on every Nth tool result: enough to see a rising load
 *  during a long run without spending context on every single call. */
const TOOL_EVERY_N = 5;

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Container counts from the local docker CLI; null when docker is unusable. */
function collectDocker() {
  let result;
  try {
    result = spawnSync('docker', ['ps', '-a', '--format', '{{.State}}'], {
      timeout: DOCKER_TIMEOUT_MS,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
  if (!result || result.error || result.status !== 0 || typeof result.stdout !== 'string') return null;
  const states = result.stdout.split('\n').map(state => state.trim()).filter(Boolean);
  return { running: states.filter(state => state === 'running').length, total: states.length };
}

function collectSnapshot() {
  const meminfo = parseMeminfo(readText(MEMINFO_PATH) ?? '');
  const loadavg = parseLoadavg(readText(LOADAVG_PATH) ?? '');
  return {
    mem: meminfo ? { totalKb: meminfo.totalKb, availableKb: meminfo.availableKb } : null,
    swap: meminfo ? { totalKb: meminfo.swapTotalKb, freeKb: meminfo.swapFreeKb } : null,
    load: loadavg ? { ...loadavg, cores: cpus().length || 1 } : null,
    docker: collectDocker(),
  };
}

function counterPath(sessionId) {
  const base = process.env.PLUGIN_DATA || join(homedir(), '.minimax', 'system-status-state');
  const key = createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 32);
  return join(base, 'tool-counts', `${key}.json`);
}

/** Per-session tool counter. It is a delivery optimisation, not a contract:
 *  a counter that cannot be persisted still delivers the snapshot. */
function bumpCounter(sessionId) {
  const path = counterPath(sessionId);
  let count = 0;
  try {
    const stored = JSON.parse(readFileSync(path, 'utf8'));
    if (Number.isFinite(stored?.count)) count = stored.count;
  } catch {
    count = 0;
  }
  count += 1;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ count })}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } catch {
    // counter state is optional; delivery continues with the default cadence
  }
  return count;
}

function main() {
  let payload = {};
  try {
    const raw = readFileSync(0, 'utf8');
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = {};
  }
  const eventName = typeof payload?.hook_event_name === 'string' ? payload.hook_event_name : '';
  if (!EVENTS.has(eventName)) return;

  const includeCleanup = eventName === 'PostToolUse';
  if (includeCleanup && bumpCounter(payload?.session_id ?? 'default') % TOOL_EVERY_N !== 0) return;

  const snapshot = collectSnapshot();
  const text = formatStatus(snapshot, classify(snapshot), { includeCleanup });
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: { hookEventName: eventName, additionalContext: text },
  })}\n`);
}

try {
  main();
} catch {
  // A failed status read must never block the host tool call.
}
