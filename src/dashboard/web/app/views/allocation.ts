/**
 * Allocation — whose budget the money lands on, and what that number is not.
 *
 * Allocated cost is the third claim in the spine, and the one most often
 * mistaken for the first. It is a DERIVED split of local estimates: a rule said
 * this request belongs to that cost centre. It is not a provider bill, it is not
 * what anyone owes, and it is explicitly excluded from budget enforcement, RoI,
 * and model recommendations — because a showback split is not evidence about
 * value or about money actually charged.
 *
 * So this view leads with the exclusions, not with a total. The payload states
 * its own basis (`showback_only`) and the list of things it must not feed; that
 * list is rendered as the first thing on the page rather than as a footnote,
 * because a reader who takes an allocation figure into a budget conversation has
 * already made the mistake the label exists to prevent.
 */

import { h } from '../core/dom.ts';
import { signal, scopedEffect } from '../core/signal.ts';
import { api, type AllocationPayload } from '../core/api.ts';
import { isPrecise, relative, count } from '../core/fmt.ts';
import { actionCard } from './spend.ts';

/** The payload's `excludedFrom` ids, said in words an operator can act on. */
const EXCLUSION_WORDS: Record<string, string> = {
  request_metered_spend: 'the metered spend figure',
  budget_enforcement: 'budget caps and blocking',
  roi: 'return on investment',
  model_recommendations: 'which model we suggest',
};

export function allocationView(): Node {
  const data = signal<AllocationPayload | null>(null);
  const error = signal<string | null>(null);

  scopedEffect(() => {
    void api.allocation()
      .then((payload) => data.set(payload))
      .catch((e: unknown) => error.set(e instanceof Error ? e.message : String(e)));
  });

  return h('div', null,
    h('div', { class: 'view-head' },
      h('h1', { class: 'view-title', text: 'Allocated' }),
      h('p', { class: 'view-plain', text: () => isPrecise()
        ? 'A derived split of locally estimated cost across cost centres, by recorded rule. Showback only — no settlement, no chargeback.'
        : 'Which team or project each pound of AI spend gets attributed to. This is a split of our own estimate — not a bill, and not something anyone is charged.' })),

    () => {
      const err = error();
      if (err) return h('div', { class: 'card' }, h('p', { class: 'drawer-error', role: 'alert', 'aria-live': 'assertive', text: err }));
      const d = data();
      if (!d) return h('div', { class: 'card' }, h('p', { class: 'drawer-muted', role: 'status', 'aria-live': 'polite', 'aria-busy': 'true', text: 'Loading…' }));

      const centres = d.costCentres ?? [];
      const rules = d.rules ?? [];
      const runs = d.runs ?? [];
      const configured = centres.length > 0 && rules.length > 0;

      return h('div', null,
        // The exclusions come first, deliberately. See the module note above.
        h('div', { class: 'card card-basis' },
          h('div', { class: 'card-head' },
            h('span', { class: 'card-title', text: () => (isPrecise() ? 'Basis and exclusions' : 'What this number is not') }),
            h('span', { class: 'pill pill-estimate', text: 'showback only' })),
          h('p', { text: () => (isPrecise()
            ? 'kind: derived_cost_allocation · trust: derived_allocation_of_local_estimates'
            : 'These figures are worked out by rules you wrote, applied to costs we estimated ourselves.') }),
          h('p', { class: 'excl-lede', text: () => (isPrecise() ? 'Deliberately excluded from:' : 'Fiscus deliberately refuses to let this feed:') }),
          h('ul', { class: 'excl' },
            ...(d.excludedFrom ?? []).map((id) =>
              h('li', { text: EXCLUSION_WORDS[id] ?? id.replace(/_/g, ' ') }))),
          h('span', { class: 'basis', text: () => (isPrecise()
            ? 'A showback split is not evidence of money charged, nor of value produced.'
            : 'Splitting a cost does not make it a bill, and it does not prove the spend was worth it.') })),

        // The residual cross-reference. Allocation of a ledger nobody has checked
        // against a provider bill is a confident split of an unverified total, and
        // the operator should meet that fact here rather than infer it.
        h('div', { class: 'card', style: 'margin-top: var(--s4)' },
          h('div', { class: 'card-head' },
            h('span', { class: 'card-title', text: () => (isPrecise() ? 'Underlying ledger' : 'What this is a split of') }),
            h('span', {
              class: `pill ${d.reconciliation?.everRun ? 'pill-ok' : 'pill-unverified'}`,
              text: d.reconciliation?.everRun ? 'checked' : 'unchecked',
            })),
          d.reconciliation?.everRun
            ? h('p', { text: () => (isPrecise()
                ? `The underlying ledger has been reconciled against provider billing; last run ${relative(d.reconciliation.latestComputedAtMs)}.`
                : `We have checked the underlying spend against a real provider bill — last time ${relative(d.reconciliation.latestComputedAtMs)}.`) })
            : h('p', { text: () => (isPrecise()
                ? 'No reconciliation run recorded. Every figure below splits a total that has never been compared against provider billing, so the residual beneath it is unbounded.'
                : 'Nobody has checked the underlying spend against a real provider bill yet. The split below is exact arithmetic on a number we estimated ourselves.') })),

        configured
          ? h('div', null,
              section(() => (isPrecise() ? 'Cost centres' : 'Who the money is attributed to'),
                h('div', { class: 'facts' },
                  ...centres.map((c) => h('div', { class: 'fact' },
                    h('span', { class: 'fact-key', text: c.label ?? c.name ?? c.id }),
                    h('span', { class: 'fact-val', text: c.id }))))),

              section(() => (isPrecise() ? 'Allocation rules' : 'The rules that decide the split'),
                h('div', { class: 'facts' },
                  // A revoked rule is shown, not hidden: a past run was computed
                  // under it, and a reader comparing runs needs to see why the
                  // split changed rather than find a rule silently absent.
                  ...rules.map((r) => h('div', { class: `fact${r.revokedAtMs ? ' fact-off' : ''}` },
                    h('span', { class: 'fact-key', text: r.id }),
                    h('span', { class: 'fact-val', text: r.revokedAtMs
                      ? `revoked · was ${r.method} v${r.version}`
                      : `${r.method} · v${r.version}` }))))),

              section(() => (isPrecise() ? 'Recorded runs' : 'Times this has been worked out'),
                runs.length > 0
                  ? h('p', { class: 'basis', text: () => (isPrecise()
                      ? `${count(runs.length)} recorded run${runs.length === 1 ? '' : 's'}; each is a snapshot under the rule version in force at the time.`
                      : `${count(runs.length)} saved result${runs.length === 1 ? '' : 's'}. Each one records the rules as they were on the day.`) })
                  : h('p', { class: 'drawer-muted', text: () => (isPrecise()
                      ? 'Rules and centres exist, but no allocation run has been recorded.'
                      : 'You have set the rules up, but never run the split.') })))
          : h('div', { class: 'notyet', style: 'margin-top: var(--s5)' },
              h('h3', { text: () => (isPrecise() ? 'No allocation model defined' : 'Nothing is being split yet') }),
              h('p', { text: () => (isPrecise()
                ? `${centres.length} cost centre${centres.length === 1 ? '' : 's'} and ${rules.length} rule${rules.length === 1 ? '' : 's'} recorded. Both are required before a run can produce a split.`
                : 'To split spend across teams or projects, Fiscus needs at least one cost centre to attribute to, and one rule that decides what goes where.') })),

        section(() => (isPrecise() ? 'Actions on this layer' : 'Things you can do with this'),
          h('div', { class: 'actions' },
            actionCard('alloc-centres'),
            actionCard('alloc-rules'),
            actionCard('alloc-run'),
            actionCard('project'))));
    });
}

function section(title: () => string, ...body: Array<Node | null>): Node {
  return h('section', { class: 'section' },
    h('h2', { class: 'section-title', text: title }),
    ...body);
}
