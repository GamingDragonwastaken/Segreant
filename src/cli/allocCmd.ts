/**
 * `fiscus alloc` — cost-centre allocation.
 *
 * Read-only by default, like every other money-facing command here: computing a
 * period shows it, `--apply` records it. The one thing this command will not do
 * is present an allocation without the basis it was made on, because allocating
 * a local rate-card estimate is legitimate and allocating one while implying it
 * is settled cost is not.
 */

import { dbPath } from '../config.ts';
import { Store } from '../store/db.ts';
import { formatUsdMicros } from '../billing/types.ts';
import { displayUsd } from '../billing/reconcile.ts';
import { MATCH_FIELDS, type AllocationMatch, type AllocationMethod, type AllocationTarget } from '../alloc/rules.ts';
import type { AllocationRunResult } from '../alloc/apply.ts';
import { color, C } from './ui.ts';
import type { Flags } from './flags.ts';

function usage(): void {
  console.error('  Usage: fiscus alloc <centres|centre|rules|rule|revoke|run> [options]');
  console.error('         fiscus alloc centre <id> --name "<name>" [--owner <who>]   add or update a cost centre');
  console.error('         fiscus alloc centre <id> --archive                          retain it, stop it receiving');
  console.error('         fiscus alloc rule <id> --method <direct|fixed_split|proportional_to_direct> \\');
  console.error('             --centre <id>[:<ratio>][,<id>[:<ratio>]...] [--match-project P] [--match-model M]');
  console.error('             [--match-provider P] [--match-source S] [--match-user U]');
  console.error('             [--priority N] [--from <ISO>] [--until <ISO>] [--owner W] [--note "..."]');
  console.error('         fiscus alloc revoke <rule-id>');
  console.error('         fiscus alloc run --from <ISO> --to <ISO> [--apply] [--json]');
  console.error('  Allocation is derived: it never modifies a request row, and never feeds budgets or RoI.');
}

function parseTs(value: unknown, label: string): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value.trim());
  if (!Number.isFinite(ms)) throw new Error(`${label} must be an ISO date or date-time`);
  return ms;
}

/**
 * `--centre eng` or `--centre eng:0.6,platform:0.4`.
 *
 * Comma-separated rather than a repeated flag: the shared flag parser keeps only
 * the LAST occurrence of a key, so `--centre a --centre b` would silently drop
 * `a` and allocate the whole slice to `b`. A split that quietly lost one of its
 * targets is exactly the failure this layer must not have.
 */
function parseTargets(flags: Flags): AllocationTarget[] {
  const raw = typeof flags.centre === 'string' ? flags.centre : '';
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) throw new Error('--centre is required (e.g. --centre eng, or --centre eng:0.6,platform:0.4)');
  return list.map((entry) => {
    const [id, ratioText] = entry.split(':');
    if (!id) throw new Error(`--centre needs a cost centre id (got "${entry}")`);
    if (ratioText === undefined) return { costCentreId: id, ratio: 1 };
    const ratio = Number(ratioText);
    if (!Number.isFinite(ratio)) throw new Error(`--centre ${id}: ratio "${ratioText}" is not a number`);
    return { costCentreId: id, ratio };
  });
}

function parseMatch(flags: Flags): AllocationMatch {
  const match: AllocationMatch = {};
  for (const field of MATCH_FIELDS) {
    const value = flags[`match-${field}`];
    if (typeof value === 'string' && value.trim()) match[field] = value.trim();
  }
  return match;
}

function printRun(result: AllocationRunResult, applied: boolean, tty: boolean): void {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const pct = (part: number, whole: number) => (whole === 0 ? '—' : `${((part / whole) * 100).toFixed(1)}%`);
  console.log('');
  console.log(color(tty, C.bold, '  Cost-centre allocation'));
  console.log(color(tty, C.dim, `  ${day(result.periodStartMs)} → ${day(result.periodEndMs)} (exclusive end)`));
  console.log('');

  if (result.byCostCentre.length === 0) {
    console.log(color(tty, C.gray, '  No spend reached a cost centre in this period.'));
  } else {
    for (const centre of result.byCostCentre) {
      console.log(
        `  ${('$' + displayUsd(centre.allocatedMicros)).padStart(13)}  ${pct(centre.allocatedMicros, result.totalMicros).padStart(6)}  ` +
        `${centre.costCentreId.padEnd(24)} ${color(tty, C.gray, centre.sourceBasis.replaceAll('_', ' '))}`,
      );
    }
  }

  console.log('');
  console.log(`  ${('$' + displayUsd(result.allocatedMicros)).padStart(13)}  ${pct(result.allocatedMicros, result.totalMicros).padStart(6)}  allocated`);
  const unallocatedColor = result.unallocatedMicros > 0 ? C.yellow : C.gray;
  console.log(color(tty, unallocatedColor, `  ${('$' + displayUsd(result.unallocatedMicros)).padStart(13)}  ${pct(result.unallocatedMicros, result.totalMicros).padStart(6)}  unallocated`));
  console.log(color(tty, C.dim, `  ${('$' + displayUsd(result.totalMicros)).padStart(13)}          ledger total for the period`));

  if (result.unallocated.length > 0) {
    console.log('');
    console.log(color(tty, C.bold, '  Why it is unallocated'));
    for (const bucket of result.unallocated) {
      console.log(`    ${('$' + displayUsd(bucket.micros)).padStart(12)}  ${bucket.reason.replaceAll('_', ' ')}`);
      const top = bucket.topProjects.map((p) => `${p.project} ($${displayUsd(p.micros)})`).join(', ');
      if (top) console.log(color(tty, C.gray, `                  mostly: ${top}`));
    }
    console.log(color(tty, C.dim, '  Unallocated is an accounting position, not a gap to fill. It is reported, never swept.'));
  }

  console.log('');
  // The whole reason this layer is safe to run before a reconciliation exists:
  // the basis travels with the money, so a showback figure cannot forget what
  // it is made of.
  console.log(color(tty, C.dim, `  Source basis  ${result.sourceBases.join(', ')}`));
  console.log(color(tty, C.dim, '                None of these is a provider-reported or reconciled amount — every'));
  console.log(color(tty, C.dim, '                figure above is a local estimate. Allocating an estimate is legitimate;'));
  console.log(color(tty, C.dim, '                presenting it as settled cost is not. Reconcile before you charge anyone.'));
  console.log(color(tty, C.dim, `  Conservation  ${result.conserves ? 'exact — allocated + unallocated = ledger total' : 'FAILED'}`));
  console.log(color(tty, C.dim, `  Excluded from ${result.excludedFrom.join(', ')}`));
  console.log(applied ? color(tty, C.green, '  Recorded as an immutable derived run.') : '  Not recorded. Persist it with: fiscus alloc run … --apply');
}

export function cmdAlloc(flags: Flags): void {
  const tty = process.stdout.isTTY ?? false;
  const action = typeof flags._[0] === 'string' ? flags._[0] : 'run';
  const store = new Store(dbPath());
  try {
    if (action === 'centres') {
      const centres = store.costCentres();
      if (flags.json) return void process.stdout.write(JSON.stringify({ costCentres: centres }, null, 2) + '\n');
      console.log('');
      if (centres.length === 0) console.log(color(tty, C.gray, '  No cost centres. Add one: fiscus alloc centre eng --name "Engineering"'));
      for (const c of centres) {
        console.log(`  ${c.costCentreId.padEnd(24)} ${c.name}${c.owner ? color(tty, C.gray, `  (${c.owner})`) : ''}${c.archivedAtMs ? color(tty, C.yellow, '  [archived]') : ''}`);
      }
      return;
    }

    if (action === 'centre') {
      const id = flags._[1];
      if (typeof id !== 'string') return void (usage(), (process.exitCode = 1));
      if (flags.archive) {
        const done = store.archiveCostCentre(id);
        console.log(done
          ? `  Archived "${id}". Past runs keep it; new spend will not reach it.`
          : `  No open cost centre "${id}".`);
        if (!done) process.exitCode = 1;
        return;
      }
      const name = typeof flags.name === 'string' ? flags.name : null;
      if (!name) return void (usage(), (process.exitCode = 1));
      const centre = store.upsertCostCentre({ costCentreId: id, name, owner: typeof flags.owner === 'string' ? flags.owner : null });
      console.log(`  ${color(tty, C.green, '✓')} cost centre "${centre.costCentreId}" — ${centre.name}`);
      return;
    }

    if (action === 'rules') {
      const rules = store.allocationRules();
      if (flags.json) return void process.stdout.write(JSON.stringify({ rules }, null, 2) + '\n');
      console.log('');
      if (rules.length === 0) console.log(color(tty, C.gray, '  No allocation rules. Spend allocates to nothing until one exists.'));
      for (const r of rules) {
        const match = MATCH_FIELDS.filter((f) => r.match[f] != null).map((f) => `${f}=${r.match[f]}`).join(' ') || 'everything';
        const targets = r.targets.map((t) => (r.method === 'fixed_split' ? `${t.costCentreId}:${t.ratio}` : t.costCentreId)).join(' ');
        const state = r.revokedAtMs ? color(tty, C.yellow, ' [revoked]') : r.effectiveToMs ? color(tty, C.gray, ' [superseded]') : '';
        console.log(`  ${`${r.ruleId} v${r.version}`.padEnd(22)} p${String(r.priority).padEnd(4)} ${r.method.padEnd(24)} ${match}  →  ${targets}${state}`);
      }
      return;
    }

    if (action === 'rule') {
      const id = flags._[1];
      const method = typeof flags.method === 'string' ? flags.method as AllocationMethod : null;
      if (typeof id !== 'string' || !method) return void (usage(), (process.exitCode = 1));
      const from = parseTs(flags.from, '--from');
      const rule = store.saveAllocationRule({
        ruleId: id,
        method,
        match: parseMatch(flags),
        targets: parseTargets(flags),
        priority: typeof flags.priority === 'string' ? Number(flags.priority) : 100,
        // Default to the epoch so a first rule covers existing history rather
        // than silently applying only to spend recorded after it was authored.
        effectiveFromMs: from ?? 0,
        effectiveToMs: parseTs(flags.until, '--until'),
        revokedAtMs: null,
        owner: typeof flags.owner === 'string' ? flags.owner : null,
        note: typeof flags.note === 'string' ? flags.note : null,
      });
      console.log(`  ${color(tty, C.green, '✓')} rule "${rule.ruleId}" v${rule.version} (${rule.method})`);
      if (rule.version > 1) console.log(color(tty, C.gray, `  v${rule.version - 1} closed at ${new Date(rule.effectiveFromMs).toISOString()} and retained — past periods still re-run under it.`));
      return;
    }

    if (action === 'revoke') {
      const id = flags._[1];
      if (typeof id !== 'string') return void (usage(), (process.exitCode = 1));
      const n = store.revokeAllocationRule(id);
      console.log(n > 0 ? `  Revoked ${n} open version(s) of "${id}". Rows retained.` : `  No open rule "${id}".`);
      if (n === 0) process.exitCode = 1;
      return;
    }

    if (action === 'run') {
      const from = parseTs(flags.from, '--from');
      const to = parseTs(flags.to, '--to');
      if (from === null || to === null) return void (usage(), (process.exitCode = 1));
      if (to <= from) {
        console.error('  --to must be after --from');
        process.exitCode = 1;
        return;
      }
      const result = store.allocatePeriod(from, to);
      if (!result.conserves) {
        // Should be unreachable; if it ever fires, the number is not publishable.
        console.error('  Allocation did not conserve its input. Refusing to show or record it.');
        console.error(`  total=${formatUsdMicros(result.totalMicros)} allocated=${formatUsdMicros(result.allocatedMicros)} unallocated=${formatUsdMicros(result.unallocatedMicros)}`);
        process.exitCode = 1;
        return;
      }
      const applied = Boolean(flags.apply);
      const allocationRunId = applied ? store.saveAllocationRun(result) : null;
      if (flags.json) process.stdout.write(JSON.stringify({ applied, allocationRunId, result }, null, 2) + '\n');
      else printRun(result, applied, tty);
      return;
    }

    usage();
    process.exitCode = 1;
  } catch (err) {
    console.error(`  ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    store.close();
  }
}
