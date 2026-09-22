import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

const TERMINAL = new Set(['COMPLETED', 'SUPERSEDED', 'SUPERSEDED_WITH_REASON', 'EXTERNAL_GATE', 'BLOCKED_EXTERNAL', 'REJECTED_WITH_REASON']);

test('every Execution Dossier III packet is in a terminal state', () => {
  const text = read('docs/program/PACKET-INVENTORY.md');
  const rows = text.split(/\r?\n/).filter((line) => /^\| `WP-[A-Z]\d{2}` \|/.test(line));
  assert.equal(rows.length, 76, `expected all 76 dossier packets, saw ${rows.length}`);
  const nonTerminal: string[] = [];
  for (const row of rows) {
    const match = /^\| `(WP-[A-Z]\d{2})` \| [^|]+ \| `([^`]+)` \|/.exec(row);
    assert.ok(match, `malformed packet row: ${row}`);
    if (!TERMINAL.has(match[2]!)) nonTerminal.push(`${match[1]}=${match[2]}`);
  }
  assert.deepEqual(nonTerminal, [], `non-terminal dossier packets: ${nonTerminal.join(', ')}`);
});

test('every Foundational Audit II finding is terminal and represented exactly once', () => {
  const text = read('docs/program/AUDIT-REGISTER.md');
  const rows = text.split(/\r?\n/).filter((line) => /^\| AII-\d{3} \|/.test(line));
  assert.equal(rows.length, 36, `expected 36 primary Audit II findings, saw ${rows.length}; archival tables must not mimic primary rows`);
  const ids = new Set<string>();
  const nonTerminal: string[] = [];
  for (const row of rows) {
    const cols = row.split('|').map((part) => part.trim());
    const id = cols[1]!;
    const status = cols[4]!;
    assert.ok(!ids.has(id), `duplicate primary audit row: ${id}`);
    ids.add(id);
    if (!TERMINAL.has(status)) nonTerminal.push(`${id}=${status}`);
  }
  assert.equal(ids.size, 36);
  assert.deepEqual(nonTerminal, [], `non-terminal Audit II findings: ${nonTerminal.join(', ')}`);
});

test('the final repository gate is closed or has only the explicit exact-head verification pending', () => {
  const text = read('docs/program/FINAL-GATE.md');
  const unchecked = text.split(/\r?\n/).filter((line) => /^- \[ \]/.test(line));
  if (unchecked.length > 0) {
    assert.equal(unchecked.length, 1, `only the exact-head verification may remain pending:\n${unchecked.join('\n')}`);
    assert.match(unchecked[0]!, /exact-head CI/i);
    assert.match(unchecked[0]!, /PENDING/i);
  }
  assert.match(text, /external/i);
});
