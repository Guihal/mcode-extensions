#!/usr/bin/env bun
// Isolate each ordinary fixture file: several tests change process state.
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const version = readFileSync(join(root, '.bun-version'), 'utf8').trim();
if (process.versions.bun !== version) {
  process.stderr.write(`Use Bun ${version} to run bun scripts/test.mjs.\n`);
  process.exit(2);
}
if (process.argv.length !== 2) {
  process.stderr.write('Usage: bun scripts/test.mjs\n');
  process.exit(2);
}
const native = new Set(['mcode-host-contract.test.mjs', 'mcode-ports-host.test.mjs']);
const files = readdirSync(join(root, 'tests')).filter(name => name.endsWith('.test.mjs') && !native.has(name)).sort();
let failures = 0;
for (const name of files) {
  process.stdout.write(`\nBun ${version}: tests/${name}\n`);
  const result = await new Promise(resolve => {
    const child = spawn(process.execPath, ['test', '--timeout', '60000', `tests/${name}`], {
      cwd: root, stdio: 'inherit', timeout: 180000, killSignal: 'SIGKILL',
    });
    child.once('error', error => resolve({ error }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  if (result.code !== 0) {
    failures++;
    process.stderr.write(`Failed tests/${name}: ${result.error?.message ?? result.signal ?? `exit ${result.code}`}\n`);
  }
}
process.stdout.write(`\nOrdinary files: ${files.length - failures} passed, ${failures} failed.\n`);
process.stdout.write('Native checks are separate: tests/mcode-host-contract.test.mjs and tests/mcode-ports-host.test.mjs use Node with MCODE_HOST_PACKAGE and MCODE_BUN_BINARY (see README).\n');
process.exitCode = failures ? 1 : 0;
