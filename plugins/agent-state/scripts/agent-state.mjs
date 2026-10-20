#!/usr/bin/env bun
// The host shares this MCP process across callers. It validates arguments and
// returns a pending receipt only; it must never select or open session state.
import { serveMcp } from './runtime/transport.mjs';
import { createPendingReceipt } from './runtime/host.mjs';
import { PLUGIN, VERSION, TOOLS, validateCall } from './agent-state-core.mjs';

await serveMcp({
  serverInfo: { name: PLUGIN, version: VERSION },
  tools: TOOLS,
  validateCall,
  handleCall: (operation, args) => createPendingReceipt(PLUGIN, operation, args),
});
