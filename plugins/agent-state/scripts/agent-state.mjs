#!/usr/bin/env node
/**
 * agent-state — durable reusable-guide store for MiniMax Code.
 *
 * Exposes two model-facing tools over the stdio MCP transport:
 *   agent_state_note       — save or edit one reusable guide (micro-skill);
 *   agent_state_checkpoint — save a private future-action guide.
 *
 * Guides are files under the session directory, so they survive compaction and
 * process restarts. A companion hook re-delivers the collected guides into
 * context; this server only owns the durable write.
 */

import { createInterface } from 'node:readline';
import {
  InvalidArgumentsError,
  POLICY,
  commitNote,
  readActiveSession,
  validateCheckpointArguments,
  validateNoteArguments,
} from './agent-state-store.mjs';

const TOOLS = [
  {
    name: 'agent_state_note',
    description: `${POLICY} Pass title/body and optionally an existing note_id (file index) to edit that own file; omit the index to create. Max 128KiB UTF-8. shared defaults false; true lets verified immediate child sessions read it. Internal failures are recorded only in the plugin's own log.`,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 200 },
        body: { type: 'string', minLength: 1 },
        shared: { type: 'boolean' },
        note_id: { type: 'string' },
      },
      required: ['title', 'body'],
    },
  },
  {
    name: 'agent_state_checkpoint',
    description: `Optional compatibility tool saving a private future-action guide in the same guide folder. ${POLICY} Max 80000 UTF-8 bytes. It does not set current task state or a compulsory anchor.`,
    inputSchema: {
      type: 'object',
      properties: { content: { type: 'string', minLength: 1 } },
      required: ['content'],
    },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function text(value, isError = false) {
  return { content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) };
}

function save(name, args) {
  const sessionId = readActiveSession();
  if (!sessionId) {
    return text('Guide tool failed: no active session recorded yet.', true);
  }
  try {
    let record;
    if (name === 'agent_state_note') {
      record = validateNoteArguments(args);
    } else {
      const validated = validateCheckpointArguments(args);
      record = validateNoteArguments({
        title: 'Optional compatibility guide',
        body: validated.content,
      });
    }
    const saved = commitNote(sessionId, record);
    return text(
      `Reusable guide saved: file index ${saved.note_id}; ${saved.path}. Continue the task.`,
    );
  } catch (error) {
    if (error instanceof InvalidArgumentsError) {
      return text(`Guide tool failed: ${String(error.message)}`, true);
    }
    process.stderr.write(`[agent-state] save failed: ${error && error.message}\n`);
    return text(`Guide tool failed: ${String(error && error.message ? error.message : error)}`, true);
  }
}

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
  const method = message.method;
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-state', version: '0.1.0' },
      },
    });
    return;
  }
  if (method === 'notifications/initialized') return;
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } });
    return;
  }
  if (method === 'tools/call') {
    const name = message.params && message.params.name;
    const args = (message.params && message.params.arguments) || {};
    let result;
    if (name === 'agent_state_note' || name === 'agent_state_checkpoint') {
      result = save(name, args);
    } else {
      result = text(`unknown tool: ${String(name)}`, true);
    }
    send({ jsonrpc: '2.0', id: message.id, result });
    return;
  }
  if (message.id !== undefined) {
    send({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32601, message: `method not found: ${String(method)}` },
    });
  }
});
