/** The four independent financial claims that organize the GUI. */
import { h } from '../core/dom.ts';
import { usd, isPrecise } from '../core/fmt.ts';
import type { Layer, LayerId } from '../core/claimTypes.ts';
export type { Layer, LayerId, ClaimInspection } from '../core/claimTypes.ts';
export interface SpineState { layers: Layer[]; active: LayerId | null; onSelect: (id: LayerId) => void; onInspect: (layer: Layer) => void; }
function separator(): Node { return h('div', { class: 'sep', 'aria-hidden': 'true' }, h('span', { class: 'sep-glyph', text: '≠' })); }
function band(layer: Layer, state: SpineState): Node {
  const active = state.active === layer.id;
  return h('div', { class: `band${active ? ' band-active' : ''}${layer.established ? '' : ' band-open'}` },
    h('button', { class: 'band-hit', 'aria-current': active ? 'page' : false, onclick: () => state.onSelect(layer.id) },
      h('span', { class: 'band-label', text: layer.label }),
      layer.established ? h('span', { class: 'band-value', text: usd(layer.valueUsd) }) : h('span', { class: 'band-value band-unset', text: 'not established' }),
      h('span', { class: 'band-basis', text: layer.basis }),
      !layer.established && layer.nextStep ? h('span', { class: 'band-next', text: layer.nextStep }) : null),
    h('button', { class: 'band-inspect', onclick: () => state.onInspect(layer), text: isPrecise() ? 'inspect claim' : 'why this number?' }));
}
export function spine(state: SpineState): Node {
  const children: Node[] = [];
  state.layers.forEach((layer, i) => { children.push(band(layer, state)); if (state.layers[i + 1]) children.push(separator()); });
  const open = state.layers.filter((l) => !l.established); const missing = open.map((l) => l.label.toLowerCase());
  return h('section', { class: 'spine', 'aria-label': 'The four claims' }, h('div', { class: 'spine-rail' }, ...children),
    h('p', { class: 'spine-read' }, open.length === 0
      ? (isPrecise() ? 'All four claims are substantiated on this machine, each on its own evidence.' : 'All four of these are backed by evidence on this machine.')
      : (isPrecise() ? `Four separate claims with four evidence standards; ${missing.join(' and ')} ${open.length === 1 ? 'is' : 'are'} unsubstantiated here. An unsubstantiated layer is an absence of evidence, never a measured zero.` : `These are four different questions, not four versions of one number — and we cannot answer ${missing.join(' or ')} yet. That is missing evidence, not an answer of nothing.`)));
}
