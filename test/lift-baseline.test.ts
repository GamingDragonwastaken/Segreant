/**
 * Real Lift baseline-minutes: the cited/refreshable population manifest (mirrors
 * pricing's refresh contract, but honestly refuses a default source), the
 * personal git-history miner, and the empirical-Bayes-style combination that
 * lets an explicit user override always win.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store/db.ts';
import {
  applyBaselineManifest,
  loadBaselineManifest,
  baselineManifestStatus,
  refreshBaselineManifest,
  personalBaselineFromCommits,
  shrinkContinuousMean,
  resolveBaselineMinutes,
  resolveBaselineMinutesForRepo,
  PERSONAL_BASELINE_PSEUDOCOUNT,
  type CommitLike,
} from '../src/value/liftBaseline.ts';

const origHome = process.env.AEGIS_HOME;
function freshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-liftbaseline-'));
  process.env.AEGIS_HOME = dir;
  return dir;
}
function manifest(featureMin: number, curated = '2099-01-01'): string {
  return JSON.stringify({
    schema_version: 1,
    curated,
    unit: 'minutes',
    source: { title: 't', url: 'https://example.test', note: 'n' },
    baselineMinutes: { feature: featureMin, fix: 90 },
  });
}

// ---- manifest apply/refresh (mirrors pricing-refresh.test.ts) ----

test('a valid manifest is cached and OVERRIDES the bundled table', () => {
  freshHome();
  const res = applyBaselineManifest(manifest(999));
  assert.equal(res.ok, true);
  assert.equal(res.taskTypeCount, 2);
  assert.equal(loadBaselineManifest(true).baselineMinutes['feature'], 999);
  assert.equal(baselineManifestStatus().source, 'cache');
});

test('a bad manifest never downgrades a good cache', () => {
  freshHome();
  assert.equal(applyBaselineManifest(manifest(111)).ok, true);
  assert.equal(applyBaselineManifest('{not json').ok, false);
  assert.equal(applyBaselineManifest(JSON.stringify({ schema_version: 1, baselineMinutes: {} })).ok, false, 'empty baselineMinutes rejected');
  assert.equal(applyBaselineManifest(JSON.stringify({ schema_version: 1, baselineMinutes: { feature: -5 } })).ok, false, 'non-positive minutes rejected');
  assert.equal(loadBaselineManifest(true).baselineMinutes['feature'], 111, 'previous cache intact');
});

test('with no cache, loadBaselineManifest falls back to the bundled, cited table', () => {
  freshHome();
  const file = loadBaselineManifest(true);
  assert.equal(baselineManifestStatus().source, 'bundled');
  assert.ok(file.source && file.source.url, 'the bundled table discloses its source');
  assert.ok(Object.keys(file.baselineMinutes).length >= 5);
});

test('refreshBaselineManifest with no URL is an honest, explained failure — never a fabricated default', async () => {
  freshHome();
  const res = await refreshBaselineManifest(null);
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /no default manifest source/);
});

test('refreshBaselineManifest degrades gracefully on a real fetch failure', async () => {
  freshHome();
  const res = await refreshBaselineManifest('https://this-host-does-not-exist.invalid/manifest.json', 2000);
  assert.equal(res.ok, false);
});

test('baselineManifestStatus flags a stale table by its curated date', () => {
  freshHome();
  applyBaselineManifest(manifest(100, '2000-01-01'));
  const st = baselineManifestStatus(30);
  assert.equal(st.stale, true);
  assert.ok((st.ageDays ?? 0) > 1000);
});

test.after(() => {
  if (origHome === undefined) delete process.env.AEGIS_HOME;
  else process.env.AEGIS_HOME = origHome;
});

// ---- personal-history mining (pure) ----

function commit(minutesAgo: number, subject: string, baseMs = 10_000_000_000): CommitLike {
  return { tsEpochMs: baseMs - minutesAgo * 60_000, subject };
}

test('personalBaselineFromCommits: buckets by task-type, gap = minutes for the LATER commit', () => {
  // Oldest → newest: 200min ago, 150min ago (50min gap, fix), 100min ago (50min gap, fix)
  const commits = [commit(200, 'chore: init'), commit(150, 'fix: crash on empty input'), commit(100, 'fix: off by one')];
  const buckets = personalBaselineFromCommits(commits, { cutoffMs: 10_000_000_000 });
  const fix = buckets.find((b) => b.taskType === 'fix')!;
  assert.equal(fix.n, 2);
  assert.ok(Math.abs(fix.minutes - 50) < 1e-6);
});

test('personalBaselineFromCommits: gaps outside [min,max] are excluded as non-working-time noise', () => {
  const commits = [
    commit(300, 'feat: a'),
    commit(299.5, 'feat: rapid fixup'), // 0.5min gap — below default min(2) — excluded
    commit(120, 'feat: b'), // 179.5min gap — above default max(90) — excluded
  ];
  const buckets = personalBaselineFromCommits(commits, { cutoffMs: 10_000_000_000 });
  assert.equal(buckets.length, 0, 'both gaps are out of bounds, so nothing is attributed');
});

test('personalBaselineFromCommits: only commits strictly before cutoffMs count', () => {
  const base = 1_000_000_000;
  const a = { tsEpochMs: base, subject: 'fix: a' };
  const b = { tsEpochMs: base + 50 * 60_000, subject: 'fix: b' }; // +50min, within the gap bounds
  const c = { tsEpochMs: base + 100 * 60_000, subject: 'fix: after tracking began' }; // +100min
  // Cutoff sits between b and c: a→b is fully pre-cutoff evidence; c is excluded outright.
  const buckets = personalBaselineFromCommits([a, b, c], { cutoffMs: base + 60 * 60_000 });
  const fix = buckets.find((bkt) => bkt.taskType === 'fix');
  assert.equal(fix?.n, 1, 'only the one pair fully before the cutoff contributes');
  assert.ok(fix && Math.abs(fix.minutes - 50) < 1e-6);
});

test('personalBaselineFromCommits: honest empty on too little history', () => {
  assert.deepEqual(personalBaselineFromCommits([], { cutoffMs: 1000 }), []);
  assert.deepEqual(personalBaselineFromCommits([commit(10, 'fix: only one')], { cutoffMs: 10_000_000_000 }), [], 'a single commit has no gap to measure');
});

// ---- shrinkage (pure) ----

test('shrinkContinuousMean: thin personal evidence stays close to the prior', () => {
  const shrunk = shrinkContinuousMean(1 * 300, 1, 90); // 1 commit at 300min, prior 90min → (300+20*90)/21 = 100
  // n=1 against pseudoCount=20 → mostly the prior, barely pulled by the one outlier commit.
  assert.ok(shrunk >= 90 && shrunk <= 105, `expected close to the 90min prior, got ${shrunk}`);
});

test('shrinkContinuousMean: thick personal evidence dominates the prior', () => {
  const n = 500;
  const shrunk = shrinkContinuousMean(n * 300, n, 90); // (500*300+20*90)/520 ≈ 291.9
  assert.ok(shrunk > 285, `expected close to the 300min personal mean, got ${shrunk}`);
});

test('shrinkContinuousMean: matches the exact Beta-Binomial-shaped formula', () => {
  const shrunk = shrinkContinuousMean(10 * 40, 10, 100, 20); // (400 + 20*100)/(10+20)
  assert.ok(Math.abs(shrunk - (400 + 2000) / 30) < 1e-9);
});

test('shrinkContinuousMean: default pseudoCount is the disclosed constant', () => {
  const a = shrinkContinuousMean(10 * 40, 10, 100);
  const b = shrinkContinuousMean(10 * 40, 10, 100, PERSONAL_BASELINE_PSEUDOCOUNT);
  assert.equal(a, b);
});

// ---- combination (pure) ----

test('resolveBaselineMinutes: an explicit user override always wins, even with rich personal data', () => {
  const r = resolveBaselineMinutes({
    configBaseline: { feature: 500 }, // user explicitly set this away from the default
    defaultBaseline: { feature: 240 },
    personalBuckets: [{ taskType: 'feature', minutes: 300, n: 1000 }],
    populationBaseline: { feature: 220 },
  });
  assert.equal(r.minutes['feature'], 500);
  assert.match(r.basis['feature']!, /user override/);
});

test('resolveBaselineMinutes: untouched default + personal history → shrunk personal estimate', () => {
  const r = resolveBaselineMinutes({
    configBaseline: { feature: 240 }, // equals the default → NOT a user override
    defaultBaseline: { feature: 240 },
    personalBuckets: [{ taskType: 'feature', minutes: 400, n: 500 }],
    populationBaseline: { feature: 220 },
  });
  assert.ok(r.minutes['feature']! > 350, 'heavy personal evidence should dominate the 220min prior');
  assert.match(r.basis['feature']!, /personal git history/);
});

test('resolveBaselineMinutes: no personal history → the cited population prior alone', () => {
  const r = resolveBaselineMinutes({
    configBaseline: { feature: 240 },
    defaultBaseline: { feature: 240 },
    personalBuckets: [],
    populationBaseline: { feature: 220 },
  });
  assert.equal(r.minutes['feature'], 220);
  assert.match(r.basis['feature']!, /population prior/);
});

test('resolveBaselineMinutes: a task-type with only user config and no population entry is honestly kept', () => {
  const r = resolveBaselineMinutes({
    configBaseline: { legacybucket: 45 },
    defaultBaseline: {},
    personalBuckets: [],
    populationBaseline: { feature: 220 },
  });
  assert.equal(r.minutes['legacybucket'], 45);
  assert.equal(r.minutes['feature'], 220);
});

test('resolveBaselineMinutes: a personal-shrunk key carries the [population, raw personal] band and the point sits inside it', () => {
  const r = resolveBaselineMinutes({
    configBaseline: { feature: 240 },
    defaultBaseline: { feature: 240 },
    personalBuckets: [{ taskType: 'feature', minutes: 400, n: 30 }],
    populationBaseline: { feature: 220 },
  });
  assert.equal(r.minutesLow['feature'], 220, 'band floor = the smaller of prior and raw personal mean');
  assert.equal(r.minutesHigh['feature'], 400, 'band ceiling = the larger of the two');
  assert.ok(
    r.minutes['feature']! >= r.minutesLow['feature']! && r.minutes['feature']! <= r.minutesHigh['feature']!,
    'the shrunken point is a convex combination — it must sit inside its own band',
  );
});

test('resolveBaselineMinutes: override and population-only keys are exact points (no invented spread)', () => {
  const r = resolveBaselineMinutes({
    configBaseline: { feature: 500, fix: 60 },
    defaultBaseline: { feature: 240, fix: 60 },
    personalBuckets: [],
    populationBaseline: { feature: 220, fix: 55 },
  });
  assert.equal(r.minutesLow['feature'], 500, 'an audited config override is exact');
  assert.equal(r.minutesHigh['feature'], 500);
  assert.equal(r.minutesLow['fix'], 55, 'a population-only key is a disclosed point, not a fabricated interval');
  assert.equal(r.minutesHigh['fix'], 55);
});

// ---- resolveBaselineMinutesForRepo (impure orchestrator: git + store) ----
// The pure functions above are unit-tested to the line; this covers the glue
// that actually ships (cache round-trip, staleness, and honest failure) — the
// class of bug static review can't catch (a code-review agent flagged this
// exact gap: it's what let the package.json omission below through unnoticed).

function g(cwd: string, args: string[], env: Record<string, string> = {}): void {
  execFileSync('git', args, { cwd, env: { ...process.env, ...env }, stdio: 'ignore' });
}
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-liftbaseline-repo-'));
  g(dir, ['init', '-q']);
  g(dir, ['config', 'user.email', 't@t.co']);
  g(dir, ['config', 'user.name', 'tester']);
  return dir;
}
function realCommit(dir: string, file: string, content: string, msg: string, iso: string): void {
  writeFileSync(join(dir, file), content);
  g(dir, ['add', '.']);
  g(dir, ['commit', '-qm', msg, `--date=${iso}`], { GIT_COMMITTER_DATE: iso });
}

test('resolveBaselineMinutesForRepo: mines real git history, caches it, and reuses the cache on a second call', async () => {
  freshHome();
  applyBaselineManifest(manifest(240)); // pin the population prior so this test isn't at the mercy of another test's cached manifest
  const dir = makeRepo();
  try {
    realCommit(dir, 'a.txt', 'x', 'feat: one', '2020-01-01T10:00:00');
    realCommit(dir, 'a.txt', 'xy', 'feat: two', '2020-01-01T10:20:00'); // 20min gap, within [2,90]
    const store = new Store(':memory:');
    const defaultBaseline = { feature: 240 };

    const first = await resolveBaselineMinutesForRepo(store, dir, 'test-project', defaultBaseline, defaultBaseline);
    assert.match(first.basis['feature']!, /personal git history/);
    assert.ok(first.minutes['feature']! < 240, 'a real 20min gap should pull the estimate below the 240min population prior');

    const cached = store.loadLiftBaseline('test-project');
    assert.ok(cached, 'the mined personal buckets must be cached so a re-run does not re-mine git on every roi call');

    // Second call within the cache window must reuse the cached buckets, not
    // re-derive them — same resolved minutes, no git invocation required.
    const second = await resolveBaselineMinutesForRepo(store, dir, 'test-project', defaultBaseline, defaultBaseline);
    assert.equal(second.minutes['feature'], first.minutes['feature']);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveBaselineMinutesForRepo: a non-git directory degrades to the population prior, honestly, without throwing', async () => {
  freshHome();
  applyBaselineManifest(manifest(240)); // pin the population prior so this test isn't at the mercy of another test's cached manifest
  const dir = mkdtempSync(join(tmpdir(), 'aegis-liftbaseline-notgit-'));
  try {
    const store = new Store(':memory:');
    const defaultBaseline = { feature: 240 };
    const resolved = await resolveBaselineMinutesForRepo(store, dir, 'not-a-repo', defaultBaseline, defaultBaseline);
    assert.equal(resolved.minutes['feature'], 240);
    assert.match(resolved.basis['feature']!, /population prior/);
    // The failure must be disclosed in a note, not just silently absorbed —
    // otherwise "no personal history yet" and "mining actually failed" are
    // indistinguishable to whoever reads the roi/dashboard output.
    assert.ok(
      resolved.notes.some((n) => /unavailable/i.test(n)),
      'a git-mining failure should surface a distinct note, not read identically to "no personal history yet"',
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- packaging regression ----
// The bundled baseline manifest is loaded via a __dirname-relative path
// (BUNDLED_BASELINE_PATH in liftBaseline.ts), which only survives `npm publish`
// if its directory is allowlisted in package.json's `files`. This exact gap
// shipped once already (caught by review, not by the 18 tests above, since the
// bundled file is always present in the dev tree) — this test pins it so it
// can't silently regress.
test('package.json ships the bundled baselines directory (npm `files` allowlist)', () => {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { files: string[] };
  assert.ok(pkg.files.includes('baselines'), '"baselines" must be in package.json "files", or a fresh `npx aegisflow roi` throws ENOENT on install');
  assert.ok(pkg.files.includes('pricing'), '"pricing" must be in package.json "files" (same class of bug, existing feature)');
});
