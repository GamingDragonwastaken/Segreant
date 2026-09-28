/**
 * The consensus quality score: many public benchmarks combined into one number
 * per model and kind of work, without pretending they share a scale.
 *
 * A plain mean of raw scores would be wrong twice over: benchmarks differ in
 * difficulty (a model tested only on hard ones would look weak), and they cover
 * different models. So, as Epoch AI does for its Capabilities Index, each score
 * is chance-corrected onto [0, 1] and a small item-response model is fitted:
 *
 *   expected score(model m, benchmark b) = sigmoid(a_b * (ability_m - difficulty_b))
 *
 * Abilities and benchmark difficulties are estimated together, each observation
 * weighted by its benchmark's published reliability. The displayed score is the
 * expected chance-corrected score on a typical benchmark of the category, 0-100.
 * Uncertainty is the leave-one-benchmark-out spread: how far a model's score
 * moves when any single benchmark is dropped. A model needs at least two
 * benchmarks to get a score at all.
 */

export type ConsensusCategoryId = 'coding' | 'general-chat';

/** Published reliability rubric, one row per benchmark. Weight = product of the three. */
export interface BenchmarkReliability {
  /** Name exactly as it appears in the source data. */
  benchmark: string;
  category: ConsensusCategoryId;
  /** 1.0 run by an independent evaluator; 0.8 third-party leaderboard; 0.5 vendor-reported. */
  independence: number;
  /** 1.0 private or continuously refreshed tasks; lower for public, likely-trained-on sets. */
  contamination: number;
  why: string;
}

export const RELIABILITY: readonly BenchmarkReliability[] = [
  { benchmark: 'SWE-Bench verified', category: 'coding', independence: 1.0, contamination: 0.6, why: 'Run by Epoch AI on real GitHub issues; the task set is public, so training exposure is likely.' },
  { benchmark: 'Terminal Bench', category: 'coding', independence: 0.8, contamination: 0.8, why: 'Third-party leaderboard of terminal tasks; submissions pair a model with an agent scaffold.' },
  { benchmark: 'DeepSWE', category: 'coding', independence: 0.8, contamination: 0.9, why: 'Recent third-party software-engineering benchmark with fresh tasks.' },
  { benchmark: 'GSO-Bench', category: 'coding', independence: 0.8, contamination: 0.8, why: 'Third-party software-optimisation benchmark.' },
  { benchmark: 'Aider polyglot', category: 'coding', independence: 0.8, contamination: 0.6, why: 'Third-party leaderboard; public exercises; no new results since late 2025.' },
  { benchmark: 'LMArena WebDev', category: 'coding', independence: 0.8, contamination: 1.0, why: 'Live human preference votes on web apps; labs can test privately before release.' },
  { benchmark: 'GPQA diamond', category: 'general-chat', independence: 1.0, contamination: 0.6, why: 'Run by Epoch AI; graduate-level science questions, public set.' },
  { benchmark: 'HLE', category: 'general-chat', independence: 1.0, contamination: 0.8, why: "Humanity's Last Exam, run by Epoch AI; hard expert questions, partly held out." },
  { benchmark: 'SimpleQA Verified', category: 'general-chat', independence: 1.0, contamination: 0.7, why: 'Run by Epoch AI; short factual questions, measures accuracy and hallucination.' },
  { benchmark: 'SimpleBench', category: 'general-chat', independence: 0.8, contamination: 1.0, why: 'Third-party everyday-reasoning benchmark with a private question set.' },
  { benchmark: 'Fiction.LiveBench', category: 'general-chat', independence: 0.8, contamination: 0.9, why: 'Third-party long-context comprehension benchmark.' },
  { benchmark: 'Lech Mazur Writing', category: 'general-chat', independence: 0.8, contamination: 0.9, why: 'Third-party creative-writing benchmark graded by a model panel.' },
  { benchmark: 'LMArena text', category: 'general-chat', independence: 0.8, contamination: 1.0, why: 'Live human preference votes on chat; labs can test privately before release.' },
];

/** A benchmark with no new result in this many days counts at half weight. */
export const STALE_AFTER_DAYS = 180;

export interface ConsensusObservation {
  /** Canonical model key (see `canonicalModel`). */
  model: string;
  /** Display name as the source wrote it. */
  label: string;
  benchmark: string;
  /** Chance-corrected score in [0, 1]. */
  score: number;
  date: string | null;
}

export interface ConsensusRow {
  model: string;
  label: string;
  /** Expected chance-corrected score on a typical benchmark of the category, 0-100. */
  score: number;
  /** Leave-one-benchmark-out range, 0-100. */
  low: number;
  high: number;
  benchmarks: Array<{ benchmark: string; score: number; date: string | null }>;
  basis: 'public_benchmark_consensus';
}

export interface ConsensusResult {
  category: ConsensusCategoryId;
  rows: ConsensusRow[];
  weights: Array<{ benchmark: string; weight: number; independence: number; contamination: number; currency: number; newest: string | null; models: number; why: string }>;
  /** Models seen on only one benchmark: shown by the board, never given a consensus score. */
  singleSource: number;
}

const EFFORT = /-(xhigh|high|medium|low|minimal|max|none|thinking|non-thinking|nothinking|no-thinking|reasoning|instant|latest|preview|exp|experimental|beta|unknown|\d+k|\d+k-thinking)$/;
const DATED = /-(\d{8}|\d{4}-\d{2}-\d{2}|\d{4}|\d{2}-\d{2})$/;

/**
 * One key for "the same model" across sources: lower-case, parentheticals and
 * provider prefixes dropped, dots/underscores/spaces as hyphens, then date and
 * effort suffixes stripped. `Claude Opus 4.6`, `claude-opus-4-6-high` and
 * `claude-opus-4.6 (thinking)` all become `claude-opus-4-6`.
 */
export function canonicalModel(name: string): string {
  let n = name.toLowerCase().replace(/\s*[([].*?[)\]]/g, '').trim();
  n = n.slice(n.lastIndexOf('/') + 1);
  n = n.replace(/[\s._:]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  for (let i = 0; i < 6; i++) {
    const next = n.replace(DATED, '').replace(EFFORT, '');
    if (next === n) break;
    n = next;
  }
  return n;
}

/** Elo-style rating -> probability of beating a reference-rated model; a bounded [0,1] score. */
export function ratingToScore(rating: number, reference: number): number {
  return 1 / (1 + 10 ** ((reference - rating) / 400));
}

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

interface Fit { ability: Map<string, number>; slope: Map<string, number>; difficulty: Map<string, number> }

/** Weighted least squares on the logistic item-response model, by Adam. Deterministic. */
function fit(obs: readonly ConsensusObservation[], weight: ReadonlyMap<string, number>, iterations = 1500): Fit {
  const models = [...new Set(obs.map((o) => o.model))];
  const benches = [...new Set(obs.map((o) => o.benchmark))];
  const mi = new Map(models.map((m, i) => [m, i]));
  const bi = new Map(benches.map((b, i) => [b, i]));
  const theta = new Float64Array(models.length);
  const alpha = new Float64Array(benches.length); // slope = exp(alpha)
  const diff = new Float64Array(benches.length);
  for (const b of benches) {
    const ys = obs.filter((o) => o.benchmark === b).map((o) => o.score);
    const mean = Math.min(0.95, Math.max(0.05, ys.reduce((s, y) => s + y, 0) / ys.length));
    diff[bi.get(b)!] = -Math.log(mean / (1 - mean));
  }
  const params = [theta, alpha, diff];
  const m1 = params.map((p) => new Float64Array(p.length));
  const m2 = params.map((p) => new Float64Array(p.length));
  const lr = 0.05, b1 = 0.9, b2 = 0.999, eps = 1e-8, ridge = 0.01;
  const idx = obs.map((o) => [mi.get(o.model)!, bi.get(o.benchmark)!, o.score, weight.get(o.benchmark) ?? 0] as const);
  for (let t = 1; t <= iterations; t++) {
    const g = params.map((p) => new Float64Array(p.length));
    for (const [m, b, y, w] of idx) {
      const a = Math.exp(alpha[b]!);
      const z = a * (theta[m]! - diff[b]!);
      const p = sigmoid(z);
      const r = 2 * w * (p - y) * p * (1 - p);
      g[0]![m]! += r * a;
      g[1]![b]! += r * z;
      g[2]![b]! -= r * a;
    }
    for (let k = 0; k < params.length; k++) {
      const p = params[k]!;
      for (let j = 0; j < p.length; j++) {
        const grad = g[k]![j]! + 2 * ridge * p[j]!;
        m1[k]![j] = b1 * m1[k]![j]! + (1 - b1) * grad;
        m2[k]![j] = b2 * m2[k]![j]! + (1 - b2) * grad * grad;
        p[j] = p[j]! - lr * (m1[k]![j]! / (1 - b1 ** t)) / (Math.sqrt(m2[k]![j]! / (1 - b2 ** t)) + eps);
      }
    }
  }
  return {
    ability: new Map(models.map((m, i) => [m, theta[i]!])),
    slope: new Map(benches.map((b, i) => [b, Math.exp(alpha[i]!)])),
    difficulty: new Map(benches.map((b, i) => [b, diff[i]!])),
  };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const h = Math.floor(s.length / 2);
  return s.length % 2 ? s[h]! : (s[h - 1]! + s[h]!) / 2;
}

/** Score on the category's typical benchmark (median slope and difficulty), 0-100. */
function display(f: Fit, ability: number): number {
  const a = median([...f.slope.values()]);
  const d = median([...f.difficulty.values()]);
  return 100 * sigmoid(a * (ability - d));
}

export function buildConsensus(category: ConsensusCategoryId, all: readonly ConsensusObservation[], today: string): ConsensusResult {
  const rubric = RELIABILITY.filter((r) => r.category === category);
  const obs = all.filter((o) => rubric.some((r) => r.benchmark === o.benchmark));
  const newest = new Map<string, string | null>();
  for (const o of obs) {
    const cur = newest.get(o.benchmark) ?? null;
    if (o.date && (!cur || o.date > cur)) newest.set(o.benchmark, o.date);
    else if (!newest.has(o.benchmark)) newest.set(o.benchmark, cur);
  }
  const ageDays = (d: string | null) => (d ? (Date.parse(today) - Date.parse(d)) / 86_400_000 : Infinity);
  const weights = rubric.filter((r) => obs.some((o) => o.benchmark === r.benchmark)).map((r) => {
    const n = newest.get(r.benchmark) ?? null;
    const currency = ageDays(n) > STALE_AFTER_DAYS ? 0.5 : 1;
    return { benchmark: r.benchmark, weight: r.independence * r.contamination * currency, independence: r.independence, contamination: r.contamination, currency, newest: n, models: new Set(obs.filter((o) => o.benchmark === r.benchmark).map((o) => o.model)).size, why: r.why };
  });
  const w = new Map(weights.map((x) => [x.benchmark, x.weight]));

  // One observation per (model, benchmark): the best reported, as sources list effort variants separately.
  const best = new Map<string, ConsensusObservation>();
  for (const o of obs) {
    const k = `${o.model}\u0000${o.benchmark}`;
    const cur = best.get(k);
    if (!cur || o.score > cur.score) best.set(k, o);
  }
  const dedup = [...best.values()];
  const perModel = new Map<string, ConsensusObservation[]>();
  for (const o of dedup) perModel.set(o.model, [...(perModel.get(o.model) ?? []), o]);
  const eligible = new Set([...perModel].filter(([, os]) => os.length >= 2).map(([m]) => m));
  const fitted = dedup.filter((o) => eligible.has(o.model));
  if (!fitted.length) return { category, rows: [], weights, singleSource: perModel.size };

  const full = fit(fitted, w);
  // Leave-one-benchmark-out: refit without each benchmark; a model keeps a value only if it still has two.
  const benches = [...new Set(fitted.map((o) => o.benchmark))];
  const spread = new Map<string, number[]>();
  for (const drop of benches) {
    const rest = fitted.filter((o) => o.benchmark !== drop);
    const counts = new Map<string, number>();
    for (const o of rest) counts.set(o.model, (counts.get(o.model) ?? 0) + 1);
    const kept = rest.filter((o) => (counts.get(o.model) ?? 0) >= 2);
    if (!kept.length) continue;
    const f = fit(kept, w, 900);
    for (const [m, ab] of f.ability) spread.set(m, [...(spread.get(m) ?? []), display(f, ab)]);
  }
  const rows: ConsensusRow[] = [...eligible].map((m) => {
    const os = perModel.get(m)!;
    const score = display(full, full.ability.get(m)!);
    const loo = spread.get(m) ?? [];
    return {
      model: m, label: os[0]!.label, score,
      low: Math.min(score, ...loo), high: Math.max(score, ...loo),
      benchmarks: os.map((o) => ({ benchmark: o.benchmark, score: o.score, date: o.date })).sort((a, b) => a.benchmark.localeCompare(b.benchmark)),
      basis: 'public_benchmark_consensus' as const,
    };
  });
  rows.sort((a, b) => b.score - a.score || a.model.localeCompare(b.model));
  return { category, rows, weights, singleSource: perModel.size - eligible.size };
}
