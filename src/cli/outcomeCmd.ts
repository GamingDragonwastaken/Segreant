/** Explicit non-code self-reports. Every write previews before --apply. */
import { Store } from '../store/db.ts';
import { dbPath, loadConfig } from '../config.ts';
import { recordReportedOutcome, selfReportedValueReport, type OutcomeInput, type SpendLink } from '../value/selfReported.ts';
import type { Flags } from './flags.ts';
import { printJson, usd } from './ui.ts';

function textFlag(flags: Flags, key: string): string | undefined {
  const value = flags[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`--${key} needs a value`);
  return value;
}
function instant(value: string, label: string): number {
  const parsed = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`--${label} needs an ISO instant or epoch milliseconds`);
  return parsed;
}
function linkFromFlags(flags: Flags): SpendLink {
  const requestId = textFlag(flags, 'request');
  const sessionId = textFlag(flags, 'session');
  const from = textFlag(flags, 'from');
  const to = textFlag(flags, 'to');
  const tool = textFlag(flags, 'tool');
  const modes = Number(requestId !== undefined) + Number(sessionId !== undefined) + Number(from !== undefined || to !== undefined || tool !== undefined);
  if (modes !== 1) throw new Error('choose one link: --request, --session, or --from --to --tool');
  if (requestId !== undefined) return { type: 'request', requestId, basis: 'recorded' };
  if (sessionId !== undefined) return { type: 'session', sessionId, basis: 'recorded' };
  if (!from || !to || !tool) throw new Error('inferred link needs --from --to --tool');
  return { type: 'window', fromMs: instant(from, 'from'), toMs: instant(to, 'to'), tool, basis: 'inferred' };
}
function inputFromFlags(flags: Flags): OutcomeInput {
  const outcomeId = textFlag(flags, 'id') ?? '';
  const kind = textFlag(flags, 'kind') as OutcomeInput['kind'];
  const decision = textFlag(flags, 'decision') as OutcomeInput['decision'];
  const use = textFlag(flags, 'use') as OutcomeInput['use'];
  const rating = textFlag(flags, 'rating');
  const attempts = textFlag(flags, 'attempts');
  const regenerated = textFlag(flags, 'regenerated');
  const stillInUse = textFlag(flags, 'still-in-use');
  const yesNo = (value: string | undefined, label: string): boolean | undefined => {
    if (value === undefined) return undefined;
    if (value !== 'true' && value !== 'false') throw new Error(`--${label} must be true or false`);
    return value === 'true';
  };
  return {
    outcomeId, kind, link: linkFromFlags(flags),
    ...(rating === undefined ? {} : { rating: Number(rating) }),
    ...(textFlag(flags, 'note') === undefined ? {} : { note: textFlag(flags, 'note') }),
    ...(decision === undefined ? {} : { decision }),
    ...(use === undefined ? {} : { use }),
    ...(attempts === undefined ? {} : { attempts: Number(attempts) }),
    ...(regenerated === undefined ? {} : { regenerated: yesNo(regenerated, 'regenerated') }),
    ...(stillInUse === undefined ? {} : { stillInUse: yesNo(stillInUse, 'still-in-use') }),
  };
}

export function cmdOutcome(flags: Flags, enabled = loadConfig().features.selfReportedOutcomes): void {
  const action = flags._[0];
  if (action !== 'record' && action !== 'report') {
    throw new Error('usage: segreant outcome record|report [--id ID --kind chat|image|other --request ID|--session ID|--from ISO --to ISO --tool TOOL] [--rating 1..5 --note TEXT --decision accepted_as_is|edited_before_use|rejected --attempts N --regenerated true|false --use exported|copied|shipped|published|not_used --still-in-use true|false] [--apply]');
  }
  if (action === 'record' && !enabled) {
    console.error('Self-reported outcomes are switched off; nothing was recorded. Enable with: segreant features on selfReportedOutcomes --apply');
    process.exitCode = 1;
    return;
  }
  const store = new Store(dbPath());
  try {
    if (action === 'record') {
      const result = recordReportedOutcome(store, inputFromFlags(flags), flags.apply === true, enabled);
      if (flags.json) printJson(result);
      else {
        console.log(`${result.apply ? 'Recorded' : 'Preview'} outcome ${result.event.outcomeId} (${result.event.kind})`);
        console.log(`  ${result.event.signals.map((s) => s.type).join(', ')} · ${result.event.link.basis} link · ${result.linkStatus} · ${result.matchedRequests} request(s)`);
        console.log(`  Matched cost: ${result.matchedCostUsd === null ? 'unknown' : usd(result.matchedCostUsd)} · ${result.basis}`);
        if (!result.apply) console.log('  No outcome was written. Repeat with --apply to record it.');
      }
      return;
    }
    const days = flags.days === undefined ? 30 : Number(flags.days);
    if (!Number.isSafeInteger(days) || days < 1 || days > 3650) throw new Error('--days must be an integer from 1 to 3650');
    const now = Date.now();
    const report = selfReportedValueReport(store, now - days * 86400000, now + 1000, enabled);
    if (flags.json) { printJson(report); return; }
    if (report.status === 'disabled') { console.log('Self-reported value is switched off (segreant features); nothing was computed.'); return; }
    console.log('Self-reported value · chat, image, other');
    console.log(`  ${report.basis}`);
    console.log(`  ${report.units.length} outcome(s); ${report.unlinkedOutcomes} unlinked; ${report.inferredLinks} inferred spend link(s)`);
    const show = (label: string, rows: typeof report.byKind): void => {
      console.log(`  By ${label} (self-reported basis)`);
      for (const row of rows) {
        const accepted = row.costPerAcceptedUsd === null ? 'unknown' : usd(row.costPerAcceptedUsd);
        const used = row.costPerUsedUsd === null ? 'unknown' : usd(row.costPerUsedUsd);
        console.log(`    ${row.key}: ${row.outcomes} outcomes, ${row.accepted} accepted, ${row.used} used; cost/accepted ${accepted}; cost/used ${used}; ${row.linked}/${row.outcomes} linked`);
      }
    };
    show('kind', report.byKind);
    show('model', report.byModel);
    console.log('  Coding git outcomes use a separate verified basis and are excluded from these figures.');
  } finally {
    store.close();
  }
}
