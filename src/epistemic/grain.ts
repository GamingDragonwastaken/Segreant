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
 * More dimensions mean a finer grain: request+project+day is finer than
 * project+day. Incomparable grains cannot be ordered without a domain witness.
 */
export function grainRelation(a: Grain, b: Grain): GrainRelation {
  if (sameGrain(a, b)) return 'equal';
  if (isDimensionSubset(b, a)) return 'finer';
  if (isDimensionSubset(a, b)) return 'coarser';
  return 'incomparable';
}
