/** Canonical dimensional grain for an observation or claim. */
export interface Grain {
  readonly dimensions: readonly string[];
}

export type GrainRelation = 'equal' | 'finer' | 'coarser' | 'incomparable';

function canonicalDimension(value: string): string {
  const dimension = value.trim();
  if (dimension.length === 0) throw new Error('grain dimensions must be non-empty');
  return dimension;
}

export function grain(dimensions: readonly string[]): Grain {
  const canonical = dimensions.map(canonicalDimension).sort();
  for (let i = 1; i < canonical.length; i++) {
    if (canonical[i] === canonical[i - 1]) throw new Error(`duplicate grain dimension: ${canonical[i]}`);
  }
  return Object.freeze({ dimensions: Object.freeze(canonical) });
}

export function sameGrain(a: Grain, b: Grain): boolean {
  return a.dimensions.length === b.dimensions.length && a.dimensions.every((dimension, i) => dimension === b.dimensions[i]);
}

function isDimensionSubset(subset: Grain, superset: Grain): boolean {
  const available = new Set(superset.dimensions);
  return subset.dimensions.every((dimension) => available.has(dimension));
}

/**
 * THE DOMAIN WITNESS `grainRelation` SAYS IT NEEDS.
 *
 * Each entry declares that the first dimension is CONTAINED in the second:
 * every `billing_record` falls inside exactly one `billing_period`, so a figure
 * reported per period aggregates records rather than inventing anything. Set
 * containment alone cannot see this — the two names share no dimension, so
 * `grainRelation` returns `incomparable`, the same verdict it returns for a
 * claim at `[model]` citing evidence at `[day]`, which IS an invention.
 *
 * THIS IS A CLAIM ABOUT THE WORLD, NOT A PERMISSION FOR A CALLER. An earlier
 * repair excepted `derivationRule.startsWith('billing.')` from the grain check:
 * a rule about who was calling, wearing the shape of a rule about evidence. It
 * covered one of the two roll-ups the product performs and left the other red.
 * An entry here is instead true or false of the domain, auditable as data, and
 * covers every caller that aggregates those dimensions — including ones not
 * written yet.
 *
 * ADDING AN ENTRY IS A DECISION. It asserts a real partition: that the finer
 * dimension names a set of things each of which belongs to exactly one thing
 * named by the coarser one. If that is not true, every aggregation licensed by
 * the entry is unsound, and the kernel will not be able to tell. Entries are
 * directed and must stay acyclic — the reverse direction is refinement, which is
 * precisely the laundering this check exists to refuse.
 */
export const DIMENSION_ROLLUPS: ReadonlyArray<readonly [finer: string, coarser: string]> = Object.freeze([
  Object.freeze(['billing_record', 'billing_period'] as const),
  Object.freeze(['provider_project_day_line_item', 'provider_project_period'] as const),
]);

/** True when `finer` is declared to be contained in `coarser`. Directed; never reflexive. */
export function grainRollsUpInto(finer: string, coarser: string): boolean {
  if (finer === coarser) return false;
  return DIMENSION_ROLLUPS.some(([from, into]) => from === finer && into === coarser);
}

/**
 * Every dimension of `claimed` is either present in `observed` or is a declared
 * coarsening of some dimension in `observed` — so nothing in the claim names a
 * distinction the evidence could not have made.
 *
 * Dimensions PRESENT in the evidence and absent from the claim are ignored on
 * purpose: dropping a dimension discards resolution, which is what aggregation
 * is. Only what the claim ADDS has to be accounted for.
 */
export function grainIsSupportedBy(claimed: Grain, observed: Grain): boolean {
  const available = new Set(observed.dimensions);
  return claimed.dimensions.every((dimension) =>
    available.has(dimension) || observed.dimensions.some((source) => grainRollsUpInto(source, dimension)));
}

/**
 * More dimensions mean a finer grain: request+project+day is finer than
 * project+day. Incomparable grains cannot be ordered without a domain witness.
 */
export function grainRelation(a: Grain, b: Grain): GrainRelation {
  if (sameGrain(a, b)) return 'equal';
  if (isDimensionSubset(b, a)) return 'finer';
  if (isDimensionSubset(a, b)) return 'coarser';
  return 'incomparable';
}
