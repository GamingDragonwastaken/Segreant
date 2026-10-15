/**
 * Statement — one calendar month, as someone who looks after the money reads it.
 *
 * The four claims sit side by side and are never added together: what Segreant
 * measured, what the provider billed, how it was split across cost centres, and
 * what the work produced. Each carries its own basis, and a claim the ledger
 * cannot establish for the month says so and names the page that establishes
 * it, rather than showing a zero.
 *
 * A billed or allocated run is a fact about ITS OWN period. When that period is
 * not exactly the month, its figures are labelled with its dates, never as the
 * month's, and never prorated into it.
 */

import { h } from '../core/dom.ts';
import { signal, scopedEffect } from '../core/signal.ts';
import { api, type StatementPayload, type StatementBilledRun, type StatementAllocatedRun } from '../core/api.ts';
import { isPrecise, usd, usdFromMicros, count, pct, share, date, relative } from '../core/fmt.ts';
import { meteredBasisLine } from '../core/claimLayers.ts';
import { errorText } from '../components/workflow.ts';

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function shiftMonth(key: string, by: number): string {
  const [y, m] = key.split('-').map(Number) as [number, number];
  return monthKey(new Date(y, m - 1 + by, 1));
}

/** A run's own period, with the last day shown inclusively. */
function runPeriod(startMs: number, endMs: number, timeZone?: 'UTC'): string {
  return `${date(startMs, timeZone)} – ${date(endMs - 1, timeZone)}${timeZone ? ' UTC' : ''}`;
}

/**
 * How a run's own period relates to the month. In a month still in progress, a
 * run from the 1st up to when it was recorded is the month so far, which
 * "part of the month only" would misdescribe.
 */
function coverWords(covers: boolean, startMs: number, endMs: number, period: StatementPayload['period'], computedAtMs: number, timeZone?: 'UTC'): string {
  const span = runPeriod(startMs, endMs, timeZone);
  if (covers) return `covers the whole month (${span})`;
  if (!period.complete && startMs <= period.startMs && endMs >= computedAtMs - 3_600_000) return `covers the month so far (${span})`;
  return `covers part of the month only (${span})`;
}

export function statementView(): Node {
  const month = signal(monthKey(new Date()));
  const data = signal<StatementPayload | null>(null);
  const error = signal<string | null>(null);

  scopedEffect(() => {
    const m = month();
    data.set(null);
    error.set(null);
    void api.statement(m).then((p) => data.set(p)).catch((e: unknown) => error.set(errorText(e)));
  });

  const thisMonth = monthKey(new Date());
  // While a month loads, the live label says its name, never the raw key: NVDA
  // read "2026-09" and then "September 2026" (2026-10-15).
  const monthName = (key: string): string => {
    const [y, m] = key.split('-').map(Number);
    return new Date(y!, (m ?? 1) - 1, 1).toLocaleString('en-GB', { month: 'long', year: 'numeric' });
  };
  return h('div', null,
    h('div', { class: 'view-head' },
      h('h1', { class: 'view-title', text: 'Statement' }),
      h('p', { class: 'view-plain', text: () => isPrecise()
        ? 'One calendar month: metered, provider-billed, allocated and realized, each on its own evidence. They answer different questions and are never summed.'
        : 'One month at a glance: what we measured, what your provider billed, how it was split, and what it produced. Four different questions, so the four figures are never added up.' })),

    h('div', { class: 'month-bar', role: 'group', 'aria-label': 'Month' },
      h('button', { class: 'btn-ghost', type: 'button', 'aria-label': 'Previous month', text: '‹', onclick: () => month.set(shiftMonth(month(), -1)) }),
      h('span', { class: 'month-label', 'aria-live': 'polite', text: () => data()?.period.label ?? monthName(month()) }),
      h('button', { class: 'btn-ghost', type: 'button', 'aria-label': 'Next month', text: '›',
        disabled: () => month() >= thisMonth, onclick: () => month.set(shiftMonth(month(), 1)) }),
      h('span', { class: 'month-state', text: () => {
        const d = data();
        if (!d) return '';
        return d.period.complete ? 'month complete' : 'month in progress, figures so far';
      } }),
      // A plain link the browser saves: the same four claims, every project and
      // model, as four sections with no total row.
      h('a', { class: 'statement-download', href: () => api.statementCsvHref(month()), download: '',
        text: () => (isPrecise() ? 'Export CSV' : 'Download as CSV') })),

    () => {
      const err = error();
      if (err) return h('div', { class: 'card' }, h('p', { class: 'drawer-error', role: 'alert', text: err }));
      const d = data();
      if (!d) return h('div', { class: 'card' }, h('p', { class: 'drawer-muted', role: 'status', 'aria-busy': 'true', text: 'Reading the month…' }));
      const names = new Map(d.allocated.costCentres.map((c) => [c.costCentreId, c.name]));
      return h('div', null,
        d.demo ? h('p', { class: 'section-note', role: 'note', text: 'Sample data: these figures were generated, not measured on your machine.' }) : null,
        h('div', { class: 'statement-grid' },
          meteredCard(d),
          billedCard(d),
          allocatedCard(d, (id) => names.get(id) ?? id),
          realizedCard(d)),
        h('p', { class: 'basis statement-rule', text: () => (isPrecise()
          ? 'Not summable: metered is a local estimate, billed is a provider figure compared with it, allocated is a split of the estimate, realized is value. Each card states its own basis.'
          : 'These four are not parts of one total. Each answers its own question, on its own evidence.') }),
        breakdown(d),
        closeLine(d));
    });
}

function card(title: () => string, pill: { text: string; tone: string } | null, ...body: Array<Node | null>): Node {
  return h('div', { class: 'card statement-card' },
    h('div', { class: 'card-head' },
      h('span', { class: 'card-title', text: title }),
      pill ? h('span', { class: `pill ${pill.tone}`, text: pill.text }) : null),
    ...body);
}

function goLink(route: string, text: string): Node {
  return h('a', { class: 'statement-link', href: `#/${route}`, text });
}

function meteredCard(d: StatementPayload): Node {
  const m = d.metered;
  return card(() => (isPrecise() ? 'Metered' : 'What we measured'), { text: 'estimate', tone: 'pill-estimate' },
    h('div', { class: 'stat', text: usd(m.costUsd) }),
    h('span', { class: 'basis', text: `${count(m.requests)} request${m.requests === 1 ? '' : 's'} · ${meteredBasisLine(m.basis)}` }),
    m.retention.truncated
      ? h('p', { class: 'drawer-error', text: `Retention deleted ${count(m.retention.rowsRemoved)} record(s) from this period, so this covers what survived.` })
      : null,
    goLink('spend', 'See where it went'));
}

/** Whether one recorded comparison carries a problem the reader must see. */
function runWarnings(r: StatementBilledRun): string[] {
  const out: string[] = [];
  if (r.snapshotStability === 'changed_across_observations') out.push('The provider reported different figures for the same days. This comparison is conflicted.');
  else if (r.snapshotStability === null) out.push('Provider snapshot stability was not recorded.');
  if (r.offPathBound === 'none_local_estimate_exceeds_provider') out.push('The local estimate exceeds the provider total. This remainder cannot bound spend outside Segreant.');
  else if (r.offPathBound === 'unknown_local_total_truncated_by_retention') out.push('Retention deleted local request rows in this period. This remainder cannot bound spend outside Segreant.');
  else if (r.offPathBound === null) out.push('The remainder bound was not recorded; what it establishes is unknown.');
  return out;
}

/** The conditions a sound comparison still rests on, said once and quietly. */
function runConditions(r: StatementBilledRun): string {
  const parts: string[] = [];
  if (r.snapshotStability === 'stable_across_observations') parts.push('Repeated provider observations agreed.');
  else if (r.snapshotStability === 'single_observation') parts.push('One provider observation, so agreement across observations is not established.');
  if (r.offPathBound === 'upper_bound_conditional') parts.push('The remainder bounds spend outside Segreant only if our pricing did not overstate the cost of requests through Segreant.');
  return parts.join(' ');
}

function billedRunLine(r: StatementBilledRun, period: StatementPayload['period']): Node {
  const conditions = runConditions(r);
  return h('div', { class: 'statement-run', role: 'group', 'aria-label': `Provider comparison for ${r.providerProjectRef ?? 'an unrecorded project'}` },
    h('p', { text: `Provider billed ${usdFromMicros(r.providerReportedMicros)}; we measured ${usdFromMicros(r.localCapturedMicros)}; ${usdFromMicros(r.unexplainedVarianceMicros)} not explained${r.providerReportedMicros > 0 ? ` (${pct(r.unexplainedVarianceMicros / r.providerReportedMicros)})` : ''}.` }),
    ...runWarnings(r).map((w) => h('p', { class: 'drawer-error', text: w })),
    h('span', { class: 'basis', text: `${coverWords(r.coversWholeMonth, r.periodStartMs, r.periodEndMs, period, r.computedAtMs, 'UTC')} · project ${r.providerProjectRef ?? 'not recorded'} · ${r.providerSourceKind === 'operator_supplied_export' ? 'from an export you supplied' : r.providerSourceKind === 'provider_api_pull' ? 'read from the provider' : 'source not recorded'} · recorded ${relative(r.computedAtMs)}` }),
    conditions ? h('span', { class: 'basis', text: conditions }) : null);
}

/**
 * The card's one-word summary. Calendar coverage alone never earns a green
 * pill: a conflicted or unbounded comparison says so even when it spans the
 * whole month.
 */
function billedPill(b: StatementPayload['billed']): { text: string; tone: string } {
  if (b.runs.some((r) => r.snapshotStability === 'changed_across_observations')) return { text: 'conflicted', tone: 'pill-warn' };
  if (b.runs.some((r) => runWarnings(r).length > 0)) return { text: 'compared, limits apply', tone: 'pill-unverified' };
  return b.monthCoverage === 'whole' ? { text: 'compared', tone: 'pill-ok' } : { text: 'partly compared', tone: 'pill-unverified' };
}

function billedCard(d: StatementPayload): Node {
  const b = d.billed;
  if (b.monthCoverage === 'not_established') {
    return card(() => (isPrecise() ? 'Provider-billed' : 'What the provider billed'), { text: 'not established', tone: 'pill-empty' },
      h('p', { class: 'statement-none', text: b.scanComplete
        ? 'No comparison with a provider bill covers this month.'
        : 'No comparison found among the most recent ones; an older one may exist.' }),
      goLink('evidence', 'Close this month'));
  }
  return card(() => (isPrecise() ? 'Provider-billed' : 'What the provider billed'), billedPill(b),
    ...b.runs.slice(0, 3).map((r) => billedRunLine(r, d.period)),
    b.runs.length > 3 ? h('span', { class: 'basis', text: `${b.runs.length - 3} more comparison(s) overlap this month.` }) : null,
    goLink('evidence', 'Open Close'));
}

function allocatedRunLine(r: StatementAllocatedRun, nameOf: (id: string) => string, period: StatementPayload['period']): Node {
  return h('div', { class: 'statement-run' },
    h('ul', { class: 'statement-shares' },
      ...r.byCostCentre.map((c) => h('li', null,
        h('span', { text: nameOf(c.costCentreId) }),
        h('span', { class: 'num', text: `${usdFromMicros(c.allocatedMicros)}${r.totalMicros > 0 ? ` · ${share(c.allocatedMicros / r.totalMicros)}` : ''}` }))),
      r.unallocatedMicros > 0
        ? h('li', { class: 'row-unalloc' }, h('span', { text: 'Not allocated' }), h('span', { class: 'num', text: usdFromMicros(r.unallocatedMicros) }))
        : null),
    h('span', { class: 'basis', text: `a split of ${usdFromMicros(r.totalMicros)} of our estimate · ${coverWords(r.coversWholeMonth, r.periodStartMs, r.periodEndMs, period, r.computedAtMs)} · recorded ${relative(r.computedAtMs)}` }));
}

function allocatedCard(d: StatementPayload, nameOf: (id: string) => string): Node {
  const a = d.allocated;
  if (a.monthCoverage === 'not_established') {
    return card(() => (isPrecise() ? 'Allocated' : 'How it was split'), { text: 'not established', tone: 'pill-empty' },
      h('p', { class: 'statement-none', text: a.scanComplete
        ? 'No recorded split covers this month.'
        : 'No split found among the most recent ones; an older one may exist.' }),
      goLink('allocation', 'Split this month'));
  }
  return card(() => (isPrecise() ? 'Allocated' : 'How it was split'), { text: 'showback only', tone: 'pill-estimate' },
    ...a.runs.slice(0, 2).map((r) => allocatedRunLine(r, nameOf, d.period)),
    a.runs.length > 2 ? h('span', { class: 'basis', text: `${a.runs.length - 2} more split(s) overlap this month.` }) : null,
    goLink('allocation', 'Open Allocate'));
}

function realizedCard(d: StatementPayload): Node {
  return card(() => (isPrecise() ? 'Realized' : 'What it produced'), { text: 'not per month', tone: 'pill-empty' },
    h('p', { class: 'statement-none', text: d.realized.reason }),
    goLink('value', 'Open Value'));
}

function breakdown(d: StatementPayload): Node | null {
  const m = d.metered;
  if (m.byProject.length === 0 && m.byModel.length === 0) return null;
  const table = (label: string, rows: Array<{ label: string; costUsd: number; requests: number }>): Node =>
    h('div', { class: 'table-wrap' },
      h('table', { 'aria-label': label },
        h('thead', null, h('tr', null, h('th', { scope: 'col', text: label }), h('th', { scope: 'col', class: 'num', text: 'Measured' }), h('th', { scope: 'col', class: 'num', text: 'Share' }), h('th', { scope: 'col', class: 'num', text: 'Requests' }))),
        h('tbody', null, ...rows.map((r) => h('tr', null,
          h('td', { class: 'name-cell', text: r.label }),
          h('td', { class: 'num', text: usd(r.costUsd) }),
          h('td', { class: 'num', text: m.costUsd > 0 ? share(r.costUsd / m.costUsd) : '—' }),
          h('td', { class: 'num', text: count(r.requests) }))))));
  return h('section', { class: 'section' },
    h('h2', { class: 'section-title', text: () => (isPrecise() ? 'Metered, by project and model' : 'Where the measured spend went') }),
    h('div', { class: 'grid grid-2' },
      table('Project', m.byProject),
      table('Model', m.byModel)));
}

function closeLine(d: StatementPayload): Node {
  const s = d.close.status;
  const words = s === 'finalized' ? 'This month is finalized in the economic ledger.'
    : s === 'reopened' ? 'This month was finalized, then reopened.'
    : s === 'conflicted' ? 'This month has conflicting finalizations.'
    : 'This month is not finalized in the economic ledger.';
  return h('p', { class: 'basis', style: 'margin-top: var(--s6)', text: () => (isPrecise() ? `period close: ${s}` : words) });
}
