/**
 * Evidence — whether the numbers hold up against the provider bill.
 *
 * This is the surface where Segreant is most likely to disappoint someone, and it
 * is designed to do that early rather than late. Reconciliation readiness comes
 * BEFORE the pull action, because on a ledger fed by tool-log imports a provider
 * pull reports the entire bill as unexplained residual — and discovering that
 * after minting an admin credential is discovering it too late.
 */

import { h } from '../core/dom.ts';
import { signal, scopedEffect } from '../core/signal.ts';
import { api, type BillingPayload, type KernelNodePayload, type BillingImportSummary, type BillingImportPreviewPayload, type BillingAdoptionPlanPayload, type BillingReconcileResultPayload } from '../core/api.ts';
import { isPrecise, relative, basisWords, usd, usdFromMicros, count, date, pct } from '../core/fmt.ts';
import { pageNotice, step, field, errorText, type Say, holdFocus } from '../components/workflow.ts';
import { actionCard } from './spend.ts';
import { projectRenderedAxes } from '../core/claimTypes.ts';

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
type ResidualBound = NonNullable<
  NonNullable<NonNullable<BillingPayload['reconciliation']>['runs']>[number]['result']['offPathBound']
>;

/**
 * A `Record` rather than an if-chain, keyed by the wire's own union.
 *
 * That is the gate: adding a state to `offPathBound` in `shared-types.ts`
 * without a rendering here fails the BROWSER typecheck. With an if-chain the
 * new state fell through to the "older than the check" sentence below, which
 * would have said a fresh run predates a field it carries — an unrecognised
 * value rendered as an absent one, which is the defect class this screen keeps
 * finding.
 */
const RESIDUAL_BOUND_WORDS: Readonly<Record<ResidualBound, { precise: string; plain: string }>> = {
  none_local_estimate_exceeds_provider: {
    precise: 'residual bounds nothing — the local estimate exceeds the provider total, so no upper bound on off-path spend survives',
    plain: 'This remainder cannot tell you how much went outside Segreant: our own estimate already came out higher than the provider’s bill.',
  },
  upper_bound_conditional: {
    precise: 'residual is an upper bound on off-path spend while the local estimate does not exceed true on-path billed cost',
    plain: 'At most this much could have gone outside Segreant — assuming our own pricing did not overshoot what you were really charged.',
  },
  unknown_local_total_truncated_by_retention: {
    precise: 'residual bounds nothing — retention deleted request rows from inside this period, so the local total is a known undercount by an unknown amount',
    plain: 'This remainder cannot tell you how much went outside Segreant: some of your own metered requests in this period were deleted by your retention setting, so part of the difference is traffic we did see.',
  },
};

/** Whether the run's own bound state is bad news rather than a caveat. */
function residualBoundIsError(bound: string | undefined): boolean {
  return bound === 'none_local_estimate_exceeds_provider'
    || bound === 'unknown_local_total_truncated_by_retention';
}

function residualBoundWords(bound: string | undefined, precise: boolean): string {
  const words = bound === undefined ? undefined : RESIDUAL_BOUND_WORDS[bound as ResidualBound];
  if (words === undefined) {
    return precise
      ? 'this run predates the recorded bound condition, so what the residual bounds is not established'
      : 'This run is older than the check that explains the remainder, so there is nothing to show for it.'
  }
  return precise ? words.precise : words.plain;
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
/**
 * The kernel viewer (D-257, WP-I01): the billing claims the server has issued
 * to the epistemic kernel, and for any one of them — or any node id typed in —
 * the node as the ledger holds it: its record, what it rests on, what rests on
 * it, the derivations and assumptions behind it, and whether revocation
 * reaches it. An as-of boundary replays the ledger to that instant, so the
 * answer is what was known then, not what is known now. A viewer only: nothing
 * here writes, and a billing evidence payload is withheld with its hash shown.
 */
function kernelPanel(d: BillingPayload): Node | null {
  const claims = [...(d.kernel?.claims ?? []), ...(d.kernel?.observedClaims ?? []), ...(d.kernel?.reconciliationClaims ?? [])];
  const nodeId = signal<string>(claims[0]?.id ?? '');
  const asOf = signal<string>(d.asOf ?? '');
  const view = signal<KernelNodePayload | null>(null);
  const failure = signal<string | null>(null);
  const load = (): void => {
    const id = nodeId().trim();
    if (!id) return;
    failure.set(null);
    void api.kernel(id, asOf().trim() || undefined)
      .then((payload) => view.set(payload))
      .catch((e: unknown) => failure.set(e instanceof Error ? e.message : String(e)));
  };
  type Edge = KernelNodePayload['restsOn'][number];
  const edgeList = (title: string, edges: Edge[], pick: (edge: Edge) => string): Node =>
    h('div', { class: 'kernel-edges' },
      h('h3', { class: 'drawer-h3', text: title + ' (' + edges.length + ')' }),
      edges.length === 0
        ? h('p', { class: 'drawer-muted', text: 'none recorded' })
        : h('ul', { class: 'kernel-edge-list' }, ...edges.map((edge) => h('li', null,
            h('span', { class: 'tag', text: edge.relation }), ' ',
            h('button', { class: 'kernel-link', type: 'button', onclick: () => { nodeId.set(pick(edge)); load(); }, text: pick(edge) })))));
  return h('div', { class: 'card', style: 'margin-top: var(--s5)' },
    h('div', { class: 'card-head' },
      h('h2', { class: 'card-title', text: () => (isPrecise() ? 'Kernel viewer' : 'What the ledger actually holds') }),
      h('span', { class: 'tag tag-read', text: 'reads only' })),
    h('p', { class: 'drawer-muted', text: () => (isPrecise()
      ? claims.length + ' billing claim(s) issued to the kernel. Open a node to see its record, the edges into and out of it, the derivations and assumptions behind it, and whether revocation reaches it — live, or as of an instant.'
      : claims.length + ' billing claim(s) have been written to the evidence ledger. Pick one to see exactly what it rests on and whether anything has since withdrawn it.') }),
    h('div', { class: 'kernel-controls' },
      h('label', { class: 'drawer-h3', for: 'kernel-node-id', text: 'Node id' }),
      claims.length > 0
        ? h('select', { id: 'kernel-node-select', class: 'drawer-input', 'aria-label': 'Issued billing claims', onchange: (event: Event) => { nodeId.set((event.target as HTMLSelectElement).value); load(); } },
            ...claims.map((claim) => h('option', { value: claim.id, text: claim.id })))
        : null,
      h('input', { id: 'kernel-node-id', class: 'drawer-input', type: 'text', autocomplete: 'off', spellcheck: 'false', value: () => nodeId(), placeholder: 'claim:… or evidence:…',
        oninput: (event: Event) => nodeId.set((event.target as HTMLInputElement).value) }),
      h('label', { class: 'drawer-h3', for: 'kernel-as-of', text: 'As of (UTC instant, blank = live)' }),
      h('input', { id: 'kernel-as-of', class: 'drawer-input', type: 'text', autocomplete: 'off', spellcheck: 'false', value: () => asOf(), placeholder: '2026-09-19T00:00:00.000Z',
        oninput: (event: Event) => asOf.set((event.target as HTMLInputElement).value) }),
      h('button', { class: 'btn-ghost', type: 'button', onclick: load, text: 'Open node' })),
    () => {
      const err = failure();
      if (err) return h('p', { class: 'drawer-error', role: 'alert', text: err });
      const v = view();
      if (!v) return h('p', { class: 'drawer-muted', role: 'status', text: 'No node opened yet.' });
      if (!v.found) {
        return h('p', { class: 'drawer-muted', role: 'status', text: v.asOf
          ? v.id + ' was not in the ledger as of ' + v.asOf + ' — it either never existed or was not yet available; the ledger held ' + v.graphSize.nodes + ' node(s) then.'
          : v.id + ' is not in the ledger (' + v.graphSize.nodes + ' node(s) held).' });
      }
      const node = v.node!;
      const record = v.record as { kind?: string; evidence?: { payloadWithheld?: boolean; payloadDigest?: string | null } } | null;
      const row = (key: string, value: string): Node =>
        h('div', { class: 'claim-profile-row' }, h('dt', { class: 'claim-key', text: key }), h('dd', { class: 'claim-val', text: value }));
      return h('div', { class: 'kernel-node' },
        h('dl', { class: 'claim-profile-rows' },
          row('node', node.id + ' · ' + node.kind),
          row('available at', node.availableAt),
          row('epistemic', node.epistemic),
          row('revoked', v.revoked ? 'yes — the revocation projection reaches this node' + (v.asOf ? ' as of ' + v.asOf : '') : 'no'),
          row('boundary', v.asOf ? 'as of ' + v.asOf + ' (' + v.graphSize.nodes + ' nodes, ' + v.graphSize.edges + ' edges then)' : 'live (' + v.graphSize.nodes + ' nodes, ' + v.graphSize.edges + ' edges)')),
        edgeList('Rests on', v.restsOn, (edge) => edge.from),
        edgeList('Supports', v.supports, (edge) => edge.to),
        h('div', { class: 'kernel-edges' },
          h('h3', { class: 'drawer-h3', text: 'Derivations (' + v.derivations.length + ')' }),
          v.derivations.length === 0
            ? h('p', { class: 'drawer-muted', text: node.kind === 'claim' ? 'a direct claim: no derivation produced it' : 'not a claim' })
            : h('ul', { class: 'kernel-edge-list' }, ...v.derivations.map((der) => h('li', null,
                h('code', { text: der.id }), ' — ' + der.transformation + '; from ' + der.inputClaimIds.length + ' claim(s), ' + der.inputEvidenceIds.length + ' evidence, ' + der.witnessIds.length + ' witness(es)')))),
        h('div', { class: 'kernel-edges' },
          h('h3', { class: 'drawer-h3', text: 'Assumptions (' + v.assumptions.length + ')' }),
          v.assumptions.length === 0
            ? h('p', { class: 'drawer-muted', text: 'none stated on a derivation behind this node' })
            : h('ul', { class: 'kernel-edge-list' }, ...v.assumptions.map((a) => h('li', { text: a })))),
        h('div', { class: 'kernel-edges' },
          h('h3', { class: 'drawer-h3', text: 'Record' }),
          record?.kind === 'evidence' && record.evidence?.payloadWithheld
            ? h('p', { class: 'drawer-muted', text: 'billing evidence payload withheld — operator-supplied exports can be confidential; canonical payload digest ' + (record.evidence.payloadDigest ?? 'not recorded') })
            : null,
          h('pre', { class: 'kernel-record', text: record ? JSON.stringify(record, null, 2) : 'no record body is stored for this node kind' })));
    });
}

function readinessPanel(d: BillingPayload): Node | null {
  const r = d.readiness;
  if (!r) return null;
  const c = r.coverage;
  // A deletion reaches this screen as `coverage === null`, exactly like a
  // machine that never metered OpenAI -- and the null used to be rendered as
  // silence on the strength of a comment that read "no OpenAI spend at all:
  // nothing to warn about". That silence is the whole panel, so a prune turned
  // the credential warning OFF (D-186). An emptied ledger says so instead.
  const truncated = r.localLedgerRetention?.truncated === true;
  if (!c) {
    if (!truncated) return null;
    const before = r.localLedgerRetention.prunedBeforeMs;
    const boundary = typeof before === 'number' && Number.isFinite(before) && before > 0 && before <= 8.64e15
      ? new Date(before).toISOString().slice(0, 10) : 'an unrecorded boundary';
    return h('div', { class: 'drawer-warning', style: 'margin-top: var(--s4)' },
      h('strong', { text: 'This ledger was emptied by retention' }),
      h('p', { text: () => (isPrecise()
        ? `No OpenAI rows survive, and retention deleted rows before ${boundary}. Whether any OpenAI spend was metered here cannot be read from the ledger, so nothing about what a reconciliation would match is stated.`
        : `Your older records were deleted, so there is no OpenAI spend left here to check. There's no record of whether there ever was any, only that it is gone.`) }));
  }
  const uncountable = c.importedUsd + c.proxyOffScopeUsd;
  if (c.onDeclaredRouteUsd > 0 || uncountable <= 0) return null;

  const lines: Node[] = [];
  if (c.importedUsd > 0) {
    lines.push(h('li', { text: () => (isPrecise()
      ? `${usd(c.importedUsd, { precise: true })} across ${count(c.importedRequests)} request(s) arrived by native import — model and cost recorded, no tie to a declared provider project`
      : `${usd(c.importedUsd)} came from reading your tools' own logs, which do not record which provider project the spend belongs to`) }));
  }
  if (c.proxyOffScopeUsd > 0 && c.declaredScopeId === null) {
    // Right verdict, wrong reason if left unbranched: no scope is active, so
    // nothing CAN be on a declared route, and that is not a fact about these
    // rows (D-187).
    lines.push(h('li', { text: () => (isPrecise()
      ? `${usd(c.proxyOffScopeUsd, { precise: true })} across ${count(c.proxyOffScopeRequests)} proxy request(s) were metered while no scope is active — nothing can be on a declared route until one is`
      : `${usd(c.proxyOffScopeUsd)} went through the proxy, but no project is declared right now, so there is nothing to match it against`) }));
  } else if (c.proxyOffScopeUsd > 0) {
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
      : 'Route your tools through Segreant (segreant start), let a few days pass, and this becomes checkable.') }));
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
      : `of ${total} imported provider evidence; Segreant does not guess a target`) }),
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

/** A step is done when readiness no longer lists anything that starts with these words. */
function readinessHas(d: BillingPayload, prefix: string): boolean {
  return (d.readiness?.missing ?? []).some((m) => m.step.startsWith(prefix));
}

/** The file's own bytes, base64, so the server hashes exactly what the CLI would. */
async function fileBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function dayRange(startMs: number | undefined, endMs: number | undefined): string {
  if (startMs === undefined || endMs === undefined) return '—';
  // Provider periods end at an exclusive midnight; show the last day included.
  return `${date(startMs, 'UTC')} – ${date(endMs - 1, 'UTC')} UTC`;
}

function rows(pairs: Array<[string, string]>): Node {
  return h('dl', { class: 'preview-rows' },
    ...pairs.map(([k, v]) => h('div', { class: 'preview-row' }, h('dt', { text: k }), h('dd', { text: v }))));
}

export function evidenceView(): Node {
  const data = signal<BillingPayload | null>(null);
  const error = signal<string | null>(null);
  const reloads = signal(0);
  const { node: noticeNode, say } = pageNotice();
  const reload = (): void => {
    reloads.set(reloads() + 1);
    // The spine's Billed band reads /api/billing once; a recorded run must reach it.
    window.dispatchEvent(new CustomEvent('segreant:ledger-changed', { detail: { claim: 'billing' } }));
  };

  scopedEffect(() => {
    reloads();
    void api.billing()
      .then((payload) => { const restore = holdFocus(page); error.set(null); data.set(payload); restore(); })
      .catch((e: unknown) => error.set(errorText(e)));
  });

  const page = h('div', null,
    h('div', { class: 'view-head' },
      h('h1', { class: 'view-title', text: 'Close' }),
      h('p', { class: 'view-plain', text: () => isPrecise()
        ? 'Provider-side billing evidence and its reconciliation against the local ledger, at project-day grain. Status is never "reconciled", only "reconciled with residual".'
        : 'Spend is our own measurement. Here you check it against what your provider actually billed, and see how much of it could be checked at all.' })),
    noticeNode,

    () => {
      const err = error();
      const d = data();
      if (!d && err) return h('div', { class: 'card' }, h('p', { class: 'drawer-error', role: 'alert', text: err }));
      if (!d) return h('div', { class: 'card' }, h('p', { class: 'drawer-muted', role: 'status', 'aria-busy': 'true', text: 'Loading…' }));

      const scopeDone = !readinessHas(d, 'declare the route scope') && !readinessHas(d, 'the active scope cannot');
      const observed = !readinessHas(d, 'observe a closed period');
      return h('div', null,
        statusCard(d),
        d.demo
          ? h('p', { class: 'section-note', role: 'note', text: 'This is sample data, so nothing can be recorded here. Every step still previews. Start Segreant without --demo to close your own month.' })
          : null,
        step({ n: 1, done: scopeDone }, () => (isPrecise() ? 'Declare the provider project' : 'Say which OpenAI project this machine uses'),
          () => (isPrecise()
            ? 'An operator declaration bound to future proxy rows. Unverified by the provider; historical and imported rows are unchanged.'
            : 'Only spend that goes through Segreant after this, to that project, can be matched against the bill. These are the ids from your OpenAI settings, not keys.'),
          d.activeScope ? declaredScope(d, reload, say) : null,
          scopeForm(d.demo, reload, say, scopeDone)),
        step({ n: 2, done: observed }, () => (isPrecise() ? 'Observe the provider side' : 'Bring in the bill'),
          () => (isPrecise()
            ? 'Import an operator export, then adopt it as the Costs observation. Stamped operator-supplied; a direct read-only pull is stronger evidence.'
            : 'Give Segreant the cost export from your OpenAI account, then use it for the comparison. No key or password is needed for this.'),
          importForm(d.demo, reload, say),
          importList(d, reload, say, scopeDone),
          // The stronger route needs an Admin credential, so it stays a card whose
          // drawer states the consequence before any key is involved.
          h('div', { class: 'actions step-aside' }, actionCard('billing-pull'))),
        step({ n: 3, done: (d.reconciliation?.runs?.length ?? 0) > 0 }, () => (isPrecise() ? 'Reconcile' : 'Compare and record'),
          () => (isPrecise()
            ? 'Preview computes the comparison; Record persists an immutable run and issues it to the kernel.'
            : 'See how our measurement compares with the bill. Nothing is saved until you record it.'),
          readinessPanel(d),
          reconcilePanel(d, reload, say),
          recordedComparisons(d)),
        h('details', { class: 'section close-details' },
          h('summary', { class: 'section-title', text: () => (isPrecise() ? 'Evidence detail' : 'The evidence behind this') }),
          kernelPanel(d),
          mappingPanel(d)));
    }) as Element;
  return page;
}

function statusCard(d: BillingPayload): Node {
  // A payload with no stated support said nothing, which is `unknown`.
  const claimState = d.claimSupport ? projectRenderedAxes(d.claimSupport.profile).epistemic : 'unknown';
  const status = CLAIM_WORDS[claimState] ?? CLAIM_WORDS.unknown!;
  // Newest recorded run, from the immutable collection the server sends.
  const latest = d.reconciliation?.runs?.[0] ?? null;
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('span', { class: 'card-title', text: 'Where this stands' }),
      h('span', { class: `pill ${status.pill}`, text: claimState })),
    h('p', { text: () => (isPrecise() ? status.precise : status.plain) }),
    d.claimSupport?.note ? h('p', { class: 'basis', text: d.claimSupport.note }) : null,
    latest
      ? h('div', null,
          h('p', { class: residualBoundIsError(latest.result.offPathBound) ? 'drawer-error' : 'basis',
            text: () => residualBoundWords(latest.result.offPathBound, isPrecise()) }),
          h('span', { class: 'basis', text: () => `provider side: ${basisWords(latest.result.providerSourceKind)} · last run ${relative(latest.computedAtMs)}` }),
          latest.result.snapshotStability === 'changed_across_observations'
            ? h('span', { class: 'drawer-error', text: () => (isPrecise()
                ? `snapshot stability: changed across observations on ${(latest.result.unstableDayStartMs ?? []).length} day(s); this reconciliation is contradicted, not established`
                : 'Careful: the provider reported different figures for the same days at different times. This check disagrees with itself.') })
            : null)
      : h('span', { class: 'basis', text: () => `${count(d.summary.recordCount)} provider line(s) held · no comparison recorded yet` }));
}

/**
 * What is declared now, and a way to stop it. Clearing previews first, like
 * every write here, and says what it leaves alone: requests already recorded
 * keep their scope and recorded comparisons stay as they were.
 */
function declaredScope(d: BillingPayload, reload: () => void, say: Say): Node {
  const s = d.activeScope!;
  const preview = signal<string | null>(null);
  const project = s.providerProjectRef ?? 'no project id';
  return h('div', { class: 'facts declared-scope' },
    h('div', { class: 'fact fact-stack' },
      h('div', { class: 'fact-line' },
        h('span', { class: 'fact-key' },
          h('span', { text: `${s.billingAccountRef} · ${project}` }),
          h('span', { class: 'fact-sub', text: `declared ${relative(s.declaredAtMs)} · your statement, not verified by the provider` })),
        h('span', { class: 'fact-val' },
          h('button', { class: 'link-btn', type: 'button', text: 'Stop matching',
            'aria-label': `Stop matching requests to ${project}`,
            onclick: async () => {
              try { const r = await api.write.billing({ op: 'scope-clear' }); preview.set(r.message ?? ''); } catch (e) { say(false, errorText(e)); }
            } }))),
      () => {
        const message = preview();
        if (message === null) return null;
        return h('div', { class: 'run-result' },
          h('p', { class: 'basis', text: message }),
          h('div', { class: 'form-actions' },
            d.demo
              ? h('p', { class: 'drawer-muted', text: 'Sample data: the declaration cannot be cleared here.' })
              : h('button', { class: 'btn-commit', type: 'button', text: 'Clear the declaration', onclick: async () => {
                  try { const r = await api.write.billing({ op: 'scope-clear', apply: true }); say(true, r.message ?? 'Cleared.'); reload(); } catch (e) { say(false, errorText(e)); }
                } }),
            h('button', { class: 'btn-ghost', type: 'button', text: 'Keep it', onclick: () => preview.set(null) })));
      }));
}

function scopeForm(demo: boolean, reload: () => void, say: Say, scopeDone: boolean): Node {
  const account = signal('');
  const project = signal('');
  const checked = signal<Record<string, unknown> | null>(null);
  const body = (): Record<string, unknown> => ({ op: 'scope', accountRef: account().trim(), ...(project().trim() ? { projectRef: project().trim() } : {}) });
  return h('form', {
    class: 'inline-form',
    onsubmit: async (event: Event) => {
      event.preventDefault();
      try {
        const r = await api.write.billing(body());
        checked.set(r.scopePreview ?? {});
      } catch (e) { checked.set(null); say(false, errorText(e)); }
    },
  },
    scopeDone ? h('p', { class: 'form-hint', text: 'A project is declared. Declaring another replaces it for future traffic.' }) : null,
    h('div', { class: 'form-row' },
      field('scope-account', 'Organisation id', h('input', { id: 'scope-account', class: 'drawer-input', required: true, placeholder: 'org_…', autocomplete: 'off', spellcheck: 'false',
        oninput: (e: Event) => { account.set((e.target as HTMLInputElement).value); checked.set(null); } })),
      field('scope-project', 'Project id', h('input', { id: 'scope-project', class: 'drawer-input', required: true, placeholder: 'proj_…', autocomplete: 'off', spellcheck: 'false',
        oninput: (e: Event) => { project.set((e.target as HTMLInputElement).value); checked.set(null); } })),
      h('button', { class: 'btn-ghost', type: 'submit', text: 'Check' })),
    () => {
      if (!checked()) return null;
      return h('div', { class: 'run-result' },
        rows([
          ['Organisation', account().trim()],
          ['Project', project().trim()],
          ['Applies to', 'OpenAI requests that go through Segreant from now on'],
          ['Past and imported spend', 'unchanged; it cannot be matched to the bill'],
        ]),
        h('div', { class: 'form-actions' },
          demo
            ? h('p', { class: 'drawer-muted', text: 'Sample data: a project cannot be declared here.' })
            : h('button', { class: 'btn-commit', type: 'button', text: 'Declare this project', onclick: async () => {
                try { const r = await api.write.billing({ ...body(), apply: true }); say(true, isPrecise() ? r.message ?? 'Declared.' : 'Project declared for future OpenAI requests through Segreant. Past and imported spend is unchanged; the provider has not verified this declaration.'); reload(); } catch (e) { say(false, errorText(e)); }
              } })));
    });
}

function importForm(demo: boolean, reload: () => void, say: Say): Node {
  const chosen = signal<{ name: string; base64: string } | null>(null);
  const preview = signal<BillingImportPreviewPayload | null>(null);
  const busy = signal(false);
  return h('div', { class: 'inline-form' },
    h('div', { class: 'form-row' },
      field('import-file', 'Cost export (.json)', h('input', {
        id: 'import-file', class: 'drawer-input', type: 'file', accept: '.json,application/json',
        onchange: async (e: Event) => {
          const file = (e.target as HTMLInputElement).files?.[0];
          preview.set(null);
          if (!file) { chosen.set(null); return; }
          busy.set(true);
          try {
            const picked = { name: file.name, base64: await fileBase64(file) };
            chosen.set(picked);
            const r = await api.write.billing({ op: 'import', fileName: picked.name, contentBase64: picked.base64 });
            preview.set(r.preview ?? null);
          } catch (err) { say(false, errorText(err)); } finally { busy.set(false); }
        },
      }))),
    h('p', { class: 'form-hint', text: () => (busy() ? 'Reading the file…' : 'The file is checked here first. Nothing is saved until you import it.') }),
    () => {
      const p = preview();
      const c = chosen();
      if (!p || !c) return null;
      const charges = Object.entries(p.byChargeType).map(([k, n]) => `${count(n)} ${k.replace(/_/g, ' ')}`).join(', ');
      return h('div', { class: 'run-result' },
        rows([
          ['File', p.fileName],
          ['Period', dayRange(p.source.periodStartMs, p.source.periodEndMs)],
          ['Lines', `${count(p.recordsSeen)}${charges ? ` (${charges})` : ''}`],
          ['Provider total', usdFromMicros(p.providerReportedUsdMicros)],
          ['Complete?', p.source.coverage === 'complete' ? 'the export says it is complete (not verified)' : `the export says: ${p.source.coverage}`],
        ]),
        h('div', { class: 'form-actions' },
          demo
            ? h('p', { class: 'drawer-muted', text: 'Sample data: an export cannot be imported here.' })
            : h('button', { class: 'btn-commit', type: 'button', text: () => `Import ${count(p.recordsSeen)} line${p.recordsSeen === 1 ? '' : 's'}`, onclick: async () => {
                try {
                  const r = await api.write.billing({ op: 'import', fileName: c.name, contentBase64: c.base64, apply: true });
                  const inserted = typeof r.run?.recordsInserted === 'number' ? r.run.recordsInserted : p.recordsSeen;
                  say(true, r.duplicateFile
                    ? 'This file was already imported. Nothing new was written.'
                    : `Imported ${count(inserted)} line${inserted === 1 ? '' : 's'}. They are kept as the provider's figures, apart from our own measurement. Next: use this export for the comparison.`);
                  reload();
                } catch (e) { say(false, errorText(e)); }
              } })));
    });
}

function importList(d: BillingPayload, reload: () => void, say: Say, scopeDone: boolean): Node | null {
  const imports = d.imports ?? [];
  if (imports.length === 0) return null;
  return h('div', { class: 'facts' },
    ...imports.slice(0, 6).map((imp) => adoptRow(imp, d.demo, reload, say, scopeDone)));
}

function adoptRow(imp: BillingImportSummary, demo: boolean, reload: () => void, say: Say, scopeDone: boolean): Node {
  const plan = signal<BillingAdoptionPlanPayload | null>(null);
  return h('div', { class: 'fact fact-stack' },
    h('div', { class: 'fact-line' },
      h('span', { class: 'fact-key' },
        h('span', { text: imp.fileName }),
        h('span', { class: 'fact-sub', text: `${dayRange(imp.periodStartMs, imp.periodEndMs)} · ${count(imp.recordsSeen)} lines · imported ${relative(imp.importedAtMs)}` })),
      h('span', { class: 'fact-val' },
        imp.inUse
          ? h('span', { class: 'in-use', text: `in use · adopted ${relative(imp.inUse.adoptedAtMs)}` })
          : scopeDone
          ? h('button', { class: 'link-btn', type: 'button', text: 'Use for the comparison', 'aria-label': `Use ${imp.fileName} for the comparison`, onclick: async () => {
              try { const r = await api.write.billing({ op: 'adopt', importId: imp.importId }); plan.set(r.plan ?? null); } catch (e) { say(false, errorText(e)); }
            } })
          : h('span', { text: 'declare the project first' }))),
    () => {
      const p = plan();
      if (!p) return null;
      if (!p.adoptable) return h('p', { class: 'drawer-error', text: p.detail ?? p.refusal ?? 'This export cannot be used.' });
      const left = p.excluded && p.excluded.otherOrNoProjectRecordCount > 0
        ? `${count(p.excluded.otherOrNoProjectRecordCount)} line(s), ${usdFromMicros(p.excluded.otherOrNoProjectMicros)}, belong to no project or another one and are left out`
        : 'none';
      return h('div', { class: 'run-result' },
        rows([
          ['Matched to your project', `${count(p.matchedRecordCount)} line(s), ${usdFromMicros(p.matchedMicros)}`],
          ['Left out', left],
          ['Days', dayRange(p.periodStartMs, p.periodEndMs)],
          ['Evidence class', 'supplied by you, not read from the provider; every comparison built on it says so'],
        ]),
        h('div', { class: 'form-actions' },
          demo
            ? h('p', { class: 'drawer-muted', text: 'Sample data: nothing can be recorded here.' })
            : h('button', { class: 'btn-commit', type: 'button', text: 'Use this export', onclick: async () => {
                try { await api.write.billing({ op: 'adopt', importId: imp.importId, apply: true }); say(true, 'Recorded as the provider side for these days.'); reload(); } catch (e) { say(false, errorText(e)); }
              } })));
    });
}

/**
 * Every recorded comparison the server sends, newest first, each with its own
 * days. A run is evidence for its own period only, so the list never sums
 * them; opening one shows what was recorded, not a recomputation.
 */
function recordedComparisons(d: BillingPayload): Node | null {
  const runs = d.reconciliation?.runs ?? [];
  if (runs.length === 0) return null;
  return h('section', { class: 'section recorded-runs' },
    h('h3', { class: 'section-title', text: () => (isPrecise() ? 'Recorded reconciliations' : 'Recorded comparisons') }),
    h('div', { class: 'facts' },
      ...runs.map((run) => {
        const r = run.result;
        const days = dayRange(r.periodStartMs, r.periodEndMs);
        return h('details', { class: 'fact fact-stack recorded-run' },
          h('summary', null,
            h('span', { class: 'fact-line' },
              h('span', { class: 'fact-key' },
                h('span', { text: days }),
                h('span', { class: 'fact-sub', text: `${r.providerProjectRef ? `${r.providerProjectRef} · ` : ''}recorded ${relative(run.computedAtMs)}` })),
              h('span', { class: 'fact-val', text: r.unexplainedVarianceMicros === undefined ? '—' : `${usdFromMicros(r.unexplainedVarianceMicros)} not explained` }))),
          rows([
            ['Billed by the provider', r.providerReportedMicros === undefined ? '—' : usdFromMicros(r.providerReportedMicros)],
            ['Measured by Segreant', r.localCapturedMicros === undefined ? '—' : usdFromMicros(r.localCapturedMicros)],
            ['Not explained', r.unexplainedVarianceMicros === undefined ? '—' : usdFromMicros(r.unexplainedVarianceMicros)],
            ['Days compared', r.coverage ? `${count(r.coverage.daysWithBoth)} with both · ${count(r.coverage.providerOnlyDays)} bill only · ${count(r.coverage.localOnlyDays)} ours only` : '—'],
            ['Days that differ', r.coverage && r.materialityUsd !== undefined ? `${count(r.coverage.materialDays)} by more than ${usd(r.materialityUsd)}` : '—'],
            ['Provider side', basisWords(r.providerSourceKind)],
          ]),
          h('p', { class: residualBoundIsError(r.offPathBound) ? 'drawer-error' : 'basis', text: () => residualBoundWords(r.offPathBound, isPrecise()) }),
          r.snapshotStability === 'changed_across_observations'
            ? h('p', { class: 'drawer-error', text: 'The provider reported different figures for the same days at different times. This comparison is contradicted.' })
            : null);
      })));
}

function reconcilePanel(d: BillingPayload, reload: () => void, say: Say): Node {
  const result = signal<BillingReconcileResultPayload | null>(null);
  const busy = signal(false);
  // Blank means the server's default. The value previewed is the value
  // recorded: changing it clears the preview, so a run is never recorded under
  // a threshold nobody looked at.
  const materiality = signal('');
  const materialityUsd = (): number | undefined => {
    const raw = materiality().trim();
    return raw === '' ? undefined : Number(raw);
  };
  const remaining = (d.readiness?.missing ?? []).filter((m) => !m.step.startsWith('observe a closed period — route A'));
  const run = async (apply: boolean): Promise<void> => {
    busy.set(true);
    try {
      const m = materialityUsd();
      const r = await api.write.billing({ op: 'reconcile', ...(m === undefined ? {} : { materialityUsd: m }), ...(apply ? { apply: true } : {}) });
      if (apply) { result.set(null); say(true, 'Recorded. The comparison is saved, and the Billed claim above now rests on it.'); reload(); }
      else result.set(r.result ?? null);
    } catch (e) { say(false, errorText(e)); } finally { busy.set(false); }
  };
  if (d.readiness && !d.readiness.ready) {
    return h('div', { class: 'run-panel' },
      h('p', { class: 'drawer-muted', text: 'Not ready to compare. Still to do:' }),
      h('ul', { class: 'drawer-notes' }, ...remaining.map((m) => h('li', { text: m.step.replace(/^observe a closed period — route B, /, '') }))));
  }
  return h('div', { class: 'run-panel' },
    h('div', { class: 'form-row run-row' },
      field('reconcile-materiality', 'Ignore daily differences up to ($)', h('input', {
        id: 'reconcile-materiality', class: 'drawer-input', type: 'number', min: '0', step: '0.01', inputmode: 'decimal',
        placeholder: '0.50', 'aria-describedby': 'reconcile-materiality-hint',
        oninput: (e: Event) => { materiality.set((e.target as HTMLInputElement).value); result.set(null); },
      })),
      h('button', { class: 'btn-ghost', type: 'button', disabled: () => busy(), text: () => (busy() ? 'Working…' : 'Preview the comparison'), onclick: () => void run(false) })),
    h('p', { id: 'reconcile-materiality-hint', class: 'form-hint', text: 'A day counts as different only when the bill and our measurement differ by more than this. Blank uses $0.50.' }),
    () => {
      const r = result();
      if (!r) return null;
      const residual = r.unexplainedVarianceMicros;
      return h('div', { class: 'run-result' },
        rows([
          ['Period', dayRange(r.periodStartMs, r.periodEndMs)],
          ['Billed by the provider', usdFromMicros(r.providerReportedMicros)],
          ['Measured by Segreant', usdFromMicros(r.localCapturedMicros)],
          ['Not explained', `${usdFromMicros(residual)}${r.providerReportedMicros > 0 ? ` (${pct(residual / r.providerReportedMicros)} of the bill)` : ''}`],
          ['Days compared', `${count(r.coverage.daysWithBoth)} with both · ${count(r.coverage.providerOnlyDays)} bill only · ${count(r.coverage.localOnlyDays)} ours only`],
          ['Days that differ', `${count(r.coverage.materialDays)} by more than ${usd(r.materialityUsd)}`],
          ['Provider side', basisWords(r.providerSourceKind)],
        ]),
        h('p', { class: residualBoundIsError(r.offPathBound) ? 'drawer-error' : 'basis', text: () => residualBoundWords(r.offPathBound, isPrecise()) }),
        r.snapshotStability === 'changed_across_observations'
          ? h('p', { class: 'drawer-error', text: 'The provider reported different figures for the same days at different times. This comparison would be contradicted.' })
          : null,
        r.conditions.length > 0
          ? h('ul', { class: 'drawer-notes' }, ...r.conditions.map((c) => h('li', { text: c.replace(/_/g, ' ') })))
          : null,
        h('div', { class: 'form-actions' },
          d.demo
            ? h('p', { class: 'drawer-muted', text: 'Sample data: a comparison cannot be recorded here.' })
            : h('button', { class: 'btn-commit', type: 'button', disabled: () => busy(), text: 'Record this comparison', onclick: () => void run(true) })));
    });
}
