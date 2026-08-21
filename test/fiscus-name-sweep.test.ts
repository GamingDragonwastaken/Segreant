/**
 * Nothing in the repository still calls the product by its old name.
 *
 * `fiscus-identity.test.ts` pins the resolver's behaviour. This file pins the
 * text: a rename that leaves the old name in a CI script, an npm alias, a
 * header constant, or a page of prose has not renamed anything, it has only
 * moved the confusion somewhere a test was not looking.
 *
 * Two allowances, both narrow, both deliberate:
 *
 *   - `docs/RELEASE-GATE.md` records what was ACTUALLY run against each
 *     candidate commit. A row saying an isolated `AEGIS_HOME` was used is true
 *     of the run it describes, and rewriting it would claim a variable that did
 *     not exist at that commit. Only recorded-result rows may carry the name:
 *     the procedure rows above them describe what to do NOW and get no
 *     exemption, which is what stops the allowance from widening.
 *
 *   - `docs/superpowers/plans/` holds dated, already-executed plans that quote
 *     the code as it stood on their date.
 *
 * Everything else is current-tense and must read Fiscus.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const LEGACY = /aegis/i;

/** This file and the identity test name the old spelling in order to ban it. */
const SELF = ['test/fiscus-name-sweep.test.ts', 'test/fiscus-identity.test.ts'];

/** Dated, already-executed plans quoting then-current code. */
const ARCHIVED_PLANS = 'docs/superpowers/plans/';

/** Gate rows are exempt only where they record an observed result. */
const GATE = 'docs/RELEASE-GATE.md';
const RECORDED_RESULT = /\*\*(Pass|Fail|Blocked)\.?\*\*/;

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

function textOf(rel: string): string | null {
  const buf = readFileSync(join(REPO, rel.split('/').join(sep)));
  if (buf.includes(0)) return null; // binary
  return buf.toString('utf8');
}

test('no current-tense file still calls the product by its old name', () => {
  const offenders: string[] = [];

  for (const rel of trackedFiles()) {
    if (SELF.includes(rel) || rel.startsWith(ARCHIVED_PLANS)) continue;
    const text = textOf(rel);
    if (text === null || !LEGACY.test(text)) continue;

    text.split(/\r?\n/).forEach((line, i) => {
      if (!LEGACY.test(line)) return;
      if (rel === GATE && RECORDED_RESULT.test(line)) return; // observed evidence
      offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 110)}`);
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `${offenders.length} line(s) still name the old product:\n${offenders.join('\n')}`,
  );
});

test('the gate document only carries the old name inside recorded results', () => {
  // Guards the allowance above: if the exemption ever stops being exercised the
  // allowance is dead code and should be deleted, and if a NON-result row in the
  // gate ever names the old product the sweep above will already have caught it.
  const rows = textOf(GATE)!
    .split(/\r?\n/)
    .filter((l) => LEGACY.test(l));
  assert.ok(rows.length > 0, 'expected historical gate rows citing the old home variable');
  for (const row of rows) {
    assert.ok(
      RECORDED_RESULT.test(row),
      `gate row names the old product outside a recorded result: ${row.trim().slice(0, 110)}`,
    );
  }
});

test('no HTTP header, route, or reason code still carries the old name', () => {
  const banned: Array<[RegExp, string]> = [
    [/x-aegis-/i, 'HTTP header'],
    [/__aegis/i, 'internal route'],
    [/aegis_budget_block/i, 'block reason code'],
    [/AEGIS_(HOME|DB|DEMO|JUDGE_API_KEY)/, 'environment override'],
  ];
  const offenders: string[] = [];

  for (const rel of trackedFiles()) {
    if (SELF.includes(rel) || rel.startsWith(ARCHIVED_PLANS) || rel === GATE) continue;
    const text = textOf(rel);
    if (text === null) continue;
    for (const [re, what] of banned) {
      if (re.test(text)) offenders.push(`${rel}: ${what} (${re.source})`);
    }
  }

  assert.deepEqual(offenders, [], `legacy wire/config surface survives:\n${offenders.join('\n')}`);
});
