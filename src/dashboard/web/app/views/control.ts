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
 *   2. A cap configured here, spend that was only ever observed after the fact,
 *      and limits held at the provider are three different enforcement claims.
 *      The screen names which boundary can actually stop a future request rather
 *      than collapsing them into the word "cap".
 *
 *      This view used to warn that a saved cap did not take effect until the
 *      proxy restarted. That was false: `fiscus start` hands ONE config object
 *      to both the proxy and the dashboard, and the guard is built as
 *      `new BudgetGuard(store, () => config.budget)` — a getter, re-read per
 *      request — so `Object.assign(config, next)` in the settings handler is
 *      live. Verified end to end against a running instance: with no cap a
 *      request returned 200, a $0.01 cap posted through this screen made the
 *      very next request 429 in the same process, no restart. Telling an
 *      operator their cap is inert while it is already blocking is the same
 *      class of defect as telling them it is active while it is not.
 *
 * The recommendation is presented as advice with its own basis (how many days of
 * observation stand behind it), never as a default that has already been applied.
 */

import { h } from '../core/dom.ts';
import { signal, scopedEffect } from '../core/signal.ts';
import { api, type SettingsSnapshot, type Overview, type ValuePayload, type AlertRow } from '../core/api.ts';
import { usd, count, pct, isPrecise } from '../core/fmt.ts';
import { actionCard } from './spend.ts';

export function controlView(): Node {
  const settings = signal<SettingsSnapshot | null>(null);
  const today = signal<Overview | null>(null);
  const advice = signal<ValuePayload['budget'] | null>(null);
  const error = signal<string | null>(null);

  scopedEffect(() => {
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
      const enforcement = s.enforcement;
      const cap = budget?.dailyUsd ?? null;
      const spentToday = today()?.summary.costUsd ?? null;
      const rec = advice();
      const includesImported = budget?.capIncludesImported === true;

      const alerts = today()?.alerts ?? [];

      return h('div', null,
        // Live governance alerts, above the caps that produced them. The server
        // already computed these; until now no screen rendered them, so an
        // operator whose cap was exhausted had to infer it from a percentage.
        alerts.length > 0 ? alertList(alerts) : null,

        h('div', { class: 'card card-basis' },
          h('div', { class: 'card-head' },
            h('span', { class: 'card-title', text: () => (isPrecise() ? 'Daily cap' : 'Your daily limit') }),
            h('span', {
              class: `pill ${cap === null ? 'pill-unverified' : 'pill-ok'}`,
              text: cap === null ? 'unlimited' : 'enforced in path',
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

          // Enforcement is a location and scope claim, not an on/off flag. Four
          // members, four different claims — see BudgetEnforcement in core/api.ts.
          h('div', { class: 'facts enforcement-facts' },
            h('div', { class: 'fact' },
              h('span', { class: 'fact-key', text: () => (isPrecise() ? 'Local proxy' : 'What Fiscus can stop') }),
              h('span', { class: 'fact-val', text: () => (isPrecise()
                ? `${enforcement.localProxy.state.replaceAll('_', ' ')}${enforcement.localProxy.hardControlActive ? ' · hard control active' : ' · no hard blocker configured'}`
                : (enforcement.localProxy.hardControlActive ? 'future requests are guarded' : 'ready, but no hard limit is set')) })),
            h('div', { class: 'fact' },
              h('span', { class: 'fact-key', text: () => (isPrecise() ? 'Config updates' : 'Changes you save') }),
              h('span', { class: 'fact-val', text: () => (enforcement.localProxy.liveConfig
                ? (isPrecise() ? 'live · running proxy re-reads config' : 'take effect straight away')
                : (isPrecise() ? 'not live' : 'need a restart')) })),
            h('div', { class: 'fact' },
              h('span', { class: 'fact-key', text: () => (isPrecise() ? 'Imported / off-path' : 'Usage Fiscus saw later') }),
              h('span', { class: 'fact-val', text: () => (isPrecise()
                ? `${enforcement.importedSpend.state.replaceAll('_', ' ')} · not blockable${enforcement.importedSpend.countsTowardInPathCap ? ' · counts toward later proxy decisions' : ''}`
                : 'visible, but already spent') })),
            h('div', { class: 'fact' },
              h('span', { class: 'fact-key', text: () => (isPrecise() ? 'Provider-native limits' : 'Limits at the AI provider') }),
              h('span', { class: 'fact-val', text: () => (isPrecise()
                ? `${enforcement.providerNative.state} · not inspected`
                : 'not checked by Fiscus') })))),

        // The other three enforcement controls the CLI exposes. Shown together so
        // the GUI states the whole enforcement picture rather than the daily cap
        // alone -- a soft threshold that is set changes what "unlimited" means.
        h('div', { class: 'card', style: 'margin-top: var(--s4)' },
          h('div', { class: 'card-head' },
            h('span', { class: 'card-title', text: () => (isPrecise() ? 'Other limits' : 'The other limits') })),
          h('div', { class: 'facts' },
            h('div', { class: `fact${budget?.dailySoftUsd == null ? ' fact-off' : ''}` },
              h('span', { class: 'fact-key', text: () => (isPrecise() ? 'Soft daily threshold' : 'Warn me at') }),
              h('span', { class: 'fact-val', text: budget?.dailySoftUsd == null
                ? (isPrecise() ? 'off' : 'no warning')
                : usd(budget.dailySoftUsd) })),
            h('div', { class: `fact${budget?.sessionUsd == null ? ' fact-off' : ''}` },
              h('span', { class: 'fact-key', text: () => (isPrecise() ? 'Per-session cap' : 'Limit for one session') }),
              h('span', { class: 'fact-val', text: budget?.sessionUsd == null
                ? (isPrecise() ? 'unlimited' : 'no limit')
                : usd(budget.sessionUsd) })),
            h('div', { class: `fact${budget?.runawayMaxUsd == null ? ' fact-off' : ''}` },
              h('span', { class: 'fact-key', text: () => (isPrecise() ? 'Runaway detection' : 'Stop a runaway loop') }),
              h('span', { class: 'fact-val', text: budget?.runawayMaxUsd == null
                ? (isPrecise() ? 'off' : 'not watching')
                : (isPrecise()
                    ? `${usd(budget.runawayMaxUsd)} / ${count(budget.runawayWindowSec)}s`
                    : `${usd(budget.runawayMaxUsd)} in ${count(budget.runawayWindowSec)} seconds`) }))),
          h('span', { class: 'basis', text: () => (isPrecise()
            ? 'All four are enforced in path at the local proxy, on the same live-config basis as the daily cap.'
            : 'These work the same way as the daily limit, and take effect as soon as you save them.') })),

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
 * Alerts carry their own quantified evidence (`metric`), so each one is rendered
 * with the figure that triggered it rather than as a bare warning. A warning an
 * operator cannot check is a warning they learn to dismiss.
 */
function alertList(alerts: AlertRow[]): Node {
  const order: Record<string, number> = { critical: 0, warn: 1, info: 2 };
  const sorted = [...alerts].sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));

  return h('div', { class: 'alerts', role: 'region', 'aria-label': 'Active alerts' },
    ...sorted.map((a) => h('div', { class: `alert alert-${a.severity}` },
      h('div', { class: 'alert-head' },
        h('span', { class: `pill pill-${a.severity === 'critical' ? 'warn' : 'unverified'}`, text: a.severity }),
        h('strong', { class: 'alert-title', text: a.title }),
        a.metric ? h('span', { class: 'alert-metric', text: a.metric }) : null),
      h('p', { class: 'alert-detail', text: a.detail }))));
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
