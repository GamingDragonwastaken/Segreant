import { h } from '../core/dom.ts';
import { signal } from '../core/signal.ts';
import { usd, isPrecise } from '../core/fmt.ts';
import type { Layer } from './spine.ts';

const active = signal<Layer | null>(null);
export function openClaimInspector(layer: Layer): void { active.set(layer); }
export function closeClaimInspector(): void { active.set(null); }

function row(label: string, value: string): Node {
  return h('div', { class: 'claim-row' }, h('span', { class: 'claim-key', text: label }), h('span', { class: 'claim-val', text: value }));
}

export function mountClaimInspector(root: HTMLElement): void {
  root.appendChild(h('div', {
    class: () => `claim-inspector${active() ? ' claim-inspector-open' : ''}`,
    'aria-hidden': () => active() ? 'false' : 'true',
  },
    h('button', { class: 'claim-backdrop', 'aria-label': 'Close claim inspector', onclick: closeClaimInspector }),
    () => {
      const layer = active();
      if (!layer) return h('aside', { class: 'claim-panel' });
      const i = layer.inspection;
      return h('aside', { class: 'claim-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': `${layer.label} claim evidence` },
        h('div', { class: 'claim-head' },
          h('div', null, h('span', { class: 'band-label', text: layer.label }), h('h2', { text: layer.claim })),
          h('button', { class: 'claim-close', onclick: closeClaimInspector, 'aria-label': 'Close', text: '×' })),
        h('div', { class: layer.established ? 'claim-figure' : 'claim-figure claim-unset', text: layer.established ? usd(layer.valueUsd) : 'not established' }),
        row(isPrecise() ? 'Basis' : 'What this rests on', layer.basis),
        row('Provenance', i.provenance), row('Scope', i.scope), row('Freshness', i.freshness),
        row('Coverage', i.coverage), row('Enforceability', i.enforceability), row('Evidence source', i.evidenceSource),
        i.assumptions.length ? h('div', { class: 'claim-list' }, h('strong', { text: 'Assumptions / conditions' }), h('ul', null, ...i.assumptions.map((x) => h('li', { text: x })))) : null,
        i.missingEvidence.length ? h('div', { class: 'claim-list claim-missing' }, h('strong', { text: 'Missing evidence' }), h('ul', null, ...i.missingEvidence.map((x) => h('li', { text: x })))) : h('p', { class: 'claim-complete', text: 'No missing evidence is currently named for this claim.' }),
        !layer.established && layer.nextStep ? h('p', { class: 'claim-next', text: `Next action: ${layer.nextStep}` }) : null);
    }));
}
