/**
 * Local, review-first causal-study operator surface.
 *
 * The current public surface reads retained version-1 evidence only. Version-2
 * registration, assignment, and projection remain deferred to their owning
 * public-operation slices; Slice 3's version-2 substrate is Store-only.
 */

import { dbPath } from '../config.ts';
import { verifyBlockedAssignmentPlan } from '../causal/assignment.ts';
import { estimateCausalStudy } from '../causal/estimate.ts';
import { commitCausalProtocol } from '../causal/protocol.ts';
import { Store } from '../store/db.ts';
import type { Flags } from './flags.ts';
import { printJson } from './ui.ts';
import { readBoundedUtf8File, RESOURCE_LIMITS } from '../util/resource-limits.ts';

function requireStringFlag(flags: Flags, name: string): string {
  const value = flags[name];
  if (typeof value !== 'string' || value.trim() === '') throw new Error('causal ' + name + ' requires --' + name + ' <value>');
  return value;
}

function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(readBoundedUtf8File(file, RESOURCE_LIMITS.jsonDocumentBytes, 'json_document_bytes'));
  } catch (err) {
    throw new Error('cannot read causal JSON file ' + file + ': ' + (err instanceof Error ? err.message : String(err)));
  }
}

class CausalCliLegacyInspectOnlyError extends Error {
  readonly code = 'CAUSAL_LEGACY_INSPECT_ONLY';

  constructor(operation: string) {
    super('CAUSAL_LEGACY_INSPECT_ONLY: retained version-1 causal evidence is inspect-only; cannot ' + operation);
    this.name = 'CausalCliLegacyInspectOnlyError';
  }
}

class CausalCliV2DeferredError extends Error {
  readonly code = 'CAUSAL_V2_CLI_DEFERRED';

  constructor(operation: string) {
    super('CAUSAL_V2_CLI_DEFERRED: version-2 causal ' + operation + ' is Store-only in this slice; the reviewed public CLI projection is deferred');
    this.name = 'CausalCliV2DeferredError';
  }
}

function emit(payload: unknown, flags: Flags): void {
  if (flags.json) {
    printJson(payload);
    return;
  }
  printJson(payload);
}

function usage(): void {
  console.log('');
  console.log('  Fiscus causal — local randomized-study evidence, review-only');
  console.log('  Ordinary Lift, baselines, and value scenarios never become causal evidence here.');
  console.log('');
  console.log('  fiscus causal status [--json]');
  console.log('  fiscus causal inspect <study-id> [--json]');
  console.log('  fiscus causal verify <study-id> [--json]');
  console.log('');
  console.log('  Public causal mutations and version-2 projection are deferred. This CLI');
  console.log('  exposes retained version-1 status, inspection, and replay verification only.');
  console.log('  No action here routes');
  console.log('  providers, alters budgets, or sends a request outside this machine.');
  console.log('');
}

function studyIdFrom(flags: Flags): string {
  const positional = flags._[1];
  return typeof positional === 'string' ? positional : requireStringFlag(flags, 'study');
}

function summaryFor(store: Store, studyId: string): Record<string, unknown> {
  const data = store.causalStudyData(studyId);
  if (!data) throw new Error('causal study not found: ' + studyId);
  const estimate = estimateCausalStudy(data);
  return {
    studyId,
    protocolHash: data.protocol.protocolHash,
    committedAtMs: data.protocol.committedAtMs,
    question: data.protocol.question,
    counts: {
      decisions: data.decisions.length,
      executions: data.executions.length,
      outcomes: data.outcomes.length,
    },
    qualification: estimate.qualification,
    allowedClaim: estimate.allowedClaim,
    jointInference: estimate.jointInference,
    latestSnapshots: store.causalAnalysisSnapshots(studyId).slice(0, 5),
    boundary: 'Local randomized-study evidence only; no automatic provider routing or budget change.',
  };
}

export function cmdCausal(flags: Flags): void {
  const action = flags._[0] ?? 'status';
  if (action === 'help' || action === '--help' || action === '-h') {
    usage();
    return;
  }
  if (action === 'register') {
    const file = requireStringFlag(flags, 'file');
    const source = readJsonFile(file);
    const at = flags.at === undefined ? Date.now() : Number(flags.at);
    const protocol = commitCausalProtocol(source, at);
    if (protocol.version === 1) {
      throw new CausalCliLegacyInspectOnlyError('register a version-1 protocol');
    }
    throw new CausalCliV2DeferredError('protocol registration');
  }
  const store = new Store(dbPath());
  try {
    if (action === 'status') {
      const studies = store.causalStudySummaries();
      emit({
        studies,
        causalEvidence: studies.length === 0
          ? 'No publicly inspectable retained version-1 causal study. Version-2 public projection is deferred; current Fiscus value output remains an observed/manual-equivalent scenario.'
          : 'Retained version-1 local studies are listed for inspection or replay verification; no public causal mutation is available.',
      }, flags);
      return;
    }

    if (action === 'assign') {
      const studyId = requireStringFlag(flags, 'study');
      requireStringFlag(flags, 'block');
      const data = store.causalStudyData(studyId);
      if (!data) throw new Error('causal study not found: ' + studyId);
      throw new CausalCliLegacyInspectOnlyError('preview or apply a new assignment');
    }

    if (action === 'inspect') {
      emit(summaryFor(store, studyIdFrom(flags)), flags);
      return;
    }

    if (action === 'verify') {
      const studyId = studyIdFrom(flags);
      const data = store.causalStudyData(studyId);
      if (!data) throw new Error('causal study not found: ' + studyId);
      const assignmentPlans = store.causalAssignmentPlans(studyId);
      emit({
        ...summaryFor(store, studyId),
        assignmentReplay: assignmentPlans.map((plan) => ({
          blockId: plan.blockId,
          allocationHash: plan.allocationHash,
          errors: verifyBlockedAssignmentPlan(data.protocol, plan),
        })),
      }, flags);
      return;
    }

    if (action === 'analyze') {
      const studyId = requireStringFlag(flags, 'study');
      const data = store.causalStudyData(studyId);
      if (!data) throw new Error('causal study not found: ' + studyId);
      const preview = estimateCausalStudy(data);
      if (!flags.apply) {
        emit({
          operation: 'analysis_preview',
          studyId,
          estimate: preview,
          warning: 'No analysis snapshot was written. Re-run with --apply to append one immutable snapshot.',
        }, flags);
        return;
      }
      // `--apply` ISSUES INTO THE KERNEL. It used to call
      // `saveCausalAnalysis`, which cannot succeed for any input: it refuses a
      // version-1 protocol as inspect-only and then asks `causalStudyData` for a
      // version-2 study, which that function returns null for by design — so the
      // operator got `causal study was not found` about a study they had just
      // inspected. Writing a snapshot row was never the point anyway. The point
      // is that the conclusion becomes revocable: the records below bind the
      // causal claim to the randomization that identifies it, so revoking the
      // assignment evidence carries the claim with it (AII-036, D-081).
      const issuance = store.issueCausalStudyToKernel(studyId);
      if (issuance === null) {
        throw new Error(
          'causal study ' + studyId + ' has no version-1 analysis path; version-2 projection is deferred',
        );
      }
      emit({
        operation: 'causal_claim_issued',
        studyId,
        issued: {
          assignmentEvidenceId: issuance.assignmentEvidence.id,
          outcomeEvidenceId: issuance.outcomeEvidence.id,
          armDifferenceClaimId: issuance.armDifference.id,
          identificationWitnessId: issuance.identification?.id ?? null,
          causalClaimId: issuance.effect?.id ?? null,
          derivationId: issuance.derivation?.id ?? null,
        },
        // Stated at the result, not in a footnote: an absent causal claim is the
        // ordinary outcome for a study that has not earned claim language, and a
        // caller who sees only the ids has no way to tell that from an error.
        causalClaim: issuance.effect === null
          ? 'No causal claim was issued. The observed arm difference is recorded as OBSERVATIONAL evidence; the pre-registered decision rule did not authorise causal language for this study.'
          : 'A causal claim was issued, bound by derivation to the randomization evidence. Revoking that evidence revokes this claim.',
      }, flags);
      return;
    }

    usage();
    process.exitCode = 1;
  } finally {
    store.close();
  }
}
