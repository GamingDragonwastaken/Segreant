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
import {
  claimIsSupported,
  claimIsSupportedButUncosted,
  claimShowsFigure,
  type Layer,
  type LayerId,
} from '../core/claimTypes.ts';

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
  /** Open the long form of this claim's basis. Reads only; never acts. */
  onInspect: (layer: Layer) => void;
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

/**
 * A band carries two distinct actions, so it is a container rather than a
 * control: going to the territory that answers the claim, and inspecting the
 * evidence behind it. The band was a single `<button>` while it had only the
 * first — nesting the second inside it is not an option, because a button
 * inside a button is invalid HTML that browsers resolve by discarding the
 * nesting, which would have silently produced two siblings anyway.
 *
 * The inspect control is a separate, quieter target on purpose. "Why this
 * number?" is the question this product wants asked, but a band whose whole
 * face opened a dialog would make the spine unusable as navigation, which is
 * the job it already had.
 */
/** The value slot's text, named for the situation rather than for a bit. */
function bandValue(layer: Layer): string {
  switch (layer.support.figure) {
    case 'shown':
      return usd(layer.valueUsd);
    case 'withheld_uncosted':
      return isPrecise() ? 'supported; not priced' : 'happened, but not priced';
    case 'not_a_money_claim':
      return isPrecise() ? 'not a money claim' : 'not a dollar figure';
    case 'withheld_unsupported':
      return 'not established';
  }
}

function band(layer: Layer, state: SpineState): Node {
  const active = state.active === layer.id;

  const supported = claimIsSupported(layer);

  return h('div', { class: `band${active ? ' band-active' : ''}${supported ? '' : ' band-open'}` },
    h('button', {
      class: 'band-hit',
      'aria-current': active ? 'page' : false,
      onclick: () => state.onSelect(layer.id),
    },
      h('span', { class: 'band-label', text: layer.label }),

      // Three distinct situations, three different words. `established` said
      // "not established" for all of them, including a Billed band that had
      // been reconciled (no dollar by design, so `usd(null)` rendered a bare
      // em dash) and a Realized band whose units shipped but were never priced.
      h('span', { class: `band-value${claimShowsFigure(layer) ? '' : ' band-unset'}`,
        text: bandValue(layer) }),

      h('span', { class: 'band-basis', text: layer.basis }),

      layer.nextStep
        ? h('span', { class: 'band-next', text: layer.nextStep })
        : null),

    h('button', {
      class: 'band-inspect',
      'aria-label': `Inspect the evidence for the ${layer.label.toLowerCase()} claim`,
      onclick: () => state.onInspect(layer),
      text: () => (isPrecise() ? 'inspect claim' : 'why this number?'),
    }));
}

export function spine(state: SpineState): Node {
  const children: Node[] = [];
  state.layers.forEach((layer, i) => {
    children.push(band(layer, state));
    if (state.layers[i + 1]) children.push(separator());
  });

  // A claim missing its evidence and a claim missing only its pricing input are
  // different sentences. Counting the second as "unsubstantiated" told an
  // operator whose units had shipped that nothing had been established.
  const open = state.layers.filter((l) => !claimIsSupported(l));
  const missing = open.map((l) => l.label.toLowerCase());
  const uncosted = state.layers.filter(claimIsSupportedButUncosted).map((l) => l.label.toLowerCase());

  const uncostedLine = uncosted.length === 0
    ? null
    : h('p', { class: 'spine-read spine-uncosted' }, isPrecise()
        ? `${uncosted.join(' and ')} ${uncosted.length === 1 ? 'is' : 'are'} substantiated but unpriced: the evidence holds and an input needed to state a dollar figure is absent. That is a withheld figure, not an absent claim.`
        : `We can see that ${uncosted.join(' and ')} happened — we just cannot put a number on ${uncosted.length === 1 ? 'it' : 'them'} yet.`);

  return h('section', { class: 'spine', 'aria-label': 'The four claims' },
    h('div', { class: 'spine-rail' }, ...children),
    h('p', { class: 'spine-read' },
      open.length === 0
        ? (isPrecise()
            ? 'All four claims are substantiated on this machine, each on its own evidence.'
            : 'All four of these are backed by evidence on this machine.')
        : (isPrecise()
            ? `Four separate claims with four evidence standards; ${missing.join(' and ')} ${open.length === 1 ? 'is' : 'are'} unsubstantiated here. An unsubstantiated layer is an absence of evidence, never a measured zero.`
            : `These are four different questions, not four versions of one number — and we cannot answer ${missing.join(' or ')} yet. That is missing evidence, not an answer of nothing.`)),
    uncostedLine);
}
