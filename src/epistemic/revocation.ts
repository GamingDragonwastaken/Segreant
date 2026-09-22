/**
 * Dependency-graph revocation closure.
 *
 * Edges point from a prerequisite to the claim/decision that depends on it.
 * Revocation is additive: the graph and its node identities remain untouched;
 * this function only computes the nodes that can no longer be certified from a
 * supplied set of revoked prerequisites. Cycles are traversed safely and
 * repeated revocations are idempotent.
 */

export interface DependencyEdge {
  readonly from: string;
  readonly to: string;
}

function nodeId(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be non-empty`);
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} must be non-empty`);
  return normalized;
}

function validateGraph(graph: ReadonlyArray<DependencyEdge>): Map<string, Set<string>> {
  if (!Array.isArray(graph)) throw new Error('dependency graph must be an array');
  const descendants = new Map<string, Set<string>>();
  for (let index = 0; index < graph.length; index += 1) {
    const edge = graph[index];
    if (edge === null || typeof edge !== 'object') {
      throw new Error(`dependency edge ${index} must be an object`);
    }
    const from = nodeId(edge.from, `dependency edge ${index} from`);
    const to = nodeId(edge.to, `dependency edge ${index} to`);
    const targets = descendants.get(from) ?? new Set<string>();
    if (targets.has(to)) throw new Error(`duplicate dependency edge: ${from} -> ${to}`);
    targets.add(to);
    descendants.set(from, targets);
  }
  return descendants;
}

/**
 * Return every revoked prerequisite and transitive dependent in stable order.
 * Independent branches remain outside the closure, including when they share
 * a downstream decision with a revoked branch.
 */
export function revocationClosure(
  revokedNodes: ReadonlyArray<string>,
  graph: ReadonlyArray<DependencyEdge>,
): string[] {
  if (!Array.isArray(revokedNodes)) throw new Error('revoked nodes must be an array');
  const descendants = validateGraph(graph);
  const revoked = new Set<string>();
  const queue: string[] = [];

  for (let index = 0; index < revokedNodes.length; index += 1) {
    const id = nodeId(revokedNodes[index], `revoked node ${index}`);
    if (!revoked.has(id)) {
      revoked.add(id);
      queue.push(id);
    }
  }

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const node = queue[cursor]!;
    for (const dependent of descendants.get(node) ?? []) {
      if (revoked.has(dependent)) continue;
      revoked.add(dependent);
      queue.push(dependent);
    }
  }

  return [...revoked].sort((a, b) => a.localeCompare(b));
}
