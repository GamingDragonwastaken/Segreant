/**
 * The first-party consumer of the plugin host (D-234): plugin evidence
 * becomes kernel Evidence, and nothing more.
 *
 * `runPluginProcess` mediates one bounded exchange and returns a validated
 * `PluginEvidenceOutput`. This module turns each record of that output into
 * an `Evidence` envelope the epistemic ledger accepts, and it is deliberately
 * the only bridge: a plugin response cannot carry a Claim, a decision or an
 * action, and this intake issues none. What a plugin says is what a plugin
 * said — recorded under its own identity, with the axes a host can honestly
 * write and no others.
 *
 * The axes. `integrity` is `verified` only when the record carried a
 * `payloadHash` that matches the payload it carried, and `unknown` otherwise
 * — the host saw bytes, not a chain of custody. `authenticity` is
 * `self_asserted`: the plugin process is not a pinned key and not a provider.
 * `completeness` is `unknown`: a bounded exchange says nothing about what the
 * plugin did not send. `sensitivity` is `internal` unless the caller says
 * otherwise. Nothing here is raised by category, manifest or reputation.
 *
 * Preview-then-commit is preserved: `planPluginIntake` builds the envelopes
 * and reports what would be appended; `applyPluginIntake` appends them and
 * reports inserted versus duplicate, and a record that cannot become valid
 * Evidence refuses the whole batch before anything is written.
 *
 * The envelope is a pure function of the plugin's output and the caller's
 * declarations — no wall-clock stamp — so re-running the same exchange is a
 * `duplicate` rather than a "different evidence" refusal, and a record that
 * changed under the same id is a CONFLICT the plan names before the ledger is
 * asked to write anything (found the first time the CLI was run twice).
 */

import { createHash } from 'node:crypto';
import { evidence, type Evidence } from '../epistemic/evidence.ts';
import type { EpistemicLedger } from '../epistemic/ledger.ts';
import { grain } from '../epistemic/grain.ts';
import { scope } from '../epistemic/scope.ts';
import { canonicalJson } from '../epistemic/serialization.ts';
import type { PluginEvidenceOutput, PluginEvidenceRecord, PluginManifest } from './contract.ts';

export interface PluginIntakeInput {
  readonly manifest: PluginManifest;
  readonly output: PluginEvidenceOutput;
  /** The scope the caller declares the plugin observed; the host cannot infer it. */
  readonly scope: Readonly<Record<string, string>>;
  readonly grain: readonly string[];
  readonly sensitivity?: Evidence['sensitivity'];
}

export interface PluginIntakePlan {
  readonly evidence: readonly Evidence[];
  /** Per record: how the integrity axis was decided. */
  readonly integrity: ReadonlyArray<{ readonly evidenceId: string; readonly integrity: Evidence['integrity']; readonly because: string }>;
  readonly refusals: readonly string[];
}

export interface PluginIntakeResult extends PluginIntakePlan {
  readonly inserted: readonly string[];
  readonly duplicate: readonly string[];
}

/**
 * Injective over the three parts (D-241). `safeIdentifier` admits ':' in
 * requestId and evidenceId, so a delimiter join let `r:1`+`e` and `r`+`1:e`
 * share one id — two distinct records from an untrusted plugin reading as one.
 * The JSON tuple is the same idiom D-217 chose for provider/model identity.
 */
export function pluginEvidenceId(pluginId: string, requestId: string, evidenceId: string): string {
  return `evidence:plugin:${JSON.stringify([pluginId, requestId, evidenceId])}`;
}

function payloadDigest(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}

function integrityFor(record: PluginEvidenceRecord): { integrity: Evidence['integrity']; because: string } {
  if (record.payload === undefined) {
    return { integrity: 'unknown', because: 'the record carries no payload to check a digest against' };
  }
  if (record.payloadHash === undefined) {
    return { integrity: 'unknown', because: 'the record carries no payloadHash; the host saw bytes, not a chain of custody' };
  }
  const expected = record.payloadHash.replace(/^sha256:/, '').toLowerCase();
  const actual = payloadDigest(record.payload);
  if (expected === actual) return { integrity: 'verified', because: 'payloadHash matches the sha256 of the canonical payload' };
  return { integrity: 'unknown', because: `payloadHash ${record.payloadHash} does not match the payload the record carried (${actual}); the record is kept, the axis is not raised` };
}

export function planPluginIntake(input: PluginIntakeInput): PluginIntakePlan {
  const refusals: string[] = [];
  if (input.output.pluginId !== input.manifest.pluginId) {
    refusals.push(`output pluginId ${input.output.pluginId} is not the manifest's ${input.manifest.pluginId}`);
  }
  if (input.output.category !== input.manifest.category) {
    refusals.push(`output category ${input.output.category} is not the manifest's ${input.manifest.category}`);
  }
  const built: Evidence[] = [];
  const integrity: Array<{ evidenceId: string; integrity: Evidence['integrity']; because: string }> = [];
  const seen = new Set<string>();
  for (const record of input.output.evidence) {
    const id = pluginEvidenceId(input.output.pluginId, input.output.requestId, record.evidenceId);
    if (seen.has(id)) { refusals.push(`record ${record.evidenceId} appears twice in one output`); continue; }
    seen.add(id);
    const decided = integrityFor(record);
    integrity.push({ evidenceId: id, ...decided });
    try {
      built.push(evidence({
        id,
        evidenceType: `plugin.${input.output.category}.${record.evidenceType}`,
        sourceIdentity: `plugin:${input.manifest.pluginId}@${input.manifest.pluginVersion}`,
        sourceClass: 'plugin_process_submission',
        ...(record.payload === undefined ? {} : { payload: record.payload }),
        ...(record.payloadHash === undefined ? {} : { payloadHash: record.payloadHash }),
        ...(record.reference === undefined ? {} : { reference: record.reference }),
        scope: scope(input.scope),
        grain: grain(input.grain),
        observedAt: new Date(record.observedAtMs).toISOString(),
        finalizedAt: null,
        integrity: decided.integrity,
        authenticity: 'self_asserted',
        completeness: { status: 'unknown', method: 'plugin_bounded_exchange' },
        measurementModelRef: null,
        monetaryBasis: null,
        schemaVersion: 1,
        sensitivity: input.sensitivity ?? 'internal',
        redaction: 'none',
      }));
    } catch (error) {
      refusals.push(`record ${record.evidenceId} cannot become Evidence: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return Object.freeze({ evidence: Object.freeze(built), integrity: Object.freeze(integrity), refusals: Object.freeze(refusals) });
}

/**
 * Append the planned envelopes; refuses the whole batch when the plan has any
 * refusal, or when a stored record under one of its ids differs from what
 * the plan would write — a re-run that changed its story is not a duplicate
 * and must not half-land.
 */
export function applyPluginIntake(ledger: EpistemicLedger, plan: PluginIntakePlan): PluginIntakeResult {
  const conflicts: string[] = [];
  for (const item of plan.evidence) {
    const stored = ledger.readEvidence(item.id);
    if (stored !== null && canonicalJson(stored) !== canonicalJson(item)) {
      conflicts.push(`${item.id} is already recorded with different content; a changed record under the same id is a conflict, not an update`);
    }
  }
  if (plan.refusals.length > 0 || conflicts.length > 0) {
    return Object.freeze({ ...plan, refusals: Object.freeze([...plan.refusals, ...conflicts]), inserted: Object.freeze([]), duplicate: Object.freeze([]) });
  }
  const inserted: string[] = [];
  const duplicate: string[] = [];
  for (const item of plan.evidence) {
    if (ledger.appendEvidence(item) === 'inserted') inserted.push(item.id);
    else duplicate.push(item.id);
  }
  return Object.freeze({ ...plan, inserted: Object.freeze(inserted), duplicate: Object.freeze(duplicate) });
}
