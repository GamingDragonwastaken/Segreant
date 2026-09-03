/**
 * Immutable Evidence/Claim dependency graph.
 *
 * This module is the in-memory kernel projection that persistence can later
 * append to. Nodes and edges are never mutated in place; append operations
 * return a new validated snapshot. Dependency edges point from a prerequisite
 * to its dependent. Supersession is a lifecycle link and is intentionally not
 * a dependency, so revoking an old claim cannot erase a corrected successor.
 */

import { EPISTEMIC_STATES, type EpistemicState } from './state.ts';
import { instant, type Instant } from './time.ts';
import { revocationClosure, type DependencyEdge } from './revocation.ts';

export const DAG_NODE_KINDS = ['evidence', 'claim', 'assumption', 'measurement', 'decision', 'witness'] as const;
export type DagNodeKind = (typeof DAG_NODE_KINDS)[number];

export const DAG_EDGE_RELATIONS = ['supports', 'assumes', 'measures', 'derives', 'depends_on', 'witnesses', 'supersedes'] as const;
export type DagEdgeRelation = (typeof DAG_EDGE_RELATIONS)[number];

export interface DagNodeInput {
  readonly id: string;
  readonly kind: DagNodeKind;
  /** The instant at which this node became available to a consumer. */
  readonly availableAt: Instant;
  readonly epistemic?: EpistemicState;
  /** IDs of older nodes this immutable version supersedes. */
  readonly supersedes?: readonly string[];
}

export interface DagNode {
  readonly id: string;
  readonly kind: DagNodeKind;
  readonly availableAt: Instant;
  readonly epistemic: EpistemicState;
  readonly supersedes: readonly string[];
}

export interface DagEdgeInput {
  readonly from: string;
  readonly to: string;
  readonly relation: DagEdgeRelation;
}

export type DagEdge = Readonly<DagEdgeInput>;

export interface EpistemicDag {
  readonly nodes: readonly DagNode[];
  readonly edges: readonly DagEdge[];
}

export interface RevocationTraceEntry {
  readonly nodeId: string;
  readonly causedBy: string;
  readonly path: readonly string[];
}

export interface RevocationProjection {
  readonly revokedIds: readonly string[];
  readonly trace: readonly RevocationTraceEntry[];
}

const NODE_KEYS = new Set(['id', 'kind', 'availableAt', 'epistemic', 'supersedes']);
const EDGE_KEYS = new Set(['from', 'to', 'relation']);
const DEPENDENCY_RELATIONS = new Set<DagEdgeRelation>([
  'supports', 'assumes', 'measures', 'derives', 'depends_on', 'witnesses',
]);

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a non-empty string`);
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} must be non-empty`);
  return normalized;
}

function member<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== 'string' || !values.includes(value as T[number])) throw new Error(`invalid ${label}: ${String(value)}`);
  return value as T[number];
}

function assertKnownKeys(value: unknown, allowed: ReadonlySet<string>, label: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} contains unknown field: ${key}`);
}

function stringList(value: unknown, label: string): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const seen = new Set<string>();
  const output = value.map((item, index) => {
    const id = nonEmpty(item, `${label}[${index}]`);
    if (seen.has(id)) throw new Error(`duplicate ${label} entry: ${id}`);
    seen.add(id);
    return id;
  });
  return Object.freeze(output);
}

function normalizeNode(input: unknown, index: number): DagNode {
  assertKnownKeys(input, NODE_KEYS, `DAG node ${index}`);
  const value = input as DagNodeInput;
  const id = nonEmpty(value.id, `DAG node ${index} id`);
  const kind = member(value.kind, DAG_NODE_KINDS, 'DAG node kind');
  if (typeof value.availableAt !== 'string') throw new Error(`DAG node ${id} availableAt must be canonical UTC ISO-8601`);
  let availableAt: Instant;
  try {
    availableAt = instant(value.availableAt);
  } catch (error) {
    throw new Error(`DAG node ${id} availableAt: ${error instanceof Error ? error.message : String(error)}`);
  }
  const epistemic = value.epistemic === undefined ? 'unknown' : member(value.epistemic, EPISTEMIC_STATES, 'DAG node epistemic state');
  return Object.freeze({ id, kind, availableAt, epistemic, supersedes: stringList(value.supersedes, `DAG node ${id} supersedes`) });
}

function normalizeEdge(input: unknown, index: number): DagEdge {
  assertKnownKeys(input, EDGE_KEYS, `DAG edge ${index}`);
  const value = input as DagEdgeInput;
  const from = nonEmpty(value.from, `DAG edge ${index} from`);
  const to = nonEmpty(value.to, `DAG edge ${index} to`);
  if (from === to) throw new Error(`self dependency is not allowed: ${from}`);
  const relation = member(value.relation, DAG_EDGE_RELATIONS, 'DAG edge relation');
  return Object.freeze({ from, to, relation });
}

function assertAcyclic(nodes: readonly DagNode[], edges: readonly DagEdge[]): void {
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) adjacency.set(node.id, []);
  for (const edge of edges) {
    if (!DEPENDENCY_RELATIONS.has(edge.relation)) continue;
    adjacency.get(edge.from)!.push(edge.to);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`dependency graph cycle includes ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const child of adjacency.get(id) ?? []) visit(child);
    visiting.delete(id);
    visited.add(id);
  };
  for (const node of nodes) visit(node.id);
}

/** Create a fully validated immutable graph snapshot. */
export function createEpistemicDag(
  inputNodes: ReadonlyArray<DagNodeInput>,
  inputEdges: ReadonlyArray<DagEdgeInput>,
): EpistemicDag {
  if (!Array.isArray(inputNodes)) throw new Error('DAG nodes must be an array');
  if (!Array.isArray(inputEdges)) throw new Error('DAG edges must be an array');
  const nodes = inputNodes.map(normalizeNode);
  const nodeIds = new Set<string>();
  for (const node of nodes) {
    if (nodeIds.has(node.id)) throw new Error(`duplicate node: ${node.id}`);
    nodeIds.add(node.id);
  }
  for (const node of nodes) {
    for (const superseded of node.supersedes) {
      if (!nodeIds.has(superseded)) throw new Error(`unknown superseded node: ${superseded}`);
      if (superseded === node.id) throw new Error(`node cannot supersede itself: ${node.id}`);
    }
  }

  const edges = inputEdges.map(normalizeEdge);
  const edgeKeys = new Set<string>();
  for (const edge of edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) throw new Error(`unknown node in dependency edge: ${edge.from} -> ${edge.to}`);
    const key = `${edge.from}\u0000${edge.to}\u0000${edge.relation}`;
    if (edgeKeys.has(key)) throw new Error(`duplicate dependency edge: ${edge.from} -> ${edge.to} (${edge.relation})`);
    edgeKeys.add(key);
  }
  assertAcyclic(nodes, edges);
  const orderedNodes = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const orderedEdges = [...edges].sort((a, b) => {
    const from = a.from.localeCompare(b.from);
    if (from !== 0) return from;
    const to = a.to.localeCompare(b.to);
    if (to !== 0) return to;
    return a.relation.localeCompare(b.relation);
  });
  return Object.freeze({ nodes: Object.freeze(orderedNodes), edges: Object.freeze(orderedEdges) });
}

/** Append without mutating the previous graph snapshot. */
export function appendDagNode(dag: EpistemicDag, node: DagNodeInput): EpistemicDag {
  return createEpistemicDag([...dag.nodes, node], dag.edges);
}

/** Append a dependency edge without mutating the previous graph snapshot. */
export function appendDagEdge(dag: EpistemicDag, edge: DagEdgeInput): EpistemicDag {
  return createEpistemicDag(dag.nodes, [...dag.edges, edge]);
}

function dependencyEdges(dag: EpistemicDag): readonly DagEdge[] {
  return dag.edges.filter((edge) => DEPENDENCY_RELATIONS.has(edge.relation));
}

function adjacency(dag: EpistemicDag, direction: 'forward' | 'reverse', relation?: DagEdgeRelation): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const node of dag.nodes) result.set(node.id, []);
  for (const edge of dependencyEdges(dag)) {
    if (relation !== undefined && edge.relation !== relation) continue;
    const key = direction === 'forward' ? edge.from : edge.to;
    const value = direction === 'forward' ? edge.to : edge.from;
    result.get(key)!.push(value);
  }
  return result;
}

function traverse(dag: EpistemicDag, startId: string, direction: 'forward' | 'reverse', relation?: DagEdgeRelation): string[] {
  if (!dag.nodes.some((node) => node.id === startId)) throw new Error(`unknown DAG node: ${startId}`);
  const graph = adjacency(dag, direction, relation);
  const seen = new Set<string>();
  const queue = [startId];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    for (const next of graph.get(queue[cursor]!) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

export function ancestors(dag: EpistemicDag, nodeId: string): string[] {
  return traverse(dag, nodeId, 'reverse');
}

export function descendants(dag: EpistemicDag, nodeId: string): string[] {
  return traverse(dag, nodeId, 'forward');
}

export function assumptionDependencies(dag: EpistemicDag, nodeId: string): string[] {
  // The `assumes` relation identifies the immediate boundary, while nested
  // assumptions may themselves be supported/derived by other dependency edges.
  // Traverse the full ancestor cone, then retain only first-class assumptions.
  return ancestors(dag, nodeId)
    .filter((id) => dag.nodes.find((node) => node.id === id)?.kind === 'assumption');
}

export function measurementDependencies(dag: EpistemicDag, nodeId: string): string[] {
  return traverse(dag, nodeId, 'reverse', 'measures')
    .filter((id) => dag.nodes.find((node) => node.id === id)?.kind === 'measurement');
}

function pathsBetween(dag: EpistemicDag, from: string, to: string, limit = 1024): string[][] {
  const graph = adjacency(dag, 'forward');
  const paths: string[][] = [];
  const walk = (current: string, path: string[]): void => {
    if (paths.length >= limit) return;
    if (current === to) {
      paths.push(path);
      return;
    }
    for (const next of graph.get(current) ?? []) {
      if (path.includes(next)) continue;
      walk(next, [...path, next]);
    }
  };
  walk(from, [from]);
  return paths;
}

export function conflictPaths(dag: EpistemicDag, nodeId: string): string[][] {
  if (!dag.nodes.some((node) => node.id === nodeId)) throw new Error(`unknown DAG node: ${nodeId}`);
  const candidates = dag.nodes
    .filter((node) => node.epistemic === 'conflicted')
    .flatMap((node) => pathsBetween(dag, node.id, nodeId));
  return candidates.sort((a, b) => a.join('\u0000').localeCompare(b.join('\u0000')));
}

export function asOfGraph(dag: EpistemicDag, asOf: Instant): EpistemicDag {
  let boundary: Instant;
  try {
    boundary = instant(asOf);
  } catch (error) {
    throw new Error(`asOf: ${error instanceof Error ? error.message : String(error)}`);
  }
  const boundaryMs = Date.parse(boundary);
  const available = new Set(dag.nodes.filter((node) => Date.parse(node.availableAt) <= boundaryMs).map((node) => node.id));
  return createEpistemicDag(
    dag.nodes
      .filter((node) => available.has(node.id))
      .map((node) => ({ ...node, supersedes: node.supersedes.filter((id) => available.has(id)) })),
    dag.edges.filter((edge) => available.has(edge.from) && available.has(edge.to)),
  );
}

function dependencyProjectionEdges(dag: EpistemicDag): DependencyEdge[] {
  const seen = new Set<string>();
  const projected: DependencyEdge[] = [];
  for (const edge of dependencyEdges(dag)) {
    const key = `${edge.from}\u0000${edge.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    projected.push({ from: edge.from, to: edge.to });
  }
  return projected;
}

export function projectRevocation(dag: EpistemicDag, revokedNodes: ReadonlyArray<string>): RevocationProjection {
  const revokedIds = revocationClosure(revokedNodes, dependencyProjectionEdges(dag));
  const dependency = adjacency(dag, 'forward');
  const roots = [...new Set(revokedNodes.map((id, index) => nonEmpty(id, `revoked node ${index}`)))].sort((a, b) => a.localeCompare(b));
  const parent = new Map<string, { causedBy: string; previous: string | null }>();
  const queue: string[] = [];
  for (const root of roots) {
    if (!dag.nodes.some((node) => node.id === root)) throw new Error(`unknown DAG node: ${root}`);
    if (parent.has(root)) continue;
    parent.set(root, { causedBy: root, previous: null });
    queue.push(root);
  }
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]!;
    for (const next of dependency.get(current) ?? []) {
      if (parent.has(next)) continue;
      parent.set(next, { causedBy: parent.get(current)!.causedBy, previous: current });
      queue.push(next);
    }
  }
  const trace = revokedIds.map((nodeId) => {
    const entry = parent.get(nodeId);
    if (entry === undefined) {
      // An unknown root is rejected above; this fallback is only defensive for
      // a future relation filter that diverges from revocationClosure.
      return Object.freeze({ nodeId, causedBy: nodeId, path: Object.freeze([nodeId]) });
    }
    const path: string[] = [];
    let current: string | null = nodeId;
    while (current !== null) {
      path.push(current);
      current = parent.get(current)?.previous ?? null;
    }
    path.reverse();
    return Object.freeze({ nodeId, causedBy: entry.causedBy, path: Object.freeze(path) });
  });
  return Object.freeze({ revokedIds: Object.freeze(revokedIds), trace: Object.freeze(trace) });
}

function supportRoots(dag: EpistemicDag, target: string): string[] {
  const allAncestors = new Set([target, ...ancestors(dag, target)]);
  const incoming = new Set<string>();
  for (const edge of dependencyEdges(dag)) if (allAncestors.has(edge.from) && allAncestors.has(edge.to)) incoming.add(edge.to);
  return [...allAncestors].filter((id) => !incoming.has(id)).sort((a, b) => a.localeCompare(b));
}

/**
 * Return inclusion-minimal supporting root sets for `target`.
 *
 * ONE READING OF AN EDGE, NOT TWO. This function used to build one singleton
 * set per dependency root, which asserts that the roots are ALTERNATIVES: each
 * one suffices on its own. `revocationClosure` propagates revocation along
 * every dependency edge, which asserts the opposite — that each root is a
 * PREREQUISITE. Both cannot be true of the same edge, and on the two-root graph
 * they openly disagreed: supporting sets `[['e1'],['e2']]` and cut sets
 * `[['e1','e2']]` against a closure that revokes the claim on `e1` alone.
 *
 * The module header settles which reading the graph means — "Dependency edges
 * point from a prerequisite to its dependent" — and the closure is the reading
 * the product consults, through `Store.epistemic().revocationProjection()`. So
 * support is CONJUNCTIVE: the dependency roots of a target are jointly
 * necessary, there is exactly one inclusion-minimal supporting set — all of
 * them — and `minimalCutSets` then answers singletons, which is what the
 * closure does.
 *
 * WHICH DIRECTION THE OLD READING ERRED IN, and why this is soundness rather
 * than taste. It made the claim look HARDER to refute than it is: cut sets said
 * an auditor must revoke both invoices to cut the billed claim, when revoking
 * either one already cuts it. Overstating a figure's own robustness is the
 * failure this codebase exists to refuse.
 *
 * WHAT IS NOT BEING CLAIMED. Alternative (disjunctive) support is a real thing
 * that this graph cannot express: `DAG_EDGE_RELATIONS` has no disjunction, so
 * assuming it was assuming information the data does not carry. When a relation
 * registry adds it, this function, `minimalCutSets` and the closure change
 * together, and `test/epistemic-support-cut-agreement.test.ts` is what holds
 * them together. Recorded at D-098.
 */
export function minimalSupportingSets(dag: EpistemicDag, target: string): string[][] {
  if (!dag.nodes.some((node) => node.id === target)) throw new Error(`unknown DAG node: ${target}`);
  const roots = supportRoots(dag, target)
    .filter((root) => root !== target && pathsBetween(dag, root, target).length > 0)
    .sort((a, b) => a.localeCompare(b));
  return roots.length === 0 ? [] : [roots];
}

/**
 * Compute inclusion-minimal hitting sets over the supporting sets.
 *
 * Unchanged, and correct under either reading: it answers "what is the smallest
 * set whose removal breaks every supporting set?" Given one conjunctive set of
 * jointly necessary roots it answers each root alone, which is exactly what
 * `revocationClosure` does. The disagreement was never here.
 */
export function minimalCutSets(dag: EpistemicDag, target: string): string[][] {
  const supportSets = minimalSupportingSets(dag, target);
  if (supportSets.length === 0) return [];
  let cuts: string[][] = [[]];
  for (const support of supportSets) {
    const candidates: string[][] = [];
    for (const cut of cuts) {
      for (const id of support) {
        const candidate = [...new Set([...cut, id])].sort((a, b) => a.localeCompare(b));
        if (!candidates.some((existing) => existing.every((item) => candidate.includes(item)))) candidates.push(candidate);
      }
    }
    cuts = candidates.filter((candidate, index) => !candidates.some((other, otherIndex) =>
      index !== otherIndex && other.length < candidate.length && other.every((item) => candidate.includes(item)),
    ));
  }
  return cuts.sort((a, b) => a.length - b.length || a.join('\u0000').localeCompare(b.join('\u0000')));
}

export function supersededBy(dag: EpistemicDag, nodeId: string): string[] {
  if (!dag.nodes.some((node) => node.id === nodeId)) throw new Error(`unknown DAG node: ${nodeId}`);
  return dag.nodes.filter((node) => node.supersedes.includes(nodeId)).map((node) => node.id).sort((a, b) => a.localeCompare(b));
}
