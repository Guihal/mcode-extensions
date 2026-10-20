#!/usr/bin/env bun
// MCP has no trusted calling session. It validates and issues a pending receipt;
// the registered native PostToolUse hook owns every session read and mutation.
import { serveMcp } from './runtime/transport.mjs';
import { createPendingReceipt } from './runtime/host.mjs';
import { TOOLS, VERSION, validateCall } from './control-task-core.mjs';

await serveMcp({
  serverInfo: { name: 'control-task', version: VERSION },
  tools: TOOLS,
  validateCall,
  handleCall: (name, args) => createPendingReceipt('control-task', name, args),
});
