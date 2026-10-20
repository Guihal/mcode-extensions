/**
 * Opt-in, offline probe of the actual published host, with no model/API call.
 * Set MCODE_HOST_PACKAGE to an unpacked @minimax-ai/code@0.6.12 package directory
 * with its npm dependencies installed. The ordinary test suite skips this probe.
 *
 * The checksum pins the unmodified published chunk. A temporary copy adds only
 * exports for otherwise-private functions; no implementation is substituted.
 * This is a version-specific compatibility probe, not a public host API.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = process.env.MCODE_HOST_PACKAGE;
const chunkName = 'chunk-47KWM23C.js';
const chunkSha256 = 'c9d0342a9efa65955831fdc28907cbd434aab354ec3fbaf1f253f7d3b9b36293';
// npm dist.integrity (also verified against the downloaded archive during development):
// sha512-aA4XPl9tYHTrtIS5DLB5DBSdxlcokZJ5BGUT/vSiDWei/tlVV5hIEVTgFhnSB6WM4evfNwOJtfi2fJVPNpJveg==

test('published mcode 0.6.12 hook and compaction contract', { skip: !packageRoot }, async (t) => {
  const previousPath = process.env.PATH;
  process.env.PATH = `${dirname(process.execPath)}:${previousPath ?? '/usr/bin:/bin'}`;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
  const sourceRoot = resolve(packageRoot);
  const metadata = JSON.parse(readFileSync(join(sourceRoot, 'package.json'), 'utf8'));
  assert.equal(metadata.name, '@minimax-ai/code');
  assert.equal(metadata.version, '0.6.12');
  const original = readFileSync(join(sourceRoot, 'chunks', chunkName));
  assert.equal(createHash('sha256').update(original).digest('hex'), chunkSha256,
    'host chunk differs from the pinned published package; review the new host before updating the probe');

  const root = mkdtempSync(join(tmpdir(), 'mcode-host-contract-'));
  const chunks = join(root, 'chunks');
  mkdirSync(chunks);
  for (const file of readdirSync(join(sourceRoot, 'chunks'))) {
    symlinkSync(join(sourceRoot, 'chunks', file), join(chunks, file), 'file');
  }
  // Both `npm install --prefix <temp> @minimax-ai/code@0.6.12` and an unpacked
  // package with local dependencies work; npm may hoist the native dependency.
  const requireFromHost = createRequire(join(sourceRoot, 'package.json'));
  const modules = requireFromHost.resolve.paths('better-sqlite3')
    .find((path) => existsSync(join(path, 'better-sqlite3')));
  assert.ok(modules, 'install the published host dependencies (npm install --ignore-scripts is sufficient)');
  symlinkSync(modules, join(root, 'node_modules'), 'junction');
  const probeModule = join(chunks, 'exposed-host.mjs');
  writeFileSync(probeModule, original.toString('utf8') + '\nexport {' + [
    'dCn as parseHooks', 'pxn as parseOutput', 'wr as hooks', 'gL as HookLifecycle',
    'qKn as manualPostCompact', '$nr as autoPostCompact', 'srr as afterTool', 'sun as executeTools',
    'zKn as manualPreCompact', 'yj as AgentHost', 'Ydn as beforeProvider',
  ].join(',') + '};\n');
  const host = await import(pathToFileURL(probeModule).href);
  host.hooks.automaticIdleSessionEnd = false;
  t.after(async () => {
    await host.hooks.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  const repo = dirname(dirname(fileURLToPath(import.meta.url)));
  const pluginRoot = join(root, 'plugins', 'injection-rules');
  cpSync(join(repo, 'plugins', 'injection-rules'), pluginRoot, { recursive: true });
  cpSync(join(repo, 'rules'), join(pluginRoot, 'rules'), { recursive: true });
  const rules = readdirSync(join(repo, 'rules')).filter((file) => file.endsWith('.json') && !file.startsWith('_'))
    .map((file) => JSON.parse(readFileSync(join(repo, 'rules', file), 'utf8')));
  const poison = rules.find((rule) => rule.name === '70-reasoning-poison');
  writeFileSync(join(pluginRoot, 'rules', 'child-only.json'), JSON.stringify({
    name: 'child-only', apply: ['worker'], send_on_start: false, send_on_subagent: true,
    body: 'CHILD_ONLY_BODY', remind: {},
  }));
  const tracePath = join(pluginRoot, 'probe-events.jsonl');
  // Test-only preloading isolates the subprocess's user-rule lookup and records
  // event metadata. Original stdin bytes and engine stdout pass through unchanged.
  writeFileSync(join(pluginRoot, 'probe-preload.cjs'), `
const fs = require('node:fs');
const path = require('node:path');
const originalRead = fs.readFileSync;
require('node:os').homedir = () => path.join(process.env.PLUGIN_ROOT, 'test-user');
fs.readFileSync = function(file, ...args) {
  const result = originalRead.call(this, file, ...args);
  if (file === 0) {
    const p = JSON.parse(String(result));
    const fields = ['hook_event_name', 'session_id', 'source', 'agent_type', 'agent_id', 'tool_name', 'is_error'];
    fs.appendFileSync(path.join(process.env.PLUGIN_ROOT, 'probe-events.jsonl'),
      JSON.stringify({ ...Object.fromEntries(fields.filter(k => p[k] !== undefined).map(k => [k,p[k]])),
        data_dir: process.env.PLUGIN_DATA }) + '\\n');
  }
  return result;
};
require('node:module').syncBuiltinESMExports();
`);
  const configuration = JSON.parse(readFileSync(join(pluginRoot, 'hooks', 'hooks.json'), 'utf8'));
  // Keep the registered engine command; add only the test subprocess preload.
  for (const entries of Object.values(configuration.hooks)) {
    for (const entry of entries) for (const hook of entry.hooks) {
      assert.ok(hook.command.startsWith('node '));
      hook.command = hook.command.replace(/^node /, 'node --require "${PLUGIN_ROOT}/probe-preload.cjs" ');
    }
  }
  const parsed = host.parseHooks({
    pluginName: 'injection-rules', pluginRoot, sourceFormat: 'MINIMAX',
    documents: [{ sourcePath: join(pluginRoot, 'hooks', 'hooks.json'), value: configuration }],
  });
  assert.deepEqual(parsed.diagnostics, []);
  const handlers = parsed.handlers;
  const runtimeContext = { model: 'test/offline', permissionMode: 'default' };
  const turn = (sessionId, turnId, extra = {}) => ({
    sessionId, turnId, cwd: root, prompt: 'Synthetic hook contract test', handlers, ...runtimeContext, ...extra,
  });
  const input = (sessionId, turnId) => ({
    lease: { sessionId, turnId, signal: new AbortController().signal },
    session: { workspaceDir: root }, pluginHooks: handlers,
    pluginHookRuntimeContext: runtimeContext, assembly: { tools: [] },
  });
  const trace = () => readFileSync(tracePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const assertBodies = (text) => {
    assert.equal(typeof text, 'string');
    for (const rule of rules) assert.ok(text.includes(rule.body.trim()), `missing body: ${rule.name}`);
  };

  await t.test('startup and resume reach the real host parser and lifecycle', async () => {
    const startup = await host.hooks.beginTurn(turn('main', 'turn-1'));
    assert.deepEqual(startup.diagnostics, []);
    assertBodies(startup.decision.additionalContext);
    assert.ok(!startup.decision.additionalContext.includes('CHILD_ONLY_BODY'));
    const previousProcess = new host.HookLifecycle(undefined, { automaticIdleSessionEnd: false });
    await previousProcess.beginTurn(turn('resumed', 'before-restart'));
    await previousProcess.dispose();
    const resume = await host.hooks.beginTurn(turn('resumed', 'turn-r', { resumeExistingSession: true }));
    assert.deepEqual(resume.diagnostics, []);
    assertBodies(resume.decision.additionalContext);
    const legacyResume = await host.hooks.beginTurn(turn('no-saved-identity', 'legacy-r', { resumeExistingSession: true }));
    const safeRules = rules.filter((rule) => rule.apply.includes('*') && !rule.apply.some((selector) => selector.startsWith('!')));
    for (const rule of safeRules) assert.ok(legacyResume.decision.additionalContext.includes(rule.body.trim()));
    for (const rule of rules.filter((rule) => !safeRules.includes(rule))) {
      assert.ok(!legacyResume.decision.additionalContext.includes(rule.body.trim()), 'unknown identity cannot establish a role exclusion');
    }
    assert.ok(trace().some((event) => event.source === 'startup'));
    assert.ok(trace().some((event) => event.source === 'resume'));
    assert.ok(trace().every((event) => event.data_dir.startsWith(root + sep)),
      'actual runner places PLUGIN_DATA inside the disposable fixture, not a real user store');
  });

  await t.test('successful, failing and batched tool executions retain results and receive reminders', async () => {
    for (const isError of [false, true]) {
      const content = [{ type: 'text', text: isError ? 'original failure' : 'original success' },
        { type: 'image', mimeType: 'image/png', data: readFileSync(join(pluginRoot, 'icon.png')).toString('base64') }];
      const result = { content, details: { ok: !isError } };
      const output = await host.afterTool({ input: input('main', 'turn-1'), context: {
        toolCall: { id: `call-${isError}`, name: 'bash' }, args: {}, result, isError,
      } });
      assert.deepEqual(output.content.slice(0, content.length), content);
      assert.ok(output.content.at(-1).text.includes(poison.remind.suffix.trim()));
      assert.equal(output.isError, undefined, 'the reminder must not rewrite the tool error flag');
      assert.deepEqual(result, { content, details: { ok: !isError } }, 'original result remains intact');
    }
    const batch = await Promise.all(Array.from({ length: 3 }, (_, i) => host.afterTool({
      input: input('main', 'turn-1'), context: {
        toolCall: { id: `batch-${i}`, name: `mcp__probe__${i}` }, args: {},
        result: { content: [{ type: 'text', text: `result-${i}` }] }, isError: false,
      },
    })));
    batch.forEach((result) => assert.ok(result.content.at(-1).text.includes(poison.remind.suffix.trim())));
    const events = trace().filter((event) => event.hook_event_name === 'PostToolUse');
    assert.equal(events.length, 5);
    // MINIMAX-format dispatch includes execution errors, but its stdin projection
    // omits is_error. The delivery assertions above cover both original outcomes.
  });

  await t.test('manual and automatic post-commit paths restore full bodies through SessionStart(compact)', async () => {
    await host.manualPostCompact({ input: input('main', 'manual'), capabilities: { hooks: handlers },
      cwd: root, runtimeContext, compactSummary: 'Synthetic compaction result' });
    const next = await host.hooks.beginTurn(turn('main', 'after-manual'));
    assert.deepEqual(next.diagnostics, []);
    assertBodies(next.decision.additionalContext);
    const auto = await host.autoPostCompact(input('main', 'after-auto'), 'Synthetic compaction result');
    assert.equal(auto.customType, 'plugin_hook_context');
    assertBodies(auto.content);
    assert.equal(trace().filter((event) => event.source === 'compact').length, 2);
    assert.equal(host.parseOutput({ hookSpecificOutput: {
      hookEventName: 'PostCompact', additionalContext: 'invalid for this event',
    } }, { sourceFormat: 'MINIMAX' }, { event: 'PostCompact' }), undefined);
  });

  await t.test('host limitation: PreCompact deferral cannot deliver a model save request before compaction', async () => {
    const marker = 'SAVE_REQUIRED_BEFORE_COMPACT_CONTRACT_PROBE';
    const format = { sourceFormat: 'MINIMAX' }, event = { event: 'PreCompact' };
    assert.equal(host.parseOutput({ hookSpecificOutput: { hookEventName: 'PreCompact', additionalContext: marker } }, format, event), undefined);
    assert.deepEqual(host.parseOutput({ decision: 'block', reason: marker }, format, event), { decision: 'allow', defer: true, reason: marker });
    const command = join(root, 'precompact-contract-hook.mjs');
    const eventsPath = join(root, 'precompact-contract-events.jsonl');
    writeFileSync(command, `import fs from 'node:fs';
const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(payload) + '\\n');
process.stdout.write(JSON.stringify({decision: 'block', reason: ${JSON.stringify(marker)}, systemMessage: ${JSON.stringify(marker)}}) + '\\n');
`);
    const precompact = host.parseHooks({ pluginName: 'agent-state-contract-probe', pluginRoot: root, sourceFormat: 'MINIMAX',
      documents: [{ sourcePath: join(root, 'precompact-hooks.json'), value: { hooks: {
        PreCompact: [{ hooks: [{ type: 'command', command: `node "${command}"`, timeout: 5 }] }],
      } } }] });
    assert.deepEqual(precompact.diagnostics, []);
    const signal = new AbortController().signal;
    const manual = await host.manualPreCompact({ lease: { sessionId: 'precompact-manual', turnId: 'manual-turn', signal } },
      { hooks: precompact.handlers }, root, runtimeContext);
    assert.equal(manual, marker, 'The manual boundary returns a reason rather than scheduling a model/tool turn');
    let compactStarted = 0;
    for (const sessionId of ['precompact-a', 'precompact-b']) {
      // Only the compaction service is a controlled offline boundary. The
      // original host admission and provider-context preparation are exercised.
      const self = { dependencies: { compaction: {
        automatic: { async compactBeforeLlm(_input, callbacks) {
          await callbacks.onStarted(); compactStarted++;
          return { status: 'unchanged', reason: 'nothing-to-compact' };
        } }, lifecycle: { async failCommittedHistory() {} },
      } }, compactionAttempts: { create: () => `attempt-${sessionId}-${compactStarted}` } };
      const compactionHook = host.AgentHost.prototype.createContextCompactionHook.call(self,
        { lease: { sessionId, turnId: 'provider-turn', leaseId: 'offline-lease', signal }, session: { workspaceDir: root } },
        { context: { sessionId, turnId: 'provider-turn', turnSequence: 1 }, preflight: { preparation: { llm: {} } },
          pluginHooks: precompact.handlers, pluginHookRuntimeContext: runtimeContext });
      const messages = [{ role: 'user', content: [{ type: 'text', text: 'Continue original work' }] }];
      const provider = { input: { sessionId, turnId: 'provider-turn', systemPrompt: 'Original system' }, hooks: { beforeLLM: [compactionHook] },
        llm: { model: { id: 'offline', api: 'anthropic-messages' } }, tools: [], thinkingLevel: 'off',
        logger: { warn() {}, info() {}, error() {} }, nextEventId: () => 0, nextRuntimeSeq: () => 0 };
      const before = compactStarted;
      const first = await host.beforeProvider(provider, messages, 'iteration', signal);
      assert.equal(first.type, 'unchanged');
      assert.deepEqual(first.messages, messages);
      assert.equal(JSON.stringify(first).includes(marker), false, 'Neither reason nor systemMessage reaches the model');
      assert.equal(compactStarted, before, 'The first automatic attempt is deferred once');
      const second = await host.beforeProvider(provider, messages, 'iteration', signal);
      assert.equal(second.type, 'unchanged');
      assert.deepEqual(second.messages, messages);
      assert.equal(compactStarted, before + 1, 'The next attempt compacts before the model despite the repeated block');
    }
    const events = readFileSync(eventsPath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(events.map((item) => item.trigger), ['manual', 'auto', 'auto', 'auto', 'auto']);
    t.diagnostic('PreCompact accepts one deferral but does not deliver a save request or an extra tool turn; an early policy reminder is not a guaranteed pre-compaction save.');
  });

  await t.test('child start and automatic compact preserve child identity and child-only bodies', async () => {
    const started = await host.hooks.startSubagent({ handlers, parentSessionId: 'main', parentTurnId: 'parent-turn',
      childSessionId: 'child', childTurnId: 'child-turn', agentId: 'child-id', agentType: 'worker',
      cwd: root, ...runtimeContext });
    assertBodies(started.additionalContext);
    assert.ok(started.additionalContext.includes('CHILD_ONLY_BODY'));
    const compacted = await host.autoPostCompact(input('child', 'child-turn'), 'Synthetic child compact');
    assertBodies(compacted.content);
    assert.ok(compacted.content.includes('CHILD_ONLY_BODY'));
    const restored = trace().find((event) => event.source === 'compact' && event.session_id === 'child');
    assert.equal(restored.agent_type, undefined, 'the host omits role identity after compact');
    assert.equal(restored.agent_id, undefined);
    const childTool = await host.afterTool({ input: input('child', 'child-turn'), context: {
      toolCall: { id: 'child-tool', name: 'read' }, args: {},
      result: { content: [{ type: 'text', text: 'child result' }] }, isError: false,
    } });
    assert.ok(childTool.content.at(-1).text.includes(poison.remind.suffix.trim()));
    const delivered = trace().find((event) => event.hook_event_name === 'PostToolUse' && event.session_id === 'child');
    assert.equal(delivered.agent_type, 'worker');
    assert.equal(delivered.agent_id, 'child-id');
  });

  await t.test('actual tool invocation exceptions pass through PostToolUse and retain their error flag', async () => {
    const kind = Symbol.for('TypeBox.Kind');
    const tools = [{ name: 'probe', parameters: { [kind]: 'Object', type: 'object',
      properties: { fail: { [kind]: 'Boolean', type: 'boolean' } }, required: ['fail'] },
    async execute(_id, args) {
      if (args.fail) throw new Error('Synthetic invocation failure');
      return { content: [{ type: 'text', text: 'Synthetic invocation success' }] };
    } }];
    const result = await host.executeTools({ tools }, { role: 'assistant', content: [
      { type: 'toolCall', id: 'exec-good', name: 'probe', arguments: { fail: false } },
      { type: 'toolCall', id: 'exec-bad', name: 'probe', arguments: { fail: true } },
    ] }, { toolExecution: 'sequential', afterToolCall: (context) => host.afterTool({
      input: input('main', 'exec'), context,
    }) }, undefined, async () => {});
    assert.equal(result.messages[0].isError, false);
    assert.equal(result.messages[1].isError, true);
    assert.match(result.messages[1].content[0].text, /Synthetic invocation failure/);
    for (const message of result.messages) assert.ok(message.content.at(-1).text.includes(poison.remind.suffix.trim()));
  });

  await t.test('host limitation: unknown tools and argument validation failures bypass both tool hooks', async () => {
    let before = 0, after = 0;
    const hooks = { beforeToolCall: async () => { before++; }, afterToolCall: async () => { after++; } };
    const unknown = await host.executeTools({ tools: [] }, {
      role: 'assistant', content: [{ type: 'toolCall', id: 'bad-name', name: 'absent', arguments: {} }],
    }, { ...hooks, toolExecution: 'sequential' }, undefined, async () => {});
    assert.equal(unknown.messages[0].isError, true);
    assert.match(unknown.messages[0].content[0].text, /not found/);
    assert.equal(before, 0);
    assert.equal(after, 0);
    const invalid = await host.executeTools({ tools: [{ name: 'test', prepareArguments() {
      throw new Error('Synthetic argument preparation failure');
    } }] }, { role: 'assistant', content: [{ type: 'toolCall', id: 'bad-args', name: 'test', arguments: {} }] },
    { ...hooks, toolExecution: 'sequential' }, undefined, async () => {});
    assert.match(invalid.messages[0].content[0].text, /argument preparation failure/);
    assert.equal(before, 0);
    assert.equal(after, 0);
  });
});
