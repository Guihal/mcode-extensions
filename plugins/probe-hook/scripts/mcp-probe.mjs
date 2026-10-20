#!/usr/bin/env node
import { join } from 'node:path';
import { serveMcp, isPlainObject } from './runtime/transport.mjs';
import { resolvePluginDataRoot } from './runtime/host.mjs';
import { RuntimeError, appendBoundedLog, diagnosticRecord, boundedDiagnostic } from './runtime/storage.mjs';
import { readProbeConfig } from './probe-config.mjs';

const config = readProbeConfig();
const tools = [{ name: 'probe_echo',
  description: 'Opt-in diagnostic echo. The packaged probe.config.json is disabled by default. When enabled, returns bounded text and the actual metadata-log write status; echo text is never logged.',
  inputSchema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', maxLength: 4096 } }, required: ['text'] } }];

function validateCall(name, args) {
  if (name !== 'probe_echo' || !isPlainObject(args) || Object.keys(args).length !== 1 ||
      typeof args.text !== 'string' || !args.text.isWellFormed() || args.text.length > 4096 || Buffer.byteLength(args.text) > 16 * 1024) {
    throw new RuntimeError('INVALID_ARGUMENTS', 'probe_echo requires only text, at most 4096 Unicode characters and 16 KiB UTF-8.', { status: 'rejected' });
  }
  return { text: args.text };
}

await boundedDiagnostic(`PROBE_CONFIG_${config.status.toUpperCase()}`, { plugin: 'probe-hook', location: config.path });

await serveMcp({ serverInfo: { name: 'probe-mcp', version: '0.1.0' }, tools, validateCall,
  async handleCall(name, args) {
    if (!config.enabled) return { content: [{ type: 'text', text: `PROBE-MCP-DISABLED: packaged configuration status=${config.status}. No diagnostic storage was attempted.` }],
      structuredContent: { status: 'disabled', configuration: config.status } };
    let stateFile;
    try {
      const { pluginDataDir } = resolvePluginDataRoot('probe-hook', { lane: 'mcp' });
      stateFile = join(pluginDataDir, 'tool-calls.log');
      await appendBoundedLog(pluginDataDir, 'tool-calls.log', diagnosticRecord('PROBE_MCP_TOOL',
        { plugin: 'probe-hook', operation: name, location: stateFile }));
      return { content: [{ type: 'text', text: `PROBE-MCP-TOOL-OK: ${args.text} | stateFile=${stateFile} | exists=true` }],
        structuredContent: { status: 'committed', echo: args.text, stateFile,
          literalEnv: process.env.PROBE_LITERAL === 'literal-ok',
          expandedEnvLiteral: process.env.PROBE_EXPANDED === '${PLUGIN_DATA}' } };
    } catch (error) {
      await boundedDiagnostic(error.code ?? 'PROBE_MCP_WRITE_FAILED', { plugin: 'probe-hook', operation: name, location: stateFile });
      const status = error.committed ? 'uncertain' : 'unavailable';
      return { isError: true, content: [{ type: 'text', text: `PROBE-MCP-TOOL-FAILED: status=${status} code=${error.code ?? 'STORAGE_UNAVAILABLE'}${stateFile ? ` | stateFile=${stateFile}` : ''}. No successful diagnostic append was confirmed.` }],
        structuredContent: { status, code: error.code ?? 'STORAGE_UNAVAILABLE', ...(stateFile ? { stateFile } : {}) } };
    }
  },
});
