/**
 * WP-J02 product route: one bounded autonomous control step for the live daily
 * budget cap. The operator delegates the envelope with --policy and opts into
 * mutation with --apply; inside that envelope Fiscus chooses/rolls back without
 * a second prompt. Re-run from a scheduler for continuous control.
 */

import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../store/db.ts';
import { BudgetGuard } from '../budget/guard.ts';
import { issueBudgetCapDecision, previewBudgetCapIssuance } from '../budget/capDecision.ts';
import {
  appendBudgetControlAuditEvent,
  budgetControlPendingMutation,
  resolveBudgetControlPending,
  budgetControlPolicy,
  initialBudgetControlState,
  reconcileBudgetControlState,
  planBudgetControl,
  verifyBudgetControlAudit,
  type BudgetControlAuditEvent,
  type BudgetControlPendingMutation,
  type BudgetControlPolicy,
  type BudgetControlState,
} from '../budget/onlineControl.ts';
import { dbPath, fiscusHome, loadConfig, saveConfig } from '../config.ts';
import { computeFrontier } from '../value/frontier.ts';
import { loadRealization } from '../value/realization.ts';
import { budgetAdvice } from '../value/report.ts';
import type { Flags } from './flags.ts';
import { printJson } from './ui.ts';

function policyFromFile(path: string): BudgetControlPolicy {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`cannot read budget control policy ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('budget control policy must be a JSON object');
  return budgetControlPolicy(raw as Parameters<typeof budgetControlPolicy>[0]);
}

function stateFile(): string { return join(fiscusHome(), 'budget-control-state.json'); }
function auditFile(): string { return join(fiscusHome(), 'budget-control-audit.jsonl'); }
function pendingFile(): string { return join(fiscusHome(), 'budget-control-pending.json'); }

function durableWrite(path: string, text: string): void {
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let fd: number | null = null;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeSync(fd, text, undefined, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temp, path);
  } catch (error) {
    if (fd !== null) closeSync(fd);
    try { if (existsSync(temp)) unlinkSync(temp); } catch { /* preserve original error */ }
    throw error;
  }
}

function durableAppend(path: string, text: string): void {
  const fd = openSync(path, 'a', 0o600);
  try {
    writeSync(fd, text, undefined, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function loadAudit(): readonly BudgetControlAuditEvent[] {
  const path = auditFile();
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8').trim();
  if (text.length === 0) return [];
  const rows = text.split(/\r?\n/).map((line, index) => {
    try { return JSON.parse(line) as BudgetControlAuditEvent; } catch { throw new Error(`invalid budget control audit JSON at line ${index + 1}`); }
  });
  const verified = verifyBudgetControlAudit(rows);
  if (!verified.valid) throw new Error(`budget control audit chain is invalid at sequence ${verified.firstInvalidSequence}`);
  return rows;
}

function loadState(policy: BudgetControlPolicy, currentDailyUsd: number | null, now: string): BudgetControlState {
  const path = stateFile();
  if (!existsSync(path)) return initialBudgetControlState(policy, currentDailyUsd, now);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf8')) as unknown; } catch {
    throw new Error('budget control state is unreadable; refusing autonomous action');
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('budget control state is invalid');
  return reconcileBudgetControlState(policy, raw as BudgetControlState, currentDailyUsd, now);
}

function writeState(state: BudgetControlState): void {
  durableWrite(stateFile(), JSON.stringify(state, null, 2) + '\n');
}

function appendAudit(event: BudgetControlAuditEvent): void {
  durableAppend(auditFile(), JSON.stringify(event) + '\n');
}

function writePending(pending: BudgetControlPendingMutation): void {
  durableWrite(pendingFile(), JSON.stringify(pending, null, 2) + '\n');
}

function loadPending(): BudgetControlPendingMutation | null {
  const path = pendingFile();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as BudgetControlPendingMutation;
  } catch {
    throw new Error('budget control pending mutation is unreadable; refusing autonomous action');
  }
}

function clearPending(): void {
  const path = pendingFile();
  if (existsSync(path)) unlinkSync(path);
}

function recoverPending(policy: BudgetControlPolicy, currentDailyUsd: number | null): void {
  const pending = loadPending();
  if (pending === null) return;
  const audit = loadAudit();
  const resolution = resolveBudgetControlPending(pending, policy, currentDailyUsd, audit);
  if (resolution.status === 'conflict') {
    throw new Error(`budget control recovery conflict: ${resolution.reason}`);
  }
  if (resolution.status === 'already_recorded') {
    clearPending();
    return;
  }
  if (resolution.status === 'complete') {
    writeState(pending.nextState);
    const next = appendBudgetControlAuditEvent(audit, {
      transactionId: pending.transactionId,
      policy,
      state: pending.nextState,
      action: pending.action,
      fromDailyUsd: pending.fromDailyUsd,
      toDailyUsd: pending.toDailyUsd,
      at: pending.at,
      reason: `${pending.reason}; recovered after interrupted durable commit`,
      decisionId: pending.decisionId,
    });
    appendAudit(next[next.length - 1]!);
    clearPending();
    return;
  }

  writeState(pending.previousState);
  const next = appendBudgetControlAuditEvent(audit, {
    transactionId: pending.transactionId,
    policy,
    state: pending.previousState,
    action: 'no_action',
    fromDailyUsd: pending.fromDailyUsd,
    toDailyUsd: pending.fromDailyUsd,
    at: pending.at,
    reason: 'recovered pending control mutation before the config change committed',
    decisionId: pending.decisionId,
  });
  appendAudit(next[next.length - 1]!);
  clearPending();
}

export async function cmdBudgetControl(flags: Flags): Promise<void> {
  const policyPath = typeof flags.policy === 'string' ? flags.policy : null;
  if (policyPath === null) {
    console.error('  Usage: fiscus budget --control --policy <file.json> [--repo <path>] [--apply] [--json]');
    process.exitCode = 1;
    return;
  }

  const policy = policyFromFile(policyPath);
  const cfg = loadConfig();
  recoverPending(policy, cfg.budget.dailyUsd);
  const store = new Store(dbPath());
  try {
    const now = new Date().toISOString();
    const days = flags.days ? Number(flags.days) : 30;
    if (!Number.isFinite(days) || days <= 0 || !Number.isInteger(days)) throw new Error('--days must be a positive integer');

    let realizedSpendShare: number | null = null;
    let frontierCells: ReturnType<typeof computeFrontier>['byModelAndTask'] = [];
    const repo = (flags.repo as string | undefined) ?? process.cwd();
    const loaded = await loadRealization(store, repo, { persist: false });
    if (loaded) {
      realizedSpendShare = loaded.report.matured.realizedSpendShare;
      frontierCells = computeFrontier(loaded.report.units).byModelAndTask;
    }

    const advice = budgetAdvice(store, cfg, { windowDays: days, realizedSpendShare, frontier: frontierCells });
    const guard = new BudgetGuard(store, cfg.budget).evaluate();
    const state = loadState(policy, cfg.budget.dailyUsd, now);
    const coverage = advice.economic?.coverage === 'exact'
      ? 'complete'
      : advice.economic?.coverage === 'partial'
        ? 'partial'
        : 'unknown';
    const canonicalDecision = advice.decision === null ? null : previewBudgetCapIssuance(advice.decision, {
      issuedAt: now,
      windowDays: days,
      spendBasis: advice.spendBasis,
      monetaryBasis: 'list',
      seriesCoverage: coverage,
    });
    // A bare engine certificate never reaches the autonomous planner. The
    // canonical adapter must first be able to construct a legal decision-fitness
    // Claim; the separate changes-spend assurance remains enforced in the plan.
    const plan = planBudgetControl({
      policy,
      state,
      decision: canonicalDecision?.decision === null ? null : advice.decision,
      currentDailyUsd: cfg.budget.dailyUsd,
      runawayMaxUsd: cfg.budget.runawayMaxUsd,
      runawayTripped: guard.runaway.tripped,
      now,
    });

    let applied = false;
    let certificateBundleId: string | null = null;
    let auditHead: string | null = null;
    if (flags.apply) {
      const before = cfg.budget.dailyUsd;
      const transactionId = randomUUID();
      const history = loadAudit();
      const reason = plan.reasons.length > 0
        ? plan.reasons.join('; ')
        : plan.action === 'apply_recommended'
          ? 'certified decision satisfied the delegated control envelope'
          : plan.action === 'rollback_to_baseline'
            ? 'circuit breaker restored the safe baseline'
            : 'controller evaluated the policy and made no mutation';

      // Persist the certificate before changing the live cap. A failure here is
      // therefore a refusal, never an unaudited spend mutation.
      if (plan.action === 'apply_recommended' && advice.decision !== null) {
        const issued = issueBudgetCapDecision(store.epistemic(), advice.decision, {
          issuedAt: now,
          windowDays: days,
          spendBasis: advice.spendBasis,
          monetaryBasis: 'list',
          seriesCoverage: coverage,
        });
        certificateBundleId = issued.certificateBundle.id;
      }

      if (plan.action !== 'no_action') {
        const pending = budgetControlPendingMutation({
          transactionId,
          policy,
          previousState: state,
          plan,
          fromDailyUsd: before,
          at: now,
        });
        // Write-ahead intent first. If the process dies after saveConfig but
        // before state/audit, the next invocation can prove whether the config
        // reached the from-side or to-side and finish/abort idempotently.
        writePending(pending);
        cfg.budget.dailyUsd = plan.nextDailyUsd;
        saveConfig(cfg);
        applied = true;
      }

      writeState(plan.nextState);
      const next = appendBudgetControlAuditEvent(history, {
        transactionId,
        policy,
        state: plan.nextState,
        action: plan.action,
        fromDailyUsd: before,
        toDailyUsd: plan.nextDailyUsd,
        at: now,
        reason,
        decisionId: plan.decisionId,
      });
      const event = next[next.length - 1]!;
      appendAudit(event);
      auditHead = event.hash;
      if (plan.action !== 'no_action') clearPending();
    }

    const payload = {
      applied,
      target: 'budget.dailyUsd',
      policy,
      state: plan.nextState,
      plan,
      runtime: {
        liveDailyUsd: cfg.budget.dailyUsd,
        runawayMaxUsd: cfg.budget.runawayMaxUsd,
        runawayTripped: guard.runaway.tripped,
        explorationRate: 0,
      },
      certificateBundleId,
      auditHead,
      boundary: flags.apply
        ? 'Mutation was permitted only inside the explicit policy envelope; a DecisionCertificate alone never authorizes action.'
        : 'Preview only. Pass --apply to delegate this bounded control step.',
    };

    if (flags.json) {
      printJson(payload);
      return;
    }
    console.log('');
    console.log('  Constrained budget control');
    console.log(`  Policy:  ${policy.id} v${policy.version} (${policy.digest.slice(0, 12)})`);
    console.log(`  Action:  ${plan.action}${applied ? ' (applied)' : ' (not applied)'}`);
    console.log(`  Cap:     ${cfg.budget.dailyUsd === null ? 'off' : '$' + cfg.budget.dailyUsd.toFixed(2)} -> ${plan.nextDailyUsd === null ? 'off' : '$' + plan.nextDailyUsd.toFixed(2)}`);
    if (plan.reasons.length > 0) for (const reason of plan.reasons) console.log(`  · ${reason}`);
    if (!flags.apply) console.log('  Preview only; re-run with --apply to delegate this step.');
    console.log('');
  } finally {
    store.close();
  }
}
