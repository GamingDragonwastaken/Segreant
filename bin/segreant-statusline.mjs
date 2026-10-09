#!/usr/bin/env node
// Claude Code status line: `"statusLine": { "type": "command", "command": "segreant-statusline" }`.
// Deliberately bypasses the full launcher (re-exec, runtime snapshot, CLI load):
// a status line runs on every refresh and must answer in about a tenth of a
// second. Prints one line on stdout and always exits 0, so a failure here can
// never break the person's status bar.
import { readFileSync } from 'node:fs';

let line = 'segreant';
try {
  let raw = '';
  try { raw = readFileSync(0, 'utf8').slice(0, 1_000_000); } catch { raw = ''; }
  const { dbPath } = await import('../dist/config.js');
  const { statuslineLine } = await import('../dist/quota/statusline.js');
  line = statuslineLine(dbPath(), raw, Date.now());
} catch {
  line = 'segreant';
}
process.stdout.write(line + '\n');
process.exit(0);
