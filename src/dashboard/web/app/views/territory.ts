/**
 * A territory whose surfaces are not built yet.
 *
 * This renders the capabilities that belong here with their real consequence
 * tiers and their commands, and says plainly that the GUI does not do them yet.
 * Saying so is cheaper than a stub that looks finished, and it is the same
 * standard the product applies to its own figures: state the limit where the
 * user meets it.
 */

import { h } from '../core/dom.ts';
import { TERRITORIES, byTerritory, type Territory } from '../core/registry.ts';
import { actionCard } from './spend.ts';

export function territoryView(id: Territory): Node {
  const meta = TERRITORIES.find((t) => t.id === id);
  const caps = byTerritory(id);
  const built = caps.filter((c) => c.coverage === 'full').length;

  return h('div', null,
    h('div', { class: 'view-head' },
      h('h1', { class: 'view-title', text: meta?.label ?? id }),
      h('p', { class: 'view-plain', text: meta?.plain ?? '' })),

    h('div', { class: 'notyet' },
      h('h3', { text: 'These screens are still being built' }),
      h('p', { text: `${built} of ${caps.length} capabilities in this section have a finished screen. Everything listed below already works on the command line today, and the classic dashboard still covers billing, allocation and value.` }),
      h('div', { class: 'cmd-row' },
        h('code', { class: 'cmd', text: 'fiscus help' }),
        h('a', { class: 'cmd-copy', href: '/classic', text: 'Classic view' }))),

    h('div', { style: 'margin-top: var(--s6)' },
      h('h2', { class: 'card-title', style: 'margin-bottom: var(--s3)', text: 'Everything in this section' }),
      h('div', { class: 'actions' }, ...caps.map((c) => actionCard(c.id)))));
}
