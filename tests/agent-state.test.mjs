import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  makeFixture, repositoryRoot, writeNativeSessions, mcpCall, runMcp, runHook,
  runScript, postToolPayload,
} from './helpers/runtime-fixture.mjs';
import {
  validateNoteArguments, validateCheckpointArguments, validateCall,
  MAX_NOTE_BODY_BYTES, CHECKPOINT_ID, sha256Hex,
} from '../plugins/agent-state/scripts/agent-state-core.mjs';
import {
  parseHeader, collectGuides, STATE_FILENAME, INDEX_FILENAME, MAX_GUIDE_HASH_BYTES,
} from '../plugins/agent-state/scripts/agent-state-store.mjs';
import {
  buildInjection, MAX_CONTEXT_CHARS,
} from '../plugins/agent-state/scripts/agent-state-delivery.mjs';
import {
  createPendingReceipt, resolveHookIdentity, readNativeLineage,
} from '../plugins/agent-state/scripts/runtime/host.mjs';
import { withSessionLock } from '../plugins/agent-state/scripts/runtime/storage.mjs';

const script = join(repositoryRoot, 'plugins/agent-state/scripts/agent-state.mjs');
const hook = join(repositoryRoot, 'plugins/agent-state/scripts/agent-state-hook.mjs');
const options = (f) => ({ env: f.env, cwd: f.workspaceDir });
const dirFor = (f, sid = 'session-a') => join(f.pluginDataDir, 'agent-state', 'sessions', sid);
const stateFor = (f, sid = 'session-a') => JSON.parse(readFileSync(join(dirFor(f, sid), STATE_FILENAME), 'utf8'));
const notesFor = (f, sid = 'session-a') => existsSync(dirFor(f, sid)) ? readdirSync(dirFor(f, sid)).filter((name) => name.endsWith('.md')).sort() : [];
const seed = (f, sid, name, text) => { const dir = dirFor(f, sid); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, name), text); return join(dir, name); };
const lifecycle = (f, event = 'SessionStart', sid = 'session-a', extra = {}) => ({ hook_event_name: event, session_id: sid, turn_id: 'turn-a', cwd: f.workspaceDir, ...(event === 'SessionStart' ? { source: 'startup' } : {}), ...extra });
const otherTool = (f, n, extra = {}) => lifecycle(f, 'PostToolUse', 'session-a', { tool_use_id: `other-${n}`, tool_name: 'bash', tool_input: { command: 'true' }, tool_response: { content: [{ type: 'text', text: 'complete' }] }, ...extra });
async function fixture(t, rows) {
  const f = makeFixture(t, 'agent-state');
  await writeNativeSessions(f.dataDir, rows ? rows(f) : [{ sessionId: 'session-a', workspaceDir: f.workspaceDir }]);
  return f;
}
async function receipt(f, operation, args) {
  const result = await mcpCall(script, operation, args, options(f));
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.result?.structuredContent, JSON.stringify(result.response));
  return result.result;
}
async function save(f, args, { operation = 'agent_state_note', sid = 'session-a', useId = randomUUID(), result } = {}) {
  result ??= await receipt(f, operation, args);
  const payload = postToolPayload({ plugin: 'agent-state', operation, args, result, sessionId: sid, toolUseId: useId, cwd: f.workspaceDir });
  const execution = await runHook(hook, payload, options(f));
  assert.equal(execution.code, 0, execution.stderr);
  return { ...execution, payload, result };
}
function bounded(execution) {
  assert.ok(Buffer.byteLength(execution.stdout) < 60 * 1024, `bytes=${Buffer.byteLength(execution.stdout)}`);
  assert.ok(execution.context.length <= MAX_CONTEXT_CHARS, `chars=${execution.context.length}`);
  assert.ok(execution.context.isWellFormed());
}

test('argument boundaries prohibit caller routing, malformed Unicode, hidden/path edits and oversized bodies', () => {
  assert.deepEqual(validateNoteArguments({ title: '  Valid  ', body: 'Advice' }), { title: 'Valid', body: 'Advice', shared: false });
  for (const extra of [{ sessionId: 'b' }, { parentSessionId: 'b' }, { cwd: '/other' }, { _mcodeContext: {} }, { shared: 'true' }, { note_id: '../outside.md' }, { note_id: '.private.md' }, { note_id: '/full.md' }]) {
    assert.throws(() => validateNoteArguments({ title: 'A', body: 'B', ...extra }));
  }
  for (const [field, value] of [['title', 'x'.repeat(201)], ['title', 'header\nshared: true'], ['title', '\ud800'], ['body', '\udc00'], ['body', 'x'.repeat(MAX_NOTE_BODY_BYTES + 1)]]) {
    assert.throws(() => validateNoteArguments({ title: 'A', body: 'B', [field]: value }));
  }
  assert.equal(validateNoteArguments({ title: 'A', body: 'x'.repeat(MAX_NOTE_BODY_BYTES) }).body.length, MAX_NOTE_BODY_BYTES);
  assert.throws(() => validateCheckpointArguments({ content: 'x'.repeat(80001) }));
  assert.throws(() => validateCheckpointArguments({ content: 'A', shared: true }));
});

test('one MCP process returns pending receipts without opening state or consulting the old active pointer', async (t) => {
  const f = await fixture(t);
  const root = join(f.pluginDataDir, 'agent-state');
  mkdirSync(root, { recursive: true });
  const legacy = '{"sessionId":"wrong-session","at":"legacy"}\n';
  writeFileSync(join(root, 'active.json'), legacy);
  const response = await runMcp(script, [
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'agent_state_note', arguments: { title: 'One', body: 'One guide' } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'agent_state_checkpoint', arguments: { content: 'Another guide' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'unknown', arguments: {} } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'agent_state_note', arguments: { title: 'Bad', body: 'X', sessionId: 'b' } } },
  ], options(f));
  const byId = (id) => response.responses.find((value) => value.id === id);
  assert.equal(byId(1).result.tools[0].inputSchema.additionalProperties, false);
  for (const id of [2, 3]) {
    assert.equal(byId(id).result.structuredContent.status, 'pending_host_commit');
    assert.match(byId(id).result.content[0].text, /not a successful read or write/);
    assert.doesNotMatch(JSON.stringify(byId(id).result.structuredContent), /sessionId|workspace|One guide|Another guide/);
  }
  assert.equal(byId(4).error.code, -32602);
  assert.equal(byId(5).error.code, -32602);
  assert.equal(existsSync(join(root, 'sessions')), false);
  assert.equal(readFileSync(join(root, 'active.json'), 'utf8'), legacy);
});

test('real MCP save then trusted hook delivers the committed original; startup and resume no longer crash', async (t) => {
  const f = await fixture(t);
  const saved = await save(f, { title: 'Delivery test', body: '15-byte guide!!' });
  assert.match(saved.context, /status=committed/);
  assert.match(saved.context, /15-byte guide!!/);
  assert.doesNotMatch(saved.context, /INJECTION TRUNCATED/);
  assert.match(saved.stderr, /GUIDE_SAVED/);
  assert.doesNotMatch(saved.stderr, /15-byte guide!!|join is not defined/);
  const original = readFileSync(join(dirFor(f), 'delivery-test.md'), 'utf8');
  assert.match(original, /15-byte guide!!/);
  for (const source of ['startup', 'resume', 'plugin_activation']) {
    const restored = await runHook(hook, lifecycle(f, 'SessionStart', 'session-a', { source }), options(f));
    bounded(restored);
    assert.match(restored.context, /15-byte guide!!/);
    assert.doesNotMatch(restored.stderr, /ReferenceError/);
  }
  assert.equal(readFileSync(join(dirFor(f), 'delivery-test.md'), 'utf8'), original);
});

test('trusted A, B and child hook identities isolate saves while concurrent title collisions both survive', async (t) => {
  const f = await fixture(t, (f) => ['A', 'B', 'child'].map((sessionId) => ({ sessionId, workspaceDir: f.workspaceDir, ...(sessionId === 'child' ? { parentSessionId: 'A' } : {}) })));
  const calls = await Promise.all([
    save(f, { title: 'Same', body: 'A body one' }, { sid: 'A' }),
    save(f, { title: 'Same', body: 'A body two' }, { sid: 'A' }),
    save(f, { title: 'Same', body: 'B body only' }, { sid: 'B' }),
    save(f, { title: 'Same', body: 'Child body only' }, { sid: 'child' }),
  ]);
  for (const result of calls) assert.match(result.context, /status=committed/);
  assert.deepEqual(notesFor(f, 'A'), ['same-2.md', 'same.md']);
  assert.deepEqual(notesFor(f, 'B'), ['same.md']);
  assert.deepEqual(notesFor(f, 'child'), ['same.md']);
  const a = notesFor(f, 'A').map((name) => readFileSync(join(dirFor(f, 'A'), name), 'utf8')).join('\n');
  assert.match(a, /A body one/); assert.match(a, /A body two/); assert.doesNotMatch(a, /B body|Child body/);
  const restamp = await save(f, { title: 'Same', body: 'A body one' }, { sid: 'A' });
  assert.match(restamp.context, /status=committed|status=unchanged/);
  assert.equal(notesFor(f, 'A').length, 2);
});

test('exact own editing and one stable private checkpoint preserve old suffix files', async (t) => {
  const f = await fixture(t);
  await save(f, { title: 'Original', body: 'Old reusable procedure' });
  const edited = await save(f, { title: 'Different heading', body: 'New reusable procedure', note_id: 'original.md' });
  assert.match(edited.context, /file index original.md/);
  assert.deepEqual(notesFor(f), ['original.md']);
  const missing = await save(f, { title: 'Missing', body: 'Advice', note_id: 'not-here.md' });
  assert.match(missing.context, /status=rejected/);
  assert.match(missing.context, /GUIDE_NOTE_NOT_FOUND/);
  seed(f, 'session-a', CHECKPOINT_ID, 'shared: true\ntitle: Old compatibility guide\n---\nOld\n');
  const legacySuffix = 'shared: false\nlegacy suffix bytes retained\n';
  seed(f, 'session-a', 'optional-compatibility-guide-2.md', legacySuffix);
  for (const content of ['Procedure one', 'Procedure two']) {
    const result = await save(f, { content }, { operation: 'agent_state_checkpoint' });
    assert.match(result.context, /file index optional-compatibility-guide.md/);
    assert.match(readFileSync(join(dirFor(f), CHECKPOINT_ID), 'utf8'), /^shared: false\n/u);
  }
  assert.equal(readFileSync(join(dirFor(f), 'optional-compatibility-guide-2.md'), 'utf8'), legacySuffix);
  assert.equal(notesFor(f).filter((name) => name.startsWith('optional-compatibility-guide')).length, 2);
});

test('first nonblank actual sharing flag is strict; body/header lookalikes remain private', () => {
  assert.equal(parseHeader('\n shared: TRUE \ntitle: Actual\n---\nbody').shared, true);
  for (const content of ['No header\nshared: true\n', 'shared: true and other words\n', 'shared: false\nshared: true\n', '# Guide\n\nshared: true', 'title: Wrong order\nshared: true\n']) {
    assert.equal(parseHeader(content).shared, false, content);
  }
});

test('child receives own plus current immediate-parent shared guides across workspaces, never private/sibling/grandparent guides', async (t) => {
  const f = await fixture(t, (f) => [
    { sessionId: 'grandparent', workspaceDir: f.workspaceDir },
    { sessionId: 'parent', parentSessionId: 'grandparent', workspaceDir: join(f.root, 'other-workspace') },
    { sessionId: 'child', parentSessionId: 'parent', workspaceDir: f.workspaceDir },
    { sessionId: 'sibling', parentSessionId: 'parent', workspaceDir: f.workspaceDir },
    { sessionId: 'unrelated', workspaceDir: f.workspaceDir },
  ]);
  const originals = [
    ['grandparent', 'g.md', 'shared: true\nGRANDPARENT_EXCLUDED'],
    ['parent', 'public.md', 'shared: true\ntitle: Parent\n---\nPARENT_PUBLIC_INCLUDED'],
    ['parent', 'private.md', 'shared: false\nPARENT_PRIVATE_EXCLUDED'],
    ['parent', 'body.md', 'Guide body\nshared: true\nBODY_FLAG_EXCLUDED'],
    ['sibling', 's.md', 'shared: true\nSIBLING_EXCLUDED'],
    ['unrelated', 'u.md', 'shared: true\nUNRELATED_EXCLUDED'],
    ['child', 'own.md', 'LEGACY_CHILD_ORIGINAL_INCLUDED\n'],
  ];
  for (const item of originals) seed(f, ...item);
  const child = await runHook(hook, lifecycle(f, 'SubagentStart', 'child', { agent_id: 'child-role-instance', agent_type: 'worker' }), options(f));
  assert.match(child.context, /PARENT_PUBLIC_INCLUDED|LEGACY_CHILD_ORIGINAL_INCLUDED/);
  assert.match(child.context, /PARENT_PUBLIC_INCLUDED/);
  assert.match(child.context, /LEGACY_CHILD_ORIGINAL_INCLUDED/);
  assert.doesNotMatch(child.context, /GRANDPARENT_EXCLUDED|PARENT_PRIVATE_EXCLUDED|BODY_FLAG_EXCLUDED|SIBLING_EXCLUDED|UNRELATED_EXCLUDED/);
  const inheritedEdit = await save(f, { title: 'Try edit', body: 'Must not replace parent', note_id: 'public.md' }, { sid: 'child' });
  assert.match(inheritedEdit.context, /GUIDE_NOTE_NOT_FOUND/);
  for (const [sid, name, content] of originals) assert.equal(readFileSync(join(dirFor(f, sid), name), 'utf8'), content);
});

test('missing parent retains own guides with partial freshness and retries; current parent changes are respected', async (t) => {
  const f = await fixture(t, (f) => [{ sessionId: 'child', parentSessionId: 'late-parent', workspaceDir: f.workspaceDir }]);
  seed(f, 'child', 'own.md', 'CHILD_OWN_RETAINED');
  let result = await runHook(hook, lifecycle(f, 'SubagentStart', 'child'), options(f));
  assert.match(result.context, /CHILD_OWN_RETAINED/);
  assert.match(result.context, /freshness=partial/);
  assert.equal(stateFor(f, 'child').delivery.lastDigest, null);
  await writeNativeSessions(f.dataDir, [{ sessionId: 'late-parent', workspaceDir: join(f.root, 'parent-workspace') }]);
  seed(f, 'late-parent', 'public.md', 'shared: true\nLATE_PARENT_NOW_VISIBLE');
  result = await runHook(hook, lifecycle(f, 'UserPromptSubmit', 'child', { prompt: 'Continue' }), options(f));
  assert.match(result.context, /LATE_PARENT_NOW_VISIBLE/);
  assert.match(result.context, /ledger sha256=/);
  assert.equal(stateFor(f, 'child').delivery.completedOtherCalls, 0);
  await writeNativeSessions(f.dataDir, [
    { sessionId: 'new-parent', workspaceDir: f.workspaceDir },
    { sessionId: 'child', parentSessionId: 'new-parent', workspaceDir: f.workspaceDir },
  ]);
  seed(f, 'new-parent', 'new.md', 'shared: true\nCURRENT_PARENT_ONLY');
  result = await runHook(hook, lifecycle(f, 'UserPromptSubmit', 'child', { prompt: 'Continue again' }), options(f));
  assert.match(result.context, /CURRENT_PARENT_ONLY/);
  assert.doesNotMatch(result.context, /LATE_PARENT_NOW_VISIBLE/);
});

test('a later shell cwd cannot rebind the session; a matching native workspace transition preserves original identity', async (t) => {
  const f = await fixture(t);
  await save(f, { title: 'Binding', body: 'Stable session guide' });
  const nextWorkspace = join(f.root, 'next-workspace');
  mkdirSync(nextWorkspace);
  const payload = lifecycle(f, 'SessionStart', 'session-a', { source: 'resume', cwd: nextWorkspace });
  const rejected = await runHook(hook, payload, { env: f.env, cwd: nextWorkspace });
  assert.match(rejected.context, /WORKSPACE_BINDING_CONFLICT/);
  assert.equal(stateFor(f).binding.currentWorkspaceDir, f.workspaceDir);
  await writeNativeSessions(f.dataDir, [{ sessionId: 'session-a', workspaceDir: nextWorkspace }]);
  const accepted = await runHook(hook, payload, { env: f.env, cwd: nextWorkspace });
  assert.match(accepted.context, /Stable session guide/);
  assert.equal(stateFor(f).binding.initialWorkspaceDir, f.workspaceDir);
  assert.equal(stateFor(f).binding.currentWorkspaceDir, nextWorkspace);
});

test('completed OTHER tools alone advance cadence10; errors count as executed tools; own saves and prompts do not', async (t) => {
  const f = await fixture(t);
  const legacyCounter = join(f.pluginDataDir, 'agent-state', 'turns-session-a.json');
  mkdirSync(dirname(legacyCounter), { recursive: true });
  writeFileSync(legacyCounter, '{"turns":99}\n');
  await save(f, { title: 'Cadence', body: 'Unchanged corpus sentinel' });
  for (let i = 0; i < 3; i += 1) {
    await runHook(hook, lifecycle(f), options(f));
    await runHook(hook, lifecycle(f, 'UserPromptSubmit', 'session-a', { prompt: 'A prompt' }), options(f));
  }
  assert.equal(stateFor(f).delivery.completedOtherCalls, 0);
  for (let i = 1; i <= 9; i += 1) {
    const result = await runHook(hook, otherTool(f, i, i === 4 ? { tool_response: { isError: true, content: [{ type: 'text', text: 'Executed error' }] } } : {}), options(f));
    assert.doesNotMatch(result.context, /Unchanged corpus sentinel|YOU MUST SAVE IMPORTANT REUSABLE GUIDES NOW/);
  }
  assert.equal(stateFor(f).delivery.completedOtherCalls, 9);
  const failed = await save(f, { title: 'Missing', body: 'Advice', note_id: 'missing.md' });
  assert.match(failed.context, /No successful save is claimed/);
  assert.equal(stateFor(f).delivery.completedOtherCalls, 9);
  await save(f, { title: 'Cadence', body: 'Own save refresh' });
  assert.equal(stateFor(f).delivery.completedOtherCalls, 9);
  const tenth = await runHook(hook, otherTool(f, 10), options(f));
  assert.match(tenth.context, /YOU MUST SAVE IMPORTANT REUSABLE GUIDES NOW/);
  assert.doesNotMatch(tenth.context, /Own save refresh/);
  assert.equal(stateFor(f).delivery.completedOtherCalls, 0);
  const duplicate = await runHook(hook, otherTool(f, 10), options(f));
  assert.doesNotMatch(duplicate.context, /YOU MUST SAVE/);
  assert.equal(stateFor(f).delivery.completedOtherCalls, 0);
  assert.equal(readFileSync(legacyCounter, 'utf8'), '{"turns":99}\n');
});

test('successful compact restores guides and resets cadence; unsupported compact events cannot claim success', async (t) => {
  const f = await fixture(t);
  await save(f, { title: 'Compaction', body: 'Compaction original' });
  await runHook(hook, otherTool(f, 1), options(f));
  const before = stateFor(f).delivery;
  for (const event of ['PreCompact', 'PostCompact']) {
    const result = await runHook(hook, lifecycle(f, event, 'session-a', { trigger: 'auto' }), options(f));
    assert.equal(result.context, '');
    assert.equal(stateFor(f).delivery.completedOtherCalls, before.completedOtherCalls);
    assert.equal(stateFor(f).delivery.epoch, before.epoch);
  }
  const compact = await runHook(hook, lifecycle(f, 'SessionStart', 'session-a', { source: 'compact' }), options(f));
  assert.match(compact.context, /Compaction original/);
  assert.match(compact.context, /Successful compaction boundary/);
  assert.equal(stateFor(f).delivery.completedOtherCalls, 0);
  assert.equal(stateFor(f).delivery.epoch, before.epoch + 1);
});

test('same-length manual edits beyond the delivered prefix change the full digest and sharing changes refresh children', async (t) => {
  const f = await fixture(t);
  const body = 'X'.repeat(120000) + 'A';
  const file = seed(f, 'session-a', 'large.md', `shared: false\n---\n${body}`);
  const first = await runHook(hook, lifecycle(f), options(f));
  assert.match(first.context, /INJECTION TRUNCATED/);
  const digest = stateFor(f).delivery.lastDigest;
  writeFileSync(file, `shared: false\n---\n${'X'.repeat(120000)}B`);
  const second = await runHook(hook, otherTool(f, 1), options(f));
  assert.match(second.context, /File large.md/);
  assert.notEqual(stateFor(f).delivery.lastDigest, digest);
  const childId = 'digest-child';
  await writeNativeSessions(f.dataDir, [{ sessionId: childId, parentSessionId: 'session-a', workspaceDir: f.workspaceDir }]);
  await runHook(hook, lifecycle(f, 'SubagentStart', childId), options(f));
  writeFileSync(file, 'shared: true\n---\nNEWLY_SHARED_GUIDE');
  const shared = await runHook(hook, lifecycle(f, 'UserPromptSubmit', childId, { prompt: 'Continue' }), options(f));
  assert.match(shared.context, /NEWLY_SHARED_GUIDE/);
});

test('unsafe own files/directories are visible failures and cannot overwrite symlink targets', async (t) => {
  const f = await fixture(t);
  const external = join(f.root, 'outside.md');
  writeFileSync(external, 'outside original bytes');
  mkdirSync(dirFor(f), { recursive: true });
  symlinkSync(external, join(dirFor(f), 'unsafe.md'));
  const edit = await save(f, { title: 'Unsafe', body: 'Must not escape', note_id: 'unsafe.md' });
  assert.doesNotMatch(edit.context, /status=committed/);
  assert.match(edit.context, /UNSAFE_FILE|FILE_UNAVAILABLE/);
  assert.match(edit.context, /freshness=partial/);
  assert.match(edit.context, /unsafe.md/);
  assert.equal(readFileSync(external, 'utf8'), 'outside original bytes');
  const outsideDir = join(f.root, 'outside-dir');
  mkdirSync(outsideDir);
  symlinkSync(outsideDir, dirFor(f, 'symlink-session'));
  const dirSave = await save(f, { title: 'Unsafe directory', body: 'Must not escape' }, { sid: 'symlink-session' });
  assert.match(dirSave.context, /UNSAFE_DIRECTORY/);
  assert.deepEqual(readdirSync(outsideDir), []);
});

test('a busy guide session reports a matching definitive unavailable result, then saves after lock release', async (t) => {
  const f = await fixture(t);
  await withSessionLock(dirFor(f), async () => {
    const blocked = await save(f, { title: 'Busy', body: 'Must wait for the own session lock' });
    assert.match(blocked.context, /definitive operation result/);
    assert.match(blocked.context, /operation=agent_state_note receipt=[a-f0-9-]+ status=unavailable/);
    assert.match(blocked.context, /LOCK_BUSY/);
    assert.equal(notesFor(f).length, 0);
  });
  const saved = await save(f, { title: 'After release', body: 'Available again' });
  assert.match(saved.context, /status=committed/);
  assert.deepEqual(notesFor(f), ['after-release.md']);
});

test('oversized manual files retain bounded readable prefixes and never become a complete freshness digest', async (t) => {
  const f = await fixture(t);
  const file = seed(f, 'session-a', 'oversized.md', `shared: false\n---\n${'Z'.repeat(MAX_GUIDE_HASH_BYTES + 65536)}`);
  const before = readFileSync(file);
  const first = await runHook(hook, lifecycle(f), options(f));
  bounded(first);
  assert.match(first.context, /freshness=partial/);
  assert.match(first.context, /GUIDE_FILE_HASH_LIMIT/);
  assert.match(first.context, /INJECTION TRUNCATED/);
  assert.match(first.context, /oversized.md/);
  assert.equal(stateFor(f).delivery.lastDigest, null);
  const later = await runHook(hook, otherTool(f, 1), options(f));
  assert.match(later.context, /complete freshness is unavailable/);
  assert.doesNotMatch(later.context, /ledger sha256=/);
  assert.deepEqual(readFileSync(file), before);
});

test('bounded advisory titles remain valid Unicode and unverified parent files expose no private locator', async (t) => {
  const f = await fixture(t, (f) => [
    { sessionId: 'parent', workspaceDir: f.workspaceDir },
    { sessionId: 'session-a', parentSessionId: 'parent', workspaceDir: f.workspaceDir },
  ]);
  const original = `shared: false\ntitle: ${'A'.repeat(199)}🙂\n---\nMANUAL_ORIGINAL_VISIBLE`;
  seed(f, 'session-a', 'manual.md', original);
  seed(f, 'parent', 'private-locator.md', Buffer.concat([Buffer.from('shared: false\n'), Buffer.from([255])]));
  const result = await runHook(hook, lifecycle(f), options(f));
  bounded(result);
  assert.match(result.context, /MANUAL_ORIGINAL_VISIBLE/);
  assert.match(result.context, /freshness=partial/);
  assert.doesNotMatch(result.context, /private-locator.md|HOOK_OUTPUT_INVALID/);
  assert.doesNotMatch(result.stderr, /private-locator.md/);
  assert.equal(readFileSync(join(dirFor(f), 'manual.md'), 'utf8'), original);
});

test('encoded JSON envelope and domain budget hold for escaped multibyte bodies; full originals remain intact', async (t) => {
  const f = await fixture(t);
  const body = ('"\\\u0001🙂界').repeat(10000) + 'END';
  assert.ok(Buffer.byteLength(body) <= MAX_NOTE_BODY_BYTES);
  const result = await save(f, { title: 'Encoded budget', body });
  bounded(result);
  assert.match(result.context, /status=committed/);
  assert.match(result.context, /INJECTION TRUNCATED/);
  assert.match(readFileSync(join(dirFor(f), 'encoded-budget.md'), 'utf8'), /END\n$/u);
  assert.equal(readFileSync(join(dirFor(f), 'encoded-budget.md'), 'utf8').split('---\n')[1], `${body}\n`);
  const pure = buildInjection({ files: [{ name: 'small.md', path: '/tmp/small.md', origin: 'own', title: null, content: '15-byte guide!!', bytes: 15, status: 'available' }], preamble: 'Guides', indexPath: '/tmp/index.json' });
  assert.equal(pure.truncated, false);
  assert.doesNotMatch(pure.text, /TRUNCATED/);
});

test('1024 admitted guide originals and long locators fit through a durable complete index, including a tiny body budget', async (t) => {
  const f = await fixture(t, (f) => [
    { sessionId: 'parent', workspaceDir: join(f.root, 'parent-workspace') },
    { sessionId: 'session-a', parentSessionId: 'parent', workspaceDir: f.workspaceDir },
  ]);
  const paths = [];
  for (const sid of ['session-a', 'parent']) {
    for (let i = 0; i < 512; i += 1) {
      const name = `${String(i).padStart(3, '0')}-${'long-locator-'.repeat(16)}.md`;
      paths.push(seed(f, sid, name, `shared: ${sid === 'parent'}\n---\nOriginal ${sid} ${i}\n`));
    }
  }
  const result = await runHook(hook, lifecycle(f), { env: { ...f.env, AGENT_STATE_MAX_INJECT_BYTES: '1' }, cwd: f.workspaceDir });
  bounded(result);
  assert.match(result.context, /INJECTION TRUNCATED/);
  assert.match(result.context, /\.guide-locators.json/);
  const index = JSON.parse(readFileSync(join(dirFor(f), INDEX_FILENAME), 'utf8'));
  assert.equal(index.files.length, 1024);
  assert.equal(index.freshness, 'complete');
  assert.deepEqual(new Set(index.files.map((file) => file.path)), new Set(paths));
  assert.ok(Buffer.byteLength(JSON.stringify(index)) < 8 * 1024 * 1024);
  assert.equal(paths.filter((path) => existsSync(path)).length, 1024);
});

test('a committed save survives a failed derived locator-index refresh and recovers on the next boundary', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 100; i += 1) seed(f, 'session-a', `${String(i).padStart(3, '0')}-${'x'.repeat(220)}.md`, `Guide ${i}`);
  const indexPath = join(dirFor(f), INDEX_FILENAME);
  mkdirSync(indexPath);
  const result = await save(f, { title: 'Committed despite index', body: 'COMMITTED_FILE_SENTINEL' });
  assert.match(result.context, /status=committed/);
  assert.match(result.context, /delivery unavailable/);
  assert.match(readFileSync(join(dirFor(f), 'committed-despite-index.md'), 'utf8'), /COMMITTED_FILE_SENTINEL/);
  assert.equal(stateFor(f).delivery.refreshDue, true);
  rmSync(indexPath, { recursive: true });
  const retry = await runHook(hook, otherTool(f, 1), options(f));
  assert.match(retry.context, /\.guide-locators.json/);
  assert.equal(stateFor(f).delivery.refreshDue, false);
  assert.equal(JSON.parse(readFileSync(indexPath, 'utf8')).files.length, 101);
  const replay = await runHook(hook, result.payload, options(f));
  assert.match(replay.context, /recorded outcome/);
  assert.equal(notesFor(f).length, 101);
});

test('receipt provenance and argument changes are rejected without a save; matching retries are deduplicated before expiry', async (t) => {
  const f = await fixture(t);
  const args = { title: 'Receipt', body: 'Receipt original' };
  const result = await receipt(f, 'agent_state_note', args);
  const base = postToolPayload({ plugin: 'agent-state', operation: 'agent_state_note', args, result, cwd: f.workspaceDir });
  for (const mutation of [
    (p) => { p.tool_input.body = 'Replaced body'; },
    (p) => { p.tool_response.details.plugin = 'other'; },
    (p) => { p.tool_response.details.mcp.isError = true; },
    (p) => { p.tool_response.details.mcp.structuredContent.status = 'saved'; },
  ]) {
    const payload = structuredClone(base); mutation(payload);
    const execution = await runHook(hook, payload, options(f));
    assert.match(execution.context, /status=rejected/);
    assert.equal(notesFor(f).length, 0);
  }
  const saved = await runHook(hook, base, options(f));
  assert.match(saved.context, /status=committed/);
  const bytes = readFileSync(join(dirFor(f), 'receipt.md'));
  const replayed = await runHook(hook, base, options(f));
  assert.match(replayed.context, /recorded outcome/);
  assert.deepEqual(readFileSync(join(dirFor(f), 'receipt.md')), bytes);
  const changed = await receipt(f, 'agent_state_note', { title: 'Different', body: 'Other invocation' });
  const reused = postToolPayload({ plugin: 'agent-state', operation: 'agent_state_note', args: { title: 'Different', body: 'Other invocation' }, result: changed, cwd: f.workspaceDir });
  const rejected = await runHook(hook, reused, options(f));
  assert.match(rejected.context, /GUIDE_RECEIPT_REUSE_CONFLICT/);
  assert.equal(notesFor(f).length, 1);
  const expiredArgs = { title: 'Expired', body: 'Never admitted' };
  const expiredResult = createPendingReceipt('agent-state', 'agent_state_note', validateCall('agent_state_note', expiredArgs), { now: Date.now() - 120000 });
  const expired = await save(f, expiredArgs, { result: expiredResult });
  assert.match(expired.context, /RECEIPT_EXPIRED/);
  assert.match(expired.context, /says nothing about whether an earlier invocation committed/);
  assert.equal(notesFor(f).length, 1);
});

async function interruptedSave(f, point) {
  const args = { title: 'Interrupted', body: 'INTERRUPTED_ORIGINAL_RETAINED' };
  const then = Date.now() - 120000;
  const result = createPendingReceipt('agent-state', 'agent_state_note', validateCall('agent_state_note', args), { now: then });
  const payload = postToolPayload({ plugin: 'agent-state', operation: 'agent_state_note', args, result, cwd: f.workspaceDir, toolUseId: 'interrupted-use' });
  const moduleRoot = join(repositoryRoot, 'plugins/agent-state/scripts');
  const harness = join(f.root, 'interrupt-save.mjs');
  writeFileSync(harness, `import {readFileSync} from 'node:fs';\nimport {resolveHookIdentity,readNativeLineage,validatePendingReceipt} from ${JSON.stringify(pathToFileURL(join(moduleRoot, 'runtime/host.mjs')).href)};\nimport {withGuideSession,executeGuideOperation} from ${JSON.stringify(pathToFileURL(join(moduleRoot, 'agent-state-store.mjs')).href)};\nimport {TOOLS,validateCall} from ${JSON.stringify(pathToFileURL(join(moduleRoot, 'agent-state-core.mjs')).href)};\nconst {payload,point,now}=JSON.parse(readFileSync(0,'utf8'));\nconst identity=resolveHookIdentity(payload,'agent-state');\nconst lineage=await readNativeLineage(identity);\nconst request=validatePendingReceipt(payload,'agent-state',{tools:TOOLS,validateCall});\nawait withGuideSession(identity,lineage,ctx=>{const persist=ctx.persist;ctx.persist=()=>{if(point==='after-file'&&ctx.state.operations.at(-1)?.state==='completed')process.kill(process.pid,'SIGKILL');const r=persist();if(point==='after-pending'&&ctx.state.operations.at(-1)?.state==='pending')process.kill(process.pid,'SIGKILL');return r;};return executeGuideOperation(ctx,request,now);});\n`);
  const execution = await runScript(harness, JSON.stringify({ payload, point, now: then + 1 }), options(f));
  assert.equal(execution.signal, 'SIGKILL');
  assert.equal(stateFor(f).operations[0].state, 'pending');
  return { payload, result, args };
}

test('real process death before/after note replacement recovers the pending target before receipt expiry without duplicate saves', async (t) => {
  for (const point of ['after-pending', 'after-file']) {
    const f = await fixture(t);
    const interrupted = await interruptedSave(f, point);
    assert.equal(notesFor(f).length, point === 'after-file' ? 1 : 0);
    const recovered = await runHook(hook, interrupted.payload, options(f));
    assert.doesNotMatch(recovered.context, /RECEIPT_EXPIRED/);
    if (point === 'after-file') {
      assert.match(recovered.context, /status=committed/);
      assert.match(recovered.context, /INTERRUPTED_ORIGINAL_RETAINED/);
    } else assert.match(recovered.context, /interrupted save did not leave the intended file/);
    assert.equal(notesFor(f).length, point === 'after-file' ? 1 : 0);
    assert.equal(stateFor(f).operations[0].state, 'completed');
    const again = await runHook(hook, interrupted.payload, options(f));
    assert.equal(notesFor(f).length, point === 'after-file' ? 1 : 0);
    assert.doesNotMatch(again.context, /RECEIPT_EXPIRED/);
  }
});

test('an unresolved expired pending target blocks later writes and cannot be reclaimed to admit new receipts', async (t) => {
  const f = await fixture(t);
  await interruptedSave(f, 'after-file');
  writeFileSync(join(dirFor(f), 'interrupted.md'), 'MANUAL_CONFLICT_RETAINED');
  const state = stateFor(f);
  for (let i = 1; i < 1024; i += 1) state.operations.push({
    toolUseId: `old-${i}`, receiptId: randomUUID(), inputDigest: sha256Hex(`old-${i}`),
    operation: 'agent_state_note', createdAt: Date.now() - 120000, state: 'completed', completedAt: Date.now() - 119000,
    outcome: { status: 'unavailable', committed: false, code: 'PREVIOUS_FAILURE' },
  });
  writeFileSync(join(dirFor(f), STATE_FILENAME), `${JSON.stringify(state)}\n`);
  const next = await save(f, { title: 'Must wait', body: 'Cannot overwrite unresolved target' });
  assert.match(next.context, /GUIDE_PENDING_RECOVERY_REQUIRED/);
  assert.equal(stateFor(f).operations.length, 1024);
  assert.equal(stateFor(f).operations[0].state, 'pending');
  assert.deepEqual(notesFor(f), ['interrupted.md']);
  assert.equal(readFileSync(join(dirFor(f), 'interrupted.md'), 'utf8'), 'MANUAL_CONFLICT_RETAINED');
});
