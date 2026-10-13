/**
 * The pieces a job page is built from: numbered steps, labelled fields, and one
 * page-level notice for what the server said.
 *
 * Allocate and Close are both jobs done in an order the engine needs, and both
 * preview before they record. They share these so the two pages behave alike:
 * the same step heading (an h2 under the page h1), the same field labelling,
 * and the same notice that survives the reload a save triggers.
 */

import { h } from '../core/dom.ts';
import { signal } from '../core/signal.ts';

/** Report what the server said, in its words, on the page-level notice. */
export type Say = (ok: boolean, text: string) => void;

/**
 * A notice that lives outside a page's data region. A save reloads the payload,
 * which rebuilds every form, and a message held by the form would vanish with it.
 * A confirmation clears itself; a refusal stays until the next action replaces it.
 */
export function pageNotice(): { node: Node; say: Say } {
  const notice = signal<{ ok: boolean; text: string } | null>(null);
  const say: Say = (ok, text) => {
    const shown = { ok, text };
    notice.set(shown);
    if (ok) setTimeout(() => { if (notice() === shown) notice.set(null); }, 6000);
  };
  const node = h('p', {
    class: () => `form-msg page-notice${notice()?.ok === false ? ' drawer-error' : ''}`,
    role: 'status', 'aria-live': 'polite',
    hidden: () => notice() === null,
    text: () => notice()?.text ?? '',
  });
  return { node, say };
}

/**
 * A numbered step. Pass `{ n, done: true }` for a step the ledger already
 * satisfies: its number becomes a check, and screen readers hear "done".
 */
export function step(at: number | { n: number; done: boolean }, title: () => string, lede: () => string, ...body: Array<Node | null>): Node {
  const n = typeof at === 'number' ? at : at.n;
  const done = typeof at === 'number' ? false : at.done;
  return h('section', { class: `section step${done ? ' step-done' : ''}` },
    h('h2', { class: 'step-title' },
      h('span', { class: 'step-n', 'aria-hidden': 'true', text: done ? '✓' : String(n) }),
      h('span', { text: title }),
      done ? h('span', { class: 'sr-only', text: ' (done)' }) : null),
    h('p', { class: 'step-lede', text: lede }),
    ...body);
}

const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])';

function focusKey(el: Element): string {
  return JSON.stringify([el.id, el.tagName, el.getAttribute('aria-label') ?? el.textContent?.trim() ?? '']);
}

function usable(el: Element): el is HTMLElement {
  return el instanceof HTMLElement && !(el as HTMLButtonElement).disabled && el.getClientRects().length > 0;
}

/**
 * Call just before a job page swaps in reloaded data; call the result after.
 *
 * The swap rebuilds the forms, and the control that started the save goes with
 * them, dropping keyboard focus to the top of the document. The returned
 * function puts focus back on the rebuilt equivalent of that control, or, when
 * the save made it disappear, on the first control of the first step still to
 * do. Focus the operator moved elsewhere while the request ran is left alone.
 */
export function holdFocus(root: Element | null): () => void {
  const active = document.activeElement;
  if (!root || !active || !root.contains(active)) return () => {};
  const key = focusKey(active);
  return () => {
    if (active.isConnected || (document.activeElement && document.activeElement !== document.body)) return;
    const candidates = [...root.querySelectorAll(FOCUSABLE)].filter(usable);
    const same = candidates.find((el) => focusKey(el) === key);
    const next = same ?? [...root.querySelectorAll('.step:not(.step-done)')]
      .map((s) => [...s.querySelectorAll(FOCUSABLE)].find(usable))
      .find((el) => el !== undefined);
    (next ?? candidates[0])?.focus();
  };
}

export function field(id: string, label: string, control: Node): Node {
  return h('div', { class: 'form-field' }, h('label', { for: id, text: label }), control);
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
