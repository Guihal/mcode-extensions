import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const STATE_DIR = join(homedir(), '.minimax', 'probe-state');

const TOOLS = [
  {
    name: 'probe_echo',
    description: 'Probe tool: echoes the given text back and reports the state file it wrote.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
];

function note(line) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    appendFileSync(join(STATE_DIR, 'probe.log'), line + '\n');
  } catch {
    // keep the probe fail-open
  }
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

note(
  JSON.stringify({
    at: new Date().toISOString(),
    event: 'mcp-server-started',
    stateDir: STATE_DIR,
    processCwd: process.cwd(),
    pluginData: process.env.PLUGIN_DATA ?? null,
    probeLiteral: process.env.PROBE_LITERAL ?? null,
  }),
);

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'probe-mcp', version: '0.0.1' },
      },
    });
    return;
  }
  if (message.method === 'notifications/initialized') return;
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } });
    return;
  }
  if (message.method === 'tools/call') {
    const args = (message.params && message.params.arguments) || {};
    const stateFile = join(STATE_DIR, 'tool-calls.log');
    try {
      mkdirSync(STATE_DIR, { recursive: true });
      appendFileSync(stateFile, JSON.stringify({ at: new Date().toISOString(), text: args.text }) + '\n');
    } catch {
      // keep the probe fail-open
    }
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        content: [
          {
            type: 'text',
            text:
              'PROBE-MCP-TOOL-OK: ' +
              String(args.text || '') +
              ' | stateFile=' +
              stateFile +
              ' | exists=' +
              String(existsSync(stateFile)),
          },
        ],
      },
    });
    return;
  }
  if (message.id !== undefined) {
    send({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32601, message: 'method not found: ' + String(message.method) },
    });
  }
});