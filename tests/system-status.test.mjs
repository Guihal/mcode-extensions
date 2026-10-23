import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import {
  classify, formatStatus, parseLoadavg, parseMeminfo,
} from '../plugins/system-status/scripts/status-core.mjs';
import { bunBinary, makeFixture, repositoryRoot, runHook } from './helpers/runtime-fixture.mjs';

const hookScript = join(repositoryRoot, 'plugins', 'system-status', 'scripts', 'status-hook.mjs');

const meminfo = [
  'MemTotal:       16314624 kB',
  'MemFree:         1234567 kB',
  'MemAvailable:    3261434 kB',
  'SwapTotal:       52009348 kB',
  'SwapFree:        41000000 kB',
].join('\n');

const snapshot = {
  mem: { totalKb: 16314624, availableKb: 8388608 },
  swap: { totalKb: 52009348, freeKb: 41000000 },
  load: { one: 3.4, five: 3.1, fifteen: 3.0, cores: 12 },
  docker: { running: 12, total: 26 },
};

test('meminfo and loadavg parsing keep the readable figures', () => {
  const parsed = parseMeminfo(meminfo);
  assert.equal(parsed.totalKb, 16314624);
  assert.equal(parsed.availableKb, 3261434);
  assert.equal(parsed.swapTotalKb, 52009348);
  assert.equal(parsed.swapFreeKb, 41000000);
  assert.equal(parseMeminfo('not a meminfo file'), null);
  assert.equal(parseLoadavg('3.40 3.10 3.00 2/456 12345').one, 3.4);
  assert.equal(parseLoadavg('nonsense'), null);
});

test('pressure is reported only from real numbers, and missing sources never escalate', () => {
  assert.equal(classify(snapshot).level, 'ok');
  const lowRam = classify({ ...snapshot, mem: { totalKb: 16314624, availableKb: 1631462 } });
  assert.equal(lowRam.level, 'pressure');
  assert.match(lowRam.reasons.join(' '), /RAM/);
  const spentSwap = classify({ ...snapshot, swap: { totalKb: 52009348, freeKb: 10000000 } });
  assert.equal(spentSwap.level, 'pressure');
  assert.match(spentSwap.reasons.join(' '), /swap/);
  const busyCpu = classify({ ...snapshot, load: { ...snapshot.load, one: 13.5 } });
  assert.equal(busyCpu.level, 'pressure');
  assert.match(busyCpu.reasons.join(' '), /cpu/);
  const warmCpu = classify({ ...snapshot, load: { ...snapshot.load, one: 9.5 } });
  assert.equal(warmCpu.level, 'elevated');
  assert.equal(classify({ mem: null, swap: null, load: null, docker: null }).level, 'ok');
});

test('the rendered status names every requested source and stays compact', () => {
  const text = formatStatus(snapshot, classify(snapshot));
  assert.match(text, /\[system-status\]/);
  assert.match(text, /RAM свободно 8\.0 ГиБ\/15\.6 ГиБ/);
  assert.match(text, /swap свободно 39\.1 ГиБ\/49\.6 ГиБ/);
  assert.match(text, /load 3\.40 \(12 cpu\)/);
  assert.match(text, /docker: 12 активных \/ 26 всего/);
  assert.ok(text.length <= 600, `status text stays compact: ${text.length}`);
  assert.doesNotMatch(text, /уборка/);
  assert.match(formatStatus(snapshot, classify(snapshot), { includeCleanup: true }), /уборка: после тестов удали тестовые контейнеры/);
});

test('a pressure snapshot asks the agent to postpone heavy work', () => {
  const busy = { ...snapshot, mem: { totalKb: 16314624, availableKb: 1631462 } };
  const text = formatStatus(busy, classify(busy));
  assert.match(text, /ДАВЛЕНИЕ/);
  assert.match(text, /отложи/);
});

test('the hook answers the host contract and degrades without docker', async t => {
  const fixture = makeFixture(t, 'system-status');
  const options = { env: fixture.env, cwd: fixture.workspaceDir };
  const sessionId = 'status-session';

  const started = await runHook(hookScript, {
    hook_event_name: 'SessionStart', source: 'startup', session_id: sessionId, cwd: fixture.workspaceDir,
  }, options);
  assert.equal(started.code, 0, started.stderr);
  assert.equal(started.envelope.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(started.context, /\[system-status\]/);
  assert.match(started.context, /RAM/);
  assert.match(started.context, /load \d/);
  assert.match(started.context, /docker: /);

  // The teardown reminder reaches the agent on tool results, on a bounded cadence.
  const withoutDocker = { ...options, env: { ...fixture.env, PATH: dirname(bunBinary) } };
  const degraded = await runHook(hookScript, {
    hook_event_name: 'UserPromptSubmit', session_id: sessionId, cwd: fixture.workspaceDir,
  }, withoutDocker);
  assert.equal(degraded.code, 0, degraded.stderr);
  assert.match(degraded.context, /docker: н\/д/);
  assert.match(degraded.context, /RAM/);
});
