// Constructed offline fixtures for extension behavior tests. These helpers do
// NOT run the native host, prove native projection, or replace host integration.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
if (!process.versions.bun) throw new Error('Run ordinary extension tests with bun scripts/test.mjs.');
export const bunBinary = process.execPath;

export function makeFixture(t, plugin, { pluginRoot = join(repositoryRoot, 'plugins', plugin) } = {}) {
  const root = mkdtempSync(join(tmpdir(), `mcode-${plugin}-test-`));
  const dataDir = join(root, 'data');
  const workspaceDir = join(root, 'workspace');
  const home = join(root, 'home');
  for (const directory of [dataDir, workspaceDir, home]) mkdirSync(directory, { recursive: true });
  t?.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, dataDir, workspaceDir, pluginRoot,
    pluginDataDir: join(dataDir, 'v2', 'plugin-data', 'hooks', plugin),
    env: { PATH: `${dirname(bunBinary)}:/usr/bin:/bin`, HOME: home, LANG: 'C.UTF-8',
      MINIMAX_DATA_DIR: dataDir, PLUGIN_ROOT: pluginRoot,
      PLUGIN_DATA: join(dataDir, 'v2', 'plugin-data', 'hooks', plugin),
      MINIMAX_PROJECT_DIR: workspaceDir } };
}

export function runScript(script, input, { env, cwd, timeout = 12000, args = [] } = {}) {
  if (!env) throw new Error('An isolated fixture environment is required.');
  return new Promise((resolve, reject) => {
    const child = spawn(bunBinary, [script, ...args], {
      cwd, env, stdio: ['pipe', 'pipe', 'pipe'], timeout, killSignal: 'SIGKILL',
    });
    const stdout = [];
    const stderr = [];
    let total = 0;
    child.stdout.on('data', bytes => {
      total += bytes.length;
      if (total > 4 * 1024 * 1024) { child.kill('SIGKILL'); reject(new Error('Fixture output exceeds 4 MiB.')); }
      else stdout.push(bytes);
    });
    child.stderr.on('data', bytes => { if (Buffer.concat(stderr).length < 1024 * 1024) stderr.push(bytes); });
    child.once('error', reject);
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.once('close', (code, signal) => resolve({ code, signal,
      stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
    child.stdin.end(input);
  });
}

export async function runMcp(script, messages, options) {
  const input = typeof messages === 'string' || Buffer.isBuffer(messages) ? messages :
    messages.map(message => JSON.stringify(message)).join('\n') + '\n';
  const execution = await runScript(script, input, options);
  const responses = execution.stdout.trim() ? execution.stdout.trim().split('\n').map(line => JSON.parse(line)) : [];
  return { ...execution, responses };
}

export async function mcpCall(script, name, args, options) {
  const execution = await runMcp(script, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'offline-fixture', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
  ], options);
  const response = execution.responses.find(item => item.id === 2);
  return { ...execution, response, result: response?.result };
}

export async function runHook(script, payload, options) {
  const execution = await runScript(script, typeof payload === 'string' || Buffer.isBuffer(payload)
    ? payload : JSON.stringify(payload), options);
  const envelopes = execution.stdout.trim() ? execution.stdout.trim().split('\n').map(line => JSON.parse(line)) : [];
  return { ...execution, envelopes, envelope: envelopes[0],
    context: envelopes.map(value => value.hookSpecificOutput?.additionalContext ?? '').join('\n') };
}

/** Explicit constructed projection, NOT evidence of the native host adapter. */
export function postToolPayload({ plugin, server = plugin, operation, args, result, cwd,
  sessionId = 'session-a', turnId = 'turn-a', toolUseId = 'tool-a', agentId, agentType }) {
  return { hook_event_name: 'PostToolUse', session_id: sessionId, turn_id: turnId, tool_use_id: toolUseId,
    cwd, tool_name: `mcp__${server}__${operation}`, tool_input: args,
    tool_response: { content: result.content, details: { plugin, server, tool: operation,
      mcp: { ...result, isError: result.isError ?? false } } },
    ...(agentId ? { agent_id: agentId, agent_type: agentType } : {}) };
}

/** Minimal constructed schema; native tests separately use checksum-pinned DDL. */
export async function writeNativeSessions(dataDir, rows) {
  const { DatabaseSync } = await import('node:sqlite');
  const directory = join(dataDir, 'v2', 'sqlite');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'runtime-state.sqlite');
  const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS local_runtime_sessions (
      session_id TEXT PRIMARY KEY, parent_session_id TEXT, workspace_dir TEXT,
      agent_name TEXT, created_at_ms INTEGER, history_relative_dir TEXT, columnar_version INTEGER,
      record_json TEXT
    )`);
    const insert = db.prepare('INSERT OR REPLACE INTO local_runtime_sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const row of rows) insert.run(row.sessionId, row.parentSessionId ?? null, row.workspaceDir,
      row.agentName ?? 'fixture-agent', row.createdAtMs ?? 1767225600000,
      row.historyRelativeDir ?? null, row.columnarVersion ?? 3,
      row.recordJson ?? '{"agentName":"__local_runtime_v2__"}');
  } finally { db.close(); }
  return path;
}
