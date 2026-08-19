import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

test('local components do not make a global zero-egress product claim', () => {
  const main = read('src/dashboard/web/app/main.ts');
  const server = read('src/dashboard/server.ts');
  const store = read('src/store/db.ts');
  assert.match(main, /Dashboard data stays local\. Network access occurs only through explicit/);
  assert.match(main, /This page loads nothing from the internet/);
  assert.doesNotMatch(server, /like everything else, nothing leaves the machine/);
  assert.match(server, /separate explicit Fiscus actions may use\s+\* the network/);
  assert.doesNotMatch(store, /whole point of the\s+\* product is that nothing leaves the machine/);
  assert.match(store, /network-capable product actions are separate/);
});

test('CLI and README describe broad AI financial operations without overstating cross-modal evidence depth', () => {
  const cli = read('src/cli.ts');
  const readme = read('README.md');
  assert.doesNotMatch(cli, /meter and cap what your AI coding agents spend, locally/);
  assert.match(cli, /local AI financial operations/);
  assert.match(readme, /Coding-agent workflows currently\s+have the deepest validated outcome instrumentation/);
  assert.doesNotMatch(readme, /works across \*any\* token usage/);
  assert.match(readme, /explicit reported-outcome adapters/);
  assert.match(readme, /does not make the surrounding measurement system\s+immune to gaming/);
});

test('Realization Standard scopes commit gates to coding and refuses anti-gaming overclaim', () => {
  const standard = read('docs/THE-STANDARD.md');
  assert.match(standard, /For the \*\*coding adapter\*\*, the atom is the \*\*commit\*\*/);
  assert.match(standard, /explicit non-coding outcome adapters/);
  assert.match(standard, /not immune to gaming/i);
  assert.doesNotMatch(standard, /Gaming is a non-concern by design intent/);
  assert.doesNotMatch(standard, /can only be measured from inside the request path/);
});

test('financial-operations roadmap no longer describes shipped reconciliation/allocation as absent', () => {
  const roadmap = read('docs/AI-FINANCIAL-OPERATIONS-ROADMAP.md');
  assert.match(roadmap, /Source-status refresh: 2026-08-19/);
  assert.match(roadmap, /Immutable project-day reconciliation runs/);
  assert.match(roadmap, /exact-microdollar conserving runs/);
  assert.match(roadmap, /Experimental decision-ledger\/promotion mathematics exists only as pure research code/);
  assert.doesNotMatch(roadmap, /there is no bill-to-ledger comparison/);
});
