/** A canonical conjunction of explicit scope constraints. */
export interface ScopeConstraint {
  readonly key: string;
  readonly value: string;
}

export interface Scope {
  readonly constraints: readonly ScopeConstraint[];
}

export type ScopeRelation = 'equal' | 'narrower' | 'broader' | 'disjoint' | 'overlapping';

function canonicalPart(value: string, label: string): string {
  const canonical = value.trim();
  if (canonical.length === 0) throw new Error(`scope ${label} must be non-empty`);
  return canonical;
}

export function scope(input: Readonly<Record<string, string>>): Scope {
  const constraints = Object.entries(input)
    .map(([key, value]) => Object.freeze({
      key: canonicalPart(key, 'key'),
      value: canonicalPart(value, 'value'),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

  for (let i = 1; i < constraints.length; i++) {
    if (constraints[i]!.key === constraints[i - 1]!.key) {
      throw new Error(`duplicate scope key: ${constraints[i]!.key}`);
    }
  }
  return Object.freeze({ constraints: Object.freeze(constraints) });
}

export function sameScope(a: Scope, b: Scope): boolean {
  return a.constraints.length === b.constraints.length
    && a.constraints.every((constraint, i) => {
      const other = b.constraints[i];
      return other !== undefined && constraint.key === other.key && constraint.value === other.value;
    });
}

function constraintMap(value: Scope): ReadonlyMap<string, string> {
  return new Map(value.constraints.map((constraint) => [constraint.key, constraint.value]));
}

function extendsScope(candidate: Scope, base: Scope): boolean {
  const candidateMap = constraintMap(candidate);
  return base.constraints.every((constraint) => candidateMap.get(constraint.key) === constraint.value);
}

function hasContradiction(a: Scope, b: Scope): boolean {
  const bMap = constraintMap(b);
  return a.constraints.some((constraint) => {
    const other = bMap.get(constraint.key);
    return other !== undefined && other !== constraint.value;
  });
}

/**
 * Scope ordering is structural only. A narrower scope carries every constraint
 * in the broader scope plus at least one more. This relation does not itself
 * authorize deriving one scope from another; derivation witnesses do that.
 */
export function scopeRelation(a: Scope, b: Scope): ScopeRelation {
  if (sameScope(a, b)) return 'equal';
  if (hasContradiction(a, b)) return 'disjoint';
  if (extendsScope(a, b)) return 'narrower';
  if (extendsScope(b, a)) return 'broader';
  return 'overlapping';
}
