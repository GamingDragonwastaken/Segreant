/**
 * The pointer a fresh install needs. With nothing recorded, every figure on
 * Statement and Spend is an honest $0.00, and nothing on those pages said where
 * usage comes in: a reader who picked "I look after the money" landed on four
 * empty claims and no next step (release-gate visual check, 2026-10-18).
 *
 * Shown only when the whole ledger is empty and the data is real. A month or a
 * window with no requests is not a fresh install, sample data has its own
 * banner, and a ledger whose requests retention deleted had usage: Spend's
 * retention warning says so instead (PR #155 review).
 */

import { h } from '../core/dom.ts';
import { signal } from '../core/signal.ts';
import { api } from '../core/api.ts';
import { isPrecise } from '../core/fmt.ts';

export function emptyLedgerNotice(): Node {
  const empty = signal(false);
  // A failed read shows nothing extra: the page's own error already says so.
  void api.overview('all').then((o) => empty.set(o.demo !== true && o.summary.requests === 0
    && o.retention.truncated !== true && !(o.retention.rowsRemoved > 0))).catch(() => undefined);
  return h('div', null, () => (empty()
    ? h('div', { class: 'banner banner-first', role: 'note' },
        h('p', null,
          h('strong', { text: () => (isPrecise() ? 'The ledger has no requests. ' : 'Nothing recorded yet. ') }),
          h('span', { text: () => (isPrecise()
            ? 'Import native tool logs, or route a tool through the proxy, to populate these claims. '
            : 'These figures stay at $0.00 until your usage comes in. Segreant reads what Claude Code, Codex and other tools have already recorded on this machine. ') }),
          h('a', { class: 'banner-link', href: '#/data', text: () => (isPrecise() ? 'Open Data' : 'Bring in your usage') })))
    : null));
}
