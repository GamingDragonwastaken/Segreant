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

export function field(id: string, label: string, control: Node): Node {
  return h('div', { class: 'form-field' }, h('label', { for: id, text: label }), control);
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
