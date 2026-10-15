/**
 * GUI shell.
 *
 * The page leads with the evidence chain, not with a figure. Four money layers
 * across the top as the spine — metered, billed, allocated, realized — and the
 * operational sections beneath it. Selecting a band selects a view, so the
 * navigation and the thesis are the same object rather than a sidebar of nouns
 * beside a caption nobody reads.
 *
 * The operational sections (Data, Control, System) are secondary on purpose:
 * they are how you feed and configure the instrument, not what it measures.
 */

import { h, render, captureFocus, restoreFocus, trapFocus, type FocusTarget } from './core/dom.ts';
import { signal, effect, computed, onCleanup } from './core/signal.ts';
import { register, setRegister, type Register } from './core/fmt.ts';
import { GRIFFIN_PATH, GRIFFIN_TRANSFORM, GRIFFIN_VIEWBOX } from './core/griffin.ts';
import { api, ApiError, type Overview, type BillingPayload, type AllocationPayload, type ValuePayload } from './core/api.ts';
import { buildClaimLayers, chainIsSampleData } from './core/claimLayers.ts';
import { period } from './core/period.ts';
import { spine, type LayerId } from './components/spine.ts';
import { mountDrawer } from './components/drawer.ts';
import { mountClaimInspector, openClaimInspector } from './components/claimInspector.ts';
import type { Layer } from './components/spine.ts';
import { spendView } from './views/spend.ts';
import { evidenceView } from './views/evidence.ts';
import { systemView } from './views/system.ts';
import { allocationView } from './views/allocation.ts';
import { valueView } from './views/value.ts';
import { controlView } from './views/control.ts';
import { dataView } from './views/data.ts';
import type { Territory } from './core/registry.ts';
import { statementView } from './views/statement.ts';
import { initTheme } from './core/theme.ts';
import { initView, viewPrefs, jobShown } from './core/view.ts';
import { JOBS as SHARED_JOBS } from './core/jobs.ts';

/** A page the shell can show: the registry's territories, plus the monthly statement, which reads all four claims. */
type Route = Territory | 'statement';

/** The four spine bands map onto the territories that answer their question. */
const LAYER_ROUTE: Record<LayerId, Territory> = {
  metered: 'spend',
  billed: 'evidence',
  allocated: 'allocation',
  realized: 'value',
};

const ROUTE_LAYER: Partial<Record<Route, LayerId>> = {
  spend: 'metered',
  evidence: 'billed',
  allocation: 'allocated',
  value: 'realized',
};

/**
 * The navigation names the jobs people come to do, in the order they meet them.
 * It used to list only Data, Control and System: the four money views were
 * reachable through the spine alone, and Billed, Allocated and Realized had no
 * name a finance reader would look for (critique 2026-10-12).
 */
const JOBS = SHARED_JOBS as ReadonlyArray<{ id: Route; label: string; plain: string }>;

/** How you feed and configure the tool: needed, but not why anyone opens it. */
const UTILITIES: ReadonlyArray<{ id: Route; label: string; plain: string }> = [
  { id: 'data', label: 'Data', plain: 'Bring usage in from your tools and providers.' },
  { id: 'system', label: 'Settings', plain: 'Pricing, settings, maintenance, and what this GUI covers.' },
];

const ALL_ROUTES: Route[] = ['statement', 'spend', 'evidence', 'allocation', 'value', 'data', 'control', 'system'];

const current = signal<Route>(readRoute());
// The four payloads behind the claims. `undefined` = still on its way; `null` =
// the read failed, which the derivation already treats as missing evidence.
const overviewIn = signal<Overview | null | undefined>(undefined);
const billingIn = signal<BillingPayload | null | undefined>(undefined);
const allocationIn = signal<AllocationPayload | null | undefined>(undefined);
const valueIn = signal<ValuePayload | null | undefined>(undefined);
const chainInputs = computed(() => ({
  overview: overviewIn() ?? null,
  billing: billingIn() ?? null,
  allocation: allocationIn() ?? null,
  value: valueIn() ?? null,
}));
const chain = computed<Layer[] | null>(() => buildClaimLayers(chainInputs(), period()));
const pendingClaims = computed<ReadonlySet<LayerId>>(() => new Set<LayerId>([
  ...(overviewIn() === undefined ? ['metered' as const] : []),
  ...(billingIn() === undefined ? ['billed' as const] : []),
  ...(allocationIn() === undefined ? ['allocated' as const] : []),
  ...(valueIn() === undefined ? ['realized' as const] : []),
]));
const sampleData = computed(() => chainIsSampleData(chainInputs()));

/**
 * The figures on screen were read from a server that has since stopped answering.
 * Set by a failed read or by the timed re-check; cleared only by a fresh page load,
 * because nothing re-reads the payloads in place.
 */
const figuresStale = signal(false);
/** When the last successful read landed, so the age of the figures can be stated. */
const lastReadAt = signal<number | null>(null);
/** Advances on each re-check, so the stated age keeps moving while the page sits. */
const clock = signal(Date.now());
const STALE_RECHECK_MS = 15_000;

const unreachable = (e: unknown): boolean => e instanceof ApiError && e.status === 0;

function ageText(readAt: number | null, now: number): string {
  if (readAt === null) return 'at an unknown time';
  const minutes = Math.floor((now - readAt) / 60_000);
  if (minutes < 1) return 'less than a minute ago';
  return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
}

/** Stated on the page, above the figures, so a stale number is never read as current. */
function staleBanner(): Node {
  return h('div', { class: 'banner banner-stale', role: 'status', 'aria-live': 'polite' },
    h('p', null,
      h('strong', { text: 'Segreant stopped responding. ' }),
      h('span', { text: () => `The figures below were read ${ageText(lastReadAt(), clock())} and are not current.` })),
    h('button', { type: 'button', class: 'btn-ghost banner-retry', onclick: () => window.location.reload(), text: 'Retry' }));
}

/**
 * Whether the operator has chosen a register at all — NOT which one they chose.
 *
 * This is the distinction the shell effect needs. It has to know when to stop
 * showing the first-run chooser; it has no business re-running because someone
 * switched between two wordings of the same numbers.
 */
const registerChosen = computed(() => register() !== null);

function readRoute(): Route {
  const hash = location.hash.replace(/^#\/?/, '');
  return (ALL_ROUTES as string[]).includes(hash) ? (hash as Route) : 'spend';
}

window.addEventListener('hashchange', () => current.set(readRoute()));

function go(route: Route): void {
  location.hash = `/${route}`;
  current.set(route);
}

/** Focus the current page's h1 once the view has rendered; give up quietly after a second. */
function focusPageHeading(tries = 20): void {
  const heading = document.querySelector<HTMLElement>('main h1');
  if (!heading) {
    if (tries > 0) setTimeout(() => focusPageHeading(tries - 1), 50);
    return;
  }
  if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
  heading.focus();
}

function brandMark(): Node {
  return h('svg', { class: 'brand-mark', viewBox: GRIFFIN_VIEWBOX, 'aria-hidden': 'true' },
    h('path', { d: GRIFFIN_PATH, transform: GRIFFIN_TRANSFORM, fill: 'var(--gold)', 'fill-rule': 'evenodd' }));
}

function firstRun(): Node {
  const previousFocus = captureFocus(document.activeElement as FocusTarget | null);
  const body = h('div', { class: 'firstrun', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'fr-title', tabindex: '-1' },
    h('div', { class: 'firstrun-card' },
      h('div', { class: 'firstrun-mark' }, brandMark()),
      // The product has two audiences on one set of screens, and the first run
      // is where it learns which one is here. It used to ask only how figures
      // should be worded, so a finance reader and a developer landed on the
      // same screen with different decimals. The answer now also picks where
      // each starts: the money, or getting usage in.
      h('h1', { id: 'fr-title', text: 'What brings you to Segreant?' }),
      h('p', { class: 'lede', text: 'Pick the closer one. It decides where you start and how figures are worded. The numbers are the same either way, and you can switch at any time with Plain and Precise at the top right.' }),
      h('div', { class: 'choice-grid' },
        h('button', { class: 'choice', onclick: () => { setRegister('plain'); go('statement'); } },
          h('strong', { text: 'I look after the money' }),
          h('span', { text: 'See what AI cost, set limits, check it against the bill and assign it to budgets. Plain wording; no terminal needed.' }),
          h('code', { class: 'choice-eg', text: '$59.16 list cost (estimate)' })),
        h('button', { class: 'choice', onclick: () => { setRegister('precise'); go('data'); } },
          h('strong', { text: 'I build with AI tools' }),
          h('span', { text: 'Bring in usage from Claude Code, Codex and others, then see it by project and model. Exact figures and the matching commands.' }),
          h('code', { class: 'choice-eg', text: '$59.163468 list cost (estimate)' }))),
      h('p', { class: 'fine', text: 'Runs entirely on this machine. This page loads nothing from the internet: no fonts, no analytics, no third parties.' })));

  const release = trapFocus(body);
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      // The choice is required, so Escape cannot dismiss the first-run gate.
      // Keep the interaction inside the modal and return to its first choice.
      event.preventDefault();
      body.querySelector<HTMLElement>('.choice')?.focus();
    }
  };
  body.addEventListener('keydown', onKey);
  onCleanup(() => {
    release();
    body.removeEventListener('keydown', onKey);
    // On a fresh page the opener is <body>, and "restoring" to it left a screen
    // reader at the top of the document (NVDA run, 2026-10-15). Land on the
    // chosen page's heading instead.
    if (previousFocus && previousFocus !== document.body) restoreFocus(previousFocus);
    else focusPageHeading();
  });
  queueMicrotask(() => body.querySelector<HTMLElement>('.choice')?.focus());
  return body;
}

function topbar(): Node {
  return h('header', { class: 'topbar' },
    h('a', { class: 'brand', href: '#/spend', onclick: () => go('spend') },
      brandMark(),
      h('span', { class: 'brand-text' },
        h('span', { class: 'brand-name', text: 'Segreant' }),
        h('span', { class: 'brand-tag', text: 'AI Financial Ops' }))),

    () => (sampleData()
      ? h('span', {
          class: 'pill pill-demo topbar-demo',
          role: 'status',
          title: 'Sample data. None of this was measured from your machine.',
          text: 'sample data',
        })
      : null),

    h('nav', { class: 'ops', 'aria-label': 'Jobs' },
      ...JOBS.map((op) => h('button', {
        class: 'op',
        // A job the reader hid stays out of the bar unless it is the one open.
        hidden: () => !jobShown(op.id) && current() !== op.id,
        'aria-current': () => (current() === op.id ? 'page' : false),
        title: op.plain,
        onclick: () => go(op.id),
        text: op.label,
      }))),

    h('nav', { class: 'ops ops-util', 'aria-label': 'Setup' },
      ...UTILITIES.map((op) => h('button', {
        class: 'op op-util',
        'aria-current': () => (current() === op.id ? 'page' : false),
        title: op.plain,
        onclick: () => go(op.id),
        text: op.label,
      }))),

    h('div', { class: 'register-switch', role: 'group', 'aria-label': 'Detail level' },
      ...(['plain', 'precise'] as Register[]).map((r) =>
        h('button', {
          'aria-pressed': () => (register() === r ? 'true' : 'false'),
          onclick: () => setRegister(r),
          text: r,
        }))));
}

function viewFor(route: Route): Node {
  switch (route) {
    case 'statement': return statementView();
    case 'spend': return spendView();
    case 'evidence': return evidenceView();
    case 'allocation': return allocationView();
    case 'value': return valueView();
    case 'control': return controlView();
    case 'data': return dataView();
    case 'system': return systemView();
  }
}

function boot(): void {
  initTheme();
  initView();
  const root = document.getElementById('app');
  if (!root) throw new Error('missing #app');

  // The overlays mount ONCE, and onto the body rather than into `#app`.
  //
  // They used to be mounted at the END of the shell effect below, which re-runs
  // whenever the register changes. Every plain/precise toggle therefore appended
  // another host and started another effect that was never disposed:
  // `render(root, ...)` detached the old hosts but not the effects still driving
  // them, so opening the inspector after four toggles built the panel seven
  // times, six of them into elements nobody could see. Mounting on `body` also
  // means the shell's own `render` can never clear them.
  mountDrawer(document.body);
  mountClaimInspector(document.body);

  // Loaded once, not per register toggle. The four claims do not depend on the
  // wording register, and re-reading them on a plain/precise click re-issued
  // every endpoint behind the spine — including `/api/value`, which correlates
  // against the repository and is the slowest read this product has.
  //
  // Each claim draws as soon as its own payload lands. They used to wait for all
  // four, and `/api/value` (which reads git history) took 17-21 s on a real
  // ledger, so the whole header said "Reading the ledger…" for that long.
  // Billing, allocation and value do not depend on the period, so they are read
  // once; the overview is re-read whenever the period changes.
  //
  // Order matters as much as independence: fired together, the value read
  // pushed the overview from 0.5 s alone to 10 s. (Other reads are not queued
  // behind it in general: settings answered in 6-16 ms during a 25 s value
  // read; the overview shares the work the value read is doing.) So the cheap reads go first and the
  // value read starts only once the overview has answered.
  let restStarted = false;
  const readTheRest = (): void => {
    if (restStarted) return;
    restStarted = true;
    void Promise.allSettled([
      api.billing().then((b) => { billingIn.set(b); lastReadAt.set(Date.now()); }, (e: unknown) => { billingIn.set(null); if (unreachable(e)) figuresStale.set(true); }),
      api.allocation().then((a) => { allocationIn.set(a); lastReadAt.set(Date.now()); }, (e: unknown) => { allocationIn.set(null); if (unreachable(e)) figuresStale.set(true); }),
    ]).then(() => api.value().then((v) => { valueIn.set(v); lastReadAt.set(Date.now()); }, (e: unknown) => { valueIn.set(null); if (unreachable(e)) figuresStale.set(true); }));
  };
  effect(() => {
    const r = period();
    const controller = new AbortController();
    overviewIn.set(undefined);
    void api.overview(r, controller.signal).then(
      (o) => { if (!controller.signal.aborted) { overviewIn.set(o); lastReadAt.set(Date.now()); } },
      (e: unknown) => { if (!controller.signal.aborted) { overviewIn.set(null); if (unreachable(e)) figuresStale.set(true); } },
    ).finally(readTheRest);
    onCleanup(() => controller.abort());
  });

  // A screen that changed the ledger says so, and the claim it touched is
  // re-read, so the spine never contradicts the page beneath it.
  window.addEventListener('segreant:ledger-changed', (event) => {
    const claim = (event as CustomEvent<{ claim?: string }>).detail?.claim;
    if (claim === 'allocation') {
      void api.allocation().then((a) => { allocationIn.set(a); lastReadAt.set(Date.now()); }, () => undefined);
    }
    if (claim === 'billing') {
      void api.billing().then((b) => { billingIn.set(b); lastReadAt.set(Date.now()); }, () => undefined);
    }
  });

  // A stopped server is noticed without a click. While any figure is on screen the
  // shell re-checks the server; a dead one marks what is shown as not current.
  setInterval(() => {
    clock.set(Date.now());
    if (lastReadAt() === null || figuresStale()) return;
    void api.health().then(() => undefined, (e: unknown) => { if (unreachable(e)) figuresStale.set(true); });
  }, STALE_RECHECK_MS);

  effect(() => {
    // `registerChosen()`, never `register()`. Reading the register itself made
    // this effect — which renders the ENTIRE application — a subscriber to the
    // plain/precise toggle. Every click tore down and rebuilt the whole view
    // tree, and each view's own load effect re-ran with it, so changing the
    // WORDING re-requested that screen's data from the server. `computed` only
    // notifies when its value actually changes, so plain↔precise no longer
    // reaches this effect at all, while first-run → chosen still does.
    //
    // The wording still updates, through the much smaller effects that `h()`
    // creates for each register-sensitive binding. That is the whole point of
    // those bindings; the full rebuild was masking them, not driving them.
    if (!registerChosen()) {
      render(root, firstRun());
      return;
    }

    render(root,
      // The skip link moves focus itself rather than letting the browser apply
      // its own href. This shell routes on the hash, and `#main` is not a route:
      // following the link wrote `#main` into `location.hash`, `hashchange` ran
      // `readRoute()`, the whitelist rejected `main`, and the fallback sent the
      // operator to Metered. So the one control that exists purely for keyboard
      // and screen-reader use was the one control that could lose them the
      // screen they were on. The href stays — it is what makes this a link, and
      // what a browser shows in the status bar — but it is never applied.
      h('a', {
        class: 'skip',
        href: '#main',
        text: 'Skip to content',
        onclick: (event: Event) => {
          event.preventDefault();
          document.getElementById('main')?.focus();
        },
      }),
      topbar(),
      () => (figuresStale() && lastReadAt() !== null ? staleBanner() : null),
      // The banner alone was easy to miss: the figures under it looked exactly
      // as current as before. While stale, the sheet is dimmed as well.
      h('div', { class: () => (figuresStale() && lastReadAt() !== null ? 'sheet is-stale' : 'sheet') },
        () => {
          // The four claims head the four money views only. On Protect, Data
          // and Settings they pushed the screen's own content below the fold
          // and asserted nothing about it.
          if (!ROUTE_LAYER[current()]) return null;
          // The reader can fold the strip away in Settings; every figure is still on its own page.
          if (!viewPrefs().strip) return null;
          const layers = chain();
          if (!layers) return h('div', { class: 'spine spine-loading' }, h('p', { class: 'spine-read', text: 'Reading the ledger…' }));
          return spine({
            layers,
            pending: pendingClaims(),
            active: ROUTE_LAYER[current()] ?? null,
            onSelect: (id) => go(LAYER_ROUTE[id]),
            onInspect: openClaimInspector,
          });
        },
        h('main', { class: 'main', id: 'main', tabindex: '-1' }, () => viewFor(current()))),
      h('footer', { class: 'shellfoot' },
        h('span', { text: 'Runs on this machine. Outbound traffic goes only to the configured provider and the other routes you set up.' }),
        h('a', { href: '/classic', text: 'Classic dashboard' })));

  });
}

boot();
