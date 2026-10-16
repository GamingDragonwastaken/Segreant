/**
 * The Workbench: the Spend page's day-to-day view of where the metered money
 * went, session by session.
 *
 * Every figure here is metered list cost, the same claim as the Metered band
 * above. Outcomes come from the last value read and are filed by the
 * Statement's rule; a session reaches a commit only through its own log.
 * Where the evidence stops (traffic with no session id, a commit never
 * measured, usage a provider never reported) the view says so beside the
 * figure instead of filling it in.
 */

import { h } from '../core/dom.ts';
import { signal, scopedEffect, onCleanup } from '../core/signal.ts';
import { api, type SessionsPayload, type SessionRow, type SessionCommitOutcome } from '../core/api.ts';
import { period } from '../core/period.ts';
import { usd, count, share, isPrecise } from '../core/fmt.ts';

const OTHER = 'other';
/** Rows shown before "Show all". */
const FIRST_ROWS = 12;

const OUTCOME_WORDS: Record<SessionCommitOutcome | 'noCommit', { label: string; plain: string; cls: string }> = {
  kept: { label: 'Kept', plain: 'passed every check you track', cls: 'oc-kept' },
  notKept: { label: 'Not kept', plain: 'a check failed, or a revert names it', cls: 'oc-notkept' },
  contested: { label: 'Results disagree', plain: 'one check both passed and failed', cls: 'oc-contested' },
  unknown: { label: 'No signal', plain: 'old enough, but survival was not measured', cls: 'oc-unknown' },
  maturing: { label: 'Too early to tell', plain: 'the survival check has not come round yet', cls: 'oc-maturing' },
  unmeasured: { label: 'Not measured yet', plain: 'no value read has looked at this commit', cls: 'oc-unmeasured' },
  noCommit: { label: 'No commit linked', plain: 'the session log records no commit', cls: 'oc-none' },
};
/** The table's narrow column takes the short word; the full one is in the title and the detail panel. */
const SHORT_WORDS: Record<SessionCommitOutcome, string> = {
  kept: 'Kept', notKept: 'Not kept', contested: 'Disputed', unknown: 'No signal', maturing: 'Too early', unmeasured: 'Unmeasured',
};
const OUTCOME_ORDER: Array<SessionCommitOutcome | 'noCommit'> = ['kept', 'notKept', 'contested', 'unknown', 'maturing', 'unmeasured', 'noCommit'];

export function workbench(): Node {
  const data = signal<SessionsPayload | null>(null);
  const error = signal<string | null>(null);
  const selected = signal<string | null>(null);
  const focusBucket = signal<number | null>(null);
  const showAll = signal(false);

  scopedEffect(() => {
    const r = period();
    const controller = new AbortController();
    let current = true;
    error.set(null);
    data.set(null);
    showAll.set(false);
    focusBucket.set(null);
    void api.sessions(r, controller.signal)
      .then((payload) => {
        if (!current || controller.signal.aborted) return;
        data.set(payload);
        // Open on the session that cost the most: the first question on this page.
        const top = [...payload.sessions].sort((a, b) => b.costUsd - a.costUsd)[0];
        selected.set(top ? top.sessionId : null);
      })
      .catch((e: unknown) => {
        if (!current || controller.signal.aborted) return;
        error.set(e instanceof Error ? e.message : String(e));
      });
    onCleanup(() => { current = false; controller.abort(); });
  });

  return h('section', { class: 'wb', 'aria-label': 'Workbench' },
    () => {
      const err = error();
      if (err) return h('div', { class: 'card' }, h('p', { class: 'drawer-error', role: 'alert', text: `The session read failed: ${err}` }));
      const d = data();
      if (!d) return h('div', { class: 'card' }, h('p', { class: 'drawer-muted', role: 'status', 'aria-busy': 'true', text: 'Reading sessions…' }));
      if (d.totals.requests === 0) return h('div', { class: 'card' }, h('p', { class: 'drawer-muted', role: 'status', text: 'Nothing was metered in this range.' }));
      const colour = modelColours(d.models);
      return h('div', { class: 'wb-body' },
        tiles(d),
        h('div', { class: 'wb-pair' },
          chart(d, colour, focusBucket, (id) => selected.set(id)),
          outcomes(d)),
        h('div', { class: 'wb-pair wb-pair-sessions' },
          sessionTable(d, colour, selected, showAll),
          () => {
            const s = d.sessions.find((x) => x.sessionId === selected());
            return s ? detail(s, d) : h('aside', { class: 'card wb-detail' }, h('p', { class: 'drawer-muted', text: 'Choose a session to see inside it.' }));
          }));
    });
}

/* ---------- Figures across the top ------------------------------------- */

function tiles(d: SessionsPayload): Node {
  const t = d.totals;
  const sent = t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens;
  const cacheShare = sent > 0 ? t.cacheReadTokens / sent : null;
  const tile = (label: string, value: string, sub: string, cls = ''): Node => h('div', { class: `wb-tile ${cls}` },
    h('span', { class: 'wb-tile-label', text: label }),
    h('span', { class: 'wb-tile-value', text: value }),
    h('span', { class: 'wb-tile-sub', text: sub }));
  return h('div', { class: 'wb-tiles', role: 'group', 'aria-label': 'This range at a glance' },
    tile('List cost', usd(t.costUsd), 'metered, not billed'),
    tile('Requests', count(t.requests), `${count(t.sessions)} session${t.sessions === 1 ? '' : 's'} · ${count(t.tools)} tool${t.tools === 1 ? '' : 's'}`),
    tile('Context sent', tokens(sent), `${tokens(t.outputTokens)} written back`),
    tile('Read from cache', cacheShare === null ? '—' : share(cacheShare), 'of the context sent'),
    tile('Refused or failed', count(t.refusedReplies + t.failedReplies), `${count(t.refusedReplies)} refused (429) · ${count(t.failedReplies)} failed (5xx)`,
      t.refusedReplies + t.failedReplies > 0 ? 'wb-tile-caution' : ''),
    tile('Outside any session', usd(t.unsessionedCostUsd), `${count(t.unsessionedRequests)} requests carry no session id`));
}

/* ---------- Cost over time, by model ----------------------------------- */

function modelColours(models: readonly string[]): (model: string) => string {
  return (model) => {
    const i = models.indexOf(model);
    return model === OTHER || i < 0 ? 'var(--series-other)' : `var(--series-${i + 1})`;
  };
}

/** A round axis top and its steps, so every gridline names a value the scale really reaches. */
export function niceScale(max: number, steps = 4): { top: number; ticks: number[] } {
  if (!(max > 0)) return { top: 1, ticks: [0, 1] };
  const raw = max / steps;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const top = Math.ceil(max / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Number(v.toFixed(10)));
  return { top, ticks };
}

function bucketLabel(ms: number, bucketMs: number): { short: string; long: string } {
  const d = new Date(ms);
  if (bucketMs <= 60 * 60 * 1000) {
    const hh = String(d.getHours()).padStart(2, '0');
    return { short: hh, long: `${hh}:00 to ${String((d.getHours() + 1) % 24).padStart(2, '0')}:00` };
  }
  const day = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  return bucketMs > 24 * 60 * 60 * 1000
    ? { short: d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }), long: `Week from ${day}` }
    : { short: String(d.getDate()), long: day };
}

function chart(
  d: SessionsPayload,
  colour: (m: string) => string,
  focusBucket: { (): number | null; set(v: number | null): void },
  select: (sessionId: string) => void,
): Node {
  const max = d.buckets.reduce((m, b) => Math.max(m, b.costUsd), 0);
  const { top, ticks } = niceScale(max);
  const every = d.buckets.length > 16 ? Math.ceil(d.buckets.length / 10) : 1;
  const unit = d.window.bucketMs <= 60 * 60 * 1000 ? 'hour' : d.window.bucketMs > 24 * 60 * 60 * 1000 ? 'week' : 'day';
  const legendModels = [...d.models, ...(d.buckets.some((b) => b.byModel.some((m) => m.model === OTHER)) ? [OTHER] : [])];
  const modelTotal = (m: string): number => d.buckets.reduce((s, b) => s + (b.byModel.find((x) => x.model === m)?.costUsd ?? 0), 0);

  // The most expensive session that ran in a bucket: what clicking the bar opens.
  const sessionIn = (i: number): SessionRow | undefined => {
    const start = d.buckets[i]!.startMs;
    const end = d.buckets[i + 1]?.startMs ?? d.window.endMs;
    return d.sessions.filter((s) => s.startMs < end && s.endMs >= start).sort((a, b) => b.costUsd - a.costUsd)[0];
  };

  const readout = (): string => {
    const i = focusBucket();
    if (i === null) return `${usd(d.totals.costUsd)} over the range. Point at a ${unit} for its split; choose one to open its costliest session.`;
    const b = d.buckets[i]!;
    const parts = b.byModel.map((m) => `${m.model} ${usd(m.costUsd)}`).join(' · ');
    return `${bucketLabel(b.startMs, d.window.bucketMs).long}: ${usd(b.costUsd)}, ${count(b.requests)} requests${parts ? ` (${parts})` : ''}`;
  };

  return h('div', { class: 'card wb-chart' },
    h('div', { class: 'card-head' },
      h('h2', { class: 'card-title', text: `List cost by ${unit}, by model` })),
    h('div', { class: 'wb-legend' },
      ...legendModels.map((m) => h('span', { class: 'wb-legend-item' },
        h('span', { class: 'wb-swatch', style: `background:${colour(m)}`, 'aria-hidden': 'true' }),
        h('span', { class: 'wb-legend-name', text: m === OTHER ? 'other models' : m }),
        h('span', { class: 'wb-legend-value num', text: usd(modelTotal(m)) })))),
    h('p', { class: 'wb-readout', role: 'status', text: readout }),
    h('div', { class: 'wb-plot' },
      h('div', { class: 'wb-yaxis', 'aria-hidden': 'true' },
        ...ticks.map((v) => h('span', { class: 'wb-ytick', style: `bottom:${(v / top) * 100}%`, text: usd(v) }))),
      h('div', { class: 'wb-bars', style: `--n:${d.buckets.length}` },
        ...ticks.map((v) => h('span', { class: 'wb-grid', style: `bottom:${(v / top) * 100}%`, 'aria-hidden': 'true' })),
        ...d.buckets.map((b, i) => {
          const label = bucketLabel(b.startMs, d.window.bucketMs);
          const target = sessionIn(i);
          return h('button', {
            class: () => `wb-bar${focusBucket() === i ? ' is-focus' : ''}`,
            'aria-label': `${label.long}: ${usd(b.costUsd)}${target ? '. Opens its costliest session' : ''}`,
            disabled: b.costUsd <= 0 && !target ? true : undefined,
            onmouseenter: () => focusBucket.set(i),
            onmouseleave: () => focusBucket.set(null),
            onfocus: () => focusBucket.set(i),
            onblur: () => focusBucket.set(null),
            onclick: () => { if (target) { select(target.sessionId); document.getElementById(rowId(target.sessionId))?.scrollIntoView({ block: 'nearest' }); } },
          },
            h('span', { class: 'wb-stack', style: `height:${top > 0 ? (b.costUsd / top) * 100 : 0}%` },
              ...[...b.byModel].reverse().map((m) => h('span', {
                class: 'wb-seg',
                style: `flex-grow:${m.costUsd};background:${colour(m.model)}`,
              }))),
            h('span', { class: 'wb-xtick', 'aria-hidden': 'true', text: i % every === 0 ? label.short : '' }));
        }))),
    d.totals.unsessionedRequests > 0
      ? h('p', { class: 'basis', text: `The bars include all ${count(d.totals.requests)} requests. ${count(d.totals.unsessionedRequests)} of them (${usd(d.totals.unsessionedCostUsd)}) carry no session id, so they appear in no session below.` })
      : h('p', { class: 'basis', text: 'Local list prices from the rate card. Billed is where this is checked against the invoice.' }));
}

/* ---------- What the session spend came to ----------------------------- */

function outcomes(d: SessionsPayload): Node {
  const o = d.outcomes;
  const parts = OUTCOME_ORDER.map((k) => ({
    k,
    cost: k === 'noCommit' ? o.noCommit.costUsd : o[k].costUsd,
    n: k === 'noCommit' ? o.noCommit.sessions : o[k].commits,
  }));
  const total = parts.reduce((s, p) => s + p.cost, 0);
  return h('div', { class: 'card wb-outcomes' },
    h('div', { class: 'card-head' },
      h('h2', { class: 'card-title', text: 'What the session spend came to' })),
    total > 0
      ? h('div', { class: 'wb-split', 'aria-hidden': 'true' },
          ...parts.filter((p) => p.cost > 0).map((p) => h('span', { class: `wb-split-seg ${OUTCOME_WORDS[p.k].cls}`, style: `flex-grow:${p.cost}` })))
      : null,
    h('div', { class: 'wb-oc-rows' },
      ...parts.filter((p) => p.cost > 0 || p.k === 'kept' || p.k === 'notKept').map((p) => h('div', { class: 'wb-oc-row' },
        h('span', { class: `wb-oc-key ${OUTCOME_WORDS[p.k].cls}` },
          h('span', { class: 'wb-oc-dot', 'aria-hidden': 'true' }),
          h('span', { text: OUTCOME_WORDS[p.k].label })),
        h('span', { class: 'wb-oc-n num', text: p.k === 'noCommit' ? `${count(p.n)} session${p.n === 1 ? '' : 's'}` : `${count(p.n)} commit${p.n === 1 ? '' : 's'}` }),
        h('span', { class: 'wb-oc-cost num', text: usd(p.cost) }),
        h('span', { class: 'wb-oc-share num', text: total > 0 ? share(p.cost / total) : '—' })))),
    h('p', { class: 'basis', text: () => (isPrecise() ? o.basis : `Only sessions are counted here. A session's cost is split evenly across the commits its own log recorded${o.measuredAt === null ? '; no value read has run yet' : ''}. This is cost, not value.`) }));
}

/* ---------- Sessions ---------------------------------------------------- */

function rowId(sessionId: string): string {
  return `wb-row-${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function when(ms: number, bucketMs: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return bucketMs <= 60 * 60 * 1000 ? time : `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`;
}

function duration(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

function sessionTable(
  d: SessionsPayload,
  colour: (m: string) => string,
  selected: { (): string | null; set(v: string | null): void },
  showAll: { (): boolean; set(v: boolean): void },
): Node {
  // One scale for every row's context, so a long session reads as long beside a short one.
  const scaleMax = d.sessions.reduce((m, s) => Math.max(m, s.contextPeakTokens), 0);
  const at = (v: number): number => (scaleMax > 0 ? (v / scaleMax) * 100 : 0);

  const row = (s: SessionRow): Node => {
    const lo = Math.min(s.contextStartTokens, s.contextEndTokens);
    const hi = Math.max(s.contextStartTokens, s.contextEndTokens);
    const measuredContext = s.profile.length > 0;
    return h('tr', {
      id: rowId(s.sessionId),
      class: () => `wb-row${selected() === s.sessionId ? ' is-selected' : ''}`,
      'aria-selected': () => (selected() === s.sessionId ? 'true' : 'false'),
      onclick: () => selected.set(s.sessionId),
    },
      h('td', { class: 'wb-when num' }, h('button', {
        class: 'link-btn wb-open',
        'aria-label': `Open the session that started ${when(s.startMs, d.window.bucketMs)}`,
        onclick: (e: Event) => { e.stopPropagation(); selected.set(s.sessionId); },
      },
        h('span', { class: 'wb-when-day', text: new Date(s.startMs).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) }),
        h('span', { class: 'wb-when-time', text: new Date(s.startMs).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) }))),
      h('td', { class: 'wb-who' },
        h('span', { class: 'wb-tool', text: s.source ?? 'direct' }),
        h('span', { class: 'wb-model' },
          h('span', { class: 'wb-swatch', style: `background:${colour(d.models.includes(s.model) ? s.model : OTHER)}`, 'aria-hidden': 'true' }),
          h('span', { text: s.models > 1 ? `${s.model} +${s.models - 1}` : s.model }))),
      h('td', { class: 'num' },
        h('span', { class: 'wb-req', text: count(s.requests) }),
        s.refusedReplies + s.failedReplies > 0
          ? h('span', { class: 'wb-req-note', text: [s.refusedReplies > 0 ? `${count(s.refusedReplies)} refused` : '', s.failedReplies > 0 ? `${count(s.failedReplies)} failed` : ''].filter(Boolean).join(', ') })
          : null),
      h('td', { class: 'wb-ctx' },
        measuredContext
          ? h('span', { class: 'wb-dumbbell', 'aria-hidden': 'true' },
              h('span', { class: 'wb-db-track' }),
              s.contextPeakTokens > hi ? h('span', { class: 'wb-db-peak', style: `left:${at(s.contextPeakTokens)}%` }) : null,
              h('span', { class: `wb-db-span${s.contextEndTokens < s.contextStartTokens ? ' is-down' : ''}`, style: `left:${at(lo)}%;width:${Math.max(0, at(hi) - at(lo))}%` }),
              h('span', { class: 'wb-db-start', style: `left:${at(s.contextStartTokens)}%` }),
              h('span', { class: 'wb-db-end', style: `left:${at(s.contextEndTokens)}%` }))
          : null,
        h('span', { class: 'wb-ctx-text num', text: measuredContext ? `${tokens(s.contextStartTokens)} → ${tokens(s.contextEndTokens)}` : 'not reported' })),
      h('td', { class: 'num wb-cost', text: usd(s.costUsd) }),
      h('td', { class: 'wb-commits' },
        s.commits.length === 0
          ? h('span', { class: 'wb-none', text: 'no commit' })
          : h('span', { class: 'wb-chips' }, ...s.commits.map((c) => h('span', {
              class: `wb-chip ${OUTCOME_WORDS[c.outcome].cls}`,
              title: `${c.sha.slice(0, 12)} ${c.subject}: ${OUTCOME_WORDS[c.outcome].label}`,
              text: SHORT_WORDS[c.outcome],
            })))));
  };

  return h('div', { class: 'card wb-sessions' },
    h('div', { class: 'card-head' },
      h('h2', { class: 'card-title', text: 'Sessions, newest first' }),
      h('span', { class: 'wb-head-note', text: `${count(d.totals.sessions)} in this range` })),
    h('div', { class: 'table-wrap' },
      h('table', { class: 'wb-table' },
        h('thead', null, h('tr', null,
          h('th', { text: 'Started' }),
          h('th', { text: 'Tool · model' }),
          h('th', { class: 'num', text: 'Requests' }),
          h('th', { text: 'Context, first → last' }),
          h('th', { class: 'num', text: 'List cost' }),
          h('th', { text: 'Outcome' }))),
        h('tbody', null, () => (showAll() ? d.sessions : d.sessions.slice(0, FIRST_ROWS)).map(row)))),
    () => (d.sessions.length > FIRST_ROWS && !showAll()
      ? h('button', { class: 'link-btn wb-more', onclick: () => showAll.set(true), text: `Show all ${count(d.sessions.length)} sessions` })
      : null),
    d.sessionsOmitted > 0
      ? h('p', { class: 'basis', text: `The ${count(d.sessionLimit)} newest are listed; ${count(d.sessionsOmitted)} older sessions are in the totals but not the list.` })
      : null,
    h('p', { class: 'basis', text: 'Context is what each request sent: new input plus cached context read and written. The line runs from the first request to the last, on one scale for every row; a tick marks the peak when it came between.' }));
}

/* ---------- Inside one session ------------------------------------------ */

function detail(s: SessionRow, d: SessionsPayload): Node {
  const sent = s.inputTokens + s.cacheReadTokens + s.cacheWriteTokens;
  const peak = s.profile.reduce((m, v) => Math.max(m, v), 0);
  const marksAt = new Map<number, string>();
  for (const m of s.marks) marksAt.set(m.at, marksAt.has(m.at) && marksAt.get(m.at) !== m.kind ? 'both' : m.kind);
  const fact = (k: string, v: string): Node => h('div', { class: 'wb-fact' }, h('dt', { text: k }), h('dd', { class: 'num', text: v }));

  return h('aside', { class: 'card wb-detail', 'aria-label': 'Inside this session' },
    h('div', { class: 'card-head' },
      h('h2', { class: 'card-title', text: 'Inside this session' }),
      h('span', { class: 'wb-head-note num', text: usd(s.costUsd) })),
    h('p', { class: 'wb-detail-who' },
      h('strong', { text: s.source ?? 'Direct traffic' }),
      ` on ${s.project}, ${when(s.startMs, 0)} for ${duration(s.endMs - s.startMs)}.`),

    s.profile.length > 0
      ? h('div', { class: 'wb-profile-wrap' },
          h('div', { class: 'wb-profile', role: 'img', 'aria-label': `Context per request, rising from ${tokens(s.contextStartTokens)} to ${tokens(s.contextEndTokens)}, peak ${tokens(peak)}` },
            ...s.profile.map((v, i) => h('span', {
              class: `wb-pbar${marksAt.has(i) ? ` has-mark mark-${marksAt.get(i)}` : ''}`,
              style: `height:${peak > 0 ? Math.max(2, (v / peak) * 100) : 0}%`,
              title: `${tokens(v)} tokens of context`,
            }))),
          h('div', { class: 'wb-profile-axis' },
            h('span', { text: `first: ${tokens(s.contextStartTokens)}` }),
            h('span', { text: `peak: ${tokens(peak)}` }),
            h('span', { text: `last: ${tokens(s.contextEndTokens)}` })),
          s.marks.length > 0
            ? h('p', { class: 'wb-profile-key' },
                h('span', { class: 'wb-mark-key mark-refused', 'aria-hidden': 'true' }), ' refused (429)  ',
                h('span', { class: 'wb-mark-key mark-failed', 'aria-hidden': 'true' }), ' failed (5xx), at the request before it')
            : null)
      : h('p', { class: 'drawer-muted', text: 'The tool reported no usage for this session, so its context is not known.' }),

    h('dl', { class: 'wb-facts' },
      fact('Requests', count(s.requests)),
      fact('Context sent', tokens(sent)),
      fact('Read from cache', sent > 0 ? share(s.cacheReadTokens / sent) : '—'),
      fact('Written back', tokens(s.outputTokens)),
      fact('Refused or failed', `${count(s.refusedReplies)} · ${count(s.failedReplies)}`),
      fact('Models', s.models > 1 ? `${count(s.models)}, mostly ${s.model}` : s.model)),

    h('h3', { class: 'wb-sub', text: 'Commits this session made' }),
    s.commits.length === 0
      ? h('p', { class: 'drawer-muted', text: 'None linked. A session is linked to a commit only when its own log records making it.' })
      : h('ul', { class: 'wb-commit-list' }, ...s.commits.map((c) => h('li', { class: 'wb-commit' },
          h('span', { class: 'wb-sha', text: c.sha.slice(0, 10) }),
          h('span', { class: 'wb-subject', text: c.subject }),
          h('span', { class: `wb-chip ${OUTCOME_WORDS[c.outcome].cls}`, text: OUTCOME_WORDS[c.outcome].label }),
          c.checkMs !== null
            ? h('span', { class: 'wb-check', text: `checked ${new Date(c.checkMs).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` })
            : null))),

    h('h3', { class: 'wb-sub', text: 'Worth a look next time' }),
    h('ul', { class: 'wb-hints' }, ...hints(s, d).map((t) => h('li', { text: t }))));
}

/**
 * Plain observations drawn only from this session's own figures. Each names the
 * fact it rests on; none promises a saving the ledger cannot show.
 */
export function hints(s: SessionRow, d: Pick<SessionsPayload, 'outcomes'>): string[] {
  const out: string[] = [];
  const sent = s.inputTokens + s.cacheReadTokens + s.cacheWriteTokens;
  if (s.profile.length > 1 && s.contextEndTokens >= 2 * Math.max(1, s.contextStartTokens) && s.contextEndTokens >= 40_000) {
    out.push(`Context grew from ${tokens(s.contextStartTokens)} to ${tokens(s.contextEndTokens)} a request. Every later request paid to resend it; a fresh session for the next task starts small again.`);
  }
  if (sent > 0 && s.requests >= 4 && s.cacheReadTokens / sent < 0.3) {
    out.push(`Only ${share(s.cacheReadTokens / sent)} of the context came from cache. Cached reads are priced well below new input, and a stable opening prompt is what lets a tool reuse them.`);
  }
  if (s.refusedReplies > 0) out.push(`${count(s.refusedReplies)} request${s.refusedReplies === 1 ? ' was' : 's were'} refused with a 429. If a Segreant cap refused ${s.refusedReplies === 1 ? 'it' : 'them'}, Protect shows which one.`);
  if (s.failedReplies > 0) out.push(`${count(s.failedReplies)} request${s.failedReplies === 1 ? '' : 's'} failed (5xx). A failed request that is retried is paid for twice.`);
  if (s.usageUnknownRequests > 0) out.push(`${count(s.usageUnknownRequests)} request${s.usageUnknownRequests === 1 ? '' : 's'} never reported usage, so this session's cost is a floor.`);
  if (s.commits.length === 0) out.push('No commit is linked. If this session produced work, its tool did not log the commit, so the outcome stays unknown rather than guessed.');
  if (s.commits.some((c) => c.outcome === 'notKept')) out.push('A commit from this session was not kept. Its cost is on the Value page under work that did not last.');
  if (s.commits.some((c) => c.outcome === 'unmeasured') && d.outcomes.measuredAt !== null) out.push('A commit here has not been measured yet. The next value read from the Value page will file it.');
  if (out.length === 0) out.push('Nothing stands out: context stayed level, the cache did its work, and nothing was refused.');
  return out;
}
