// Both materialized entrypoints read this one packaged switch. Arbitrary
// environment toggles are not forwarded to native hooks by MiniMax Code.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeRecord, readRegular } from './runtime/storage.mjs';

export const PROBE_CONFIG_PATH = join(dirname(dirname(fileURLToPath(import.meta.url))), 'probe.config.json');

export function readProbeConfig() {
  try {
    const record = readRegular(PROBE_CONFIG_PATH, 1024);
    if (record === null) return { enabled: false, status: 'missing', path: PROBE_CONFIG_PATH };
    const config = JSON.parse(decodeRecord(record));
    if (config === null || typeof config !== 'object' || Array.isArray(config) ||
        Object.keys(config).length !== 1 || typeof config.enabled !== 'boolean') {
      return { enabled: false, status: 'invalid', path: PROBE_CONFIG_PATH };
    }
    return { enabled: config.enabled, status: config.enabled ? 'enabled' : 'disabled', path: PROBE_CONFIG_PATH };
  } catch { return { enabled: false, status: 'unavailable', path: PROBE_CONFIG_PATH }; }
}
