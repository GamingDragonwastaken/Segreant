/**
 * SQLite persistence for the Trusted Epistemic Kernel's immutable objects.
 *
 * This is intentionally a small kernel ledger, separate from Fiscus's existing
 * operational Store tables. Every accepted object is retained as canonical JSON
 * plus a digest; nodes, dependency edges, and revocation events are append-only
 * and protected by database triggers. Exact replays are idempotent, while a
 * different payload for an existing identity is an integrity error.
 */

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { initializeEpistemicSchema } from '../store/schema.ts';
import { claim, type Claim } from './claim.ts';
import { assumption, type Assumption } from './assumption.ts';
import { evidence, type Evidence } from './evidence.ts';
import {
  DAG_NODE_KINDS,
  asOfGraph,
  createEpistemicDag,
  projectRevocation,
  type DagEdge,
  type DagEdgeInput,
  type DagNode,
  type DagNodeInput,
  type EpistemicDag,
  type RevocationProjection,
} from './dag.ts';
import { EPISTEMIC_STATES } from './state.ts';
import { derivation, type Derivation, type DerivationInput, type DerivationWitness } from './derivation.ts';
import { canonicalJson } from './serialization.ts';
import { instant, type Instant } from './time.ts';
import { witness, type Witness } from './witness.ts';

export type AppendResult = 'inserted' | 'duplicate';

export interface RevocationEventInput {
  readonly eventId: string;
  readonly targetId: string;
  readonly recordedAt: Instant;
  readonly reason: string;
}

/** A single, hindsight-safe projection of the kernel at an observation boundary. */
export interface EpistemicReplay {
  readonly asOf: Instant;
  readonly graph: EpistemicDag;
  readonly revocation: RevocationProjection;
}

interface StoredNodeRow {
  node_id: string;
  node_kind: string;
  available_at: string;
  epistemic: string;
  supersedes_json: string;
}

interface StoredPayloadRow {
  json: string;
  digest: string;
}

interface StoredEventRow {
  event_id: string;
  target_id: string;
  recorded_at: string;
  reason: string;
}

interface StoredEdgeRow {
  from_id: string;
  to_id: string;
  relation: string;
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be non-empty`);
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} must be non-empty`);
  return normalized;
}

function canonicalInstant(value: unknown, label: string): Instant {
  if (typeof value !== 'string') throw new Error(`${label} must be canonical UTC ISO-8601`);
  try {
    return instant(value);
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function nodeIdList(value: unknown, label: string): readonly string[] {
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

function normalizeNodeForLedger(input: DagNodeInput): DagNode {
  const id = nonEmpty(input.id, 'DAG node id');
  if (typeof input.kind !== 'string' || !DAG_NODE_KINDS.includes(input.kind as DagNode['kind'])) throw new Error(`invalid DAG node kind: ${String(input.kind)}`);
  const availableAt = canonicalInstant(input.availableAt, `DAG node ${id} availableAt`);
  const epistemic = input.epistemic === undefined ? 'unknown' : input.epistemic;
  if (typeof epistemic !== 'string' || !EPISTEMIC_STATES.includes(epistemic as DagNode['epistemic'])) throw new Error(`invalid DAG node epistemic state: ${String(epistemic)}`);
  return Object.freeze({ id, kind: input.kind as DagNode['kind'], availableAt, epistemic: epistemic as DagNode['epistemic'], supersedes: nodeIdList(input.supersedes, `DAG node ${id} supersedes`) });
}

function json(value: unknown, label: string): string {
  try { return canonicalJson(value); }
  catch (error) { throw new Error(`${label} is not serializable: ${error instanceof Error ? error.message : String(error)}`); }
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sameStoredPayload(row: StoredPayloadRow, encoded: string): boolean {
  return row.digest === digest(encoded) && row.json === encoded;
}

function sameNodeIdentity(a: DagNode, b: DagNode): boolean {
  return a.id === b.id
    && a.kind === b.kind
    && a.availableAt === b.availableAt
    && a.epistemic === b.epistemic
    && JSON.stringify(a.supersedes) === JSON.stringify(b.supersedes);
}

function sameWitnessReference(reference: DerivationWitness, registered: Witness): boolean {
  return reference.id === registered.id
    && reference.kind === registered.kind
    && canonicalJson(reference.evidenceIds ?? []) === canonicalJson(registered.evidenceIds)
    && (reference.detail ?? null) === registered.detail
    && canonicalJson(reference.from ?? null) === canonicalJson(registered.from ?? null)
    && canonicalJson(reference.to ?? null) === canonicalJson(registered.to ?? null);
}

function row<T>(value: unknown): T | null {
  return value === undefined ? null : value as T;
}

export class EpistemicLedger {
  private readonly db: DatabaseSync;

  public constructor(db: DatabaseSync) {
    this.db = db;
    initializeEpistemicSchema(this.db);
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve the original failure */ }
      throw error;
    }
  }

  private node(id: string): DagNode | null {
    const stored = row<StoredNodeRow>(this.db.prepare(
      'SELECT node_id, node_kind, available_at, epistemic, supersedes_json FROM epistemic_nodes WHERE node_id = ?',
    ).get(id));
    if (stored === null) return null;
    let supersedes: unknown;
    try { supersedes = JSON.parse(stored.supersedes_json); } catch { throw new Error(`stored node ${id} has invalid supersession metadata`); }
    if (!Array.isArray(supersedes) || !supersedes.every((item) => typeof item === 'string')) throw new Error(`stored node ${id} has invalid supersession metadata`);
    return Object.freeze({
      id: stored.node_id,
      kind: stored.node_kind as DagNode['kind'],
      availableAt: canonicalInstant(stored.available_at, `stored node ${id} availableAt`),
      epistemic: stored.epistemic as DagNode['epistemic'],
      supersedes: Object.freeze(supersedes),
    });
  }

  private nodePayload(id: string, table: 'epistemic_evidence' | 'epistemic_claims' | 'epistemic_assumptions' | 'epistemic_witnesses' | 'epistemic_derivations', key: string, label: string): StoredPayloadRow | null {
    const projection = table === 'epistemic_evidence'
      ? 'evidence_json AS json, evidence_digest AS digest'
      : table === 'epistemic_claims'
        ? 'claim_json AS json, claim_digest AS digest'
        : table === 'epistemic_assumptions'
          ? 'assumption_json AS json, assumption_digest AS digest'
          : table === 'epistemic_witnesses'
            ? 'witness_json AS json, witness_digest AS digest'
            : 'derivation_json AS json, derivation_digest AS digest';
    const stored = row<StoredPayloadRow>(this.db.prepare(`SELECT ${key} AS id, ${projection} FROM ${table} WHERE ${key} = ?`).get(id));
    if (stored === null) return null;
    if (typeof stored.json !== 'string' || typeof stored.digest !== 'string' || stored.digest !== digest(stored.json)) {
      throw new Error(`stored ${label} ${id} failed digest verification`);
    }
    return stored;
  }

  private insertNode(node: DagNodeInput): AppendResult {
    const current = this.node(node.id);
    const candidate = normalizeNodeForLedger(node);
    if (current !== null) {
      if (!sameNodeIdentity(current, candidate)) throw new Error(`different DAG node already exists for ${node.id}`);
      return 'duplicate';
    }
    this.db.prepare(
      'INSERT INTO epistemic_nodes (node_id, node_kind, available_at, epistemic, supersedes_json) VALUES (?, ?, ?, ?, ?)',
    ).run(candidate.id, candidate.kind, candidate.availableAt, candidate.epistemic, json(candidate.supersedes, 'DAG node supersedes'));
    return 'inserted';
  }

  appendNode(input: DagNodeInput): AppendResult {
    const id = nonEmpty(input.id, 'DAG node id');
    if (input.kind === 'evidence' || input.kind === 'claim' || input.kind === 'assumption') {
      throw new Error(`use appendEvidence, appendClaim, or appendAssumption for canonical ${input.kind} nodes`);
    }
    return this.transaction(() => {
      const current = this.graph();
      const normalized = normalizeNodeForLedger(input);
      const existing = current.nodes.find((node) => node.id === id);
      if (existing !== undefined) {
        if (!sameNodeIdentity(existing, normalized)) throw new Error(`different DAG node already exists for ${id}`);
        return 'duplicate';
      }
      createEpistemicDag([...current.nodes, normalized], current.edges);
      return this.insertNode(normalized);
    });
  }

  appendEvidence(value: Evidence): AppendResult {
    const item = evidence(value);
    const availableAt = item.observedAt ?? item.recordedAt ?? item.assertedAt;
    if (availableAt === null) throw new Error(`evidence ${item.id} has no acquisition timestamp`);
    const encoded = json(item, 'evidence');
    return this.transaction(() => {
      const current = this.graph();
      const normalized = normalizeNodeForLedger({
        id: item.id, kind: 'evidence', availableAt, supersedes: item.supersedes,
      });
      const existing = current.nodes.find((node) => node.id === item.id);
      let nodeResult: AppendResult;
      if (existing !== undefined) {
        if (!sameNodeIdentity(existing, normalized)) throw new Error(`different DAG node already exists for ${item.id}`);
        nodeResult = 'duplicate';
      } else {
        createEpistemicDag([...current.nodes, normalized], current.edges);
        nodeResult = this.insertNode(normalized);
      }
      const stored = this.nodePayload(item.id, 'epistemic_evidence', 'evidence_id', 'evidence');
      if (stored !== null) {
        if (!sameStoredPayload(stored, encoded)) throw new Error(`different evidence already exists for ${item.id}`);
        return 'duplicate';
      }
      this.db.prepare('INSERT INTO epistemic_evidence (evidence_id, evidence_json, evidence_digest) VALUES (?, ?, ?)').run(item.id, encoded, digest(encoded));
      return nodeResult === 'duplicate' ? 'inserted' : nodeResult;
    });
  }

  appendClaim(value: Claim): AppendResult {
    const item = claim(value);
    const encoded = json(item, 'claim');
    return this.transaction(() => {
      this.ensureKinds(item.evidenceIds, 'evidence');
      this.ensureKinds(item.assumptionIds, 'assumption');
      const current = this.graph();
      const normalized = normalizeNodeForLedger({
        id: item.id, kind: 'claim', availableAt: item.issuedAt, epistemic: item.epistemic, supersedes: item.supersedes,
      });
      const existing = current.nodes.find((node) => node.id === item.id);
      let nodeResult: AppendResult;
      if (existing !== undefined) {
        if (!sameNodeIdentity(existing, normalized)) throw new Error(`different DAG node already exists for ${item.id}`);
        nodeResult = 'duplicate';
      } else {
        createEpistemicDag([...current.nodes, normalized], current.edges);
        nodeResult = this.insertNode(normalized);
      }
      const stored = this.nodePayload(item.id, 'epistemic_claims', 'claim_id', 'claim');
      if (stored !== null) {
        if (!sameStoredPayload(stored, encoded)) throw new Error(`different claim already exists for ${item.id}`);
        return 'duplicate';
      }
      this.db.prepare('INSERT INTO epistemic_claims (claim_id, claim_json, claim_digest) VALUES (?, ?, ?)').run(item.id, encoded, digest(encoded));
      for (const evidenceId of item.evidenceIds) this.insertEdge({ from: evidenceId, to: item.id, relation: 'supports' });
      for (const assumptionId of item.assumptionIds) this.insertEdge({ from: assumptionId, to: item.id, relation: 'assumes' });
      return nodeResult === 'duplicate' ? 'inserted' : nodeResult;
    });
  }

  appendAssumption(value: Assumption): AppendResult {
    const item = assumption(value);
    const encoded = json(item, 'assumption');
    return this.transaction(() => {
      this.ensureKinds(item.evidenceIds, 'evidence');
      const current = this.graph();
      const normalized = normalizeNodeForLedger({
        id: item.id, kind: 'assumption', availableAt: item.issuedAt, epistemic: item.epistemic, supersedes: item.supersedes,
      });
      const existing = current.nodes.find((node) => node.id === item.id);
      let nodeResult: AppendResult;
      if (existing !== undefined) {
        if (!sameNodeIdentity(existing, normalized)) throw new Error(`different DAG node already exists for ${item.id}`);
        nodeResult = 'duplicate';
      } else {
        createEpistemicDag([...current.nodes, normalized], current.edges);
        nodeResult = this.insertNode(normalized);
      }
      const stored = this.nodePayload(item.id, 'epistemic_assumptions', 'assumption_id', 'assumption');
      if (stored !== null) {
        if (!sameStoredPayload(stored, encoded)) throw new Error(`different assumption already exists for ${item.id}`);
        return 'duplicate';
      }
      this.db.prepare('INSERT INTO epistemic_assumptions (assumption_id, assumption_json, assumption_digest) VALUES (?, ?, ?)').run(item.id, encoded, digest(encoded));
      for (const evidenceId of item.evidenceIds) this.insertEdge({ from: evidenceId, to: item.id, relation: 'supports' });
      return nodeResult === 'duplicate' ? 'inserted' : nodeResult;
    });
  }

  appendWitness(value: Witness): AppendResult {
    const item = witness(value);
    const encoded = json(item, 'witness');
    return this.transaction(() => {
      this.ensureKinds(item.evidenceIds, 'evidence');
      const current = this.graph();
      const normalized = normalizeNodeForLedger({
        id: item.id, kind: 'witness', availableAt: item.issuedAt, epistemic: item.epistemic,
      });
      const existing = current.nodes.find((node) => node.id === item.id);
      let nodeResult: AppendResult;
      if (existing !== undefined) {
        if (!sameNodeIdentity(existing, normalized)) throw new Error(`different DAG node already exists for ${item.id}`);
        if (existing.kind !== 'witness') throw new Error(`${item.id} is not a witness node`);
        nodeResult = 'duplicate';
      } else {
        createEpistemicDag([...current.nodes, normalized], current.edges);
        nodeResult = this.insertNode(normalized);
      }
      const stored = this.nodePayload(item.id, 'epistemic_witnesses', 'witness_id', 'witness');
      if (stored !== null) {
        if (!sameStoredPayload(stored, encoded)) throw new Error(`different witness already exists for ${item.id}`);
        return 'duplicate';
      }
      this.db.prepare('INSERT INTO epistemic_witnesses (witness_id, witness_json, witness_digest) VALUES (?, ?, ?)').run(item.id, encoded, digest(encoded));
      for (const evidenceId of item.evidenceIds) this.insertEdge({ from: evidenceId, to: item.id, relation: 'supports' });
      return nodeResult === 'duplicate' ? 'inserted' : nodeResult;
    });
  }

  appendDerivation(value: Derivation): AppendResult {
    const item = derivation(value);
    const encoded = json(item, 'derivation');
    return this.transaction(() => {
      this.ensureKinds(item.inputEvidenceIds, 'evidence');
      this.ensureKinds(item.inputClaimIds, 'claim');
      this.ensureKinds(item.witnesses.map((candidate) => candidate.id), 'witness');
      for (const reference of item.witnesses) {
        const registered = this.readWitness(reference.id);
        if (registered === null) throw new Error(`unknown witness: ${reference.id}`);
        if (!sameWitnessReference(reference, registered)) {
          throw new Error(`derivation witness ${reference.id} does not match the registered witness`);
        }
      }
      const output = this.readClaim(item.outputClaimId);
      if (output === null) throw new Error(`unknown output claim: ${item.outputClaimId}`);
      if (JSON.stringify(output.proposition) !== JSON.stringify(item.outputProposition)) throw new Error(`derivation output proposition does not match ${item.outputClaimId}`);

      const graph = this.graph();
      const extraEdges: DagEdgeInput[] = [
        ...item.inputEvidenceIds.map((from) => ({ from, to: item.outputClaimId, relation: 'depends_on' as const })),
        ...item.inputClaimIds.map((from) => ({ from, to: item.outputClaimId, relation: 'derives' as const })),
        ...item.witnesses.map((from) => ({ from: from.id, to: item.outputClaimId, relation: 'witnesses' as const })),
      ];
      const stored = this.nodePayload(item.id, 'epistemic_derivations', 'derivation_id', 'derivation');
      if (stored !== null) {
        if (!sameStoredPayload(stored, encoded)) throw new Error(`different derivation already exists for ${item.id}`);
        for (const edge of extraEdges) {
          if (!graph.edges.some((existing) => existing.from === edge.from && existing.to === edge.to && existing.relation === edge.relation)) {
            throw new Error(`stored derivation ${item.id} is missing dependency edge ${edge.from} -> ${edge.to}`);
          }
        }
        return 'duplicate';
      }
      createEpistemicDag(graph.nodes, [...graph.edges, ...extraEdges]);
      this.db.prepare('INSERT INTO epistemic_derivations (derivation_id, derivation_json, derivation_digest) VALUES (?, ?, ?)').run(item.id, encoded, digest(encoded));
      for (const edge of extraEdges) this.insertEdge(edge);
      return 'inserted';
    });
  }

  appendDependency(edge: DagEdgeInput): AppendResult {
    const from = nonEmpty(edge.from, 'dependency edge from');
    const to = nonEmpty(edge.to, 'dependency edge to');
    const candidate = { from, to, relation: edge.relation };
    return this.transaction(() => {
      const existing = row<StoredEdgeRow>(this.db.prepare('SELECT from_id, to_id, relation FROM epistemic_edges WHERE from_id = ? AND to_id = ? AND relation = ?').get(from, to, edge.relation));
      if (existing !== null) return 'duplicate';
      const graph = this.graph();
      createEpistemicDag(graph.nodes, [...graph.edges, candidate]);
      return this.insertEdge(candidate);
    });
  }

  appendRevocation(input: RevocationEventInput): AppendResult {
    const eventId = nonEmpty(input.eventId, 'revocation eventId');
    const targetId = nonEmpty(input.targetId, 'revocation targetId');
    const recordedAt = canonicalInstant(input.recordedAt, 'revocation recordedAt');
    const reason = nonEmpty(input.reason, 'revocation reason');
    return this.transaction(() => {
      if (this.node(targetId) === null) throw new Error(`unknown target for revocation: ${targetId}`);
      const existing = row<StoredEventRow>(this.db.prepare('SELECT event_id, target_id, recorded_at, reason FROM epistemic_revocations WHERE event_id = ?').get(eventId));
      if (existing !== null) {
        if (existing.target_id !== targetId || existing.recorded_at !== recordedAt || existing.reason !== reason) throw new Error(`different revocation already exists for ${eventId}`);
        return 'duplicate';
      }
      this.db.prepare('INSERT INTO epistemic_revocations (event_id, target_id, recorded_at, reason) VALUES (?, ?, ?, ?)').run(eventId, targetId, recordedAt, reason);
      return 'inserted';
    });
  }

  readEvidence(id: string): Evidence | null {
    const stored = this.nodePayload(id, 'epistemic_evidence', 'evidence_id', 'evidence');
    if (stored === null) return null;
    try {
      const item = evidence(JSON.parse(stored.json) as Evidence);
      if (item.id !== id) throw new Error('physical identity does not match the requested ID');
      return item;
    } catch (error) {
      throw new Error(`stored evidence ${id} failed canonical validation: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  readClaim(id: string): Claim | null {
    const stored = this.nodePayload(id, 'epistemic_claims', 'claim_id', 'claim');
    if (stored === null) return null;
    try {
      const item = claim(JSON.parse(stored.json) as Claim);
      if (item.id !== id) throw new Error('physical identity does not match the requested ID');
      return item;
    } catch (error) {
      throw new Error(`stored claim ${id} failed canonical validation: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  readAssumption(id: string): Assumption | null {
    const stored = this.nodePayload(id, 'epistemic_assumptions', 'assumption_id', 'assumption');
    if (stored === null) return null;
    try {
      const item = assumption(JSON.parse(stored.json) as Assumption);
      if (item.id !== id) throw new Error('physical identity does not match the requested ID');
      return item;
    } catch (error) {
      throw new Error(`stored assumption ${id} failed canonical validation: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  readWitness(id: string): Witness | null {
    const stored = this.nodePayload(id, 'epistemic_witnesses', 'witness_id', 'witness');
    if (stored === null) return null;
    try {
      const item = witness(JSON.parse(stored.json) as Witness);
      if (item.id !== id) throw new Error('physical identity does not match the requested ID');
      return item;
    } catch (error) {
      throw new Error(`stored witness ${id} failed canonical validation: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  readDerivation(id: string): Derivation | null {
    const stored = this.nodePayload(id, 'epistemic_derivations', 'derivation_id', 'derivation');
    if (stored === null) return null;
    try {
      const item = derivation(JSON.parse(stored.json) as Derivation);
      if (item.id !== id) throw new Error('physical identity does not match the requested ID');
      return item;
    } catch (error) {
      throw new Error(`stored derivation ${id} failed canonical validation: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  graph(): EpistemicDag {
    const nodes = (this.db.prepare('SELECT node_id, node_kind, available_at, epistemic, supersedes_json FROM epistemic_nodes ORDER BY node_id').all() as unknown as StoredNodeRow[]).map((stored) => {
      let supersedes: unknown;
      try { supersedes = JSON.parse(stored.supersedes_json); } catch { throw new Error(`stored node ${stored.node_id} has invalid supersession metadata`); }
      if (!Array.isArray(supersedes) || !supersedes.every((item) => typeof item === 'string')) throw new Error(`stored node ${stored.node_id} has invalid supersession metadata`);
      return { id: stored.node_id, kind: stored.node_kind as DagNode['kind'], availableAt: canonicalInstant(stored.available_at, `stored node ${stored.node_id} availableAt`), epistemic: stored.epistemic as DagNode['epistemic'], supersedes };
    });
    const edges = (this.db.prepare('SELECT from_id, to_id, relation FROM epistemic_edges ORDER BY from_id, to_id, relation').all() as unknown as StoredEdgeRow[]).map((edge) => ({ from: edge.from_id, to: edge.to_id, relation: edge.relation as DagEdge['relation'] }));
    // Re-parse every payload while constructing the graph so a tampered child
    // row cannot hide behind otherwise-valid node metadata.
    for (const node of nodes) {
      if (node.kind === 'evidence' && this.readEvidence(node.id) === null) throw new Error(`stored evidence node ${node.id} has no payload`);
      if (node.kind === 'claim') {
        const item = this.readClaim(node.id);
        if (item === null) throw new Error(`stored claim node ${node.id} has no payload`);
        this.ensureKinds(item.evidenceIds, 'evidence');
        this.ensureKinds(item.assumptionIds, 'assumption');
      }
      if (node.kind === 'assumption') {
        const item = this.readAssumption(node.id);
        if (item === null) throw new Error(`stored assumption node ${node.id} has no payload`);
        this.ensureKinds(item.evidenceIds, 'evidence');
      }
      if (node.kind === 'witness') {
        const item = this.readWitness(node.id);
        if (item === null) throw new Error(`stored witness node ${node.id} has no payload`);
        this.ensureKinds(item.evidenceIds, 'evidence');
      }
    }
    const derivationRows = this.db.prepare('SELECT derivation_id FROM epistemic_derivations ORDER BY derivation_id').all() as unknown as Array<{ derivation_id: string }>;
    for (const stored of derivationRows) {
      const item = this.readDerivation(stored.derivation_id);
      if (item === null) throw new Error(`stored derivation ${stored.derivation_id} has no payload`);
      if (this.node(item.outputClaimId)?.kind !== 'claim') throw new Error(`stored derivation ${stored.derivation_id} has an unknown output claim`);
      this.ensureKinds(item.inputEvidenceIds, 'evidence');
      this.ensureKinds(item.inputClaimIds, 'claim');
      this.ensureKinds(item.witnesses.map((candidate) => candidate.id), 'witness');
      for (const reference of item.witnesses) {
        const registered = this.readWitness(reference.id);
        if (registered === null || !sameWitnessReference(reference, registered)) {
          throw new Error(`stored derivation ${stored.derivation_id} has an unregistered or divergent witness ${reference.id}`);
        }
        const witnessEdge = this.db.prepare(
          'SELECT 1 AS present FROM epistemic_edges WHERE from_id = ? AND to_id = ? AND relation = ?',
        ).get(reference.id, item.outputClaimId, 'witnesses');
        if (witnessEdge === undefined) throw new Error(`stored derivation ${stored.derivation_id} is missing witness edge ${reference.id} -> ${item.outputClaimId}`);
      }
    }
    return createEpistemicDag(nodes, edges);
  }

  asOf(asOf: Instant): EpistemicDag {
    return this.replayAsOf(asOf).graph;
  }

  /**
   * Reconstruct every currently modeled kernel projection at one boundary.
   * Node availability and revocation event time are filtered independently;
   * later observations or corrections cannot leak into the historical view.
   */
  replayAsOf(asOf: Instant): EpistemicReplay {
    const boundary = canonicalInstant(asOf, 'epistemic replay asOf');
    const graph = asOfGraph(this.graph(), boundary);
    const visible = new Set(graph.nodes.map((node) => node.id));
    const events = this.revocationEvents().filter((event) =>
      Date.parse(event.recorded_at) <= Date.parse(boundary) && visible.has(event.target_id),
    );
    return Object.freeze({
      asOf: boundary,
      graph,
      revocation: projectRevocation(graph, events.map((event) => event.target_id)),
    });
  }

  revocationProjection(): RevocationProjection {
    const graph = this.graph();
    const events = this.revocationEvents();
    return projectRevocation(graph, events.map((event) => event.target_id));
  }

  /** Reconstruct revocation state using only events recorded by the boundary. */
  revocationProjectionAsOf(asOf: Instant): RevocationProjection {
    return this.replayAsOf(asOf).revocation;
  }

  private revocationEvents(): StoredEventRow[] {
    const rows = this.db.prepare('SELECT event_id, target_id, recorded_at, reason FROM epistemic_revocations ORDER BY event_id').all() as unknown as StoredEventRow[];
    return rows.map((event) => ({
      event_id: nonEmpty(event.event_id, 'stored revocation eventId'),
      target_id: nonEmpty(event.target_id, 'stored revocation targetId'),
      recorded_at: canonicalInstant(event.recorded_at, `stored revocation ${event.event_id} recordedAt`),
      reason: nonEmpty(event.reason, `stored revocation ${event.event_id} reason`),
    }));
  }

  private ensureKinds(ids: readonly string[], kind: DagNode['kind']): void {
    for (const id of ids) {
      const node = this.node(id);
      if (node === null) throw new Error(`unknown ${kind}: ${id}`);
      if (node.kind !== kind) throw new Error(`${id} is not a ${kind} node`);
    }
  }

  private insertEdge(edge: DagEdgeInput): AppendResult {
    const existing = row<StoredEdgeRow>(this.db.prepare('SELECT from_id, to_id, relation FROM epistemic_edges WHERE from_id = ? AND to_id = ? AND relation = ?').get(edge.from, edge.to, edge.relation));
    if (existing !== null) return 'duplicate';
    this.db.prepare('INSERT INTO epistemic_edges (from_id, to_id, relation) VALUES (?, ?, ?)').run(edge.from, edge.to, edge.relation);
    return 'inserted';
  }
}
