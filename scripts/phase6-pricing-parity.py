from pathlib import Path

root = Path(__file__).resolve().parents[1]

def read(path: str) -> str:
    return (root / path).read_text(encoding='utf-8')

def write(path: str, text: str) -> None:
    p = root / path
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding='utf-8')

def replace_once(path: str, old: str, new: str) -> None:
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected one target, found {count}')
    write(path, text.replace(old, new, 1))

# ---------------------------------------------------------------------------
# Canonical browser/server contract for the exact read-only pricing coverage
# report the CLI already exposes.
# ---------------------------------------------------------------------------
contracts = 'src/dashboard/web/app/core/contracts.ts'
replace_once(
    contracts,
    '''export interface Overview {\n  demo: boolean;''',
    '''export interface PricingStatusSnapshot {\n  source?: string;\n  sourceKind?: string;\n  sourceUrl?: string | null;\n  stale?: boolean;\n  fresh?: boolean;\n  ageDays?: number | null;\n  modelCount?: number;\n  cacheIntegrity?: string;\n  fetchedAt?: string | null;\n  updated?: string;\n  freshnessBasis?: string;\n  cardSha256?: string | null;\n}\n\n/** One immutable pricing-evidence cohort captured on request rows. */\nexport interface PricingEvidenceRow {\n  provider: string;\n  model: string;\n  costBasis: string;\n  rateCardSha256: string | null;\n  rateCardSourceKind: string;\n  rateMatchKind: string;\n  rateMatchProvider: string | null;\n  rateMatchModel: string | null;\n  requests: number;\n  costUsd: number;\n  estimatedCostUsd: number;\n  inputTokens: number;\n  outputTokens: number;\n}\n\nexport interface PricingCoveragePayload {\n  demo: boolean;\n  generatedAt: string;\n  window: { startMs: number; endMs: number; label: string };\n  activeRateCard: PricingStatusSnapshot;\n  total: { costUsd: number; requests: number };\n  provenance: PricingEvidenceRow[];\n  boundary: string;\n}\n\nexport interface Overview {\n  demo: boolean;''',
)
replace_once(
    contracts,
    '''    status: { fresh?: boolean; ageDays?: number | null } | string;\n    autoRefresh?: boolean;\n    estimatedCostUsd: number;\n    estimatedSpendShare: number;\n    provenance?: unknown;''',
    '''    status: PricingStatusSnapshot | string;\n    autoRefresh?: boolean;\n    estimatedCostUsd: number;\n    estimatedSpendShare: number;\n    provenance?: PricingEvidenceRow[];''',
)

# ---------------------------------------------------------------------------
# Typed API client. This path is GET-only; it never refreshes a card or reprices
# history.
# ---------------------------------------------------------------------------
api = 'src/dashboard/web/app/core/api.ts'
replace_once(
    api,
    '''import type { Summary, GroupRow, SeriesPoint, AlertRow, Overview, BillingPayload, CostCentre, AllocationRule, AllocationPayload, Matured, ValuePayload, BudgetAdvice, BudgetConfig, SettingsSnapshot, Importer, ScanPayload, ImportResult, HealthPayload } from './contracts.ts';\nexport type { Summary, GroupRow, SeriesPoint, AlertRow, Overview, BillingPayload, CostCentre, AllocationRule, AllocationPayload, Matured, ValuePayload, BudgetAdvice, BudgetConfig, SettingsSnapshot, Importer, ScanPayload, ImportResult, HealthPayload } from './contracts.ts';''',
    '''import type { Summary, GroupRow, SeriesPoint, AlertRow, Overview, PricingCoveragePayload, BillingPayload, CostCentre, AllocationRule, AllocationPayload, Matured, ValuePayload, BudgetAdvice, BudgetConfig, SettingsSnapshot, Importer, ScanPayload, ImportResult, HealthPayload } from './contracts.ts';\nexport type { Summary, GroupRow, SeriesPoint, AlertRow, Overview, PricingCoveragePayload, BillingPayload, CostCentre, AllocationRule, AllocationPayload, Matured, ValuePayload, BudgetAdvice, BudgetConfig, SettingsSnapshot, Importer, ScanPayload, ImportResult, HealthPayload } from './contracts.ts';''',
)
replace_once(
    api,
    '''  overview: (range: string) => request<Overview>(`/api/overview?range=${encodeURIComponent(range)}`),\n  billing: () => request<BillingPayload>('/api/billing'),''',
    '''  overview: (range: string) => request<Overview>(`/api/overview?range=${encodeURIComponent(range)}`),\n  pricingCoverage: (window: { days?: number; all?: boolean } = {}) => {\n    const query = window.all ? 'all=1' : `days=${encodeURIComponent(String(window.days ?? 30))}`;\n    return request<PricingCoveragePayload>(`/api/pricing?${query}`);\n  },\n  billing: () => request<BillingPayload>('/api/billing'),''',
)

# ---------------------------------------------------------------------------
# Server: exact CLI-equivalent coverage model, with arbitrary positive --days
# or all-time. No network, no writes, no repricing.
# ---------------------------------------------------------------------------
server = 'src/dashboard/server.ts'
replace_once(
    server,
    '''import type { Overview } from './web/app/core/contracts.ts';''',
    '''import type { Overview, PricingCoveragePayload } from './web/app/core/contracts.ts';''',
)
insert_after = '''function buildOverview(store: Store, config: AegisConfig, range: RangeKey): Overview {'''
# Add helper after buildOverview by anchoring on the next section comment.
anchor = '''/**\n * Server-side view of the importers: where each tool's local data lives, whether\n * it's present on this machine, and how to read it. Lets non-CLI users click to\n * meter their tools from the dashboard — same engines as `fiscus import`.\n */'''
helper = r'''/**
 * The same immutable pricing-provenance read model as `fiscus pricing
 * --coverage`. Keeping it server-side means the CLI and GUI both group rows by
 * the evidence captured at metering time; neither can accidentally merge two
 * cards/match paths or reinterpret a historical request after a refresh.
 */
function buildPricingCoverage(
  store: Store,
  config: AegisConfig,
  opts: { all: boolean; days: number },
  now = Date.now(),
): PricingCoveragePayload {
  const day = 24 * 60 * 60 * 1000;
  const startMs = opts.all ? 0 : now - opts.days * day;
  const endMs = now + 1000;
  const label = opts.all ? 'all recorded time' : `last ${opts.days} day${opts.days === 1 ? '' : 's'}`;
  const total = store.summary(startMs, endMs);
  return {
    demo: isDemo(),
    generatedAt: new Date(now).toISOString(),
    window: { startMs, endMs, label },
    activeRateCard: pricingStatus(config.pricing.maxAgeDays),
    total: { costUsd: total.costUsd, requests: total.requests },
    provenance: store.pricingEvidenceByModel(startMs, endMs),
    boundary: 'Captured local pricing evidence only. It does not fetch pricing, reprice history, or represent any amount as provider-billed or reconciled cost.',
  };
}

'''
replace_once(server, anchor, helper + anchor)

route_anchor = '''    // Provider billing evidence has a different truth contract from the local\n    // request ledger: an operator supplied it, Fiscus has not verified it with'''
route = r'''    // Exact read-only counterpart of `fiscus pricing --coverage`. `all=1`
    // takes precedence over days, matching the CLI's --all behavior. This route
    // never calls refreshPricing and never rewrites historical request costs.
    if (url.pathname === '/api/pricing') {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'text/plain', allow: 'GET' });
        res.end('method not allowed');
        return;
      }
      const all = url.searchParams.has('all');
      const daysRaw = url.searchParams.get('days');
      const days = daysRaw === null ? 30 : Number(daysRaw);
      if (!all && (!Number.isFinite(days) || days <= 0)) {
        return json(res, 400, { error: 'days must be a positive number (or use all=1)' });
      }
      try {
        return json(res, 200, buildPricingCoverage(store, config, { all, days }));
      } catch (err) {
        return json(res, 500, { error: String(err) });
      }
    }

'''
replace_once(server, route_anchor, route + route_anchor)

# ---------------------------------------------------------------------------
# GUI action: same window choice and complete cohort list. Read-only, so there is
# no commit callback and no accidental path from coverage inspection to refresh.
# ---------------------------------------------------------------------------
actions = 'src/dashboard/web/app/core/actions.ts'
replace_once(
    actions,
    '''import { isPrecise, usd, count } from './fmt.ts';''',
    '''import { isPrecise, usd, count, pct } from './fmt.ts';''',
)
action_anchor = '''  settings: (cap) => ({'''
pricing_action = r'''  pricing: (cap) => {
    const days = signal<string>('30');
    const all = signal<boolean>(false);
    return {
      capability: cap,
      fields: () => h('div', null,
        h('label', { class: 'drawer-h3', for: 'pricing-days-input' }, 'Coverage window'),
        h('div', { class: 'facts' },
          h('label', { class: 'fact' },
            h('span', { class: 'fact-key', text: 'Last N days' }),
            h('input', {
              id: 'pricing-days-input', class: 'drawer-input', type: 'number', min: '0.000001', step: '1',
              value: '30', disabled: () => all(),
              oninput: (event: Event) => days.set((event.target as HTMLInputElement).value),
            })),
          h('label', { class: 'fact' },
            h('span', { class: 'fact-key', text: 'All recorded time' }),
            h('input', {
              type: 'checkbox', checked: () => all(),
              onchange: (event: Event) => all.set((event.target as HTMLInputElement).checked),
            })))),
      preview: async (): Promise<PreviewResult> => {
        const parsedDays = Number(days());
        if (!all() && (!Number.isFinite(parsedDays) || parsedDays <= 0)) {
          return {
            applicable: false,
            blockedReason: 'Enter a positive number of days, or choose all recorded time.',
            summary: 'Pricing coverage was not read because the requested window is invalid.',
          };
        }
        const payload = await api.pricingCoverage(all() ? { all: true } : { days: parsedDays });
        const status = payload.activeRateCard;
        const source = status.source === 'cache'
          ? `${status.sourceKind ?? 'cached'} local cache`
          : status.source === 'bundled'
            ? 'bundled package card'
            : status.source ?? 'unknown source';
        const freshness = status.stale === true
          ? `stale${status.ageDays == null ? '' : ` · ${count(status.ageDays)}d old`}`
          : `current${status.ageDays == null ? '' : ` · ${count(status.ageDays)}d old`}`;
        const estimated = payload.provenance.reduce((sum, row) => sum + row.estimatedCostUsd, 0);
        const cohortRows = payload.provenance.map((row) => ({
          label: `${row.provider}/${row.model}`,
          value: usd(row.costUsd),
          note: `${count(row.requests)} req · ${row.costBasis.replaceAll('_', ' ')} · ${row.rateMatchKind.replaceAll('_', ' ')} · ${row.rateCardSourceKind} · ${row.rateCardSha256?.slice(0, 12) ?? 'no card'}`,
        }));
        return {
          applicable: false,
          blockedReason: 'Read-only pricing evidence. Refreshing a rate card and repricing history are separate explicit actions.',
          summary: `Pricing provenance for ${payload.window.label}. Every cohort preserves the evidence captured when its requests were metered.`,
          rows: [
            { label: 'Active rate card', value: source, note: `${freshness}${status.modelCount == null ? '' : ` · ${count(status.modelCount)} models`}` },
            { label: 'Recorded amount', value: usd(payload.total.costUsd), note: `${count(payload.total.requests)} request(s)` },
            { label: 'Estimated-rate share', value: payload.total.costUsd > 0 ? pct(estimated / payload.total.costUsd, 1) : '0%', note: `${usd(estimated)} of this window used estimated pricing evidence` },
            ...cohortRows,
          ],
          notes: [payload.boundary, 'Changing or refreshing the active rate card does not rewrite the provenance shown for historical requests.'],
        };
      },
    };
  },

'''
replace_once(actions, action_anchor, pricing_action + action_anchor)

# Registry can now make the claim: the default command's complete read-only
# coverage operation is runnable with arbitrary days/all from the GUI.
registry = 'src/dashboard/web/app/core/registry.ts'
replace_once(
    registry,
    "  { id: 'pricing', label: 'Pricing', plain: 'The rate cards used to estimate cost.', territory: 'system', consequence: 'read', coverage: 'partial', command: 'fiscus pricing --coverage' },",
    "  { id: 'pricing', label: 'Pricing', plain: 'The rate cards used to estimate cost.', territory: 'system', consequence: 'read', coverage: 'full', command: 'fiscus pricing --coverage' },",
)
replace_once(
    registry,
    "  pricing: { reason: 'Pricing provenance is shown in spend/value surfaces, but the complete coverage report is not a dedicated GUI view.', safeAlternative: 'Use fiscus pricing --coverage; refresh is an explicit network action.' },\n",
    '',
)

system = 'src/dashboard/web/app/views/system.ts'
replace_once(
    system,
    '''      h('div', { class: 'actions' },\n        actionCard('settings'),\n        actionCard('doctor'),''',
    '''      h('div', { class: 'actions' },\n        actionCard('settings'),\n        actionCard('pricing'),\n        actionCard('doctor'),''',
)

# ---------------------------------------------------------------------------
# Regression tests: API equality/boundaries and registry truth.
# ---------------------------------------------------------------------------
write('test/dashboard-pricing-coverage.test.ts', r'''import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { Store, type RequestRow } from '../src/store/db.ts';
import { createDashboardServer } from '../src/dashboard/server.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';

function row(): RequestRow {
  return {
    requestId: 'dashboard-pricing-coverage-fixture', sessionId: null, tsEpochMs: Date.now(),
    provider: 'openai', model: 'gpt-5', project: 'fixture', taskWeight: 1,
    inputTokens: 100, outputTokens: 20, cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0,
    costUsd: 1.25, estimated: false, streamed: false, statusCode: 200, durationMs: 1,
    pricing: {
      costBasis: 'local_list_price', rateCardSha256: 'c'.repeat(64), rateCardSourceKind: 'bundled',
      rateMatchKind: 'exact_provider', rateMatchProvider: 'openai', rateMatchModel: 'gpt-5',
    },
  };
}

function boot(store: Store): Promise<{ base: string; close: () => Promise<void> }> {
  const server: http.Server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'test' });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

test('GET /api/pricing reproduces the immutable pricing --coverage evidence model without mutation or network', async () => {
  const store = new Store(':memory:');
  store.insertRequest(row());
  const srv = await boot(store);
  try {
    const response = await fetch(`${srv.base}/api/pricing?all=1`);
    assert.equal(response.status, 200);
    const body = await response.json() as {
      window: { label: string };
      total: { costUsd: number; requests: number };
      provenance: Array<Record<string, unknown>>;
      boundary: string;
    };
    assert.equal(body.window.label, 'all recorded time');
    assert.deepEqual(body.total, { costUsd: 1.25, requests: 1 });
    assert.deepEqual(body.provenance, [{
      provider: 'openai', model: 'gpt-5', costBasis: 'local_list_price', rateCardSha256: 'c'.repeat(64),
      rateCardSourceKind: 'bundled', rateMatchKind: 'exact_provider', rateMatchProvider: 'openai', rateMatchModel: 'gpt-5',
      requests: 1, costUsd: 1.25, estimatedCostUsd: 0, inputTokens: 100, outputTokens: 20,
    }]);
    assert.match(body.boundary, /does not fetch pricing, reprice history/i);
    assert.match(body.boundary, /provider-billed or reconciled cost/i);
    assert.equal(store.summary(0, Date.now() + 1000).requests, 1, 'GET coverage must not mutate the ledger');
  } finally {
    await srv.close();
    store.close();
  }
});

test('/api/pricing validates the window and is GET-only', async () => {
  const store = new Store(':memory:');
  const srv = await boot(store);
  try {
    const invalid = await fetch(`${srv.base}/api/pricing?days=0`);
    assert.equal(invalid.status, 400);
    assert.match(await invalid.text(), /positive number/);
    const post = await fetch(`${srv.base}/api/pricing?days=30`, { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET');
  } finally {
    await srv.close();
    store.close();
  }
});
''')

write('test/dashboard-pricing-parity.test.ts', r'''import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { capability, paritySummary } from '../src/dashboard/web/app/core/registry.ts';
import { hasRunner } from '../src/dashboard/web/app/core/actions.ts';

const root = process.cwd();

test('Pricing is full only because the GUI runs the complete read-only coverage path', () => {
  const cap = capability('pricing');
  assert.ok(cap);
  assert.equal(cap.coverage, 'full');
  assert.equal(cap.consequence, 'read');
  assert.equal(hasRunner(cap), true);
  const actions = readFileSync(join(root, 'src/dashboard/web/app/core/actions.ts'), 'utf8');
  assert.match(actions, /api\.pricingCoverage/);
  assert.match(actions, /does not rewrite the provenance shown for historical requests/);
  assert.match(actions, /Refreshing a rate card and repricing history are separate explicit actions/);
});

test('pricing parity promotion changes only the honest parity count', () => {
  assert.deepEqual(paritySummary(), { total: 45, full: 26, partial: 14, planned: 5 });
});
''')

print('phase6 pricing parity applied')
