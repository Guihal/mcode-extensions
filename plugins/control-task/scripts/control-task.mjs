#!/usr/bin/env node
/**
 * control-task — durable canonical task anchor for MiniMax Code.
 *
 * Exposes two model-facing tools over the stdio MCP transport:
 *   control_task_set  — replace the WHOLE canonical task for this session;
 *   control_task_get  — read the current canonical task back.
 *
 * The task body is stored per session in a file, so it survives compaction and
 * process restarts. A companion hook re-injects the stored body into every
 * turn; this server only owns the durable write.
 */

import { createInterface } from 'node:readline';
import {
  appendRevision,
  parseTaskBody,
  readActiveSession,
  resolveControlTask,
  stateDir,
} from './control-task-store.mjs';

const TOOLS = [
  {
    name: 'control_task_set',
    description:
      'Set the durable canonical task for this session. This is the WHOLE TASK, not just its goal: taskBody is the complete context that must survive between compactions. It carries: (1) the description of the task itself in a deliberately general form — describe WHAT is being done and what result is wanted, not a narrow enumeration of files or steps, which is easy to understate and goes stale; (2) the requirements, constraints and limitations that apply to this task; (3) the working rules specific to this task — these live HERE and are separate from the general harness rules; where a task-specific rule conflicts with a general harness rule, the task-specific rule wins for this task; (4) relevant source-of-truth paths and references. Do NOT put an acceptance/done criterion in taskBody: a narrow completion checklist misleads and tends to end the task early. Do NOT put a narrow scope (an itemized list of files or steps) in taskBody either — keep the task statement general enough to survive later refinement. Never put transient state here: no current step, no plan, no last tool outcomes, no blockers, no progress — that is conversation-only working memory. Call it ONLY when the task definition materially changes (goal change, added or removed durable requirement, corrected source of truth, task-specific rule change, explicit cancellation of part of the task). Ordinary user corrections, step instructions and tone apply to your current reasoning and must not rewrite this anchor. The write atomically replaces the previous canonical task.',
    inputSchema: {
      type: 'object',
      properties: {
        taskBody: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['taskBody', 'reason'],
    },
  },
  {
    name: 'control_task_get',
    description:
      'Read the durable canonical task for this session. Returns the stored task body, or reports that no task has been set yet.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function text(value) {
  return { content: [{ type: 'text', text: value }] };
}

function currentSessionId() {
  return readActiveSession();
}

function toolSet(args) {
  const reason = args && typeof args.reason === 'string' ? args.reason.trim() : '';
  if (!reason) {
    return text('control_task_set rejected: reason must be a non-empty string');
  }
  const sessionId = currentSessionId();
  if (!sessionId) {
    return text(
      'control_task_set rejected: the durable task store has no active session yet (the session pointer is not initialized).',
    );
  }
  const resolution = resolveControlTask(sessionId);
  if (resolution.status === 'unavailable') {
    return text(
      `control_task_set rejected: the durable task store is unavailable (${resolution.error}); fix or remove the corrupt state file`,
    );
  }
  const parsed = parseTaskBody(args && args.taskBody);
  if (!parsed.ok) return text(`control_task_set rejected: ${parsed.error}`);
  if (resolution.status === 'current' && resolution.taskBody === parsed.value) {
    return text(
      'control_task_set rejected: the submitted task body is identical to the recorded one; the durable task is already current',
    );
  }
  const appended = appendRevision(sessionId, parsed.value);
  if (!appended.ok) {
    return text(`control_task_set rejected: ${appended.error}`);
  }
  return text('control_task_set committed (durable=file)');
}

function toolGet() {
  const sessionId = currentSessionId();
  if (!sessionId) {
    return text('control_task_get: no active session recorded yet.');
  }
  const resolution = resolveControlTask(sessionId);
  if (resolution.status === 'unavailable') {
    return text(`control_task_get: the durable task store is unavailable (${resolution.error}).`);
  }
  if (resolution.status === 'uninitialized') {
    return text('control_task_get: no canonical task has been set for this session yet.');
  }
  return text(resolution.taskBody);
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
        serverInfo: { name: 'control-task', version: '0.1.0' },
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
    try {
      if (name === 'control_task_set') result = toolSet(args);
      else if (name === 'control_task_get') result = toolGet();
      else result = text(`unknown tool: ${String(name)}`);
    } catch (error) {
      result = text(`control-task internal error: ${error && error.message ? error.message : String(error)}`);
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

process.stderr.write(`control-task mcp ready (state=${stateDir()})\n`);
