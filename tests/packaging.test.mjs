import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  makeFixture, repositoryRoot, runMcp, runHook, postToolPayload, writeNativeSessions,
} from './helpers/runtime-fixture.mjs';

const pluginNames = ['agent-state', 'control-task', 'injection-rules', 'probe-hook'];
const runtimeModules = ['host.mjs', 'storage.mjs', 'transport.mjs'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = path => JSON.parse(fs.readFileSync(path, 'utf8'));

function inside(root, path) {
  const absolute = resolve(root, path);
  assert.ok(absolute.startsWith(`${resolve(root)}${sep}`), `package-relative path escaped: ${path}`);
  assert.ok(fs.lstatSync(absolute).isFile() && !fs.lstatSync(absolute).isSymbolicLink(), `packaged entry must be a regular file: ${path}`);
  return absolute;
}

function hookScript(root, manifest, event) {
  const handlers = manifest.hooks.flatMap(path => readJson(inside(root, path)).hooks[event] ?? [])
    .flatMap(entry => entry.hooks);
  assert.equal(handlers.length, 1, `one packaged ${event} entrypoint`);
  assert.equal(handlers[0].type, 'command');
  assert.equal(handlers[0].timeout, 5);
  const match = /^node "\$\{PLUGIN_ROOT\}\/(scripts\/[^"\s]+\.mjs)"$/.exec(handlers[0].command);
  assert.ok(match, 'the declared native command must resolve entirely inside this package');
  return inside(root, match[1]);
}

test('exactly the four original installable roots include current runtime copies and the unchanged probe skill', () => {
  const directories = fs.readdirSync(join(repositoryRoot, 'plugins'), { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  assert.deepEqual(directories, pluginNames);
  const manifests = [];
  const walk = path => {
    for (const entry of fs.readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'plugin.json' && dirname(full).endsWith(`${sep}.minimax-plugin`)) manifests.push(relative(repositoryRoot, full));
    }
  };
  walk(join(repositoryRoot, 'plugins'));
  assert.deepEqual(manifests.sort(), pluginNames.map(name => join('plugins', name, '.minimax-plugin/plugin.json')));
  for (const plugin of pluginNames) {
    const root = join(repositoryRoot, 'plugins', plugin);
    const manifest = readJson(join(root, '.minimax-plugin/plugin.json'));
    assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.name, plugin);
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
    for (const path of [...manifest.hooks, ...manifest.mcpServers, ...manifest.skills]) inside(root, path);
    if (plugin === 'injection-rules') {
      assert.equal(fs.existsSync(join(root, 'scripts/runtime')), false);
    } else for (const module of runtimeModules) {
      assert.deepEqual(fs.readFileSync(join(root, 'scripts/runtime', module)), fs.readFileSync(join(repositoryRoot, 'runtime', module)), `${plugin}/${module} must equal its canonical source`);
    }
  }
  assert.equal(digest(fs.readFileSync(join(repositoryRoot, 'plugins/probe-hook/skills/probe-skill/SKILL.md'))),
    'b7b45f54bf1dd8ca7a695e44e7c6d20bf63685ee7ea104ca6b30cb5f07c90623', 'the literal loader probe skill is intentionally unchanged');
  assert.deepEqual(readJson(join(repositoryRoot, 'plugins/probe-hook/probe.config.json')), { enabled: false });
});

for (const plugin of pluginNames) test(`standalone copied ${plugin} resolves its actual MCP and hook entrypoints without repository siblings`, async t => {
  const fixture = makeFixture(t, plugin);
  const root = join(fixture.root, 'installed-package');
  fs.cpSync(join(repositoryRoot, 'plugins', plugin), root, { recursive: true });
  fixture.env.PLUGIN_ROOT = root;
  // The legacy rule reader calls os.homedir(). Pin it to this fixture so no
  // actual user rule directory participates in a standalone-package check.
  const preload = join(fixture.root, 'isolated-home.cjs');
  fs.writeFileSync(preload, "require('node:os').homedir=()=>process.env.MCODE_FIXTURE_HOME;require('node:module').syncBuiltinESMExports();\n");
  fixture.env.MCODE_FIXTURE_HOME = fixture.env.HOME;
  fixture.env.NODE_OPTIONS = `--require=${preload}`;
  fs.mkdirSync(join(fixture.env.HOME, '.minimax/rules'), { recursive: true });
  fs.cpSync(join(repositoryRoot, 'rules'), join(fixture.env.HOME, '.minimax/rules'), { recursive: true });
  const manifest = readJson(join(root, '.minimax-plugin/plugin.json'));
  const options = { env: fixture.env, cwd: fixture.workspaceDir };
  const sessionId = 'packaged-session';
  let operation;
  let args;
  let result;
  for (const configFile of manifest.mcpServers) {
    const config = readJson(inside(root, configFile));
    assert.equal(config.schemaVersion, 1);
    assert.equal(Object.keys(config.mcpServers).length, 1);
    const [serverName, server] = Object.entries(config.mcpServers)[0];
    assert.equal(server.type, 'stdio'); assert.equal(server.command, 'node');
    assert.equal(server.args.length, 1);
    const script = inside(root, server.args[0]);
    operation = plugin === 'control-task' ? 'control_task_set' : plugin === 'agent-state' ? 'agent_state_note' : 'probe_echo';
    args = plugin === 'control-task' ? { taskBody: 'Complete packaged task remains available.', reason: 'standalone package check' } :
      plugin === 'agent-state' ? { title: 'Standalone guide', body: 'Preserve the complete package when updating an installed plugin.' } : { text: 'packaged probe' };
    const execution = await runMcp(script, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'standalone-fixture', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: operation, arguments: args } },
    ], { ...options, env: { ...fixture.env, ...server.env } });
    assert.equal(execution.code, 0, execution.stderr);
    assert.equal(execution.responses.find(response => response.id === 1).result.serverInfo.version, manifest.version);
    const tools = execution.responses.find(response => response.id === 2).result.tools;
    assert.ok(tools.some(tool => tool.name === operation));
    assert.ok(tools.every(tool => tool.inputSchema.type === 'object' && tool.inputSchema.additionalProperties === false));
    result = execution.responses.find(response => response.id === 3).result;
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.status, plugin === 'probe-hook' ? 'disabled' : 'pending_host_commit');
    assert.equal(fs.existsSync(fixture.pluginDataDir), false, 'MCP discovery/call alone creates no session or disabled-probe state');
    assert.equal(serverName, plugin === 'probe-hook' ? 'probe' : plugin);
  }
  if (plugin === 'control-task' || plugin === 'agent-state') {
    await writeNativeSessions(fixture.dataDir, [{ sessionId, workspaceDir: fixture.workspaceDir }]);
    const emitted = await runHook(hookScript(root, manifest, 'PostToolUse'), postToolPayload({
      plugin, operation, args, result, sessionId, cwd: fixture.workspaceDir,
    }), options);
    assert.equal(emitted.code, 0, emitted.stderr); assert.match(emitted.context, /status=committed/);
    const path = plugin === 'control-task'
      ? join(fixture.pluginDataDir, 'control-task/sessions', `${sessionId}.json`)
      : join(fixture.pluginDataDir, 'agent-state/sessions', sessionId, 'standalone-guide.md');
    const bytes = fs.readFileSync(path, 'utf8');
    assert.ok(bytes.includes(plugin === 'control-task' ? args.taskBody : args.body));
    const restored = await runHook(hookScript(root, manifest, 'SessionStart'), {
      hook_event_name: 'SessionStart', source: 'resume', session_id: sessionId, cwd: fixture.workspaceDir,
    }, options);
    assert.equal(restored.code, 0, restored.stderr);
    assert.ok(restored.context.includes(plugin === 'control-task' ? args.taskBody : args.body));
  } else {
    const emitted = await runHook(hookScript(root, manifest, 'SessionStart'), {
      hook_event_name: 'SessionStart', source: 'startup', session_id: sessionId, cwd: fixture.workspaceDir,
    }, options);
    assert.equal(emitted.code, 0, emitted.stderr);
    if (plugin === 'probe-hook') {
      assert.equal(emitted.stdout, ''); assert.equal(fs.existsSync(fixture.pluginDataDir), false);
    } else {
      const poison = readJson(join(repositoryRoot, 'rules/70-reasoning-poison.json'));
      assert.ok(emitted.context.includes(poison.body));
      const after = await runHook(hookScript(root, manifest, 'PostToolUse'), {
        hook_event_name: 'PostToolUse', session_id: sessionId, cwd: fixture.workspaceDir,
        turn_id: 'packaged-turn', tool_use_id: 'packaged-tool', tool_name: 'bash',
        tool_input: {}, tool_response: { content: [{ type: 'text', text: 'original execution error' }], isError: true },
      }, options);
      assert.equal(after.code, 0, after.stderr); assert.ok(after.context.includes(poison.remind.suffix));
    }
  }
});

// These hashes pin only the pre-existing non-control tool profiles. Prompt,
// description and model wording remain outside a capability regression check.
const roleProfiles = [
  { roles: ['architect', 'constitution-reviewer', 'critic', 'design-product-validator', 'design-researcher',
    'design-worker', 'escalation-advisor', 'implementation-critic', 'oracle', 'planner', 'probe-role',
    'researcher', 'reviewer', 'task-researcher', 'teamlead', 'worker'],
  hash: '299426802f8d5578b25c6bcdad3e19abf5f471b9d828deea25431e331bbc9483' },
  { roles: ['auditor', 'delegate', 'design-critic', 'design-verifier', 'evidence-auditor'],
    hash: 'a9d2aa8d4612fd16fbdfbd2de7b635093a48ce310c132df00c5cc1714ef03475' },
  { roles: ['preplan-auditor', 'product-validator', 'scout'],
    hash: '392e77bcecbfe0fa391e76fe87010b9ead5a49f4056c30b861d1edfca0ebb59c' },
];

test('all 24 existing role allowlists expose exact get/set/patch/confirm without unrelated capability changes', () => {
  const names = fs.readdirSync(join(repositoryRoot, 'agents'), { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  assert.deepEqual(names, roleProfiles.flatMap(profile => profile.roles).sort());
  for (const name of names) {
    const text = fs.readFileSync(join(repositoryRoot, 'agents', name, 'agent.md'), 'utf8');
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(text)?.[1];
    assert.ok(frontmatter, `${name}: actual YAML frontmatter`);
    const field = /(?:^|\n)tools:\n((?:  - [^\n]+\n?)+)/.exec(frontmatter)?.[1];
    assert.ok(field, `${name}: explicit tools allowlist`);
    const tools = field.trimEnd().split('\n').map(line => line.slice(4));
    assert.equal(new Set(tools).size, tools.length, `${name}: no duplicate tools`);
    assert.deepEqual(tools.filter(tool => tool.startsWith('mcp__control-task__')), [
      'mcp__control-task__control_task_get', 'mcp__control-task__control_task_set',
      'mcp__control-task__control_task_patch', 'mcp__control-task__control_task_confirm',
    ]);
    const otherTools = tools.filter(tool => !tool.startsWith('mcp__control-task__'));
    assert.equal(digest(`${otherTools.join('\n')}\n`), roleProfiles.find(profile => profile.roles.includes(name)).hash,
      `${name}: non-control capability profile must remain unchanged`);
  }
});

function documentedShellBlock(marker) {
  const readme = fs.readFileSync(join(repositoryRoot, 'README.md'), 'utf8');
  const block = new RegExp(`<!-- ${marker} -->\\s*\x60\x60\x60sh\\n([\\s\\S]*?)\\n\x60\x60\x60`).exec(readme)?.[1];
  assert.ok(block, `documented ${marker} command block exists`);
  return block;
}

test('documented complete-root upgrade preserves existing MCP/config/credentials and durable data', t => {
  const fixture = makeFixture(t, 'control-task');
  const sentinels = {
    'mcp.json': '{"mcpServers":{"existing":{"command":"synthetic-existing-server"}}}',
    'config.yaml': 'synthetic: existing-configuration\n',
    'auth.json': '{"token":"SYNTHETIC_CREDENTIAL_SENTINEL"}',
    'permission.json': '{"synthetic":"existing-permission-policy"}',
    'AGENTS.md': 'Existing machine instructions retained in backup.\n',
    'plugins/custom-plugin/local.txt': 'Existing unrelated plugin file.\n',
    'v2/plugin-data/hooks/control-task/control-task/sessions/preserved.json': '{"sessionId":"preserved","taskBody":"Keep this original task","updatedAt":"2026-01-01T00:00:00.000Z"}',
    'v2/plugin-data/hooks/agent-state/agent-state/sessions/preserved/original.md': '# Original retained guide\n',
  };
  for (const [path, text] of Object.entries(sentinels)) {
    fs.mkdirSync(dirname(join(fixture.dataDir, path)), { recursive: true }); fs.writeFileSync(join(fixture.dataDir, path), text);
  }
  const executed = spawnSync('/bin/sh', ['-c', documentedShellBlock('install-upgrade')], {
    cwd: repositoryRoot, env: fixture.env, encoding: 'utf8', timeout: 12000,
  });
  assert.equal(executed.status, 0, executed.stderr);
  for (const [path, text] of Object.entries(sentinels)) {
    if (path === 'AGENTS.md') continue;
    assert.equal(fs.readFileSync(join(fixture.dataDir, path), 'utf8'), text, `existing ${path} preserved`);
  }
  const backup = fs.readdirSync(join(fixture.dataDir, 'extension-backups'));
  assert.equal(backup.length, 1);
  assert.equal(fs.readFileSync(join(fixture.dataDir, 'extension-backups', backup[0], 'AGENTS.md'), 'utf8'), sentinels['AGENTS.md']);
  for (const plugin of pluginNames) {
    assert.deepEqual(fs.readFileSync(join(fixture.dataDir, 'plugins', plugin, '.minimax-plugin/plugin.json')),
      fs.readFileSync(join(repositoryRoot, 'plugins', plugin, '.minimax-plugin/plugin.json')));
    if (plugin !== 'injection-rules') for (const module of runtimeModules) {
      assert.deepEqual(fs.readFileSync(join(fixture.dataDir, 'plugins', plugin, 'scripts/runtime', module)), fs.readFileSync(join(repositoryRoot, 'runtime', module)));
    }
  }
  for (const name of roleProfiles.flatMap(profile => profile.roles)) assert.deepEqual(
    fs.readFileSync(join(fixture.dataDir, 'agents', name, 'agent.md')), fs.readFileSync(join(repositoryRoot, 'agents', name, 'agent.md')));
  assert.deepEqual(fs.readFileSync(join(fixture.env.HOME, '.minimax/rules/70-reasoning-poison.json')),
    fs.readFileSync(join(repositoryRoot, 'rules/70-reasoning-poison.json')));
  assert.ok(fs.existsSync(join(fixture.dataDir, 'skills/task/SKILL.md')));
  assert.deepEqual(readJson(join(fixture.dataDir, 'plugins/probe-hook/probe.config.json')), { enabled: false });
});

test('documented fresh MCP initialization exclusively creates a reviewed template and refuses overwrite', t => {
  const fixture = makeFixture(t, 'probe-hook');
  const block = documentedShellBlock('fresh-mcp-config');
  const options = { cwd: repositoryRoot, env: fixture.env, encoding: 'utf8', timeout: 12000 };
  const first = spawnSync('/bin/sh', ['-c', block], options);
  assert.equal(first.status, 0, first.stderr);
  const path = join(fixture.dataDir, 'mcp.json');
  const original = fs.readFileSync(path);
  assert.ok(Object.keys(JSON.parse(original).mcpServers).length > 0);
  assert.equal(original.includes('<HOME>'), false);
  const second = spawnSync('/bin/sh', ['-c', block], options);
  assert.notEqual(second.status, 0); assert.match(second.stderr, /EEXIST/);
  assert.deepEqual(fs.readFileSync(path), original);
});
