import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bunBinary } from './helpers/runtime-fixture.mjs';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const plugin = join(repo, 'plugins', 'injection-rules');
const configuration = JSON.parse(readFileSync(join(plugin, 'hooks', 'hooks.json'), 'utf8'));

function rule(name, extra = {}) {
  return {
    name, apply: ['*'], body: `BODY ${name}`,
    remind: { every_tool: true, every_input: true, suffix: `REMIND ${name}` },
    ...extra,
  };
}

function fixture(t, rules = []) {
  const root = mkdtempSync(join(tmpdir(), 'mcode-injection-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pluginRoot = join(root, 'plugin');
  const userDirectory = join(root, 'user');
  const userRules = join(userDirectory, '.minimax', 'rules');
  const data = join(root, 'state');
  cpSync(plugin, pluginRoot, { recursive: true });
  mkdirSync(join(pluginRoot, 'rules'), { recursive: true });
  mkdirSync(userRules, { recursive: true });
  // Bun resolves homedir from this isolated child environment.
  const env = {
    PATH: `${dirname(bunBinary)}:/usr/bin:/bin`,
    HOME: userDirectory,
    LANG: 'C.UTF-8',
    PLUGIN_ROOT: pluginRoot,
    PLUGIN_DATA: data,
  };
  const put = (value, directory = join(pluginRoot, 'rules'), file = `${value.name}.json`) => {
    writeFileSync(join(directory, file), JSON.stringify(value));
  };
  rules.forEach((value) => put(value));
  const command = (event) => {
    const handlers = configuration.hooks[event]?.flatMap((entry) => entry.hooks);
    assert.equal(handlers?.length, 1, `one registered command for ${event}`);
    return handlers[0].command.replaceAll('${PLUGIN_ROOT}', pluginRoot);
  };
  const decode = (event, output) => {
    assert.ifError(output.error);
    assert.equal(output.status, 0, output.stderr || output.error?.message);
    if (!output.stdout.trim()) return { ...output, text: '' };
    const envelope = JSON.parse(output.stdout);
    assert.deepEqual(Object.keys(envelope), ['hookSpecificOutput']);
    assert.equal(envelope.hookSpecificOutput.hookEventName, event);
    return { ...output, text: envelope.hookSpecificOutput.additionalContext };
  };
  const call = (event, payload = {}, options = {}) => decode(event, spawnSync(command(event), {
    shell: true, cwd: root, env: { ...env, ...options.env }, encoding: 'utf8',
    input: options.raw ?? JSON.stringify({ hook_event_name: event, session_id: 'session-a', ...payload }),
    timeout: 5000,
  }));
  const callAsync = (event, payload = {}) => new Promise((resolve, reject) => {
    const child = spawn(command(event), { shell: true, cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => {
      try { resolve(decode(event, { status, stdout, stderr })); } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify({ hook_event_name: event, session_id: 'session-a', ...payload }));
  });
  const counter = (session, kind = 'prompt') => join(data, `${kind}-counts`, `${createHash('sha256').update(session).digest('hex')}.json`);
  return { root, data, pluginRoot, userRules, put, call, callAsync, counter };
}

test('registered lifecycle commands include tool results and child starts, without a PostCompact envelope', () => {
  const manifest = JSON.parse(readFileSync(join(plugin, '.minimax-plugin', 'plugin.json'), 'utf8'));
  assert.deepEqual(manifest.hooks, ['hooks/hooks.json']);
  assert.deepEqual(Object.keys(configuration.hooks).sort(),
    ['PostToolUse', 'SessionStart', 'SubagentStart', 'UserPromptSubmit']);
  assert.equal(configuration.hooks.PostToolUse[0].matcher, '*');
});

test('startup, resume, plugin activation and compact re-deliver full standing bodies without counting prompts', (t) => {
  const f = fixture(t, [rule('active'), rule('disabled', { send_on_start: false })]);
  for (const source of ['startup', 'resume', 'plugin_activation', 'compact', 'compact']) {
    const out = f.call('SessionStart', { source });
    assert.match(out.text, /BODY active/);
    assert.doesNotMatch(out.text, /BODY disabled|REMIND/);
    assert.equal(out.stderr, '');
  }
  assert.equal(existsSync(join(f.data, 'prompt-counts')), false);
});

test('every tool result, including errors and repeated calls in a batch, receives a stateless reminder', (t) => {
  const f = fixture(t, [rule('tool'), rule('input-only', { remind: { every_input: true, suffix: 'INPUT ONLY' } })]);
  for (const [tool_name, is_error] of [['read', false], ['bash', true], ['mcp__x__y', false], ['read', false]]) {
    const out = f.call('PostToolUse', { turn_id: 'same-turn', tool_use_id: 'same-id', tool_name, is_error,
      tool_input: { value: 'private-input' }, tool_result: { content: [{ type: 'text', text: 'private-result' }] } });
    assert.equal(out.text, 'REMIND tool');
    assert.doesNotMatch(out.stdout + out.stderr, /private-input|private-result/);
  }
  assert.equal(existsSync(f.data), false, 'tool reminders do not persist cadence or success logs');
});

test('tool results and compaction do not advance or reset legacy user-prompt cadence', (t) => {
  const f = fixture(t, [rule('input'), rule('periodic', { remind: { every_n_turns: 2, suffix: 'PERIODIC' } })]);
  assert.equal(f.call('UserPromptSubmit').text, 'REMIND input');
  for (let i = 0; i < 4; i++) f.call('PostToolUse', { tool_name: 'read' });
  f.call('SessionStart', { source: 'compact' });
  assert.equal(f.call('UserPromptSubmit').text, 'REMIND input\n\nPERIODIC');
  assert.equal(JSON.parse(readFileSync(f.counter('session-a'))).turn, 2);
});

test('subagent opt-outs and exact role exclusions hold at child start, input, tool results and compact', (t) => {
  const f = fixture(t, [
    rule('common'), rule('parent', { send_on_subagent: false }),
    rule('excluded', { apply: ['*', '!critic'] }), rule('critic-only', { apply: ['CrItIc'] }),
    rule('worker-only', { apply: ['worker'] }), rule('child-only', { send_on_start: false, send_on_subagent: true }),
  ]);
  for (const event of ['SubagentStart', 'UserPromptSubmit', 'PostToolUse', 'SessionStart']) {
    const out = f.call(event, { session_id: 'child-session', agent_type: 'CRITIC', agent_id: 'child-1', source: 'compact' });
    assert.match(out.text, /common/);
    assert.match(out.text, /critic-only/);
    assert.doesNotMatch(out.text, /parent|excluded|worker-only/);
    if (event === 'SubagentStart' || event === 'SessionStart') assert.match(out.text, /BODY child-only/);
  }
  const main = f.call('PostToolUse');
  assert.match(main.text, /REMIND parent/);
  assert.match(main.text, /REMIND excluded/);
  assert.doesNotMatch(main.text, /critic-only|worker-only/);
  // The actual host strips agent_type/id from SessionStart after child compaction.
  for (const source of ['compact', 'resume']) {
    const restored = f.call('SessionStart', { session_id: 'child-session', source });
    assert.match(restored.text, /BODY critic-only/);
    assert.match(restored.text, /BODY child-only/);
    assert.doesNotMatch(restored.text, /parent|excluded|worker-only/);
  }
});

test('missing session identity skips only periodic reminders, never stateless standing/tool/input rules', (t) => {
  const f = fixture(t, [rule('always'), rule('periodic', { remind: { every_n_turns: 1, suffix: 'PERIODIC' } })]);
  assert.match(f.call('SessionStart', { session_id: null }).text, /BODY always/);
  assert.equal(f.call('PostToolUse', { session_id: null }).text, 'REMIND always');
  const out = f.call('UserPromptSubmit', { session_id: null });
  assert.equal(out.text, 'REMIND always');
  assert.match(out.stderr, /PROMPT_CADENCE_SKIPPED_NO_SESSION/);
  assert.equal(existsSync(join(f.data, 'prompt-counts')), false);
});

test('user rules override bundled rules by name, and a malformed neighbor does not hide valid rules', (t) => {
  const f = fixture(t, [rule('same'), rule('other')]);
  f.put(rule('same', { body: 'USER BODY', remind: { every_tool: true, suffix: 'USER REMINDER' } }), f.userRules, '99-override.json');
  writeFileSync(join(f.userRules, 'broken.json'), '{"private":"do-not-log"');
  assert.match(f.call('SessionStart').text, /USER BODY/);
  const out = f.call('PostToolUse');
  assert.match(out.text, /USER REMINDER/);
  assert.match(out.text, /REMIND other/);
  assert.doesNotMatch(out.text, /REMIND same/);
  assert.match(out.stderr, /RULE_UNREADABLE_OR_INVALID/);
  assert.doesNotMatch(out.stderr, /do-not-log/);
  // An intentionally disabled valid user override suppresses the bundled default.
  f.put(rule('same', { body: '', remind: {} }), f.userRules, '99-override.json');
  assert.equal(f.call('PostToolUse').text, 'REMIND other');
});

test('malformed/nonobject inputs fail open with bounded metadata-only diagnostics', (t) => {
  const f = fixture(t, [rule('active')]);
  for (const raw of ['', 'null', '[]', '"private-input"', '{"secret":"do-not-log"']) {
    const out = f.call('PostToolUse', {}, { raw });
    assert.equal(out.stdout, '');
    assert.match(out.stderr, /INVALID_PAYLOAD/);
    assert.doesNotMatch(out.stderr, /private-input|do-not-log/);
  }
});

test('invalid selectors do not crash valid rule loading and diagnostics are bounded', (t) => {
  const f = fixture(t, [rule('valid')]);
  for (let i = 0; i < 30; i++) f.put(rule(`invalid-${i}`, { apply: [null] }));
  const out = f.call('PostToolUse');
  assert.equal(out.text, 'REMIND valid');
  assert.equal(out.stderr.trim().split('\n').length, 10);
});

test('a corrupt counter never fabricates a fresh cadence or suppresses every-input reminders', (t) => {
  const f = fixture(t, [rule('input'), rule('periodic', { remind: { every_n_turns: 1, suffix: 'PERIODIC' } })]);
  mkdirSync(dirname(f.counter('session-a')), { recursive: true });
  writeFileSync(f.counter('session-a'), '{');
  const out = f.call('UserPromptSubmit');
  assert.equal(out.text, 'REMIND input');
  assert.match(out.stderr, /PROMPT_CADENCE_STATE_UNAVAILABLE/);
  assert.equal(readFileSync(f.counter('session-a'), 'utf8'), '{');
});

test('state-store failure leaves stateless input/tool reminders operational', (t) => {
  const f = fixture(t, [rule('active')]);
  writeFileSync(f.data, 'not a directory');
  assert.equal(f.call('PostToolUse').text, 'REMIND active');
  const out = f.call('UserPromptSubmit');
  assert.equal(out.text, 'REMIND active');
  assert.match(out.stderr, /PROMPT_CADENCE_STATE_UNAVAILABLE/);
});

test('a corrupt child-role record keeps only generic child-safe rules and reports the uncertainty', (t) => {
  const f = fixture(t, [rule('common'), rule('parent-only', { send_on_subagent: false }),
    rule('role-specific', { apply: ['critic'] }), rule('role-exclusion', { apply: ['*', '!critic'] })]);
  f.call('SubagentStart', { session_id: 'child', agent_type: 'critic' });
  const filename = `${createHash('sha256').update('child').digest('hex')}.json`;
  writeFileSync(join(f.data, 'agent-identities', filename), '{');
  const restored = f.call('SessionStart', { session_id: 'child', source: 'compact' });
  assert.match(restored.text, /BODY common/);
  assert.doesNotMatch(restored.text, /parent-only|role-specific|role-exclusion/);
  assert.match(restored.stderr, /AGENT_IDENTITY_UNREADABLE/);
  writeFileSync(f.data + '-blocked', 'not a directory');
  const failedSave = f.call('SubagentStart', { agent_type: 'critic' }, { env: { PLUGIN_DATA: f.data + '-blocked' } });
  assert.match(failedSave.text, /BODY common/);
  assert.match(failedSave.stderr, /AGENT_IDENTITY_NOT_SAVED/);
  // No saved identity after that failure: restore cannot assume this is a main agent.
  const missing = f.call('SessionStart', { session_id: 'unknown-child', source: 'compact' });
  assert.match(missing.text, /BODY common/);
  assert.doesNotMatch(missing.text, /parent-only|role-specific|role-exclusion/);
  assert.match(missing.stderr, /AGENT_IDENTITY_UNKNOWN_GENERIC_RULES_ONLY/);
});

test('existing cadence migrates once, and hostile-looking session IDs remain opaque identifiers', (t) => {
  const f = fixture(t, [rule('periodic', { remind: { every_n_turns: 2, suffix: 'PERIODIC' } })]);
  mkdirSync(f.data);
  writeFileSync(join(f.data, 'turns.json'), JSON.stringify({ 'session-a': { turn: 5, updated: 1 } }));
  assert.equal(f.call('UserPromptSubmit').text, 'PERIODIC');
  assert.equal(f.call('UserPromptSubmit').text, '');
  for (const session_id of ['../../outside', '__proto__', 'constructor']) {
    f.call('UserPromptSubmit', { session_id });
    assert.equal(f.call('UserPromptSubmit', { session_id }).text, 'PERIODIC');
    assert.equal(JSON.parse(readFileSync(f.counter(session_id))).turn, 2);
  }
  assert.ok(readdirSync(join(f.data, 'prompt-counts')).every((name) => /^[a-f0-9]{64}\.json$/.test(name)));
});

test('concurrent sessions keep independent prompt counters across process restarts', async (t) => {
  const f = fixture(t, [rule('periodic', { remind: { every_n_turns: 3, suffix: 'PERIODIC' } })]);
  const sessions = Array.from({ length: 8 }, (_, i) => `session-${i}`);
  for (let turn = 1; turn <= 3; turn++) {
    const outputs = await Promise.all(sessions.map((session_id) => f.callAsync('UserPromptSubmit', { session_id })));
    for (const out of outputs) assert.equal(out.text, turn === 3 ? 'PERIODIC' : '');
  }
  for (const session of sessions) assert.equal(JSON.parse(readFileSync(f.counter(session))).turn, 3);
});

test('shipped full rules reach lifecycle boundaries with the requested two-tool poison and five-tool prediction cadence', (t) => {
  const f = fixture(t);
  const rules = readdirSync(join(repo, 'rules')).filter((name) => name.endsWith('.json') && !name.startsWith('_'))
    .map((name) => JSON.parse(readFileSync(join(repo, 'rules', name), 'utf8')));
  rules.forEach((value) => f.put(value));
  for (const [event, payload] of [['SessionStart', { source: 'startup' }], ['SessionStart', { source: 'compact' }],
    ['SubagentStart', { agent_type: 'worker', agent_id: 'child' }]]) {
    const out = f.call(event, payload);
    for (const value of rules) assert.ok(out.text.includes(value.body.trim()), `missing full body: ${value.name}`);
    assert.ok(Buffer.byteLength(out.stdout) < 64 * 1024, 'inside 0.6.12 command stdout budget');
  }
  const poison = rules.find((value) => value.name === '70-reasoning-poison');
  const operating = rules.find((value) => value.name === '01-operating-principle');
  const outcome = rules.find((value) => value.name === '71-user-intent-outcome');
  const verification = rules.find((value) => value.name === '73-tests-not-proof');
  assert.equal(poison.remind.every_n_tools, 2, 'the requested poison cadence is two completed tools');
  assert.equal(poison.remind.send_full_rule, true);
  assert.equal(outcome.remind.every_n_tools, 5, 'the general prediction contract keeps the requested cadence five');
  assert.ok(poison.body.includes('ОБЯЗАТЕЛЬНО СЛЕДУЙ ДОСЛОВНО ЭТОМУ ПРАВИЛУ'));
  // This sequence is the required observable schedule, not a reimplementation
  // of the engine's reminder selection. Other rules may share a due event.
  const expected = ['', poison.body, operating.remind.suffix.trim(), poison.body,
    outcome.remind.suffix.trim(), `${operating.remind.suffix.trim()}\n\n${poison.body}`,
    verification.remind.suffix.trim()];
  for (let call = 1; call <= 7; call++) {
    const out = f.call('PostToolUse', { tool_name: 'bash', is_error: call % 2 === 0 });
    assert.equal(out.text, expected[call - 1]);
    if (call === 2) {
      assert.ok(f.call('UserPromptSubmit').text.includes(poison.body), 'input delivery does not change the tool counter');
      f.call('SessionStart', { source: 'compact' });
    }
  }
  assert.equal(f.call('PostToolUse', { session_id: 'child', agent_type: 'worker' }).text, '');
  assert.equal(f.call('PostToolUse', { session_id: 'child', agent_type: 'worker' }).text, poison.body);
  assert.equal(f.call('PostToolUse', { session_id: 'child', agent_type: 'worker' }).text, operating.remind.suffix.trim());
});

test('concurrent same-session tool completions preserve exact cadence without storing tool content', async (t) => {
  const full = rule('full', { body: '  FULL RULE WITH ALL WHITESPACE\n', remind: { every_n_tools: 3, send_full_rule: true, suffix: 'WRONG SUFFIX' } });
  const f = fixture(t, [full]);
  const outputs = await Promise.all(Array.from({ length: 12 }, (_, i) => f.callAsync('PostToolUse', {
    tool_name: 'read', tool_use_id: `call-${i}`, tool_input: { secret: 'DO NOT STORE' },
  })));
  outputs.forEach(out => assert.equal(out.stderr, ''));
  assert.equal(outputs.filter(out => out.text === full.body).length, 4);
  assert.equal(outputs.filter(out => out.text === '').length, 8);
  assert.equal(readFileSync(f.counter('session-a', 'tool'), 'utf8'), '{"turn":12}\n');
  assert.equal(existsSync(join(f.data, 'prompt-counts')), false);
});

test('missing or corrupt tool cadence does not fabricate delivery or hide stateless rules', (t) => {
  const f = fixture(t, [rule('stateless'), rule('periodic', { remind: { every_n_tools: 3, send_full_rule: true } })]);
  const missing = f.call('PostToolUse', { session_id: null });
  assert.equal(missing.text, 'REMIND stateless');
  assert.match(missing.stderr, /TOOL_CADENCE_SKIPPED_NO_SESSION/);
  mkdirSync(dirname(f.counter('session-a', 'tool')), { recursive: true });
  writeFileSync(f.counter('session-a', 'tool'), '{');
  const corrupt = f.call('PostToolUse');
  assert.equal(corrupt.text, 'REMIND stateless');
  assert.match(corrupt.stderr, /TOOL_CADENCE_STATE_UNAVAILABLE/);
  assert.equal(readFileSync(f.counter('session-a', 'tool'), 'utf8'), '{');
});
