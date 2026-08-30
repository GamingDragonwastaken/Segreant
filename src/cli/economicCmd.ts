/** Exact economic-ledger inspection — no BigInt or legacy-number leakage. */

import { Store, type ExactSpendProjection } from '../store/db.ts';
import { dbPath, isDemo } from '../config.ts';
import { formatMoneyAmount, moneyToJson } from '../economics/money.ts';
import { canonicalPeriod } from '../economics/close.ts';
import { instant, type Instant } from '../epistemic/time.ts';
import type { EconomicPeriodCloseStatus, PeriodFinalizationResult, PeriodReopenResult } from '../economics/ledger.ts';
import { printJson, C, color, num } from './ui.ts';
import type { Flags } from './flags.ts';

interface EconomicReportOptions {
  readonly startMs: number;
  readonly endMs: number;
  readonly demo: boolean;
}

interface EconomicMoneyView {
  readonly amount: string;
  readonly coefficient: string;
  readonly scale: number;
  readonly currency: string;
  readonly basis: string;
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
    if (flags.json) {
      printJson({ kind: 'period_close', schemaVersion: 1, operation, result: finalizationView(result) });
    } else {
      console.log('');
      console.log(color(process.stdout.isTTY ?? false, C.bold, '  Economic period finalized'));
      console.log(`  period                 ${period.start} → ${period.end} (exclusive end)`);
      console.log(`  event                  ${result.eventId}`);
      console.log(`  recorded at            ${result.recordedAt}`);
      console.log(`  bound events           ${num(result.eventCount)}`);
      console.log(`  projection digest      ${result.projectionDigest}`);
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
  const projection = store.economic().project();
  const coverage = store.exactSpendBetween(options.startMs, options.endMs, false);
  const periodClose = store.economic().periodCloseStatus(options.startMs, options.endMs);
  return Object.freeze({
    kind: 'economic_projection' as const,
    schemaVersion: 1,
    demo: options.demo,
    window: Object.freeze({
      startMs: options.startMs,
      endMs: options.endMs,
      requestCoverage: coverageView(coverage),
    }),
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
  const store = new Store(dbPath());
  try {
    const report = buildEconomicReport(store, { startMs, endMs, demo: isDemo() });
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
