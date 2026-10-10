/**
 * Bare `segreant`: the first thing anyone sees.
 *
 * Read-only, like every command without --apply: it never imports on its own.
 * With nothing recorded yet it says what Segreant does, which tools it can read
 * on this machine, and the one command that reads them. With a ledger it leads
 * with the month, the plans, and how much of the AI work stayed in the code
 * (from the last measurement), then the next step. `segreant guide` keeps the
 * full checklist.
 */
import { existsSync } from 'node:fs';
import { Store } from '../store/db.ts';
import { dbPath, isDemo } from '../config.ts';
import { defaultClaudeCodeRoot } from '../connect/claudeCode.ts';
import { defaultCodexRoot } from '../connect/codex.ts';
import { defaultOpencodeDbPath } from '../connect/opencode.ts';
import { defaultAntigravityRoot } from '../connect/antigravity.ts';
import { detectPlans, planName } from '../plans/detect.ts';
import { keptSummary, realizationFromStore } from '../value/realization.ts';
import { planComparisons, printPlanLines } from './planCmd.ts';
import { summarizeBasis } from '../cost/basis.ts';
import { basisLines } from './basisLines.ts';
import { C, color, usd, num, printJson } from './ui.ts';
import { rangeFor, type Flags } from './flags.ts';

const DAY = 86_400_000;

interface FoundTool { id: string; label: string; plan: string | null }

function toolsOnThisMachine(): FoundTool[] {
  const plans = new Map(detectPlans().map((p) => [p.source, planName(p)]));
  const out: FoundTool[] = [];
  if (existsSync(defaultClaudeCodeRoot())) out.push({ id: 'claude-code', label: 'Claude Code', plan: plans.get('claude-code') ?? null });
  const codex = defaultCodexRoot();
  if (codex !== null && existsSync(codex)) out.push({ id: 'codex', label: 'Codex', plan: plans.get('codex') ?? null });
  const opencode = defaultOpencodeDbPath();
  if (opencode !== null && existsSync(opencode)) out.push({ id: 'opencode', label: 'opencode', plan: null });
  if (defaultAntigravityRoot() !== null) out.push({ id: 'antigravity', label: 'Antigravity', plan: null });
  return out;
}

export function cmdHome(flags: Flags): void {
  const store = new Store(dbPath());
  const month = rangeFor('month');
  const summary = store.summary(month.startMs, month.endMs);
  const everything = store.summary(0, Date.now() + 1000);
  const tools = toolsOnThisMachine();
  const now = Date.now();
  // The last measurement of what stayed in the code, over the last 90 days of commits.
  const stored = realizationFromStore(store);
  const recent = stored.units.filter((u) => u.tsEpochMs >= now - 90 * DAY);
  const kept = recent.length > 0 ? keptSummary({ units: recent, windowDays: stored.windowDays }) : null;
  const plans = everything.requests > 0 && !isDemo() ? planComparisons(store, month.startMs, month.endMs) : [];
  const basis = summarizeBasis(store.pricingEvidenceByModel(month.startMs, month.endMs));
  store.close();

  if (flags.json) {
    printJson({
      empty: everything.requests === 0,
      tools,
      last30Days: { listCostUsd: summary.costUsd, requests: summary.requests, basis },
      kept: kept === null ? null : { ...kept, asOf: new Date(stored.generatedAt).toISOString() },
      plans,
    });
    return;
  }

  const tty = process.stdout.isTTY ?? false;
  console.log('');
  console.log(color(tty, C.bold, '  Segreant') + color(tty, C.gray, ' — what your AI coding spend produced, measured on your machine') + (isDemo() ? color(tty, C.yellow, '   ● DEMO DATA') : ''));
  console.log('');

  if (everything.requests === 0) {
    if (tools.length > 0) {
      const found = tools.map((t) => `${t.label}${t.plan ? ` (${t.plan})` : ''}`).join(' · ');
      console.log(`  Found on this machine: ${color(tty, C.bold, found)}`);
      console.log('');
      console.log('  Read their logs and measure what the work produced:');
      console.log(color(tty, C.cyan, '    segreant scan --setup'));
      console.log(color(tty, C.gray, '    Nothing leaves this machine. The first run takes a few minutes; the month appears after about one.'));
    } else {
      console.log('  No AI coding tool logs found here (Claude Code, Codex, Antigravity and opencode are read today).');
      console.log(color(tty, C.cyan, '    segreant scan') + color(tty, C.gray, '   looks further and lists what it can and cannot read'));
    }
    console.log('');
    console.log(color(tty, C.gray, '  See every screen with sample data first:  segreant demo --serve'));
    console.log('');
    return;
  }

  const plainList = basis.cohorts.length === 1 && basis.cohorts[0]!.id === 'list_exact';
  console.log(`  ${color(tty, C.bold, 'Last 30 days')}  ${color(tty, C.green, usd(summary.costUsd))} ${basis.headlineLabel.toLowerCase()}  ${color(tty, C.gray, plainList
    ? `(${num(summary.requests)} requests · each model's API list rate · not your bill)`
    : `(${num(summary.requests)} requests, priced in parts:)`)}`);
  if (!plainList) for (const line of basisLines(basis, '                ')) console.log(color(tty, C.gray, line));
  printPlanLines(tty, plans);
  console.log('');
  if (kept !== null && kept.kept.units + kept.notKept.units + kept.unknown.units + kept.maturing.units > 0) {
    const asOf = new Date(stored.generatedAt).toISOString().slice(0, 10);
    console.log(color(tty, C.bold, '  Did the AI work stay in the code?') + color(tty, C.gray, `   commits of the last 90 days, all projects · measured ${asOf}`));
    const row = (label: string, b: { units: number; costUsd: number }, tone: string, what: string) => {
      if (b.units === 0) return;
      console.log(`    ${label.padEnd(10)} ${color(tty, tone, usd(b.costUsd).padStart(10))}  ${String(b.units).padStart(4)} commits  ${color(tty, C.gray, what)}`);
    };
    row('Kept', kept.kept, C.green, 'still in the code after 14 days');
    row('Not kept', kept.notKept, C.yellow, 'rewritten, removed or reverted');
    row('Unknown', kept.unknown, C.gray, 'not measured');
    row('Maturing', kept.maturing, C.gray, 'younger than 14 days when measured');
    console.log(color(tty, C.gray, '    Refresh: segreant scan --setup · one project in full: segreant realize --repo <path>'));
  } else {
    console.log(color(tty, C.gray, '  Not measured yet: what the work produced. Run segreant scan --setup, or segreant realize --repo <path> for one project.'));
  }
  console.log('');
  console.log(`  ${color(tty, C.bold, 'Next')}  ${color(tty, C.cyan, 'segreant start')}${color(tty, C.gray, ' opens the dashboard')} · ${color(tty, C.cyan, 'segreant quota')}${color(tty, C.gray, ' your plan limits')} · ${color(tty, C.cyan, 'segreant guide')}${color(tty, C.gray, ' the full checklist')}`);
  console.log('');
}
