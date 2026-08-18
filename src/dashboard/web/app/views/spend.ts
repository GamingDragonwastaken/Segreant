/**
 * Metered — what we observed, and how it splits.
 *
 * The headline figure is not here. It lives in the spine above, beside the three
 * claims it must never be confused with, which is the whole point of putting the
 * spine there. This view answers the next question instead: of that metered
 * spend, where did it go — and it lets the operator pivot the same money across
 * axes rather than reading two fixed tables side by side.
 */

import { h } from '../core/dom.ts';
import { signal, effect } from '../core/signal.ts';
import { api, RANGES, type Overview, type Range, type GroupRow } from '../core/api.ts';
import { usd, count, pct, isPrecise, register } from '../core/fmt.ts';
import { capability } from '../core/registry.ts';
import { openAction } from '../components/drawer.ts';
import { actionSpec, hasRunner } from '../core/actions.ts';

type Axis = 'project' | 'model' | 'source';

const AXES: ReadonlyArray<{ id: Axis; label: string; plain: string; precise: string }> = [
  { id: 'project', label: 'Project', plain: 'which piece of work', precise: 'attribution label — basis varies by row' },
  { id: 'model', label: 'Model', plain: 'which AI model', precise: 'recorded model id' },
  { id: 'source', label: 'Source', plain: 'which tool', precise: 'acquisition route' },
];

export function spendView(): Node {
  const range = signal<Range>('30d');
  const axis = signal<Axis>('project');
  const data = signal<Overview | null>(null);
  const error = signal<string | null>(null);

  effect(() => {
    const r = range();
    error.set(null);
    void api.overview(r)
      .then((payload) => data.set(payload))
      .catch((e: unknown) => error.set(e instanceof Error ? e.message : String(e)));
  });

  return h('div', null,
    h('div', { class: 'view-head' },
      h('div', { class: 'view-head-row' },
        h('h1', { class: 'view-title', text: 'Metered' }),
        h('div', { class: 'rangebar', role: 'group', 'aria-label': 'Time range' },
          ...RANGES.map((r) => h('button', {
            class: 'chip',
            'aria-pressed': () => (range() === r.id ? 'true' : 'false'),
            onclick: () => range.set(r.id),
            text: r.label,
            title: r.plain,
          })))),
      h('p', { class: 'view-plain', text: () => isPrecise()
        ? 'Request volume and cost computed locally from a rate card. Not a provider-billed amount.'
        : 'What we watched AI cost you. This is our own measurement — Billed is where we check it against the real invoice.' })),

    () => {
      const err = error();
      if (err) return h('div', { class: 'card' }, h('p', { class: 'drawer-error', text: err }));

      const d = data();
      if (!d) return h('div', { class: 'card' }, h('p', { class: 'drawer-muted', text: 'Reading the ledger…' }));

      const rows = (axis() === 'project' ? d.byProject : axis() === 'model' ? d.byModel : d.bySource) ?? [];
      const meta = AXES.find((a) => a.id === axis());

      return h('div', null,
        d.demo ? demoBanner() : null,

        h('div', { class: 'axisbar', role: 'group', 'aria-label': 'Break down by' },
          h('span', { class: 'axisbar-label', text: 'Break down by' }),
          ...AXES.map((a) => h('button', {
            class: 'axis',
            'aria-pressed': () => (axis() === a.id ? 'true' : 'false'),
            onclick: () => axis.set(a.id),
            text: a.label,
          })),
          h('span', { class: 'axisbar-note', text: () => (isPrecise() ? meta?.precise ?? '' : meta?.plain ?? '') })),

        ledger(rows, d.summary.costUsd),

        h('section', { class: 'section' },
          h('h2', { class: 'section-title', text: () => (isPrecise() ? 'Actions on this layer' : 'Things you can do with this') }),
          h('div', { class: 'actions' },
            actionCard('export'),
            actionCard('usage'),
            actionCard('report'))));
    });
}

function demoBanner(): Node {
  return h('div', { class: 'banner banner-demo' },
    h('span', { class: 'pill pill-demo', text: 'demo' }),
    h('p', null,
      h('strong', { text: 'Sample data. ' }),
      'None of this was measured from your machine — import your real usage from Data to replace it.'));
}

/**
 * The breakdown, drawn as a ledger rather than a table of numbers: each row
 * carries its own proportion as a rule beneath it, so the shape of the spend is
 * legible before any figure is read. The bar is a proportion of the LARGEST row,
 * not of the total, because the question this answers is "what dominates".
 */
function ledger(rows: GroupRow[], totalUsd: number): Node {
  if (rows.length === 0) {
    return h('div', { class: 'card' }, h('p', { class: 'drawer-muted', text: 'Nothing recorded in this window.' }));
  }

  const sorted = [...rows].sort((a, b) => b.costUsd - a.costUsd);
  const max = sorted[0]?.costUsd ?? 0;
  const total = totalUsd > 0 ? totalUsd : sorted.reduce((s, r) => s + r.costUsd, 0);

  return h('div', { class: 'ledger' },
    h('div', { class: 'ledger-head' },
      h('span', { text: 'Where it went' }),
      h('span', { class: 'num cell-calls', text: () => (isPrecise() ? 'Requests' : 'Calls') }),
      h('span', { class: 'num cell-cost', text: 'Cost' }),
      h('span', { class: 'num cell-share', text: 'Share' })),

    ...sorted.map((row) => h('div', { class: 'ledger-row' },
      h('span', { class: 'ledger-key', text: row.label }),
      h('span', { class: 'num cell-calls', text: count(row.requests) }),
      h('span', { class: 'num cell-cost ledger-cost', text: usd(row.costUsd) }),
      h('span', { class: 'num cell-share', text: total > 0 ? pct(row.costUsd / total, 0) : '—' }),
      h('span', {
        class: 'ledger-bar',
        'aria-hidden': 'true',
        style: `--fill: ${max > 0 ? Math.max(0.5, (row.costUsd / max) * 100) : 0}%`,
      }))));
}

/**
 * Every action opens the drawer, read-only ones included. One path means the
 * consequence, the preview, and the equivalent command are never something a
 * particular button forgot to show.
 */
export function actionCard(id: string): Node | null {
  const cap = capability(id);
  if (!cap) return null;

  return h('button', {
    class: 'action',
    onclick: () => openAction(actionSpec(cap)),
  },
    h('span', { class: 'action-label', text: cap.label }),
    h('span', { class: 'action-plain', text: cap.plain }),
    h('span', { class: 'action-meta' },
      cap.consequence !== 'read'
        ? h('span', { class: `tag tag-${cap.consequence}`, text: cap.consequence })
        : null,
      !hasRunner(cap) ? h('span', { class: 'tag tag-planned', text: 'CLI only' }) : null,
      () => (register() === 'precise' ? h('span', { class: 'tag', text: cap.command.replace(/^fiscus /, '') }) : null)));
}
