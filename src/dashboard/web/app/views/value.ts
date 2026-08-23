/**
 * Realized — what the spend actually produced, and how much of that is knowable.
 *
 * This is the claim with the weakest evidence and the strongest commercial pull,
 * which is exactly why it is the most disciplined screen in the product. Three
 * rules hold it together:
 *
 *   1. Realized value counts only MATURED units that survived. A suggestion that
 *      was accepted and later reverted is not value. Every tool in this category
 *      reports acceptance as if it were outcome; this one refuses.
 *   2. Where the number came from is stated beside it — observed git history or a
 *      persisted snapshot, spend scoped to this project or a window sum. Those
 *      are different claims and they do not get the same presentation.
 *   3. Per-user figures are a distribution or they are nothing. The cohort is
 *      gated by opt-in AND a k-anonymity floor, and when it is suppressed this
 *      screen says so rather than quietly rendering an empty section.
 *
 * The waste breakdown is the point of the page. Knowing that 66% of units
 * realize is a score; knowing which gate the other 34% died at, and what that
 * cost, is something an operator can act on tomorrow.
 */

import { h } from '../core/dom.ts';
import { signal, effect } from '../core/signal.ts';
import { api, type CausalPayload, type ValuePayload } from '../core/api.ts';
import { usd, count, pct, isPrecise } from '../core/fmt.ts';
import { actionCard } from './spend.ts';

/** What each gate means, for the funnel counts. */
const GATE_WORDS: Record<string, string> = {
  proposed: 'was suggested',
  accepted: 'was accepted',
  committed: 'was committed',
  tested: 'was tested',
  merged: 'was merged',
  shipped: 'shipped',
  survived: 'survived in production',
  clean: 'survived without rework',
};

/** The same gates named as a stage a unit STOPPED at, for the waste breakdown. */
const STOPPED_AFTER: Record<string, string> = {
  proposed: 'being suggested',
  accepted: 'being accepted',
  committed: 'being committed',
  tested: 'being tested',
  merged: 'being merged',
  shipped: 'shipping',
  survived: 'surviving in production',
  clean: 'surviving without rework',
  unverified: 'never being verified',
};

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

function causalStudyCard(payload: CausalPayload | null, failure: string | null): Node {
  if (failure) {
    return h('div', { class: 'card', style: 'margin-top: var(--s4)' },
      h('div', { class: 'card-head' },
        h('span', { class: 'card-title', text: 'Causal study evidence' }),
        h('span', { class: 'pill pill-warn', text: 'unavailable' })),
      h('p', { class: 'basis', text: 'The value scenario remains non-causal because the local study inspector could not be read.' }),
      h('p', { class: 'drawer-muted', text: failure }));
  }
  if (!payload) {
    return h('div', { class: 'card', style: 'margin-top: var(--s4)' },
      h('p', { class: 'drawer-muted', text: 'Loading causal-study evidence…' }));
  }
  if (!payload.study) {
    return h('div', { class: 'card', style: 'margin-top: var(--s4)' },
      h('div', { class: 'card-head' },
        h('span', { class: 'card-title', text: 'Causal study evidence' }),
        h('span', { class: 'pill pill-warn', text: 'not established' })),
      h('p', { text: payload.causalEvidence }),
      h('p', { class: 'basis', text: 'Create and inspect a local protocol with fiscus causal register, then use pre-exposure randomized assignment. This never changes routing automatically.' }));
  }

  const study = payload.study;
  const claim = study.allowedClaim === 'causal_net_benefit_supported'
    ? 'Scoped causal net-benefit evidence is supported under this registered protocol.'
    : study.allowedClaim === 'comparative_cost_quality_supported'
      ? 'Scoped randomized comparative cost-and-quality evidence is supported under this registered protocol.'
      : study.qualification.state === 'qualified'
        ? 'The protocol and records validate, but the conservative decision threshold is not met.'
        : study.qualification.state === 'collecting'
          ? 'The protocol is registered, but execution or outcome evidence is still incomplete.'
          : 'The study does not currently qualify for a causal claim.';
  const replayFailures = study.assignmentReplay.flatMap((plan) => plan.errors);
  return h('div', { class: 'card', style: 'margin-top: var(--s4)' },
    h('div', { class: 'card-head' },
      h('span', { class: 'card-title', text: 'Causal study evidence' }),
      h('span', {
        class: study.allowedClaim === 'not_established' ? 'pill pill-warn' : 'pill pill-ok',
        text: study.allowedClaim === 'not_established' ? study.qualification.state : 'scoped result',
      })),
    h('p', { text: claim }),
    h('p', { class: 'basis', text: 'Protocol ' + study.protocolHash.slice(0, 12) + '… · ' + study.question.replaceAll('_', ' ') }),
    h('div', { class: 'facts' },
      ...Object.entries(study.qualification.countsByArm).map(([armId, counts]) => h('div', { class: 'fact' },
        h('span', { class: 'fact-key', text: armId }),
        h('span', { class: 'fact-val', text: String(counts.completed) + '/' + String(counts.assigned) + ' completed' })))),
    replayFailures.length > 0
      ? h('p', { class: 'drawer-error', text: 'Assignment replay failed: ' + replayFailures.join('; ') })
      : h('p', { class: 'basis', text: 'Recorded assignment blocks replay from their retained local material.' }),
    study.qualification.reasons.length > 0
      ? h('p', { class: 'basis', text: study.qualification.reasons.join(' ') })
      : null,
    h('p', { class: 'drawer-muted', text: payload.boundary }));
}

export function valueView(): Node {
  const data = signal<ValuePayload | null>(null);
  const error = signal<string | null>(null);
  const causal = signal<CausalPayload | null>(null);
  const causalError = signal<string | null>(null);

  effect(() => {
    void api.value()
      .then((payload) => data.set(payload))
      .catch((e: unknown) => error.set(e instanceof Error ? e.message : String(e)));
    void api.causal()
      .then((payload) => causal.set(payload))
      .catch((e: unknown) => causalError.set(e instanceof Error ? e.message : String(e)));
  });

  return h('div', null,
    h('div', { class: 'view-head' },
      h('h1', { class: 'view-title', text: 'Realized' }),
      h('p', { class: 'view-plain', text: () => isPrecise()
        ? 'Realized value over matured work units, rework-discounted. Acceptance is not an outcome and is never counted as one.'
        : 'What the AI spend actually produced — counting only work that shipped and stayed shipped, not work that merely got accepted.' })),

    () => {
      const err = error();
      if (err) return h('div', { class: 'card' }, h('p', { class: 'drawer-error', text: err }));
      const d = data();
      if (!d) return h('div', { class: 'card' }, h('p', { class: 'drawer-muted', text: 'Loading…' }));

      const matured = d.realization?.matured ?? null;
      const established = (matured?.realizedUnits ?? 0) > 0;

      if (!established) {
        return h('div', null,
          h('div', { class: 'notyet' },
            h('h3', { text: () => (isPrecise() ? 'Realized value is not established' : 'We cannot tell you this yet') }),
            h('p', { text: () => (isPrecise()
              ? 'No work units have matured into verified outcomes on this machine. This is an absence of evidence, not a realized value of zero — the two must not be reported alike.'
              : 'Nothing has been observed all the way through to a shipped, surviving outcome yet. That is missing evidence, not an answer of nothing.') }),
            h('p', { class: 'basis', text: () => (isPrecise()
              ? 'Maturation requires observable outcomes: a repository whose history can be read, or imported units with recorded gate results.'
              : 'Fiscus needs somewhere to watch outcomes happen — usually a code repository — before it can say what the spend produced.') })),
          causalStudyCard(causal(), causalError()),
          actions());
      }

      const funnel = matured?.instrumentation ?? {};
      const waste = (matured?.wasteByStage ?? []).filter((w) => w.stage !== 'realized');
      const wasteCost = waste.reduce((s, w) => s + w.costUsd, 0);
      const bounds = matured?.realizationBounds ?? null;
      const team = d.team ?? null;
      const drift = d.drift ?? null;
      const ret = d.roi?.returnRatio ?? null;

      return h('div', null,
        d.demo ? h('div', { class: 'banner banner-demo' },
          h('span', { class: 'pill pill-demo', text: 'demo' }),
          h('p', null, h('strong', { text: 'Sample data. ' }), 'These outcomes were seeded, not observed on your machine.')) : null,

        causalStudyCard(causal(), causalError()),

        // Basis before figure. Which of the two sources produced this, and whether
        // the dollars are scoped to the project or merely summed over a window,
        // change what the headline means.
        h('div', { class: 'card card-basis' },
          h('div', { class: 'card-head' },
            h('span', { class: 'card-title', text: () => (isPrecise() ? 'Basis of this figure' : 'Where this comes from') }),
            h('span', {
              class: `pill ${d.projectScoped ? 'pill-ok' : 'pill-estimate'}`,
              text: d.projectScoped ? 'project-scoped' : 'window sum',
            })),
          h('p', { text: () => (isPrecise()
            ? `Outcome source: ${d.valueSource ?? 'none'}${d.gitRepo ? ' (live repository history)' : ' (persisted snapshot)'}.`
            : d.gitRepo
              ? 'Outcomes were read from a real repository’s history on this machine.'
              : 'Outcomes come from a saved snapshot rather than live repository history.') }),
          h('p', { text: () => (d.projectScoped
            ? (isPrecise()
                ? 'Attributed cost is scoped to this project, so the denominator matches the outcomes above it.'
                : 'The cost side is limited to this project, so it lines up with the work counted here.')
            : (isPrecise()
                ? 'Attributed cost is a project-blind window sum. The denominator may include spend unrelated to these outcomes, so the return is a lower bound.'
                : 'The cost side is everything spent in the period, not just this project — so it may include spend that had nothing to do with this work.')) }),
          matured && matured.units > 0 && (d.realization?.costStaleUnits ?? 0) > 0
            ? h('span', { class: 'basis', text: () => (isPrecise()
                ? `${count(d.realization?.costStaleUnits)} unit(s) carry stale cost attribution.`
                : `${count(d.realization?.costStaleUnits)} of these have out-of-date cost information.`) })
            : null),

        // The value claim and the cost figure, kept apart on purpose.
        //
        // The payload spells two different quantities `realizedValueUsd`:
        // `roi.returnRatio.realizedValueUsd` is manual-equivalent value produced,
        // and `matured.realizedValueUsd` is the attributed SPEND on units that
        // realized. An earlier version of this screen showed the second one under
        // the heading "what it produced", which reported a cost as a value --
        // the collapse this whole product is built to refuse. They now sit in
        // separate cards, each saying which it is.
        ret && ret.basis === 'usd'
          ? h('div', { class: 'grid grid-2', style: 'margin-top: var(--s4)' },
              h('div', { class: 'card' },
                h('div', { class: 'card-head' },
                  h('span', { class: 'card-title', text: () => (isPrecise() ? 'Realized value' : 'What the work was worth') })),
                h('div', { class: 'stat', text: usd(ret.realizedValueUsd) }),
                h('span', { class: 'basis', text: () => (isPrecise()
                  ? 'manual-equivalent dollars for realized work, net of rework'
                  : 'what that work would have cost to do by hand instead') })),

              h('div', { class: 'card' },
                h('div', { class: 'card-head' },
                  h('span', { class: 'card-title', text: () => (isPrecise() ? 'Honest cost' : 'What it cost to get') })),
                h('div', { class: 'stat', text: usd(ret.costUsd) }),
                h('span', { class: 'basis', text: () => (isPrecise()
                  ? ret.supervisionPriced
                    ? 'token spend plus measured time-with-AI at the labour rate'
                    : 'token spend plus a rework proxy for supervision'
                  : ret.supervisionPriced
                    ? 'the AI spend plus your own measured time, priced at your labour rate'
                    : 'the AI spend plus an estimate of the time it took you') })))
          : h('div', { class: 'notyet', style: 'margin-top: var(--s4)' },
              h('h3', { text: () => (isPrecise() ? 'Realized value is not priced' : 'We cannot put a figure on this') }),
              h('p', { text: () => (isPrecise()
                ? 'Work matured, but no labour rate is configured, so the value it produced cannot be expressed in dollars. The rate below is still computable; the money figure is not.'
                : 'Work did get finished, but Fiscus has no hourly rate to value it against — so it can tell you how much stuck, but not what it was worth.') })),

        // The money face is an observed/manual-equivalent scenario. A separate
        // qualified randomized study is required for causal economics.
        ret && typeof ret.grossRatio === 'number'
          ? h('div', { class: 'card', style: 'margin-top: var(--s4)' },
              h('div', { class: 'card-head' },
                h('span', { class: 'card-title', text: () => (isPrecise() ? 'Observed value scenario' : 'The value it looks like it delivered') }),
                h('span', {
                  class: 'pill pill-warn',
                  text: 'not causal evidence',
                })),
              h('div', { class: 'stat', text: `${ret.grossRatio.toFixed(2)}\u00d7` }),
              h('span', { class: 'basis', text: () => (isPrecise()
                ? 'realized manual-equivalent value divided by tokens plus measured time; a qualified randomized study is required for causal net benefit'
                : 'This uses the value of work that stuck and what it cost in AI and time. It cannot tell us what would have happened without AI.') }))
          : null,

        // Realization rate with its partial-identification bounds. A point estimate
        // alone would overstate how precisely this is known.
        h('div', { class: 'card', style: 'margin-top: var(--s4)' },
          h('div', { class: 'card-head' },
            h('span', { class: 'card-title', text: () => (isPrecise() ? 'Realization rate' : 'How much of the work stuck') })),
          h('div', { class: 'stat', text: pct(matured?.realizationRate, 0) }),
          bounds
            ? h('span', { class: 'basis', text: () => (isPrecise()
                ? `partial-identification bounds ${pct(bounds.lower, 0)}–${pct(bounds.upper, 0)} over n=${count(bounds.n)}`
                : `somewhere between ${pct(bounds.lower, 0)} and ${pct(bounds.upper, 0)}, based on ${count(bounds.n)} pieces of work`) })
            : null,
          drift
            ? h('p', {
                class: drift.alarm ? 'drift drift-alarm' : 'drift',
                text: () => (drift.alarm
                  ? (isPrecise()
                      ? `Drift alarm: the recent realization rate (${pct(drift.recentRate, 0)}) has departed from the overall rate (${pct(drift.overallRate, 0)}) beyond chance.`
                      : `Warning: work has recently been sticking much less often than it used to (${pct(drift.recentRate, 0)} against ${pct(drift.overallRate, 0)} overall).`)
                  : (isPrecise()
                      ? `No drift detected over n=${count(drift.n)} mature units.`
                      : 'The rate is holding steady — no sign it is drifting.')),              })
            : null),

        // The actionable part: where units die and what that costs.
        waste.length > 0
          ? h('section', { class: 'section' },
              h('h2', { class: 'section-title', text: () => (isPrecise() ? 'Where value is lost' : 'Where the work fell over') }),
              h('p', { class: 'view-plain', text: () => (isPrecise()
                ? `Of ${usd(matured?.totalCostUsd)} attributed to matured units, ${usd(matured?.realizedValueUsd)} reached a kept outcome and ${usd(wasteCost)} did not. These are spend figures, not value.`
                : `Of the ${usd(matured?.totalCostUsd)} spent on this work, ${usd(matured?.realizedValueUsd)} went on work that stuck and ${usd(wasteCost)} went on work that did not.`) }),
              h('div', { class: 'ledger' },
                ...waste
                  .slice()
                  .sort((a, b) => b.costUsd - a.costUsd)
                  .map((w) => h('div', { class: 'ledger-row' },
                    h('span', { class: 'ledger-key', text: () => (isPrecise() ? w.stage : `stopped after ${STOPPED_AFTER[w.stage] ?? w.stage}`) }),
                    h('span', { class: 'num cell-calls', text: `${count(w.units)} ${plural(w.units, 'unit', 'units')}` }),
                    h('span', { class: 'num cell-cost ledger-cost', text: usd(w.costUsd) }),
                    h('span', { class: 'num cell-share', text: wasteCost > 0 ? pct(w.costUsd / wasteCost, 0) : '—' }),
                    h('span', {
                      class: 'ledger-bar',
                      'aria-hidden': 'true',
                      style: `--fill: ${wasteCost > 0 ? Math.max(0.5, (w.costUsd / wasteCost) * 100) : 0}%`,
                    })))))
          : null,

        // The funnel, as counts. Deliberately after the waste breakdown: the
        // question worth asking is where work dies, not how big the pipeline is.
        Object.keys(funnel).length > 0
          ? h('section', { class: 'section' },
              h('h2', { class: 'section-title', text: () => (isPrecise() ? 'Instrumented gates' : 'How far work got') }),
              h('div', { class: 'facts' },
                ...Object.entries(funnel).map(([stage, n]) => h('div', { class: 'fact' },
                  h('span', { class: 'fact-key', text: () => (isPrecise() ? stage : (GATE_WORDS[stage] ?? stage)) }),
                  h('span', { class: 'fact-val', text: count(n) })))))
          : null,

        d.reclaimed && typeof d.reclaimed.workWeeksSaved === 'number'
          ? h('div', { class: 'card', style: 'margin-top: var(--s4)' },
              h('div', { class: 'card-head' },
                h('span', { class: 'card-title', text: () => (isPrecise() ? 'Time reclaimed' : 'Time this saved') })),
              h('div', { class: 'stat', text: `${d.reclaimed.workWeeksSaved.toFixed(1)} work weeks` }),
              // The interval, in the SAME unit as the headline. An earlier draft
              // rendered the raw minute range beside a work-week figure, which
              // invited reading a four-digit low bound as weeks.
              d.reclaimed.workWeeksRange
                ? (() => {
                    const lo = d.reclaimed?.workWeeksRange?.low ?? 0;
                    const hi = d.reclaimed?.workWeeksRange?.high ?? 0;
                    // At one decimal a genuinely narrow interval collapses to
                    // "between 0.4 and 0.4 weeks", which reads as a defect rather
                    // than as precision. Say it as a single figure instead.
                    const tight = lo.toFixed(1) === hi.toFixed(1);
                    return h('span', { class: 'basis', text: () => (isPrecise()
                      ? tight
                        ? `partial-identification interval narrower than 0.1 work weeks; the manual baseline is estimated, not observed`
                        : `partial-identification interval ${lo.toFixed(1)}\u2013${hi.toFixed(1)} work weeks; the manual baseline is estimated, not observed`
                      : tight
                        ? 'This compares against an estimate of how long the work would have taken by hand, not a stopwatch.'
                        : `Somewhere between ${lo.toFixed(1)} and ${hi.toFixed(1)} weeks. This compares against an estimate of how long the work would have taken by hand, not a stopwatch.`) });
                  })()
                : null,
              (d.reclaimed.uncreditedUnits ?? 0) > 0
                ? h('span', { class: 'basis', text: () => (isPrecise()
                    ? `${count(d.reclaimed?.uncreditedUnits)} matured ${plural(d.reclaimed?.uncreditedUnits ?? 0, 'unit', 'units')} earned no time credit (died, or had no baseline).`
                    : `${count(d.reclaimed?.uncreditedUnits)} ${plural(d.reclaimed?.uncreditedUnits ?? 0, 'piece', 'pieces')} of work got no credit here — they either failed, or we had nothing to compare them against.`) })
                : null)
          : null,

        // Per-user. The guardrail state is the content when the cohort is suppressed.
        team
          ? h('div', { class: 'card', style: 'margin-top: var(--s4)' },
              h('div', { class: 'card-head' },
                h('span', { class: 'card-title', text: () => (isPrecise() ? 'Cohort distribution' : 'Across the people using it') }),
                h('span', {
                  class: `pill ${team.suppressed || !team.enabled ? 'pill-unverified' : 'pill-ok'}`,
                  text: !team.enabled ? 'off' : team.suppressed ? 'suppressed' : 'distribution only',
                })),
              !team.enabled
                ? h('p', { text: () => (isPrecise()
                    ? 'Per-user analysis is disabled. No per-user data is computed or held.'
                    : 'Per-person figures are switched off, so none are being worked out at all.') })
                : team.suppressed || !team.distribution
                  ? h('p', { text: () => (isPrecise()
                      ? `Suppressed: ${team.reason ?? 'cohort below the k-anonymity floor'}.`
                      : 'There are too few people here to show this without effectively identifying someone, so it is withheld.') })
                  : h('div', null,
                      h('p', { text: () => (isPrecise()
                        ? `Distribution over ${count(team.distribution?.cohortSize)} users; individuals are never identified.`
                        : `Spread across ${count(team.distribution?.cohortSize)} people. Fiscus never shows who is who.`) }),
                      h('div', { class: 'facts' },
                        h('div', { class: 'fact' },
                          h('span', { class: 'fact-key', text: () => (isPrecise() ? 'median extraction' : 'typical person gets back') }),
                          h('span', { class: 'fact-val', text: pct(team.distribution.medianExtraction, 0) })),
                        h('div', { class: 'fact' },
                          h('span', { class: 'fact-key', text: () => (isPrecise() ? 'dispersion' : 'how evenly spread') }),
                          h('span', { class: 'fact-val', text: team.distribution.broadBased
                            ? (isPrecise() ? `${team.distribution.dispersion.toFixed(2)} — broad-based` : 'fairly even')
                            : (isPrecise() ? `${team.distribution.dispersion.toFixed(2)} — concentrated` : 'concentrated in a few') })),
                        h('div', { class: 'fact' },
                          h('span', { class: 'fact-key', text: () => (isPrecise() ? 'coaching headroom' : 'possible if everyone matched the middle') }),
                          h('span', { class: 'fact-val', text: usd(team.distribution.coachingHeadroomUsd) })))))
          : null,

        (d.roi?.notes?.length ?? 0) > 0
          ? h('section', { class: 'section' },
              h('h2', { class: 'section-title', text: () => (isPrecise() ? 'Method notes' : 'How this was worked out') }),
              h('p', { class: 'scope-note', text: () => (isPrecise()
                ? 'These notes are stated on the manual-equivalent value basis (the figures in Realized value and Honest cost above), not on the attributed-spend basis used in the waste breakdown.'
                : 'These notes talk about what the work was worth and what your time cost — not the smaller AI-spend figures further down the page.') }),
              h('ul', { class: 'drawer-notes' }, ...(d.roi?.notes ?? []).slice(0, 8).map((n) => h('li', { text: n }))))
          : null,

        actions());
    });
}

function actions(): Node {
  return h('section', { class: 'section' },
    h('h2', { class: 'section-title', text: () => (isPrecise() ? 'Actions on this layer' : 'Things you can do with this') }),
    h('div', { class: 'actions' },
      actionCard('roi'),
      actionCard('realize'),
      actionCard('frontier'),
      actionCard('saved'),
      actionCard('judge'),
      actionCard('team')));
}
