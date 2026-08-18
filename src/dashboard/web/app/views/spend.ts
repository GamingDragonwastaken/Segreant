/**
 * Spend — what AI cost, and where it went.
 *
 * The first figure on the page is metered local spend, and it says so on the
 * line beneath it. That placement is the product's whole argument: the number
 * and the basis for the number arrive together, so nobody has to go looking for
 * the caveat after they have already quoted the figure.
 */

import { h } from '../core/dom.ts';
import { signal, effect } from '../core/signal.ts';
import { api, RANGES, type Overview, type Range, type GroupRow } from '../core/api.ts';
import { usd, count, pct, isPrecise, register } from '../core/fmt.ts';
import { capability } from '../core/registry.ts';
import { openAction } from '../components/drawer.ts';
import { actionSpec, hasRunner } from '../core/actions.ts';

export function spendView(): Node {
  const range = signal<Range>('7d');
  const data = signal<Overview | null>(null);
  const error = signal<string | null>(null);
  const loading = signal(true);

  effect(() => {
    const r = range();
    loading.set(true);
    error.set(null);
    void api.overview(r)
      .then((payload) => data.set(payload))
      .catch((e: unknown) => error.set(e instanceof Error ? e.message : String(e)))
      .finally(() => loading.set(false));
  });

  return h('div', null,
    h('div', { class: 'view-head' },
      h('h1', { class: 'view-title', text: 'Spend' }),
      h('p', { class: 'view-plain', text: () => isPrecise()
        ? 'Metered request volume and locally-computed cost across the selected window. Rate-card estimates, not provider-billed amounts.'
        : 'What AI has cost you, and where it went. These are our own measurements — the Evidence section checks them against your provider bill.' }),
      h('div', { class: 'rangebar', role: 'group', 'aria-label': 'Time range' },
        ...RANGES.map((r) => h('button', {
          class: 'chip',
          'aria-pressed': () => (range() === r.id ? 'true' : 'false'),
          onclick: () => range.set(r.id),
          text: () => (isPrecise() ? r.label : `${r.label}`),
          title: r.plain,
        })))),

    () => {
      const err = error();
      if (err) return h('div', { class: 'card' }, h('p', { class: 'drawer-error', text: err }));

      const d = data();
      if (!d) return h('div', { class: 'card' }, h('p', { class: 'drawer-muted', text: 'Loading…' }));

      const estimateShare = d.pricing?.estimatedSpendShare ?? 0;

      return h('div', null,
        d.demo ? demoBanner() : null,

        h('div', { class: 'grid' },
          statCard(
            isPrecise() ? 'Metered cost' : 'Spent',
            usd(d.summary.costUsd),
            isPrecise()
              ? `local rate-card computation · ${pct(estimateShare, 0)} of it estimated`
              : estimateShare > 0.001
                ? `${pct(estimateShare, 0)} of this is estimated from a price list, not a bill`
                : 'measured from metered requests',
          ),
          statCard(
            isPrecise() ? 'Requests' : 'AI calls',
            count(d.summary.requests),
            isPrecise() ? 'rows in the local ledger' : 'individual requests we saw',
          ),
          statCard(
            isPrecise() ? 'Distinct models' : 'Models used',
            count(d.byModel?.length ?? 0),
            isPrecise() ? 'grouped by recorded model id' : 'different AI models in this window',
          ),
        ),

        h('div', { class: 'grid-2', style: 'margin-top: var(--s4)' },
          breakdownCard(isPrecise() ? 'By project' : 'Where it went', d.byProject ?? [], 'project'),
          breakdownCard(isPrecise() ? 'By model' : 'Which models', d.byModel ?? [], 'model'),
        ),

        h('div', { style: 'margin-top: var(--s6)' },
          h('h2', { class: 'card-title', style: 'margin-bottom: var(--s3)', text: 'Things you can do here' }),
          h('div', { class: 'actions' },
            actionCard('export'),
            actionCard('usage'),
            actionCard('report'))),
      );
    });
}

function demoBanner(): Node {
  return h('div', { class: 'banner banner-demo' },
    h('span', { class: 'pill pill-demo', text: 'demo' }),
    h('p', null,
      h('strong', { text: 'This is sample data. ' }),
      'Nothing here was measured from your machine. Import your real usage from the Data section to replace it.'));
}

function statCard(title: string, value: string, basis: string): Node {
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('span', { class: 'card-title', text: title })),
    h('div', { class: 'stat', text: value }),
    h('span', { class: 'basis', text: basis }));
}

function breakdownCard(title: string, rows: GroupRow[], kind: 'project' | 'model'): Node {
  const label = (row: GroupRow): string =>
    row.project ?? row.model ?? row.name ?? row.key ?? row.source ?? '—';

  const top = [...rows].sort((a, b) => b.costUsd - a.costUsd).slice(0, 8);
  const total = rows.reduce((sum, r) => sum + r.costUsd, 0);

  return h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('span', { class: 'card-title', text: title }),
      h('span', { class: 'card-title', text: `${rows.length}` })),
    top.length === 0
      ? h('p', { class: 'drawer-muted', text: 'Nothing recorded in this window.' })
      : h('div', { class: 'table-wrap' },
          h('table', null,
            h('thead', null, h('tr', null,
              h('th', { text: kind === 'project' ? 'Project' : 'Model' }),
              h('th', { class: 'num', text: isPrecise() ? 'Requests' : 'Calls' }),
              h('th', { class: 'num', text: 'Cost' }),
              h('th', { class: 'num', text: 'Share' }))),
            h('tbody', null, ...top.map((row) => h('tr', null,
              h('td', { text: label(row) }),
              h('td', { class: 'num', text: count(row.requests) }),
              h('td', { class: 'num', text: usd(row.costUsd) }),
              h('td', { class: 'num', text: total > 0 ? pct(row.costUsd / total, 0) : '—' })))))));
}

/**
 * Every action goes through the drawer, including the read-only ones. A single
 * path means the equivalent command, the consequence, and the preview are never
 * something a particular button forgot to show.
 */
export function actionCard(id: string): Node | null {
  const cap = capability(id);
  if (!cap) return null;

  // Even an unbuilt capability opens its drawer. The drawer is where the
  // consequence, the preview and the command live, so a card that refused to
  // open would hide the one thing the operator needs: what this would do, and
  // how to do it in the meantime.
  return h('button', {
    class: 'action',
    onclick: () => openAction(actionSpec(cap)),
  },
    h('span', { class: 'action-label', text: cap.label }),
    h('span', { class: 'action-plain', text: cap.plain }),
    h('span', { class: 'action-meta' },
      h('span', { class: `tag tag-${cap.consequence}`, text: cap.consequence === 'read' ? 'reads only' : cap.consequence }),
      !hasRunner(cap) ? h('span', { class: 'tag tag-planned', text: 'command line only' }) : null,
      () => (register() === 'precise' ? h('span', { class: 'tag', text: cap.command.replace(/^fiscus /, '') }) : null)));
}
