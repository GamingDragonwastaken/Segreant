/**
 * Nothing in the repository still calls the product by its old name.
 *
 * `segreant-identity.test.ts` pins the resolver's behaviour. This file pins the
 * text: a rename that leaves the old name in a CI script, an npm alias, a
 * header constant, or a page of prose has not renamed anything, it has only
 * moved the confusion somewhere a test was not looking.
 *
 * The product was AegisFlow, then Fiscus; both names are banned here.
 *
 * Allowances, each narrow and deliberate:
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
 *   - `docs/NAME-COLLISION-REVIEW.md` and `docs/program/NAMING-DECISION.md`
 *     are ABOUT the old name: the npm collision that forced the rename and the
 *     choice of the new one. They cannot make that case without naming it.
 *
 *   - The repository URL `GamingDragonwastaken/Fiscus` stays until the GitHub
 *     repository itself is renamed; a link to a URL that does not exist yet
 *     would be broken. A line passes only if nothing legacy remains once the
 *     URL is removed, so the URL cannot shelter any other use.
 *
 *   - The one CHANGELOG sentence that tells users what the product used to be
 *     called.
 *
 * Everything else is current-tense and must read Segreant.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const LEGACY = /aegis|fiscus/i;

/** These name the old spelling in order to ban it, or to prove it inert. */
const SELF = [
  'test/segreant-name-sweep.test.ts',
  'test/segreant-identity.test.ts',
  'test/segreant-home-cli.test.ts',
];

/** Documents whose subject is the old name. */
const NAMING_DOCS = ['docs/NAME-COLLISION-REVIEW.md', 'docs/program/NAMING-DECISION.md'];

/** The repository URL, until the repository is renamed. */
const REPO_URL = /GamingDragonwastaken\/Fiscus/g;

/** The single sentence that records the former name for users. */
const RENAME_NOTE = /It was called Fiscus until \d{4}-\d{2}-\d{2}/;

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
    if (SELF.includes(rel) || rel.startsWith(ARCHIVED_PLANS) || NAMING_DOCS.includes(rel)) continue;
    const text = textOf(rel);
    if (text === null || !LEGACY.test(text)) continue;

    text.split(/\r?\n/).forEach((line, i) => {
      if (!LEGACY.test(line.replace(REPO_URL, ''))) return;
      if (rel === 'CHANGELOG.md' && !LEGACY.test(line.replace(RENAME_NOTE, ''))) return;
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
    .filter((l) => LEGACY.test(l.replace(REPO_URL, '')));
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
    [/x-fiscus-/i, 'HTTP header'],
    [/fiscus_(budget|egress|upstream|resource)/i, 'error type'],
    [/FISCUS_(HOME|DB|DEMO|JUDGE_API_KEY)/, 'environment override'],
    [/\.fiscuspack\b|["']fiscuspack(\.manifest)?["']/, 'evidence pack format'],
  ];
  const offenders: string[] = [];

  for (const rel of trackedFiles()) {
    if (SELF.includes(rel) || rel.startsWith(ARCHIVED_PLANS) || rel === GATE || NAMING_DOCS.includes(rel)) continue;
    const text = textOf(rel);
    if (text === null) continue;
    for (const [re, what] of banned) {
      if (re.test(text)) offenders.push(`${rel}: ${what} (${re.source})`);
    }
  }

  assert.deepEqual(offenders, [], `legacy wire/config surface survives:\n${offenders.join('\n')}`);
});
