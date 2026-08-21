/**
 * Evidence — whether the numbers hold up against the provider bill.
 *
 * This is the surface where Fiscus is most likely to disappoint someone, and it
 * is designed to do that early rather than late. Reconciliation readiness comes
 * BEFORE the pull action, because on a ledger fed by tool-log imports a provider
 * pull reports the entire bill as unexplained residual — and discovering that
 * after minting an admin credential is discovering it too late.
 */

import { h } from '../core/dom.ts';
import { signal, effect } from '../core/signal.ts';
import { api, type BillingPayload } from '../core/api.ts';
import { isPrecise, relative, basisWords, usd, count } from '../core/fmt.ts';
import { actionCard } from './spend.ts';

const STATUS_WORDS: Record<string, { plain: string; precise: string; pill: string }> = {
  not_reconciled: {
    plain: 'Not checked against a provider bill yet.',
    precise: 'not_reconciled — no observation run recorded',
    pill: 'pill-unverified',
  },
  reconciled_with_residual: {
    plain: 'Checked, with an unexplained remainder.',
    precise: 'reconciled_with_residual — residual is an upper bound on off-path spend',
    pill: 'pill-ok',
  },
};

/**
 * What a reconciliation would actually match, stated before the credential.
 *
 * Rendered only when readiness is REPORTED and says nothing would count.
 * Absent readiness renders nothing at all — an older payload without the field
 * must not be turned into a reassurance that everything is fine, and it must
 * not be turned into a warning either. Silence is the honest rendering of "not
 * reported".
 */
function readinessPanel(d: BillingPayload): Node | null {
  const r = d.readiness;
  if (!r) return null;
  const c = r.coverage;
  // No OpenAI spend at all: nothing to warn about, and saying "0 would count"
  // would read as a defect rather than as an empty ledger.
  if (!c) return null;
  const uncountable = c.importedUsd + c.proxyOffScopeUsd;
  if (c.onDeclaredRouteUsd > 0 || uncountable <= 0) return null;

  const lines: Node[] = [];
  if (c.importedUsd > 0) {
    lines.push(h('li', { text: () => (isPrecise()
      ? `${usd(c.importedUsd, { precise: true })} across ${count(c.importedRequests)} request(s) arrived by native import — model and cost recorded, no tie to a declared provider project`
      : `${usd(c.importedUsd)} came from reading your tools' own logs, which do not record which provider project the spend belongs to`) }));
  }
  if (c.proxyOffScopeUsd > 0) {
    lines.push(h('li', { text: () => (isPrecise()
      ? `${usd(c.proxyOffScopeUsd, { precise: true })} across ${count(c.proxyOffScopeRequests)} proxy request(s) predate the declaration or carry a different one`
      : `${usd(c.proxyOffScopeUsd)} went through the proxy before you declared the project, so it cannot be matched either`) }));
  }

  return h('div', { class: 'drawer-warning', style: 'margin-top: var(--s4)' },
    h('strong', { text: 'Read this before getting a credential' }),
    h('p', { text: () => (isPrecise()
      ? `${usd(uncountable, { precise: true })} of local OpenAI spend cannot reconcile. A pull would report the entire provider bill as unexplained residual — arithmetically true and operationally useless.`
      : `None of your ${usd(uncountable)} of OpenAI spend can be checked against a bill yet. Getting a key now would tell you nothing.`) }),
    h('ul', { class: 'drawer-notes' }, ...lines),
    h('p', { style: 'margin-top: var(--s3)', text: () => (isPrecise()
      ? 'Only live proxy traffic carrying the declaration can count. Route traffic through the proxy, let a period close, and the local side will have something in it.'
      : 'Route your tools through Fiscus (fiscus start), let a few days pass, and this becomes checkable.') }));
}

export function evidenceView(): Node {
  const data = signal<BillingPayload | null>(null);
  const error = signal<string | null>(null);

  effect(() => {
    void api.billing()
      .then((payload) => data.set(payload))
      .catch((e: unknown) => error.set(e instanceof Error ? e.message : String(e)));
  });

  return h('div', null,
    h('div', { class: 'view-head' },
      h('h1', { class: 'view-title', text: 'Evidence' }),
      h('p', { class: 'view-plain', text: () => isPrecise()
        ? 'Provider-side billing evidence and its reconciliation against the local ledger, at project-day grain. Status is never "reconciled" — only "reconciled with residual".'
        : 'Everything in Spend is our own measurement. This is where we check it against what your provider actually billed you — and tell you honestly how much of it can be checked at all.' })),

    () => {
      const err = error();
      if (err) return h('div', { class: 'card' }, h('p', { class: 'drawer-error', text: err }));
      const d = data();
      if (!d) return h('div', { class: 'card' }, h('p', { class: 'drawer-muted', text: 'Loading…' }));

      const fallback = { plain: d.evidence.reconciliationStatus, precise: d.evidence.reconciliationStatus, pill: 'pill-unverified' };
      const status = STATUS_WORDS[d.evidence.reconciliationStatus] ?? fallback;
      // Newest recorded run, read from the immutable collection the server
      // sends. This used to read `reconciliation.latest`, a field that has
      // never been on the wire — so it was always null and this screen reported
      // "no check has been run" no matter how many reconciliations existed.
      const latest = d.reconciliation?.runs?.[0] ?? null;

      return h('div', null,
        h('div', { class: 'card' },
          h('div', { class: 'card-head' },
            h('span', { class: 'card-title', text: 'Reconciliation status' }),
            h('span', { class: `pill ${status.pill}`, text: d.evidence.reconciliationStatus.replace(/_/g, ' ') })),
          h('p', { text: () => (isPrecise() ? status.precise : status.plain) }),
          latest
            ? h('div', null,
                h('span', { class: 'basis', text: () => `provider side: ${basisWords(latest.result.providerSourceKind)}` }),
                h('span', { class: 'basis', text: `last run ${relative(latest.computedAtMs)}` }))
            : h('span', { class: 'basis', text: () => (isPrecise()
                ? 'zero recorded observation runs'
                : 'no check has been run on this machine yet') }),
          latest?.result.conditions?.length
            ? h('ul', { class: 'drawer-notes' }, ...latest.result.conditions!.map((c: string) => h('li', { text: c.replace(/_/g, ' ') })))
            : null),

        h('div', { class: 'card', style: 'margin-top: var(--s4)' },
          h('div', { class: 'card-head' }, h('span', { class: 'card-title', text: 'Provider records held' })),
          h('div', { class: 'stat', text: String(d.summary.recordCount) }),
          h('span', { class: 'basis', text: () => (isPrecise()
            ? 'imported provider line items, unverified against the provider'
            : 'billing lines you have given us from your provider') })),

        readinessPanel(d),

        h('div', { style: 'margin-top: var(--s6)' },
          h('h2', { class: 'card-title', style: 'margin-bottom: var(--s3)', text: 'Start here' }),
          h('div', { class: 'actions' },
            actionCard('billing-readiness'),
            actionCard('billing-scope'),
            actionCard('billing-adopt'))),

        h('div', { style: 'margin-top: var(--s5)' },
          h('h2', { class: 'card-title', style: 'margin-bottom: var(--s3)', text: 'Only after readiness says it is worth it' }),
          h('div', { class: 'actions' },
            actionCard('billing-pull'),
            actionCard('billing-reconcile'))),
      );
    });
}
