/**
 * The ledger spine — the primary structure of this GUI, and its thesis.
 *
 *     metered usage != provider-billed cost != allocated cost != realized value
 *
 * Four claims, four evidence standards, and the one idea this product owns. Every
 * other spend tool collapses them into a single confident number; Segreant refuses
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
  claimIsConflicted,
  claimIsRefuted,
  claimIsSupported,
  claimIsSupportedButUncosted,
  claimIsUnevidenced,
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
  /** Claims whose data has not arrived yet. They draw as "reading…", never as a value. */
  pending?: ReadonlySet<LayerId>;
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
      return isPrecise() ? 'no dollar figure, by design' : 'no dollar figure here';
    case 'withheld_unsupported':
      return isPrecise() ? 'not established' : 'nothing to show yet';
  }
}

/** A shown figure whose money is an estimate rather than metered, billed or allocated. */
function estimated(layer: Layer): boolean {
  return layer.support.figure === 'shown' && layer.support.profile.monetaryBasis === 'estimated';
}

function band(layer: Layer, state: SpineState): Node {
  const active = state.active === layer.id;
  if (state.pending?.has(layer.id)) {
    // Not a value and not an absence: the answer is on its way. Drawn as an
    // open socket with no figure, so nothing here can be read as a zero.
    return h('div', { class: `band band-open band-pending${active ? ' band-active' : ''}`, 'aria-busy': 'true' },
      h('button', {
        class: 'band-hit',
        'aria-current': active ? 'page' : false,
        onclick: () => state.onSelect(layer.id),
      },
        h('span', { class: 'band-label' }, layer.label, h('span', { class: 'band-period', text: ` · ${layer.period}` })),
        h('span', { class: 'band-value band-unset', text: 'reading…' }),
        h('span', { class: 'band-basis', text: layer.id === 'realized'
          ? "measuring what the work produced; the other figures don't wait for it"
          : 'reading the ledger' })));
  }

  const supported = claimIsSupported(layer);

  return h('div', { class: `band${active ? ' band-active' : ''}${supported ? '' : ' band-open'}` },
    h('button', {
      class: 'band-hit',
      'aria-current': active ? 'page' : false,
      onclick: () => state.onSelect(layer.id),
    },
      h('span', { class: 'band-label' }, layer.label, h('span', { class: 'band-period', text: ` · ${layer.period}` })),

      // Three distinct situations, three different words. `established` said
      // "not established" for all of them, including a Billed band that had
      // been reconciled (no dollar by design, so `usd(null)` rendered a bare
      // em dash) and a Realized band whose units shipped but were never priced.
      // An estimated figure must not look like a measured one. Realized carried
      // the largest number on the page at the same size as Metered, so the
      // least-evidenced claim read as the headline (critique 2026-10-12). It
      // keeps its figure, smaller, with the word "estimate" on the band itself.
      estimated(layer)
        ? h('span', { class: 'band-value band-estimate' },
            h('span', { class: 'band-chip', text: () => (isPrecise() ? 'estimate' : 'estimate, not a measurement') }),
            h('span', { text: bandValue(layer) }))
        : h('span', { class: `band-value${claimShowsFigure(layer) ? '' : ' band-unset'}`,
            text: bandValue(layer) }),

      h('span', { class: 'band-basis', text: layer.basis }),

      layer.nextStep
        ? h('span', { class: 'band-next', text: layer.nextStep })
        : null),

    h('button', {
      class: 'band-inspect',
      'aria-label': `How the ${layer.label.toLowerCase()} figure was worked out`,
      onclick: () => state.onInspect(layer),
      text: () => (isPrecise() ? 'show the working' : 'why this number?'),
    }));
}

/** A sentence that opens with a lowercased label still starts with a capital. */
const sentence = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export function spine(state: SpineState): Node {
  const children: Node[] = [];
  state.layers.forEach((layer, i) => {
    children.push(band(layer, state));
    if (state.layers[i + 1]) children.push(separator());
  });

  // A claim missing its evidence and a claim missing only its pricing input are
  // different sentences. Counting the second as "unsubstantiated" told an
  // operator whose units had shipped that nothing had been established.
  //
  // And a claim whose evidence CONTRADICTS ITSELF is a third sentence. The line
  // below ends "an absence of evidence, never a measured zero", which is exactly
  // false about a contradiction — so `unsubstantiated` is now scoped to the
  // claims that really are unevidenced, and the other two states say their own
  // thing. This became reachable when the axes moved to the wire: the browser's
  // count-based inference had no branch that could produce either one.
  // A claim still on its way is neither missing nor answered. Counting it as
  // "cannot answer yet" told the reader Realized had no evidence while it was
  // being measured.
  const arrived = state.layers.filter((l) => !state.pending?.has(l.id));
  const waiting = state.layers.filter((l) => state.pending?.has(l.id)).map((l) => l.label.toLowerCase());
  const missing = arrived.filter(claimIsUnevidenced).map((l) => l.label.toLowerCase());
  const conflicted = arrived.filter(claimIsConflicted).map((l) => l.label.toLowerCase());
  const refuted = arrived.filter(claimIsRefuted).map((l) => l.label.toLowerCase());
  const settled = waiting.length === 0 && arrived.every(claimIsSupported);
  const uncosted = arrived.filter(claimIsSupportedButUncosted).map((l) => l.label.toLowerCase());

  const uncostedLine = uncosted.length === 0
    ? null
    : h('p', { class: 'spine-read spine-uncosted' }, isPrecise()
        ? `${sentence(uncosted.join(' and '))} ${uncosted.length === 1 ? 'is' : 'are'} backed by evidence but not priced: an input needed for a dollar figure is missing, so the figure is held back. The evidence itself stands.`
        : `${sentence(uncosted.join(' and '))} happened, but there isn't enough yet to put a dollar figure on ${uncosted.length === 1 ? 'it' : 'them'}.`);

  const conflictedLine = conflicted.length === 0
    ? null
    : h('p', { class: 'spine-read spine-conflicted' }, isPrecise()
        ? `${sentence(conflicted.join(' and '))} ${conflicted.length === 1 ? 'has' : 'have'} conflicting evidence: two records of the same thing disagree. Nothing is missing, so collecting more won't settle it; the conflict has to be resolved.`
        : `Two sources disagree about ${conflicted.join(' and ')}. That needs sorting out; it isn't missing data.`);

  const refutedLine = refuted.length === 0
    ? null
    : h('p', { class: 'spine-read spine-refuted' }, isPrecise()
        ? `${sentence(refuted.join(' and '))}: the evidence says no. That is a measured answer, the only one of these states that is.`
        : `For ${refuted.join(' and ')}, the evidence says no. That is an answer, not a gap.`);

  return h('section', { class: 'spine', 'aria-label': 'The four figures' },
    h('div', { class: 'spine-rail' }, ...children),
    h('p', { class: 'spine-read' },
      settled
        ? (isPrecise()
            ? 'All four figures are backed by evidence on this machine, each by its own.'
            : 'All four of these are backed by evidence on this machine.')
        : missing.length === 0
          ? (isPrecise()
              ? 'Four separate figures, each needing its own kind of evidence. None is simply missing; the notes below cover the ones still unsettled.'
              : 'These are four different questions, not four versions of one number. None is simply missing; see below.')
          : (isPrecise()
              ? `Four separate figures, each needing its own kind of evidence. ${sentence(missing.join(' and '))} ${missing.length === 1 ? 'has' : 'have'} no evidence here yet, which is not the same as a measured zero.`
              : `These are four different questions, not four versions of one number. ${sentence(missing.join(' and '))}: nothing to show yet, which isn't the same as zero.`)),
    conflictedLine,
    refutedLine,
    uncostedLine,
    waiting.length === 0
      ? null
      : h('p', { class: 'spine-read', 'aria-live': 'polite', text: `Still reading: ${waiting.join(' and ')}.` }));
}
