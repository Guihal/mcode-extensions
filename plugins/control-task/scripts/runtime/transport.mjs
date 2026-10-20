// Stateless, bounded stdio MCP transport. Protocol IDs never identify sessions.
import { RuntimeError } from './storage.mjs';

export const MAX_RPC_LINE_BYTES = 1024 * 1024;
export const MAX_IN_FLIGHT = 64;
export const MAX_RPC_OUTPUT_BYTES = 1024 * 1024;
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

export function checkJsonShape(value, { maxDepth = 64, maxNodes = 10000 } = {}) {
  const stack = [[value, 0]];
  let nodes = 0;
  while (stack.length) {
    const [item, depth] = stack.pop();
    if (++nodes > maxNodes || depth > maxDepth) throw new RuntimeError('JSON_COMPLEXITY', 'JSON exceeds its structural bound.', { status: 'rejected' });
    if (typeof item === 'string' && !item.isWellFormed()) throw new RuntimeError('INVALID_UTF8', 'JSON contains an unpaired surrogate.', { status: 'rejected' });
    if (item && typeof item === 'object') {
      if (!Array.isArray(item) && !isPlainObject(item)) throw new RuntimeError('INVALID_JSON', 'JSON contains an unsupported object.', { status: 'rejected' });
      for (const key of Object.keys(item)) {
        if (!key.isWellFormed()) throw new RuntimeError('INVALID_UTF8', 'JSON contains an invalid property name.', { status: 'rejected' });
        stack.push([item[key], depth + 1]);
      }
    }
  }
}

function errorMessage(error, fallback) {
  // Validator messages describe a field/constraint; internal I/O error details
  // are not reflected into MCP responses or stdout diagnostics.
  if (error instanceof RuntimeError || error?.name === 'InvalidArgumentsError') {
    return typeof error.message === 'string' ? error.message.slice(0, 400) : fallback;
  }
  return fallback;
}

/** Resolves after EOF and admitted requests finish. No storage or identity I/O. */
export async function serveMcp({ serverInfo, tools, validateCall, handleCall,
  input = process.stdin, output = process.stdout }) {
  const toolMap = new Map(tools.map(tool => [tool.name, tool]));
  if (toolMap.size !== tools.length || typeof validateCall !== 'function' || typeof handleCall !== 'function') {
    throw new RuntimeError('INVALID_SERVER', 'The MCP server contract is invalid.');
  }
  let inFlight = 0;
  let ended = false;
  let closed = false;
  let buffer = Buffer.alloc(0);
  let discarding = false;
  let finish;
  const completion = new Promise(resolve => { finish = resolve; });
  const activeIds = new Set();
  const maybeFinish = () => { if (ended && inFlight === 0) finish(); };
  const send = message => {
    if (closed) return;
    let line = JSON.stringify(message) + '\n';
    if (Buffer.byteLength(line) > MAX_RPC_OUTPUT_BYTES) {
      line = JSON.stringify({ jsonrpc: '2.0', id: message.id ?? null,
        error: { code: -32603, message: 'MCP result exceeds the output byte bound.' } }) + '\n';
    }
    // A reader that stops consuming must not grow an unbounded stdout queue.
    if ((output.writableLength ?? 0) + Buffer.byteLength(line) > 2 * MAX_RPC_OUTPUT_BYTES) {
      closed = true; ended = true; input.pause?.(); input.destroy?.(); maybeFinish(); return;
    }
    try { output.write(line); }
    catch { closed = true; ended = true; input.destroy?.(); maybeFinish(); }
  };
  const error = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
  const dispatch = async message => {
    const id = message.id;
    if (message.method === 'initialize') {
      if (!isPlainObject(message.params) || typeof message.params.protocolVersion !== 'string') {
        error(id, -32602, 'initialize requires a protocolVersion.'); return;
      }
      send({ jsonrpc: '2.0', id, result: {
        protocolVersion: PROTOCOL_VERSIONS.includes(message.params.protocolVersion) ? message.params.protocolVersion : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} }, serverInfo,
      } });
    } else if (message.method === 'ping') send({ jsonrpc: '2.0', id, result: {} });
    else if (message.method === 'tools/list') send({ jsonrpc: '2.0', id, result: { tools } });
    else if (message.method === 'tools/call') {
      const params = message.params;
      if (!isPlainObject(params) || typeof params.name !== 'string' || !toolMap.has(params.name)) {
        error(id, -32602, 'Unknown or missing tool name.'); return;
      }
      const raw = params.arguments ?? {};
      if (!isPlainObject(raw)) { error(id, -32602, 'Tool arguments must be an object.'); return; }
      let args;
      try { args = await validateCall(params.name, raw); }
      catch (cause) { error(id, -32602, errorMessage(cause, 'Tool arguments are invalid.')); return; }
      try {
        const result = await handleCall(params.name, args);
        if (!isPlainObject(result) || !Array.isArray(result.content)) throw new Error('invalid result');
        send({ jsonrpc: '2.0', id, result });
      } catch (cause) {
        send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text',
          text: errorMessage(cause, 'The tool could not complete its operation.') }] } });
      }
    } else error(id, -32601, 'Method not found.');
  };
  const accept = line => {
    if (!line.length || line.every(byte => [9, 13, 32].includes(byte))) return;
    let message;
    try {
      message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
      checkJsonShape(message);
    } catch { error(null, -32700, 'Invalid JSON or bounded JSON structure.'); return; }
    const hasId = isPlainObject(message) && Object.hasOwn(message, 'id');
    const validId = hasId && (typeof message.id === 'string' && message.id.length <= 256 ||
      typeof message.id === 'number' && Number.isFinite(message.id));
    if (!isPlainObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' ||
        message.method.length > 200 || hasId && !validId) {
      error(validId ? message.id : null, -32600, 'Invalid JSON-RPC request.'); return;
    }
    // Notifications never receive responses and never invoke tool handlers.
    if (!hasId) return;
    if (inFlight >= MAX_IN_FLIGHT) { error(message.id, -32000, 'Too many in-flight MCP requests.'); return; }
    const key = `${typeof message.id}:${message.id}`;
    if (activeIds.has(key)) { error(message.id, -32600, 'Duplicate in-flight request id.'); return; }
    inFlight += 1; activeIds.add(key);
    void dispatch(message).catch(() => error(message.id, -32603, 'Internal MCP protocol error.')).finally(() => {
      inFlight -= 1; activeIds.delete(key); maybeFinish();
    });
  };
  const onData = data => {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    let offset = 0;
    while (offset < chunk.length && !closed) {
      const newline = chunk.indexOf(10, offset);
      const end = newline === -1 ? chunk.length : newline;
      const length = end - offset;
      if (!discarding && buffer.length + length > MAX_RPC_LINE_BYTES) {
        buffer = Buffer.alloc(0); discarding = true;
        error(null, -32600, 'MCP input line exceeds 1 MiB.');
      }
      if (!discarding) buffer = buffer.length ? Buffer.concat([buffer, chunk.subarray(offset, end)]) : Buffer.from(chunk.subarray(offset, end));
      if (newline !== -1) {
        if (!discarding) accept(buffer);
        buffer = Buffer.alloc(0); discarding = false;
      }
      offset = newline === -1 ? chunk.length : newline + 1;
    }
  };
  const onEnd = () => { if (buffer.length && !discarding) accept(buffer); buffer = Buffer.alloc(0); ended = true; maybeFinish(); };
  const onError = () => { ended = true; closed = true; maybeFinish(); };
  input.on('data', onData); input.once('end', onEnd); input.once('error', onError);
  output.on('error', onError);
  await completion;
  input.off('data', onData); input.off('end', onEnd); input.off('error', onError); output.off('error', onError);
}
