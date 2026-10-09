/**
 * `segreant plan`: which plan each tool runs on, what the person pays for it,
 * and how much list-price work the plan did. Two bases, always named: the plan
 * price is what the person entered; the work is list cost from the rate card.
 */
import { Store } from '../store/db.ts';
import { dbPath, loadConfig, mutateConfig, PLAN_SOURCES, type PlanPrice } from '../config.ts';
import {
  detectPlans, planName, suggestedPrice, PUBLIC_PLAN_PRICES_CHECKED, type DetectedPlan, type PlanSource,
} from '../plans/detect.ts';
import { C, color, usd, printJson } from './ui.ts';
import { rangeFor, UserInputError, type Flags } from './flags.ts';

const TOOL_LABEL: Record<PlanSource, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };

/** List cost of a tool's imported (subscription) use in a window. */
function importedListCost(store: Store, source: PlanSource, startMs: number, endMs: number): number {
  let total = 0;
  for (const r of store.requestsInRange(startMs, endMs)) {
    if (r.source === source && r.via === 'import') total += r.costUsd;
  }
  return total;
}

export interface PlanComparison {
  source: PlanSource;
  detected: DetectedPlan;
  price: PlanPrice | null;
  /** List cost of the tool's logged use over the last 30 days. */
  listCostUsd: number;
}

export function planComparisons(store: Store, startMs: number, endMs: number): PlanComparison[] {
  const cfg = loadConfig();
  return detectPlans().map((detected) => ({
    source: detected.source,
    detected,
    price: cfg.plans[detected.source] ?? null,
    listCostUsd: importedListCost(store, detected.source, startMs, endMs),
  }));
}

/**
 * The month's plan lines, printed under the list cost by `month` and `scan`.
 * A price the person set: "Your $20 Claude Pro plan did $1,830 of list-price
 * work". A plan with no price: the plan, and the command that sets it.
 */
export function printPlanLines(tty: boolean, rows: PlanComparison[]): void {
  for (const r of rows) {
    if (r.listCostUsd < 0.005) continue;
    const name = planName(r.detected) ?? `${TOOL_LABEL[r.source]} (plan not detected)`;
    if (r.price !== null) {
      const times = r.price.monthlyUsd > 0 ? `, ${(r.listCostUsd / r.price.monthlyUsd).toFixed(1)}× its price` : '';
      console.log(`  ${color(tty, C.bold, `Your ${usd(r.price.monthlyUsd)}/month ${name} plan`)} did ${color(tty, C.green, usd(r.listCostUsd))} of list-price work in the last 30 days${color(tty, C.gray, `${times}`)}`);
      console.log(color(tty, C.gray, `              plan price: what you set${r.price.plan !== null && r.price.plan !== r.detected.plan ? ` (for ${r.price.plan}; the tool now reports ${r.detected.plan ?? 'no plan'})` : ''} · work: priced from the rate card`));
    } else if (r.detected.plan !== null) {
      const hint = suggestedPrice(r.detected);
      console.log(color(tty, C.gray, `  ${name} plan: ${usd(r.listCostUsd)} of list-price work. Compare it with what you pay: segreant plan set ${r.source} <dollars per month>${hint !== null ? ` (public price ${usd(hint)})` : ''}`));
    }
  }
}

export function cmdPlan(flags: Flags): void {
  const [action, tool, amount] = flags._.map(String);
  if (action === 'set' || action === 'clear') {
    if (tool === undefined || !(PLAN_SOURCES as readonly string[]).includes(tool)) {
      throw new UserInputError(`Name the tool: segreant plan ${action} ${PLAN_SOURCES.join('|')}${action === 'set' ? ' <dollars per month>' : ''}`);
    }
    const source = tool as PlanSource;
    const detected = detectPlans().find((p) => p.source === source)!;
    if (action === 'set') {
      if (amount === undefined) throw new UserInputError(`Give the monthly price: segreant plan set ${source} 20`);
      const monthlyUsd = Number(amount.replace(/^\$/, ''));
      if (!Number.isFinite(monthlyUsd) || monthlyUsd < 0 || monthlyUsd > 100_000) {
        throw new UserInputError('The price must be a dollar amount per month, for example 20.');
      }
      mutateConfig((cfg) => ({
        ...cfg,
        plans: { ...cfg.plans, [source]: { monthlyUsd, plan: detected.plan, setAt: new Date().toISOString() } },
      }));
      console.log(`  Saved: ${planName(detected) ?? TOOL_LABEL[source]} costs you ${usd(monthlyUsd)} a month.`);
    } else {
      mutateConfig((cfg) => {
        const plans = { ...cfg.plans };
        delete plans[source];
        return { ...cfg, plans };
      });
      console.log(`  Cleared the plan price for ${TOOL_LABEL[source]}.`);
    }
    return;
  }
  if (action !== undefined) throw new UserInputError('Usage: segreant plan [set <tool> <dollars> | clear <tool>]');

  const store = new Store(dbPath());
  const { startMs, endMs } = rangeFor('month');
  const rows = planComparisons(store, startMs, endMs);
  store.close();
  if (flags.json) {
    printJson({ windowDays: 30, plans: rows, publicPricesChecked: PUBLIC_PLAN_PRICES_CHECKED });
    return;
  }
  const tty = process.stdout.isTTY ?? false;
  console.log('');
  console.log(color(tty, C.bold, '  Plans') + color(tty, C.gray, '   read from each tool\'s own files · the price is only what you set'));
  for (const r of rows) {
    const name = planName(r.detected);
    const price = r.price === null ? color(tty, C.gray, 'price not set') : `${usd(r.price.monthlyUsd)}/month (you set this ${r.price.setAt.slice(0, 10)})`;
    console.log(`    ${TOOL_LABEL[r.source].padEnd(12)} ${(name ?? 'not detected').padEnd(18)} ${price}`);
    console.log(color(tty, C.gray, `                 ${r.detected.evidence}${r.detected.billing ? ` · billed via ${r.detected.billing.replace(/_/g, ' ')}` : ''}`));
  }
  console.log('');
  printPlanLines(tty, rows);
  const unset = rows.filter((r) => r.price === null && r.detected.plan !== null);
  if (unset.length > 0) {
    console.log('');
    console.log(color(tty, C.gray, `  Public prices (checked ${PUBLIC_PLAN_PRICES_CHECKED}) are only a hint: App Store billing, tax and annual plans change what you pay.`));
  }
  console.log('');
}
