from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def read(p: str) -> str:
    return (ROOT / p).read_text(encoding='utf-8')

def write(p: str, s: str) -> None:
    q = ROOT / p
    q.parent.mkdir(parents=True, exist_ok=True)
    q.write_text(s, encoding='utf-8')

def replace_once(p: str, old: str, new: str) -> None:
    s = read(p)
    if s.count(old) != 1:
        raise SystemExit(f'{p}: expected one target, found {s.count(old)}')
    write(p, s.replace(old, new, 1))

# ---- Registry truth + explicit gap reasons --------------------------------
reg = read('src/dashboard/web/app/core/registry.ts')
reg = reg.replace("  warning?: string;\n}", "  warning?: string;\n  /** Why GUI coverage is incomplete; required at runtime for non-full rows. */\n  gapReason?: string;\n  /** Safest currently-supported path while the GUI gap remains. */\n  safeAlternative?: string;\n}", 1)
reg = reg.replace('export const CAPABILITIES: readonly Capability[] = [', 'const RAW_CAPABILITIES: readonly Capability[] = [', 1)
reg = reg.replace("  { id: 'report', label: 'Period report', plain: 'A summary you can hand to someone.', territory: 'spend', consequence: 'read', coverage: 'partial', command: 'fiscus report' },",
                  "  { id: 'report', label: 'Record an outcome', plain: 'Attach a tested, shipped, incident, or non-code outcome signal to one unit of work.', territory: 'value', consequence: 'local', coverage: 'partial', command: 'fiscus report --kind <kind>' },", 1)
reg = reg.replace("  { id: 'budget-recommend', label: 'Suggest a budget', plain: 'Propose a cap from your actual history.', territory: 'control', consequence: 'read', coverage: 'partial', command: 'fiscus budget --recommend' },",
                  "  { id: 'budget-recommend', label: 'Suggest a budget', plain: 'Propose a cap from your actual history.', territory: 'control', consequence: 'read', coverage: 'full', command: 'fiscus budget --recommend' },", 1)
old_warning = "warning: 'This is the only action in Fiscus that sends data off this machine. It transmits signed aggregate rollups to the team server you configured — never raw requests, prompts, or file contents. The team server is separately gated and is not approved for internet-facing deployment.',"
new_warning = "warning: 'Sends signed aggregate rollups to the team server you configured — never raw requests, prompts, or file contents. Other explicit provider, refresh, judge, webhook, and billing actions may also use the network; the local dashboard itself does not.',"
if old_warning not in reg:
    raise SystemExit('registry team-push warning target missing')
reg = reg.replace(old_warning, new_warning, 1)
marker = "];\n\nexport function byTerritory"
if reg.count(marker) != 1:
    raise SystemExit('registry array terminator missing')
gaps = r'''];

const GAP_DETAILS: Readonly<Record<string, { reason: string; safeAlternative: string }>> = {
  report: { reason: 'Outcome recording mutates the local evidence ledger and needs a unit/kind form plus preview semantics.', safeAlternative: 'Use fiscus report with an immutable commit or session id.' },
  alerts: { reason: 'The GUI renders active alerts, but webhook configuration and delivery are still CLI-only.', safeAlternative: 'Review alerts here; configure or notify a webhook with fiscus alerts.' },
  'project-alias': { reason: 'Project coverage is visible, but alias mutation has no reviewed GUI form yet.', safeAlternative: 'Preview project coverage here; use fiscus project alias/unalias for the mutation.' },
  'billing-pull': { reason: 'Credential-backed provider access is intentionally not launched from the browser yet.', safeAlternative: 'Check readiness here, then use fiscus billing openai-costs pull explicitly.' },
  receipt: { reason: 'Value evidence is visible, but receipt emission/verification and key pinning remain CLI workflows.', safeAlternative: 'Use fiscus receipt for signed receipt operations.' },
  evidence: { reason: 'The GUI shows evidence state, but signed CI artifact import/emit workflows remain CLI-only.', safeAlternative: 'Use fiscus evidence for signed artifact operations.' },
  audit: { reason: 'Audit results have no dedicated browser report yet.', safeAlternative: 'Use fiscus audit --repo <path>.' },
  saved: { reason: 'The Realized screen exposes return/value evidence, but the detailed reclaimed-time breakdown remains CLI-only.', safeAlternative: 'Use fiscus saved --repo <path> for the detailed breakdown.' },
  yield: { reason: 'Durability is represented in realized outcomes, but the dedicated durable-lines-per-dollar report has no browser view.', safeAlternative: 'Use fiscus yield --repo <path>.' },
  judge: { reason: 'The server has a guarded judge endpoint, but the browser has no reviewed session/tier consent flow yet.', safeAlternative: 'Use fiscus judge; algorithmic judging is the default and hosted judging remains explicit opt-in.' },
  connect: { reason: 'Connection recipes can change external tool configuration and need tool-specific previews.', safeAlternative: 'Use fiscus connect <tool>; write-capable variants require their explicit CLI flag.' },
  baseline: { reason: 'Baseline evidence is consumed by value calculations, but refresh/source management has no browser surface.', safeAlternative: 'Use fiscus baseline to inspect or explicitly refresh a configured source.' },
  demo: { reason: 'Demo state is supported by read surfaces, but generation/clearing is not exposed as a reviewed browser action.', safeAlternative: 'Use fiscus demo or fiscus demo --clear.' },
  pricing: { reason: 'Pricing provenance is shown in spend/value surfaces, but the complete coverage report is not a dedicated GUI view.', safeAlternative: 'Use fiscus pricing --coverage; refresh is an explicit network action.' },
  doctor: { reason: 'Setup state is visible across screens, but the consolidated diagnostic report has no browser renderer.', safeAlternative: 'Use fiscus doctor.' },
  exec: { reason: 'Wrapping an arbitrary local command is too consequential for a generic browser button and requires command/exit-code semantics.', safeAlternative: 'Use fiscus exec -- <command> explicitly.' },
  team: { reason: 'The local value screen exposes privacy-safe cohort summaries, but the complete team CLI workflow has no dedicated browser view.', safeAlternative: 'Use fiscus team; named self-view remains subject to its existing privacy gates.' },
  reprice: { reason: 'Historical repricing rewrites recorded money and needs a dedicated diff/confirmation workflow.', safeAlternative: 'Use fiscus reprice dry-run first; add --apply only after reviewing the exact changes.' },
  'team-push': { reason: 'Cross-machine egress needs a destination/identity/TLS review before a browser action is safe.', safeAlternative: 'Use fiscus team push --dry-run, then supply the team-server URL explicitly.' },
  prune: { reason: 'Pruning is irreversible and needs retention/backup-aware confirmation beyond the generic drawer.', safeAlternative: 'Back up the ledger if needed, then use fiscus prune explicitly.' },
};

export const CAPABILITIES: readonly Capability[] = RAW_CAPABILITIES.map((cap) => {
  if (cap.coverage === 'full') return cap;
  const detail = GAP_DETAILS[cap.id];
  return detail ? { ...cap, ...detail } : cap;
});

export function byTerritory'''
reg = reg.replace(marker, gaps, 1)
write('src/dashboard/web/app/core/registry.ts', reg)

# ---- Actions: live cap truth + complete safe budget recommendation reader ---
actions = read('src/dashboard/web/app/core/actions.ts')
actions = actions.replace("   * place a number typed by an operator becomes enforcement configuration -- so\n   * the preview states the enforcement gap (the running proxy keeps the old\n   * value until restart) as a row of the preview, not as a footnote under it.\n",
                          "   * place a number typed by an operator becomes enforcement configuration.\n   * The running guard reads live configuration; the preview therefore names the\n   * real boundary (future in-path requests), not a stale restart requirement.\n", 1)
actions = actions.replace("{\n              label: 'Takes effect',\n              value: 'on proxy restart',\n              note: 'the running proxy keeps enforcing the previous value until it is restarted',\n            },",
                          "{\n              label: 'Takes effect',\n              value: 'immediately for future in-path requests',\n              note: 'the running proxy reads the saved budget configuration live',\n            },", 1)
actions = actions.replace("message: `Saved. The daily cap is now ${saved === null ? 'unlimited' : usd(saved)}. Restart Fiscus for the proxy to begin enforcing it.`,",
                          "message: `Saved. The daily cap is now ${saved === null ? 'unlimited' : usd(saved)} and applies to subsequent requests that pass through the running proxy.`,", 1)
insert = r'''

  'budget-recommend': (cap) => ({
    capability: cap,
    preview: async (): Promise<PreviewResult> => {
      const value = await api.value();
      const advice = value.budget ?? null;
      if (!advice) {
        return {
          applicable: false,
          blockedReason: 'No budget recommendation is available from the current evidence.',
          summary: 'Fiscus has no recommendation to show yet. This is missing evidence, not a $0 recommendation.',
        };
      }
      return {
        applicable: false,
        blockedReason: 'Read-only recommendation. Use the Budgets action if you decide to apply a cap.',
        summary: advice.canApply
          ? `Recommendation derived from ${count(advice.basisDays)} active day(s) of observed spend.`
          : `Only ${count(advice.basisDays)} active day(s) support this review; Fiscus will not present it as apply-ready yet.`,
        rows: [
          { label: 'Recommended daily', value: advice.recommendedDailyUsd == null ? 'not established' : usd(advice.recommendedDailyUsd) },
          { label: 'Recommended soft', value: advice.recommendedSoftUsd == null ? 'not established' : usd(advice.recommendedSoftUsd) },
          { label: 'Evidence days', value: count(advice.basisDays), note: `minimum ${count(advice.minActiveDays)} active days` },
          { label: 'Status', value: advice.status },
        ],
        notes: advice.rationale ?? [],
      };
    },
  }),
'''
needle = "\n  export: (cap) => ({"
if actions.count(needle) != 1:
    raise SystemExit('actions export insertion marker missing')
actions = actions.replace(needle, insert + needle, 1)
# fallback uses explicit gap metadata
old = "notes: ['The System section lists exactly which capabilities the GUI covers and which it does not.'],"
new = "notes: [cap.gapReason ?? 'The System section lists exactly which capabilities the GUI covers and which it does not.', cap.safeAlternative ? `Safe alternative: ${cap.safeAlternative}` : ''],"
actions = actions.replace(old, new, 1)
write('src/dashboard/web/app/core/actions.ts', actions)

# ---- Pure claim layer builder + Claim Inspector ----------------------------
write('src/dashboard/web/app/core/claimLayers.ts', r'''import type { Overview, BillingPayload, AllocationPayload, ValuePayload } from './contracts.ts';
import type { Layer } from '../components/spine.ts';

export interface ClaimInputs {
  overview: Overview | null;
  billing: BillingPayload | null;
  allocation: AllocationPayload | null;
  value: ValuePayload | null;
}

const iso = (ms: number | null | undefined): string => typeof ms === 'number' ? new Date(ms).toISOString() : 'not established';

export function buildClaimLayers(input: ClaimInputs, range: string): Layer[] {
  const { overview: o, billing: b, allocation: a, value: v } = input;
  const estimatedShare = o?.pricing.estimatedSpendShare ?? null;
  const metered: Layer = {
    id: 'metered', label: 'Metered', claim: 'what we observed', valueUsd: o?.summary.costUsd ?? null,
    established: o !== null,
    basis: o === null ? 'could not read the ledger' : 'counted from requests, priced from a rate card',
    nextStep: o === null ? 'Check that Fiscus is running.' : undefined,
    inspection: {
      provenance: 'local request ledger + recorded pricing basis',
      scope: o ? `${range}; ${o.summary.requests} recorded request(s)` : range,
      freshness: o?.generatedAt ?? 'computed from the current ledger read',
      coverage: estimatedShare === null ? 'pricing coverage unavailable' : `${Math.round((1 - estimatedShare) * 100)}% of spend not estimated`,
      enforceability: 'observation claim; local caps can govern future in-path requests but do not make metered cost billed cost',
      evidenceSource: 'local request ledger',
      assumptions: ['Rate-card cost is an estimate unless provider billing evidence establishes a billed amount.'],
      missingEvidence: o === null ? ['readable local ledger'] : estimatedShare && estimatedShare > 0 ? ['exact rate-card matches for estimated rows'] : [],
    },
  };

  const latestRun = b?.reconciliation?.runs?.[0] ?? null;
  const runs = b?.reconciliation?.runs?.length ?? 0;
  const billed: Layer = {
    id: 'billed', label: 'Billed', claim: 'what the provider charged', valueUsd: null, established: runs > 0,
    basis: runs > 0 ? 'reconciled against a provider report, with a residual' : b && b.summary.recordCount > 0 ? `${b.summary.recordCount} provider records held, none reconciled yet` : 'no provider bill has been compared against this ledger',
    nextStep: runs > 0 ? undefined : 'Check readiness in Evidence before spending a credential on it.',
    inspection: {
      provenance: latestRun?.result.providerSourceKind ?? (b?.summary.recordCount ? 'operator-supplied provider evidence' : 'none'),
      scope: latestRun ? `reconciliation run ${latestRun.reconciliationRunId}` : 'no reconciled provider scope',
      freshness: latestRun ? iso(latestRun.computedAtMs) : 'not established',
      coverage: b ? `${b.summary.recordCount} provider evidence record(s); ${runs} reconciliation run(s)` : 'billing endpoint unavailable',
      enforceability: 'evidence claim only; reconciliation does not change provider billing or local caps',
      evidenceSource: latestRun?.result.providerSourceKind ?? 'provider evidence not established',
      assumptions: latestRun?.result.conditions ? [...latestRun.result.conditions] : [],
      missingEvidence: runs > 0 ? [] : ['a compatible provider observation/export', 'a completed reconciliation run'],
    },
  };

  const allocRuns = Array.isArray(a?.runs) ? a.runs.length : 0;
  const centres = Array.isArray(a?.costCentres) ? a.costCentres.length : 0;
  const allocated: Layer = {
    id: 'allocated', label: 'Allocated', claim: 'whose cost it is', valueUsd: null, established: allocRuns > 0,
    basis: allocRuns > 0 ? 'apportioned by recorded rules — showback only' : centres > 0 ? `${centres} cost centre${centres === 1 ? '' : 's'} defined, no allocation recorded` : 'no cost centres and no rules yet',
    nextStep: allocRuns > 0 ? undefined : 'Define a cost centre, then run an allocation.',
    inspection: {
      provenance: a?.basis ?? 'no allocation basis recorded',
      scope: a ? `${centres} cost centre(s); ${a.rules.length} rule version(s); ${allocRuns} immutable run(s)` : 'allocation endpoint unavailable',
      freshness: a?.reconciliation?.latestComputedAtMs ? iso(a.reconciliation.latestComputedAtMs) : 'no related reconciliation timestamp established',
      coverage: a?.excludedFrom?.length ? `excluded from: ${a.excludedFrom.join(', ')}` : (a ? 'allocation payload available' : 'unavailable'),
      enforceability: 'showback/accounting claim; allocation does not enforce provider spend or chargeback by itself',
      evidenceSource: 'recorded local cost centres, rule versions, and immutable allocation runs',
      assumptions: a ? [`trust class: ${a.trust}`, `allocation kind: ${a.kind}`] : [],
      missingEvidence: allocRuns > 0 ? [] : ['at least one reviewed allocation rule', 'an applied immutable allocation run'],
    },
  };

  const matured = v?.realization?.matured;
  const realizedUnits = matured?.realizedUnits ?? 0;
  const ret = v?.roi?.returnRatio ?? null;
  const valued = ret?.basis === 'usd' && typeof ret.realizedValueUsd === 'number';
  const realized: Layer = {
    id: 'realized', label: 'Realized', claim: 'what it produced', valueUsd: valued ? (ret?.realizedValueUsd ?? null) : null,
    established: realizedUnits > 0 && valued,
    basis: realizedUnits === 0 ? 'no work units have matured into verified outcomes' : valued ? `${realizedUnits} of ${matured?.units ?? 0} matured units shipped and survived; manual-equivalent value, net of rework` : `${realizedUnits} of ${matured?.units ?? 0} units matured, but no labour rate is set to price what they produced`,
    nextStep: realizedUnits === 0 ? 'Connect a repository so outcomes can be observed.' : valued ? undefined : 'Set a labour rate so realized work can be priced.',
    inspection: {
      provenance: v?.valueSource ?? 'no outcome source established',
      scope: v?.projectScoped === true ? 'project-scoped outcomes and attributed spend' : v?.projectScoped === false ? 'window-scoped cost basis; may include unrelated spend' : 'scope not established',
      freshness: v?.gitRepo ? 'derived from live repository history on read' : 'derived from persisted outcome evidence on read',
      coverage: typeof v?.roi?.coverage === 'number' ? `${Math.round(v.roi.coverage * 100)}% RoI lens coverage` : 'RoI coverage not established',
      enforceability: 'outcome/value claim; it is never used as proof that a provider or local budget was enforced',
      evidenceSource: v?.gitRepo ? 'repository history + recorded outcome signals' : (v?.valueSource ?? 'none'),
      assumptions: v?.roi?.notes ?? [],
      missingEvidence: realizedUnits === 0 ? ['matured outcome evidence'] : valued ? [] : ['labour-rate/value basis for monetary realization'],
    },
  };
  return [metered, billed, allocated, realized];
}
''')

write('src/dashboard/web/app/core/chain.ts', r'''/** Transport wrapper for the pure four-claim builder. */
import { api } from './api.ts';
import type { Layer } from '../components/spine.ts';
import { buildClaimLayers } from './claimLayers.ts';

export async function loadChain(range: string): Promise<Layer[]> {
  const [overview, billing, allocation, value] = await Promise.allSettled([
    api.overview(range), api.billing(), api.allocation(), api.value(),
  ]);
  const ok = <T,>(r: PromiseSettledResult<T>): T | null => r.status === 'fulfilled' ? r.value : null;
  return buildClaimLayers({ overview: ok(overview), billing: ok(billing), allocation: ok(allocation), value: ok(value) }, range);
}
''')

write('src/dashboard/web/app/components/claimInspector.ts', r'''import { h } from '../core/dom.ts';
import { signal } from '../core/signal.ts';
import { usd, isPrecise } from '../core/fmt.ts';
import type { Layer } from './spine.ts';

const active = signal<Layer | null>(null);
export function openClaimInspector(layer: Layer): void { active.set(layer); }
export function closeClaimInspector(): void { active.set(null); }

function row(label: string, value: string): Node {
  return h('div', { class: 'claim-row' }, h('span', { class: 'claim-key', text: label }), h('span', { class: 'claim-val', text: value }));
}

export function mountClaimInspector(root: HTMLElement): void {
  root.appendChild(h('div', {
    class: () => `claim-inspector${active() ? ' claim-inspector-open' : ''}`,
    'aria-hidden': () => active() ? 'false' : 'true',
  },
    h('button', { class: 'claim-backdrop', 'aria-label': 'Close claim inspector', onclick: closeClaimInspector }),
    () => {
      const layer = active();
      if (!layer) return h('aside', { class: 'claim-panel' });
      const i = layer.inspection;
      return h('aside', { class: 'claim-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': `${layer.label} claim evidence` },
        h('div', { class: 'claim-head' },
          h('div', null, h('span', { class: 'band-label', text: layer.label }), h('h2', { text: layer.claim })),
          h('button', { class: 'claim-close', onclick: closeClaimInspector, 'aria-label': 'Close', text: '×' })),
        h('div', { class: layer.established ? 'claim-figure' : 'claim-figure claim-unset', text: layer.established ? usd(layer.valueUsd) : 'not established' }),
        row(isPrecise() ? 'Basis' : 'What this rests on', layer.basis),
        row('Provenance', i.provenance), row('Scope', i.scope), row('Freshness', i.freshness),
        row('Coverage', i.coverage), row('Enforceability', i.enforceability), row('Evidence source', i.evidenceSource),
        i.assumptions.length ? h('div', { class: 'claim-list' }, h('strong', { text: 'Assumptions / conditions' }), h('ul', null, ...i.assumptions.map((x) => h('li', { text: x })))) : null,
        i.missingEvidence.length ? h('div', { class: 'claim-list claim-missing' }, h('strong', { text: 'Missing evidence' }), h('ul', null, ...i.missingEvidence.map((x) => h('li', { text: x })))) : h('p', { class: 'claim-complete', text: 'No missing evidence is currently named for this claim.' }),
        !layer.established && layer.nextStep ? h('p', { class: 'claim-next', text: `Next action: ${layer.nextStep}` }) : null);
    }));
}
''')

write('src/dashboard/web/app/components/spine.ts', r'''/** The four independent financial claims that organize the GUI. */
import { h } from '../core/dom.ts';
import { usd, isPrecise } from '../core/fmt.ts';
export type LayerId = 'metered' | 'billed' | 'allocated' | 'realized';
export interface ClaimInspection {
  provenance: string; scope: string; freshness: string; coverage: string;
  enforceability: string; evidenceSource: string; assumptions: string[]; missingEvidence: string[];
}
export interface Layer {
  id: LayerId; label: string; claim: string; valueUsd: number | null; established: boolean;
  basis: string; nextStep?: string; inspection: ClaimInspection;
}
export interface SpineState { layers: Layer[]; active: LayerId | null; onSelect: (id: LayerId) => void; onInspect: (layer: Layer) => void; }
function separator(): Node { return h('div', { class: 'sep', 'aria-hidden': 'true' }, h('span', { class: 'sep-glyph', text: '≠' })); }
function band(layer: Layer, state: SpineState): Node {
  const active = state.active === layer.id;
  return h('div', { class: `band${active ? ' band-active' : ''}${layer.established ? '' : ' band-open'}` },
    h('button', { class: 'band-hit', 'aria-current': active ? 'page' : false, onclick: () => state.onSelect(layer.id) },
      h('span', { class: 'band-label', text: layer.label }),
      layer.established ? h('span', { class: 'band-value', text: usd(layer.valueUsd) }) : h('span', { class: 'band-value band-unset', text: 'not established' }),
      h('span', { class: 'band-basis', text: layer.basis }),
      !layer.established && layer.nextStep ? h('span', { class: 'band-next', text: layer.nextStep }) : null),
    h('button', { class: 'band-inspect', onclick: () => state.onInspect(layer), text: isPrecise() ? 'inspect claim' : 'why this number?' }));
}
export function spine(state: SpineState): Node {
  const children: Node[] = [];
  state.layers.forEach((layer, i) => { children.push(band(layer, state)); if (state.layers[i + 1]) children.push(separator()); });
  const open = state.layers.filter((l) => !l.established); const missing = open.map((l) => l.label.toLowerCase());
  return h('section', { class: 'spine', 'aria-label': 'The four claims' }, h('div', { class: 'spine-rail' }, ...children),
    h('p', { class: 'spine-read' }, open.length === 0
      ? (isPrecise() ? 'All four claims are substantiated on this machine, each on its own evidence.' : 'All four of these are backed by evidence on this machine.')
      : (isPrecise() ? `Four separate claims with four evidence standards; ${missing.join(' and ')} ${open.length === 1 ? 'is' : 'are'} unsubstantiated here. An unsubstantiated layer is an absence of evidence, never a measured zero.` : `These are four different questions, not four versions of one number — and we cannot answer ${missing.join(' or ')} yet. That is missing evidence, not an answer of nothing.`)));
}
''')

main = read('src/dashboard/web/app/main.ts')
main = main.replace("import { mountDrawer } from './components/drawer.ts';", "import { mountDrawer } from './components/drawer.ts';\nimport { mountClaimInspector, openClaimInspector } from './components/claimInspector.ts';", 1)
main = main.replace("            onSelect: (id) => go(LAYER_ROUTE[id]),\n", "            onSelect: (id) => go(LAYER_ROUTE[id]),\n            onInspect: openClaimInspector,\n", 1)
main = main.replace("h('span', { text: 'Runs on this machine only. Nothing is sent anywhere.' }),", "h('span', { text: 'Dashboard data stays local. Network access occurs only through explicit provider, refresh, judge, webhook, billing, or team actions.' }),", 1)
main = main.replace("    mountDrawer(root);\n", "    mountDrawer(root);\n    mountClaimInspector(root);\n", 1)
write('src/dashboard/web/app/main.ts', main)

# styles: make the old band container non-button and give each action its own target.
css = read('src/dashboard/web/styles/app.css')
old = """.band {\n  display: flex; flex-direction: column; gap: var(--s2);\n  text-align: left; padding: var(--s4) var(--s4) var(--s5);\n  border: 0; border-top: 2px solid var(--line);\n  background: none; color: inherit; font: inherit; cursor: pointer;\n  transition: border-color var(--t) var(--ease), background var(--t) var(--ease);\n  border-radius: 0 0 var(--r-sm) var(--r-sm);\n  min-width: 0;\n}\n.band:hover { background: var(--panel); }\n"""
new = """.band {\n  display: flex; flex-direction: column; gap: 0;\n  text-align: left; border-top: 2px solid var(--line);\n  background: none; color: inherit;\n  transition: border-color var(--t) var(--ease), background var(--t) var(--ease);\n  border-radius: 0 0 var(--r-sm) var(--r-sm); min-width: 0;\n}\n.band:hover { background: var(--panel); }\n.band-hit { display:flex; flex-direction:column; gap:var(--s2); text-align:left; padding:var(--s4) var(--s4) var(--s3); border:0; background:none; color:inherit; font:inherit; cursor:pointer; min-width:0; }\n.band-inspect { align-self:flex-start; margin:0 var(--s4) var(--s4); padding:3px 7px; border:1px solid var(--line-soft); border-radius:999px; background:none; color:var(--faint); font-family:var(--mono); font-size:10px; cursor:pointer; }\n.band-inspect:hover { color:var(--gold-text); border-color:var(--gold-text); }\n"""
if old not in css:
    raise SystemExit('band CSS target missing')
css = css.replace(old, new, 1)
css += r'''

/* Read-only Claim Inspector: evidence details, not an action confirmation. */
.claim-inspector { position:fixed; inset:0; z-index:80; pointer-events:none; visibility:hidden; }
.claim-inspector-open { pointer-events:auto; visibility:visible; }
.claim-backdrop { position:absolute; inset:0; border:0; background:rgba(0,0,0,.62); cursor:default; }
.claim-panel { position:absolute; top:0; right:0; width:min(560px, 94vw); height:100%; overflow:auto; background:var(--ink-2); border-left:1px solid var(--line); box-shadow:var(--shadow); padding:var(--s6); }
.claim-head { display:flex; justify-content:space-between; gap:var(--s4); align-items:flex-start; padding-bottom:var(--s4); border-bottom:1px solid var(--line-soft); }
.claim-head h2 { font-family:var(--serif); font-size:22px; font-weight:500; margin-top:var(--s1); }
.claim-close { border:0; background:none; color:var(--muted); font-size:28px; cursor:pointer; line-height:1; }
.claim-figure { font-family:var(--mono); font-size:30px; margin:var(--s5) 0; }
.claim-unset { color:var(--faint); font-family:var(--sans); font-style:italic; font-size:18px; }
.claim-row { display:grid; grid-template-columns:minmax(120px,.65fr) minmax(0,1.35fr); gap:var(--s3); padding:var(--s3) 0; border-top:1px solid var(--line-soft); }
.claim-key { color:var(--faint); font-family:var(--mono); font-size:11px; text-transform:uppercase; letter-spacing:.08em; }
.claim-val { color:var(--text); overflow-wrap:anywhere; }
.claim-list { margin-top:var(--s5); padding:var(--s4); background:var(--panel); border:1px solid var(--line-soft); border-radius:var(--r-sm); }
.claim-list ul { padding-left:var(--s5); margin-top:var(--s2); color:var(--muted); }
.claim-missing { border-style:dashed; }
.claim-complete { margin-top:var(--s5); color:var(--mint); }
.claim-next { margin-top:var(--s5); color:var(--gold-text); }
'''
write('src/dashboard/web/styles/app.css', css)

# System parity table exposes reason and safe alternative.
system = read('src/dashboard/web/app/views/system.ts')
system = system.replace("            h('th', { text: 'Here' }),\n            h('th', { text: 'Command' }))),",
                        "            h('th', { text: 'Here' }),\n            h('th', { text: 'Gap / safe alternative' }),\n            h('th', { text: 'Command' }))),", 1)
system = system.replace("            h('td', null, h('span', { class: c.coverage === 'planned' ? 'tag tag-planned' : 'tag', text: COVERAGE_WORDS[c.coverage] ?? c.coverage })),\n            h('td', null, h('code', { class: 'cmd', style: 'white-space: nowrap', text: c.command })))))))),",
                        "            h('td', null, h('span', { class: c.coverage === 'planned' ? 'tag tag-planned' : 'tag', text: COVERAGE_WORDS[c.coverage] ?? c.coverage })),\n            h('td', null, c.coverage === 'full' ? h('span', { class: 'action-plain', text: '—' }) : h('span', { class: 'action-plain', text: `${c.gapReason ?? 'gap not described'} Safe alternative: ${c.safeAlternative ?? c.command}` })),\n            h('td', null, h('code', { class: 'cmd', style: 'white-space: nowrap', text: c.command })))))))),", 1)
write('src/dashboard/web/app/views/system.ts', system)

# Tests: registry truth and pure claim-layer behavior.
write('test/dashboard-registry-truth.test.ts', r'''import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CAPABILITIES, paritySummary } from '../src/dashboard/web/app/core/registry.ts';

test('every non-full GUI capability names the gap and a safe alternative', () => {
  for (const cap of CAPABILITIES) {
    if (cap.coverage === 'full') continue;
    assert.ok(cap.gapReason?.trim(), `${cap.id} missing gapReason`);
    assert.ok(cap.safeAlternative?.trim(), `${cap.id} missing safeAlternative`);
  }
});

test('report is represented as a local evidence mutation, not a read-only period report', () => {
  const report = CAPABILITIES.find((c) => c.id === 'report');
  assert.equal(report?.consequence, 'local');
  assert.equal(report?.territory, 'value');
  assert.match(report?.plain ?? '', /Attach|outcome/i);
});

test('safe budget recommendation is now fully readable in the GUI without applying anything', () => {
  const cap = CAPABILITIES.find((c) => c.id === 'budget-recommend');
  assert.equal(cap?.coverage, 'full');
  const p = paritySummary();
  assert.equal(p.total, CAPABILITIES.length);
  assert.ok(p.full >= 25);
});

test('network wording never says Fiscus has only one egress path', () => {
  const reg = readFileSync(new URL('../src/dashboard/web/app/core/registry.ts', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../src/dashboard/web/app/main.ts', import.meta.url), 'utf8');
  assert.ok(!reg.includes('only action in Fiscus that sends data off this machine'));
  assert.ok(!main.includes('Nothing is sent anywhere.'));
});

test('budget drawer describes live enforcement rather than a restart requirement', () => {
  const actions = readFileSync(new URL('../src/dashboard/web/app/core/actions.ts', import.meta.url), 'utf8');
  assert.ok(!actions.includes('on proxy restart'));
  assert.ok(!actions.includes('Restart Fiscus for the proxy'));
  assert.match(actions, /immediately for future in-path requests/);
});
''')

write('test/claim-layers.test.ts', r'''import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClaimLayers } from '../src/dashboard/web/app/core/claimLayers.ts';

const empty = () => buildClaimLayers({ overview: null, billing: null, allocation: null, value: null }, '30d');

test('Claim Inspector metadata exists for all four independent claims and missing claims remain missing, never zero', () => {
  const layers = empty();
  assert.deepEqual(layers.map((x) => x.id), ['metered', 'billed', 'allocated', 'realized']);
  for (const layer of layers) {
    assert.equal(layer.established, false);
    assert.equal(layer.valueUsd, null);
    assert.ok(layer.inspection.provenance);
    assert.ok(layer.inspection.scope);
    assert.ok(layer.inspection.freshness);
    assert.ok(layer.inspection.coverage);
    assert.ok(layer.inspection.enforceability);
    assert.ok(layer.inspection.evidenceSource);
    assert.ok(layer.inspection.missingEvidence.length > 0);
  }
});

test('metered evidence never promotes itself into billed evidence', () => {
  const [metered, billed] = buildClaimLayers({
    overview: { demo:false, range:'30d', generatedAt:'now', summary:{requests:3,costUsd:1.25}, pricing:{status:{fresh:true},estimatedCostUsd:0,estimatedSpendShare:0}, byModel:[],byProject:[],bySource:[],series:[],recent:[] },
    billing: { demo:false, evidence:{reconciliationStatus:'never'}, summary:{recordCount:0}, reconciliation:{runs:[]} },
    allocation:null, value:null,
  }, '30d');
  assert.equal(metered?.established, true);
  assert.equal(metered?.valueUsd, 1.25);
  assert.equal(billed?.established, false);
  assert.equal(billed?.valueUsd, null);
});

test('allocation and realized inspections state their non-enforcement boundaries explicitly', () => {
  const layers = buildClaimLayers({
    overview:null, billing:null,
    allocation:{demo:false,kind:'showback',trust:'local_rule',basis:'metered',excludedFrom:['provider bill'],costCentres:[{id:'a'}],rules:[],runs:[{}],reconciliation:{everRun:false,latestComputedAtMs:null}},
    value:{demo:false,allocation:null,valueSource:'store',gitRepo:false,projectScoped:true,realization:{matured:{units:2,realizedUnits:1,realizationRate:.5,totalCostUsd:2,realizedValueUsd:1}},roi:{coverage:.5,returnRatio:{basis:'usd',realizedValueUsd:4}}},
  }, '30d');
  assert.match(layers[2]!.inspection.enforceability, /showback/i);
  assert.match(layers[3]!.inspection.enforceability, /outcome\/value claim/i);
});
''')

print('phase4 GUI truth batch applied')
