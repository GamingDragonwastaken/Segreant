/**
 * System — settings, maintenance, and the parity table.
 *
 * The parity table is not documentation. Fiscus's argument is that an important
 * claim should be inspectable, and "the GUI can do everything the CLI can" is an
 * important claim — so it is rendered from the same registry the rest of the GUI
 * routes through. A capability with no screen says so here, inside the product,
 * rather than in a README nobody opens.
 */

import { h } from '../core/dom.ts';
import { CAPABILITIES, TERRITORIES, paritySummary } from '../core/registry.ts';
import { isPrecise } from '../core/fmt.ts';
import { actionCard } from './spend.ts';

const COVERAGE_WORDS: Record<string, string> = {
  full: 'in the GUI',
  partial: 'partly in the GUI',
  planned: 'command line only',
};

export function systemView(): Node {
  const parity = paritySummary();

  return h('div', null,
    h('div', { class: 'view-head' },
      h('h1', { class: 'view-title', text: 'System' }),
      h('p', { class: 'view-plain', text: () => isPrecise()
        ? 'Local configuration, rate cards, maintenance, and the CLI/GUI parity map rendered from the same registry the GUI routes through.'
        : 'Settings for this machine, plus an honest list of everything Fiscus can do and whether this web interface can do it yet.' })),

    h('div', { class: 'grid' },
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('span', { class: 'card-title', text: 'In the GUI' })),
        h('div', { class: 'stat', text: String(parity.full) }),
        h('span', { class: 'basis', text: `of ${parity.total} capabilities` })),
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('span', { class: 'card-title', text: 'Partly' })),
        h('div', { class: 'stat', text: String(parity.partial) }),
        h('span', { class: 'basis', text: 'usable, with options only on the CLI' })),
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('span', { class: 'card-title', text: 'Command line only' })),
        h('div', { class: 'stat', text: String(parity.planned) }),
        h('span', { class: 'basis', text: 'no screen yet — the command is listed' }))),

    h('div', { class: 'card', style: 'margin-top: var(--s4)' },
      h('div', { class: 'card-head' }, h('span', { class: 'card-title', text: 'Parity map' })),
      h('p', { class: 'view-plain', style: 'margin-bottom: var(--s4)', text: 'Every capability Fiscus has, where it lives, what it costs you to run it, and whether this interface covers it. Generated from the same registry the navigation uses, so it cannot drift from what the GUI actually does.' }),
      h('div', { class: 'table-wrap' },
        h('table', null,
          h('thead', null, h('tr', null,
            h('th', { text: 'Capability' }),
            h('th', { text: 'Section' }),
            h('th', { text: 'Consequence' }),
            h('th', { text: 'Here' }),
            h('th', { text: 'Gap / safe alternative' }),
            h('th', { text: 'Command' }))),
          h('tbody', null, ...CAPABILITIES.map((c) => h('tr', null,
            h('td', null, h('strong', { text: c.label }), h('br'), h('span', { class: 'action-plain', text: c.plain })),
            h('td', { text: TERRITORIES.find((t) => t.id === c.territory)?.label ?? c.territory }),
            h('td', null, h('span', { class: `tag tag-${c.consequence}`, text: c.consequence === 'read' ? 'reads only' : c.consequence })),
            h('td', null, h('span', { class: c.coverage === 'planned' ? 'tag tag-planned' : 'tag', text: COVERAGE_WORDS[c.coverage] ?? c.coverage })),
            h('td', null, c.coverage === 'full' ? h('span', { class: 'action-plain', text: '—' }) : h('span', { class: 'action-plain', text: `${c.gapReason ?? 'gap not described'} Safe alternative: ${c.safeAlternative ?? c.command}` })),
            h('td', null, h('code', { class: 'cmd', style: 'white-space: nowrap', text: c.command })))))))),

    h('div', { style: 'margin-top: var(--s6)' },
      h('h2', { class: 'card-title', style: 'margin-bottom: var(--s3)', text: 'Maintenance' }),
      h('div', { class: 'actions' },
        actionCard('settings'),
        actionCard('pricing'),
        actionCard('doctor'),
        actionCard('clear-proposals'),
        actionCard('prune'))));
}
