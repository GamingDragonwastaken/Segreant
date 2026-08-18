/**
 * Control — the caps that actually stop spend, and how far they can be trusted.
 *
 * Two honesty problems live on this screen, and both are load-bearing:
 *
 *   1. A cap only blocks what passes through the proxy. Imported subscription
 *      usage is sunk cost observed after the fact, so by default it does not
 *      count toward enforcement. A screen that showed one "spend against cap"
 *      figure without saying which basis it used would be telling the operator
 *      their cap governs money it cannot touch.
 *   2. Saving a cap writes the config file, but the RUNNING proxy holds its own
 *      config object and does not pick the change up until it restarts. The
 *      server source says so in a comment; before this view, no surface said it
 *      to the person relying on it. A control that silently does not take effect
 *      is worse than no control.
 *
 * The recommendation is presented as advice with its own basis (how many days of
 * observation stand behind it), never as a default that has already been applied.
 */

import { h } from '../core/dom.ts';
import { signal, effect } from '../core/signal.ts';
import { api, type SettingsSnapshot, type Overview, type ValuePayload } from '../core/api.ts';
import { usd, count, pct, isPrecise } from '../core/fmt.ts';
import { actionCard } from './spend.ts';

export function controlView(): Node {
  const settings = signal<SettingsSnapshot | null>(null);
  const today = signal<Overview | null>(null);
  const advice = signal<ValuePayload['budget'] | null>(null);
  const error = signal<string | null>(null);

  effect(() => {
    void Promise.allSettled([api.settings(), api.overview('today'), api.value()])
      .then(([s, o, v]) => {
        if (s.status === 'fulfilled') settings.set(s.value);
        if (o.status === 'fulfilled') today.set(o.value);
        if (v.status === 'fulfilled') advice.set(v.value.budget ?? null);
        if (s.status === 'rejected') {
          error.set(s.reason instanceof Error ? s.reason.message : String(s.reason));
        }
      });
  });

  return h('div', null,
    h('div', { class: 'view-head' },
      h('h1', { class: 'view-title', text: 'Control' }),
      h('p', { class: 'view-plain', text: () => isPrecise()
        ? 'Enforcement caps applied at the proxy, and the advisory recommendation derived from observed spend.'
        : 'The limits that stop AI spend before it happens — and how much of your spend they can actually reach.' })),

    () => {
      const err = error();
      if (err) return h('div', { class: 'card' }, h('p', { class: 'drawer-error', text: err }));
      const s = settings();
      if (!s) return h('div', { class: 'card' }, h('p', { class: 'drawer-muted', text: 'Loading…' }));

      const budget = s.budget;
      const cap = budget?.dailyCapUsd ?? null;
      const spentToday = today()?.summary.costUsd ?? null;
      const rec = advice();
      const includesImported = budget?.capIncludesImported === true;

      return h('div', null,
        h('div', { class: 'card card-basis' },
          h('div', { class: 'card-head' },
            h('span', { class: 'card-title', text: () => (isPrecise() ? 'Daily cap' : 'Your daily limit') }),
            h('span', {
              class: `pill ${cap === null ? 'pill-unverified' : 'pill-ok'}`,
              text: cap === null ? 'unlimited' : 'enforced',
            })),
          cap === null
            ? h('div', null,
                h('div', { class: 'stat band-unset', text: 'no cap set' }),
                h('span', { class: 'basis', text: () => (isPrecise()
                  ? 'No daily cap is configured. Requests are never blocked on spend.'
                  : 'Nothing is stopping spend right now. Fiscus will measure it, but it will not block it.') }))
            : h('div', null,
                h('div', { class: 'stat', text: usd(cap) }),
                spentToday !== null
                  ? h('div', null,
                      h('div', { class: 'meter', 'aria-hidden': 'true' },
                        h('span', {
                          class: `meter-fill${spentToday >= cap ? ' meter-over' : ''}`,
                          style: `--fill: ${Math.min(100, cap > 0 ? (spentToday / cap) * 100 : 0)}%`,
                        })),
                      h('span', { class: 'basis', text: () => (isPrecise()
                        ? `${usd(spentToday)} observed today — ${pct(cap > 0 ? spentToday / cap : 0, 0)} of the cap`
                        : `${usd(spentToday)} spent today, which is ${pct(cap > 0 ? spentToday / cap : 0, 0)} of your limit`) }))
                  : null),

          // Which money the cap can actually reach. See the module note.
          h('p', { class: 'scope-note', text: () => (includesImported
            ? (isPrecise()
                ? 'Basis: all observed spend. Imported subscription usage counts toward the cap even though it cannot be blocked, so the cap governs total spend rather than blockable spend.'
                : 'This limit counts everything we can see, including usage imported from tools. Fiscus cannot actually block that kind — it is already spent — so treat the limit as a total, not a wall.')
            : (isPrecise()
                ? 'Basis: live proxy spend only. Imported subscription usage is sunk cost observed after the fact and does not count toward enforcement.'
                : 'This limit only counts spend that goes through Fiscus, where it can genuinely be stopped. Usage imported from other tools is already spent, so it is not counted here.')) }),

          // The enforcement gap. A control that does not take effect until restart
          // must say so at the point of use, not in a source comment.
          h('div', { class: 'drawer-warning', role: 'note' },
            h('strong', { text: () => (isPrecise() ? 'Applies at proxy restart' : 'Changes need a restart') }),
            h('p', { text: () => (isPrecise()
              ? 'Editing a cap here writes the config file, but the running proxy holds its own configuration and continues enforcing the previous value until it is restarted.'
              : 'If you change this, the new limit is saved straight away — but the part of Fiscus that does the blocking keeps using the old one until you restart it.') }))),

        budget?.sessionCapUsd !== null && budget?.sessionCapUsd !== undefined
          ? h('div', { class: 'card', style: 'margin-top: var(--s4)' },
              h('div', { class: 'card-head' }, h('span', { class: 'card-title', text: () => (isPrecise() ? 'Per-session cap' : 'Limit for a single session') })),
              h('div', { class: 'stat', text: usd(budget.sessionCapUsd) }),
              h('span', { class: 'basis', text: () => (isPrecise()
                ? 'Applied per session in addition to the daily cap.'
                : 'A single working session cannot go past this, on top of the daily limit.') }))
          : null,

        rec ? recommendation(rec, cap) : null,

        h('section', { class: 'section' },
          h('h2', { class: 'section-title', text: () => (isPrecise() ? 'Actions on this layer' : 'Things you can do with this') }),
          h('div', { class: 'actions' },
            actionCard('budget'),
            actionCard('budget-recommend'),
            actionCard('alerts'),
            actionCard('exec'))));
    });
}

/**
 * The advisory recommendation. Rendered with its basis and its own readiness
 * status, because a cap recommended from four days of data is a different object
 * from one recommended from a month of it, and the difference must be visible
 * before anyone acts on it.
 */
function recommendation(rec: NonNullable<ValuePayload['budget']>, currentCap: number | null): Node {
  const ready = rec.canApply === true;
  const value = rec.recommendedDailyUsd ?? null;

  return h('div', { class: 'card', style: 'margin-top: var(--s4)' },
    h('div', { class: 'card-head' },
      h('span', { class: 'card-title', text: () => (isPrecise() ? 'Recommended cap' : 'What we would suggest') }),
      h('span', {
        class: `pill ${ready ? 'pill-ok' : 'pill-unverified'}`,
        text: ready ? 'enough data' : 'not enough data',
      })),

    value !== null
      ? h('div', { class: 'stat', text: usd(value) })
      : h('div', { class: 'stat band-unset', text: 'not established' }),

    h('span', { class: 'basis', text: () => (isPrecise()
      ? `derived from ${count(rec.basisDays)} day(s) of observed spend on a ${rec.spendBasis === 'live_proxy' ? 'live proxy' : 'all observed'} basis; minimum ${count(rec.minActiveDays)} active days`
      : `worked out from ${count(rec.basisDays)} days of your actual spend`) }),

    !ready
      ? h('p', { class: 'scope-note', text: () => (isPrecise()
          ? 'Status is not review-ready: too few active days stand behind this to recommend acting on it.'
          : 'There is not enough history yet for this to be a suggestion worth acting on.') })
      : currentCap !== null && value !== null && Math.abs(currentCap - value) < 0.005
        ? h('p', { class: 'scope-note', text: () => (isPrecise()
            ? 'Your configured cap already matches this recommendation.'
            : 'Your current limit already matches this.') })
        : null,

    rec.observed
      ? h('div', { class: 'facts' },
          h('div', { class: 'fact' },
            h('span', { class: 'fact-key', text: () => (isPrecise() ? 'median daily' : 'a typical day') }),
            h('span', { class: 'fact-val', text: usd(rec.observed.medianDaily) })),
          h('div', { class: 'fact' },
            h('span', { class: 'fact-key', text: () => (isPrecise() ? 'p90 daily' : 'a busy day') }),
            h('span', { class: 'fact-val', text: usd(rec.observed.p90Daily) })),
          h('div', { class: 'fact' },
            h('span', { class: 'fact-key', text: () => (isPrecise() ? 'max daily' : 'the worst day seen') }),
            h('span', { class: 'fact-val', text: usd(rec.observed.maxDaily) })))
      : null,

    // Projected waste is the number worth acting on, so it is not buried in the
    // rationale list. It is explicitly a projection, and says so.
    typeof rec.projectedMonthlyWasteUsd === 'number' && rec.projectedMonthlyWasteUsd > 0
      ? h('div', { class: 'waste-call' },
          h('span', { class: 'waste-fig', text: `${usd(rec.projectedMonthlyWasteUsd)}/mo` }),
          h('span', { class: 'waste-say', text: () => (isPrecise()
            ? `projected spend not converting to kept outcomes, at the current realized-value rate (${pct(rec.realizedValueRate, 0)})`
            : `is heading for work that never gets used, if things carry on as they are`) }))
      : null,

    rec.rationale?.length
      ? h('ul', { class: 'drawer-notes' }, ...rec.rationale.map((r) => h('li', { text: r })))
      : null);
}
