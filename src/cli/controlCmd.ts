/**
 * WP-J02 product route: one bounded autonomous control step for the live daily
 * budget cap. The operator delegates the envelope with --policy and opts into
 * mutation with --apply; inside that envelope Fiscus chooses/rolls back without
 * a second prompt. Re-run from a scheduler for continuous control.
 */

import { existsSync, readFileSync, renameSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../store/db.ts';
import { BudgetGuard } from '../budget/guard.ts';
import { issueBudgetCapDecision } from '../budget/capDecision.ts';
import {
  appendBudgetControlAuditEvent,
  budgetControlPolicy,
  initialBudgetControlState,
  planBudgetControl,
  verifyBudgetControlAudit,
  type BudgetControlAuditEvent,
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
  return raw as BudgetControlState;
}

function writeState(state: BudgetControlState): void {
  const path = stateFile();
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, path);
}

function appendAudit(event: BudgetControlAuditEvent): void {
  appendFileSync(auditFile(), JSON.stringify(event) + '\n', { encoding: 'utf8', mode: 0o600 });
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
    const plan = planBudgetControl({
      policy,
      state,
      decision: advice.decision,
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
      if (plan.action !== 'no_action') {
        cfg.budget.dailyUsd = plan.nextDailyUsd;
        saveConfig(cfg);
        applied = true;
      }
      writeState(plan.nextState);

      if (plan.action === 'apply_recommended' && advice.decision !== null) {
        const coverage = advice.economic?.coverage === 'exact'
          ? 'complete'
          : advice.economic?.coverage === 'partial'
            ? 'partial'
            : 'unknown';
        const issued = issueBudgetCapDecision(store.epistemic(), advice.decision, {
          issuedAt: now,
          windowDays: days,
          spendBasis: advice.spendBasis,
          monetaryBasis: 'list',
          seriesCoverage: coverage,
        });
        certificateBundleId = issued.certificateBundle.id;
      }

      const history = loadAudit();
      const reason = plan.reasons.length > 0
        ? plan.reasons.join('; ')
        : plan.action === 'apply_recommended'
          ? 'certified decision satisfied the delegated control envelope'
          : plan.action === 'rollback_to_baseline'
            ? 'circuit breaker restored the safe baseline'
            : 'controller evaluated the policy and made no mutation';
      const next = appendBudgetControlAuditEvent(history, {
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
