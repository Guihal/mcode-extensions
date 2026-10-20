/**
 * Opt-in, offline integration of the shipped packages with @minimax-ai/code
 * 0.6.12. This separate Node host harness uses Bun for the real plugin children.
 * MCODE_HOST_PACKAGE names an unpacked package with dependencies installed;
 * MCODE_BUN_BINARY selects the plugin executable. No provider, live user session,
 * native better-sqlite3 writer, or network service participates in these checks.
 *
 * Both published chunks are checked before temporary copies append exports for
 * original private functions. Az performs the actual production hook snapshot
 * materialization; qN discovers the real stdio MCP schemas. No replacement host
 * implementation or synthetic TypeBox schema stands in for the plugin tools.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const packageRoot = process.env.MCODE_HOST_PACKAGE;
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const pluginNames = ['agent-state', 'control-task', 'injection-rules', 'probe-hook'];
const pinned = {
  'chunk-47KWM23C.js': {
    sha: 'c9d0342a9efa65955831fdc28907cbd434aab354ec3fbaf1f253f7d3b9b36293',
    exports: 'wr as hooks, gL as HookLifecycle, err as beforeTool, srr as afterTool, sun as executeTools, Zpn as adaptTool, qKn as manualPostCompact, $nr as autoPostCompact, cJn as prepareSteering, dJn as stopAfterTurn, QGe as runModelLoop, pa as parseRole, jve as assembleCapabilities, pxn as parseOutput, nw as encodeSession, Wr as decodeSession, mN as mutateSession, sSt as createRecord',
  },
  'chunk-5ADYFF2U.js': {
    sha: '27ea8db9479c8d20175b22e2d98ed75c4b991db1239d75ed28376c9dcc59d52c',
    exports: 'YP as loadPlugin, Az as PackageStore, qN as PluginMcpRuntime, C0t as sessionDDL, nOt as addHistoryMigration',
  },
};
const textOf = (message) => (message?.content ?? []).filter((item) => item.type === 'text').map((item) => item.text).join('\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const noContinuation = (result) => {
  assert.equal(result.decision.continuePrompt, undefined, 'plain Stop additionalContext is also a native continuation');
  assert.notEqual(result.decision.decision, 'block');
};
function deliveredPolicy(text) {
  // Supplied fixture clauses and captured raw text cannot establish that the
  // plugin itself delivers the content obligation to the model.
  return text.replace(/\[BEGIN VERBATIM CANONICAL TASK\][\s\S]*?\[END VERBATIM CANONICAL TASK\]/gu, '')
    .split('\n').filter((line) => !line.startsWith('Raw prompt text (JSON string):')).join('\n');
}
function assertRequirementsPolicy(text, label, { review = false } = {}) {
  const policy = deliveredPolicy(text);
  for (const meaning of [
    /applicable explicit requirements/iu, /grounded implicit \(implied\) requirements/iu,
    /basis and source/iu, /constraints, result and acceptance conditions/iu,
    /source-of-truth references/iu, /inferred requirements identified as inferences/iu,
    /unresolved assumptions visibly tentative\/open/iu,
  ]) assert.match(policy, meaning, label);
  if (review) for (const meaning of [
    /whole current task and the relevant original input/iu,
    /earlier requirements and qualifications that still apply/iu,
    /set\/patch/iu, /Unchanged steering needs no task call or confirmation/iu,
  ]) assert.match(policy, meaning, label);
}

function assertInputObligation(text, label) {
  const policy = deliveredPolicy(text);
  for (const meaning of [
    /After this user message, you MUST use control_task_set\/control_task_patch to add, change or remove durable requirements/,
    /preserving all earlier requirements and qualifications that still apply/,
    /Include grounded implied requirements with their basis/,
    /If no durable requirement changes, no invented edit, confirmation or read is required/,
  ]) assert.match(policy, meaning, label);
}

function assertPrecompactPolicy(text) {
  assert.match(text, /Before compaction, you must save new useful reusable knowledge with agent_state_note/);
  assert.match(text, /If there is no new reusable knowledge, do not invent or duplicate a guide/);
  assert.match(text, /Continue the next authorized task action or answer even when a save is rejected, unavailable, pending or uncertain/);
}

async function fixture(t) {
  assert.equal(process.versions.bun, undefined, 'The published host harness runs under Node; its plugins run under Bun.');
  const bunBinary = realpathSync(process.env.MCODE_BUN_BINARY || execFileSync('bun', ['-p', 'process.execPath'], { encoding: 'utf8' }).trim());
  assert.equal(execFileSync(bunBinary, ['-p', 'process.versions.bun'], { encoding: 'utf8' }).trim(),
    readFileSync(join(repo, '.bun-version'), 'utf8').trim(), 'Use the declared Bun runtime for the plugin lane.');
  const sourceRoot = resolve(packageRoot);
  const metadata = readJson(join(sourceRoot, 'package.json'));
  assert.equal(metadata.name, '@minimax-ai/code');
  assert.equal(metadata.version, '0.6.12');
  const source = {};
  for (const [name, contract] of Object.entries(pinned)) {
    source[name] = readFileSync(join(sourceRoot, 'chunks', name));
    assert.equal(createHash('sha256').update(source[name]).digest('hex'), contract.sha,
      'Review a changed host contract before updating its pin; never patch the installed host.');
  }
  const root = mkdtempSync(join(os.tmpdir(), 'mcode-ports-host-'));
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  const workspaceDir = join(root, 'workspace');
  const childWorkspace = join(root, 'child-workspace');
  const chunks = join(root, 'chunks');
  for (const path of [dataDir, home, workspaceDir, childWorkspace, chunks]) mkdirSync(path, { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
  for (const name of readdirSync(join(sourceRoot, 'chunks'))) {
    if (pinned[name]) writeFileSync(join(chunks, name), source[name].toString('utf8') + `\nexport {${pinned[name].exports}};\n`);
    else symlinkSync(join(sourceRoot, 'chunks', name), join(chunks, name), 'file');
  }
  const requireFromHost = createRequire(join(sourceRoot, 'package.json'));
  const modules = requireFromHost.resolve.paths('better-sqlite3').find((path) => existsSync(join(path, 'better-sqlite3')));
  assert.ok(modules, 'Install the pinned package dependencies; --ignore-scripts is sufficient for this offline fixture.');
  symlinkSync(modules, join(root, 'node_modules'), 'junction');

  // Environment isolation only; all product scripts and registered commands
  // remain unchanged. In particular, no test-only hook variable grants identity.
  const previousEnv = { ...process.env }, previousCwd = process.cwd(), previousHome = os.homedir;
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, { PATH: `${dirname(bunBinary)}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home,
    LANG: 'C.UTF-8', MINIMAX_DATA_DIR: dataDir });
  os.homedir = () => home;
  syncBuiltinESMExports();
  process.chdir(root);
  const host = await import(pathToFileURL(join(chunks, 'chunk-47KWM23C.js')).href);
  const loader = await import(pathToFileURL(join(chunks, 'chunk-5ADYFF2U.js')).href);
  host.hooks.automaticIdleSessionEnd = false;
  const logs = [];
  host.hooks.configureObservability({ logger: { warn: (data, message) => logs.push({ kind: 'hook', data, message }) } });
  const runtimes = [], wires = new Map();
  function observeWire(runtime) {
    for (const connection of runtime.pool.connections.values()) {
      const child = connection.transport._process, pid = connection.transport.pid;
      assert.ok(Number.isSafeInteger(pid) && pid > 0);
      assert.equal(realpathSync(`/proc/${pid}/exe`), bunBinary, 'native MCP discovery launches the actual declared Bun executable');
      assert.equal(readlinkSync(`/proc/${pid}/cwd`), home, 'MCP starts at home, not the hook workspace');
      const env = Object.fromEntries(readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')
        .filter(Boolean).map((item) => { const at = item.indexOf('='); return [item.slice(0, at), item.slice(at + 1)]; }));
      assert.equal(env.MINIMAX_DATA_DIR, dataDir);
      for (const field of ['PLUGIN_DATA', 'SESSION_ID', 'AGENT_ID']) assert.equal(env[field], undefined);
      if (wires.has(pid)) continue;
      const wire = { pid, server: connection.name, input: '', output: '' };
      wires.set(pid, wire);
      // Transparent taps on our disposable child pipes record actual protocol
      // bytes; every write and response is passed through without modification.
      const write = child.stdin.write;
      child.stdin.write = function (bytes, ...args) { wire.input += String(bytes); return write.call(this, bytes, ...args); };
      child.stdout.on('data', (bytes) => { wire.output += bytes.toString('utf8'); });
    }
  }
  t.after(async () => {
    await Promise.all(runtimes.map((runtime) => runtime.close()));
    await host.hooks.dispose();
    process.chdir(previousCwd);
    os.homedir = previousHome;
    syncBuiltinESMExports();
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, previousEnv);
    rmSync(root, { recursive: true, force: true });
  });
  for (const name of pluginNames) cpSync(join(repo, 'plugins', name), join(dataDir, 'plugins', name), { recursive: true });
  // Rules are a separately installed component; use the documented user path.
  cpSync(join(repo, 'rules'), join(home, '.minimax', 'rules'), { recursive: true });
  const rules = readdirSync(join(repo, 'rules')).filter((name) => name.endsWith('.json') && !name.startsWith('_'))
    .map((name) => readJson(join(repo, 'rules', name)));
  const poison = rules.find((rule) => rule.name === '70-reasoning-poison');
  const packageStore = new loader.PackageStore({ dataDir, metrics: { localScan(...args) { logs.push({ kind: 'scan', args }); } } });
  let packages, handlers, inventory;
  const entries = (items) => items.flatMap(({ plugin, contentDigest }) => plugin.mcpServers.map((server) => ({
    pluginName: plugin.name, source: 'LOCAL_MINIMAX', packageContentDigest: contentDigest, server,
  })));
  const createRuntime = () => {
    const runtime = new loader.PluginMcpRuntime({ poolOptions: { idleTimeoutMs: 120000 }, logger: {
      info: (message, data) => logs.push({ kind: 'mcp-info', message, data }),
      warn: (message, data) => logs.push({ kind: 'mcp-warn', message, data }),
      error: (message, data) => logs.push({ kind: 'mcp-error', message, data }),
    } });
    runtimes.push(runtime);
    return runtime;
  };
  const runtime = createRuntime();
  async function reload() {
    packages = await packageStore.scanLocalPackages();
    assert.deepEqual(packages.map(({ plugin }) => plugin.name).sort(), pluginNames);
    for (const { plugin, contentDigest } of packages) {
      assert.deepEqual(plugin.diagnostics, []);
      assert.ok(contentDigest);
      for (const hook of plugin.hooks) {
        assert.match(hook.command, /^bun /, 'every owned native hook selects Bun');
        assert.equal(hook.pluginDataDir, join(dataDir, 'v2', 'plugin-data', 'hooks', plugin.name));
        assert.ok(hook.pluginRoot.startsWith(join(dataDir, 'v2', 'plugin-hook-cache') + sep));
        assert.equal(hook.activationKey, contentDigest);
      }
    }
    handlers = packages.flatMap(({ plugin }) => plugin.hooks);
    inventory = await runtime.reconcile(entries(packages));
    assert.deepEqual(inventory.diagnostics, []);
    observeWire(runtime);
    return inventory;
  }
  await reload();
  const context = { model: 'offline/ports-fixture', permissionMode: 'default' };
  const turn = (sessionId, turnId, options = {}) => ({
    sessionId, turnId, cwd: workspaceDir, prompt: 'Synthetic initial input', handlers, ...context, ...options,
  });
  const input = (sessionId, turnId, options = {}) => ({
    lease: { sessionId, turnId, signal: new AbortController().signal },
    session: { workspaceDir }, pluginHooks: handlers, pluginHookRuntimeContext: context,
    assembly: { tools: inventory.runtimeTools }, pluginApprovalRequests: new Map(),
    pluginMcpToolOwners: new Map(inventory.runtimeToolBindings.map((binding) => [binding.tool.def.name, binding.pluginName])),
    ...options,
  });
  function tool(name, from = inventory) {
    const result = from.runtimeTools.find((item) => item.def.name === name);
    assert.ok(result, `Native runtime did not load ${name}`);
    return result;
  }
  async function invoke(sessionId, turnId, name, args, options = {}) {
    const nativeInput = input(sessionId, turnId, {
      ...(options.cwd ? { session: { workspaceDir: options.cwd } } : {}),
      ...(options.handlers ? { pluginHooks: options.handlers } : {}),
    });
    const availableTools = options.availableTools ?? [options.tool ?? tool(name, options.inventory)];
    const pluginToolContexts = new Map();
    const result = await host.executeTools({ tools: availableTools.map((selected) => host.adaptTool(selected, {
      sessionId, turnId, workspaceDir: nativeInput.session.workspaceDir,
    })) }, { role: 'assistant', content: [{ type: 'toolCall', id: options.id ?? `call-${turnId}`,
      name, arguments: args }] }, {
      toolExecution: 'sequential',
      beforeToolCall: (context) => host.beforeTool({ input: nativeInput, context, pluginToolContexts }),
      afterToolCall: (context) => host.afterTool({ input: nativeInput, context }),
    }, undefined, async () => {});
    assert.equal(result.messages.length, 1);
    return result.messages[0];
  }
  const taskPath = (sessionId) => join(dataDir, 'v2', 'plugin-data', 'hooks', 'control-task', 'control-task', 'sessions', `${sessionId}.json`);
  const guideDir = (sessionId) => join(dataDir, 'v2', 'plugin-data', 'hooks', 'agent-state', 'agent-state', 'sessions', sessionId);
  const assertBodies = (text) => {
    assert.equal(typeof text, 'string');
    for (const rule of rules) assert.ok(text.includes(rule.body.trim()), `Missing full standing body ${rule.name}`);
  };
  const assertReminder = (message) => assert.ok(textOf(message).includes(poison.remind.suffix.trim()), 'Every executed tool receives the shipped reasoning-poison suffix');

  // Actual published DDL and record codecs; only SQLite connection/insertion is
  // fixture-owned. This does not pretend to run the optional native host writer.
  const sqlDir = join(dataDir, 'v2', 'sqlite');
  mkdirSync(sqlDir, { recursive: true });
  const dbPath = join(sqlDir, 'runtime-state.sqlite');
  const database = new DatabaseSync(dbPath);
  database.exec(loader.sessionDDL);
  loader.addHistoryMigration.up(database);
  const columns = {
    session_id: 'sessionId', record_json: 'recordJson', updated_at_ms: 'updatedAtMs', columnar_version: 'columnarVersion',
    agent_name: 'agentName', runtime: 'runtime', session_type: 'sessionType', status: 'status', archived: 'archived',
    visibility: 'visibility', session_kind: 'sessionKind', purpose: 'purpose', purpose_kind: 'purposeKind', origin_cron_id: 'originCronId',
    parent_session_id: 'parentSessionId', workspace_dir: 'workspaceDir', project_workspace_dir: 'projectWorkspaceDir',
    is_default_workspace: 'isDefaultWorkspace', title: 'title', created_at_ms: 'createdAtMs', error_message: 'errorMessage',
    error_code: 'errorCode', extra_data_json: 'extraDataJson', project_id: 'projectId', history_relative_dir: 'historyRelativeDir',
  };
  const names = Object.keys(columns);
  const insert = database.prepare(`INSERT OR REPLACE INTO local_runtime_sessions (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`);
  const records = new Map();
  function nativeSession(sessionId, options = {}) {
    const previous = records.get(sessionId);
    const record = previous ? host.mutateSession(previous, options, 1767225601000) : host.createRecord({
      sessionId, agentName: 'offline-native-fixture', workspaceDir, runtime: 'pi-agent', sessionType: 'branch',
      sessionKind: 'task', createdAtMs: 1767225600000, sessionDataVersion: 4, sessionOrigin: 'local-runtime', ...options,
    }, 1767225600000);
    const encoded = host.encodeSession(record);
    assert.equal(host.decodeSession(encoded).sessionId, sessionId);
    insert.run(...names.map((column) => encoded[columns[column]]));
    records.set(sessionId, record);
    return record;
  }
  t.after(() => database.close());
  return { root, dataDir, home, workspaceDir, childWorkspace, host, loader, logs, runtime, context,
    get packages() { return packages; }, get handlers() { return handlers; }, get inventory() { return inventory; },
    reload, entries, createRuntime, observeWire, wires, tool, turn, input, invoke, taskPath, guideDir, assertBodies, assertReminder,
    nativeSession, database, records, source };
}

test('published mcode 0.6.12 executes the four complete existing ports', { skip: !packageRoot, timeout: 180000 }, async (t) => {
  const f = await fixture(t);
  const set = 'mcp__control-task__control_task_set', get = 'mcp__control-task__control_task_get';
  const note = 'mcp__agent-state__agent_state_note';
  f.nativeSession('main-a'); f.nativeSession('main-b');
  f.nativeSession('child', { parentSessionId: 'main-a', workspaceDir: f.childWorkspace });

  await t.test('native materialization, manifests, raw MCP and skill loader', async () => {
    assert.deepEqual(f.inventory.runtimeTools.map((item) => item.def.name).sort(), [
      'mcp__agent-state__agent_state_checkpoint', note, 'mcp__control-task__control_task_confirm', get,
      'mcp__control-task__control_task_patch', set, 'mcp__probe__probe_echo',
    ].sort());
    for (const item of f.inventory.runtimeTools) {
      assert.equal(item.def.schema.type, 'object');
      assert.equal(item.def.schema[Symbol.for('TypeBox.Kind')], undefined);
    }
    const controlServer = [...f.runtime.servers].find(([, entry]) => entry.pluginName === 'control-task')[0];
    const listed = await f.runtime.pool.refreshTools(controlServer);
    for (const name of ['control_task_set', 'control_task_patch']) {
      assertRequirementsPolicy(listed.find((tool) => tool.name === name).description, `actual stdio tools/list ${name}`);
      assertRequirementsPolicy(f.tool(`mcp__control-task__${name}`).def.description, `native model tool ${name}`);
    }
    const guideServer = [...f.runtime.servers].find(([, entry]) => entry.pluginName === 'agent-state')[0];
    for (const tool of await f.runtime.pool.refreshTools(guideServer)) assertPrecompactPolicy(tool.description);
    assertPrecompactPolicy(f.tool(note).def.description);
    const probe = f.packages.find(({ plugin }) => plugin.name === 'probe-hook').plugin;
    assert.match(probe.skills[0].content, /PROBE-SKILL-MARKER-24680/);
    assert.deepEqual(readJson(join(probe.rootPath, 'probe.config.json')), { enabled: false });
  });

  await t.test('crossed starts and shared raw MCP isolate root A, root B and differing child agent_id', async () => {
    const startA = await f.host.hooks.beginTurn(f.turn('main-a', 'initial-a'));
    const startB = await f.host.hooks.beginTurn(f.turn('main-b', 'initial-b'));
    f.assertBodies(startA.decision.additionalContext); f.assertBodies(startB.decision.additionalContext);
    assertPrecompactPolicy(startA.decision.additionalContext);
    const child = await f.host.hooks.startSubagent({ handlers: f.handlers, parentSessionId: 'main-a',
      parentTurnId: 'parent-turn', childSessionId: 'child', childTurnId: 'child-turn',
      agentId: 'different-agent-instance', agentType: 'worker', cwd: f.childWorkspace, ...f.context });
    f.assertBodies(child.additionalContext);
    const results = await Promise.all([
      f.invoke('main-a', 'save-a', set, { taskBody: 'Canonical task A\nKeep original requirement A.', reason: 'Initial user task' }),
      f.invoke('main-b', 'save-b', set, { taskBody: 'Canonical task B\nKeep original requirement B.', reason: 'Initial user task' }),
      f.invoke('child', 'save-child', set, { taskBody: 'Canonical child task\nKeep original child requirement.', reason: 'Initial child task' }, { cwd: f.childWorkspace }),
    ]);
    for (const result of results) {
      assert.match(textOf(result), /PENDING_HOST_COMMIT/);
      assert.match(textOf(result), /status=committed/);
      f.assertReminder(result);
      assert.equal(result.isError, false);
    }
    const reads = await Promise.all([
      f.invoke('main-a', 'read-a', get, {}), f.invoke('main-b', 'read-b', get, {}),
      f.invoke('child', 'read-child', get, {}, { cwd: f.childWorkspace }),
    ]);
    for (const [index, id] of ['main-a', 'main-b', 'child'].entries()) {
      const state = readJson(f.taskPath(id));
      assert.equal(state.sessionId, id);
      assert.equal(state.taskRevision, 1);
      assert.ok(textOf(reads[index]).includes(state.revisions.at(-1).taskBody));
      for (const other of ['main-a', 'main-b', 'child'].filter((item) => item !== id)) {
        assert.ok(!textOf(reads[index]).includes(readJson(f.taskPath(other)).revisions.at(-1).taskBody));
      }
    }
    assert.equal(existsSync(f.taskPath('different-agent-instance')), false);
    t.diagnostic(`native committed bodies: ${['main-a', 'main-b', 'child'].map((id) => `${id}:${readJson(f.taskPath(id)).taskRevision}`).join(', ')}`);
  });

  await t.test('two independent native MCP processes retain hook-owned storage and raw protocol boundaries', async () => {
    const second = f.createRuntime();
    const inventory = await second.reconcile(f.entries(f.packages));
    assert.deepEqual(inventory.diagnostics, []);
    f.observeWire(second);
    const firstPids = [...f.runtime.pool.connections.values()].map((connection) => connection.transport.pid);
    const secondPids = [...second.pool.connections.values()].map((connection) => connection.transport.pid);
    assert.equal(new Set([...firstPids, ...secondPids]).size, 6, 'Each runtime owns three distinct real stdio children');
    const before = readJson(f.taskPath('main-a'));
    const unhooked = await f.invoke('main-a', 'external-only', set,
      { taskBody: 'An external MCP call cannot replace A', reason: 'Boundary test' }, { handlers: [], inventory });
    assert.match(textOf(unhooked), /PENDING_HOST_COMMIT/);
    assert.doesNotMatch(textOf(unhooked), /definitive operation result/);
    assert.deepEqual(readJson(f.taskPath('main-a')), before);
    const results = await Promise.all([
      f.invoke('main-a', 'process-one-read', get, {}),
      f.invoke('main-b', 'process-two-read', get, {}, { inventory }),
      f.invoke('child', 'process-two-child-read', get, {}, { inventory, cwd: f.childWorkspace }),
    ]);
    for (const [index, id] of ['main-a', 'main-b', 'child'].entries()) {
      assert.ok(textOf(results[index]).includes(readJson(f.taskPath(id)).revisions.at(-1).taskBody));
      f.assertReminder(results[index]);
    }
    const wires = [...f.wires.values()];
    const calls = wires.flatMap((wire) => wire.input.trim().split('\n').filter(Boolean).map(JSON.parse))
      .filter((message) => message.method === 'tools/call');
    assert.ok(calls.length >= 10);
    for (const call of calls) {
      assert.deepEqual(Object.keys(call.params).sort(), ['arguments', 'name']);
      for (const field of ['sessionId', 'session_id', 'parentSessionId', 'cwd', '_mcodeContext']) {
        assert.equal(field in call.params.arguments, false, `MCP did not receive trusted ${field}`);
      }
    }
    const replies = wires.flatMap((wire) => wire.output.trim().split('\n').filter(Boolean).map(JSON.parse));
    assert.ok(replies.some((reply) => reply.result?.structuredContent?.status === 'pending_host_commit'));
    assert.ok(replies.every((reply) => reply.jsonrpc === '2.0'));
    t.diagnostic(`Observed ${calls.length} actual tools/call wire requests across ${new Set([...firstPids, ...secondPids]).size} native stdio processes; session identity appears only at the hook boundary.`);
  });

  await t.test('missing, disabled, failed and timed-out PostToolUse leaves an unresolved receipt while the next tool and completion remain available', async () => {
    const failed = join(f.root, 'failure-fixture.mjs'), stalled = join(f.root, 'timeout-fixture.mjs');
    writeFileSync(failed, 'throw new Error("OFFLINE_HOOK_FAILURE");\n');
    writeFileSync(stalled, 'setInterval(() => {}, 1000);\n');
    const ownHook = (hook) => hook.pluginName === 'control-task' && hook.event === 'PostToolUse';
    const cases = [
      ['missing', []], ['disabled', f.handlers.filter((hook) => !ownHook(hook))],
      ['failed', f.handlers.map((hook) => ownHook(hook) ? { ...hook, command: `bun "${failed}"` } : hook)],
      ['timed-out', f.handlers.map((hook) => ownHook(hook) ? { ...hook, command: `bun "${stalled}"` } : hook)],
    ];
    for (const [label, handlers] of cases) {
      const sessionId = `pending-${label}`;
      f.nativeSession(sessionId);
      const result = await f.invoke(sessionId, `hook-${label}`, set,
        { taskBody: `Pending task ${label}`, reason: 'Exercise unavailable native hook' }, { handlers });
      assert.match(textOf(result), /PENDING_HOST_COMMIT/);
      assert.doesNotMatch(textOf(result), /\[control-task definitive operation result\]/);
      assert.equal(existsSync(f.taskPath(sessionId)), false);
      if (handlers.length) f.assertReminder(result);
      assert.match(textOf(result), /Continue the authorized task or finish the response/);
      const next = await f.invoke(sessionId, `after-${label}`, 'mcp__probe__probe_echo',
        { text: `NEXT_TOOL_AFTER_${label}` }, { handlers });
      assert.equal(next.isError, false);
      assert.match(textOf(next), /PROBE-MCP-DISABLED/);
      assert.equal(next.details.mcp.structuredContent.status, 'disabled');
      const messages = [];
      assert.equal(await f.host.stopAfterTurn(f.input(sessionId, `after-${label}`, { pluginHooks: handlers }), messages,
        { stopHookActive: false, stopContinuationCount: 0, lastAssistantMessage: 'Primary work completed despite unresolved storage' }), true);
      assert.deepEqual(messages, [], 'A pending hook outcome does not request a repair or acknowledgment turn');
    }
    const warnings = f.logs.filter((entry) => entry.kind === 'hook');
    assert.ok(warnings.length >= 2, 'Actual hook failures produce native diagnostics');
    t.diagnostic(`Native failure diagnostics observed: ${warnings.map((entry) => JSON.stringify(entry)).join(' ').slice(0, 1400)}`);
  });

  const rawResult = (message) => ({ content: message.details.mcp.content, details: message.details });
  async function repeatPost(sessionId, turnId, toolName, args, result, id, cwd = f.workspaceDir) {
    return f.host.afterTool({ input: f.input(sessionId, turnId, { session: { workspaceDir: cwd } }), context: {
      toolCall: { id, name: toolName }, args, result, isError: false,
    } });
  }

  await t.test('native receipt validation, replay after expiry and reused tool IDs remain truthful', async () => {
    f.nativeSession('receipt-owner');
    const args = { taskBody: 'Original receipt-owned canonical body', reason: 'Set the original task' };
    const original = await f.invoke('receipt-owner', 'receipt-set', set, args, { id: 'stable-native-call' });
    assert.match(textOf(original), /status=committed/);
    const raw = structuredClone(rawResult(original));
    let state = readJson(f.taskPath('receipt-owner'));
    const operation = state.operations.find((item) => item.toolUseId === 'stable-native-call');
    assert.equal(operation.receipt.receiptId, raw.details.mcp.structuredContent.receiptId);
    // Historical durable fixture: age the same real receipt and its recorded
    // completion together. The real hook must consult it before admission age.
    const old = Date.now() - 120000;
    operation.receipt.createdAt = old;
    operation.completedAt = old + 1000;
    raw.details.mcp.structuredContent.createdAt = old;
    writeFileSync(f.taskPath('receipt-owner'), JSON.stringify(state) + '\n');
    const replay = await repeatPost('receipt-owner', 'receipt-set', set, args, raw, 'stable-native-call');
    assert.match(textOf(replay), /status=committed/);
    assert.match(textOf(replay), /Retained completed receipt replayed/);
    assert.equal(readJson(f.taskPath('receipt-owner')).taskRevision, 1);
    const reused = await f.invoke('receipt-owner', 'receipt-conflict', set,
      { taskBody: 'A conflicting replacement', reason: 'Different arguments' }, { id: 'stable-native-call' });
    assert.match(textOf(reused), /status=rejected/);
    assert.equal(readJson(f.taskPath('receipt-owner')).revisions.at(-1).taskBody, args.taskBody);
    assert.equal(reused.details.mcp.isError, false);
    assert.equal(reused.isError, false, 'PostToolUse context cannot rewrite the original native MCP success flag');

    for (const label of ['expired', 'wrong-server', 'wrong-digest', 'upstream-error']) {
      const sessionId = `receipt-${label}`;
      f.nativeSession(sessionId);
      const pending = await f.invoke(sessionId, label, set, args, { handlers: [], id: `pending-${label}` });
      const bad = structuredClone(rawResult(pending));
      if (label === 'expired') bad.details.mcp.structuredContent.createdAt = old;
      if (label === 'wrong-server') bad.details.server = 'unrelated-server';
      if (label === 'wrong-digest') bad.details.mcp.structuredContent.inputDigest = '0'.repeat(64);
      if (label === 'upstream-error') bad.details.mcp.isError = true;
      const result = await repeatPost(sessionId, label, set, args, bad, `pending-${label}`);
      assert.doesNotMatch(textOf(result), /status=committed/);
      assert.equal(existsSync(f.taskPath(sessionId)), false);
      f.assertReminder(result);
      if (label === 'expired') assert.match(textOf(result), /RECEIPT_EXPIRED[\s\S]*did not execute|did not execute[\s\S]*RECEIPT_EXPIRED/);
    }
    state = readJson(f.taskPath('receipt-owner'));
    assert.equal(state.taskRevision, 1);
    assert.equal(state.operations.length, 1);
  });

  await t.test('combined maximum task, 1024 original guide locators and shipped rules fit the native startup budget', async () => {
    f.nativeSession('bound-parent');
    f.nativeSession('bound-main', { parentSessionId: 'bound-parent' });
    const originals = [];
    for (const id of ['bound-parent', 'bound-main']) {
      mkdirSync(f.guideDir(id), { recursive: true });
      for (let index = 0; index < 512; index++) {
        const path = join(f.guideDir(id), `guide-${String(index).padStart(3, '0')}-${'x'.repeat(190)}.md`);
        writeFileSync(path, `shared: true\ntitle: Native bounded guide ${index}\nupdated: 2026-01-01T00:00:00.000Z\n---\nGUIDE-${id}-${index}\n${'"\\\u0001Ж'.repeat(600)}\n`);
        originals.push(path);
      }
    }
    const body = 'TASK_BOUND_START\n' + 'т'.repeat(11950) + '\nTASK_BOUND_END';
    const saved = await f.invoke('bound-main', 'bound-set', set, { taskBody: body, reason: 'Maximum combined native delivery' });
    assert.match(textOf(saved), /status=committed/);
    f.assertReminder(saved);
    assert.equal(readJson(f.taskPath('bound-main')).revisions.at(-1).taskBody, body);
    const started = await f.host.hooks.beginTurn(f.turn('bound-main', 'bound-start'));
    f.assertBodies(started.decision.additionalContext);
    const combined = started.decision.additionalContext;
    assert.ok(combined.includes(`${f.taskPath('bound-main')}#taskRevision=1`));
    const indexPath = join(f.guideDir('bound-main'), '.guide-locators.json');
    assert.ok(combined.includes(indexPath));
    const index = readJson(indexPath);
    assert.equal(index.files.length, 1024);
    assert.deepEqual(new Set(index.files.map((file) => file.path)), new Set(originals));
    const begins = combined.split('[BEGIN VERBATIM CANONICAL TASK]').length - 1;
    const ends = combined.split('[END VERBATIM CANONICAL TASK]').length - 1;
    t.diagnostic(`Combined native startup: ${combined.length} characters; task begin/end markers=${begins}/${ends}; complete guide locator index=${index.files.length}; diagnostics=${JSON.stringify(started.diagnostics)}.`);
    assert.equal(begins, ends, 'Native combined startup must never clip a canonical task body');
    assert.ok(combined.length < 64 * 1024, 'Combined context stays below the host clipping limit');
    assert.deepEqual(started.diagnostics, []);
    const fullRead = await f.invoke('bound-main', 'bound-full-get', get, {});
    assert.ok(textOf(fullRead).includes(body), 'Native get retains the complete maximum-size original when its own envelope fits');
    const escaped = 'ESCAPED_TASK_START' + '\u0001'.repeat(11950) + 'ESCAPED_TASK_END';
    const escapedSave = await f.invoke('bound-main', 'bound-escaped-set', set, { taskBody: escaped, reason: 'Maximum JSON-escaped native body' });
    assert.match(textOf(escapedSave), /status=committed/);
    f.assertReminder(escapedSave);
    assert.ok(textOf(escapedSave).includes(`${f.taskPath('bound-main')}#taskRevision=2`));
    assert.match(textOf(escapedSave), /complete canonical body is omitted/);
    assert.equal(readJson(f.taskPath('bound-main')).revisions.at(-1).taskBody, escaped);
    const { hookOutputByteLength } = await import(pathToFileURL(join(repo, 'runtime', 'host.mjs')).href);
    for (const plugin of ['agent-state', 'control-task', 'injection-rules']) {
      const isolated = await f.host.hooks.runEvent(f.handlers.filter((hook) => hook.pluginName === plugin), {
        event: 'SessionStart', sessionId: 'bound-main', turnId: `encoded-${plugin}`, cwd: f.workspaceDir,
        ...f.context, matcherValue: 'compact', payload: { source: 'compact' },
      });
      assert.deepEqual(isolated.diagnostics, []);
      const context = isolated.decision.additionalContext;
      assert.ok(context);
      assert.ok(hookOutputByteLength('SessionStart', context) < 60 * 1024, `${plugin} encoded native envelope fits`);
    }
  });

  await t.test('actual queued steering preserves complete explicit and implied requirements through review, restart and compact', async () => {
    f.nativeSession('steer-main');
    const controlHooks = f.handlers.filter((hook) => hook.pluginName === 'control-task');
    const notSet = await f.host.hooks.runEvent(controlHooks, {
      event: 'SessionStart', sessionId: 'steer-main', turnId: 'steer-not-set', cwd: f.workspaceDir,
      ...f.context, matcherValue: 'startup', payload: { source: 'startup' },
    });
    assert.match(notSet.decision.additionalContext, /ACTIVE TASK — NOT SET/);
    assertRequirementsPolicy(notSet.decision.additionalContext, 'native not-set guidance');
    const originalPrompt = 'Repair all four existing ports and preserve my existing task and guide state across upgrade and restart.';
    const started = await f.host.hooks.beginTurn(f.turn('steer-main', 'steer-start', { prompt: originalPrompt }));
    assertInputObligation(started.decision.additionalContext, 'native first-prompt obligation');
    const before = readJson(f.taskPath('steer-main')).inputRevision;
    const clauses = [
      'Explicit outcome: repair control-task, agent-state, injection-rules and probe-hook. Source: fixture://request/original#ports.',
      'Inferred requirement: retained canonical tasks and reusable guides remain readable after upgrade and restart. Basis: the original preservation request. Source: fixture://request/original#preserve.',
      'Constraint: diagnostic probe writes remain disabled in the distributed package. Source: fixture://request/original#diagnostics.',
      'Result condition: demonstrate correct independent root and child state plus delivery after committed compact. Source: fixture://request/original#result.',
      'Open assumption — UNVERIFIED: the installed host matches the pinned offline fixture; actual installed version evidence is still missing. Basis: only the offline package was provided. Source: fixture://evidence/host-package.',
    ];
    const body = clauses.join('\n');
    const initial = await f.invoke('steer-main', 'steer-set', set, { taskBody: body, reason: 'Complete original task with grounded inference and qualified assumption', reviewedInputRevision: before });
    assert.ok(textOf(initial).includes(body));
    assertRequirementsPolicy(textOf(initial), 'native current-task result guidance');
    const clarification = 'Also make same-length edits to a shared parent guide refresh the child delivery; keep every earlier task clause.';
    const addedClause = 'Additional explicit requirement: same-length parent-guide edits refresh child delivery. Source: fixture://request/clarification#same-length.';
    const prompts = [clarification, 'Please review the existing original constraints.', 'Identical steering', 'Identical steering'];
    const preparedAt = [], admitted = [];
    for (const [index, prompt] of prompts.entries()) {
      const result = await f.host.prepareSteering(f.input('steer-main', 'same-live-turn', index === 0 ? { pluginHooks: controlHooks } : {}), {
        message: { text: prompt }, producerId: 'composer-steer', userMessageId: `native-user-${index}`, idempotencyKey: `native-user-${index}`,
      }, async (pending) => {
        preparedAt.push(readJson(f.taskPath('steer-main')).inputRevision);
        return { userMessage: { text: pending.message.text }, genuineUserQueryText: pending.message.text };
      });
      assertInputObligation(textOf(result.message), `native steering obligation ${index}`);
      if (index === 0) assertRequirementsPolicy(textOf(result.message), 'native raw-input reconciliation guidance', { review: true });
      admitted.push(result.acceptedUserMessageId);
    }
    let state = readJson(f.taskPath('steer-main'));
    assert.deepEqual(state.inputs.slice(-4).map((item) => item.text), prompts);
    assert.deepEqual(state.inputs.slice(-4).map((item) => item.turnId), prompts.map(() => 'same-live-turn'));
    assert.deepEqual(state.inputs.slice(-4).map((item) => item.provenance), prompts.map(() => 'native-UserPromptSubmit-observation'));
    assert.equal(new Set(state.inputs.slice(-4).map((item) => item.observationId)).size, 4);
    assert.deepEqual(preparedAt, [1, 2, 3, 4].map((value) => before + value), 'Hooks observe raw input before native preparation returns');
    assert.deepEqual(admitted, prompts.map((_, index) => `native-user-${index}`));
    assert.equal(state.reviewedInputRevision, before);
    assert.equal(state.revisions.at(-1).taskBody, body);
    const replayedSteering = await f.host.prepareSteering(f.input('steer-main', 'same-live-turn'), {
      message: { text: prompts[3] }, producerId: 'composer-steer', userMessageId: 'native-user-3', idempotencyKey: 'native-user-3',
    }, async (pending) => ({ userMessage: { text: pending.message.text }, genuineUserQueryText: pending.message.text }));
    assertInputObligation(textOf(replayedSteering.message), 'native replayed occurrence obligation');
    assert.equal(readJson(f.taskPath('steer-main')).inputRevision, before + 5, 'Indistinguishable hook replay is conservatively another observation');
    const view = await f.invoke('steer-main', 'steer-view', get, { inputFromRevision: before + 1, inputLimit: 5 });
    for (let index = before + 1; index <= before + 5; index++) assert.ok(textOf(view).includes(`${f.taskPath('steer-main')}#inputRevision=${index}`));
    for (const prompt of prompts) assert.ok(textOf(view).includes(prompt));
    assert.match(textOf(view), /not an exact-once accepted-human-message count/);
    const priorCompact = readJson(f.taskPath('steer-main')).inputRevision;
    const compact = await f.host.autoPostCompact(f.input('steer-main', 'steer-compact'), 'Offline committed summary');
    assert.ok(compact.content.includes(body));
    assert.ok(compact.content.includes(`inputRevision=${priorCompact}; reviewedInputRevision=${before}; unreviewed=5`));
    assert.equal(readJson(f.taskPath('steer-main')).inputRevision, priorCompact, 'Successful compact and tool results are not prompt inputs');

    async function restartSnapshot(tag, expectedBody, reviewed) {
      const restarted = new f.host.HookLifecycle(undefined, { automaticIdleSessionEnd: false });
      try {
        // A fresh native lifecycle executes the registered SessionStart(resume)
        // commands. This restoration event supplies no UserPromptSubmit.
        const result = await restarted.runEvent(f.handlers, {
          event: 'SessionStart', sessionId: 'steer-main', turnId: tag, cwd: f.workspaceDir,
          ...f.context, matcherValue: 'resume', payload: { source: 'resume' },
        });
        assert.deepEqual(result.diagnostics, []);
        f.assertBodies(result.decision.additionalContext);
        assert.ok(result.decision.additionalContext.includes(expectedBody));
        const durable = readJson(f.taskPath('steer-main'));
        assert.equal(durable.revisions.at(-1).taskBody, expectedBody);
        assert.equal(durable.reviewedInputRevision, reviewed);
        assert.ok(result.decision.additionalContext.includes(`inputRevision=${durable.inputRevision}; reviewedInputRevision=${reviewed}; unreviewed=${durable.inputRevision - reviewed}`));
      } finally { await restarted.dispose(); }
    }
    await restartSnapshot('steer-pending-resume', body, before);
    assert.equal(readJson(f.taskPath('steer-main')).inputRevision, priorCompact);
    const expectedBody = [...clauses, addedClause].join('\n');
    const patched = await f.invoke('steer-main', 'steer-reconcile-patch', 'mcp__control-task__control_task_patch', {
      expectedRevision: 1, operations: [{ op: 'add', after: clauses.at(-1), text: addedClause }],
      reason: 'Add the authoritative clarification while preserving every original clause and qualification', reviewedInputRevision: priorCompact,
    });
    assert.match(textOf(patched), /status=committed/);
    assert.ok(textOf(patched).includes(expectedBody));
    state = readJson(f.taskPath('steer-main'));
    assert.equal(state.taskRevision, 2);
    assert.equal(state.reviewedInputRevision, priorCompact);
    assert.equal(state.revisions.at(-1).taskBody, expectedBody);
    const nonmaterial = 'Check progress against the same complete task; this message adds or cancels no requirement.';
    const unchangedSteering = await f.host.prepareSteering(f.input('steer-main', 'same-live-turn'), {
      message: { text: nonmaterial }, producerId: 'composer-steer', userMessageId: 'native-nonmaterial', idempotencyKey: 'native-nonmaterial',
    }, async (pending) => ({ userMessage: { text: pending.message.text }, genuineUserQueryText: pending.message.text }));
    assertInputObligation(textOf(unchangedSteering.message), 'native nonmaterial steering obligation');
    const finalInputRevision = priorCompact + 1;
    const review = await f.invoke('steer-main', 'steer-review-original', get, { inputFromRevision: finalInputRevision, inputLimit: 1 });
    assert.ok(textOf(review).includes(expectedBody));
    assert.ok(textOf(review).includes(nonmaterial));
    assert.ok(textOf(review).includes(`${f.taskPath('steer-main')}#inputRevision=${finalInputRevision}`));
    const stale = await f.invoke('steer-main', 'steer-stale-confirm', 'mcp__control-task__control_task_confirm', {
      reviewedInputRevision: priorCompact, reason: 'An earlier review cannot clear the new observation',
    });
    assert.match(textOf(stale), /code=STALE_INPUT_REVISION/);
    assert.equal(readJson(f.taskPath('steer-main')).reviewedInputRevision, priorCompact);
    const confirmed = await f.invoke('steer-main', 'steer-exact-confirm', 'mcp__control-task__control_task_confirm', {
      reviewedInputRevision: finalInputRevision, reason: 'Read the raw nonmaterial input and the whole still-applicable task; definition unchanged',
    });
    assert.match(textOf(confirmed), /status=committed/);
    assert.ok(textOf(confirmed).includes(expectedBody));
    await restartSnapshot('steer-reviewed-resume', expectedBody, finalInputRevision);
    const reviewedCompact = await f.host.autoPostCompact(f.input('steer-main', 'steer-reviewed-compact'), 'Another offline committed summary');
    assert.ok(reviewedCompact.content.includes(expectedBody));
    assert.ok(reviewedCompact.content.includes(`inputRevision=${finalInputRevision}; reviewedInputRevision=${finalInputRevision}; unreviewed=0`));
    state = readJson(f.taskPath('steer-main'));
    assert.equal(state.taskRevision, 2, 'Unchanged confirmation and lifecycle delivery do not rewrite the task');
    assert.equal(state.inputRevision, finalInputRevision, 'Restore, compact and tool results introduce no synthetic raw prompt');
    assert.deepEqual(state.inputs.map((item) => item.text), [originalPrompt, ...prompts, prompts[3], nonmaterial]);

    f.nativeSession('steer-child', { parentSessionId: 'steer-main' });
    await f.host.hooks.startSubagent({ handlers: f.handlers, parentSessionId: 'steer-main', parentTurnId: 'same-live-turn',
      childSessionId: 'steer-child', childTurnId: 'child-live-turn', agentId: 'steering-agent-instance', agentType: 'worker',
      cwd: f.workspaceDir, ...f.context });
    assert.equal(readJson(f.taskPath('steer-child')).inputRevision, 0, 'SubagentStart is not a prompt input');
    for (let index = 0; index < 2; index++) {
      const childSteering = await f.host.prepareSteering(f.input('steer-child', 'child-live-turn'), {
        message: { text: 'Identical child steering' }, producerId: 'composer-steer', userMessageId: `child-user-${index}`, idempotencyKey: `child-user-${index}`,
      }, async (pending) => ({ userMessage: { text: pending.message.text }, genuineUserQueryText: pending.message.text }));
      assertInputObligation(textOf(childSteering.message), `native child steering obligation ${index}`);
    }
    state = readJson(f.taskPath('steer-child'));
    assert.deepEqual(state.inputs.map((item) => item.text), ['Identical child steering', 'Identical child steering']);
    assert.equal(state.binding.agentId, 'steering-agent-instance');
    assert.equal(readJson(f.taskPath('steer-main')).inputRevision, finalInputRevision);
    t.diagnostic(`Native cJn retained ${finalInputRevision} root observations and two child observations; complete explicit/implied clauses, sources and qualified assumption survived pending/reviewed restart and compact. Policy was checked outside supplied task/raw text; no autonomous model compliance is inferred.`);
  });

  const guideState = (sessionId) => readJson(join(f.guideDir(sessionId), '.agent-state.json'));
  const echo = 'mcp__probe__probe_echo';
  const otherTool = (sessionId, tag, cwd = f.workspaceDir) => f.invoke(sessionId, tag, echo, { text: `Offline other tool ${tag}` }, { cwd });
  async function saveGuide(sessionId, tag, args, cwd = f.workspaceDir) {
    const result = await f.invoke(sessionId, tag, note, args, { cwd });
    assert.match(textOf(result), /status=committed/);
    assert.match(textOf(result), /Reusable guide committed/);
    assert.ok(textOf(result).includes(args.body));
    f.assertReminder(result);
    return result;
  }

  await t.test('saved guides reach native results, start, resume and exact immediate-child inheritance', async () => {
    f.nativeSession('guide-grand'); f.nativeSession('guide-b');
    f.nativeSession('guide-parent', { parentSessionId: 'guide-grand' });
    f.nativeSession('guide-child', { parentSessionId: 'guide-parent', workspaceDir: f.childWorkspace });
    f.nativeSession('guide-sibling', { parentSessionId: 'guide-parent' });
    f.nativeSession('guide-grandchild', { parentSessionId: 'guide-child' });
    await saveGuide('guide-grand', 'grand-guide', { title: 'Grand guide', body: 'GRANDPARENT_SHARED_BODY', shared: true });
    await saveGuide('guide-b', 'b-guide', { title: 'B guide', body: 'SECOND_PARENT_SHARED_BODY', shared: true });
    await saveGuide('guide-parent', 'parent-shared', { title: 'Parent shared', body: 'PARENT_SHARED_OLD', shared: true });
    await saveGuide('guide-parent', 'parent-private', { title: 'Parent private', body: 'PARENT_PRIVATE_BODY' });
    await saveGuide('guide-sibling', 'sibling-guide', { title: 'Sibling guide', body: 'SIBLING_SHARED_BODY', shared: true });
    writeFileSync(join(f.guideDir('guide-parent'), 'malformed-sharing.md'), 'title: Missing strict sharing header\n---\nshared: true\nMALFORMED_SHARED_BODY\n');
    const started = await f.host.hooks.beginTurn(f.turn('guide-parent', 'guide-parent-start'));
    f.assertBodies(started.decision.additionalContext);
    for (const marker of ['PARENT_SHARED_OLD', 'PARENT_PRIVATE_BODY', 'GRANDPARENT_SHARED_BODY']) assert.ok(started.decision.additionalContext.includes(marker));
    const child = await f.host.hooks.startSubagent({ handlers: f.handlers, parentSessionId: 'guide-parent', parentTurnId: 'guide-parent-start',
      childSessionId: 'guide-child', childTurnId: 'guide-child-start', agentId: 'guide-child-instance', agentType: 'worker',
      cwd: f.childWorkspace, ...f.context });
    assert.ok(child.additionalContext.includes('PARENT_SHARED_OLD'));
    f.assertBodies(child.additionalContext);
    const own = await saveGuide('guide-child', 'own-guide', { title: 'Child own', body: 'CHILD_OWN_SHARED_BODY', shared: true }, f.childWorkspace);
    for (const marker of ['PARENT_SHARED_OLD', 'CHILD_OWN_SHARED_BODY']) assert.ok(textOf(own).includes(marker));
    for (const marker of ['PARENT_PRIVATE_BODY', 'GRANDPARENT_SHARED_BODY', 'SIBLING_SHARED_BODY', 'SECOND_PARENT_SHARED_BODY', 'MALFORMED_SHARED_BODY']) {
      assert.ok(!textOf(own).includes(marker), `Child cannot discover ${marker}`);
    }
    assert.doesNotMatch(textOf(own), /INJECTION TRUNCATED/);
    assert.equal(guideState('guide-child').binding.agentId, 'guide-child-instance');
    const grandchild = await f.host.hooks.startSubagent({ handlers: f.handlers, parentSessionId: 'guide-child', parentTurnId: 'guide-child-start',
      childSessionId: 'guide-grandchild', childTurnId: 'grandchild-start', agentId: 'grandchild-instance', agentType: 'worker',
      cwd: f.workspaceDir, ...f.context });
    assert.ok(grandchild.additionalContext.includes('CHILD_OWN_SHARED_BODY'));
    assert.ok(!grandchild.additionalContext.includes('PARENT_SHARED_OLD'));
    const restarted = new f.host.HookLifecycle(undefined, { automaticIdleSessionEnd: false });
    try {
      const resumed = await restarted.beginTurn(f.turn('guide-parent', 'guide-resume', { resumeExistingSession: true }));
      f.assertBodies(resumed.decision.additionalContext);
      assert.ok(resumed.decision.additionalContext.includes('PARENT_SHARED_OLD'));
      assert.ok(resumed.decision.additionalContext.includes('PARENT_PRIVATE_BODY'));
    } finally { await restarted.dispose(); }
  });

  await t.test('native guide digest refresh and ten completed-tool cadence avoid repeated unchanged bodies', async () => {
    const before = guideState('guide-child');
    assert.equal(before.delivery.completedOtherCalls, 0);
    const parentOriginal = join(f.guideDir('guide-parent'), 'parent-shared.md');
    const oldBytes = readFileSync(parentOriginal, 'utf8');
    const changedBytes = oldBytes.replace('PARENT_SHARED_OLD', 'PARENT_SHARED_NEW');
    assert.equal(Buffer.byteLength(changedBytes), Buffer.byteLength(oldBytes));
    writeFileSync(parentOriginal, changedBytes);
    const refreshed = await otherTool('guide-child', 'fresh-parent', f.childWorkspace);
    assert.ok(textOf(refreshed).includes('PARENT_SHARED_NEW'));
    assert.ok(!textOf(refreshed).includes('PARENT_SHARED_OLD'));
    assert.notEqual(guideState('guide-child').delivery.lastDigest, before.delivery.lastDigest);
    for (let index = 2; index <= 10; index++) {
      const result = await otherTool('guide-child', `cadence-${index}`, f.childWorkspace);
      assert.ok(!textOf(result).includes('CHILD_OWN_SHARED_BODY'));
      assert.ok(!textOf(result).includes('PARENT_SHARED_NEW'));
      f.assertReminder(result);
      if (index < 10) assert.doesNotMatch(textOf(result), /\[Reusable guide reminder\]/);
      else {
        assert.match(textOf(result), /\[Reusable guide reminder\]/);
        assertPrecompactPolicy(textOf(result));
      }
    }
    assert.equal(guideState('guide-child').delivery.completedOtherCalls, 0);
    const epoch = guideState('guide-child').delivery.epoch;
    const compact = await f.host.autoPostCompact(f.input('guide-child', 'guide-auto', { session: { workspaceDir: f.childWorkspace } }), 'Committed child compact');
    assert.ok(compact.content.includes('PARENT_SHARED_NEW'));
    assert.ok(compact.content.includes('CHILD_OWN_SHARED_BODY'));
    f.assertBodies(compact.content);
    assertPrecompactPolicy(compact.content);
    assert.equal(guideState('guide-child').delivery.epoch, epoch + 1);
    assert.equal(guideState('guide-child').delivery.completedOtherCalls, 0);
    await otherTool('guide-child', 'before-failed-compact', f.childWorkspace);
    const beforeFailure = guideState('guide-child').delivery;
    await f.host.hooks.runEvent(f.handlers, { event: 'PreCompact', sessionId: 'guide-child', turnId: 'failed-compact',
      cwd: f.childWorkspace, ...f.context, payload: { trigger: 'auto' } });
    assert.deepEqual(guideState('guide-child').delivery, beforeFailure, 'A prepared but uncommitted compact does not reset cadence');
    await f.host.manualPostCompact({ input: f.input('guide-parent', 'guide-manual'), capabilities: { hooks: f.handlers },
      cwd: f.workspaceDir, runtimeContext: f.context, compactSummary: 'Committed manual summary' });
    const next = await f.host.hooks.beginTurn(f.turn('guide-parent', 'after-guide-manual'));
    f.assertBodies(next.decision.additionalContext);
    assert.ok(next.decision.additionalContext.includes('PARENT_SHARED_NEW'));
    assert.ok(next.decision.additionalContext.includes('PARENT_PRIVATE_BODY'));
    assert.match(next.decision.additionalContext, /Successful compaction boundary/);
  });

  await t.test('native lineage is retried and current parent/workspace transitions preserve the session store', async () => {
    f.nativeSession('lineage-late', { parentSessionId: 'late-parent' });
    const own = await saveGuide('lineage-late', 'late-own', { title: 'Late own', body: 'LATE_OWN_BODY' });
    assert.match(textOf(own), /partial/);
    assert.equal(guideState('lineage-late').delivery.lastDigest, null);
    f.nativeSession('late-parent');
    await saveGuide('late-parent', 'late-parent-guide', { title: 'Late parent', body: 'LATE_PARENT_BODY', shared: true });
    const retried = await otherTool('lineage-late', 'late-lineage-retry');
    assert.ok(textOf(retried).includes('LATE_OWN_BODY'));
    assert.ok(textOf(retried).includes('LATE_PARENT_BODY'));
    assert.ok(guideState('lineage-late').delivery.lastDigest);

    const originalOwn = readFileSync(join(f.guideDir('guide-child'), 'child-own.md'));
    const moved = join(f.root, 'verified-new-workspace'), wrong = join(f.root, 'unverified-workspace');
    mkdirSync(moved); mkdirSync(wrong);
    f.nativeSession('guide-child', { parentSessionId: 'guide-b', workspaceDir: moved });
    const transitioned = await otherTool('guide-child', 'lineage-transition', moved);
    assert.ok(textOf(transitioned).includes('SECOND_PARENT_SHARED_BODY'));
    assert.ok(textOf(transitioned).includes('CHILD_OWN_SHARED_BODY'));
    assert.ok(!textOf(transitioned).includes('PARENT_SHARED_NEW'));
    let binding = guideState('guide-child').binding;
    assert.equal(binding.initialWorkspaceDir, f.childWorkspace);
    assert.equal(binding.currentWorkspaceDir, moved);
    assert.ok(readFileSync(join(f.guideDir('guide-child'), 'child-own.md')).equals(originalOwn));
    const rejected = await otherTool('guide-child', 'unverified-transition', wrong);
    assert.match(textOf(rejected), /WORKSPACE_BINDING_CONFLICT/);
    binding = guideState('guide-child').binding;
    assert.equal(binding.currentWorkspaceDir, moved);
    assert.equal(existsSync(join(wrong, 'agent-state')), false);
  });

  await t.test('native guide receipt recovery resolves an expired pending journal without repeating its durable write', async () => {
    f.nativeSession('guide-receipts');
    const args = { title: 'Recovered original', body: 'RECOVERED_GUIDE_ORIGINAL' };
    const original = await f.invoke('guide-receipts', 'guide-receipt', note, args, { id: 'guide-stable-call' });
    assert.match(textOf(original), /status=committed/);
    const raw = structuredClone(rawResult(original));
    const journalPath = join(f.guideDir('guide-receipts'), '.agent-state.json');
    const journal = readJson(journalPath), entry = journal.operations[0];
    const noteId = entry.outcome.note_id, file = join(f.guideDir('guide-receipts'), noteId), bytes = readFileSync(file);
    // Recreate the exact interrupted-after-file-write journal shape using the
    // real operation identity and original file digest, then age that receipt.
    entry.state = 'pending'; entry.note_id = noteId;
    entry.beforeDigest = null; entry.beforeMissing = true;
    entry.intendedDigest = createHash('sha256').update(bytes).digest('hex');
    entry.createdAt = Date.now() - 120000;
    delete entry.outcome; delete entry.completedAt;
    raw.details.mcp.structuredContent.createdAt = entry.createdAt;
    writeFileSync(journalPath, JSON.stringify(journal) + '\n');
    const replayed = await repeatPost('guide-receipts', 'guide-receipt', note, args, raw, 'guide-stable-call');
    assert.match(textOf(replayed), /status=committed/);
    assert.match(textOf(replayed), /recorded outcome/);
    assert.ok(readFileSync(file).equals(bytes));
    assert.equal(readJson(journalPath).operations[0].outcome.code, 'GUIDE_SAVE_RECOVERED');
    assert.deepEqual(readdirSync(f.guideDir('guide-receipts')).filter((name) => name.endsWith('.md')), [noteId]);

    f.nativeSession('guide-expired');
    const pending = await f.invoke('guide-expired', 'guide-expired', note, args, { handlers: [], id: 'guide-expired-call' });
    const expired = structuredClone(rawResult(pending));
    expired.details.mcp.structuredContent.createdAt = entry.createdAt;
    const rejected = await repeatPost('guide-expired', 'guide-expired', note, args, expired, 'guide-expired-call');
    assert.match(textOf(rejected), /RECEIPT_EXPIRED/);
    assert.doesNotMatch(textOf(rejected), /Reusable guide committed/);
    assert.equal(readdirSync(f.guideDir('guide-expired')).filter((name) => name.endsWith('.md')).length, 0);
    const missingEdit = await f.invoke('guide-expired', 'missing-guide-edit', note, { ...args, note_id: 'missing.md' });
    assert.doesNotMatch(textOf(missingEdit), /Reusable guide committed/);
    assert.equal(readdirSync(f.guideDir('guide-expired')).filter((name) => name.endsWith('.md')).length, 0);
  });

  await t.test('complete native executed results, images and thrown errors retain their every-tool reminder', async () => {
    f.nativeSession('result-preservation');
    await f.host.hooks.beginTurn(f.turn('result-preservation', 'read-start', { prompt: 'Read the requested file' }));
    const inputRevision = readJson(f.taskPath('result-preservation')).inputRevision;
    await f.invoke('result-preservation', 'read-task', set, {
      taskBody: 'Read the requested file and report the actual observation.', reason: 'Read-only task', reviewedInputRevision: inputRevision,
    });
    const picture = { type: 'image', mimeType: 'image/png', data: readFileSync(join(repo, 'plugins', 'probe-hook', 'icon.png')).toString('base64') };
    // This synthetic read executor tests the host's normal execution-error
    // branch. All plugin capability tests above use their real raw MCP schemas.
    const kind = Symbol.for('TypeBox.Kind');
    const read = { name: 'bash', parameters: { [kind]: 'Object', type: 'object', properties: {
      fail: { [kind]: 'Boolean', type: 'boolean' },
    }, required: ['fail'] }, async execute(_id, args) {
      if (args.fail) throw new Error('OFFLINE_READ_EXECUTION_FAILED');
      return { content: [{ type: 'text', text: 'ORIGINAL_READ_RESULT' }, picture], details: { untouched: true } };
    } };
    const results = await f.host.executeTools({ tools: [read] }, { role: 'assistant', content: [
      { type: 'toolCall', id: 'actual-read-ok', name: 'bash', arguments: { fail: false } },
      { type: 'toolCall', id: 'actual-read-error', name: 'bash', arguments: { fail: true } },
    ] }, { toolExecution: 'sequential', afterToolCall: (context) => f.host.afterTool({
      input: f.input('result-preservation', 'reads'), context,
    }) }, undefined, async () => {});
    assert.equal(results.messages[0].isError, false);
    assert.deepEqual(results.messages[0].content.slice(0, 2), [{ type: 'text', text: 'ORIGINAL_READ_RESULT' }, picture]);
    assert.equal(results.messages[0].details.untouched, true);
    assert.equal(results.messages[1].isError, true);
    assert.match(results.messages[1].content[0].text, /OFFLINE_READ_EXECUTION_FAILED/);
    for (const result of results.messages) f.assertReminder(result);
    noContinuation(await f.host.hooks.finishTurn(f.turn('result-preservation', 'reads')));
    assert.equal(readJson(f.taskPath('result-preservation')).reviewedInputRevision, inputRevision);
  });

  const obsoleteCheckpointPath = (id) => join(dirname(f.taskPath(id)), id, 'checkpoint.json');
  await t.test('task observations and failed extension storage leave ordinary tools and native root/child completion available', async () => {
    for (const child of [false, true]) {
      const id = child ? 'stop-child' : 'stop-root';
      f.nativeSession(id, child ? { parentSessionId: 'main-a' } : {});
      const oldBudget = '{obsolete checkpoint data is deliberately invalid';
      mkdirSync(dirname(obsoleteCheckpointPath(id)), { recursive: true });
      writeFileSync(obsoleteCheckpointPath(id), oldBudget);
      for (const phase of ['unset', 'unreviewed', 'corrupt-task', 'corrupt-guide']) {
        const turnId = `nonblocking-${phase}`;
        if (child) await f.host.hooks.startSubagent({ handlers: f.handlers, parentSessionId: 'main-a', parentTurnId: 'parent-stop',
          childSessionId: id, childTurnId: turnId, agentId: 'stop-child-instance', agentType: 'worker', cwd: f.workspaceDir, ...f.context });
        else await f.host.hooks.beginTurn(f.turn(id, turnId));
        if (child) await f.host.prepareSteering(f.input(id, turnId), {
          message: { text: `Original ${phase} user instruction` }, producerId: 'composer-steer',
          userMessageId: `${id}-${phase}`, idempotencyKey: `${id}-${phase}`,
        }, async (pending) => ({ userMessage: { text: pending.message.text }, genuineUserQueryText: pending.message.text }));
        if (phase === 'unset') assert.equal(readJson(f.taskPath(id)).taskRevision, 0);
        if (phase === 'unreviewed') {
          const saved = await f.invoke(id, `${phase}-save`, set, { taskBody: 'Preserve every applicable explicit and grounded implied requirement.' });
          assert.match(textOf(saved), /status=committed/);
          const state = readJson(f.taskPath(id));
          assert.equal(state.reviewedInputRevision, 0);
          assert.ok(state.inputRevision > 0, 'No review acknowledgment is made before proceeding');
          assert.equal(state.revisions.at(-1).reason, '', 'A plain save requires no bookkeeping rationale');
        }
        if (phase === 'corrupt-task') {
          writeFileSync(f.taskPath(id), '{broken canonical JSON');
          const failed = await f.invoke(id, `${phase}-save`, set, { taskBody: 'This cannot replace unreadable original state.' });
          assert.match(textOf(failed), /status=unavailable/);
          assert.match(textOf(failed), /TASK_STATE_INVALID/);
          assert.equal(readFileSync(f.taskPath(id), 'utf8'), '{broken canonical JSON');
        }
        if (phase === 'corrupt-guide') {
          const journal = join(f.guideDir(id), '.agent-state.json');
          mkdirSync(f.guideDir(id), { recursive: true });
          writeFileSync(journal, '{broken original guide journal');
          const failed = await f.invoke(id, `${phase}-save`, note, { title: 'An unavailable save', body: 'Verified guide content whose save must remain unresolved.' });
          assert.match(textOf(failed), /status=unavailable/);
          assert.match(textOf(failed), /GUIDE_STATE_INVALID/);
          assert.equal(readFileSync(journal, 'utf8'), '{broken original guide journal');
          assert.equal(existsSync(join(f.guideDir(id), 'an-unavailable-save.md')), false);
        }
        const next = await otherTool(id, `${turnId}-ordinary-tool`);
        assert.equal(next.isError, false);
        assert.match(textOf(next), /PROBE-MCP-DISABLED/);
        f.assertReminder(next);
        const messages = [];
        const stopped = await f.host.stopAfterTurn(f.input(id, turnId), messages,
          { stopHookActive: false, stopContinuationCount: 0, lastAssistantMessage: 'Completed offline turn' });
        assert.equal(stopped, true);
        assert.deepEqual(messages, [], `Native ${child ? 'SubagentStop' : 'Stop'} needs no bookkeeping continuation for ${phase}`);
        noContinuation(await f.host.hooks.finishTurn(f.turn(id, turnId, { stopHookActive: false })));
        assert.equal(readFileSync(obsoleteCheckpointPath(id), 'utf8'), oldBudget, 'Old checkpoint budgets remain untouched and inert');
      }
    }
    t.diagnostic('Original native tool dispatch and dJn completed with no forced follow-up for unset/unreviewed tasks and task/guide storage failures in both root and child sessions.');
  });

  await t.test('the original native model loop exits errors and aborts before any Stop hook or continuation', async () => {
    for (const child of [false, true]) for (const stopReason of ['error', 'aborted']) {
      const id = `loop-${child ? 'child' : 'root'}-${stopReason}`;
      f.nativeSession(id, child ? { parentSessionId: 'main-a' } : {});
      if (child) await f.host.hooks.startSubagent({ handlers: f.handlers, parentSessionId: 'main-a', parentTurnId: 'loop-parent',
        childSessionId: id, childTurnId: 'loop-turn', agentId: `${id}-instance`, agentType: 'worker', cwd: f.workspaceDir, ...f.context });
      else await f.host.hooks.beginTurn(f.turn(id, 'loop-turn'));
      const events = [], messages = [], result = { role: 'assistant', content: [{ type: 'text', text: `Offline ${stopReason}` }], stopReason };
      let stopCalls = 0;
      // Only the provider stream is a deterministic offline fixture. QGe's
      // turn-exit logic and the optional native Stop callback are unmodified.
      await f.host.runModelLoop({ messages: [], systemPrompt: '', tools: [] }, messages, {
        model: { provider: 'offline', id: 'boundary-fixture' }, convertToLlm: async (items) => items,
        shouldStopAfterTurn: async () => {
          stopCalls += 1;
          return f.host.stopAfterTurn(f.input(id, 'loop-turn'), [], { stopHookActive: false, stopContinuationCount: 0 });
        },
      }, new AbortController().signal, async (event) => events.push(event), async () => ({
        async *[Symbol.asyncIterator]() { yield { type: 'done' }; }, async result() { return result; },
      }));
      assert.equal(stopCalls, 0);
      assert.equal(messages.at(-1).stopReason, stopReason);
      assert.ok(events.some((event) => event.type === 'agent_end'));
      assert.equal(existsSync(obsoleteCheckpointPath(id)), false);
      if (child) {
        f.host.hooks.cancelSubagent(id);
        assert.equal(existsSync(obsoleteCheckpointPath(id)), false, 'Native cancellation does not create an extension checkpoint');
      }
    }
  });

  await t.test('native child role capability assembly exposes and invokes all four control-task operations', async () => {
    const required = ['control_task_get', 'control_task_set', 'control_task_patch', 'control_task_confirm']
      .map((name) => `mcp__control-task__${name}`);
    const roles = readdirSync(join(repo, 'agents')).sort();
    assert.equal(roles.length, 24);
    let workerTools, workerRole;
    const assemble = (parsed) => f.host.assembleCapabilities({
      config: { enabled: false }, env: {}, sessionId: 'role-child', llmModel: { provider: 'offline', id: 'role-fixture' },
      modelCapabilities: { support_image: true, support_video: true }, effectivePluginSkills: [],
      agentProfile: { surface: 'task-child', canonicalRole: parsed.name, trustedBuiltin: false, configSelection: parsed,
        capabilityCeiling: { features: { mavis: false, delegation: false, webSearch: true } } },
      sources: { nativeTools: [], mcpEntries: [], threadGoalTools: [], cuRuntimeAvailable: false },
      // An empty annotation catalog is deliberate: actual plugin loading is
      // checked above; this call tests native role filtering plus assembly.
      desktopCapabilities: { runtimeTools: f.inventory.runtimeTools, runtimeToolBindings: f.inventory.runtimeToolBindings, plugins: [] },
    });
    for (const role of roles) {
      const parsed = f.host.parseRole(readFileSync(join(repo, 'agents', role, 'agent.md'), 'utf8'), role);
      assert.deepEqual(parsed.diagnostics, []);
      const assembled = assemble(parsed);
      assert.deepEqual(assembled.tools.map((tool) => tool.def.name).filter((name) => name.startsWith('mcp__control-task__')).sort(), required.slice().sort(), role);
      if (role === 'worker') { workerTools = assembled.tools; workerRole = parsed; }
    }
    const confirm = 'mcp__control-task__control_task_confirm';
    const restricted = assemble({ ...workerRole, tools: workerRole.tools.filter((name) => name !== confirm) });
    assert.ok(!restricted.tools.some((tool) => tool.def.name === confirm), 'The native assembly applies the explicit role selector before appending plugin tools');
    f.nativeSession('role-child', { parentSessionId: 'main-a' });
    await f.host.hooks.startSubagent({ handlers: f.handlers, parentSessionId: 'main-a', parentTurnId: 'role-parent',
      childSessionId: 'role-child', childTurnId: 'role-turn', agentId: 'role-native-instance', agentType: 'worker',
      cwd: f.workspaceDir, ...f.context });
    const selected = (name) => workerTools.find((tool) => tool.def.name === name);
    await f.invoke('role-child', 'role-set', set, { taskBody: 'Original role requirement', reason: 'Original child task' }, { tool: selected(set) });
    const patch = 'mcp__control-task__control_task_patch';
    const patched = await f.invoke('role-child', 'role-patch', patch, { expectedRevision: 1,
      operations: [{ op: 'add', after: 'Original role requirement', text: 'Additional preserved role requirement' }],
      reason: 'Extend the task without losing original requirements' }, { tool: selected(patch) });
    assert.match(textOf(patched), /status=committed/);
    await f.host.prepareSteering(f.input('role-child', 'role-turn'), {
      message: { text: 'The task is unchanged; check the current original requirement.' }, producerId: 'composer-steer',
      userMessageId: 'role-steering', idempotencyKey: 'role-steering',
    }, async (pending) => ({ userMessage: { text: pending.message.text }, genuineUserQueryText: pending.message.text }));
    const revision = readJson(f.taskPath('role-child')).inputRevision;
    const confirmed = await f.invoke('role-child', 'role-confirm', confirm,
      { reviewedInputRevision: revision, reason: 'Reviewed the original raw prompt; no material task change' }, { tool: selected(confirm) });
    assert.match(textOf(confirmed), /status=committed/);
    const state = readJson(f.taskPath('role-child'));
    assert.equal(state.taskRevision, 2);
    assert.equal(state.reviewedInputRevision, revision);
    assert.equal(state.revisions.at(-1).taskBody, 'Original role requirement\nAdditional preserved role requirement');

    const skill = readFileSync(join(repo, 'skills', 'task', 'SKILL.md'), 'utf8');
    const literal = skill.match(/The durable canonical task for the session lives in `([^`]+)`/u)?.[1];
    assert.ok(literal, 'Extract the canonical task tool name from the actual shipped task skill');
    f.nativeSession('skill-role-child', { parentSessionId: 'main-a' });
    await f.host.hooks.startSubagent({ handlers: f.handlers, parentSessionId: 'main-a', parentTurnId: 'skill-parent',
      childSessionId: 'skill-role-child', childTurnId: 'skill-role-turn', agentId: 'skill-role-instance', agentType: 'worker',
      cwd: f.workspaceDir, ...f.context });
    const skillBody = 'Complete task authored through the actual task skill canonical tool reference.';
    // Supply the actual role-filtered tool assembly to native sun. An unknown
    // spelling must reach the real dispatcher, not fail an earlier fixture lookup.
    const skillResult = await f.invoke('skill-role-child', 'skill-literal-set', literal,
      { taskBody: skillBody, reason: 'Follow the shipped task skill canonical task reference' }, { availableTools: workerTools });
    assert.equal(skillResult.toolName, literal);
    assert.match(textOf(skillResult), /PENDING_HOST_COMMIT/);
    assert.match(textOf(skillResult), /status=committed/);
    assert.equal(skillResult.isError, false);
    assert.ok(textOf(skillResult).includes(skillBody));
    f.assertReminder(skillResult);
    assert.equal(readJson(f.taskPath('skill-role-child')).revisions.at(-1).taskBody, skillBody);
  });

  await t.test('packaged probe is inert by default and both real lanes activate only after complete-root reload', async () => {
    const sourceRoot = join(f.dataDir, 'plugins', 'probe-hook');
    const pluginData = join(f.dataDir, 'v2', 'plugin-data', 'hooks', 'probe-hook');
    const config = join(sourceRoot, 'probe.config.json');
    assert.deepEqual(readdirSync(pluginData), [], 'Default-off hooks and MCP calls wrote no diagnostic file');
    const disabled = await otherTool('main-a', 'disabled-probe');
    assert.match(textOf(disabled), /PROBE-MCP-DISABLED/);
    assert.equal(disabled.details.mcp.structuredContent.status, 'disabled');
    assert.deepEqual(readdirSync(pluginData), []);
    const priorRoot = f.packages.find(({ plugin }) => plugin.name === 'probe-hook').plugin.hooks[0].pluginRoot;
    writeFileSync(config, '{"enabled":true}\n');
    const stillDisabled = await otherTool('main-a', 'before-probe-reload');
    assert.match(textOf(stillDisabled), /PROBE-MCP-DISABLED/, 'A running MCP process keeps its loaded configuration until reload');
    assert.equal(readJson(join(priorRoot, 'probe.config.json')).enabled, false, 'Existing immutable hook snapshot also remains unchanged');
    await f.reload();
    const reloaded = f.packages.find(({ plugin }) => plugin.name === 'probe-hook').plugin;
    assert.notEqual(reloaded.hooks[0].pluginRoot, priorRoot);
    assert.equal(readJson(join(reloaded.hooks[0].pluginRoot, 'probe.config.json')).enabled, true);
    assert.match(reloaded.skills[0].content, /PROBE-SKILL-MARKER-24680/);
    assert.ok(readFileSync(join(sourceRoot, 'skills', 'probe-skill', 'SKILL.md')).equals(readFileSync(join(repo, 'plugins', 'probe-hook', 'skills', 'probe-skill', 'SKILL.md'))));
    f.nativeSession('probe-enabled');
    const started = await f.host.hooks.beginTurn(f.turn('probe-enabled', 'probe-start'));
    assert.match(started.decision.additionalContext, /PROBE-HOOK-CONTEXT-MARKER-12345/);
    f.assertBodies(started.decision.additionalContext);
    const sentinel = 'OFFLINE_SECRET_SENTINEL_NEVER_LOG_THIS';
    const result = await f.invoke('probe-enabled', 'enabled-echo', echo, { text: sentinel });
    assert.match(textOf(result), /PROBE-MCP-TOOL-OK/);
    assert.equal(result.details.mcp.structuredContent.echo, sentinel);
    assert.equal(result.details.mcp.structuredContent.literalEnv, true);
    assert.equal(result.details.mcp.structuredContent.expandedEnvLiteral, true, 'The intentionally literal ${PLUGIN_DATA} probe is preserved');
    assert.equal(result.details.mcp.structuredContent.stateFile, join(pluginData, 'tool-calls.log'));
    const hookLog = join(pluginData, 'probe.log'), toolLog = join(pluginData, 'tool-calls.log');
    for (const path of [hookLog, toolLog]) {
      assert.ok(statSync(path).size > 0);
      assert.ok(!readFileSync(path, 'utf8').includes(sentinel));
      for (const line of readFileSync(path, 'utf8').trim().split('\n')) assert.ok(Buffer.byteLength(line + '\n') <= 512);
    }
    const server = [...f.runtime.servers].find(([, entry]) => entry.pluginName === 'probe-hook')[0];
    const beforeUnknown = readFileSync(toolLog);
    await assert.rejects(f.runtime.pool.callTool(server, 'unknown_probe_tool', { text: sentinel }), /MCP error -32602: Unknown or missing tool name\./);
    assert.ok(readFileSync(toolLog).equals(beforeUnknown));
    // Exercise actual append rotation through qN, then an actual regular-file
    // failure. Only disposable fixture log paths are altered.
    writeFileSync(toolLog, '{}\n'.repeat(Math.floor(128 * 1024 / 3)));
    const rotated = await f.invoke('probe-enabled', 'probe-rotate', echo, { text: 'Rotation metadata only' });
    assert.match(textOf(rotated), /PROBE-MCP-TOOL-OK/);
    assert.ok(statSync(`${toolLog}.previous`).size <= 128 * 1024);
    assert.ok(statSync(toolLog).size <= 512);
    rmSync(toolLog); mkdirSync(toolLog);
    const failed = await f.invoke('probe-enabled', 'probe-write-failure', echo, { text: sentinel });
    assert.equal(failed.details.mcp.isError, true);
    assert.equal(failed.details.mcp.structuredContent.status, 'unavailable');
    assert.match(textOf(failed), /PROBE-MCP-TOOL-FAILED/);
    assert.doesNotMatch(textOf(failed), /PROBE-MCP-TOOL-OK/);
    f.assertReminder(failed);
    rmSync(hookLog); mkdirSync(hookLog);
    const noMarker = await f.host.prepareSteering(f.input('probe-enabled', 'probe-failed-hook'), {
      message: { text: sentinel }, producerId: 'composer-steer', userMessageId: 'probe-failed-message', idempotencyKey: 'probe-failed-message',
    }, async (pending) => ({ userMessage: { text: pending.message.text }, genuineUserQueryText: pending.message.text }));
    assert.ok(!textOf(noMarker.message).includes('PROBE-HOOK-CONTEXT-MARKER-12345'));
    rmSync(toolLog, { recursive: true }); rmSync(hookLog, { recursive: true });
    const probeHandlers = f.handlers.filter((hook) => hook.pluginName === 'probe-hook');
    noContinuation(await f.host.hooks.finishTurn(f.turn('probe-enabled', 'probe-stop', { handlers: probeHandlers })));
    await f.host.hooks.startSubagent({ handlers: probeHandlers, parentSessionId: 'probe-enabled', parentTurnId: 'probe-parent',
      childSessionId: 'probe-child', childTurnId: 'probe-child-turn', agentId: 'probe-child-instance', agentType: 'worker',
      cwd: f.workspaceDir, ...f.context });
    noContinuation(await f.host.hooks.finishTurn(f.turn('probe-child', 'probe-child-turn')));
    noContinuation(await f.host.hooks.finishTurn(f.turn('stop-root', 'enabled-with-corrupt-task')));
    const logBytes = readFileSync(hookLog);
    writeFileSync(config, '{"enabled":"yes"}\n');
    await f.reload();
    const invalid = await f.invoke('probe-enabled', 'invalid-probe-config', echo, { text: sentinel });
    assert.match(textOf(invalid), /PROBE-MCP-DISABLED/);
    assert.equal(existsSync(toolLog), false);
    assert.ok(readFileSync(hookLog).equals(logBytes), 'Invalid configuration cannot enable either diagnostic writer');
    t.diagnostic('Actual probe reload changed both cached hook configuration and the stdio process; enabled echo/log writes, rotation and write failures were inspected.');
  });
});
