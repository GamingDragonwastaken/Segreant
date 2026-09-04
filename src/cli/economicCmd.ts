/** Exact economic-ledger inspection — no BigInt or legacy-number leakage. */

import { Store, type EffectiveRequestRow, type ExactSpendProjection } from '../store/db.ts';
import { dbPath, isDemo } from '../config.ts';
import { addMoney, formatMoneyAmount, money, moneyToJson, type EconomicBasis } from '../economics/money.ts';
import { canonicalPeriod } from '../economics/close.ts';
import { instant, type Instant } from '../epistemic/time.ts';
import type { EconomicPeriodCloseStatus, PeriodFinalizationResult, PeriodReopenResult } from '../economics/ledger.ts';
import { printJson, C, color, num } from './ui.ts';
import type { Flags } from './flags.ts';

export interface EconomicReportOptions {
  readonly startMs: number;
  readonly endMs: number;
  readonly demo: boolean;
  /** Optional target currency for a historical, read-only translation. */
  readonly targetUnit?: string;
  /** Recorded-time knowledge boundary for all exact report sections. */
  readonly asOf?: Instant;
  /** Optional modeled instant for the translated request coverage. */
  readonly effectiveAt?: Instant;
}

interface EconomicMoneyView {
  readonly amount: string;
  readonly coefficient: string;
  readonly scale: number;
  readonly currency: string;
  readonly basis: string;
}

export interface EconomicTranslationCoverage extends EconomicMoneyView {
  readonly targetUnit: string;
  readonly asOf: Instant | null;
  readonly effectiveAt: Instant | null;
  readonly eventIds: readonly string[];
  readonly sourceBases: readonly string[];
  readonly requestCount: number;
  readonly unresolvedRequests: number;
  readonly complete: boolean;
  readonly rateSources: readonly string[];
}

function moneyView(value: Parameters<typeof moneyToJson>[0]): EconomicMoneyView {
  const json = moneyToJson(value);
  return Object.freeze({ amount: formatMoneyAmount(value), ...json });
}

function coverageView(value: ExactSpendProjection) {
  return Object.freeze({
    ...moneyView(value.amount),
    eventIds: value.eventIds,
    sourceBases: value.sourceBases,
    requestCount: value.requestCount,
    unresolvedRequests: value.unresolvedRequests,
    complete: value.unresolvedRequests === 0,
  });
}

function exactCoverageFromRows(rows: readonly EffectiveRequestRow[]): ExactSpendProjection {
  let amount = money('0', 'USD', 'effective');
  const eventIds: string[] = [];
  const sourceBases = new Set<EconomicBasis>();
  let unresolvedRequests = 0;
  for (const row of rows) {
    if (row.effectiveAmount === null) {
      unresolvedRequests += 1;
      continue;
    }
    if (row.effectiveAmount.currency !== 'USD') {
      throw new Error(`economic report request ${row.requestId} is not a USD charge`);
    }
    amount = addMoney(amount, row.effectiveAmount);
    eventIds.push(...row.sourceEventIds);
    for (const basis of row.sourceBases) sourceBases.add(basis);
  }
  return Object.freeze({
    amount,
    eventIds: Object.freeze([...new Set(eventIds)].sort()),
    sourceBases: Object.freeze([...sourceBases].sort()),
    requestCount: rows.length,
    unresolvedRequests,
  });
}

function translationCoverageFromRows(
  rows: readonly EffectiveRequestRow[],
  targetUnit: string,
  asOf: Instant | undefined,
  effectiveAt: Instant | undefined,
): EconomicTranslationCoverage {
  const normalizedTarget = targetUnit.trim();
  if (normalizedTarget.length === 0) throw new Error('economic report target currency/unit must be non-empty');
  let amount = money('0', normalizedTarget, 'effective');
  const eventIds: string[] = [];
  const sourceBases = new Set<EconomicBasis>();
  const rateSources = new Set<string>();
  let unresolvedRequests = 0;
  for (const row of rows) {
    const translation = row.fxTranslation;
    if (translation === null) {
      unresolvedRequests += 1;
      continue;
    }
    if (translation.translatedAmount.currency !== normalizedTarget) {
      throw new Error(`economic report request ${row.requestId} translated to an unexpected currency`);
    }
    amount = addMoney(amount, translation.translatedAmount);
    eventIds.push(...translation.eventIds);
    for (const basis of row.sourceBases) sourceBases.add(basis);
    rateSources.add(translation.rateSource);
  }
  return Object.freeze({
    ...moneyView(amount),
    targetUnit: normalizedTarget,
    asOf: asOf ?? null,
    effectiveAt: effectiveAt ?? null,
    eventIds: Object.freeze([...new Set(eventIds)].sort()),
    sourceBases: Object.freeze([...sourceBases].sort()),
    requestCount: rows.length,
    unresolvedRequests,
    complete: unresolvedRequests === 0,
    rateSources: Object.freeze([...rateSources].sort()),
  });
}

type PeriodCloseOperation = 'finalize' | 'reopen' | 'status';

function flagText(flags: Flags, key: string, required = false): string | null {
  const value = flags[key];
  if (value === undefined) {
    if (required) throw new Error(`--${key} is required`);
    return null;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`--${key} must be a non-empty value`);
  }
  return value.trim();
}

function canonicalFlag(flags: Flags, key: string, required = false): Instant | null {
  const value = flagText(flags, key, required);
  if (value === null) return null;
  try {
    return instant(value);
  } catch (error) {
    throw new Error(`--${key}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function requestedCloseOperation(flags: Flags): PeriodCloseOperation | null {
  const requested: PeriodCloseOperation[] = [];
  if (flags.finalize === true) requested.push('finalize');
  if (flags.reopen === true) requested.push('reopen');
  if (flags['close-status'] === true) requested.push('status');
  // The positional spellings make the lifecycle readable in scripts while the
  // flag spellings remain convenient for one-shot operator commands.
  const positional = flags._[0];
  if (positional === 'finalize' || positional === 'reopen' || positional === 'close-status' || positional === 'status') {
    requested.push(positional === 'status' || positional === 'close-status' ? 'status' : positional);
  }
  if (requested.length > 1 || (requested.length === 1 && flags._[0] !== undefined && !['finalize', 'reopen', 'close-status', 'status'].includes(String(flags._[0])))) {
    throw new Error('choose exactly one period-close operation: --finalize, --reopen, or --close-status');
  }
  return requested[0] ?? null;
}

function requiredPeriod(flags: Flags): { startMs: number; endMs: number; start: Instant; end: Instant } {
  const start = canonicalFlag(flags, 'from', true)!;
  const end = canonicalFlag(flags, 'to', true)!;
  const period = canonicalPeriod(Date.parse(start), Date.parse(end));
  return period;
}

function finalizationView(result: PeriodFinalizationResult) {
  return Object.freeze({
    ...result,
    balances: result.balances.map((balance) => Object.freeze({
      role: balance.role,
      currency: balance.currency,
      basis: balance.basis,
      amount: moneyView(balance.amount),
      eventIds: [...balance.eventIds],
    })),
    sourceEventIds: [...result.sourceEventIds],
  });
}

function reopenView(result: PeriodReopenResult) {
  return Object.freeze({ ...result });
}

function printCloseStatus(status: EconomicPeriodCloseStatus, tty: boolean): void {
  console.log('');
  console.log(color(tty, C.bold, '  Fiscus — economic period close'));
  console.log(color(tty, C.gray, `  ${new Date(status.periodStartMs).toISOString()} → ${new Date(status.periodEndMs).toISOString()} (exclusive end)`));
  console.log(`  status                 ${status.status}`);
  console.log(`  active finalization    ${status.activeFinalizationId ?? 'none'}`);
  console.log(`  latest finalization    ${status.latestFinalizationId ?? 'none'}`);
  console.log(`  latest reopen          ${status.latestReopenId ?? 'none'}`);
  console.log(`  projection digest      ${status.projectionDigest ?? 'none'}`);
  console.log(`  bound event count      ${status.eventCount === null ? 'none' : num(status.eventCount)}`);
  if (status.asOf !== null) console.log(color(tty, C.gray, `  as of                  ${status.asOf}`));
  console.log('');
}

function runCloseOperation(store: Store, flags: Flags, operation: PeriodCloseOperation): void {
  const period = requiredPeriod(flags);
  if (operation === 'status') {
    const asOf = canonicalFlag(flags, 'as-of');
    const result = store.economicPeriodCloseStatus(period.startMs, period.endMs, asOf ?? undefined);
    if (flags.json) {
      printJson({ kind: 'period_close', schemaVersion: 1, operation, result });
    } else {
      printCloseStatus(result, process.stdout.isTTY ?? false);
    }
    return;
  }

  const recordedAt = canonicalFlag(flags, 'recorded-at');
  const id = flagText(flags, 'id');
  if (operation === 'finalize') {
    const result = store.finalizeEconomicPeriod({
      periodStartMs: period.startMs,
      periodEndMs: period.endMs,
      ...(recordedAt === null ? {} : { recordedAt }),
      ...(id === null ? {} : { id }),
    });
    // Finalization is a consequential statement, so the supported CLI path
    // immediately issues its immutable Evidence/Claim pair. The Store method
    // is idempotent; a retry after a process interruption cannot mint a second
    // claim or silently change the economic snapshot.
    const kernel = store.issueEconomicPeriodCloseToKernel(result);
    if (flags.json) {
      printJson({ kind: 'period_close', schemaVersion: 1, operation, result: finalizationView(result), kernel });
    } else {
      console.log('');
      console.log(color(process.stdout.isTTY ?? false, C.bold, '  Economic period finalized'));
      console.log(`  period                 ${period.start} → ${period.end} (exclusive end)`);
      console.log(`  event                  ${result.eventId}`);
      console.log(`  recorded at            ${result.recordedAt}`);
      console.log(`  bound events           ${num(result.eventCount)}`);
      console.log(`  projection digest      ${result.projectionDigest}`);
      console.log(`  kernel evidence        ${kernel.evidenceId} (${kernel.evidence.result})`);
      console.log(`  kernel claim           ${kernel.claimId} (${kernel.claim.result})`);
      console.log('  The close is append-only. Reopen explicitly before recording late in-period evidence.');
      console.log('');
    }
    return;
  }

  const reason = flagText(flags, 'reason', true)!;
  const result = store.reopenEconomicPeriod({
    periodStartMs: period.startMs,
    periodEndMs: period.endMs,
    reason,
    ...(recordedAt === null ? {} : { recordedAt }),
    ...(id === null ? {} : { id }),
  });
  if (flags.json) {
    printJson({ kind: 'period_close', schemaVersion: 1, operation, result: reopenView(result) });
  } else {
    console.log('');
    console.log(color(process.stdout.isTTY ?? false, C.bold, '  Economic period reopened'));
    console.log(`  period                 ${period.start} → ${period.end} (exclusive end)`);
    console.log(`  event                  ${result.eventId}`);
    console.log(`  recorded at            ${result.recordedAt}`);
    console.log(`  reason                 ${result.reason}`);
    console.log(`  reopened finalization  ${result.reopenedFinalizationId}`);
    console.log('  Late evidence may now be appended; finalize again to create a new immutable snapshot.');
    console.log('');
  }
}

/** Build a JSON-safe exact economic report for CLI/API consumers. */
export function buildEconomicReport(store: Store, options: EconomicReportOptions) {
  if (!Number.isFinite(options.startMs) || !Number.isFinite(options.endMs) || options.startMs >= options.endMs) {
    throw new Error('economic report window must contain ordered finite timestamps');
  }
  const targetUnit = options.targetUnit === undefined
    ? undefined
    : (typeof options.targetUnit === 'string' && options.targetUnit.trim().length > 0
      ? options.targetUnit.trim()
      : (() => { throw new Error('economic report target currency/unit must be non-empty'); })());
  if (targetUnit === undefined && options.effectiveAt !== undefined) {
    throw new Error('economic report effectiveAt requires an explicit target currency/unit');
  }
  const requestRows = store.economicRequestRowsInRange(options.startMs, options.endMs, {
    ...(options.asOf === undefined ? {} : { asOf: options.asOf }),
    ...(targetUnit === undefined ? {} : { targetUnit }),
    ...(options.effectiveAt === undefined ? {} : { effectiveAt: options.effectiveAt }),
  });
  const coverage = exactCoverageFromRows(requestRows);
  const translation = targetUnit === undefined
    ? null
    : translationCoverageFromRows(requestRows, targetUnit, options.asOf, options.effectiveAt);
  const projection = store.economic().project(options.asOf);
  const periodClose = store.economic().periodCloseStatus(options.startMs, options.endMs, options.asOf);
  return Object.freeze({
    kind: 'economic_projection' as const,
    schemaVersion: 1,
    demo: options.demo,
    window: Object.freeze({
      startMs: options.startMs,
      endMs: options.endMs,
      requestCoverage: coverageView(coverage),
    }),
    translation,
    projection: Object.freeze({
      asOf: projection.asOf,
      eventIds: projection.eventIds,
      balances: projection.balances.map((balance) => Object.freeze({
        role: balance.role,
        ...moneyView(balance.amount),
        eventIds: balance.eventIds,
      })),
    }),
    periodClose,
  });
}

export function cmdEconomic(flags: Flags): void {
  let operation: PeriodCloseOperation | null;
  try {
    operation = requestedCloseOperation(flags);
  } catch (error) {
    console.error(`  Fiscus error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  if (operation !== null) {
    const store = new Store(dbPath());
    try {
      runCloseOperation(store, flags, operation);
    } catch (error) {
      console.error(`  Fiscus error: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    } finally {
      store.close();
    }
    return;
  }

  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const all = flags.all === true;
  const rawDays = flags.days === undefined ? '30' : String(flags.days);
  const days = Number(rawDays);
  if (!all && (!Number.isFinite(days) || days <= 0 || days > 3650)) {
    console.error('  --days must be a finite number between 0 and 3650 (or pass --all)');
    process.exitCode = 1;
    return;
  }
  const startMs = all ? 0 : now - days * dayMs;
  const endMs = now + 1000;
  let targetUnit: string | null;
  let asOf: Instant | null;
  let effectiveAt: Instant | null;
  try {
    targetUnit = flagText(flags, 'target-currency');
    asOf = canonicalFlag(flags, 'as-of');
    effectiveAt = canonicalFlag(flags, 'effective-at');
  } catch (error) {
    console.error(`  Fiscus error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }
  const store = new Store(dbPath());
  try {
    const report = buildEconomicReport(store, {
      startMs,
      endMs,
      demo: isDemo(),
      ...(targetUnit === null ? {} : { targetUnit }),
      ...(asOf === null ? {} : { asOf }),
      ...(effectiveAt === null ? {} : { effectiveAt }),
    });
    if (flags.json) {
      printJson(report);
      return;
    }
    const tty = process.stdout.isTTY ?? false;
    console.log('');
    console.log(color(tty, C.bold, '  Fiscus — exact economic ledger'));
    console.log(color(tty, C.gray, '  ' + '─'.repeat(64)));
    if (report.demo) console.log(color(tty, C.yellow, '  ● DEMO DATA — synthetic, isolated in demo.db'));
    console.log(color(tty, C.gray, `  ${all ? 'all recorded time' : `last ${days} days`} · exact charge coverage is disclosed below`));
    console.log('');
    console.log(color(tty, C.bold, '  Request charge coverage'));
    const coverage = report.window.requestCoverage;
    console.log(`  ${coverage.complete ? color(tty, C.green, '✓ complete') : color(tty, C.yellow, '! incomplete')}  ${coverage.amount} ${coverage.currency} effective-policy amount`);
    console.log(color(tty, C.gray, `      ${num(coverage.requestCount)} requests · ${num(coverage.eventIds.length)} exact charge events · ${num(coverage.unresolvedRequests)} unresolved legacy rows`));
    if (coverage.sourceBases.length) console.log(color(tty, C.gray, `      source bases: ${coverage.sourceBases.join(', ')}`));
    if (report.translation !== null) {
      const translation = report.translation;
      console.log('');
      console.log(color(tty, C.bold, `  Historical translation coverage (${translation.targetUnit})`));
      console.log(`  ${translation.complete ? color(tty, C.green, '✓ complete') : color(tty, C.yellow, '! incomplete')}  ${translation.amount} ${translation.currency} effective-policy amount`);
      console.log(color(tty, C.gray, `      ${num(translation.requestCount)} requests · ${num(translation.eventIds.length)} translated events · ${num(translation.unresolvedRequests)} unresolved requests`));
      if (translation.rateSources.length) console.log(color(tty, C.gray, `      rate sources: ${translation.rateSources.join(', ')}`));
      if (translation.asOf !== null) console.log(color(tty, C.gray, `      knowledge as-of: ${translation.asOf}`));
      if (translation.effectiveAt !== null) console.log(color(tty, C.gray, `      modeled effective-at: ${translation.effectiveAt}`));
    }
    console.log('');
    console.log(color(tty, C.bold, `  Ledger projection (${num(report.projection.eventIds.length)} events)`));
    if (report.projection.balances.length === 0) {
      console.log(color(tty, C.gray, '  No economic events have been recorded.'));
    } else {
      for (const balance of report.projection.balances) {
        console.log(`  ${`${balance.role}/${balance.currency}/${balance.basis}`.padEnd(38)} ${balance.amount.padStart(18)}  ${color(tty, C.gray, `${num(balance.eventIds.length)} events`)}`);
      }
    }
    console.log('');
    console.log(color(tty, C.gray, '  Exact amounts are canonical strings; legacy numeric request rows are never backfilled without evidence.'));
    console.log('');
  } finally {
    store.close();
  }
}
