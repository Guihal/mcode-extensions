import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { makeFixture, repositoryRoot, mcpCall, runHook, runMcp } from './helpers/runtime-fixture.mjs';

function copiedProbe(t, enabled) {
  const fixture = makeFixture(t, 'probe-hook');
  fixture.pluginRoot = join(fixture.root, 'installed-probe-hook');
  fs.cpSync(join(repositoryRoot, 'plugins/probe-hook'), fixture.pluginRoot, { recursive: true });
  fixture.env.PLUGIN_ROOT = fixture.pluginRoot;
  if (enabled !== undefined) fs.writeFileSync(join(fixture.pluginRoot, 'probe.config.json'), JSON.stringify({ enabled }));
  fixture.mcp = join(fixture.pluginRoot, 'scripts/mcp-probe.mjs');
  fixture.hook = join(fixture.pluginRoot, 'scripts/hook.mjs');
  fixture.payload = { hook_event_name: 'UserPromptSubmit', session_id: 'probe-session', turn_id: 'probe-turn',
    cwd: fixture.workspaceDir, prompt: 'SECRET_PROMPT_SENTINEL' };
  return fixture;
}

test('shipped probe configuration disables both lanes without diagnostic files even with arbitrary env switches', async t => {
  const fixture = copiedProbe(t);
  const options = { env: { ...fixture.env, MINIMAX_PROBE_ENABLED: '1', PROBE_ENABLED: 'true' }, cwd: fixture.workspaceDir };
  const call = await mcpCall(fixture.mcp, 'probe_echo', { text: 'SECRET_ECHO_SENTINEL' }, options);
  const hook = await runHook(fixture.hook, fixture.payload, options);
  assert.equal(call.code, 0, call.stderr); assert.equal(hook.code, 0, hook.stderr);
  assert.equal(call.result.structuredContent.status, 'disabled');
  assert.match(call.result.content[0].text, /PROBE-MCP-DISABLED/); assert.equal(hook.stdout, '');
  assert.match(hook.stderr, /PROBE_CONFIG_DISABLED/);
  assert.equal(fs.existsSync(fixture.pluginDataDir), false);
  assert.equal((call.stderr + hook.stderr).includes('SECRET_'), false);
});

test('one enabled packaged configuration activates MCP and projected hook lanes at the same verified data root', async t => {
  const fixture = copiedProbe(t, true);
  const mcpEnv = { ...fixture.env, PROBE_LITERAL: 'literal-ok', PROBE_EXPANDED: '${PLUGIN_DATA}' };
  delete mcpEnv.PLUGIN_DATA;
  const hookEnv = { ...fixture.env }; delete hookEnv.MINIMAX_DATA_DIR;
  const text = 'Quoted "echo" 😀\nSECRET_ECHO_SENTINEL';
  const call = await mcpCall(fixture.mcp, 'probe_echo', { text }, { env: mcpEnv, cwd: fixture.root });
  assert.equal(call.code, 0, call.stderr); assert.equal(call.result.isError, undefined);
  assert.equal(call.result.structuredContent.status, 'committed'); assert.equal(call.result.structuredContent.echo, text);
  assert.equal(call.result.structuredContent.literalEnv, true); assert.equal(call.result.structuredContent.expandedEnvLiteral, true);
  assert.equal(call.result.structuredContent.stateFile, join(fixture.pluginDataDir, 'tool-calls.log'));
  assert.match(call.result.content[0].text, /PROBE-MCP-TOOL-OK/);
  const hook = await runHook(fixture.hook, fixture.payload, { env: hookEnv, cwd: fixture.workspaceDir });
  assert.equal(hook.code, 0, hook.stderr); assert.match(hook.context, /PROBE-HOOK-CONTEXT-MARKER-12345/);
  const mcpLog = fs.readFileSync(join(fixture.pluginDataDir, 'tool-calls.log'), 'utf8');
  const hookLog = fs.readFileSync(join(fixture.pluginDataDir, 'probe.log'), 'utf8');
  assert.equal(JSON.parse(mcpLog).operation, 'probe_echo'); assert.equal(JSON.parse(hookLog).sessionId, 'probe-session');
  assert.equal((mcpLog + hookLog + call.stderr + hook.stderr).includes('SECRET_'), false);
  assert.equal((mcpLog + hookLog).includes(text), false);
  assert.equal(fs.existsSync(join(fixture.root, '.minimax')), false);
  for (const line of [mcpLog, hookLog]) assert.ok(Buffer.byteLength(line) <= 512);
});

test('missing, invalid and symlinked packaged configuration remain disabled', async t => {
  for (const mode of ['missing', 'invalid', 'symlink']) {
    const fixture = copiedProbe(t, true);
    const config = join(fixture.pluginRoot, 'probe.config.json');
    if (mode === 'invalid') fs.writeFileSync(config, '{"enabled":"true"}');
    else {
      fs.unlinkSync(config);
      if (mode === 'symlink') {
        const elsewhere = join(fixture.root, 'external-config.json'); fs.writeFileSync(elsewhere, '{"enabled":true}'); fs.symlinkSync(elsewhere, config);
      }
    }
    const options = { env: fixture.env, cwd: fixture.workspaceDir };
    const call = await mcpCall(fixture.mcp, 'probe_echo', { text: 'unused' }, options);
    const hook = await runHook(fixture.hook, fixture.payload, options);
    assert.equal(call.result.structuredContent.status, 'disabled', mode);
    assert.equal(hook.stdout, '', mode); assert.equal(fs.existsSync(fixture.pluginDataDir), false, mode);
    assert.match(hook.stderr, /PROBE_CONFIG_(MISSING|INVALID|UNAVAILABLE)/);
  }
});

test('unknown tools, unknown arguments, invalid Unicode and oversized echoes reject without append', async t => {
  const fixture = copiedProbe(t, true);
  const requests = [
    ['not_probe_echo', { text: 'unexpected' }], ['probe_echo', { text: 'unexpected', sessionId: 'spoof' }],
    ['probe_echo', { text: '\ud800' }], ['probe_echo', { text: 'x'.repeat(4097) }],
  ].map(([name, args], index) => ({ jsonrpc: '2.0', id: index + 1, method: 'tools/call', params: { name, arguments: args } }));
  const call = await runMcp(fixture.mcp, requests, { env: fixture.env, cwd: fixture.workspaceDir });
  assert.equal(call.code, 0, call.stderr);
  assert.equal(call.responses.length, 4); assert.ok(call.responses.every(response => response.error));
  assert.equal(call.stdout.includes('PROBE-MCP-TOOL-OK'), false);
  assert.equal(fs.existsSync(fixture.pluginDataDir), false);
});

test('unavailable log directory returns actual MCP failure and no hook success marker', async t => {
  const fixture = copiedProbe(t, true);
  fs.mkdirSync(join(fixture.dataDir, 'v2/plugin-data/hooks'), { recursive: true });
  fs.writeFileSync(fixture.pluginDataDir, 'not a directory');
  const options = { env: fixture.env, cwd: fixture.workspaceDir };
  const call = await mcpCall(fixture.mcp, 'probe_echo', { text: 'SECRET_ECHO_SENTINEL' }, options);
  assert.equal(call.result.isError, true); assert.equal(call.result.structuredContent.status, 'unavailable');
  assert.match(call.result.content[0].text, /PROBE-MCP-TOOL-FAILED/); assert.equal(call.stdout.includes('PROBE-MCP-TOOL-OK'), false);
  const hook = await runHook(fixture.hook, fixture.payload, options);
  assert.equal(hook.stdout, ''); assert.match(hook.stderr, /UNSAFE_DIRECTORY/);
  assert.equal((call.stderr + hook.stderr).includes('SECRET_'), false);
  assert.equal(fs.readFileSync(fixture.pluginDataDir, 'utf8'), 'not a directory');
});

test('missing native roots do not guess cwd/home, and enabled stop hooks never emit continuation context', async t => {
  const fixture = copiedProbe(t, true);
  const mcpEnv = { ...fixture.env }; delete mcpEnv.MINIMAX_DATA_DIR;
  const call = await mcpCall(fixture.mcp, 'probe_echo', { text: 'root unavailable' }, { env: mcpEnv, cwd: fixture.workspaceDir });
  assert.equal(call.result.isError, true); assert.equal(call.result.structuredContent.status, 'unavailable');
  assert.equal(fs.existsSync(fixture.pluginDataDir), false);
  for (const event of ['Stop', 'SubagentStop']) {
    const hook = await runHook(fixture.hook, { ...fixture.payload, hook_event_name: event,
      stop_hook_active: false, ...(event === 'SubagentStop' ? { agent_id: 'child-instance', agent_type: 'worker' } : {}) },
    { env: fixture.env, cwd: fixture.workspaceDir });
    assert.equal(hook.code, 0, hook.stderr); assert.equal(hook.stdout, '');
  }
  const records = fs.readFileSync(join(fixture.pluginDataDir, 'probe.log'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.map(record => record.operation), ['Stop', 'SubagentStop']);
});

test('enabled probe rotates bounded metadata logs and retains the literal loader and environment probes', async t => {
  const fixture = copiedProbe(t, true);
  fs.mkdirSync(fixture.pluginDataDir, { recursive: true });
  fs.writeFileSync(join(fixture.pluginDataDir, 'tool-calls.log'), 'x'.repeat(128 * 1024 - 1));
  const call = await mcpCall(fixture.mcp, 'probe_echo', { text: 'rotation' }, { env: fixture.env, cwd: fixture.workspaceDir });
  assert.equal(call.result.structuredContent.status, 'committed');
  assert.equal(fs.statSync(join(fixture.pluginDataDir, 'tool-calls.log.previous')).size, 128 * 1024 - 1);
  assert.ok(fs.statSync(join(fixture.pluginDataDir, 'tool-calls.log')).size <= 512);
  const config = JSON.parse(fs.readFileSync(join(fixture.pluginRoot, 'probe.mcp.json'), 'utf8'));
  assert.equal(config.mcpServers.probe.env.PROBE_EXPANDED, '${PLUGIN_DATA}');
  const original = fs.readFileSync(join(repositoryRoot, 'plugins/probe-hook/skills/probe-skill/SKILL.md'));
  assert.deepEqual(fs.readFileSync(join(fixture.pluginRoot, 'skills/probe-skill/SKILL.md')), original);
  assert.match(original.toString(), /PROBE-SKILL/);
});
