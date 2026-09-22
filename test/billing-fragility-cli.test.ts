/**
 * The residual's countermodels reach an operator (WP-B04).
 *
 * `src/epistemic/countermodel.ts` and `src/billing/countermodels.ts` are pinned
 * by `test/countermodel.test.ts` as machinery. Machinery nothing runs is not a
 * property of the product, and this repository has a name for that state —
 * `reach: 'unreached'` on the issuance map — so the wiring needs its own test at
 * the surface an operator actually meets: `fiscus billing reconcile`.
 *
 * WHAT THIS PINS THAT THE UNIT TESTS CANNOT. That the terminal says the residual
 * is PERMANENTLY conditional rather than pending a check, and that a negative
 * residual is announced as an ESTABLISHED failure of a stated condition rather
 * than left for the reader to infer from a minus sign. Both are statements about
 * output, and output is where the collapse this repository keeps finding —
 * presenting one class of claim as another — actually reaches a person.
 *
 * The database is seeded in-process and the CLI is then run against it as a
 * subprocess, so what is asserted is what a person would see, not what a
 * function returns.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FISCUS_HOME = mkdtempSync(join(tmpdir(), 'fiscus-home-fragility-'));

import { Store, type RequestRow } from '../src/store/db.ts';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const DAY = 24 * 60 * 60 * 1000;
// A long-closed UTC period, so the settlement-lag guard never depends on when
// the suite runs.
const D0 = Date.UTC(2026, 6, 1);

function runCli(args: string[], dbPath: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...process.env, FISCUS_DB: dbPath, NODE_OPTIONS: '' } },
      (err, stdout, stderr) => {
        const code = err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
          ? (err as unknown as { code: number }).code
          : err ? 1 : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/**
 * The block wraps at 70 columns and prefixes continuation lines, so a sentence
 * an operator reads as one thing is several lines on the wire. Assertions about
 * WHAT IT SAYS are made against the flattened text; assertions about the block's
 * structure stay on the raw output.
 */
function flat(stdout: string): string {
  return stdout.replaceAll(/\s*\n\s*[!>]?\s*/g, ' ');
}

let reqSeq = 0;
function request(scopeId: string, dayIndex: number, costUsd: number): RequestRow {
  return {
    requestId: `r-frag-${reqSeq++}`,
    sessionId: null,
    tsEpochMs: D0 + dayIndex * DAY + 6 * 60 * 60 * 1000,
    provider: 'openai',
    model: 'gpt-4o',
    project: 'p',
    taskWeight: 1,
    inputTokens: 100,
    outputTokens: 10,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    costUsd,
    estimated: false,
    streamed: true,
    statusCode: 200,
    durationMs: 100,
    via: 'proxy',
    scopeCaptureStatus: 'declared_unverified',
    providerScopeDeclarationId: scopeId,
  };
}

/**
 * A database a reconciliation can actually run against: a declared scope that
 * can address the Costs API, one complete provider observation of a closed
 * two-day period, and local requests on that route.
 *
 * `localUsd` is what makes the two cases differ. Everything else is held fixed,
 * so a difference in the output is a difference in the residual and nothing
 * else.
 */
function seed(dbPath: string, providerUsd: readonly string[], localUsd: readonly number[]): void {
  const store = new Store(dbPath);
  try {
    const scope = store.setOpenAiScope({
      billingAccountRef: 'org_test',
      providerProjectRef: 'proj_test',
      upstreamBase: 'https://api.openai.com',
    });
    store.recordOpenAiCostsObservation({
      declaredScopeId: scope.declarationId,
      providerProjectRef: 'proj_test',
      periodStartMs: D0,
      periodEndMs: D0 + providerUsd.length * DAY,
      fetchedAtMs: D0 + (providerUsd.length + 1) * DAY,
      paginationComplete: true,
      pageCount: 1,
      pageDigestChainSha256: 'c'.repeat(64),
      resultState: 'succeeded',
      failureCode: null,
      observations: providerUsd.map((amountDecimal, index) => ({
        providerProjectRef: 'proj_test',
        bucketStartMs: D0 + index * DAY,
        bucketEndMs: D0 + (index + 1) * DAY,
        lineItem: 'gpt-4o',
        currency: 'USD',
        amountDecimal,
      })),
    });
    for (const [index, costUsd] of localUsd.entries()) {
      store.insertRequest(request(scope.declarationId, index, costUsd));
    }
  } finally {
    store.close();
  }
}

interface FragilityPayload {
  readonly assumptions: readonly string[];
  readonly unexcludable: readonly { readonly violates: string; readonly excludedBy: string | null }[];
  readonly realized: readonly { readonly violates: string }[];
  readonly claimHoldsAsStated: boolean;
  readonly robustnessAssessed: boolean;
}

test('a reconciliation tells an operator that its conditions can be closed by nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-fragility-'));
  const db = join(dir, 'fiscus.db');
  try {
    // Provider $30, local $29 — an ordinary positive residual.
    seed(db, ['10', '20'], [9, 20]);

    const human = await runCli(['billing', 'reconcile'], db);
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /Unexplained\s+\+\$1\.00/, 'the run reconciled as expected');

    // The finding, at the terminal. Not "these conditions are unverified" —
    // unverified reads as an errand, and four of these are not.
    assert.match(human.stdout, /If a condition does not hold/);
    assert.match(flat(human.stdout), /4 of 4 cannot be ruled out by anything Fiscus can observe/);
    assert.match(flat(human.stdout), /permanently conditional rather than pending a check/);
    // Nothing is established on a positive residual, so nothing is announced as
    // broken. A block that cried wolf on every run would be ignored on the one
    // that mattered.
    assert.equal(/ESTABLISHED/.test(human.stdout), false);

    const json = await runCli(['billing', 'reconcile', '--json'], db);
    assert.equal(json.code, 0, json.stderr);
    const payload = JSON.parse(json.stdout) as { fragility: FragilityPayload };
    assert.ok(payload.fragility, 'a machine consumer gets the worlds too, not just the prose');
    assert.equal(payload.fragility.assumptions.length, 4);
    assert.equal(payload.fragility.unexcludable.length, 4);
    assert.equal(payload.fragility.claimHoldsAsStated, true);
    // And the assessment covers every condition the run states, so an empty
    // fragile set below would mean something rather than nothing.
    assert.equal(payload.fragility.robustnessAssessed, true);
    for (const model of payload.fragility.unexcludable) assert.equal(model.excludedBy, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a negative residual is reported as a broken condition, not as a small number', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-fragility-neg-'));
  const db = join(dir, 'fiscus.db');
  try {
    // Provider $30, local $40. R < 0 means L > P >= T, which refutes the
    // rate-card condition outright rather than leaving it merely unexcluded.
    seed(db, ['10', '20'], [15, 25]);

    const human = await runCli(['billing', 'reconcile'], db);
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /Unexplained\s+-\$10\.00/);
    assert.match(
      flat(human.stdout),
      /local_request_amounts_are_rate_card_estimates is ESTABLISHED, not merely possible/,
    );
    // Still 4 of 4: an established world is one nothing excluded, so it is
    // counted here as well as announced above. The two lines say different
    // things and the block would be weaker for collapsing them.
    assert.match(flat(human.stdout), /4 of 4 cannot be ruled out/);

    const json = await runCli(['billing', 'reconcile', '--json'], db);
    const payload = JSON.parse(json.stdout) as { fragility: FragilityPayload };
    assert.equal(payload.fragility.claimHoldsAsStated, false, 'the residual no longer bounds what the claim says it bounds');
    assert.deepEqual(
      payload.fragility.realized.map((model) => model.violates),
      ['local_request_amounts_are_rate_card_estimates'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
