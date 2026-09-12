/**
 * Nothing checked a rollup against the ledger it summarises.
 *
 * INTEGRITY IS NOT TRUTH — WP-C06's thesis, made executable. `signRollup`
 * proves two things and only two: these bytes were not altered, and this key
 * signed them. `validateRollupBody` adds an internal-consistency floor —
 * realized spend inside total spend — which is a statement about the body's
 * agreement with ITSELF. Neither is a statement about whether the totals
 * describe the ledger they claim to summarise. A body whose figures were
 * filtered, recomputed against a different window, or drawn from a ledger
 * retention had pruned passed every one of those checks and was signed.
 *
 * D-181 IS THE CLASS. A signed rollup declared complete coverage over spend
 * that had been deleted — a signature over an absence. That was repaired by
 * making the CLI compute `coverage` and pass it, which fixed the one call site
 * that existed. It left the property unenforced: a caller that computes
 * coverage wrongly, or omits the ledger entirely, still mints `complete`. The
 * enumeration this program keeps relearning is that a repaired reader stays
 * repaired only until the next reader is written, so the rule belongs at the
 * mint, where the body is constructed, rather than in whichever caller happens
 * to be looking.
 *
 * THE FOUR QUESTIONS ASKED AT EMIT.
 *   1. Is the window the ledger was queried over the window the body claims?
 *   2. Do the constituent figures match the ledger row by row, and does their
 *      exact sum match the ledger's?
 *   3. Does the declared scope describe the population that is actually there —
 *      an `all-projects` claim over a filtered list is the D-101 erasure with
 *      a snapshot's face on it?
 *   4. Does the retention floor support a `complete` claim at all?
 *
 * EXACT, NOT TOLERANT. The constituent sums are compared as integers at a fixed
 * decimal scale, never as floats: a tolerance on a conservation check is a place
 * for a real discrepancy to hide, and the receiver forms this same sum.
 *
 * WHAT THIS FILE DOES NOT ESTABLISH. That the ledger is right. Every check here
 * is agreement between a body and the local meter that produced it; the meter's
 * own limits — spend that never reached Fiscus, provider-billed cost that is a
 * different claim entirely — are untouched and unmeasured by any of it.
 *
 * Recorded at D-199.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FISCUS_HOME = mkdtempSync(join(tmpdir(), 'fiscus-rollup-ledger-home-'));

import { readFileSync, readdirSync } from 'node:fs';
import { loadOrCreateKeyPair } from '../src/value/receipt.ts';
import {
  buildEconomicRollupBody,
  buildRollupBody,
  rollupEconomicCoverage,
  rollupLedgerDisagreement,
  type EconomicProjectValue,
  type RollupLedgerEvidence,
} from '../src/team/rollup.ts';
import { readLedgerForRollup } from '../src/team/ledger-evidence.ts';
import { Store } from '../src/store/db.ts';
import type { ProjectValue } from '../src/value/realization.ts';

const PERIOD = { from: '2026-08-01T00:00:00.000Z', to: '2026-08-31T00:00:00.000Z' };
const DAY = 86_400_000;

const keyDir = mkdtempSync(join(tmpdir(), 'fiscus-rollup-ledger-'));
process.on('exit', () => rmSync(keyDir, { recursive: true, force: true }));
process.on('exit', () => rmSync(process.env.FISCUS_HOME!, { recursive: true, force: true }));

function keys() {
  return loadOrCreateKeyPair(join(keyDir, 'key.json'));
}

function project(name: string, costUsd = 100): ProjectValue {
  return {
    project: name,
    units: 10,
    costUsd,
    realizationRate: 0.4,
    spendOnRealizedUnitsUsd: costUsd * 0.4,
    acceptanceWeightedSpendUsd: costUsd * 0.2,
    roiIndex: 1.2,
    sources: ['claude-code'],
  };
}

/** The ledger as it would be read at emit: every project, unfiltered, plus what retention took. */
function ledger(projects: ProjectValue[], overrides: Partial<RollupLedgerEvidence> = {}): RollupLedgerEvidence {
  return {
    window: { from: PERIOD.from, to: PERIOD.to },
    projects: projects.map((p) => ({
      project: p.project,
      units: p.units,
      costUsd: p.costUsd,
      spendOnRealizedUnitsUsd: p.spendOnRealizedUnitsUsd,
      acceptanceWeightedSpendUsd: p.acceptanceWeightedSpendUsd,
    })),
    retentionTruncatesWindow: false,
    retentionPrunedBeforeMs: null,
    ...overrides,
  };
}

// ---- the window the body claims -------------------------------------------

test('a body whose period is not the window the ledger was read over is refused at emit', () => {
  const body = buildRollupBody(keys(), [project('api')], PERIOD, undefined, 'complete', {
    scope: { kind: 'all-projects' },
  });
  const other = ledger([project('api')], {
    window: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-31T00:00:00.000Z' },
  });
  assert.match(rollupLedgerDisagreement(body, other) ?? '', /window|period/i);
});

// ---- the constituents ------------------------------------------------------

test('a constituent figure the ledger does not carry is refused', () => {
  const body = buildRollupBody(keys(), [project('api', 100)], PERIOD, undefined, 'complete', {
    scope: { kind: 'all-projects' },
  });
  // The same project, six dollars cheaper than the ledger holds — the D-176
  // shape, where the number is well-formed and simply not the one measured.
  assert.match(rollupLedgerDisagreement(body, ledger([project('api', 106)])) ?? '', /api/);
});

test('a project the ledger has never heard of is refused', () => {
  const body = buildRollupBody(keys(), [project('api'), project('ghost')], PERIOD, undefined, 'complete', {
    scope: { kind: 'all-projects' },
  });
  assert.match(rollupLedgerDisagreement(body, ledger([project('api')])) ?? '', /ghost/);
});

test('the constituent sum is compared exactly, so no tolerance can absorb a real gap', () => {
  // Figures chosen to be inexact in binary floating point. Both sides quantize
  // to the same fixed decimal scale, so agreement is agreement and not luck.
  const rows = [project('a', 0.1), project('b', 0.2)];
  const body = buildRollupBody(keys(), rows, PERIOD, undefined, 'complete', { scope: { kind: 'all-projects' } });
  assert.equal(rollupLedgerDisagreement(body, ledger(rows)), null);
});

// ---- the scope claim, checked against the population -----------------------

test('an all-projects claim over a filtered list is refused, which is D-101 at the mint', () => {
  // The exact push the CLI refuses to send. Here the body cannot be MADE: a
  // rollup that names one of three projects may not also declare itself a
  // snapshot of the machine.
  const all = [project('api'), project('web'), project('infra')];
  const body = buildRollupBody(keys(), [project('api')], PERIOD, undefined, 'complete', {
    scope: { kind: 'all-projects' },
  });
  assert.match(rollupLedgerDisagreement(body, ledger(all)) ?? '', /web|infra|all-projects/);
});

test('a scoped claim over exactly its own project is minted, because saying so is the repair', () => {
  const all = [project('api'), project('web')];
  const body = buildRollupBody(keys(), [project('api')], PERIOD, undefined, 'complete', {
    scope: { kind: 'project', project: 'api' },
  });
  assert.equal(rollupLedgerDisagreement(body, ledger(all)), null);
});

test('a scoped claim carrying a project it did not name is refused', () => {
  const all = [project('api'), project('web')];
  const body = buildRollupBody(keys(), [project('api'), project('web')], PERIOD, undefined, 'complete', {
    scope: { kind: 'project', project: 'api' },
  });
  assert.match(rollupLedgerDisagreement(body, ledger(all)) ?? '', /web|scope/);
});

// ---- what the retention floor supports -------------------------------------

test('a complete claim over a window retention has cut into is refused at emit', () => {
  const body = buildRollupBody(keys(), [project('api')], PERIOD, undefined, 'complete', {
    scope: { kind: 'all-projects' },
  });
  const pruned = ledger([project('api')], {
    retentionTruncatesWindow: true,
    retentionPrunedBeforeMs: Date.parse('2026-08-10T00:00:00.000Z'),
  });
  assert.match(rollupLedgerDisagreement(body, pruned) ?? '', /retention|complete/i);
});

test('the same body declaring partial coverage is minted, because partial is the true statement', () => {
  const body = buildRollupBody(keys(), [project('api')], PERIOD, undefined, 'partial', {
    scope: { kind: 'all-projects' },
  });
  const pruned = ledger([project('api')], {
    retentionTruncatesWindow: true,
    retentionPrunedBeforeMs: Date.parse('2026-08-10T00:00:00.000Z'),
  });
  assert.equal(rollupLedgerDisagreement(body, pruned), null);
});

test('the builder itself refuses, so the body a receiver would have to catch is never signed', () => {
  const pruned = ledger([project('api')], {
    retentionTruncatesWindow: true,
    retentionPrunedBeforeMs: Date.parse('2026-08-10T00:00:00.000Z'),
  });
  assert.throws(
    () => buildRollupBody(keys(), [project('api')], PERIOD, undefined, 'complete', {
      scope: { kind: 'all-projects' },
      ledger: pruned,
    }),
    /retention|complete/i,
  );
});

// ---- against a real ledger, not a fixture ----------------------------------

test('a real pruned ledger reports a truncated window, and a complete rollup over it cannot be minted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-rollup-real-ledger-'));
  try {
    const store = new Store(join(dir, 'ledger.db'));
    try {
      const to = new Date();
      const from = new Date(to.getTime() - 30 * DAY);
      const period = { from: from.toISOString(), to: to.toISOString() };

      const before = readLedgerForRollup(store, { windowDays: 30, period });
      assert.equal(before.evidence.retentionTruncatesWindow, false, 'an unpruned window is not truncated');
      assert.equal(before.evidence.retentionPrunedBeforeMs, null, 'no prune on record is null, never zero');

      // The real operation, not a mocked one: `prune` records its boundary
      // atomically with the delete, and every window starting before it is cut.
      store.prune(Date.now() - 10 * DAY);

      const after = readLedgerForRollup(store, { windowDays: 30, period });
      assert.equal(after.evidence.retentionTruncatesWindow, true);
      assert.ok(after.evidence.retentionPrunedBeforeMs !== null);
      assert.throws(
        () => buildRollupBody(keys(), [project('api')], period, undefined, 'complete', {
          scope: { kind: 'all-projects' },
          ledger: { ...after.evidence, projects: [{
            project: 'api', units: 10, costUsd: 100, spendOnRealizedUnitsUsd: 40, acceptanceWeightedSpendUsd: 20,
          }] },
        }),
        /retention|complete/i,
      );
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- a signed aggregate must not erase weaker provenance -------------------

test('one legacy_unknown constituent makes the aggregate legacy_unknown, and signing does not upgrade it', () => {
  const exact = (p: ProjectValue): EconomicProjectValue => ({
    ...p,
    economic: { coverage: 'legacy_unknown', total: null, realized: null },
  });
  const body = buildEconomicRollupBody(keys(), [exact(project('api')), exact(project('web'))], PERIOD, undefined, 'complete', {
    scope: { kind: 'all-projects' },
  });
  assert.equal(rollupEconomicCoverage(body), 'legacy_unknown');
});

test('a v1 body claims no exact lineage at all, and reads as legacy_unknown rather than exact', () => {
  const body = buildRollupBody(keys(), [project('api')], PERIOD);
  assert.equal(rollupEconomicCoverage(body), 'legacy_unknown');
});

// ---- the enumeration, made executable (checklist step 8) -------------------

test('no production module mints a rollup body outside the one ledger-backed path', () => {
  // A repaired reader stays repaired until the next reader is written. This
  // derives the caller list from the source rather than from prose, so a new
  // mint site arrives as a failing test instead of as a silent second hole.
  const allowed = new Set(['src/team/rollup.ts', 'src/cli/teamCmd.ts']);
  const roots = ['src'];
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts')) files.push(path);
    }
  };
  for (const root of roots) walk(root);
  const callers = files.filter((path) => /\bbuild(Economic)?RollupBody\s*\(/.test(readFileSync(path, 'utf8')))
    .map((path) => path.replace(/\\/g, '/'));
  assert.ok(files.length > 0, `the sweep must have a corpus: ${files.length} source files scanned`);
  assert.deepEqual(
    callers.sort(),
    [...allowed].sort(),
    `mint sites found in ${files.length} scanned source files; a new one must pass ledger evidence`,
  );
});
