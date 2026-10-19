import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  let parsed = {};
  try {
    parsed = JSON.parse(input);
  } catch {
    parsed = { prompt: input.slice(0, 200) };
  }
  const event = parsed.hook_event_name || 'unknown';
  const dataDir = process.env.PLUGIN_DATA || process.env.MINIMAX_PLUGIN_DATA || '.';
  try {
    mkdirSync(dataDir, { recursive: true });
  } catch {
    // keep the probe fail-open
  }
  try {
    appendFileSync(
      join(dataDir, 'probe.log'),
      JSON.stringify({
        at: new Date().toISOString(),
        event,
        cwd: process.env.MINIMAX_PROJECT_DIR || null,
        root: process.env.PLUGIN_ROOT || null,
        stdin: input.slice(0, 2000),
      }) + '\n',
    );
  } catch {
    // keep the probe fail-open
  }
  if (event === 'UserPromptSubmit') {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: 'PROBE-HOOK-CONTEXT-MARKER-12345',
        },
      }),
    );
  }
});