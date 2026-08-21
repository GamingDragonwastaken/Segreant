/**
 * The ledger spine — the primary structure of this GUI, and its thesis.
 *
 *     metered usage != provider-billed cost != allocated cost != realized value
 *
 * Four claims, four evidence standards, and the one idea this product owns. Every
 * other spend tool collapses them into a single confident number; Fiscus refuses
 * to, so the interface should not bury that refusal in a caption under a stat
 * card. It IS the layout.
 *
 * The spine renders the four layers side by side, separated by the inequality
 * itself. Each is established or not on its OWN evidence — reconciliation for
 * billed, recorded rules for allocated, matured outcomes for realized — and an
 * unestablished layer reads "not established", never zero. A zero is a
 * measurement; an absence is not, and they must not look alike.
 *
 * This is also the navigation: the four layers are where the money questions
 * live, so selecting a band is selecting a view.
 */

import { h } from '../core/dom.ts';
import { usd, isPrecise } from '../core/fmt.ts';
import type { Layer, LayerId } from '../core/claimTypes.ts';

/**
 * `Layer` and its evidence moved down to `core/claimTypes.ts` so that
 * `core/claimLayers.ts` can build one without a core module importing a
 * component. They are re-exported here because this is where every consumer
 * already reaches for them, and a type's home is not worth a churn of imports.
 */
export type { Layer, LayerId, ClaimInspection } from '../core/claimTypes.ts';

export interface SpineState {
  layers: Layer[];
  /**
   * The layer being viewed, or null on an operational route (Data, Control,
   * System) that is not a money claim at all. Null matters: defaulting to
   * 'metered' made the spine assert "you are reading the metered claim" while
   * the operator was on the Data screen, which is the same category of untruth
   * as a figure claiming evidence it does not have.
   */
  active: LayerId | null;
  onSelect: (id: LayerId) => void;
}

/**
 * The separator between two layers is the product's own notation, rendered
 * literally: these are four different claims, not four stages of one.
 *
 * An earlier version drew this as a dependency chain with gates that closed when
 * the chain "held". That was wrong and the render proved it — realized value
 * appeared with a substantiated figure two bands after the chain had broken,
 * because realized value does not in fact require allocation. A layout that
 * implies a prerequisite the product does not have is the same class of error as
 * a number that implies evidence it does not have.
 */
function separator(): Node {
  return h('div', { class: 'sep', 'aria-hidden': 'true' }, h('span', { class: 'sep-glyph', text: '≠' }));
}

function band(layer: Layer, state: SpineState): Node {
  const active = state.active === layer.id;

  return h('button', {
    class: `band${active ? ' band-active' : ''}${layer.established ? '' : ' band-open'}`,
    'aria-current': active ? 'page' : false,
    onclick: () => state.onSelect(layer.id),
  },
    h('span', { class: 'band-label', text: layer.label }),

    layer.established
      ? h('span', { class: 'band-value', text: usd(layer.valueUsd) })
      : h('span', { class: 'band-value band-unset', text: 'not established' }),

    h('span', { class: 'band-basis', text: layer.basis }),

    !layer.established && layer.nextStep
      ? h('span', { class: 'band-next', text: layer.nextStep })
      : null);
}

export function spine(state: SpineState): Node {
  const children: Node[] = [];
  state.layers.forEach((layer, i) => {
    children.push(band(layer, state));
    if (state.layers[i + 1]) children.push(separator());
  });

  const open = state.layers.filter((l) => !l.established);
  const missing = open.map((l) => l.label.toLowerCase());

  return h('section', { class: 'spine', 'aria-label': 'The four claims' },
    h('div', { class: 'spine-rail' }, ...children),
    h('p', { class: 'spine-read' },
      open.length === 0
        ? (isPrecise()
            ? 'All four claims are substantiated on this machine, each on its own evidence.'
            : 'All four of these are backed by evidence on this machine.')
        : (isPrecise()
            ? `Four separate claims with four evidence standards; ${missing.join(' and ')} ${open.length === 1 ? 'is' : 'are'} unsubstantiated here. An unsubstantiated layer is an absence of evidence, never a measured zero.`
            : `These are four different questions, not four versions of one number — and we cannot answer ${missing.join(' or ')} yet. That is missing evidence, not an answer of nothing.`)));
}
