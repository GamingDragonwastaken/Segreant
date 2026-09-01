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
import { signal, scopedEffect } from '../core/signal.ts';
import { api, type BillingPayload } from '../core/api.ts';
import { isPrecise, relative, basisWords, usd, usdFromMicros, count } from '../core/fmt.ts';
import { actionCard } from './spend.ts';

/**
 * The headline of this card, keyed on the BILLED CLAIM's state.
 *
 * It used to be keyed on `evidence.reconciliationStatus`, which `handleBilling`
 * sends as a constant `'not_reconciled'` describing the trust posture of the
 * HELD IMPORTED RECORDS. Rendered under a card titled "Reconciliation status"
 * with the gloss "no observation run recorded", it said that whenever any run
 * existed — the screen contradicted the run it was describing four lines below.
 *
 * That is the same defect as the whole packet: a collapsed status field read as
 * a claim's state. The claim's state is on the wire now, so read that.
 */
const CLAIM_WORDS: Record<string, { plain: string; precise: string; pill: string }> = {
  unknown: {
    plain: 'Not checked against a provider bill yet.',
    precise: 'unknown — no reconciliation run has been recorded',
    pill: 'pill-unverified',
  },
  conflicted: {
    plain: 'Checked — and the check disagrees with itself.',
    precise: 'conflicted — repeated provider observations of the same days disagree',
    pill: 'pill-warn',
  },
  refuted: {
    plain: 'Checked, and the evidence says no.',
    precise: 'refuted — the recorded evidence contradicts the billed claim',
    pill: 'pill-warn',
  },
  supported: {
    plain: 'Checked, with an unexplained remainder.',
    // The unconditional half of this sentence is deliberately gone. D-068
    // established that the residual bounds off-path spend from above only while
    // the local rate-card estimate stays at or under the true on-path billed
    // cost, and a residual below zero refutes that condition outright. The CLI
    // says so beneath the number; this screen said "residual is an upper bound
    // on off-path spend" flatly, for every run, including the ones where it is
    // not one. The condition is now read from the run itself, below.
    precise: 'reconciled_with_residual — a residual, under the conditions recorded with the run',
    pill: 'pill-ok',
  },
};

/**
 * What the recorded residual actually bounds, from the run's own `offPathBound`.
 *
 * Absent means a run written before the field existed. That is not a licence to
 * assume the favourable branch: it says the condition was never recorded, which
 * is the whole reason the field exists.
 */
function residualBoundWords(bound: string | undefined, precise: boolean): string {
  if (bound === 'none_local_estimate_exceeds_provider') {
    return precise
      ? 'residual bounds nothing — the local estimate exceeds the provider total, so no upper bound on off-path spend survives'
      : 'This remainder cannot tell you how much went outside Fiscus: our own estimate already came out higher than the provider’s bill.'
  }
  if (bound === 'upper_bound_conditional') {
    return precise
      ? 'residual is an upper bound on off-path spend while the local estimate does not exceed true on-path billed cost'
      : 'At most this much could have gone outside Fiscus — assuming our own pricing did not overshoot what you were really charged.'
  }
  return precise
    ? 'this run predates the recorded bound condition, so what the residual bounds is not established'
    : 'This run is older than the check that says what the remainder means, so we cannot tell you.'
}

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

/**
 * Explain the exact-record mapping layer on the same Evidence surface as the
 * provider report. Mapping is useful accounting preparation, not provider
 * verification: even a fully mapped import remains excluded from money-
 * consuming controls until a verified provider scope exists.
 */
function mappingPanel(d: BillingPayload): Node | null {
  const m = d.mapping;
  if (!m) return null;
  const eligible = m.reconciliationStatus === 'eligible_for_authoritative_reconciliation';
  const status = m.coverageStatus === 'no_records'
    ? 'no imported records'
    : m.coverageStatus.replace(/_/g, ' ');
  const mapped = usdFromMicros(m.mappedMicros);
  const total = usdFromMicros(m.totalMicros);
  const residual = usdFromMicros(m.residualMicros);
  const statusRows = Object.entries(m.byStatus)
    .filter(([, value]) => value.recordCount > 0)
    .map(([key, value]) => h('li', { text: () => (isPrecise()
      ? `${key}: ${count(value.recordCount)} record(s), ${usdFromMicros(value.amountMicros, { precise: true })}`
      : `${key.replace(/_/g, ' ')}: ${count(value.recordCount)} record(s), ${usdFromMicros(value.amountMicros)}`) }));
  const targetRows = m.targets.slice(0, 8).map((target) => h('li', { text: () => (isPrecise()
    ? `${target.targetAccountRef} / ${target.targetProject}: ${count(target.recordCount)} record(s), ${usdFromMicros(target.amountMicros, { precise: true })}`
    : `${target.targetProject}: ${usdFromMicros(target.amountMicros)} across ${count(target.recordCount)} record(s)`) }));
  if (m.targets.length > 8) {
    targetRows.push(h('li', { class: 'drawer-muted', text: `${count(m.targets.length - 8)} more target(s) hidden` }));
  }
  return h('div', { class: 'card', style: 'margin-top: var(--s4)' },
    h('div', { class: 'card-head' },
      h('span', { class: 'card-title', text: 'Imported-record mapping' }),
      h('span', { class: `pill ${eligible ? 'pill-ok' : 'pill-unverified'}`, text: status })),
    h('p', { text: () => (isPrecise()
      ? `${count(m.mappedRecordCount)} of ${count(m.totalRecordCount)} imported record(s) have an exact operator mapping; ${m.providerScopeAuthority} provider scope keeps reconciliation ${m.reconciliationStatus}.`
      : `${count(m.mappedRecordCount)} of ${count(m.totalRecordCount)} imported records have an exact local target. ${m.reconciliationDetail}.`) }),
    h('div', { class: 'stat' },
      h('span', { text: () => `${mapped} mapped · ${residual} residual` })),
    h('span', { class: 'basis', text: () => (isPrecise()
      ? `total ${total}; mapping trust ${m.mappingTrust}`
      : `of ${total} imported provider evidence; Fiscus does not guess a target`) }),
    statusRows.length > 0
      ? h('ul', { class: 'drawer-notes', style: 'margin-top: var(--s3)' }, ...statusRows)
      : null,
    targetRows.length > 0
      ? h('div', { style: 'margin-top: var(--s3)' },
          h('span', { class: 'basis', text: 'Exact local targets' }),
          h('ul', { class: 'drawer-notes' }, ...targetRows))
      : null,
    h('p', { class: 'basis', style: 'margin-top: var(--s3)', text: () => (m.excludedFrom.length > 0
      ? `Still excluded from: ${m.excludedFrom.join(', ')}.`
      : 'Provider scope authority is present for this payload; review the recorded reconciliation before consuming the result.') }));
}

export function evidenceView(): Node {
  const data = signal<BillingPayload | null>(null);
  const error = signal<string | null>(null);

  scopedEffect(() => {
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
      if (err) return h('div', { class: 'card' }, h('p', { class: 'drawer-error', role: 'alert', 'aria-live': 'assertive', text: err }));
      const d = data();
      if (!d) return h('div', { class: 'card' }, h('p', { class: 'drawer-muted', role: 'status', 'aria-live': 'polite', 'aria-busy': 'true', text: 'Loading…' }));

      // A payload with no stated support is a payload that said nothing, which
      // is `unknown` — not a licence to fall back to the records' label.
      const claimState = d.claimSupport?.epistemic ?? 'unknown';
      const status = CLAIM_WORDS[claimState] ?? CLAIM_WORDS.unknown!;
      // Newest recorded run, read from the immutable collection the server
      // sends. This used to read `reconciliation.latest`, a field that has
      // never been on the wire — so it was always null and this screen reported
      // "no check has been run" no matter how many reconciliations existed.
      const latest = d.reconciliation?.runs?.[0] ?? null;

      return h('div', null,
        h('div', { class: 'card' },
          h('div', { class: 'card-head' },
            h('span', { class: 'card-title', text: 'Reconciliation status' }),
            h('span', { class: `pill ${status.pill}`, text: claimState })),
          h('p', { text: () => (isPrecise() ? status.precise : status.plain) }),
          // The server's own one-line reason, where it has one the payload does
          // not otherwise show. Rendering it beats restating the axes here in
          // different words, which is how two descriptions of one judgement come
          // apart.
          d.claimSupport?.note
            ? h('p', { class: 'basis', text: d.claimSupport.note })
            : null,
          latest
            ? h('div', null,
                // What the residual bounds is a property of THIS run, not of the
                // status word, and it is the sentence an operator acts on.
                h('p', { class: latest.result.offPathBound === 'none_local_estimate_exceeds_provider' ? 'drawer-error' : 'basis',
                  text: () => residualBoundWords(latest.result.offPathBound, isPrecise()) }),
                h('span', { class: 'basis', text: () => `provider side: ${basisWords(latest.result.providerSourceKind)}` }),
                latest.result.snapshotStability === 'changed_across_observations'
                  ? h('span', { class: 'drawer-error', text: () => (isPrecise()
                      ? `snapshot stability: changed across observations on ${(latest.result.unstableDayStartMs ?? []).length} day(s) — this reconciliation is contradicted, not established`
                      : 'Careful: the provider reported different figures for the same days at different times. This check disagrees with itself.') })
                  : null,
                h('span', { class: 'basis', text: `last run ${relative(latest.computedAtMs)}` }),
                // The constant the headline used to be built from, restored to
                // its actual subject: the held import records, not the run.
                h('span', { class: 'basis', text: () => (isPrecise()
                  ? `held provider records: ${d.evidence.reconciliationStatus.replace(/_/g, ' ')}`
                  : 'The provider records themselves are still operator-supplied and unverified.') }))
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
        mappingPanel(d),

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
