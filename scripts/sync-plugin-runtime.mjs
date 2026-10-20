#!/usr/bin/env node
// Deterministic per-package copies: native installation has no sibling root.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const plugins = ['control-task', 'agent-state', 'probe-hook'];
const modules = ['transport.mjs', 'host.mjs', 'storage.mjs'];
if (process.argv.slice(2).some(argument => argument !== '--check')) {
  process.stderr.write('Usage: node scripts/sync-plugin-runtime.mjs [--check]\n');
  process.exitCode = 2;
} else {
  let stale = 0;
  for (const plugin of plugins) for (const module of modules) {
    const source = readFileSync(join(root, 'runtime', module));
    const target = join(root, 'plugins', plugin, 'scripts', 'runtime', module);
    if (process.argv.includes('--check')) {
      let matches = false;
      try { matches = readFileSync(target).equals(source); } catch { /* Missing copy is stale. */ }
      if (!matches) { stale += 1; process.stderr.write(`Runtime copy differs: plugins/${plugin}/scripts/runtime/${module}\n`); }
    } else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, source);
    }
  }
  if (stale) process.exitCode = 1;
}
