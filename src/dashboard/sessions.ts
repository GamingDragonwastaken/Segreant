/**
 * The Workbench read behind the Spend page: the range's metered requests,
 * grouped by agent session, by time bucket and model, and joined to the
 * commits each session reported making.
 *
 * Everything here is metered list cost. A session's link to a commit is the
 * session's own log line (`observed_commits`), never a time-window guess, and a
 * commit's outcome is the last value read filed by `keptBucketOf`, the rule the
 * Statement uses. A session that made several commits splits its cost evenly
 * across them, and the basis sentence says so.
 */

import type { Store, RequestRow, ObservedCommit } from '../store/db.ts';
import { realizationFromStore, keptBucketOf } from '../value/realization.ts';
import { isDemo } from '../config.ts';
import type { SessionCommit, SessionCommitOutcome, SessionOutcomeShare, SessionRow, SessionsPayload } from './shared-types.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** The most session rows one read returns; the rest are counted, not listed. */
export const SESSION_LIMIT = 200;
/** The most points one session's context profile carries. */
export const PROFILE_POINTS = 40;
/** The most named models in the chart; the rest are `other`. */
export const NAMED_MODELS = 5;
/** Past this many days the chart steps by week, so a year stays readable. */
const MAX_DAY_BUCKETS = 92;

/** Context sent with one request: uncached input plus cache reads and writes. */
export function contextTokens(r: Pick<RequestRow, 'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>): number {
  return r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens;
}

/**
 * What a status code shows, and no more. 429 is a refusal by a cap, Segreant's
 * own or the provider's (the alert counts call every 429 blocked); 5xx is a
 * failure. The code alone does not say which side refused, so neither is named.
 */
export function replyKind(statusCode: number | null): 'refused' | 'failed' | null {
  if (statusCode === 429) return 'refused';
  if (statusCode !== null && statusCode >= 500) return 'failed';
  return null;
}

/** A request that reported tokens: the only kind that says how much context was sent. */
function measured(r: RequestRow): boolean {
  return contextTokens(r) + r.outputTokens > 0;
}

/**
 * A reply that went through yet reported no tokens: its usage is unknown. This
 * is not `estimated`, which says only that the PRICE came from a near match;
 * such a request may carry complete token counts (Codex review 2026-10-16).
 * A refused or failed reply with no tokens sent nothing measurable.
 */
function usageUnknown(r: RequestRow): boolean {
  return !measured(r) && (r.statusCode === null || r.statusCode < 400);
}

function localDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function localHour(ts: number): number {
  const d = new Date(ts);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

function localWeek(ts: number): number {
  const d = new Date(localDay(ts));
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // weeks start on Monday
  return d.getTime();
}

function nextBucket(start: number, step: 'hour' | 'day' | 'week'): number {
  if (step === 'hour') {
    const next = localHour(start + HOUR_MS);
    return next > start ? next : start + HOUR_MS;
  }
  // From noon of the bucket's date, so a midnight that a DST change moved to
  // 01:00 cannot carry 01:00 into every later bucket; each boundary is then
  // taken afresh as that date's own local midnight (Codex review 2026-10-16).
  const d = new Date(start);
  const noon = new Date(d.getFullYear(), d.getMonth(), d.getDate() + (step === 'week' ? 7 : 1), 12).getTime();
  return localDay(noon);
}

/** Fold a sequence to at most `points` values, each the largest in its slice. */
export function foldProfile(values: readonly number[], points = PROFILE_POINTS): { profile: number[]; sliceOf: (index: number) => number } {
  if (values.length <= points) return { profile: [...values], sliceOf: (i) => i };
  const sliceOf = (i: number): number => Math.min(points - 1, Math.floor((i * points) / values.length));
  const profile = new Array<number>(points).fill(0);
  values.forEach((v, i) => { const s = sliceOf(i); if (v > profile[s]!) profile[s] = v; });
  return { profile, sliceOf };
}

function topBy<K>(counts: Map<K, number>): K | undefined {
  let best: K | undefined;
  let bestValue = -Infinity;
  for (const [k, v] of counts) if (v > bestValue) { best = k; bestValue = v; }
  return best;
}

function add<K>(m: Map<K, number>, k: K, v: number): void {
  m.set(k, (m.get(k) ?? 0) + v);
}

export function buildSessions(
  store: Store,
  range: string,
  window: { startMs: number; endMs: number; bucketMs: number },
  opts: { now?: number; sessionLimit?: number } = {},
): SessionsPayload {
  const now = opts.now ?? Date.now();
  const sessionLimit = opts.sessionLimit ?? SESSION_LIMIT;
  const rows = store.requestsInRange(window.startMs, window.endMs);

  // Models: the five that cost most in the range keep their names.
  const modelCost = new Map<string, number>();
  for (const r of rows) add(modelCost, r.model, r.costUsd);
  const models = [...modelCost.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, NAMED_MODELS).map(([m]) => m);
  const named = new Set(models);

  // Buckets: hours for today, days otherwise, weeks for a long all-time range.
  // A bounded range is drawn whole, empty stretches included; all-time starts at the first request.
  const from = window.startMs > 0 ? window.startMs : Math.min(rows[0]?.tsEpochMs ?? now, now);
  const step: 'hour' | 'day' | 'week' = window.bucketMs <= HOUR_MS
    ? 'hour'
    : (now - from) / DAY_MS > MAX_DAY_BUCKETS ? 'week' : 'day';
  const keyOf = step === 'hour' ? localHour : step === 'week' ? localWeek : localDay;
  const buckets: SessionsPayload['buckets'] = [];
  const bucketIndex = new Map<number, number>();
  for (let b = keyOf(from); b < window.endMs && b <= now; b = nextBucket(b, step)) {
    bucketIndex.set(b, buckets.length);
    buckets.push({ startMs: b, costUsd: 0, requests: 0, byModel: [], otherUsd: 0 });
  }
  const bucketModel = buckets.map(() => new Map<string, number>());

  // Sessions, folded in one pass over the time-ordered rows.
  interface Acc {
    rows: RequestRow[];
    source: Map<string | null, number>;
    project: Map<string, number>;
    model: Map<string, number>;
  }
  const sessions = new Map<string, Acc>();
  const totals: SessionsPayload['totals'] = {
    requests: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    sessions: 0, tools: 0, refusedReplies: 0, failedReplies: 0, unsessionedRequests: 0, unsessionedCostUsd: 0,
  };
  const tools = new Set<string>();
  for (const r of rows) {
    totals.requests += 1;
    totals.costUsd += r.costUsd;
    totals.inputTokens += r.inputTokens;
    totals.outputTokens += r.outputTokens;
    totals.cacheReadTokens += r.cacheReadTokens;
    totals.cacheWriteTokens += r.cacheWriteTokens;
    const kind = replyKind(r.statusCode);
    if (kind === 'refused') totals.refusedReplies += 1;
    if (kind === 'failed') totals.failedReplies += 1;
    if (r.source) tools.add(r.source);
    const bi = bucketIndex.get(keyOf(r.tsEpochMs));
    if (bi !== undefined) {
      buckets[bi]!.costUsd += r.costUsd;
      buckets[bi]!.requests += 1;
      if (named.has(r.model)) add(bucketModel[bi]!, r.model, r.costUsd);
      else buckets[bi]!.otherUsd += r.costUsd;
    }
    if (!r.sessionId) {
      totals.unsessionedRequests += 1;
      totals.unsessionedCostUsd += r.costUsd;
      continue;
    }
    let acc = sessions.get(r.sessionId);
    if (!acc) {
      acc = { rows: [], source: new Map(), project: new Map(), model: new Map() };
      sessions.set(r.sessionId, acc);
    }
    acc.rows.push(r);
    add(acc.source, r.source ?? null, 1);
    add(acc.project, r.projectCanonical ?? r.project, r.costUsd + 1e-12);
    add(acc.model, r.model, r.costUsd + 1e-12);
  }
  totals.sessions = sessions.size;
  totals.tools = tools.size;
  buckets.forEach((b, i) => {
    b.byModel = models.filter((m) => bucketModel[i]!.has(m)).map((m) => ({ model: m, costUsd: bucketModel[i]!.get(m)! }));
  });

  // Commits: each session's own log lines, joined to the last value read.
  const report = realizationFromStore(store);
  const units = report.units;
  const observed = new Map<string, ObservedCommit[]>();
  const seenSha = new Map<string, Set<string>>();
  for (const o of store.observedCommits()) {
    if (!sessions.has(o.sessionId)) continue;
    const seen = seenSha.get(o.sessionId) ?? new Set<string>();
    if (seen.has(o.shortSha)) continue;
    seen.add(o.shortSha);
    seenSha.set(o.sessionId, seen);
    const list = observed.get(o.sessionId) ?? [];
    list.push(o);
    observed.set(o.sessionId, list);
  }
  // Indexed once: scanning every unit for every commit stalled the process
  // that also serves the proxy (Codex review 2026-10-16: 30 s at 10,000).
  const byHash = new Map<string, (typeof units)[number]>();
  const byPrefix = new Map<string, Array<(typeof units)[number]>>();
  for (const u of units) {
    const h = u.hash.toLowerCase();
    byHash.set(h, u);
    if (h.length >= 7) {
      const list = byPrefix.get(h.slice(0, 7)) ?? [];
      list.push(u);
      byPrefix.set(h.slice(0, 7), list);
    }
  }
  const commitOf = (o: ObservedCommit): SessionCommit => {
    // A log records an abbreviated sha. Only a hex abbreviation of seven or more
    // characters may stand for a longer hash, and only when exactly one
    // measured unit has it: with two, picking either would hand this session
    // another repository's outcome, so the commit stays unmatched.
    const sha = o.shortSha.toLowerCase();
    const abbreviated = sha.length >= 7 && /^[0-9a-f]+$/.test(sha);
    const exact = byHash.get(sha);
    const candidates = exact || !abbreviated ? [] : (byPrefix.get(sha.slice(0, 7)) ?? []).filter((u) => u.hash.toLowerCase().startsWith(sha));
    const unit = exact ?? (candidates.length === 1 ? candidates[0] : undefined);
    const outcome: SessionCommitOutcome = unit ? keptBucketOf(unit) : 'unmeasured';
    const checkMs = unit && outcome === 'maturing' ? unit.tsEpochMs + (unit.checkWindowDays ?? report.windowDays) * DAY_MS : null;
    return { sha: o.shortSha, subject: o.subject, tsEpochMs: o.tsEpochMs, outcome, checkMs };
  };

  const share = (): SessionOutcomeShare => ({ costUsd: 0, commits: 0 });
  const outcomes: SessionsPayload['outcomes'] = {
    kept: share(), notKept: share(), contested: share(), unknown: share(), maturing: share(), unmeasured: share(),
    noCommit: { costUsd: 0, sessions: 0 },
    basis: '',
    measuredAt: units.length > 0 ? report.generatedAt : null,
  };

  const outcomeMicros: Record<SessionCommitOutcome, number> = { kept: 0, notKept: 0, contested: 0, unknown: 0, maturing: 0, unmeasured: 0 };
  let noCommitMicros = 0;
  const built: SessionRow[] = [];
  for (const [sessionId, acc] of sessions) {
    const context: number[] = [];
    const rawMarks: Array<{ at: number; kind: 'refused' | 'failed' }> = [];
    for (const r of acc.rows) {
      if (measured(r)) context.push(contextTokens(r));
      const kind = replyKind(r.statusCode);
      if (kind) rawMarks.push({ at: Math.max(0, context.length - 1), kind });
    }
    const { profile, sliceOf } = foldProfile(context);
    const seen = new Set<string>();
    const marks = rawMarks
      .map((m) => ({ at: sliceOf(m.at), kind: m.kind }))
      .filter((m) => { const k = `${m.at}:${m.kind}`; if (seen.has(k)) return false; seen.add(k); return true; });
    const commits = (observed.get(sessionId) ?? []).sort((a, b) => a.tsEpochMs - b.tsEpochMs).map(commitOf);
    const cost = acc.rows.reduce((s, r) => s + r.costUsd, 0);
    // Exact (fractional) microdollars here; each category is rounded once, at
    // the end, against the rounded total. Rounding every session first let a
    // thousand $0.0014008 sessions add up to $1.401 of outcomes for $1.4008 of
    // spend (review 4, F1).
    if (commits.length === 0) {
      noCommitMicros += cost * 1e6;
      outcomes.noCommit.sessions += 1;
    } else {
      const share = (cost * 1e6) / commits.length;
      for (const c of commits) {
        outcomeMicros[c.outcome] += share;
        outcomes[c.outcome].commits += 1;
      }
    }
    built.push({
      sessionId,
      startMs: acc.rows[0]!.tsEpochMs,
      endMs: acc.rows[acc.rows.length - 1]!.tsEpochMs,
      source: topBy(acc.source) ?? null,
      project: topBy(acc.project) ?? '',
      model: topBy(acc.model) ?? '',
      models: acc.model.size,
      requests: acc.rows.length,
      costUsd: cost,
      inputTokens: acc.rows.reduce((s, r) => s + r.inputTokens, 0),
      outputTokens: acc.rows.reduce((s, r) => s + r.outputTokens, 0),
      cacheReadTokens: acc.rows.reduce((s, r) => s + r.cacheReadTokens, 0),
      cacheWriteTokens: acc.rows.reduce((s, r) => s + r.cacheWriteTokens, 0),
      contextStartTokens: context[0] ?? 0,
      contextEndTokens: context[context.length - 1] ?? 0,
      contextPeakTokens: context.reduce((m, v) => Math.max(m, v), 0),
      refusedReplies: acc.rows.filter((r) => replyKind(r.statusCode) === 'refused').length,
      failedReplies: acc.rows.filter((r) => replyKind(r.statusCode) === 'failed').length,
      usageUnknownRequests: acc.rows.filter(usageUnknown).length,
      profile: context.length > 0 ? profile : [],
      marks,
      commits,
    });
  }
  built.sort((a, b) => b.startMs - a.startMs || a.sessionId.localeCompare(b.sessionId));
  // Largest remainder: whole microdollars per category that add up to the
  // rounded sum of the exact parts, so the breakdown partitions the spend.
  const parts: Array<[SessionCommitOutcome | 'noCommit', number]> = [
    ...(Object.keys(outcomeMicros) as SessionCommitOutcome[]).map((k): [SessionCommitOutcome, number] => [k, outcomeMicros[k]]),
    ['noCommit', noCommitMicros],
  ];
  const whole = parts.map(([k, v]) => ({ k, floor: Math.floor(v), rem: v - Math.floor(v) }));
  let left = Math.round(parts.reduce((s, [, v]) => s + v, 0)) - whole.reduce((s, w) => s + w.floor, 0);
  for (const w of [...whole].sort((a, b) => b.rem - a.rem)) {
    if (left <= 0) break;
    w.floor += 1;
    left -= 1;
  }
  for (const w of whole) {
    if (w.k === 'noCommit') outcomes.noCommit.costUsd = w.floor / 1e6;
    else outcomes[w.k].costUsd = w.floor / 1e6;
  }

  outcomes.basis = 'Metered list cost of the sessions in this range. A session is linked to a commit only when its own log recorded making it;'
    + ' a session that made several commits splits its cost evenly across them. Each commit is filed by the last value read'
    + (outcomes.measuredAt === null ? ', and none has run on this machine yet, so every linked commit is unmeasured.' : ', by the same rule as the Statement.');

  return {
    demo: isDemo(),
    generatedAt: new Date(now).toISOString(),
    range,
    window: { startMs: window.startMs, endMs: window.endMs, bucketMs: step === 'hour' ? HOUR_MS : step === 'week' ? 7 * DAY_MS : DAY_MS },
    totals,
    models,
    buckets,
    sessions: built.slice(0, sessionLimit),
    sessionLimit,
    sessionsOmitted: Math.max(0, built.length - sessionLimit),
    outcomes,
  };
}
