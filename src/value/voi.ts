/**
 * Value of Information — which measurement to buy next.
 * (docs/RETURN-ON-INTELLIGENCE.md §12.)
 *
 * The Index is an upper bound while lenses are un-instrumented (§5): every
 * unmeasured necessary condition can only pull it DOWN. But "wire more lenses"
 * is not a decision — "wire THIS lens next" is. This module ranks the
 * un-instrumented lenses by how much the Index would move if each were measured,
 * completing the decision calculus:
 *
 *   shadow price (§9)  — where does the next DOLLAR go?
 *   VoI (this)         — which MEASUREMENT do I buy next?
 *   anytime CS (§10)   — when do I actually KNOW?
 *
 * The arithmetic is transparent — no invented priors. If lens k (weight w_k)
 * were measured at a reference value v, the geometric composite becomes
 *
 *   Index_k(v) = 100 · exp( (Σᵢ wᵢ ln xᵢ + w_k ln v) / (Σᵢ wᵢ + w_k) )
 *
 * over the currently instrumented lenses i. We evaluate at a DISCLOSED neutral
 * reference (v = 0.5 by default — the midpoint, not a prediction) and rank by
 * the size of the move. The exposure is real regardless of the reference's
 * exact position: a heavier, further-from-current lens moves the Index more,
 * and measuring can only make the number more honest.
 */

import { DEFAULT_LENS_WEIGHTS, type RoIResult } from './lenses.ts';

export type LensName = 'realization' | 'acceptance' | 'lift' | 'impact';

export interface InstrumentationPriority {
  lens: LensName;
  /** The lens's output elasticity in the composite — its leverage. */
  weight: number;
  /** The Index if this lens were measured at the reference value. */
  indexAtReference: number;
  /** indexAtReference − current Index (usually negative: more measurement, more honest). */
  deltaAtReference: number;
  /** The disclosed reference the exposure was evaluated at. */
  reference: number;
}

/**
 * Rank un-instrumented lenses by unmeasured exposure. Empty when everything is
 * instrumented (nothing left to buy) or nothing is (no base to move from).
 */
export function instrumentationPriority(
  roi: RoIResult,
  opts: { weights?: typeof DEFAULT_LENS_WEIGHTS; reference?: number } = {},
): InstrumentationPriority[] {
  const w = opts.weights ?? DEFAULT_LENS_WEIGHTS;
  const v = Math.min(0.99, Math.max(0.01, opts.reference ?? 0.5));
  if (roi.roiIndex === null) return [];

  const names: LensName[] = ['realization', 'acceptance', 'lift', 'impact'];
  let sumW = 0;
  let sumWLn = 0;
  for (const name of names) {
    const lens = roi.lenses[name];
    if (lens.instrumented && lens.value !== null) {
      const x = Math.min(1, Math.max(1e-4, lens.value));
      sumW += w[name];
      sumWLn += w[name] * Math.log(x);
    }
  }
  if (sumW <= 0) return [];

  const out: InstrumentationPriority[] = [];
  for (const name of names) {
    const lens = roi.lenses[name];
    if (lens.instrumented && lens.value !== null) continue;
    const wk = w[name];
    const indexAtReference = 100 * Math.exp((sumWLn + wk * Math.log(v)) / (sumW + wk));
    out.push({
      lens: name,
      weight: wk,
      indexAtReference,
      deltaAtReference: indexAtReference - roi.roiIndex,
      reference: v,
    });
  }
  out.sort((a, b) => Math.abs(b.deltaAtReference) - Math.abs(a.deltaAtReference));
  return out;
}
