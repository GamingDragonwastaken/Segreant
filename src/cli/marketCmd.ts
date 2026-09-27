/**
 * `segreant market` — public quality per dollar, by kind of work, from the
 * bundled dated snapshot plus any refresh the operator fetched. Read-only by
 * default; `--refresh <source|all>` fetches only through the egress gate.
 */
import { Store } from '../store/db.ts';
import { dbPath, loadConfig } from '../config.ts';
import { loadRealization } from '../value/realization.ts';
import { computeFrontier } from '../value/frontier.ts';
import { buildMarketReport, loadMarket, type BenchmarkRow, type MarketBoard, type MarketReport, type PersonalMarketValue, type RatingRow } from '../market/market.ts';
import { refreshMarketSource } from '../market/refresh.ts';
import { MARKET_SOURCES, MARKET_SOURCE_IDS, type MarketSourceId } from '../market/sources.ts';
import type { Flags } from './flags.ts';
import { C, color, printJson, usd } from './ui.ts';

const DAY_MS = 86_400_000;
const STALE_DAYS = 120;

function ageDays(day: string | null, nowMs: number): number | null {
  if (!day) return null;
  const t = Date.parse(`${day.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(t) ? Math.floor((nowMs - t) / DAY_MS) : null;
}

async function personalValues(repo: string, windowDays: number): Promise<PersonalMarketValue[]> {
  const store = new Store(dbPath());
  try {
    const loaded = await loadRealization(store, repo, { windowDays, persist: false });
    if (!loaded) return [];
    return computeFrontier(loaded.report.units).byModel
      .filter((cell) => cell.model !== null && cell.units > 0)
      .map((cell) => {
        const realized = cell.realizationRate * cell.units;
        return {
          model: cell.model!, units: cell.units, realizationRate: cell.realizationRate,
          costPerRealizedUnitUsd: realized > 0 ? cell.costUsd / realized : null,
          basis: 'operator_realized_value' as const,
        };
      });
  } finally {
    store.close();
  }
}

async function refresh(target: string, json: boolean): Promise<void> {
  const ids: MarketSourceId[] = target === 'all' ? [...MARKET_SOURCE_IDS] : MARKET_SOURCE_IDS.includes(target as MarketSourceId) ? [target as MarketSourceId] : [];
  if (!ids.length) {
    console.error(`Unknown market source "${target}". Sources: ${MARKET_SOURCE_IDS.join(', ')}, or all.`);
    process.exitCode = 1;
    return;
  }
  const features = loadConfig().features;
  const results = [];
  for (const id of ids) {
    if (!features.market || !features[MARKET_SOURCES[id].feature]) {
      results.push({ ok: false as const, sourceId: id, code: 'disabled' as const, error: `${id} is switched off (segreant features)`, grantCommand: null });
      continue;
    }
    results.push(await refreshMarketSource(id));
  }
  if (json) { printJson(results); return; }
  for (const r of results) {
    if (r.ok) console.log(`  ${r.sourceId}: refreshed — ${r.rows} rows in ${r.requests} request(s); published ${r.publishedAt ?? 'undated'}; fetched ${r.fetchedAt}`);
    else {
      console.log(`  ${r.sourceId}: not refreshed (${r.code}) — ${r.error}`);
      if (r.grantCommand) console.log(`    Allow it with:\n      ${r.grantCommand}`);
    }
  }
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

function fmtPrice(r: RatingRow): string {
  if (!r.price) return 'no public price';
  const p = r.price.blendedUsdPerMillion !== undefined ? `${usd(r.price.blendedUsdPerMillion)}/M` : `${usd(r.price.usdPerImage!)}/img`;
  return r.price.match === 'exact' ? p : `${p} as ${r.price.pricedAs}`;
}

function printBoard(b: MarketBoard, tty: boolean, limit: number, nowMs: number): void {
  const dated = b.newestRowDate ?? b.publishedAt;
  const age = ageDays(dated, nowMs);
  console.log(color(tty, C.bold, `  ${b.label}`) + color(tty, C.gray, `  · ${b.licence} · ${b.homepage}`));
  if (b.status !== 'available') {
    console.log(`    ${b.status === 'disabled' ? 'Switched off (segreant features) — not computed.' : 'No data for this source in the bundled snapshot; run segreant market --refresh ' + b.sourceId + '.'}`);
    return;
  }
  console.log(color(tty, C.gray, `    ${b.origin === 'refreshed' ? 'Refreshed' : 'Bundled snapshot'} · fetched ${b.fetchedAt!.slice(0, 10)} · newest result ${dated ?? 'undated'}${age !== null && age > STALE_DAYS ? ` (${age} days old — this source has not published newer results)` : ''}${b.priceSource ? ` · prices ${b.priceSource.status}${b.priceSource.asOf ? ` as of ${b.priceSource.asOf}` : ''}` : ''}`));
  const shown = b.rows.slice(0, limit);
  if (b.sourceId === 'aider') {
    console.log(color(tty, C.gray, '    model                                     pass    run cost   per solved task   frontier  date'));
    for (const r of shown as BenchmarkRow[]) {
      const personal = r.personal ? `  | yours: ${(r.personal.realizationRate * 100).toFixed(0)}% realized, ${r.personal.costPerRealizedUnitUsd === null ? 'no realized unit' : usd(r.personal.costPerRealizedUnitUsd) + '/realized unit'}` : '';
      console.log(`    ${r.model.slice(0, 40).padEnd(40)}  ${r.passRatePercent.toFixed(1).padStart(5)}%  ${(r.runCostUsd === null ? 'unpublished' : usd(r.runCostUsd)).padStart(10)}  ${(r.costPerSolvedTaskUsd === null ? '—' : usd(r.costPerSolvedTaskUsd)).padStart(16)}  ${r.frontier === null ? '    —   ' : r.frontier ? '   yes  ' : '        '}  ${r.date}${personal}`);
    }
  } else {
    console.log(color(tty, C.gray, '    model                                     rating (interval)       votes   list price (3:1 blend)         frontier'));
    for (const r of shown as RatingRow[]) {
      const personal = r.personal ? `  | yours: ${(r.personal.realizationRate * 100).toFixed(0)}% realized` : '';
      console.log(`    ${r.model.slice(0, 40).padEnd(40)}  ${r.rating.toFixed(0)} (${r.ratingLower.toFixed(0)}–${r.ratingUpper.toFixed(0)})`.padEnd(66) + `${String(r.votes).padStart(7)}   ${fmtPrice(r).slice(0, 30).padEnd(30)} ${r.frontier === null ? '—' : r.frontier ? 'yes' : ''}${personal}`);
    }
  }
  if (b.rows.length > shown.length) console.log(color(tty, C.gray, `    … ${b.rows.length - shown.length} more (--all or --json)`));
  if (b.frontier.length) {
    const rule = b.sourceId === 'aider' ? 'no other run cost less and passed more' : 'no model priced no higher has a clearly higher rating';
    console.log(`    Frontier (${rule}): ${b.frontier.join(', ')}`);
  }
  for (const note of b.notes) console.log(color(tty, C.gray, `    ${note}`));
}

export function printMarket(report: MarketReport, flags: Flags): void {
  const tty = process.stdout.isTTY ?? false;
  if (report.status === 'disabled') {
    console.log('\n  The public model market is switched off (segreant features on market --apply to enable). Nothing was computed.\n');
    return;
  }
  const limit = flags.all ? Number.MAX_SAFE_INTEGER : 12;
  const now = Date.now();
  console.log('');
  console.log(color(tty, C.bold, '  Public model market — quality per dollar from public evidence'));
  console.log(color(tty, C.gray, '  Public benchmarks and list prices, not your own results. docs/MARKET-SOURCES.md'));
  for (const e of report.cacheErrors) console.log(color(tty, C.gray, `  Refresh file ignored: ${e}`));
  const only = typeof flags.category === 'string' ? flags.category : null;
  for (const cat of report.categories) {
    if (only && cat.id !== only) continue;
    console.log('');
    console.log(color(tty, C.bold, `  ${cat.label}`));
    for (const b of cat.boards) printBoard(b, tty, limit, now);
  }
  console.log('');
  for (const line of report.boundary) console.log(color(tty, C.gray, `  · ${line}`));
  console.log('');
}

export async function cmdMarket(flags: Flags): Promise<void> {
  if (flags.refresh !== undefined) {
    await refresh(typeof flags.refresh === 'string' ? flags.refresh : 'all', flags.json === true);
    return;
  }
  const features = loadConfig().features;
  const personal = typeof flags.repo === 'string' && features.market ? await personalValues(flags.repo, flags.window ? Number(flags.window) : 30) : [];
  const report = buildMarketReport(loadMarket(), features, personal);
  if (flags.json) { printJson(report); return; }
  printMarket(report, flags);
}
