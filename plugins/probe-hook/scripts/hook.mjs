#!/usr/bin/env node
import { join } from 'node:path';
import { readHookPayload, resolveHookIdentity, emitHookResult } from './runtime/host.mjs';
import { appendBoundedLog, boundedDiagnostic, diagnosticRecord } from './runtime/storage.mjs';
import { readProbeConfig } from './probe-config.mjs';

const config = readProbeConfig();
try {
  const payload = await readHookPayload();
  if (!config.enabled) {
    await boundedDiagnostic(`PROBE_CONFIG_${config.status.toUpperCase()}`, { plugin: 'probe-hook', location: config.path });
  } else {
    const identity = resolveHookIdentity(payload, 'probe-hook');
    const stateFile = join(identity.pluginDataDir, 'probe.log');
    await appendBoundedLog(identity.pluginDataDir, 'probe.log', diagnosticRecord('PROBE_NATIVE_HOOK',
      { plugin: 'probe-hook', sessionId: identity.sessionId, operation: identity.event, location: stateFile }));
    if (identity.event === 'UserPromptSubmit') emitHookResult(identity.event,
      'PROBE-HOOK-CONTEXT-MARKER-12345\nDiagnostic metadata append committed.');
  }
} catch (error) {
  await boundedDiagnostic(error.code ?? 'PROBE_HOOK_UNAVAILABLE', { plugin: 'probe-hook', location: error.path });
  // Ordinary hooks fail open, but a failed append never emits the success marker.
}
