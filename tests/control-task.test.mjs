import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { makeFixture, repositoryRoot, mcpCall, runMcp, runHook, postToolPayload, writeNativeSessions } from './helpers/runtime-fixture.mjs';
import { argumentDigest, createPendingReceipt, resolveHookIdentity, hookOutputByteLength } from '../plugins/control-task/scripts/runtime/host.mjs';
import * as storage from '../plugins/control-task/scripts/runtime/storage.mjs';
import { ControlTaskStore, taskPaths, STORE_LIMITS } from '../plugins/control-task/scripts/control-task-store.mjs';
import { TOOLS, validateCall, applyPatch } from '../plugins/control-task/scripts/control-task-core.mjs';
import { renderOperation, renderSnapshot } from '../plugins/control-task/scripts/control-task-render.mjs';
import { handleHook } from '../plugins/control-task/scripts/control-task-hook.mjs';

const script = join(repositoryRoot, 'plugins/control-task/scripts/control-task.mjs');
const hook = join(repositoryRoot, 'plugins/control-task/scripts/control-task-hook.mjs');
let sequence = 0;
function identity(f, sessionId = 'session-a', extra = {}) {
  return resolveHookIdentity({ hook_event_name: 'PostToolUse', session_id: sessionId, cwd: f.workspaceDir, turn_id: 'turn-a', tool_use_id: `tool-${++sequence}`, ...extra }, 'control-task', { env: f.env });
}
function state(f, sessionId = 'session-a') { return JSON.parse(readFileSync(taskPaths(identity(f, sessionId)).state, 'utf8')); }
function store(f, options = {}) {
  const { sessionId = 'session-a', identityExtra = {}, ...rest } = options;
  return new ControlTaskStore(identity(f, sessionId, identityExtra), rest);
}
async function operation(f, name, args, options = {}) {
  const instance = store(f, options);
  const receipt = createPendingReceipt('control-task', name, validateCall(name, args), { now: options.now?.() ?? Date.now() }).structuredContent;
  return { store: instance, receipt, args, ...await instance.execute(receipt, args) };
}
function capture() {
  let text = '';
  return { write(value) { text += value; }, get text() { return text; } };
}
function rpcOptions(f) { return { env: f.env, cwd: f.workspaceDir }; }
function prompt(f, text, sessionId = 'session-a', extra = {}) {
  return { hook_event_name: 'UserPromptSubmit', session_id: sessionId, turn_id: 'one-live-turn', cwd: f.workspaceDir, prompt: text, ...extra };
}
function stop(f, turnId, sessionId = 'session-a', extra = {}) {
  return { hook_event_name: 'Stop', session_id: sessionId, turn_id: turnId, cwd: f.workspaceDir, stop_hook_active: false, ...extra };
}
function inputObligation(text) {
  const policy = text.replace(/\[BEGIN VERBATIM CANONICAL TASK\][\s\S]*?\[END VERBATIM CANONICAL TASK\]/gu, '')
    .replace(/^Raw prompt text \(JSON string\):[^\n]*(?:\n|$)/gmu, '');
  for (const meaning of [
    /ОБЯЗАТЕЛЬНО ОБНОВИ ТРЕБОВАНИЯ, УСЛОВИЯ, ИЛИ ЗАДАЧУ ПОСЛЕ СООБЩЕНИЯ ПОЛЬЗОВАТЕЛЯ/u,
    /After this user message, you MUST use control_task_set\/control_task_patch to add, change or remove durable requirements/u,
    /original message adds, changes or cancels/u,
    /preserving all earlier requirements and qualifications that still apply/u,
    /grounded implied requirements with their basis/u,
    /If no durable requirement changes, no invented edit, confirmation or read is required/u,
  ]) assert.match(policy, meaning, 'The prompt hook must deliver the requirement-update obligation itself');
}
const small = { maxStateBytes: 32 * 1024, archiveThreshold: 20 * 1024, maxArchiveBytes: 32 * 1024 };

test('actual stdio discovery is stateless; direct clients receive only pending receipts', async (t) => {
  const f = makeFixture(t, 'control-task');
  const discovery = await runMcp(script, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ], rpcOptions(f));
  assert.equal(discovery.code, 0, discovery.stderr);
  assert.equal(discovery.responses[0].result.serverInfo.version, '0.2.3');
  assert.deepEqual(discovery.responses[1].result.tools.map((value) => value.name), TOOLS.map((value) => value.name));
  assert.ok(discovery.responses[1].result.tools.every((value) => value.inputSchema.additionalProperties === false));
  for (const name of ['control_task_set', 'control_task_patch', 'control_task_confirm']) {
    const tool = discovery.responses[1].result.tools.find((value) => value.name === name);
    assert.equal(tool.inputSchema.required.includes('reason'), false);
    assert.match(tool.description, /reason is optional/u);
  }
  for (const [name, args] of [['control_task_set', { taskBody: 'External client must not store this', reason: 'fixture' }], ['control_task_get', {}]]) {
    const result = await mcpCall(script, name, args, rpcOptions(f));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.result.structuredContent.status, 'pending_host_commit');
    assert.match(result.result.content[0].text, /not a successful read or write/u);
    assert.equal(Object.hasOwn(result.result.structuredContent, 'taskBody'), false);
    assert.equal(Object.hasOwn(result.result.structuredContent, 'sessionId'), false);
  }
  assert.equal(existsSync(f.pluginDataDir), false, 'MCP must not create, read or choose a session directory');
});

test('real hook processes isolate crossed A/B/child callers, survive restart, and ignore active.json', async (t) => {
  const f = makeFixture(t, 'control-task');
  for (const id of ['session-a', 'session-b']) {
    const result = await runHook(hook, { hook_event_name: 'SessionStart', session_id: id, cwd: f.workspaceDir, source: 'startup' }, rpcOptions(f));
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.context, /NOT SET/u);
  }
  const active = join(f.pluginDataDir, 'control-task/active.json');
  const oldActive = '{"sessionId":"session-b","at":"legacy-pointer-preserved"}\n';
  writeFileSync(active, oldActive);
  const calls = await Promise.all([
    ['session-a', 'ALPHA canonical'], ['session-b', 'BETA canonical'], ['child-session', 'CHILD canonical'],
  ].map(async ([sessionId, taskBody]) => {
    const args = { taskBody, reason: 'isolated concurrent caller' };
    const pending = await mcpCall(script, 'control_task_set', args, rpcOptions(f));
    const result = await runHook(hook, postToolPayload({ plugin: 'control-task', operation: 'control_task_set', args, result: pending.result, cwd: f.workspaceDir, sessionId, toolUseId: `save-${sessionId}`, ...(sessionId === 'child-session' ? { agentId: 'different-role-instance', agentType: 'worker' } : {}) }), rpcOptions(f));
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.context, /status=committed/u);
    assert.ok(result.context.includes(taskBody));
    assert.equal(state(f, sessionId).revisions.at(-1).taskBody, taskBody);
    return { sessionId, taskBody };
  }));
  assert.equal(state(f, 'child-session').binding.agentId, 'different-role-instance');
  assert.equal(readFileSync(active, 'utf8'), oldActive);
  for (const { sessionId, taskBody } of calls) {
    const get = await mcpCall(script, 'control_task_get', {}, rpcOptions(f));
    const result = await runHook(hook, postToolPayload({ plugin: 'control-task', operation: 'control_task_get', args: {}, result: get.result, cwd: f.workspaceDir, sessionId, toolUseId: `get-${sessionId}` }), rpcOptions(f));
    assert.match(result.context, /status=current/u);
    assert.ok(result.context.includes(taskBody));
    assert.equal(calls.filter((other) => result.context.includes(other.taskBody)).length, 1);
  }
});

test('whole-task set, exact no-op, anchored edits and CAS preserve durable requirements', async (t) => {
  const f = makeFixture(t, 'control-task');
  const body = '  Goal: repair café parser.\r\nConstraint: retain all explicit user conditions.\r\nPath: src/parser.ts.  ';
  const initial = await operation(f, 'control_task_set', { taskBody: body, reason: 'new task' });
  assert.equal(initial.outcome.revision, 1);
  assert.equal(initial.view.taskBody, body);
  const noop = await operation(f, 'control_task_set', { taskBody: body, reason: 'identical' });
  assert.equal(noop.outcome.status, 'unchanged');
  assert.equal(state(f).revisions.length, 1);
  const patched = await operation(f, 'control_task_patch', { expectedRevision: 1, operations: [
    { op: 'replace', match: 'Goal: repair café parser.', text: 'Goal: repair café parser and Unicode handling.' },
    { op: 'add', text: 'Acceptance: preserve the exact user-defined condition.', after: 'Constraint: retain all explicit user conditions.' },
    { op: 'remove', match: 'Path: src/parser.ts.' },
  ], reason: 'explicit added Unicode requirement' });
  assert.equal(patched.outcome.revision, 2);
  assert.match(patched.view.taskBody, /Constraint: retain all explicit user conditions\./u);
  assert.match(patched.view.taskBody, /Acceptance: preserve the exact user-defined condition\./u);
  assert.ok(!patched.view.taskBody.includes('\r'));
  const before = state(f).revisions;
  for (const args of [
    { expectedRevision: 1, operations: [{ op: 'add', text: 'stale' }], reason: 'stale revision' },
    { expectedRevision: 2, operations: [{ op: 'add', text: 'must not survive' }, { op: 'remove', match: 'missing' }], reason: 'atomic failure' },
  ]) {
    const result = await operation(f, 'control_task_patch', args);
    assert.equal(result.outcome.status, 'rejected');
    assert.deepEqual(state(f).revisions, before);
  }
  assert.equal(applyPatch('Same\n Same ', [{ op: 'remove', match: 'Same' }]).ok, false);
  assert.equal(applyPatch(body, [{ op: 'replace', match: 'Goal: repair café parser.', text: '  Goal: repair café parser.' }]).body, body, 'no-op must not normalize an existing body');
  const races = await Promise.all(['FIRST', 'SECOND'].map((text) => operation(f, 'control_task_patch', { expectedRevision: 2, operations: [{ op: 'add', text }], reason: 'concurrent CAS' })));
  assert.deepEqual(races.map((result) => result.outcome.status).sort(), ['committed', 'rejected']);
  assert.equal(state(f).taskRevision, 3);
  assert.equal(state(f).revisions.length, 3);
});

test('reason-free native calls preserve receipt arguments and no-op edits record only explicit monotone review progress', async (t) => {
  const f = makeFixture(t, 'control-task');
  const invoke = async (name, args) => {
    const originalArgs = structuredClone(args);
    assert.equal(validateCall(name, args), args);
    const pending = await mcpCall(script, name, args, rpcOptions(f));
    assert.equal(pending.code, 0, pending.stderr);
    assert.equal(pending.result.structuredContent.status, 'pending_host_commit');
    assert.equal(pending.result.structuredContent.inputDigest, argumentDigest(originalArgs));
    assert.deepEqual(args, originalArgs, 'Optional reason must not be injected into receipt-bound arguments');
    const payload = postToolPayload({ plugin: 'control-task', operation: name, args, result: pending.result,
      cwd: f.workspaceDir, toolUseId: `reason-free-${++sequence}` });
    const delivered = await runHook(hook, payload, rpcOptions(f));
    assert.equal(delivered.code, 0, delivered.stderr);
    assert.equal(delivered.envelope.decision, undefined);
    return { payload, delivered };
  };
  const taskBody = 'Goal: keep the original requirements.\nConstraint: preserve user work.';
  await runHook(hook, prompt(f, 'Keep the original requirements and preserve user work.'), rpcOptions(f));
  const initialArgs = Object.freeze({ taskBody });
  await invoke('control_task_set', initialArgs);
  assert.equal(Object.hasOwn(initialArgs, 'reason'), false);
  assert.equal(state(f).revisions[0].reason, '', 'Store an omitted optional reason only in the persisted body record');
  assert.equal(state(f).reviewedInputRevision, 0, 'Omission makes no implicit review claim');
  const originalRevisions = state(f).revisions;
  for (const text of ['Continue with the same requirements.', 'The scope and constraints still apply.']) {
    inputObligation((await runHook(hook, prompt(f, text), rpcOptions(f))).context);
  }
  const reviewedSet = await invoke('control_task_set', Object.freeze({ taskBody, reviewedInputRevision: 1 }));
  assert.match(reviewedSet.delivered.context, /status=committed[\s\S]*REVIEW_RECORDED/u);
  assert.equal(state(f).reviewedInputRevision, 1);
  assert.deepEqual(state(f).revisions, originalRevisions, 'An identical set with supplied coverage creates no body revision');
  const afterSet = readFileSync(taskPaths(identity(f)).state);
  const replay = await runHook(hook, reviewedSet.payload, rpcOptions(f));
  assert.match(replay.context, /Retained completed receipt replayed/u);
  assert.deepEqual(readFileSync(taskPaths(identity(f)).state), afterSet);
  for (const args of [{ taskBody }, { taskBody, reviewedInputRevision: 0 }]) {
    assert.match((await invoke('control_task_set', args)).delivered.context, /status=unchanged[\s\S]*IDENTICAL_TASK/u);
    assert.equal(state(f).reviewedInputRevision, 1);
  }
  const operations = [{ op: 'add', text: 'Temporary anchored line' }, { op: 'remove', match: 'Temporary anchored line' }];
  const reviewedPatch = await invoke('control_task_patch', { expectedRevision: 1, operations, reviewedInputRevision: 2 });
  assert.match(reviewedPatch.delivered.context, /status=committed[\s\S]*REVIEW_RECORDED/u);
  assert.equal(state(f).reviewedInputRevision, 2);
  assert.deepEqual(state(f).revisions, originalRevisions, 'A valid net-unchanged patch stores coverage without touching body history');
  for (const args of [{ expectedRevision: 1, operations }, { expectedRevision: 1, operations, reviewedInputRevision: 1 }]) {
    assert.match((await invoke('control_task_patch', args)).delivered.context, /status=unchanged[\s\S]*IDENTICAL_TASK/u);
    assert.equal(state(f).reviewedInputRevision, 2);
  }
  for (const [name, args, code] of [
    ['control_task_set', { taskBody, reviewedInputRevision: 4 }, 'FUTURE_INPUT_REVISION'],
    ['control_task_patch', { expectedRevision: 1, operations, reviewedInputRevision: 4 }, 'FUTURE_INPUT_REVISION'],
    ['control_task_patch', { expectedRevision: 2, operations, reviewedInputRevision: 3 }, 'STALE_TASK_REVISION'],
    ['control_task_patch', { expectedRevision: 1, operations: [{ op: 'add', text: 'Must not survive a failed later anchor' }, { op: 'remove', match: 'Missing anchor' }], reviewedInputRevision: 3 }, 'PATCH_ANCHOR'],
  ]) {
    const rejected = await invoke(name, args);
    assert.match(rejected.delivered.context, /status=rejected/u);
    assert.ok(rejected.delivered.context.includes(`code=${code}`));
    assert.equal(state(f).reviewedInputRevision, 2, 'An invalid edit cannot record review progress');
    assert.deepEqual(state(f).revisions, originalRevisions);
  }
  const confirmed = await invoke('control_task_confirm', { reviewedInputRevision: 3 });
  assert.match(confirmed.delivered.context, /status=committed/u);
  assert.equal(state(f).reviewedInputRevision, 3);
  assert.deepEqual(state(f).revisions, originalRevisions, 'Optional reason-free compatibility confirmation is metadata only');
  await runHook(hook, prompt(f, 'A later unchanged observation.'), rpcOptions(f));
  const beforeHistoricalReplay = readFileSync(taskPaths(identity(f)).state);
  const historical = await runHook(hook, reviewedSet.payload, rpcOptions(f));
  assert.match(historical.context, /current taskRevision=1, inputRevision=4, reviewedInputRevision=3/u);
  assert.deepEqual(readFileSync(taskPaths(identity(f)).state), beforeHistoricalReplay, 'An old reviewed receipt must not regress coverage or cover later input');
  assert.equal(state(f).inputRevision - state(f).reviewedInputRevision, 1);
});

test('complete requirements policy reaches discovery and hooks, and set/patch review preserves every applicable clause', async (t) => {
  const registered = JSON.parse(readFileSync(join(repositoryRoot, 'plugins/control-task/hooks/hooks.json'), 'utf8')).hooks;
  const withoutQuotedSources = (text) => text
    .replace(/\[BEGIN VERBATIM CANONICAL TASK\][\s\S]*?\[END VERBATIM CANONICAL TASK\]/gu, '')
    .replace(/^Raw prompt text \(JSON string\):[^\n]*(?:\n|$)/gmu, '');
  const contentPolicy = (text) => {
    for (const meaning of [
      /explicit requirements/u,
      /grounded (?:implicit|implied)[\s\S]{0,70}requirements with their basis and source/u,
      /constraints, result and acceptance conditions/u,
      /source-of-truth references/u,
      /inferred requirements identified as inferences/u,
      /unresolved assumptions visibly tentative\/open/u,
      /basis or missing evidence/u,
      /review counters do not certify semantic completeness/u,
    ]) assert.match(text, meaning, 'The delivered policy itself must cover full requirements and uncertainty');
  };
  const reviewPolicy = (text) => {
    for (const meaning of [
      /whole current task and the relevant original input/u,
      /Preserve all earlier requirements and qualifications that still apply/u,
      /authoritative clarification (?:actually )?changes or cancels/u,
      /set\/patch/u,
      /Optional reviewedInputRevision records only the inputs actually considered/u,
      /Unchanged steering needs no task call or confirmation/u,
      /control_task_confirm is optional bookkeeping/u,
    ]) assert.match(text, meaning, 'Reconciliation must cover the entire still-applicable task');
  };
  const initialPrompt = 'Repair control-task, agent-state, injection-rules and probe-hook while preserving existing user work. Keep diagnostics off by default. Demonstrate the requested behavior with original state retained. Source: request://preservation#original.';
  const initialBody = [
    'Outcome [explicit; source: prompt://initial#four-ports]: Repair the four existing ports: control-task, agent-state, injection-rules, probe-hook.',
    'Inferred requirement [basis: preserving existing user work entails its reuse after upgrade and restart; source: request://preservation#original]: Retained task and guide state must remain reusable after upgrade/restart.',
    'Constraint [source: prompt://initial#diagnostics]: Diagnostics remain disabled by default.',
    'Result condition [source: prompt://initial#acceptance]: Each existing port demonstrates its requested behavior without losing original user state.',
    'Task-specific rule [source: request://preservation#priority]: Preserve instruction priority and exact source references.',
    'Unverified assumption [open; missing evidence: installed host version; source: fixture://host/0.6.12]: The user installation may match the pinned host fixture; verify before claiming installation parity.',
  ].join('\n');
  const clarification = 'Also restore the complete control-task definition and original source references after automatic compact. This adds a requirement and cancels none of the existing requirements.';
  const addedClause = 'Additional explicit requirement [source: prompt://clarification#compact]: Restore the complete task and its original source references after automatic compact.';
  const expectedBody = `${initialBody}\n${addedClause}`;
  const nonmaterial = 'Continue with the same complete scope and qualifications; this steering does not change the durable definition.';
  for (const changedBranch of ['set', 'patch']) {
    const f = makeFixture(t, 'control-task');
    const runRegistered = async (payload) => {
      const commands = registered[payload.hook_event_name].flatMap((group) => group.hooks).filter((entry) => entry.type === 'command');
      assert.ok(commands.some((entry) => entry.command.replaceAll('${PLUGIN_ROOT}', f.pluginRoot) === `bun "${hook}"`), 'Exercise the script actually registered for this event');
      const result = await runHook(hook, payload, rpcOptions(f));
      assert.equal(result.code, 0, result.stderr);
      return result;
    };
    const invoke = async (name, args) => {
      const pending = await mcpCall(script, name, args, rpcOptions(f));
      assert.equal(pending.result.structuredContent.status, 'pending_host_commit');
      return runRegistered(postToolPayload({ plugin: 'control-task', operation: name, args, result: pending.result, cwd: f.workspaceDir, toolUseId: `requirements-${changedBranch}-${++sequence}` }));
    };
    const guidance = (result) => {
      const policy = withoutQuotedSources(result.context);
      assert.ok(!policy.includes(initialBody), 'Supplied canonical text cannot satisfy policy assertions');
      assert.ok(!policy.includes(initialPrompt), 'Quoted raw observations cannot satisfy policy assertions');
      contentPolicy(policy);
      reviewPolicy(policy);
    };
    const discovery = await runMcp(script, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ], rpcOptions(f));
    const descriptions = discovery.responses.find((entry) => entry.id === 2).result.tools;
    for (const name of ['control_task_set', 'control_task_patch']) {
      const description = descriptions.find((entry) => entry.name === name).description;
      contentPolicy(description);
      reviewPolicy(description);
    }
    reviewPolicy(descriptions.find((entry) => entry.name === 'control_task_confirm').description);
    const unset = await runRegistered({ hook_event_name: 'SessionStart', session_id: 'session-a', cwd: f.workspaceDir, source: 'startup' });
    assert.match(unset.context, /NOT SET/u);
    guidance(unset);
    inputObligation((await runRegistered(prompt(f, initialPrompt))).context);
    const initial = await invoke('control_task_set', { taskBody: initialBody, reason: 'Complete definition from the original request and stated basis', reviewedInputRevision: 1 });
    assert.match(initial.context, /status=committed/u);
    assert.ok(initial.context.includes(initialBody));
    guidance(initial);
    assert.equal(state(f).revisions[0].taskBody, initialBody);
    assert.equal(state(f).reviewedInputRevision, 1);
    const pendingReview = await runRegistered(prompt(f, clarification));
    inputObligation(pendingReview.context);
    guidance(pendingReview);
    assert.match(pendingReview.context, /inputRevision=2; reviewedInputRevision=1; unreviewed=1/u);
    assert.ok(pendingReview.context.includes(`${taskPaths(identity(f)).state}#taskRevision=1`));
    assert.match(pendingReview.context, /inputFromRevision:2/u);
    assert.equal(state(f).revisions[0].taskBody, initialBody);
    assert.equal(state(f).taskRevision, 1);
    for (const source of ['resume', 'compact']) {
      const restored = await runRegistered({ hook_event_name: 'SessionStart', session_id: 'session-a', cwd: f.workspaceDir, source });
      assert.ok(restored.context.includes(initialBody));
      assert.match(restored.context, /inputRevision=2; reviewedInputRevision=1; unreviewed=1/u);
      guidance(restored);
      assert.equal(state(f).inputRevision, 2, 'Lifecycle restoration cannot become a new prompt');
    }
    const args = changedBranch === 'set'
      ? { taskBody: expectedBody, reason: 'Review the complete task; add only the authorized clarification', reviewedInputRevision: 2 }
      : { expectedRevision: 1, operations: [{ op: 'add', text: addedClause }], reason: 'Review the complete task; add only the authorized clarification', reviewedInputRevision: 2 };
    const changed = await invoke(`control_task_${changedBranch}`, args);
    assert.match(changed.context, /status=committed/u);
    assert.ok(changed.context.includes(expectedBody));
    assert.deepEqual(state(f).revisions.map((entry) => entry.taskBody), [initialBody, expectedBody]);
    assert.equal(state(f).taskRevision, 2);
    assert.equal(state(f).reviewedInputRevision, 2);
    inputObligation((await runRegistered(prompt(f, nonmaterial))).context);
    const originalRead = await invoke('control_task_get', { inputFromRevision: 3, inputLimit: 1 });
    assert.ok(originalRead.context.includes(expectedBody));
    assert.ok(originalRead.context.includes(JSON.stringify(nonmaterial)));
    guidance(originalRead);
    for (const [reviewedInputRevision, code] of [[2, 'STALE_INPUT_REVISION'], [4, 'FUTURE_INPUT_REVISION']]) {
      const rejected = await invoke('control_task_confirm', { reviewedInputRevision, reason: 'This incomplete or future review cannot clear the observed input' });
      assert.ok(rejected.context.includes(code));
      assert.equal(state(f).reviewedInputRevision, 2);
    }
    const confirmed = await invoke('control_task_confirm', { reviewedInputRevision: 3, reason: 'Read the original steering and reviewed the whole task, including inference basis and open assumption; definition unchanged' });
    assert.match(confirmed.context, /status=committed/u);
    assert.equal(state(f).reviewedInputRevision, 3);
    assert.equal(state(f).taskRevision, 2);
    assert.equal(state(f).revisions.at(-1).taskBody, expectedBody);
    const alreadyReviewed = await invoke('control_task_confirm', { reviewedInputRevision: 3, reason: 'No additional input is pending; task remains unchanged' });
    assert.match(alreadyReviewed.context, /status=unchanged/u);
    assert.match(alreadyReviewed.context, /ALREADY_REVIEWED/u);
    for (const source of ['resume', 'compact']) {
      const restored = await runRegistered({ hook_event_name: 'SessionStart', session_id: 'session-a', cwd: f.workspaceDir, source });
      assert.ok(restored.context.includes(expectedBody));
      assert.match(restored.context, /inputRevision=3; reviewedInputRevision=3; unreviewed=0/u);
      guidance(restored);
    }
    const finalRead = await invoke('control_task_get', { inputFromRevision: 1, inputLimit: 3 });
    assert.ok(finalRead.context.includes(expectedBody));
    for (const original of [initialPrompt, clarification, nonmaterial]) assert.ok(finalRead.context.includes(JSON.stringify(original)));
    guidance(finalRead);
    assert.deepEqual(state(f).inputs.map((entry) => entry.text), [initialPrompt, clarification, nonmaterial]);
    assert.equal(state(f).taskRevision, 2);
    assert.equal(state(f).inputRevision, 3);
    const cancellation = 'Remove the requirement that diagnostics remain disabled by default; all other requirements and qualifications still apply.';
    const removedClause = 'Constraint [source: prompt://initial#diagnostics]: Diagnostics remain disabled by default.';
    const remainingBody = expectedBody.split('\n').filter((line) => line !== removedClause).join('\n');
    inputObligation((await runRegistered(prompt(f, cancellation))).context);
    assert.equal(state(f).revisions.at(-1).taskBody, expectedBody, 'Observing a cancellation does not rewrite the canonical body automatically');
    const removed = await invoke(`control_task_${changedBranch}`, changedBranch === 'set'
      ? { taskBody: remainingBody, reviewedInputRevision: 4 }
      : { expectedRevision: 2, operations: [{ op: 'remove', match: removedClause }], reviewedInputRevision: 4 });
    assert.match(removed.context, /status=committed/u);
    assert.equal(state(f).revisions.at(-1).taskBody, remainingBody);
    assert.equal(state(f).reviewedInputRevision, 4);
    assert.equal(state(f).inputs.at(-1).text, cancellation);
  }
});

test('invalid bodies, reasons, schema fields and oversized patches never get usable receipts', async (t) => {
  const f = makeFixture(t, 'control-task');
  const invalid = [
    ['control_task_set', { taskBody: '', reason: 'empty task' }],
    ['control_task_set', { taskBody: 'valid', reason: ' ' }],
    ['control_task_set', { taskBody: 'a'.repeat(12001), reason: 'large' }],
    ['control_task_set', { taskBody: 'valid', reason: 'bad routing', sessionId: 'victim' }],
    ['control_task_set', { taskBody: '\ud800', reason: 'unpaired surrogate' }],
    ['control_task_patch', { expectedRevision: 1, operations: Array.from({ length: 129 }, () => ({ op: 'add', text: 'x' })), reason: 'too many' }],
    ['control_task_patch', { expectedRevision: 1, operations: [{ op: 'remove', match: 'a\nb' }], reason: 'non-line anchor' }],
    ['control_task_confirm', { reviewedInputRevision: -1, reason: 'invalid count' }],
    ['control_task_get', { inputFromRevision: 1, inputLimit: 33 }],
  ];
  const replies = await Promise.all(invalid.map(([name, args]) => mcpCall(script, name, args, rpcOptions(f))));
  assert.ok(replies.every((reply) => reply.response?.error || reply.responses.some((response) => response.id === null && response.error?.code === -32700)), JSON.stringify(replies.map((reply) => reply.responses)));
  assert.ok(replies.every((reply) => reply.responses.every((response) => !response.result?.structuredContent)), 'invalid arguments never receive an executable pending receipt');
  assert.equal(existsSync(f.pluginDataDir), false);
});

test('every actual same-turn prompt occurrence is retained and only explicit covered input clears debt', async (t) => {
  const f = makeFixture(t, 'control-task');
  await operation(f, 'control_task_set', { taskBody: 'Canonical body stays unchanged until an explicit operation.', reason: 'fixture' });
  const texts = ['Distinct one', 'Distinct two', 'Identical prompt', 'Identical prompt'];
  for (const text of texts) {
    const observed = await runHook(hook, prompt(f, text), rpcOptions(f));
    assert.match(observed.context, /Input provenance: native UserPromptSubmit hook observations/u);
    assert.match(observed.context, /not an exact-once accepted-human-message count/u);
  }
  assert.deepEqual(state(f).inputs.map((item) => item.text), texts);
  assert.equal(new Set(state(f).inputs.map((item) => item.observationId)).size, 4);
  assert.equal(new Set(state(f).inputs.map((item) => item.turnId)).size, 1);
  assert.equal(state(f).taskRevision, 1);
  const oldBody = state(f).revisions[0].taskBody;
  const stale = await operation(f, 'control_task_confirm', { reviewedInputRevision: 3, reason: 'stale view' });
  const future = await operation(f, 'control_task_confirm', { reviewedInputRevision: 5, reason: 'future view' });
  assert.equal(stale.outcome.code, 'STALE_INPUT_REVISION');
  assert.equal(future.outcome.code, 'FUTURE_INPUT_REVISION');
  const partial = await operation(f, 'control_task_patch', { expectedRevision: 1, operations: [{ op: 'add', text: 'A durable clarification.' }], reason: 'only input one was reviewed', reviewedInputRevision: 1 });
  assert.equal(partial.outcome.unreviewed, 3);
  const omitted = await operation(f, 'control_task_set', { taskBody: `${oldBody}\nA durable clarification.\nAnother requirement.`, reason: 'no coverage claimed' });
  assert.equal(omitted.outcome.unreviewed, 3);
  assert.equal(omitted.outcome.reviewedInputRevision, 1);
  await store(f).capturePrompt('Concurrent newer input');
  const stillStale = await operation(f, 'control_task_confirm', { reviewedInputRevision: 4, reason: 'race must not clear' });
  assert.equal(stillStale.outcome.code, 'STALE_INPUT_REVISION');
  const confirmed = await operation(f, 'control_task_confirm', { reviewedInputRevision: 5, reason: 'read the actual five observations; task is unchanged' });
  assert.equal(confirmed.outcome.unreviewed, 0);
  assert.equal(state(f).taskRevision, 3);
  const get = await operation(f, 'control_task_get', { inputFromRevision: 1, inputLimit: 5 });
  assert.deepEqual(get.view.inputRecords.map((item) => item.text), [...texts, 'Concurrent newer input']);
  assert.equal(get.view.inputRecords[0].locator, `${get.store.paths.state}#inputRevision=1`);
  for (const payload of [
    { hook_event_name: 'SessionStart', session_id: 'session-a', cwd: f.workspaceDir, source: 'compact' },
    { hook_event_name: 'SubagentStart', session_id: 'child', cwd: f.workspaceDir, agent_id: 'role-different-from-session', agent_type: 'worker' },
    postToolPayload({ plugin: 'other-plugin', operation: 'get', args: {}, result: { content: [{ type: 'text', text: 'A tool result is not a prompt' }] }, cwd: f.workspaceDir }),
  ]) await runHook(hook, payload, rpcOptions(f));
  assert.equal(state(f).inputRevision, 5);
  assert.equal(state(f, 'child').inputRevision, 0);
  await runHook(hook, prompt(f, 'Child steering belongs to child', 'child'), rpcOptions(f));
  assert.equal(state(f).inputRevision, 5);
  assert.equal(state(f, 'child').inputs[0].text, 'Child steering belongs to child');
});

test('cross-process prompt/patch race linearizes without implicitly reviewing the arriving input', async (t) => {
  const f = makeFixture(t, 'control-task');
  await operation(f, 'control_task_set', { taskBody: 'Initial task', reason: 'fixture' });
  await store(f).capturePrompt('Reviewed first input');
  const args = { expectedRevision: 1, operations: [{ op: 'add', text: 'Preserve the new requirement.' }], reviewedInputRevision: 1, reason: 'first input covered' };
  const pending = await mcpCall(script, 'control_task_patch', args, rpcOptions(f));
  const replies = await Promise.all([
    runHook(hook, prompt(f, 'Arrives concurrently'), rpcOptions(f)),
    runHook(hook, postToolPayload({ plugin: 'control-task', operation: 'control_task_patch', args, result: pending.result, cwd: f.workspaceDir, toolUseId: 'raced-patch' }), rpcOptions(f)),
  ]);
  assert.ok(replies.every((reply) => reply.code === 0));
  const final = state(f);
  assert.equal(final.taskRevision, 2);
  assert.equal(final.inputRevision, 2);
  assert.equal(final.reviewedInputRevision, 1);
  assert.equal(final.inputs[1].text, 'Arrives concurrently');
});

test('receipt provenance, errors, replay, age and retention remain truthful', async (t) => {
  const f = makeFixture(t, 'control-task');
  const initial = await operation(f, 'control_task_set', { taskBody: 'Receipt-bound initial body', reason: 'initial' });
  const savedBytes = readFileSync(initial.store.paths.state);
  const badArgs = { taskBody: 'Mismatched body', reason: 'tamper' };
  const pending = createPendingReceipt('control-task', 'control_task_set', badArgs);
  const cases = [
    (payload) => { payload.tool_response.details.server = 'wrong-server'; },
    (payload) => { payload.tool_response.details.mcp.isError = true; },
    (payload) => { payload.tool_input.taskBody = 'Changed after receipt'; },
    (payload) => { payload.tool_response.details.mcp.structuredContent.receiptVersion = 99; },
  ];
  for (const mutate of cases) {
    const payload = postToolPayload({ plugin: 'control-task', operation: 'control_task_set', args: structuredClone(badArgs), result: structuredClone(pending), cwd: f.workspaceDir, toolUseId: `bad-${++sequence}` });
    mutate(payload);
    const result = await runHook(hook, payload, rpcOptions(f));
    assert.match(result.context, /operation rejected/u);
    assert.deepEqual(readFileSync(initial.store.paths.state), savedBytes);
  }
  const expiredNow = initial.receipt.createdAt + 70000;
  const replayStore = new ControlTaskStore(initial.store.identity, { now: () => expiredNow });
  const replay = await replayStore.execute(initial.receipt, initial.args);
  assert.equal(replay.replayed, true);
  assert.equal(replay.outcome.revision, 1);
  assert.equal(state(f).taskRevision, 1);
  await store(f).capturePrompt('A newer prompt arrived after the original completed receipt');
  const historical = await replayStore.execute(initial.receipt, initial.args);
  assert.equal(historical.outcome.inputRevision, 0, 'replay preserves the actual original outcome');
  assert.equal(state(f).inputRevision, 1);
  assert.match(renderOperation(initial.receipt, historical), /recorded operation snapshot; current taskRevision=1, inputRevision=1, reviewedInputRevision=0/u, 'a newer input without a task edit must still make the replay visibly historical');
  const unknown = createPendingReceipt('control-task', 'control_task_set', badArgs, { now: initial.receipt.createdAt }).structuredContent;
  await assert.rejects(store(f, { now: () => expiredNow }).execute(unknown, badArgs), (error) => error.code === 'RECEIPT_EXPIRED' && /does not establish/u.test(error.message));
  const reused = createPendingReceipt('control-task', 'control_task_set', badArgs).structuredContent;
  await assert.rejects(new ControlTaskStore(initial.store.identity).execute(reused, badArgs), (error) => error.code === 'OPERATION_ID_REUSE');
  const f2 = makeFixture(t, 'control-task');
  const bounded = { maxOperations: 2 };
  const one = await operation(f2, 'control_task_set', { taskBody: 'one', reason: 'one' }, { limits: bounded });
  await operation(f2, 'control_task_get', {}, { limits: bounded });
  await assert.rejects(operation(f2, 'control_task_get', {}, { limits: bounded }), (error) => error.code === 'OPERATION_STORAGE_LIMIT');
  assert.equal(state(f2).operations.length, 2);
  const afterExpiry = () => one.receipt.createdAt + 70000;
  await operation(f2, 'control_task_get', {}, { limits: bounded, now: afterExpiry });
  assert.equal(state(f2).operations.length, 1, 'only expired completed receipts may be reclaimed');
  assert.equal(state(f2).revisions[0].taskBody, 'one');
});

test('legacy migration preserves exact bytes and invalid existing records remain unavailable', async (t) => {
  const f = makeFixture(t, 'control-task');
  const instance = store(f);
  mkdirSync(instance.paths.directory, { recursive: true });
  const legacy = Buffer.from('{\r\n  "sessionId":"session-a", "taskBody":"  Preserve whitespace\\r\\nAnd Unicode: café.  ",\r\n "updatedAt":"2026-01-02T03:04:05.000Z"\r\n}\r\n');
  writeFileSync(instance.paths.state, legacy);
  const beforeBody = JSON.parse(legacy).taskBody;
  const migrated = await instance.snapshot();
  assert.equal(migrated.taskBody, beforeBody);
  assert.deepEqual(readFileSync(instance.paths.legacy), legacy);
  assert.equal(state(f).schemaVersion, 2);
  assert.equal((await store(f).snapshot()).taskBody, beforeBody);
  await operation(f, 'control_task_patch', { expectedRevision: 1, operations: [{ op: 'add', text: 'Explicit addition' }], reason: 'authorized change' });
  assert.deepEqual(readFileSync(instance.paths.legacy), legacy);
  const invalidRecords = ['', '{broken', JSON.stringify({ schemaVersion: 50, sessionId: 'bad' }), JSON.stringify({ sessionId: 'wrong', taskBody: 'x', updatedAt: '2026-01-01' }), JSON.stringify({ sessionId: 'bad', taskBody: ' ', updatedAt: '2026-01-01' })];
  for (let index = 0; index < invalidRecords.length; index += 1) {
    const id = `bad-${index}`;
    const broken = store(f, { sessionId: id });
    mkdirSync(broken.paths.directory, { recursive: true });
    writeFileSync(broken.paths.state, invalidRecords[index]);
    await assert.rejects(broken.snapshot());
    await assert.rejects(operation(f, 'control_task_set', { taskBody: 'must not repair silently', reason: 'attempt' }, { sessionId: id }));
    assert.equal(readFileSync(broken.paths.state, 'utf8'), invalidRecords[index]);
  }
  const canonical = state(f);
  canonical.reviewedInputRevision = canonical.inputRevision + 1;
  writeFileSync(instance.paths.state, JSON.stringify(canonical));
  await assert.rejects(store(f).snapshot(), (error) => error.code === 'TASK_STATE_INVALID');
  const tooLarge = store(f, { sessionId: 'oversize' });
  writeFileSync(tooLarge.paths.state, '');
  truncateSync(tooLarge.paths.state, STORE_LIMITS.maxStateBytes + 1);
  await assert.rejects(tooLarge.snapshot(), (error) => error.code === 'FILE_TOO_LARGE');
  assert.equal(statSync(tooLarge.paths.state).size, STORE_LIMITS.maxStateBytes + 1);
});

test('archives keep every body/raw input and stable revision locators after restart', async (t) => {
  const f = makeFixture(t, 'control-task');
  const inputs = [];
  const bodies = [];
  for (let i = 0; i < 10; i += 1) {
    const body = `Task ${i}: ` + 'canonical ü '.repeat(260);
    bodies.push(body);
    await operation(f, 'control_task_set', { taskBody: body, reason: `durable change ${i}` }, { limits: small });
    const text = `Observed ${i}: ` + 'raw original 漢字 '.repeat(230);
    inputs.push(text);
    await store(f, { limits: small }).capturePrompt(text);
  }
  const current = state(f);
  assert.ok(current.archives.length > 0);
  assert.ok(statSync(taskPaths(identity(f)).state).size <= small.maxStateBytes);
  const allInputs = [];
  const allRevisions = [];
  for (const archived of current.archives) {
    const path = join(taskPaths(identity(f)).directory, archived.file);
    assert.ok(statSync(path).size <= small.maxArchiveBytes);
    const segment = JSON.parse(readFileSync(path, 'utf8'));
    allInputs.push(...segment.inputs); allRevisions.push(...segment.revisions);
  }
  allInputs.push(...current.inputs); allRevisions.push(...current.revisions);
  assert.deepEqual(allInputs.map((value) => value.text), inputs);
  assert.deepEqual(allRevisions.map((value) => value.taskBody), bodies);
  assert.deepEqual(allInputs.map((value) => value.inputRevision), Array.from({ length: 10 }, (_, index) => index + 1));
  const get = await operation(f, 'control_task_get', { inputFromRevision: 1, inputLimit: 10 }, { limits: small });
  assert.equal(get.view.inputRecords.length, 10);
  assert.equal(get.view.inputRecords[0].locator, `${get.store.paths.state}#inputRevision=1`);
  const index = JSON.parse(readFileSync(get.store.paths.index, 'utf8'));
  assert.equal(index.inputRevision, 10);
  for (const range of index.inputs) {
    const segment = JSON.parse(readFileSync(resolve(index.baseDirectory, range.file), 'utf8'));
    assert.equal(segment.inputs[0].inputRevision, range.from);
    assert.equal(segment.inputs.at(-1).inputRevision, range.to);
  }
  assert.equal(get.view.reviewedInputRevision, 0, 'archiving never reviews or evicts unreviewed primary input');
});

test('a real hook archives a near-limit active store within its configured timeout without losing primary input', async (t) => {
  const f = makeFixture(t, 'control-task');
  const instance = store(f);
  await operation(f, 'control_task_set', { taskBody: 'Keep every raw observation at the supported storage bound.', reason: 'scale fixture' });
  const text = 'Original input at supported scale: ' + 'x'.repeat(760000);
  for (let i = 0; i < 16; i += 1) await instance.capturePrompt(`${i}: ${text}`);
  assert.equal(state(f).archives.length, 0);
  assert.ok(statSync(instance.paths.state).size > 11 * 1024 * 1024);
  const last = `16: ${text}`;
  const result = await runHook(hook, prompt(f, last), { ...rpcOptions(f), timeout: 5000 });
  assert.equal(result.code, 0, `signal=${result.signal}; ${result.stderr}`);
  assert.match(result.context, /inputRevision=17/u);
  const current = state(f);
  assert.equal(current.inputRevision, 17);
  assert.equal(current.reviewedInputRevision, 0);
  assert.ok(current.archives.length > 0);
  assert.ok(statSync(instance.paths.state).size <= STORE_LIMITS.maxStateBytes);
  const firstArchive = JSON.parse(readFileSync(join(instance.paths.directory, current.archives[0].file), 'utf8'));
  assert.equal(firstArchive.inputs[0].text, `0: ${text}`);
  assert.equal(current.inputs.at(-1).text, last);
  assert.equal(firstArchive.inputs.length + current.inputs.length, 17);
});

test('archive interruption before canonical replacement retains old truth and supports retry', async (t) => {
  const f = makeFixture(t, 'control-task');
  const instance = store(f, { limits: small });
  await instance.capturePrompt('A'.repeat(7000));
  await instance.capturePrompt('B'.repeat(7000));
  const before = readFileSync(instance.paths.state);
  const failing = store(f, { limits: small, io: { atomicWrite(path, bytes) {
    if (path === instance.paths.state) throw new storage.RuntimeError('WRITE_FAILED', 'Injected before canonical rename', { path, phase: 'before_rename' });
    return storage.atomicWrite(path, bytes);
  } } });
  await assert.rejects(failing.capturePrompt('C'.repeat(7000)), (error) => error.committed === false && error.phase === 'archive-written-canonical-unchanged' && typeof error.recoveryPath === 'string');
  assert.deepEqual(readFileSync(instance.paths.state), before);
  const prepared = readdirSync(instance.paths.directory).filter((name) => name.startsWith('archive-'));
  assert.equal(prepared.length, 1);
  const recovered = await instance.capturePrompt('C'.repeat(7000));
  assert.equal(recovered.inputRevision, 3);
  assert.deepEqual(readdirSync(instance.paths.directory).filter((name) => name.startsWith('archive-')), prepared, 'content-addressed prepared archive is reused');
  assert.deepEqual((await instance.snapshot({ inputFromRevision: 1, inputLimit: 3 })).inputRecords.map((entry) => entry.text[0]), ['A', 'B', 'C']);
});

test('after-rename uncertainty keeps the completed receipt, and failed derived indexes do not undo a commit', async (t) => {
  const f = makeFixture(t, 'control-task');
  for (const text of ['A', 'B']) await operation(f, 'control_task_set', { taskBody: text.repeat(8000), reason: 'fill revisions for archive' }, { limits: small });
  const instance = store(f, { limits: small });
  const args = { taskBody: 'C'.repeat(8000), reason: 'third revision survives uncertain response' };
  const receipt = createPendingReceipt('control-task', 'control_task_set', args).structuredContent;
  const failing = new ControlTaskStore(instance.identity, { limits: small, io: { atomicWrite(path, bytes) {
    const result = storage.atomicWrite(path, bytes);
    if (path === instance.paths.state) throw new storage.RuntimeError('WRITE_UNCERTAIN', 'Injected after canonical replacement', { path, committed: true, status: 'uncertain', phase: 'after_rename' });
    return result;
  } } });
  await assert.rejects(failing.execute(receipt, args), (error) => error.committed === true && error.phase === 'after_rename');
  assert.equal(state(f).taskRevision, 3);
  assert.ok(state(f).archives.length > 0);
  const recovered = await new ControlTaskStore(instance.identity, { limits: small, now: () => receipt.createdAt + 70000 }).execute(receipt, args);
  assert.equal(recovered.replayed, true);
  assert.equal(recovered.outcome.status, 'committed');
  assert.equal(state(f).taskRevision, 3);
  const indexFailure = await operation(f, 'control_task_set', { taskBody: 'D'.repeat(8000), reason: 'index failure cannot undo task' }, { limits: small, io: { atomicWrite(path, bytes) {
    if (path.endsWith('/input-locations.json')) throw new storage.RuntimeError('WRITE_FAILED', 'Injected derived index failure', { path });
    return storage.atomicWrite(path, bytes);
  } } });
  assert.equal(indexFailure.outcome.status, 'committed');
  assert.equal(indexFailure.view.indexStatus, 'unavailable');
  assert.equal(state(f).taskRevision, 4);
  assert.match(renderOperation(indexFailure.receipt, indexFailure), /operation outcome above is retained/u);
  assert.equal((await store(f, { limits: small }).snapshot()).indexStatus, 'current');
});

test('backup/archive-only uncertainty cannot be misreported as a committed task', async (t) => {
  const f = makeFixture(t, 'control-task');
  const instance = store(f, { limits: small });
  mkdirSync(instance.paths.directory, { recursive: true });
  const old = Buffer.from(JSON.stringify({ sessionId: 'session-a', taskBody: 'Legacy task', updatedAt: '2026-01-01T00:00:00Z' }));
  writeFileSync(instance.paths.state, old);
  const failBackup = store(f, { limits: small, io: { writeExclusive(path, bytes) {
    storage.writeExclusive(path, bytes);
    throw new storage.RuntimeError('WRITE_UNCERTAIN', 'Backup durability uncertain', { path, committed: true, status: 'uncertain' });
  } } });
  await assert.rejects(failBackup.snapshot(), (error) => error.committed === false && error.phase === 'legacy-backup-preparation');
  assert.deepEqual(readFileSync(instance.paths.state), old);
  assert.deepEqual(readFileSync(instance.paths.legacy), old);
  await instance.snapshot();
  await instance.capturePrompt('A'.repeat(7000));
  await instance.capturePrompt('B'.repeat(7000));
  const before = readFileSync(instance.paths.state);
  const failArchive = store(f, { limits: small, io: { writeExclusive(path, bytes) {
    const result = storage.writeExclusive(path, bytes);
    if (path.includes('/archive-')) throw new storage.RuntimeError('WRITE_UNCERTAIN', 'Archive durability uncertain', { path, committed: true, status: 'uncertain' });
    return result;
  } } });
  await assert.rejects(failArchive.capturePrompt('C'.repeat(7000)), (error) => error.committed === false && error.phase === 'archive-preparation-canonical-unchanged');
  assert.deepEqual(readFileSync(instance.paths.state), before);
});

test('archive capacity rejects growth before loss; completed task history is never deleted', async (t) => {
  const f = makeFixture(t, 'control-task');
  const limits = { ...small, maxArchives: 1 };
  const instance = store(f, { limits });
  for (const char of ['A', 'B', 'C']) await instance.capturePrompt(char.repeat(7000));
  let last = readFileSync(instance.paths.state);
  let rejected = false;
  for (const char of ['D', 'E', 'F']) {
    try { await instance.capturePrompt(char.repeat(7000)); last = readFileSync(instance.paths.state); }
    catch (error) { assert.equal(error.code, 'TASK_STORAGE_LIMIT'); rejected = true; break; }
  }
  assert.equal(rejected, true);
  assert.deepEqual(readFileSync(instance.paths.state), last);
  assert.equal(readdirSync(instance.paths.directory).filter((name) => name.startsWith('archive-')).length, 1);
  assert.equal((await instance.snapshot({ inputFromRevision: 1, inputLimit: 1 })).inputRecords[0].text, 'A'.repeat(7000));
});

test('Stop and SubagentStop are unregistered and inert before identity or storage, including old checkpoint files', async (t) => {
  const registered = JSON.parse(readFileSync(join(repositoryRoot, 'plugins/control-task/hooks/hooks.json'), 'utf8')).hooks;
  assert.equal(registered.Stop, undefined);
  assert.equal(registered.SubagentStop, undefined);
  assert.equal(existsSync(join(repositoryRoot, 'plugins/control-task/scripts/control-task-checkpoint.mjs')), false);
  const f = makeFixture(t, 'control-task');
  const ignored = async (payload) => {
    const result = await runHook(hook, payload, rpcOptions(f));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, '', 'Even additionalContext would cause an unwanted native Stop continuation');
    assert.equal(result.stderr, '', 'Unsupported stop hooks must not inspect identity, task state or checkpoint budgets');
  };
  for (const event of ['Stop', 'SubagentStop']) {
    await ignored({ hook_event_name: event });
    await ignored(stop(f, 'missing-task', 'session-a', { hook_event_name: event }));
    const output = capture(); const stderr = capture();
    await handleHook({ hook_event_name: event }, { env: {}, output, stderr, storeOptions: { io: {
      atomicWrite() { assert.fail('Unsupported events must return before storage'); },
      readJson() { assert.fail('Unsupported events must return before storage'); },
    } } });
    assert.equal(output.text + stderr.text, '');
  }
  assert.equal(existsSync(f.pluginDataDir), false);
  const initial = await operation(f, 'control_task_set', { taskBody: 'Retain this complete task.' });
  const checkpointPath = join(initial.store.paths.directory, 'checkpoint.json');
  const oldCheckpoint = '{invalid legacy checkpoint bytes must remain untouched\n';
  writeFileSync(checkpointPath, oldCheckpoint);
  await runHook(hook, prompt(f, 'A clarification that has not been reviewed.'), rpcOptions(f));
  const restored = await runHook(hook, { hook_event_name: 'SessionStart', session_id: 'session-a', cwd: f.workspaceDir, source: 'compact' }, rpcOptions(f));
  assert.ok(restored.context.includes('Retain this complete task.'));
  assert.equal(readFileSync(checkpointPath, 'utf8'), oldCheckpoint, 'Invalid legacy checkpoint content is not loaded by ordinary hooks');
  for (const corrupt of [false, true]) {
    if (corrupt) writeFileSync(initial.store.paths.state, '{corrupt canonical state retained');
    const before = readFileSync(initial.store.paths.state);
    for (const event of ['Stop', 'SubagentStop']) {
      for (const outcome of ['completed', 'error', 'aborted', 'cancelled']) {
        await ignored(stop(f, `old-run-${outcome}`, 'session-a', { hook_event_name: event, outcome,
          stop_hook_active: outcome === 'completed', ...(event === 'SubagentStop' ? { agent_id: 'child-role', agent_type: 'worker' } : {}) }));
      }
    }
    assert.deepEqual(readFileSync(initial.store.paths.state), before);
    assert.equal(readFileSync(checkpointPath, 'utf8'), oldCheckpoint);
  }
});

test('failed prompt capture retains the update obligation and never gates unrelated tools or completion', async (t) => {
  const f = makeFixture(t, 'control-task');
  await operation(f, 'control_task_set', { taskBody: 'Read the current directory only.', reason: 'read-only task' });
  const statePath = taskPaths(identity(f)).state;
  const before = readFileSync(statePath);
  const output = capture(); const stderr = capture();
  await handleHook(prompt(f, 'Remove the previous directory-only restriction.'), { env: f.env, output, stderr, storeOptions: { io: { atomicWrite(path, bytes) {
    if (path === statePath) throw new storage.RuntimeError('WRITE_FAILED', 'Injected prompt capture failure', { path });
    return storage.atomicWrite(path, bytes);
  } } } });
  const failed = JSON.parse(output.text);
  assert.equal(failed.decision, undefined);
  assert.match(stderr.text, /WRITE_FAILED/u);
  const context = failed.hookSpecificOutput.additionalContext;
  inputObligation(context);
  assert.match(context, /ACTIVE TASK — UNAVAILABLE/u);
  assert.match(context, /If task capture, updating or restoration fails[\s\S]*continue the authorized work or deliver the report/u);
  assert.match(context, /No separate confirmation, read-back, retry or repair is required to proceed after that failure/u);
  assert.deepEqual(readFileSync(statePath), before, 'Capture failure cannot erase or invent task/input state');
  const bash = await runHook(hook, { hook_event_name: 'PostToolUse', session_id: 'session-a', turn_id: 'read-only', tool_use_id: 'pwd', cwd: f.workspaceDir, tool_name: 'bash', tool_input: { command: 'pwd' }, tool_response: { content: [{ type: 'text', text: '/fixture' }] } }, rpcOptions(f));
  assert.equal(bash.stdout, '');
  assert.equal((await runHook(hook, stop(f, 'read-only'), rpcOptions(f))).stdout, '');
  const failureResult = await runHook(hook, { hook_event_name: 'PostToolUse', session_id: 'session-a', turn_id: 'read-only', tool_use_id: 'failed-read', cwd: f.workspaceDir, tool_name: 'read', tool_input: {}, tool_response: { isError: true, content: [{ type: 'text', text: 'Read failed' }] } }, rpcOptions(f));
  assert.equal(failureResult.stdout, '');
  assert.deepEqual(readFileSync(statePath), before);
  writeFileSync(statePath, '{corrupt task remains preserved');
  const corrupt = await runHook(hook, prompt(f, 'Add the requirement to keep original references.'), rpcOptions(f));
  assert.equal(corrupt.code, 0, corrupt.stderr);
  assert.equal(corrupt.envelope.decision, undefined);
  inputObligation(corrupt.context);
  assert.match(corrupt.context, /ACTIVE TASK — UNAVAILABLE/u);
  assert.equal(readFileSync(statePath, 'utf8'), '{corrupt task remains preserved');
  const noIdentity = await runHook(hook, { hook_event_name: 'UserPromptSubmit', cwd: f.workspaceDir, prompt: 'Continue.' }, rpcOptions(f));
  assert.equal(noIdentity.code, 0, noIdentity.stderr);
  inputObligation(noIdentity.context);
  assert.equal(noIdentity.envelope.decision, undefined);
  const boundedUnavailable = renderSnapshot({ status: 'unavailable', errorCode: 'WRITE_FAILED', statePath: '/'.repeat(30000) }, { event: 'UserPromptSubmit' });
  assert.ok(boundedUnavailable.length < 4000);
  assert.match(boundedUnavailable, /identity or the full state locator could not be delivered/u);
  inputObligation(boundedUnavailable);
});

test('paired startup and prompt snapshots retain originals, review metadata and the input obligation within one context budget', async (t) => {
  const f = makeFixture(t, 'control-task');
  const body = `TASK_BOUND_START\n${'т'.repeat(11950)}\nTASK_BOUND_END`;
  const raw = `RAW_INPUT_START\n${'Long original clarification. '.repeat(2000)}\nRAW_INPUT_END`;
  const saved = await operation(f, 'control_task_set', { taskBody: body, reason: 'Full body at the supported task limit' });
  const restored = await runHook(hook, { hook_event_name: 'SessionStart', session_id: 'session-a', cwd: f.workspaceDir, source: 'startup' }, rpcOptions(f));
  const observed = await runHook(hook, prompt(f, raw), rpcOptions(f));
  assert.ok(restored.context.length + observed.context.length <= 20000, `The native paired events share one reservation, received ${restored.context.length + observed.context.length} characters`);
  for (const result of [restored, observed]) {
    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.context.includes(`${saved.store.paths.state}#taskRevision=1`));
    assert.ok(Buffer.byteLength(result.stdout) < 60 * 1024);
  }
  assert.ok(restored.context.length <= 16000);
  assert.ok(restored.context.includes(`[BEGIN VERBATIM CANONICAL TASK]\n${body}\n[END VERBATIM CANONICAL TASK]`), 'The restore allowance retains a complete maximum body when its framing fits');
  assert.ok(observed.context.length <= 4000);
  inputObligation(observed.context);
  assert.match(observed.context, /complete canonical body is omitted/u);
  assert.equal(observed.context.includes('[BEGIN VERBATIM CANONICAL TASK]'), false);
  assert.match(observed.context, /taskRevision=1; inputRevision=1; reviewedInputRevision=0; unreviewed=1/u);
  assert.match(observed.context, /control_task_get\(\{inputFromRevision:1,inputLimit:20\}\)/u);
  assert.equal(state(f).revisions[0].taskBody, body);
  assert.equal(state(f).inputs[0].text, raw);
  const getArgs = {};
  const pending = await mcpCall(script, 'control_task_get', getArgs, rpcOptions(f));
  const read = await runHook(hook, postToolPayload({ plugin: 'control-task', operation: 'control_task_get', args: getArgs, result: pending.result, cwd: f.workspaceDir, toolUseId: 'read-full-after-paired-events' }), rpcOptions(f));
  assert.match(read.context, /status=current/u);
  assert.ok(read.context.includes(`[BEGIN VERBATIM CANONICAL TASK]\n${body}\n[END VERBATIM CANONICAL TASK]`), 'A task read retains the larger complete-body allowance');
  assert.equal(state(f).reviewedInputRevision, 0, 'Delivery and reading never reconcile a prompt implicitly');
  const compact = await runHook(hook, { hook_event_name: 'SessionStart', session_id: 'session-a', cwd: f.workspaceDir, source: 'compact' }, rpcOptions(f));
  assert.ok(compact.context.includes(`${saved.store.paths.state}#taskRevision=1`));
  assert.ok(compact.context.includes(`[BEGIN VERBATIM CANONICAL TASK]\n${body}\n[END VERBATIM CANONICAL TASK]`));
  assert.match(compact.context, /inputRevision=1; reviewedInputRevision=0; unreviewed=1/u);
  assert.equal(state(f).taskRevision, 1);
  assert.equal(state(f).inputRevision, 1);
  const longPath = `/${'directory/'.repeat(820)}session.json`;
  const longView = { ...await store(f).snapshot(), statePath: longPath, indexPath: `${longPath}.index`, bodyLocator: `${longPath}#taskRevision=1` };
  const longRestore = renderSnapshot(longView, { event: 'SessionStart' });
  const longPrompt = renderSnapshot(longView, { event: 'UserPromptSubmit' });
  assert.ok(longRestore.length + longPrompt.length <= 20000, 'Long complete locators redistribute the same paired reservation');
  for (const text of [longRestore, longPrompt]) {
    assert.ok(text.includes(longPath), 'The complete original location cannot be clipped to meet a smaller prompt allowance');
    assert.match(text, /inputRevision=1; reviewedInputRevision=0; unreviewed=1/u);
    assert.match(text, /Review metadata is optional and only records inputs actually considered/u);
  }
  inputObligation(longPrompt);
});

test('escaped body/raw prompt delivery fits serialized native bounds and preserves complete originals', async (t) => {
  const f = makeFixture(t, 'control-task');
  const body = '\u0001'.repeat(12000);
  const saved = await operation(f, 'control_task_set', { taskBody: body, reason: 'maximally escaped valid canonical task' });
  const rendered = renderOperation(saved.receipt, saved);
  assert.ok(rendered.length <= 20000);
  assert.ok(hookOutputByteLength('PostToolUse', rendered) < 60 * 1024);
  assert.match(rendered, /complete canonical body is omitted/u);
  assert.ok(rendered.includes(`${saved.store.paths.state}#taskRevision=1`));
  assert.equal(state(f).revisions[0].taskBody, body);
  const raw = '🧭 raw prompt '.repeat(16000);
  await store(f).capturePrompt(raw);
  const get = await operation(f, 'control_task_get', { inputFromRevision: 1, inputLimit: 1 });
  const text = renderOperation(get.receipt, get);
  assert.ok(hookOutputByteLength('PostToolUse', text) < 60 * 1024);
  assert.ok(text.length <= 20000);
  assert.match(text, /Raw text retained at the original locator/u);
  assert.equal(state(f).inputs[0].text, raw);
  assert.equal(get.view.indexStatus, 'current');
  const payload = postToolPayload({ plugin: 'control-task', operation: 'control_task_get', args: {}, result: createPendingReceipt('control-task', 'control_task_get', {}), cwd: f.workspaceDir, toolUseId: 'bounded-real-output' });
  const actual = await runHook(hook, payload, rpcOptions(f));
  assert.equal(actual.code, 0, actual.stderr);
  assert.ok(Buffer.byteLength(actual.stdout) < 60 * 1024);
  assert.equal(actual.envelopes.length, 1);
  assert.match(actual.context, /complete canonical body is omitted/u);
});

test('workspace rebinding requires the current native row and keeps the initial address and binding', async (t) => {
  const f = makeFixture(t, 'control-task');
  await operation(f, 'control_task_set', { taskBody: 'Keep the stable session body', reason: 'fixture' });
  const other = join(f.root, 'changed-workspace');
  mkdirSync(other);
  const unverified = await runHook(hook, { hook_event_name: 'SessionStart', session_id: 'session-a', cwd: other, source: 'resume' }, { env: f.env, cwd: other });
  assert.match(unverified.context, /WORKSPACE_BINDING_CONFLICT/u);
  assert.equal(state(f).binding.currentWorkspaceDir, f.workspaceDir);
  await writeNativeSessions(f.dataDir, [{ sessionId: 'session-a', workspaceDir: other }]);
  const verified = await runHook(hook, { hook_event_name: 'SessionStart', session_id: 'session-a', cwd: other, source: 'resume' }, { env: f.env, cwd: other });
  assert.ok(verified.context.includes('Keep the stable session body'));
  const final = state(f);
  assert.equal(final.binding.initialWorkspaceDir, f.workspaceDir);
  assert.equal(final.binding.currentWorkspaceDir, other);
  assert.equal(final.taskRevision, 1);
});
