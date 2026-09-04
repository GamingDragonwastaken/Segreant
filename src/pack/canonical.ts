import type { FiscusPackLimits } from './types.ts';

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * Deterministic JSON for pack metadata. Arrays retain order; plain-object keys
 * are sorted. The byte limit is supplied by the caller because a manifest and
 * its containing envelope have different resource budgets.
 */
export function canonicalPackJson(
  value: unknown,
  limits: FiscusPackLimits,
  maxBytes: number,
): string {
  const seen = new WeakSet<object>();
  let nodes = 0;
  const visit = (current: unknown, path: string, depth: number): string => {
    if (depth > limits.maxCanonicalDepth) throw new Error(`${path} exceeds canonical depth limit`);
    nodes += 1;
    if (nodes > limits.maxCanonicalNodes) throw new Error(`${path} exceeds canonical node limit`);
    if (current === null) return 'null';
    if (typeof current === 'string') {
      if (byteLength(current) > limits.maxCanonicalStringBytes) throw new Error(`${path} exceeds canonical string limit`);
      return JSON.stringify(current);
    }
    if (typeof current === 'boolean') return current ? 'true' : 'false';
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new Error(`${path} contains a non-finite number`);
      return Object.is(current, -0) ? '0' : JSON.stringify(current);
    }
    if (typeof current !== 'object') throw new Error(`${path} contains a non-JSON value`);
    if (seen.has(current)) throw new Error(`${path} contains a cycle`);
    seen.add(current);
    let result: string;
    if (Array.isArray(current)) {
      const items: string[] = [];
      for (let index = 0; index < current.length; index += 1) {
        items.push(visit(current[index], `${path}[${index}]`, depth + 1));
      }
      result = `[${items.join(',')}]`;
    } else {
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) throw new Error(`${path} is not a plain object`);
      const items: string[] = [];
      for (const key of Object.keys(current).sort((a, b) => a.localeCompare(b))) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error(`${path}.${key} is forbidden`);
        items.push(`${JSON.stringify(key)}:${visit((current as Record<string, unknown>)[key], `${path}.${key}`, depth + 1)}`);
      }
      result = `{${items.join(',')}}`;
    }
    seen.delete(current);
    if (byteLength(result) > maxBytes) throw new Error(`${path} exceeds canonical byte limit (${maxBytes})`);
    return result;
  };
  return visit(value, 'value', 0);
}