/**
 * The Claim Inspector — the long form of a band's basis.
 *
 * A spine band states its basis in six words, which is enough to orient and not
 * enough to rely on. The rule this product runs on is that every figure carries
 * its basis; a figure whose basis is a caption satisfies that rule only as far
 * as the caption goes. This is where the rest of it lives: the same claim
 * answered along provenance, scope, freshness, coverage, enforceability and
 * evidence source, with what it assumes and what it is missing named out loud.
 *
 * It is deliberately a VIEWER, not an action. Nothing here writes, previews, or
 * offers a next step it can perform — the drawer owns everything that changes
 * state, and putting a commit in the panel that explains the evidence would put
 * the persuasion and the action in the same box. The only next step shown is
 * the words the layer already carries, unlinked.
 *
 * The overlay mechanics follow `drawer.ts` rather than inventing a second set:
 * one host element, the panel rendered only while a claim is open, focus
 * trapped inside it, Escape and the scrim close it. An always-mounted dialog
 * hidden with CSS is still in the tab order and still read by a screen reader,
 * which for a panel whose entire content is claims about evidence is a worse
 * failure than for most.
 */

import { h, render, captureFocus, restoreFocus, trapFocus, type FocusTarget } from '../core/dom.ts';
import { signal, effect, onCleanup } from '../core/signal.ts';
import { usd, isPrecise } from '../core/fmt.ts';
import type { Layer } from '../core/claimTypes.ts';

const active = signal<Layer | null>(null);
let opener: FocusTarget | null = null;

export function openClaimInspector(layer: Layer): void {
  if (active.peek() === null) opener = captureFocus(document.activeElement as FocusTarget | null);
  active.set(layer);
}

export function closeClaimInspector(): void {
  active.set(null);
  const previous = opener;
  opener = null;
  restoreFocus(previous);
}

function row(label: string, value: string): Node {
  return h('div', { class: 'claim-row' },
    h('dt', { class: 'claim-key', text: label }),
    h('dd', { class: 'claim-val', text: value }));
}

function list(title: string, items: string[], cls: string): Node {
  return h('div', { class: `claim-list ${cls}` },
    h('strong', { text: title }),
    h('ul', null, ...items.map((x) => h('li', { text: x.replace(/_/g, ' ') }))));
}

export function mountClaimInspector(root: HTMLElement): void {
  const host = h('div', { class: 'claim-host' });
  root.appendChild(host);

  effect(() => {
    const layer = active();
    render(host);
    if (!layer) {
      document.body.classList.remove('claim-open');
      return;
    }
    document.body.classList.add('claim-open');
    render(host, panel(layer));
  });
}

function panel(layer: Layer): Node {
  const i = layer.inspection;

  const scrim = h('div', { class: 'claim-scrim', onclick: () => closeClaimInspector() });

  const body = h('aside', {
    class: `claim-panel${layer.established ? '' : ' claim-panel-open'}`,
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': `Evidence for the ${layer.label.toLowerCase()} claim`,
  },
    h('div', { class: 'claim-head' },
      h('span', { class: 'band-label', text: layer.label }),
      h('h2', { class: 'claim-title', text: layer.claim }),
      h('button', { class: 'claim-close', 'aria-label': 'Close', onclick: () => closeClaimInspector() }, '×')),

    // The figure repeats the band exactly, including its refusal to show one.
    // An inspector that quietly resolved "not established" into a number would
    // be the collapse this panel exists to document.
    layer.established
      ? h('div', { class: 'claim-figure', text: usd(layer.valueUsd) })
      : h('div', { class: 'claim-figure claim-unset', text: 'not established' }),

    h('p', { class: 'claim-basis', text: layer.basis }),

    h('dl', { class: 'claim-rows' },
      row(isPrecise() ? 'Provenance' : 'Where it came from', i.provenance),
      row(isPrecise() ? 'Scope' : 'What it covers', i.scope),
      row(isPrecise() ? 'Freshness' : 'When it was computed', i.freshness),
      row(isPrecise() ? 'Coverage' : 'How much it reaches', i.coverage),
      row(isPrecise() ? 'Enforceability' : 'What it can and cannot do', i.enforceability),
      row(isPrecise() ? 'Evidence source' : 'Where to check it', i.evidenceSource)),

    i.assumptions.length
      ? list(isPrecise() ? 'Assumptions and conditions' : 'Taken on trust', i.assumptions, 'claim-assumed')
      : null,

    i.missingEvidence.length
      ? list(isPrecise() ? 'Missing evidence' : 'What we do not have', i.missingEvidence, 'claim-missing')
      : h('p', { class: 'claim-complete', text: isPrecise()
          ? 'No missing evidence is named for this claim.'
          : 'Nothing is missing for this one.' }),

    !layer.established && layer.nextStep
      ? h('p', { class: 'claim-next', text: `Next action: ${layer.nextStep}` })
      : null);

  const release = trapFocus(body as HTMLElement);
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') closeClaimInspector();
  };
  document.addEventListener('keydown', onKey);

  // `onCleanup`, not a nested effect watching for the inspector to close. The
  // panel reads `isPrecise()` while the host effect is running, so the register
  // toggle is one of that effect's dependencies and flipping it rebuilds the
  // panel in place. A teardown that only fired on close would leave one live
  // document listener and one focus trap behind per rebuild; `onCleanup` runs
  // before the NEXT run as well as on disposal, which is the case that matters.
  onCleanup(() => {
    release();
    document.removeEventListener('keydown', onKey);
  });

  // Focus lands on the panel itself, not on the close button — the evidence is
  // the point, and the first thing under the cursor should not be the exit.
  (body as HTMLElement).tabIndex = -1;
  queueMicrotask(() => (body as HTMLElement).focus());

  return h('div', { class: 'claim-wrap' }, scrim, body);
}
