/**
 * Local, review-first causal-study operator surface.
 *
 * Registration and assignment require --apply because they append local
 * evidence records. They never change provider routing, budgets, prompts, or
 * external systems. Analysis without --apply is a deterministic preview.
 */

import { readFileSync } from 'node:fs';
import { dbPath } from '../config.ts';
import { createBlockedAssignmentPlan, verifyBlockedAssignmentPlan } from '../causal/assignment.ts';
import { estimateCausalStudy } from '../causal/estimate.ts';
import { commitCausalProtocol } from '../causal/protocol.ts';
import type { CausalStudyProtocolDraft } from '../causal/types.ts';
import { Store } from '../store/db.ts';
import type { Flags } from './flags.ts';

function requireStringFlag(flags: Flags, name: string): string {
  const value = flags[name];
  if (typeof value !== 'string' || value.trim() === '') throw new Error('causal ' + name + ' requires --' + name + ' <value>');
  return value;
}

function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error('cannot read causal JSON file ' + file + ': ' + (err instanceof Error ? err.message : String(err)));
  }
}

function readUnitHashes(file: string): string[] {
  try {
    const values = readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (values.length === 0) throw new Error('no unit hashes found');
    return values;
  } catch (err) {
    throw new Error('cannot read causal unit hashes from ' + file + ': ' + (err instanceof Error ? err.message : String(err)));
  }
}

function emit(payload: unknown, flags: Flags): void {
  if (flags.json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    return;
  }
  console.log(JSON.stringify(payload, null, 2));
}

function usage(): void {
  console.log('');
  console.log('  Fiscus causal — local randomized-study evidence, review-only');
  console.log('  Ordinary Lift, baselines, and value scenarios never become causal evidence here.');
  console.log('');
  console.log('  fiscus causal status [--json]');
  console.log('  fiscus causal inspect <study-id> [--json]');
  console.log('  fiscus causal verify <study-id> [--json]');
  console.log('  fiscus causal register --file <protocol.json> [--at <epoch-ms>] [--apply] [--json]');
  console.log('  fiscus causal assign --study <study-id> --block <block-id> --units-file <sha256-lines.txt> [--apply] [--json]');
  console.log('  fiscus causal analyze --study <study-id> [--id <analysis-id>] [--apply] [--json]');
  console.log('');
  console.log('  register and assign without --apply are validated previews. No action here routes');
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
  const store = new Store(dbPath());
  try {
    if (action === 'status') {
      const studies = store.causalStudySummaries();
      emit({
        studies,
        causalEvidence: studies.length === 0
          ? 'No registered causal study. Current Fiscus value output remains an observed/manual-equivalent scenario.'
          : 'Registered local studies are listed. Inspect or verify one before using any causal language.',
      }, flags);
      return;
    }

    if (action === 'register') {
      const file = requireStringFlag(flags, 'file');
      const source = readJsonFile(file) as CausalStudyProtocolDraft;
      const at = flags.at === undefined ? Date.now() : Number(flags.at);
      const protocol = commitCausalProtocol(source, at);
      if (!flags.apply) {
        emit({
          operation: 'register_preview',
          protocol,
          warning: 'Validated only. Re-run with --apply to append this immutable local protocol.',
        }, flags);
        return;
      }
      emit({
        operation: 'registered',
        result: store.registerCausalProtocol(protocol),
        protocolHash: protocol.protocolHash,
        studyId: protocol.studyId,
        boundary: 'Protocol registration does not collect traffic or alter routing.',
      }, flags);
      return;
    }

    if (action === 'assign') {
      const studyId = requireStringFlag(flags, 'study');
      const blockId = requireStringFlag(flags, 'block');
      const unitsFile = requireStringFlag(flags, 'units-file');
      const data = store.causalStudyData(studyId);
      if (!data) throw new Error('causal study not found: ' + studyId);
      const plan = createBlockedAssignmentPlan(data.protocol, {
        blockId,
        unitIdHashes: readUnitHashes(unitsFile),
      });
      if (!flags.apply) {
        emit({
          operation: 'assign_preview',
          studyId,
          blockId,
          allocationHash: plan.allocationHash,
          decisions: plan.decisions.map((decision) => ({
            decisionId: decision.decisionId,
            unitIdHash: decision.unitIdHash,
            assignedArmId: decision.assignedArmId,
            propensity: decision.propensity,
          })),
          warning: 'Validated only. Re-run with --apply to append this immutable local assignment block.',
        }, flags);
        return;
      }
      emit({
        operation: 'assigned',
        result: store.saveCausalAssignmentPlan(plan),
        studyId,
        blockId,
        allocationHash: plan.allocationHash,
        decisions: plan.decisions.length,
        boundary: 'Assignment is evidence collection only. It does not switch a provider route.',
      }, flags);
      return;
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
      const analysisId = flags.id === undefined
        ? 'analysis:' + studyId + ':' + String(Date.now())
        : requireStringFlag(flags, 'id');
      emit({
        operation: 'analysis_saved',
        snapshot: store.saveCausalAnalysis(studyId, analysisId),
      }, flags);
      return;
    }

    usage();
    process.exitCode = 1;
  } finally {
    store.close();
  }
}
