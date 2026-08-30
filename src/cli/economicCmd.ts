/** Exact economic-ledger inspection — no BigInt or legacy-number leakage. */

import { Store, type ExactSpendProjection } from '../store/db.ts';
import { dbPath, isDemo } from '../config.ts';
import { formatMoneyAmount, moneyToJson } from '../economics/money.ts';
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

/** Build a JSON-safe exact economic report for CLI/API consumers. */
export function buildEconomicReport(store: Store, options: EconomicReportOptions) {
  if (!Number.isFinite(options.startMs) || !Number.isFinite(options.endMs) || options.startMs >= options.endMs) {
    throw new Error('economic report window must contain ordered finite timestamps');
  }
  const projection = store.economic().project();
  const coverage = store.exactSpendBetween(options.startMs, options.endMs, false);
  return Object.freeze({
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
  });
}

export function cmdEconomic(flags: Flags): void {
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
