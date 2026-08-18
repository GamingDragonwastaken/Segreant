/**
 * GUI shell: identity, navigation, register, and routing.
 *
 * The navigation is organized by what an operator is trying to do — seven
 * territories — not by the forty commands the CLI happens to expose. A GUI that
 * mirrors a command list is a worse CLI with buttons; the command list still
 * lives in core/registry.ts, and System renders it as an auditable parity table.
 */

import { h, render } from './core/dom.ts';
import { signal, effect } from './core/signal.ts';
import { register, setRegister, type Register } from './core/fmt.ts';
import { TERRITORIES, type Territory } from './core/registry.ts';
import { mountDrawer } from './components/drawer.ts';
import { spendView } from './views/spend.ts';
import { evidenceView } from './views/evidence.ts';
import { systemView } from './views/system.ts';
import { territoryView } from './views/territory.ts';

const current = signal<Territory>(readRoute());

function readRoute(): Territory {
  const hash = location.hash.replace(/^#\/?/, '');
  const match = TERRITORIES.find((t) => t.id === hash);
  return match ? match.id : 'spend';
}

window.addEventListener('hashchange', () => current.set(readRoute()));

function go(territory: Territory): void {
  location.hash = `/${territory}`;
  current.set(territory);
}

/** Small inline glyphs. Drawn in the system's own grammar, not an icon font. */
function icon(name: string): Node {
  const paths: Record<string, string> = {
    meter: 'M2 12a6 6 0 0 1 12 0M8 12l3.2-3.6',
    shield: 'M8 1.6 13 3.6v4.2c0 3-2 5.3-5 6.6-3-1.3-5-3.6-5-6.6V3.6z',
    split: 'M8 2v5m0 0-4 3v3m4-6 4 3v3',
    seal: 'M8 1.8 9.7 4l2.7.2-1.4 2.3 1 2.5-2.7.4L8 11.6 6.7 9.4 4 9l1-2.5L3.6 4.2 6.3 4z M5.4 10.6 4.4 14 8 12.6 11.6 14l-1-3.4',
    yield: 'M2.5 13V8m3.7 5V4.5M9.8 13V7M13.5 13V2.6',
    inflow: 'M8 2.4v7.2m0 0L5.2 6.9M8 9.6l2.8-2.7M2.6 12.4h10.8',
    gear: 'M8 5.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8M8 1.6v1.6m0 9.6v1.6M14.4 8h-1.6M3.2 8H1.6m10.9-4.5-1.1 1.1m-5.5 5.5-1.2 1.1m0-7.7 1.2 1.1m5.5 5.5 1.1 1.1',
  };
  return h('svg', { class: 'ico', viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
    h('path', { d: paths[name] ?? paths['gear']! }));
}

function brandMark(): Node {
  return h('svg', { class: 'brand-mark', viewBox: '0 0 30 34', 'aria-hidden': 'true' },
    h('path', { d: 'M15 1 28 6v11c0 8-5.6 13.4-13 16C7.6 30.4 2 25 2 17V6z', fill: 'none', stroke: 'var(--gold)', 'stroke-width': '1.6' }),
    h('path', { d: 'M11 11h8M11 16h6M11 21h4', stroke: 'var(--gold)', 'stroke-width': '1.6', 'stroke-linecap': 'round' }));
}

function firstRun(): Node {
  return h('div', { class: 'firstrun', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'fr-title' },
    h('div', { class: 'firstrun-card' },
      h('h1', { id: 'fr-title', text: 'Welcome to Fiscus' }),
      h('p', { class: 'lede', text: 'Everything here works either way — this only changes how precisely things are worded and how much detail is shown by default. You can switch at any time.' }),
      h('div', { class: 'choice-grid' },
        h('button', { class: 'choice', onclick: () => setRegister('plain') },
          h('strong', { text: 'Plain language' }),
          h('span', { text: 'Rounded figures, concepts explained where they appear, no command line assumed.' })),
        h('button', { class: 'choice', onclick: () => setRegister('precise') },
          h('strong', { text: 'Precise' }),
          h('span', { text: 'Exact microdollar figures, provenance labels shown, equivalent commands surfaced.' }))),
      h('p', { class: 'fine', text: 'Fiscus runs entirely on this machine. This page makes no external requests — no fonts, no analytics, nothing loaded from the internet.' })));
}

function rail(): Node {
  return h('nav', { class: 'rail', 'aria-label': 'Sections' },
    h('div', { class: 'brand' }, brandMark(),
      h('div', { class: 'brand-text' },
        h('div', { class: 'brand-name', text: 'Fiscus' }),
        h('div', { class: 'brand-tag', text: 'AI Financial Ops' }))),

    h('div', { class: 'nav' }, ...TERRITORIES.map((t) =>
      h('button', {
        class: 'nav-item',
        'aria-current': () => (current() === t.id ? 'page' : false),
        title: t.plain,
        onclick: () => go(t.id),
      }, icon(t.icon), h('span', { class: 'nav-label', text: t.label })))),

    h('div', { class: 'rail-foot' },
      h('div', { class: 'register-switch', role: 'group', 'aria-label': 'Detail level' },
        ...(['plain', 'precise'] as Register[]).map((r) =>
          h('button', {
            'aria-pressed': () => (register() === r ? 'true' : 'false'),
            onclick: () => setRegister(r),
            text: r,
          }))),
      h('p', { class: 'rail-note' },
        'Runs on this machine only. ',
        h('a', { href: '/classic', text: 'Classic view' }))));
}

function viewFor(territory: Territory): Node {
  switch (territory) {
    case 'spend': return spendView();
    case 'evidence': return evidenceView();
    case 'system': return systemView();
    default: return territoryView(territory);
  }
}

function boot(): void {
  const root = document.getElementById('app');
  if (!root) throw new Error('missing #app');

  effect(() => {
    if (register() === null) {
      render(root, firstRun());
      return;
    }
    render(root,
      h('a', { class: 'skip', href: '#main', text: 'Skip to content' }),
      h('div', { class: 'shell' },
        rail(),
        h('main', { class: 'main', id: 'main', tabindex: '-1' }, () => viewFor(current()))));
    mountDrawer(root);
  });
}

boot();
