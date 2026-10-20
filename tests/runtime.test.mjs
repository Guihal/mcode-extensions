import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable, PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { RuntimeError, safeSessionId, safeDirectory, readRegular, inspectRegular, decodeRecord,
  listDirectory, atomicWrite, writeExclusive, withSessionLock, diagnosticRecord, boundedDiagnostic,
  appendBoundedLog, MAX_LOG_BYTES } from '../runtime/storage.mjs';
import { createPendingReceipt, validatePendingReceipt, assertReceiptFresh, validateReceiptShape,
  resolveHookIdentity, resolveWorkspaceBinding, readNativeLineage, readHookPayload, emitHookResult,
  hookOutputByteLength, MAX_HOOK_OUTPUT_BYTES, RECEIPT_MAX_AGE_MS, RECEIPT_CLOCK_SKEW_MS } from '../runtime/host.mjs';
import { serveMcp } from '../runtime/transport.mjs';
import { makeFixture, repositoryRoot, runScript, runMcp, postToolPayload, writeNativeSessions } from './helpers/runtime-fixture.mjs';

const probeScript = join(repositoryRoot, 'plugins/probe-hook/scripts/mcp-probe.mjs');
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } };

async function directoryProbe(t, body) {
  const fixture = makeFixture(t, 'probe-hook');
  const script = join(fixture.root, 'directory-probe.mjs');
  const moduleUrl = name => JSON.stringify(pathToFileURL(join(repositoryRoot, 'runtime', name)).href);
  fs.writeFileSync(script, `import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import {join} from 'node:path';
    import {createRequire} from 'node:module';
    import {Readable, PassThrough} from 'node:stream';
    import {iterateDirectory} from ${moduleUrl('directory.mjs')};
    import {listDirectory} from ${moduleUrl('storage.mjs')};
    import {serveMcp} from ${moduleUrl('transport.mjs')};
    const ffi=createRequire(import.meta.url)('bun:ffi');
    const root=${JSON.stringify(fixture.root)};
    const directory=join(root,'directory');fs.mkdirSync(directory);
    const descriptorCount=()=>fs.readdirSync('/proc/self/fd').length;
    ${body}
  `);
  const result = await runScript(script, '', { env: fixture.env, timeout: 30000 });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

test('native directory iteration honors zero/exact/overflow bounds and closes on early exits', async t => {
  const result = await directoryProbe(t, `
    const calls={opendir:0,readdir64:0,closedir:0};
    const original=ffi.dlopen;
    ffi.dlopen=(...args)=>{
      const library=original(...args);
      for(const name of Object.keys(calls)) {
        const call=library.symbols[name];
        library.symbols[name]=(...values)=>{calls[name]++;return call(...values);};
      }
      return library;
    };
    const reset=()=>{for(const name of Object.keys(calls))calls[name]=0;};
    assert.deepEqual(listDirectory(directory,0),[]);
    assert.equal(calls.opendir,1);assert.equal(calls.closedir,1);
    fs.writeFileSync(join(directory,'file'),'body');fs.mkdirSync(join(directory,'folder'));
    fs.symlinkSync('folder',join(directory,'link'));fs.writeFileSync(join(directory,'😀.md'),'unicode');
    const exact=listDirectory(directory,4);
    assert.deepEqual(exact.map(entry=>entry.name).sort(),['file','folder','link','😀.md'].sort());
    assert.equal(exact.find(entry=>entry.name==='folder').isDirectory(),true);
    assert.equal(exact.find(entry=>entry.name==='file').isFile(),true);
    assert.equal(exact.find(entry=>entry.name==='link').isSymbolicLink(),true);
    assert.equal(exact.find(entry=>entry.name==='link').isDirectory(),false);
    const large=join(root,'large');fs.mkdirSync(large);
    for(let i=0;i<5000;i++)fs.linkSync(join(directory,'file'),join(large,'entry-'+i));
    const before=descriptorCount();
    const observations=[];
    for(const limit of [0,2,4096]) {
      reset();
      assert.throws(()=>listDirectory(large,limit),error=>error.code==='DIRECTORY_LIMIT');
      assert.equal(calls.opendir,1);assert.equal(calls.closedir,1);
      assert.ok(calls.readdir64>=limit+1&&calls.readdir64<=limit+3);
      observations.push({limit,...calls});
    }
    reset();for(const entry of iterateDirectory(large)){assert.match(entry.name,/^entry-/);break;}
    assert.equal(calls.closedir,1);assert.ok(calls.readdir64<=3);
    const marker=new Error('consumer failure');
    reset();assert.throws(()=>{for(const entry of iterateDirectory(large))throw marker;},error=>error===marker);
    assert.equal(calls.closedir,1);
    assert.equal(descriptorCount(),before);
    const pinned=fs.openSync(directory,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
    try {
      fs.renameSync(directory,join(root,'moved'));fs.symlinkSync(large,directory);
      assert.throws(()=>listDirectory(directory),error=>error.code==='UNSAFE_DIRECTORY');
      assert.deepEqual([...iterateDirectory('/proc/self/fd/'+pinned)].map(entry=>entry.name).sort(),exact.map(entry=>entry.name).sort());
    } finally {fs.closeSync(pinned);}
    console.log(JSON.stringify({observations,descriptorsBefore:before,descriptorsAfter:descriptorCount()}));
  `);
  assert.deepEqual(result.observations.map(item => item.limit), [0, 2, 4096]);
  assert.equal(result.descriptorsAfter, result.descriptorsBefore);
});

test('native directory errors preserve errno and release the stream before later operations', async t => {
  const result = await directoryProbe(t, `
    const original=ffi.dlopen;
    let invalidate=true,closes=0;
    ffi.dlopen=(path,symbols)=>{
      const library=original(path,{...symbols,dirfd:{args:['ptr'],returns:'i32'}});
      const read=library.symbols.readdir64,close=library.symbols.closedir;
      library.symbols.readdir64=directory=>{
        // Invalidate the real descriptor once; the actual libc read returns EBADF.
        if(invalidate){invalidate=false;fs.closeSync(library.symbols.dirfd(directory));}
        return read(directory);
      };
      library.symbols.closedir=directory=>{closes++;return close(directory);};
      return library;
    };
    const before=descriptorCount();
    assert.throws(()=>listDirectory(directory),error=>error.code==='DIRECTORY_UNAVAILABLE'&&error.systemCode==='EBADF'&&error.cause.syscall==='readdir64');
    assert.equal(closes,1);
    assert.deepEqual(listDirectory(directory,0),[]);
    assert.equal(closes,2);
    assert.throws(()=>[...iterateDirectory(join(root,'missing'))],error=>error.code==='ENOENT'&&error.errno===2);
    const file=join(root,'file');fs.writeFileSync(file,'body');
    assert.throws(()=>[...iterateDirectory(file)],error=>error.code==='ENOTDIR'&&error.errno===20);
    assert.deepEqual(listDirectory(directory,0),[],'prior errno cannot turn EOF into a failure');
    assert.equal(descriptorCount(),before);
    console.log(JSON.stringify({nativeReadError:'EBADF',closes,descriptorsBefore:before,descriptorsAfter:descriptorCount()}));
  `);
  assert.equal(result.nativeReadError, 'EBADF');
  assert.equal(result.descriptorsAfter, result.descriptorsBefore);
});

test('unsupported or missing directory capabilities stay local and do not block stateless MCP', async t => {
  const result = await directoryProbe(t, `
    const originalArch=Object.getOwnPropertyDescriptor(process,'arch');
    Object.defineProperty(process,'arch',{...originalArch,value:'arm64'});
    assert.throws(()=>listDirectory(directory),error=>error.code==='DIRECTORY_UNAVAILABLE'&&error.systemCode==='DIRECTORY_RUNTIME_UNSUPPORTED');
    Object.defineProperty(process,'arch',originalArch);
    const original=ffi.dlopen;
    ffi.dlopen=()=>{throw new Error('injected missing native capability');};
    assert.throws(()=>listDirectory(directory),error=>error.status==='unavailable'&&error.systemCode==='DIRECTORY_RUNTIME_UNAVAILABLE');
    const output=new PassThrough();let emitted='';output.on('data',bytes=>emitted+=bytes);
    await serveMcp({serverInfo:{name:'capability-failure-fixture',version:'1'},tools:[],validateCall:()=>{},handleCall:()=>{},
      input:Readable.from([JSON.stringify({jsonrpc:'2.0',id:1,method:'ping'})+'\\n']),output});
    assert.deepEqual(JSON.parse(emitted).result,{});
    ffi.dlopen=original;
    assert.deepEqual(listDirectory(directory,0),[]);
    console.log(JSON.stringify({unavailable:'local',unrelatedPing:'completed',laterEnumeration:'completed'}));
  `);
  assert.deepEqual(result, { unavailable: 'local', unrelatedPing: 'completed', laterEnumeration: 'completed' });
});

test('actual stdio transport emits parse/method/tool/argument errors and survives oversized input', async t => {
  const fixture = makeFixture(t, 'probe-hook');
  const messages = [initialize, { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'not-a-method' },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'unknown', arguments: { text: 'not logged' } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'probe_echo', arguments: { text: 42 } } }];
  const input = messages.map(value => JSON.stringify(value)).join('\n') + '\n{broken\n' +
    'x'.repeat(1024 * 1024 + 1) + '\n' + JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'ping' }) + '\n';
  const result = await runMcp(probeScript, input, { env: fixture.env, cwd: fixture.workspaceDir });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.responses.find(value => value.id === 1).result.protocolVersion, '2025-06-18');
  assert.equal(result.responses.find(value => value.id === 2).result.tools[0].inputSchema.additionalProperties, false);
  assert.equal(result.responses.find(value => value.id === 3).error.code, -32601);
  assert.equal(result.responses.find(value => value.id === 4).error.code, -32602);
  assert.equal(result.responses.find(value => value.id === 5).error.code, -32602);
  assert.equal(result.responses.filter(value => value.id === null && value.error.code === -32700).length, 1);
  assert.equal(result.responses.filter(value => value.id === null && value.error.code === -32600).length, 1);
  assert.deepEqual(result.responses.find(value => value.id === 6).result, {});
  assert.equal(fs.existsSync(fixture.pluginDataDir), false);
});

test('transport caps concurrent admitted requests without dispatching overflow or notifications', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let emitted = '';
  output.on('data', bytes => { emitted += bytes; });
  let admitted = 0;
  const release = [];
  const serving = serveMcp({ serverInfo: { name: 'bounded-fixture', version: '1' }, input, output,
    tools: [{ name: 'wait', inputSchema: { type: 'object' } }], validateCall: (_name, args) => args,
    handleCall: async () => { admitted += 1; await new Promise(resolve => release.push(resolve)); return { content: [] }; } });
  input.write(Array.from({ length: 70 }, (_, index) => JSON.stringify({ jsonrpc: '2.0', id: index, method: 'tools/call', params: { name: 'wait', arguments: {} } })).join('\n') + '\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'wait', arguments: {} } }) + '\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(admitted, 64);
  assert.equal(emitted.trim().split('\n').map(JSON.parse).filter(value => value.error?.code === -32000).length, 6);
  release.forEach(resolve => resolve()); input.end(); await serving;
  assert.equal(emitted.trim().split('\n').length, 70);
});

test('safe reads distinguish absence and reject symlinks, special files, oversized data and invalid UTF-8', async t => {
  const fixture = makeFixture(t, 'probe-hook');
  const dir = join(fixture.root, 'files'); safeDirectory(dir);
  assert.equal(readRegular(join(dir, 'missing')), null);
  assert.equal(safeSessionId('legacy.session-1'), 'legacy.session-1');
  for (const id of ['.', '..', '../x', 'bad/id', 'space id', 'x\u0000']) assert.throws(() => safeSessionId(id), RuntimeError);
  const original = join(dir, 'original'); fs.writeFileSync(original, 'original bytes');
  fs.symlinkSync(original, join(dir, 'link'));
  fs.symlinkSync(dir, join(fixture.root, 'alias'));
  assert.throws(() => readRegular(join(dir, 'link')), error => error.code === 'UNSAFE_FILE');
  assert.throws(() => readRegular(join(fixture.root, 'alias', 'original')), error => error.code === 'UNSAFE_DIRECTORY');
  assert.throws(() => atomicWrite(join(fixture.root, 'alias', 'original'), 'wrong'));
  assert.equal(fs.readFileSync(original, 'utf8'), 'original bytes');
  const fifo = join(dir, 'fifo');
  assert.equal(spawnSync('/usr/bin/mkfifo', [fifo]).status, 0);
  assert.throws(() => readRegular(fifo), error => error.code === 'NOT_REGULAR_FILE');
  assert.throws(() => readRegular(original, 3), error => error.code === 'FILE_TOO_LARGE');
  fs.writeFileSync(join(dir, 'invalid'), Buffer.from([0xc3, 0x28]));
  assert.throws(() => decodeRecord(readRegular(join(dir, 'invalid'))), error => error.code === 'INVALID_UTF8');
  assert.throws(() => listDirectory(dir, 2), error => error.code === 'DIRECTORY_LIMIT');
});

test('streamed guide inspection hashes the full bounded file and marks oversized freshness unavailable', t => {
  const fixture = makeFixture(t, 'agent-state');
  const file = join(fixture.root, 'guide.md');
  fs.writeFileSync(file, '😀' + 'a'.repeat(9000) + 'z');
  const first = inspectRegular(file, { prefixBytes: 3, maxHashBytes: 10000 });
  assert.equal(decodeRecord(first), '');
  assert.equal(first.hashComplete, true);
  assert.equal(first.hash, createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
  fs.writeFileSync(file, '😀' + 'a'.repeat(9000) + 'y');
  assert.notEqual(inspectRegular(file, { prefixBytes: 3, maxHashBytes: 10000 }).hash, first.hash);
  const oversized = inspectRegular(file, { prefixBytes: 100, maxHashBytes: 1000 });
  assert.equal(oversized.bytes.length, 100);
  assert.equal(oversized.hash, null);
  assert.equal(oversized.hashComplete, false);
});

test('atomic writes and immutable records preserve actual before/after-rename outcomes', t => {
  const fixture = makeFixture(t, 'control-task');
  const path = join(fixture.root, 'state.json');
  assert.equal(atomicWrite(path, 'old').status, 'committed');
  assert.equal(atomicWrite(path, 'old').status, 'unchanged');
  assert.equal(writeExclusive(path, 'replace forbidden').status, 'exists');
  assert.equal(fs.readFileSync(path, 'utf8'), 'old');
  const oldRename = fs.renameSync;
  const oldSync = fs.fsyncSync;
  try {
    fs.renameSync = () => { throw Object.assign(new Error('injected rename failure'), { code: 'EIO' }); };
    assert.throws(() => atomicWrite(path, 'new'), error => error.code === 'WRITE_FAILED' && error.committed === false && error.phase === 'before_rename');
    assert.equal(fs.readFileSync(path, 'utf8'), 'old');
    let replaced = false;
    fs.renameSync = (...args) => { oldRename(...args); replaced = true; };
    fs.fsyncSync = fd => { if (replaced) throw Object.assign(new Error('injected directory sync failure'), { code: 'EIO' }); oldSync(fd); };
    assert.throws(() => atomicWrite(path, 'new'), error => error.code === 'WRITE_UNCERTAIN' && error.status === 'uncertain' && error.committed === true);
    assert.equal(fs.readFileSync(path, 'utf8'), 'new');
  } finally { fs.renameSync = oldRename; fs.fsyncSync = oldSync; }
});

test('two real writer processes serialize and domain errors remain domain errors', async t => {
  const fixture = makeFixture(t, 'control-task');
  const directory = join(fixture.root, 'locked');
  const script = join(fixture.root, 'writer.mjs');
  fs.writeFileSync(script, `import {readRegular,atomicWrite,withSessionLock} from ${JSON.stringify(pathToFileURL(join(repositoryRoot, 'runtime/storage.mjs')).href)};
    import {join} from 'node:path';
    const directory=process.argv[2];
    for(let i=0;i<12;i++) await withSessionLock(directory,()=>{const file=join(directory,'count');const n=Number(readRegular(file)?.bytes.toString()??'0');atomicWrite(file,String(n+1));});
    process.stdout.write('completed\\n');`);
  const results = await Promise.all([runScript(script, '', { env: fixture.env, args: [directory] }), runScript(script, '', { env: fixture.env, args: [directory] })]);
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.readFileSync(join(directory, 'count'), 'utf8'), '24');
  const domainError = new Error('domain failure');
  await assert.rejects(withSessionLock(directory, () => { throw domainError; }), error => error === domainError);
});

test('flock has a bounded busy result and a killed holder releases kernel ownership', async t => {
  const fixture = makeFixture(t, 'agent-state');
  const directory = join(fixture.root, 'locked');
  const script = join(fixture.root, 'holder.mjs');
  fs.writeFileSync(script, `import {withSessionLock} from ${JSON.stringify(pathToFileURL(join(repositoryRoot, 'runtime/storage.mjs')).href)};
    await withSessionLock(process.argv[2],async()=>{process.stdout.write('locked\\n');await new Promise(()=>setInterval(()=>{},1000));});`);
  const child = spawn(process.execPath, [script, directory], { env: fixture.env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error('holder exited before acquiring'); })]);
  const started = Date.now();
  await assert.rejects(withSessionLock(directory, () => 'unexpected'), error => error.code === 'LOCK_BUSY');
  assert.ok(Date.now() - started < 3000);
  const closed = once(child, 'exit'); child.kill('SIGKILL'); await closed;
  assert.equal(await withSessionLock(directory, () => 'released'), 'released');
});

test('native receipt validation rejects argument/provenance/error spoofing while leaving expiry to admission', t => {
  const fixture = makeFixture(t, 'control-task');
  const args = { taskBody: 'canonical synthetic task', reason: 'fixture' };
  const tools = [{ name: 'control_task_set' }];
  const validateCall = (_name, value) => { if (Object.keys(value).sort().join(',') !== 'reason,taskBody') throw new RuntimeError('INVALID_ARGUMENTS', 'Invalid arguments.'); return value; };
  const result = createPendingReceipt('control-task', 'control_task_set', args, { now: 1000 });
  assert.match(result.content[0].text, /PENDING_HOST_COMMIT/);
  assert.equal(JSON.stringify(result.structuredContent).includes(args.taskBody), false);
  const payload = postToolPayload({ plugin: 'control-task', operation: 'control_task_set', args, result, cwd: fixture.workspaceDir });
  assert.equal(validatePendingReceipt(payload, 'control-task', { tools, validateCall }).receipt, result.structuredContent);
  assert.throws(() => assertReceiptFresh(result.structuredContent, { now: 1000 + RECEIPT_MAX_AGE_MS + RECEIPT_CLOCK_SKEW_MS + 1 }), error => error.code === 'RECEIPT_EXPIRED');
  assert.equal(validateReceiptShape(result.structuredContent), result.structuredContent);
  for (const mutate of [p => { p.tool_input.taskBody = 'spoof'; }, p => { p.tool_response.details.plugin = 'other'; },
    p => { p.tool_response.details.server = 'other'; }, p => { p.tool_response.details.mcp.isError = true; },
    p => { p.tool_response.details.mcp.structuredContent.sessionId = 'spoof'; }]) {
    const changed = structuredClone(payload); mutate(changed);
    assert.throws(() => validatePendingReceipt(changed, 'control-task', { tools, validateCall }), RuntimeError);
  }
  assert.equal(validatePendingReceipt({ ...payload, tool_name: 'other_tool' }, 'control-task', { tools, validateCall }), null);
});

test('identity and read-only native lineage use current exact columns and preserve workspace binding', async t => {
  const fixture = makeFixture(t, 'agent-state');
  const payload = { hook_event_name: 'SubagentStart', session_id: 'child.session', cwd: fixture.workspaceDir,
    agent_id: 'different-agent-id', agent_type: 'worker' };
  const identity = resolveHookIdentity(payload, 'agent-state', { env: fixture.env });
  assert.equal(identity.sessionId, 'child.session');
  assert.notEqual(identity.agentId, identity.sessionId);
  assert.throws(() => resolveHookIdentity(payload, 'agent-state', { env: { PLUGIN_DATA: join(fixture.root, '.plugin-data/agent-state') } }));
  assert.equal((await readNativeLineage(identity)).status, 'unavailable');
  const file = await writeNativeSessions(fixture.dataDir, [
    { sessionId: 'child.session', parentSessionId: 'parent', workspaceDir: fixture.workspaceDir, recordJson: '{"parentSessionId":"spoof"}' },
    { sessionId: 'parent', parentSessionId: 'grandparent', workspaceDir: join(fixture.root, 'different-parent-workspace') },
    { sessionId: 'unrelated', workspaceDir: fixture.workspaceDir },
  ]);
  const before = fs.readFileSync(file);
  const lineage = await readNativeLineage(identity);
  assert.equal(lineage.status, 'ok'); assert.equal(lineage.parent.sessionId, 'parent');
  assert.equal(lineage.current.parentSessionId, 'parent');
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal((await readNativeLineage({ ...identity, sessionId: "' OR 1=1 --" })).status, 'unavailable');
  const initial = resolveWorkspaceBinding(null, identity, lineage);
  const moved = { ...identity, workspaceDir: join(fixture.root, 'native-new-workspace') };
  assert.throws(() => resolveWorkspaceBinding(initial, moved), error => error.code === 'WORKSPACE_BINDING_CONFLICT');
  assert.equal((await readNativeLineage(moved)).currentVerified, false);
  await writeNativeSessions(fixture.dataDir, [{ sessionId: 'child.session', parentSessionId: 'missing-parent', workspaceDir: moved.workspaceDir }]);
  const updatedLineage = await readNativeLineage(moved);
  assert.equal(updatedLineage.status, 'unavailable'); assert.equal(updatedLineage.currentVerified, true);
  const binding = resolveWorkspaceBinding(initial, moved, updatedLineage);
  assert.equal(binding.initialWorkspaceDir, fixture.workspaceDir); assert.equal(binding.currentWorkspaceDir, moved.workspaceDir);
  assert.equal(resolveWorkspaceBinding(binding, { ...moved, agentId: null, agentType: null }).agentType, 'worker');
  assert.throws(() => resolveWorkspaceBinding({}, identity), error => error.code === 'BINDING_UNAVAILABLE');
});

test('native lineage rejects a composite primary key with ambiguous session rows', async t => {
  const fixture = makeFixture(t, 'agent-state');
  const directory = join(fixture.dataDir, 'v2', 'sqlite');
  fs.mkdirSync(directory, { recursive: true });
  const path = join(directory, 'runtime-state.sqlite');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE local_runtime_sessions (
      session_id TEXT, parent_session_id TEXT, workspace_dir TEXT, agent_name TEXT,
      created_at_ms INTEGER, history_relative_dir TEXT, columnar_version INTEGER,
      PRIMARY KEY (session_id, created_at_ms)
    )`);
    const insert = db.prepare('INSERT INTO local_runtime_sessions VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const [sessionId, parentId, createdAt] of [
      ['child', 'parent-first', 1], ['child', 'parent-second', 2],
      ['parent-first', null, 3], ['parent-second', null, 4],
    ]) insert.run(sessionId, parentId, fixture.workspaceDir, 'fixture-agent', createdAt, null, 3);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM local_runtime_sessions WHERE session_id = ?').get('child').count, 2);
  } finally { db.close(); }
  const before = fs.readFileSync(path);
  const lineage = await readNativeLineage({ dataDir: fixture.dataDir, sessionId: 'child', workspaceDir: fixture.workspaceDir });
  assert.deepEqual({ status: lineage.status, code: lineage.code ?? null,
    currentVerified: lineage.currentVerified, parent: lineage.parent?.sessionId ?? null },
  { status: 'unavailable', code: 'NATIVE_SCHEMA_UNSUPPORTED', currentVerified: false, parent: null },
  'Unsupported schema must not choose an arbitrary parent from duplicate current child rows');
  assert.deepEqual(fs.readFileSync(path), before, 'Reject the metadata without changing the original database');
});

test('hook parsing and emitted JSON enforce byte bounds without truncating a result', async () => {
  await assert.rejects(readHookPayload({ input: Readable.from([Buffer.alloc(1024 * 1024 + 1)]) }), error => error.code === 'HOOK_INPUT_TOO_LARGE');
  await assert.rejects(readHookPayload({ input: Readable.from(['{"hook_event_name":"SessionStart","value":"\\ud800"}']) }), error => error.code === 'INVALID_UTF8');
  const text = '"\\\n😀'.repeat(3000);
  let emitted = '';
  const bytes = hookOutputByteLength('PostToolUse', text);
  assert.ok(bytes < MAX_HOOK_OUTPUT_BYTES);
  emitHookResult('PostToolUse', text, { output: { write: line => { emitted += line; } } });
  assert.equal(JSON.parse(emitted).hookSpecificOutput.additionalContext, text);
  assert.throws(() => emitHookResult('PostToolUse', '\u0000'.repeat(12000), { output: { write: () => assert.fail('overflow emitted') } }), error => error.code === 'HOOK_OUTPUT_TOO_LARGE');
  assert.throws(() => emitHookResult('PostCompact', 'unsupported'), error => error.code === 'HOOK_CONTEXT_UNSUPPORTED');
});

test('native SQLite remains bound to the safe inode when its original pathname is replaced', async t => {
  const fixture = makeFixture(t, 'agent-state');
  const path = await writeNativeSessions(fixture.dataDir, [
    { sessionId: 'child', parentSessionId: 'intended-parent', workspaceDir: fixture.workspaceDir },
    { sessionId: 'intended-parent', workspaceDir: fixture.workspaceDir },
  ]);
  const otherData = join(fixture.root, 'other-data');
  const other = await writeNativeSessions(otherData, [
    { sessionId: 'child', parentSessionId: 'unexpected-parent', workspaceDir: fixture.workspaceDir },
    { sessionId: 'unexpected-parent', workspaceDir: fixture.workspaceDir },
  ]);
  const originalStat = fs.fstatSync;
  let swapped = false;
  try {
    // Swap immediately after the safe file was opened and identified, before
    // DatabaseSync opens its own descriptor. This is stronger than closing the
    // old preflight descriptor and swapping only afterwards.
    fs.fstatSync = function(fd, ...args) {
      const stat = originalStat.call(fs, fd, ...args);
      let target;
      try { target = fs.readlinkSync(`/proc/self/fd/${fd}`); } catch {}
      if (!swapped && target === path) {
        swapped = true; fs.renameSync(path, `${path}.original`); fs.symlinkSync(other, path);
      }
      return stat;
    };
    const lineage = await readNativeLineage({ dataDir: fixture.dataDir, sessionId: 'child', workspaceDir: fixture.workspaceDir });
    assert.equal(swapped, true);
    assert.equal(lineage.status, 'ok'); assert.equal(lineage.parent.sessionId, 'intended-parent');
  } finally { fs.fstatSync = originalStat; }
});

test('native read-only SQLite sees current uncheckpointed WAL rows', async t => {
  const fixture = makeFixture(t, 'agent-state');
  const path = await writeNativeSessions(fixture.dataDir, [
    { sessionId: 'child', parentSessionId: null, workspaceDir: fixture.workspaceDir },
    { sessionId: 'parent', workspaceDir: fixture.workspaceDir },
  ]);
  const { DatabaseSync } = await import('node:sqlite');
  const writer = new DatabaseSync(path);
  try {
    writer.exec('PRAGMA journal_mode=WAL;');
    writer.prepare('UPDATE local_runtime_sessions SET parent_session_id=? WHERE session_id=?').run('parent', 'child');
    assert.equal(fs.existsSync(`${path}-wal`), true);
    const lineage = await readNativeLineage({ dataDir: fixture.dataDir, sessionId: 'child', workspaceDir: fixture.workspaceDir });
    assert.equal(lineage.status, 'ok'); assert.equal(lineage.parent.sessionId, 'parent');
  } finally { writer.close(); }
});

test('metadata diagnostics have byte caps, rotate one prior file and never retain arbitrary content', async t => {
  const fixture = makeFixture(t, 'probe-hook');
  const context = { plugin: 'probe-hook', sessionId: '😀'.repeat(200), location: '😀'.repeat(400), taskBody: 'SECRET_SENTINEL' };
  const line = diagnosticRecord('BOUNDED', context);
  assert.ok(Buffer.byteLength(line) <= 512); assert.equal(line.includes('SECRET_SENTINEL'), false); JSON.parse(line);
  const directory = join(fixture.root, 'logs'); safeDirectory(directory);
  fs.writeFileSync(join(directory, 'runtime.log'), 'x'.repeat(MAX_LOG_BYTES - 1));
  await appendBoundedLog(directory, 'runtime.log', diagnosticRecord('ROTATED', { plugin: 'probe-hook' }));
  assert.equal(fs.statSync(join(directory, 'runtime.log.previous')).size, MAX_LOG_BYTES - 1);
  assert.ok(fs.statSync(join(directory, 'runtime.log')).size < 512);
  const blocked = join(fixture.root, 'blocked'); fs.writeFileSync(blocked, 'not a directory');
  let stderr = '';
  const outcome = await boundedDiagnostic('PRIMARY_FAILURE', { logDirectory: blocked, taskBody: 'SECRET_SENTINEL' }, { stderr: { write: value => { stderr += value; } } });
  assert.equal(outcome.status, 'stderr_only'); assert.match(stderr, /PRIMARY_FAILURE/); assert.equal(stderr.includes('SECRET_SENTINEL'), false);
});
