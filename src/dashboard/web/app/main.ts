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
import { api, type Overview, type BillingPayload, type AllocationPayload, type ValuePayload } from './core/api.ts';
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

/** The four spine bands map onto the territories that answer their question. */
const LAYER_ROUTE: Record<LayerId, Territory> = {
  metered: 'spend',
  billed: 'evidence',
  allocated: 'allocation',
  realized: 'value',
};

const ROUTE_LAYER: Partial<Record<Territory, LayerId>> = {
  spend: 'metered',
  evidence: 'billed',
  allocation: 'allocated',
  value: 'realized',
};

/** Everything that is not a money claim: how you feed and configure the tool. */
const OPERATIONS: ReadonlyArray<{ id: Territory; label: string; plain: string }> = [
  { id: 'data', label: 'Data', plain: 'Getting your usage in, from tools and providers.' },
  { id: 'control', label: 'Control', plain: 'Budgets and alerts, so nothing surprises you.' },
  { id: 'system', label: 'System', plain: 'Pricing, settings, maintenance, and what this GUI covers.' },
];

const ALL_ROUTES: Territory[] = ['spend', 'evidence', 'allocation', 'value', 'data', 'control', 'system'];

const current = signal<Territory>(readRoute());
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
 * Whether the operator has chosen a register at all — NOT which one they chose.
 *
 * This is the distinction the shell effect needs. It has to know when to stop
 * showing the first-run chooser; it has no business re-running because someone
 * switched between two wordings of the same numbers.
 */
const registerChosen = computed(() => register() !== null);

function readRoute(): Territory {
  const hash = location.hash.replace(/^#\/?/, '');
  return (ALL_ROUTES as string[]).includes(hash) ? (hash as Territory) : 'spend';
}

window.addEventListener('hashchange', () => current.set(readRoute()));

function go(route: Territory): void {
  location.hash = `/${route}`;
  current.set(route);
}

function brandMark(): Node {
  return h('svg', { class: 'brand-mark', viewBox: '0 0 30 34', 'aria-hidden': 'true' },
    h('path', { d: 'M15 1 28 6v11c0 8-5.6 13.4-13 16C7.6 30.4 2 25 2 17V6z', fill: 'none', stroke: 'var(--gold)', 'stroke-width': '1.6' }),
    h('path', { d: 'M11 11h8M11 16h6M11 21h4', stroke: 'var(--gold)', 'stroke-width': '1.6', 'stroke-linecap': 'round' }));
}

function firstRun(): Node {
  const previousFocus = captureFocus(document.activeElement as FocusTarget | null);
  const body = h('div', { class: 'firstrun', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'fr-title', tabindex: '-1' },
    h('div', { class: 'firstrun-card' },
      h('div', { class: 'firstrun-mark' }, brandMark()),
      h('h1', { id: 'fr-title', text: 'How should Segreant talk to you?' }),
      h('p', { class: 'lede', text: 'The numbers are identical either way. This only changes how precisely they are worded and how much detail shows by default — and you can switch whenever you like.' }),
      h('div', { class: 'choice-grid' },
        h('button', { class: 'choice', onclick: () => setRegister('plain') },
          h('strong', { text: 'Plain language' }),
          h('span', { text: 'Rounded figures, concepts explained where they appear, no command line assumed.' }),
          h('code', { class: 'choice-eg', text: '$59.16 · measured from metered requests' })),
        h('button', { class: 'choice', onclick: () => setRegister('precise') },
          h('strong', { text: 'Precise' }),
          h('span', { text: 'Exact microdollar figures, provenance labels shown, equivalent commands surfaced.' }),
          h('code', { class: 'choice-eg', text: '$59.163468 · local_list_price' }))),
      h('p', { class: 'fine', text: 'Runs entirely on this machine. This page loads nothing from the internet — no fonts, no analytics, no third parties.' })));

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
    restoreFocus(previousFocus);
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

    h('nav', { class: 'ops', 'aria-label': 'Operations' },
      ...OPERATIONS.map((op) => h('button', {
        class: 'op',
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

function viewFor(route: Territory): Node {
  switch (route) {
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
  // Order matters as much as independence: the server answers one request at a
  // time, and the value read holds it for seconds. Fired together, it pushed
  // the overview (0.5 s alone) to 10 s. So the cheap reads go first and the
  // value read starts only once the overview has answered.
  let restStarted = false;
  const readTheRest = (): void => {
    if (restStarted) return;
    restStarted = true;
    void Promise.allSettled([
      api.billing().then((b) => billingIn.set(b), () => billingIn.set(null)),
      api.allocation().then((a) => allocationIn.set(a), () => allocationIn.set(null)),
    ]).then(() => api.value().then((v) => valueIn.set(v), () => valueIn.set(null)));
  };
  effect(() => {
    const r = period();
    const controller = new AbortController();
    overviewIn.set(undefined);
    void api.overview(r, controller.signal).then(
      (o) => { if (!controller.signal.aborted) overviewIn.set(o); },
      () => { if (!controller.signal.aborted) overviewIn.set(null); },
    ).finally(readTheRest);
    onCleanup(() => controller.abort());
  });

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
      h('div', { class: 'sheet' },
        () => {
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
        h('span', { text: 'Dashboard runs locally; provider traffic follows your configured egress boundary.' }),
        h('a', { href: '/classic', text: 'Classic dashboard' })));

  });
}

boot();
