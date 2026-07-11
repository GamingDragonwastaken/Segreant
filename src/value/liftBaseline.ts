/**
 * Real Lift baseline-minutes — a cited, refreshable, personally-calibrated
 * replacement for a flat, unsourced guess.
 *
 * `lift.ts` already does the honest math (TSF = baselined manual minutes ÷
 * measured AI minutes, discounted into a partial-identification interval) — that
 * math is declared final and untouched here. What THIS module improves is one of
 * its inputs: `baselineMinutes`, the manual-minute estimate per task-type. Before
 * this, that was a flat, hand-picked, unsourced table
 * (config.ts DEFAULT_CONFIG.lift.baselineMinutes). This module gives it three
 * honest upgrades, same posture as pricing.ts had for cost rates:
 *
 *   1. A CITED population prior. baselines/lift-baselines.json is a small,
 *      dated table anchored to METR's published, human-timed task-completion
 *      research (see the file's own `source` block) — refreshable exactly like
 *      the pricing table (bundled floor, user-writable cache override), but
 *      HONEST about the fact that, unlike pricing, there is no established
 *      machine-readable feed for this: refreshing requires an explicit URL, we
 *      never invent a default one.
 *   2. A PERSONAL prior. `personalBaselineFromCommits` mines this project's own
 *      git history from BEFORE AegisFlow recorded its first tracked request
 *      ANYWHERE (a global cutoff, not per-project) — turning inter-commit gaps
 *      into a real, behavioral personal baseline. Two honest limits, disclosed
 *      rather than hidden: (a) the cutoff can only reflect AI use AegisFlow has
 *      itself tracked — pre-install AI-assisted commits (from a tool AegisFlow
 *      never saw) are indistinguishable from genuinely manual ones and get
 *      absorbed into the "manual" signal; (b) the cutoff is `MIN(ts_epoch_ms)`
 *      over the `requests` table, which retention pruning (`Store.prune`) can
 *      delete from, so on a long-lived install the cutoff can drift forward
 *      over time rather than staying fixed at the true first-ever request. Both
 *      are real reasons — beyond thin-sample noise — that this prior is always
 *      SHRUNK toward the population prior (below) rather than trusted outright.
 *   3. Principled COMBINATION. The two are blended with a continuous-data
 *      analogue of reliability.ts's empirical-Bayes rate-shrinkage: a thin
 *      personal sample is pulled toward the cited population prior; a thick one
 *      dominates it. An explicit user override in config always wins over both.
 *
 * Every function down to `resolveBaselineMinutes` is PURE (no fs/store/git), so
 * the estimator is unit-testable to the line; only the two `...ForRepo`/`compute*`
 * wrappers at the bottom touch git or the store.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { aegisHome } from '../config.ts';
import type { Store } from '../store/db.ts';
import { readCommitsBefore } from '../git/correlate.ts';
import { classifyTaskType, type TaskType } from './taskType.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The baseline table shipped inside the package — always present, works offline. */
const BUNDLED_BASELINE_PATH = join(__dirname, '..', '..', 'baselines', 'lift-baselines.json');

/** A user-writable override at ~/.aegisflow/baselines/lift-baselines.json, same pattern as pricing's cache. */
function cachePath(): string {
  return join(aegisHome(), 'baselines', 'lift-baselines.json');
}

export interface BaselineManifest {
  schema_version: number;
  curated: string;
  unit: string;
  source: { title: string; url: string; note: string; [k: string]: unknown };
  baselineMinutes: Record<string, number>;
}

let cached: BaselineManifest | null = null;
let cachedSource: 'cache' | 'bundled' = 'bundled';

function isValidBaselineManifest(obj: unknown): obj is BaselineManifest {
  if (!obj || typeof obj !== 'object') return false;
  const o = obj as Record<string, unknown>;
  if (typeof o['schema_version'] !== 'number') return false;
  if (!o['baselineMinutes'] || typeof o['baselineMinutes'] !== 'object') return false;
  const minutes = Object.values(o['baselineMinutes'] as Record<string, unknown>);
  return minutes.length > 0 && minutes.every((v) => typeof v === 'number' && v > 0);
}

function readValidBaselineManifest(path: string): BaselineManifest | null {
  try {
    const obj: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isValidBaselineManifest(obj) ? obj : null;
  } catch {
    return null;
  }
}

/** The active population baseline table — the cache when present and valid, else the bundled table. */
export function loadBaselineManifest(force = false): BaselineManifest {
  if (cached && !force) return cached;
  const fromCache = readValidBaselineManifest(cachePath());
  if (fromCache) {
    cached = fromCache;
    cachedSource = 'cache';
    return cached;
  }
  cached = JSON.parse(readFileSync(BUNDLED_BASELINE_PATH, 'utf8')) as BaselineManifest;
  cachedSource = 'bundled';
  return cached;
}

export interface BaselineRefreshResult {
  ok: boolean;
  curated?: string;
  taskTypeCount?: number;
  error?: string;
}

/**
 * Validate a baseline manifest (raw JSON text) and, if it passes, write it to the
 * local cache so it overrides the bundled table. Network-free and unit-testable
 * on its own; `refreshBaselineManifest` adds the fetch. On any failure the
 * existing cache is left untouched.
 */
export function applyBaselineManifest(rawText: string): BaselineRefreshResult {
  let obj: unknown;
  try {
    obj = JSON.parse(rawText);
  } catch (e) {
    return { ok: false, error: `not valid JSON: ${String(e)}` };
  }
  if (!isValidBaselineManifest(obj)) {
    return { ok: false, error: 'manifest failed shape check (schema_version / baselineMinutes: positive numbers)' };
  }
  try {
    const dir = join(aegisHome(), 'baselines');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(cachePath(), JSON.stringify(obj, null, 2) + '\n', 'utf8');
  } catch (e) {
    return { ok: false, error: `could not write cache: ${String(e)}` };
  }
  cached = null; // invalidate the memo so the next load picks up the new table
  return { ok: true, curated: obj.curated, taskTypeCount: Object.keys(obj.baselineMinutes).length };
}

/**
 * Pull a fresh baseline manifest from `url` and apply it. Unlike pricing (which
 * defaults to LiteLLM's real, community-maintained, machine-readable feed), there
 * is no established machine-readable feed for Lift baselines — METR publishes
 * research, not a versioned JSON endpoint. So this NEVER invents a default: pass
 * an explicit URL you trust (e.g. a manifest you or your org curates and hosts),
 * or edit ~/.aegisflow/baselines/lift-baselines.json by hand. Calling this with
 * no URL is a clear, honest failure — not a silent no-op and not a fabricated
 * endpoint.
 */
export async function refreshBaselineManifest(url: string | null, timeoutMs = 20_000): Promise<BaselineRefreshResult> {
  if (!url) {
    return {
      ok: false,
      error:
        'no default manifest source is configured for Lift baselines (unlike pricing, there is no established machine-readable feed for this) — pass an explicit URL you trust, or edit the cache file by hand',
    };
  }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} from ${url}` };
    return applyBaselineManifest(await res.text());
  } catch (e) {
    return { ok: false, error: `fetch failed: ${String(e)}` };
  }
}

export interface BaselineManifestStatus {
  source: 'cache' | 'bundled';
  curated: string;
  ageDays: number | null;
  stale: boolean;
  taskTypeCount: number;
}

/** Where the active population baseline came from, how old it is, and whether it's stale. */
export function baselineManifestStatus(maxAgeDays = 180): BaselineManifestStatus {
  const file = loadBaselineManifest(true);
  const t = Date.parse(file.curated);
  const ageDays = Number.isNaN(t) ? null : Math.floor((Date.now() - t) / 86_400_000);
  return {
    source: cachedSource,
    curated: file.curated,
    ageDays,
    stale: ageDays !== null && ageDays > maxAgeDays,
    taskTypeCount: Object.keys(file.baselineMinutes).length,
  };
}

// ---- Personal-history mining (pure) ----

export interface CommitLike {
  tsEpochMs: number;
  subject: string;
}

export interface PersonalBaselineBucket {
  taskType: TaskType;
  /** Mean minutes per commit in this bucket. */
  minutes: number;
  /** Number of commits contributing (the evidence strength). */
  n: number;
}

export interface PersonalBaselineOptions {
  /** Only commits strictly before this timestamp count as pre-tracking evidence. */
  cutoffMs: number;
  /** Gaps shorter than this are almost certainly not real working time (batch/fixup commits) — excluded. Default 2. */
  sessionGapMinMinutes?: number;
  /** Gaps longer than this are almost certainly a break, not time spent on the next commit — excluded. Default 90. */
  sessionGapMaxMinutes?: number;
}

/**
 * Turn a project's OWN pre-AI-tracking commit history into a personal baseline:
 * for each consecutive pair of commits whose gap looks like real, continuous
 * working time (bounded above and below — see PersonalBaselineOptions), classify
 * the later commit by task-type (the exact same classifier the realization
 * engine already uses) and treat the gap as the manual minutes it took. This is
 * an honest, disclosed heuristic, not a measurement: it can't know whether a gap
 * was uninterrupted work, and it will always be noisier than the AI-side
 * measurement (which has an objective concurrency signal from request
 * timestamps). That's exactly why the caller shrinks it toward a population
 * prior rather than trusting it outright — see shrinkContinuousMean.
 */
export function personalBaselineFromCommits(commits: CommitLike[], opts: PersonalBaselineOptions): PersonalBaselineBucket[] {
  const gapMinMs = (opts.sessionGapMinMinutes ?? 2) * 60_000;
  const gapMaxMs = (opts.sessionGapMaxMinutes ?? 90) * 60_000;
  const pre = commits.filter((c) => c.tsEpochMs < opts.cutoffMs).sort((a, b) => a.tsEpochMs - b.tsEpochMs);

  const cells = new Map<TaskType, { sumMin: number; n: number }>();
  for (let i = 1; i < pre.length; i++) {
    const gapMs = pre[i]!.tsEpochMs - pre[i - 1]!.tsEpochMs;
    if (gapMs < gapMinMs || gapMs > gapMaxMs) continue; // not a real "time spent producing this commit" signal
    const t = classifyTaskType(pre[i]!.subject);
    const cell = cells.get(t) ?? { sumMin: 0, n: 0 };
    cell.sumMin += gapMs / 60_000;
    cell.n += 1;
    cells.set(t, cell);
  }
  return [...cells.entries()].map(([taskType, { sumMin, n }]) => ({ taskType, minutes: sumMin / n, n }));
}

// ---- Combination (pure) ----

/**
 * How many personal commits a bucket needs before it meaningfully outweighs the
 * population prior — 20 pseudo-observations means ~20 personal commits in a
 * task-type pulls the estimate about halfway to the personal mean; well beyond
 * that, the personal data dominates. FIXED and disclosed rather than empirically
 * estimated: reliability.ts can estimate its shrinkage strength from the
 * dispersion ACROSS many independent cells (every model×task context in the
 * whole ledger), but a personal git baseline typically has only a handful of
 * task-type buckets — too few to separate real spread from noise the same way.
 * A fixed, conservative, disclosed constant is the honest choice over pretending
 * to fit one from too little data.
 */
export const PERSONAL_BASELINE_PSEUDOCOUNT = 20;

/**
 * Continuous-data analogue of reliability.ts's Beta-Binomial posterior mean
 * ρ̂ = (k + κ·μ)/(n + κ): the same "evidence plus κ pseudo-observations at the
 * prior mean, divided by total weight" shape, generalized from a 0..1 rate to a
 * continuous positive mean (minutes). `personalSum` is n commits' worth of
 * minutes (i.e. personalN × their mean) so this is exact, not an approximation.
 */
export function shrinkContinuousMean(personalSum: number, personalN: number, priorMean: number, pseudoCount = PERSONAL_BASELINE_PSEUDOCOUNT): number {
  const denom = personalN + pseudoCount;
  return denom > 0 ? (personalSum + pseudoCount * priorMean) / denom : priorMean;
}

export interface ResolvedBaseline {
  minutes: Record<string, number>;
  // The baseline as an INTERVAL, per task-type. The Lift lens is most dangerous
  // near break-even (dL/dB = T/B² — small baseline errors flip the sign), so an
  // estimated baseline must carry its width into the TSF rather than pose as a
  // point. The band is identification-style, never an invented spread:
  //   · config override → exact (an audited org input, like the labor rate);
  //   · population prior alone → exact (its own width is unpublished; treating
  //     it as a point is disclosed, not hidden);
  //   · personal-shrunk → [min(population, raw personal), max(...)] — the
  //     shrunken point is a convex combination of the two, so this band is
  //     "anywhere between trusting the prior fully and trusting your own
  //     history fully", which is exactly the real uncertainty.
  minutesLow: Record<string, number>;
  minutesHigh: Record<string, number>;
  /** One human-readable sentence per task-type explaining where its number came from. */
  basis: Record<string, string>;
  notes: string[];
}

/**
 * Resolve the final per-task-type baseline-minutes table from three inputs, in
 * priority order — an explicit user override in config ALWAYS wins (the
 * existing "auditable org input" contract in config.ts is never silently
 * overridden); otherwise personal history (shrunk toward the population prior)
 * when there's any; otherwise the cited population prior alone.
 */
export function resolveBaselineMinutes(opts: {
  /** The live config.lift.baselineMinutes. */
  configBaseline: Record<string, number>;
  /** DEFAULT_CONFIG.lift.baselineMinutes — used only to detect whether the user touched a given key. */
  defaultBaseline: Record<string, number>;
  personalBuckets: PersonalBaselineBucket[];
  populationBaseline: Record<string, number>;
  pseudoCount?: number;
}): ResolvedBaseline {
  const personalByType = new Map(opts.personalBuckets.map((b) => [b.taskType, b] as const));
  const keys = new Set([...Object.keys(opts.configBaseline), ...Object.keys(opts.populationBaseline)]);
  const minutes: Record<string, number> = {};
  const minutesLow: Record<string, number> = {};
  const minutesHigh: Record<string, number> = {};
  const basis: Record<string, string> = {};
  // Per-key `basis` (above) is the full sourcing sentence; these counts are only
  // for the compact human-readable summary line below — same information, two
  // grains, so the CLI/dashboard notes line is never silent about which source
  // won even though it doesn't print all 8 sentences.
  let overrideCount = 0;
  let personalCount = 0;
  let populationCount = 0;

  for (const k of keys) {
    const userVal = opts.configBaseline[k];
    const defaultVal = opts.defaultBaseline[k];
    const popVal = opts.populationBaseline[k];

    if (userVal !== undefined && userVal !== defaultVal) {
      minutes[k] = userVal;
      minutesLow[k] = userVal;
      minutesHigh[k] = userVal;
      basis[k] = 'user override (config)';
      overrideCount++;
      continue;
    }
    const personal = personalByType.get(k as TaskType);
    if (personal && personal.n > 0 && popVal !== undefined) {
      minutes[k] = shrinkContinuousMean(personal.minutes * personal.n, personal.n, popVal, opts.pseudoCount);
      // The shrunken point is a convex combination of popVal and the raw
      // personal mean, so this band contains it by construction.
      minutesLow[k] = Math.min(popVal, personal.minutes);
      minutesHigh[k] = Math.max(popVal, personal.minutes);
      basis[k] = `personal git history (n=${personal.n} pre-tracking commit(s)), shrunk toward the population prior`;
      personalCount++;
      continue;
    }
    if (popVal !== undefined) {
      minutes[k] = popVal;
      minutesLow[k] = popVal;
      minutesHigh[k] = popVal;
      basis[k] = 'population prior (METR-anchored, no personal history yet)';
      populationCount++;
      continue;
    }
    if (userVal !== undefined) {
      minutes[k] = userVal;
      minutesLow[k] = userVal;
      minutesHigh[k] = userVal;
      basis[k] = 'config (no population default for this task-type)';
      overrideCount++;
    }
  }

  const notes = [
    `Baseline minutes: ${[...keys]
      .filter((k) => minutes[k] !== undefined)
      .map((k) => `${k}=${Math.round(minutes[k]!)}min`)
      .join(', ')}.`,
    `Baseline sources (per task-type, ${keys.size} total): ${[
      overrideCount > 0 ? `${overrideCount} config override` : null,
      personalCount > 0 ? `${personalCount} personal git history (shrunk toward the population prior)` : null,
      populationCount > 0 ? `${populationCount} population prior (METR-anchored)` : null,
    ]
      .filter((s): s is string => s !== null)
      .join(', ')}.`,
  ];
  return { minutes, minutesLow, minutesHigh, basis, notes };
}

// ---- Impure orchestration (git + store) ----

/** Mine this repo's personal baseline from its history before `cutoffMs`. */
export async function computePersonalBaseline(
  repoPath: string,
  cutoffMs: number,
  opts: { limit?: number; sessionGapMinMinutes?: number; sessionGapMaxMinutes?: number } = {},
): Promise<PersonalBaselineBucket[]> {
  const commits = await readCommitsBefore(repoPath, cutoffMs, opts.limit ?? 1000);
  return personalBaselineFromCommits(
    commits.map((c) => ({ tsEpochMs: c.tsEpochMs, subject: c.subject })),
    { cutoffMs, sessionGapMinMinutes: opts.sessionGapMinMinutes, sessionGapMaxMinutes: opts.sessionGapMaxMinutes },
  );
}

/** Past this age, a cached personal baseline is recomputed rather than trusted stale. */
const PERSONAL_BASELINE_MAX_AGE_DAYS = 30;

/**
 * The one-call resolver: load (or compute-and-cache) this project's personal
 * baseline, load the population manifest, and combine them with the live config
 * — the exact function the CLI and dashboard call instead of reading
 * `config.lift.baselineMinutes` directly. Caches the (expensive) git mining in
 * the store so it runs once per ~month per project, not on every `roi` call.
 */
export async function resolveBaselineMinutesForRepo(
  store: Store,
  repoPath: string,
  project: string,
  configBaseline: Record<string, number>,
  defaultBaseline: Record<string, number>,
): Promise<ResolvedBaseline> {
  const nowMs = Date.now();
  let personalBuckets: PersonalBaselineBucket[] = [];
  let miningFailed: string | null = null;
  try {
    const cachedRow = store.loadLiftBaseline(project);
    const freshEnough = cachedRow && nowMs - cachedRow.atMs < PERSONAL_BASELINE_MAX_AGE_DAYS * 86_400_000;
    if (cachedRow && freshEnough) {
      personalBuckets = JSON.parse(cachedRow.bucketsJson) as PersonalBaselineBucket[];
    } else {
      const cutoffMs = store.earliestRequestMs() ?? nowMs;
      personalBuckets = await computePersonalBaseline(repoPath, cutoffMs);
      store.saveLiftBaseline(project, JSON.stringify(personalBuckets), nowMs);
    }
  } catch (err) {
    // Degrade to the population prior, never throw — a broken personal signal
    // must not take down `roi`/`/api/value`. But NOT silently: logged (same
    // posture as Store.loadScanSnapshot's corrupt-row handling) and flagged in
    // `miningFailed` so the notes below can say "unavailable", not misreport it
    // as "no personal history yet" (a different, honest claim this isn't).
    console.error(`  personal baseline mining for "${project}" failed, falling back to the population prior: ${String(err)}`);
    personalBuckets = [];
    miningFailed = String(err instanceof Error ? err.message : err);
  }

  const populationBaseline = loadBaselineManifest().baselineMinutes;
  const resolved = resolveBaselineMinutes({ configBaseline, defaultBaseline, personalBuckets, populationBaseline });
  if (miningFailed) {
    resolved.notes.push(`Personal git history unavailable for "${project}" (${miningFailed}) — task-types above without a config override fall back to the population prior only.`);
  }
  return resolved;
}
