/**
 * Demo data generator.
 *
 * Produces a deterministic, clearly-synthetic dataset so every store-backed
 * surface — spend (summary / by-model / by-project / series / recent),
 * governance alerts, per-developer attribution, non-coding RoI, and the budget
 * advisor — is populated WITHOUT a real API key or days of live traffic.
 *
 * The product's honesty rule still holds. This data is:
 *   - isolated   — written to a separate `demo.db`, never the real store;
 *   - labeled    — every surface that shows it renders a "DEMO" marker;
 *   - priced for real — each synthetic request is costed by the production cost
 *                  engine (computeCost) against the same pricing table, so the
 *                  dollar figures are internally accurate for the tokens shown.
 *
 * The git-correlated value surfaces (Realization funnel, RoI Index, waste P&L,
 * per-context frontier) are lit the SAME way: synthetic work units carry
 * hand-authored gate verdicts — exactly what a real git analysis would derive —
 * then are scored and rolled up by the production functions (scoreFunnel →
 * rollupRealization → computeReturnOnIntelligence) and persisted via the real
 * writer. The demo therefore exercises the production value pipeline, not a
 * parallel fake; only the inputs are synthetic, and every surface stays DEMO.
 */

import type { Store, RequestRow, RealizationUnitRecord } from '../store/db.ts';
import { computeCost, type Provider } from '../cost/pricing.ts';
import { startOfLocalDay } from '../budget/guard.ts';
import type { WorkUnit } from '../value/realization.ts';
import { GATE_LADDER, scoreFunnel, type Gate, type GateResult, type Verdict } from '../value/gates.ts';
import { classifyTaskType } from '../value/taskType.ts';
import { boundedLift } from '../value/lift.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * A representative behavioral Time-Savings Factor for the demo — the stand-in for
 * a real transcript-judge / A-B measurement (which spends API tokens, so it is
 * deferred until the product runs for real). It is priced through the REAL
 * `boundedLift`, so the demo shows the genuine METR discounting and the
 * partially-identified RoI **interval** — not a fabricated point. Honest by
 * construction: a synthetic input, the production engine, clearly labeled DEMO.
 */
export const DEMO_TSF = 2.4;
export function demoLiftOptions(): { lift: number | null; liftRange: { low: number | null; high: number | null } } {
  const e = boundedLift({ tsfUpperBound: DEMO_TSF });
  return { lift: e.lensScore, liftRange: { low: e.lensLow, high: e.lensHigh } };
}

export interface SeedResult {
  requests: number;
  blocked: number;
  sessions: number;
  proposals: number;
  signals: number;
  realizationUnits: number;
  days: number;
  totalCostUsd: number;
}

interface ModelPick {
  provider: Provider;
  model: string;
}

// Only models that resolve to a REAL rate in pricing/models.json, so every
// synthetic request is priced exactly (estimated=false) — no invented numbers.
const OPUS: ModelPick = { provider: 'anthropic', model: 'claude-opus-4-8' };
const SONNET: ModelPick = { provider: 'anthropic', model: 'claude-sonnet-4-6' };
const HAIKU: ModelPick = { provider: 'anthropic', model: 'claude-haiku-4-5' };
const GPT4O: ModelPick = { provider: 'openai', model: 'gpt-4o' };
const GPT_MINI: ModelPick = { provider: 'openai', model: 'gpt-4.1-mini' };

const PROJECTS = ['backend-api', 'web-frontend', 'data-pipeline'];
// Six named devs — deliberately above the k-anonymity floor (5) so the demo can
// show the per-user VALUE distribution. Real deployments still default this off.
const NAMED_USERS: string[] = ['alice@team', 'bob@team', 'carol@team', 'dave@team', 'erin@team', 'frank@team'];
// Background traffic includes some unattributed calls (no x-aegis-user header).
const USERS: Array<string | null> = [...NAMED_USERS, null];
// Connected sources (feeds) — the AI tools routed through Fiscus. opencode is
// the first first-class connector; the rest are a realistic multi-tool mix, plus
// some untagged traffic (no x-aegis-source header) that reads as 'direct'.
const SOURCES: Array<string | null> = ['opencode', 'cursor', 'claude-code', null];

/**
 * Deterministic PRNG (mulberry32). A fixed seed makes the demo reproducible —
 * which keeps it honest (a single fixed scenario, not random noise that changes
 * every run) and makes it assertable in tests.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Ctx {
  store: Store;
  rng: () => number;
  n: number;
  requests: number;
  blocked: number;
  sessions: number;
  proposals: number;
  signals: number;
  cost: number;
}

function int(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

interface ReqSpec {
  tsEpochMs: number;
  model: ModelPick;
  project: string;
  user: string | null;
  source?: string | null;
  sessionId: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
  statusCode?: number;
}

/** Price a synthetic request with the real engine and insert it. */
function addRequest(ctx: Ctx, spec: ReqSpec): void {
  const blocked = spec.statusCode === 429;
  // A blocked request never reached the provider, so it has no billable usage.
  const inputTokens = blocked ? 0 : spec.inputTokens;
  const outputTokens = blocked ? 0 : spec.outputTokens;
  const cacheWriteTokens = blocked ? 0 : spec.cacheWriteTokens ?? 0;
  const cacheReadTokens = blocked ? 0 : spec.cacheReadTokens ?? 0;

  const cost = blocked
    ? { costUsd: 0, estimated: false }
    : computeCost(spec.model.provider, spec.model.model, {
        inputTokens,
        outputTokens,
        cacheWriteTokens,
        cacheReadTokens,
      });

  const row: RequestRow = {
    requestId: `demo-req-${ctx.n++}`,
    sessionId: spec.sessionId,
    tsEpochMs: spec.tsEpochMs,
    provider: spec.model.provider,
    model: spec.model.model,
    project: spec.project,
    taskWeight: 1,
    inputTokens,
    outputTokens,
    cacheWriteTokens,
    cacheReadTokens,
    reasoningTokens: 0,
    costUsd: cost.costUsd,
    estimated: cost.estimated,
    streamed: !blocked,
    statusCode: spec.statusCode ?? 200,
    durationMs: blocked ? 2 : int(ctx.rng, 600, 9000),
    user: spec.user,
    source: spec.source ?? null,
  };
  ctx.store.insertRequest(row);
  ctx.requests += 1;
  ctx.cost += cost.costUsd;
  if (blocked) ctx.blocked += 1;
}

/** A loose background call — mixed model, not tied to a session. */
function backgroundCall(ctx: Ctx, tsEpochMs: number): void {
  // Mostly cheaper models, with the occasional opus/gpt-4o so the baseline days
  // have real substance (and the model mix on the dashboard looks lived-in).
  const model = pick(ctx.rng, [SONNET, HAIKU, GPT4O, GPT_MINI, SONNET, HAIKU, OPUS]);
  addRequest(ctx, {
    tsEpochMs,
    model,
    project: pick(ctx.rng, PROJECTS),
    user: pick(ctx.rng, USERS),
    source: pick(ctx.rng, SOURCES),
    sessionId: null,
    inputTokens: int(ctx.rng, 1_200, 26_000),
    outputTokens: int(ctx.rng, 200, 3_000),
    cacheReadTokens: ctx.rng() < 0.5 ? int(ctx.rng, 2_000, 24_000) : 0,
  });
}

/** A captured AI proposal (a few added lines) — what marks a session as coding. */
function addProposal(ctx: Ctx, idx: number, sessionId: string, project: string, tsEpochMs: number): void {
  ctx.store.insertProposal({
    proposalId: `demo-prop-${idx}`,
    requestId: null,
    sessionId,
    tsEpochMs,
    provider: 'anthropic',
    model: 'claude-opus-4-8',
    project,
    files: [
      { path: `src/${project}/handler.ts`, addedLines: ['export function handle(req) {', '  return ok(req);', '}'] },
    ],
  });
  ctx.proposals += 1;
}

/**
 * A coding session: a burst of opus/sonnet calls plus a captured proposal. These
 * enrich the spend + acceptance surfaces; the realized-value picture is seeded
 * separately as persisted work units (see seedRealizationUnits).
 */
function codingSession(ctx: Ctx, idx: number, startMs: number): void {
  const sessionId = `demo-sess-code-${idx}`;
  const project = pick(ctx.rng, PROJECTS);
  const user = pick(ctx.rng, NAMED_USERS);
  const source = pick(ctx.rng, ['opencode', 'cursor']);
  ctx.store.upsertSession(sessionId, project, source, startMs);
  ctx.sessions += 1;

  const calls = int(ctx.rng, 6, 12);
  let t = startMs;
  for (let i = 0; i < calls; i++) {
    addRequest(ctx, {
      tsEpochMs: t,
      model: pick(ctx.rng, [OPUS, SONNET, SONNET]),
      project,
      user,
      source,
      sessionId,
      inputTokens: int(ctx.rng, 6_000, 45_000),
      outputTokens: int(ctx.rng, 700, 4_500),
      cacheWriteTokens: i === 0 ? int(ctx.rng, 8_000, 30_000) : 0,
      cacheReadTokens: i === 0 ? 0 : int(ctx.rng, 10_000, 80_000),
    });
    t += int(ctx.rng, 2 * 60 * 1000, 25 * 60 * 1000);
  }
  addProposal(ctx, idx, sessionId, project, startMs + 1000);
}

/**
 * A non-coding session (chat / research / drafting): a short burst with no
 * proposal, plus a reported outcome. This is the modality the store can score
 * for RoI on its own — `computeUsageRoI` reads the outcome signal keyed on the
 * session id.
 */
function nonCodingSession(ctx: Ctx, idx: number, startMs: number, outcome: string | null, user?: string | null): void {
  const sessionId = `demo-sess-chat-${idx}`;
  const project = pick(ctx.rng, PROJECTS);
  const sessionUser = user === undefined ? pick(ctx.rng, USERS) : user;
  const source = pick(ctx.rng, SOURCES);
  ctx.store.upsertSession(sessionId, project, 'chat', startMs);
  ctx.sessions += 1;

  const calls = int(ctx.rng, 2, 5);
  let t = startMs;
  for (let i = 0; i < calls; i++) {
    addRequest(ctx, {
      tsEpochMs: t,
      model: pick(ctx.rng, [SONNET, GPT4O, HAIKU]),
      project,
      user: sessionUser,
      source,
      sessionId,
      inputTokens: int(ctx.rng, 1_500, 12_000),
      outputTokens: int(ctx.rng, 300, 2_000),
      cacheReadTokens: ctx.rng() < 0.4 ? int(ctx.rng, 2_000, 12_000) : 0,
    });
    t += int(ctx.rng, 30 * 1000, 20 * 60 * 1000);
  }

  // Reported outcome → drives the non-coding funnel. `commit_hash` is reused as
  // a generic ref (the session id), matching how computeUsageRoI looks it up.
  if (outcome) {
    ctx.store.insertSignal({
      signalId: `demo-sig-${idx}`,
      kind: outcome,
      commitHash: sessionId,
      project,
      tsEpochMs: startMs + 60_000,
      verdict: outcome === 'redone' || outcome === 'incident' ? 'fail' : 'pass',
      detail: 'demo reported outcome',
    });
    ctx.signals += 1;
  }
}

// ── Realization snapshots (slice 2) ──────────────────────────────────────────
// Persisted work units that flow through the SAME funnel scorer + rollup as
// production. We author the gate verdicts (what a real git/blame/revert analysis
// would yield) and let scoreFunnel classify realized vs churned vs reverted, so
// the Realization funnel, RoI Index, waste P&L, and per-context frontier compute
// through production logic — the store-backed path a manager's dashboard reads.

type Arch = 'realized' | 'realized_light' | 'churned' | 'rejected' | 'reverted' | 'unverified' | 'maturing';

// Each archetype is a set of gate verdicts; scoreFunnel turns them into an
// outcome (realized only if nothing failed AND survived+clean both pass).
const ARCHETYPES: Record<Arch, { maturing: boolean; survival: number; verdicts: Partial<Record<Gate, Verdict>> }> = {
  realized:       { maturing: false, survival: 0.93, verdicts: { proposed: 'pass', accepted: 'pass', committed: 'pass', tested: 'pass', merged: 'pass', shipped: 'pass', survived: 'pass', clean: 'pass' } },
  realized_light: { maturing: false, survival: 0.88, verdicts: { proposed: 'pass', accepted: 'pass', committed: 'pass', tested: 'pass', survived: 'pass', clean: 'pass' } },
  churned:        { maturing: false, survival: 0.22, verdicts: { proposed: 'pass', accepted: 'pass', committed: 'pass', tested: 'pass', survived: 'fail', clean: 'pass' } },
  rejected:       { maturing: false, survival: 0.40, verdicts: { proposed: 'pass', accepted: 'fail', committed: 'pass' } },
  reverted:       { maturing: false, survival: 0.66, verdicts: { proposed: 'pass', accepted: 'pass', committed: 'pass', tested: 'pass', survived: 'pass', clean: 'fail' } },
  unverified:     { maturing: false, survival: 0.55, verdicts: { committed: 'pass' } },
  maturing:       { maturing: true,  survival: 0.70, verdicts: { proposed: 'pass', accepted: 'pass', committed: 'pass', tested: 'pass' } },
};

interface UnitSpec {
  project: string;
  model: string;
  subject: string;
  daysAgo: number;
  costUsd: number;
  linesAdded: number;
  acceptance: number | null;
  arch: Arch;
}

// A coherent fortnight-plus of committed work, clustered so the frontier has real
// cells: opus earns its price on hard backend features (all realized); gpt-4o on
// data-pipeline refactors keeps churning/reverting → a concrete routing fix.
const REALIZATION_ROSTER: UnitSpec[] = [
  { project: 'backend-api',   model: 'claude-opus-4-8',   subject: 'feat: streaming proposal reassembly', daysAgo: 24, costUsd: 4.8,  linesAdded: 320, acceptance: 0.92, arch: 'realized' },
  { project: 'backend-api',   model: 'claude-opus-4-8',   subject: 'feat: per-user attribution',          daysAgo: 21, costUsd: 3.4,  linesAdded: 240, acceptance: 0.88, arch: 'realized' },
  { project: 'backend-api',   model: 'claude-opus-4-8',   subject: 'feat: signed value receipts',         daysAgo: 18, costUsd: 3.9,  linesAdded: 280, acceptance: 0.85, arch: 'realized_light' },
  { project: 'data-pipeline', model: 'gpt-4o',            subject: 'refactor: rework series bucketing',   daysAgo: 23, costUsd: 1.2,  linesAdded: 180, acceptance: 0.68, arch: 'churned' },
  { project: 'data-pipeline', model: 'gpt-4o',            subject: 'refactor: split correlate module',    daysAgo: 20, costUsd: 1.05, linesAdded: 150, acceptance: 0.62, arch: 'reverted' },
  { project: 'data-pipeline', model: 'gpt-4o',            subject: 'refactor: dedupe attribution',        daysAgo: 17, costUsd: 0.95, linesAdded: 130, acceptance: 0.58, arch: 'churned' },
  { project: 'web-frontend',  model: 'claude-sonnet-4-6', subject: 'feat: RoI dashboard section',         daysAgo: 22, costUsd: 1.8,  linesAdded: 260, acceptance: 0.84, arch: 'realized' },
  { project: 'web-frontend',  model: 'claude-sonnet-4-6', subject: 'feat: alerts banner rework',          daysAgo: 16, costUsd: 1.3,  linesAdded: 160, acceptance: 0.52, arch: 'rejected' },
  { project: 'web-frontend',  model: 'claude-sonnet-4-6', subject: 'fix: usd zero formatting',            daysAgo: 19, costUsd: 0.3,  linesAdded: 20,  acceptance: 0.90, arch: 'realized_light' },
  { project: 'web-frontend',  model: 'claude-sonnet-4-6', subject: 'fix: dark-mode contrast',             daysAgo: 15, costUsd: 0.55, linesAdded: 45,  acceptance: 0.80, arch: 'realized' },
  { project: 'backend-api',   model: 'claude-sonnet-4-6', subject: 'test: gate funnel coverage',          daysAgo: 18, costUsd: 0.5,  linesAdded: 110, acceptance: 0.82, arch: 'realized_light' },
  { project: 'data-pipeline', model: 'gpt-4o',            subject: 'perf: batch insert requests',         daysAgo: 25, costUsd: 0.9,  linesAdded: 90,  acceptance: null, arch: 'unverified' },
  { project: 'backend-api',   model: 'claude-opus-4-8',   subject: 'feat: webhook delivery',              daysAgo: 12, costUsd: 2.2,  linesAdded: 190, acceptance: 0.86, arch: 'maturing' },
  { project: 'web-frontend',  model: 'claude-sonnet-4-6', subject: 'fix: chart axis labels',              daysAgo: 8,  costUsd: 0.45, linesAdded: 35,  acceptance: 0.80, arch: 'maturing' },
  { project: 'backend-api',   model: 'claude-opus-4-8',   subject: 'feat: per-context frontier',          daysAgo: 5,  costUsd: 1.95, linesAdded: 175, acceptance: 0.83, arch: 'maturing' },
  { project: 'data-pipeline', model: 'gpt-4o',            subject: 'refactor: store-backed realization',  daysAgo: 3,  costUsd: 0.8,  linesAdded: 120, acceptance: 0.60, arch: 'maturing' },
];

function makeRealizationUnit(ctx: Ctx, now: number, spec: UnitSpec, hash: string): WorkUnit {
  const arch = ARCHETYPES[spec.arch];
  const tsEpochMs = now - Math.floor(spec.daysAgo * DAY_MS);
  const verdicts = {} as Record<Gate, GateResult>;
  for (const g of GATE_LADDER) verdicts[g] = { gate: g, verdict: arch.verdicts[g] ?? 'unknown', detail: 'demo' };
  return {
    hash,
    tsEpochMs,
    subject: spec.subject,
    linesAdded: spec.linesAdded,
    linesDeleted: Math.round(spec.linesAdded * 0.18),
    filesChanged: int(ctx.rng, 1, 6),
    windowStartMs: tsEpochMs - 2 * HOUR_MS,
    windowEndMs: tsEpochMs,
    attributedCostUsd: spec.costUsd,
    attributedRequests: int(ctx.rng, 4, 22),
    attributedOutputTokens: int(ctx.rng, 1_500, 12_000),
    costPerHundredLines: spec.linesAdded > 0 ? (spec.costUsd / spec.linesAdded) * 100 : null,
    ageDays: spec.daysAgo,
    maturing: arch.maturing,
    survivalRatio: arch.survival,
    reverted: arch.verdicts.clean === 'fail',
    hadProposal: spec.acceptance !== null,
    acceptance: spec.acceptance,
    taskType: classifyTaskType(spec.subject),
    dominantModel: spec.model,
    funnel: scoreFunnel(verdicts),
  };
}

function unitModelPick(model: string): ModelPick {
  return model.startsWith('gpt') ? { provider: 'openai', model } : { provider: 'anthropic', model };
}

/**
 * Seed the AI requests that produced a unit, spread INSIDE its attribution window
 * and sharing one session id. This makes "time with AI" (METR 10-min windowing)
 * measurable in the demo — which is what lets the money number (RoI return) price
 * your supervision time instead of reading `un-priced`. Without it the seeded
 * requests sit in the last fortnight and never overlap the older matured units.
 */
function seedUnitTraffic(ctx: Ctx, spec: UnitSpec, u: WorkUnit): void {
  const reqs = Math.min(u.attributedRequests, 8);
  const span = Math.max(1, u.windowEndMs - u.windowStartMs);
  const model = unitModelPick(spec.model);
  const user = pick(ctx.rng, NAMED_USERS);
  const source = pick(ctx.rng, ['opencode', 'cursor', 'claude-code']);
  for (let k = 0; k < reqs; k++) {
    const base = u.windowStartMs + Math.floor((span * (k + 0.5)) / reqs);
    const ts = Math.min(u.windowEndMs, Math.max(u.windowStartMs, base + int(ctx.rng, -2 * 60_000, 2 * 60_000)));
    addRequest(ctx, {
      tsEpochMs: ts,
      model,
      project: spec.project,
      user,
      source,
      // sessionId null on purpose: this is the coding traffic that produced the
      // commit, so it must NOT be grouped as a non-coding usage session. METR
      // windowing still measures it (it buckets null sessions as one stream).
      sessionId: null,
      inputTokens: int(ctx.rng, 6_000, 30_000),
      outputTokens: int(ctx.rng, 600, 3_500),
      cacheReadTokens: int(ctx.rng, 3_000, 30_000),
    });
  }
}

/** Persist the roster as realization snapshots; returns the number written. */
function seedRealizationUnits(ctx: Ctx, now: number): number {
  const records: RealizationUnitRecord[] = REALIZATION_ROSTER.map((spec, i) => {
    const u = makeRealizationUnit(ctx, now, spec, `demo-commit-${i + 1}`);
    seedUnitTraffic(ctx, spec, u);
    return {
      commitHash: u.hash,
      project: spec.project,
      tsEpochMs: u.tsEpochMs,
      computedAtMs: now,
      attributedCostUsd: u.attributedCostUsd,
      maturing: u.maturing,
      realized: u.funnel.realized,
      unitJson: JSON.stringify(u),
    };
  });
  ctx.store.saveRealizationUnits(records);
  return records.length;
}

/**
 * Seed a full demo scenario into `store`. Caller is responsible for pointing the
 * store at the isolated demo DB and clearing it first (a fresh DB each run keeps
 * the deterministic ids collision-free).
 */
export function seedDemo(store: Store, opts: { now?: number; days?: number } = {}): SeedResult {
  const now = opts.now ?? Date.now();
  const days = opts.days ?? 14;
  const ctx: Ctx = { store, rng: mulberry32(0xae915f10), n: 0, requests: 0, blocked: 0, sessions: 0, proposals: 0, signals: 0, cost: 0 };

  // Each prior day of the fortnight: light background chatter plus a real block
  // of opus/sonnet work. This establishes a believable active-day baseline (a
  // few dollars a day) so today's runaway reads as a credible multiple of a
  // typical day — not an absurd one.
  for (let d = days - 1; d >= 1; d--) {
    const dayStart = now - d * DAY_MS;
    const at = (loHour: number, hiHour: number) =>
      dayStart + int(ctx.rng, loHour * HOUR_MS, hiHour * HOUR_MS);
    for (let i = 0, n = int(ctx.rng, 5, 10); i < n; i++) backgroundCall(ctx, at(8, 19));
    const proj = pick(ctx.rng, PROJECTS);
    const user = pick(ctx.rng, NAMED_USERS);
    for (let i = 0, n = int(ctx.rng, 6, 12); i < n; i++) {
      addRequest(ctx, {
        tsEpochMs: at(9, 18),
        model: pick(ctx.rng, [OPUS, SONNET, SONNET, OPUS]),
        project: proj,
        user,
        source: pick(ctx.rng, SOURCES),
        sessionId: null,
        inputTokens: int(ctx.rng, 8_000, 55_000),
        outputTokens: int(ctx.rng, 800, 5_000),
        cacheReadTokens: int(ctx.rng, 5_000, 60_000),
      });
    }
  }

  // Scattered work sessions over the period.
  const codingStarts = [11, 9, 7, 4].map((d) => now - d * DAY_MS + 10 * HOUR_MS);
  codingStarts.forEach((startMs, i) => codingSession(ctx, i + 1, startMs));

  // Non-coding sessions, seeded per-user so the per-user VALUE distribution is
  // real: a spread of extraction across the team (some extract nearly all their
  // spend, some little), which drives dispersion + coaching headroom in
  // `fiscus team`. Outcomes stay honest (redone = negative, null = unreported),
  // so no user shows a fake 100%. Each dev gets 3 sessions.
  const perUserOutcomes: Array<{ user: string; outcomes: Array<string | null> }> = [
    { user: 'alice@team', outcomes: ['published', 'resolved', 'used'] }, // extracts a lot
    { user: 'bob@team', outcomes: ['resolved', 'used', null] },
    { user: 'carol@team', outcomes: ['used', 'published', 'redone'] },
    { user: 'dave@team', outcomes: ['used', null, null] },
    { user: 'erin@team', outcomes: ['resolved', 'redone', null] },
    { user: 'frank@team', outcomes: ['redone', null, null] }, // could use enablement
  ];
  let chatIdx = 1;
  for (const { user, outcomes } of perUserOutcomes) {
    for (const o of outcomes) {
      nonCodingSession(ctx, chatIdx++, now - int(ctx.rng, 1, days - 1) * DAY_MS + 13 * HOUR_MS, o, user);
    }
  }

  // TODAY runs hot: a looping coding agent (many large opus calls) plus normal
  // background. This is what makes today's spend breach the demo daily cap
  // (budget alert), exceed 2x the prior active-day p90 (spend-spike), and —
  // having hit the cap — get throttled (429s). All of today's data is anchored
  // to the current local day so it lands in the "today" window at any wall-clock
  // hour, then walks up to `now`.
  const dayStartMs = startOfLocalDay(now);
  const hotStart = Math.max(dayStartMs + 30 * 60 * 1000, now - 150 * 60 * 1000);
  const hotEnd = Math.max(hotStart + 1, now - 60 * 1000);
  const span = hotEnd - hotStart;
  const hotSession = 'demo-sess-code-5';
  ctx.store.upsertSession(hotSession, 'backend-api', 'claude-code', hotStart);
  ctx.sessions += 1;

  const hotCalls = int(ctx.rng, 60, 80);
  for (let i = 0; i < hotCalls; i++) {
    addRequest(ctx, {
      tsEpochMs: hotStart + Math.floor(((i + 1) / hotCalls) * span),
      model: OPUS,
      project: 'backend-api',
      user: 'alice@team',
      source: 'claude-code',
      sessionId: hotSession,
      inputTokens: int(ctx.rng, 45_000, 120_000),
      outputTokens: int(ctx.rng, 3_000, 8_000),
      cacheWriteTokens: i === 0 ? int(ctx.rng, 10_000, 30_000) : 0,
      cacheReadTokens: i === 0 ? 0 : int(ctx.rng, 15_000, 90_000),
    });
  }
  addProposal(ctx, 5, hotSession, 'backend-api', hotStart + 1000);

  for (let i = 0; i < int(ctx.rng, 4, 7); i++) {
    backgroundCall(ctx, hotStart + Math.floor(ctx.rng() * span));
  }

  // A handful of blocked (429) requests in the last hour — the cap doing its job.
  for (let i = 0; i < 5; i++) {
    addRequest(ctx, {
      tsEpochMs: Math.max(dayStartMs + 60 * 1000, now - int(ctx.rng, 2 * 60 * 1000, 50 * 60 * 1000)),
      model: OPUS,
      project: 'backend-api',
      user: 'alice@team',
      source: 'claude-code',
      sessionId: hotSession,
      inputTokens: 0,
      outputTokens: 0,
      statusCode: 429,
    });
  }

  const realizationUnits = seedRealizationUnits(ctx, now);

  return {
    requests: ctx.requests,
    blocked: ctx.blocked,
    sessions: ctx.sessions,
    proposals: ctx.proposals,
    signals: ctx.signals,
    realizationUnits,
    days,
    totalCostUsd: ctx.cost,
  };
}
