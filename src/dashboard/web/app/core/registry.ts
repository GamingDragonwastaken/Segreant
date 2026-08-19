/**
 * The parity map.
 *
 * The GUI is meant to reach full parity with the CLI. A claim like that is worth
 * nothing unless it is checkable, and this product's whole argument is that
 * important claims should be inspectable — so parity is a data structure, not a
 * promise in a README. Every CLI capability is listed here with its territory,
 * its consequence, and its honest GUI status. The Settings surface renders this
 * table, so a gap is visible to the operator instead of discovered by them.
 *
 * Adding a CLI verb without adding its row is the one change this file exists to
 * make awkward.
 */

/** Where an operator would look for this, thinking about their job rather than the command name. */
export type Territory = 'spend' | 'control' | 'allocation' | 'evidence' | 'value' | 'data' | 'system';

/**
 * What happens if this runs. The tier drives how much the GUI makes you say yes:
 * `read` runs on click, `local` previews first, `credential` and `egress` state
 * exactly what leaves and require a deliberate confirm, `destructive` requires
 * typing the thing being destroyed.
 */
export type Consequence = 'read' | 'local' | 'credential' | 'egress' | 'destructive';

/** Honest state of the GUI surface for this capability. */
export type Coverage = 'full' | 'partial' | 'planned';

export interface Capability {
  /** Stable id, used for routing and for the parity table. */
  id: string;
  /** What the operator is trying to do, in their words. */
  label: string;
  /** One line, plain register — shown to someone who has never seen the CLI. */
  plain: string;
  territory: Territory;
  consequence: Consequence;
  coverage: Coverage;
  /** The equivalent command. Shown beside every action: the developer's shortcut and the audit trail. */
  command: string;
  /** Stated only where a consequence needs naming out loud before it happens. */
  warning?: string;
  /** Why GUI coverage is incomplete; required at runtime for non-full rows. */
  gapReason?: string;
  /** Safest currently-supported path while the GUI gap remains. */
  safeAlternative?: string;
}

export const TERRITORIES: ReadonlyArray<{ id: Territory; label: string; plain: string; icon: string }> = [
  { id: 'spend', label: 'Spend', plain: 'What AI is costing you, and where it went.', icon: 'meter' },
  { id: 'control', label: 'Control', plain: 'Budgets and alerts, so nothing surprises you.', icon: 'shield' },
  { id: 'allocation', label: 'Allocation', plain: 'Whose cost this is — projects and cost centres.', icon: 'split' },
  { id: 'evidence', label: 'Evidence', plain: 'Whether the numbers hold up against the provider bill.', icon: 'seal' },
  { id: 'value', label: 'Value', plain: 'What the spend produced, with the limits stated.', icon: 'yield' },
  { id: 'data', label: 'Data', plain: 'Getting your usage in, from tools and providers.', icon: 'inflow' },
  { id: 'system', label: 'System', plain: 'Pricing, settings, maintenance, and this table.', icon: 'gear' },
];

const RAW_CAPABILITIES: readonly Capability[] = [
  // ---- Spend --------------------------------------------------------------
  { id: 'today', label: 'Today', plain: 'What today has cost so far.', territory: 'spend', consequence: 'read', coverage: 'full', command: 'fiscus today' },
  { id: 'week', label: 'This week', plain: 'The last seven days of spend.', territory: 'spend', consequence: 'read', coverage: 'full', command: 'fiscus week' },
  { id: 'month', label: 'This month', plain: 'The current month of spend.', territory: 'spend', consequence: 'read', coverage: 'full', command: 'fiscus month' },
  { id: 'usage', label: 'Usage detail', plain: 'Requests and tokens broken down.', territory: 'spend', consequence: 'read', coverage: 'full', command: 'fiscus usage' },
  { id: 'report', label: 'Record an outcome', plain: 'Attach a tested, shipped, incident, or non-code outcome signal to one unit of work.', territory: 'value', consequence: 'local', coverage: 'partial', command: 'fiscus report --kind <kind>' },
  { id: 'export', label: 'Export CSV', plain: 'Download the ledger as a spreadsheet.', territory: 'spend', consequence: 'read', coverage: 'full', command: 'fiscus export' },

  // ---- Control ------------------------------------------------------------
  { id: 'budget', label: 'Budgets', plain: 'Set a spending cap and see how close you are.', territory: 'control', consequence: 'local', coverage: 'full', command: 'fiscus budget' },
  { id: 'budget-recommend', label: 'Suggest a budget', plain: 'Propose a cap from your actual history.', territory: 'control', consequence: 'read', coverage: 'full', command: 'fiscus budget --recommend' },
  { id: 'alerts', label: 'Alerts', plain: 'Get told before a cap is hit, not after.', territory: 'control', consequence: 'local', coverage: 'partial', command: 'fiscus alerts' },
  { id: 'exec', label: 'Run under a cap', plain: 'Run a command with a hard spending limit around it.', territory: 'control', consequence: 'local', coverage: 'planned', command: 'fiscus exec -- <command>' },

  // ---- Allocation ---------------------------------------------------------
  { id: 'project', label: 'Projects', plain: 'Which project each request belongs to, and how we know.', territory: 'allocation', consequence: 'read', coverage: 'full', command: 'fiscus project --coverage' },
  { id: 'project-alias', label: 'Merge project names', plain: 'Treat two names as the same project.', territory: 'allocation', consequence: 'local', coverage: 'partial', command: 'fiscus project alias' },
  { id: 'alloc-centres', label: 'Cost centres', plain: 'The teams or budgets that carry the cost.', territory: 'allocation', consequence: 'local', coverage: 'full', command: 'fiscus alloc centre' },
  { id: 'alloc-rules', label: 'Allocation rules', plain: 'How spend is split across cost centres.', territory: 'allocation', consequence: 'local', coverage: 'full', command: 'fiscus alloc rule' },
  { id: 'alloc-run', label: 'Run an allocation', plain: 'Apply the rules to a period and record the result.', territory: 'allocation', consequence: 'local', coverage: 'full', command: 'fiscus alloc run --apply' },

  // ---- Evidence -----------------------------------------------------------
  { id: 'billing-scope', label: 'Declare a provider scope', plain: 'Say which provider project this machine is metering.', territory: 'evidence', consequence: 'local', coverage: 'full', command: 'fiscus billing scope set' },
  { id: 'billing-readiness', label: 'Reconciliation readiness', plain: 'Whether a provider check would actually match anything.', territory: 'evidence', consequence: 'read', coverage: 'full', command: 'fiscus billing reconcile' },
  { id: 'billing-adopt', label: 'Adopt a provider export', plain: 'Use a costs file you exported, with no credential.', territory: 'evidence', consequence: 'local', coverage: 'full', command: 'fiscus billing openai-costs adopt --apply' },
  {
    id: 'billing-pull', label: 'Pull provider costs', plain: 'Read your bill directly from the provider.',
    territory: 'evidence', consequence: 'credential', coverage: 'partial', command: 'fiscus billing openai-costs pull',
    warning: 'Reads an OpenAI Admin credential from your environment and makes a network request to OpenAI. Fiscus never stores it. Check readiness first — on a ledger with no proxy traffic on the declared route, a pull reports your entire bill as unexplained.',
  },
  { id: 'billing-reconcile', label: 'Reconcile', plain: 'Compare what we metered against what you were billed.', territory: 'evidence', consequence: 'local', coverage: 'full', command: 'fiscus billing reconcile --apply' },
  { id: 'receipt', label: 'Receipts', plain: 'The evidence behind a single claim.', territory: 'evidence', consequence: 'read', coverage: 'partial', command: 'fiscus receipt' },
  { id: 'evidence', label: 'Evidence records', plain: 'Signed CI artifacts and verified outcomes.', territory: 'evidence', consequence: 'read', coverage: 'partial', command: 'fiscus evidence' },
  { id: 'audit', label: 'Audit', plain: 'Check the ledger against itself for inconsistencies.', territory: 'evidence', consequence: 'read', coverage: 'partial', command: 'fiscus audit' },

  // ---- Value --------------------------------------------------------------
  { id: 'roi', label: 'Return on Intelligence', plain: 'What the spend produced, with the limits stated.', territory: 'value', consequence: 'read', coverage: 'full', command: 'fiscus roi' },
  { id: 'realize', label: 'Realized value', plain: 'Work that actually shipped, not work that was proposed.', territory: 'value', consequence: 'local', coverage: 'full', command: 'fiscus realize' },
  { id: 'frontier', label: 'Model comparison', plain: 'Whether a cheaper model would have done the same job.', territory: 'value', consequence: 'read', coverage: 'full', command: 'fiscus frontier' },
  { id: 'saved', label: 'Savings', plain: 'What routing decisions have avoided so far.', territory: 'value', consequence: 'read', coverage: 'partial', command: 'fiscus saved' },
  { id: 'yield', label: 'Yield', plain: 'Output per dollar across projects.', territory: 'value', consequence: 'read', coverage: 'partial', command: 'fiscus yield' },
  { id: 'judge', label: 'Judge', plain: 'Score a change on quality, not just cost.', territory: 'value', consequence: 'local', coverage: 'partial', command: 'fiscus judge' },
  { id: 'team', label: 'Team view', plain: 'Per-person value on this machine, anonymized.', territory: 'value', consequence: 'read', coverage: 'planned', command: 'fiscus team' },

  // ---- Data ---------------------------------------------------------------
  { id: 'sources', label: 'Sources', plain: 'Which tools are feeding data in.', territory: 'data', consequence: 'read', coverage: 'full', command: 'fiscus sources' },
  { id: 'discover', label: 'Find tools', plain: 'Look for AI tools installed on this machine.', territory: 'data', consequence: 'read', coverage: 'full', command: 'fiscus discover' },
  { id: 'connect', label: 'Connect a tool', plain: 'Point a tool at Fiscus so its spend is metered.', territory: 'data', consequence: 'local', coverage: 'partial', command: 'fiscus connect <tool>' },
  { id: 'import', label: 'Import history', plain: 'Read past usage out of tool logs on this machine.', territory: 'data', consequence: 'local', coverage: 'full', command: 'fiscus import all' },
  { id: 'scan', label: 'Scan', plain: 'Check what is available to import before importing.', territory: 'data', consequence: 'read', coverage: 'full', command: 'fiscus scan' },
  { id: 'baseline', label: 'Baselines', plain: 'The before-AI reference this compares against.', territory: 'data', consequence: 'local', coverage: 'partial', command: 'fiscus baseline' },
  { id: 'demo', label: 'Demo data', plain: 'Load labelled sample data to see how it works.', territory: 'data', consequence: 'local', coverage: 'partial', command: 'fiscus demo' },

  // ---- System -------------------------------------------------------------
  { id: 'settings', label: 'Settings', plain: 'How Fiscus behaves on this machine.', territory: 'system', consequence: 'local', coverage: 'full', command: 'fiscus config' },
  { id: 'pricing', label: 'Pricing', plain: 'The rate cards used to estimate cost.', territory: 'system', consequence: 'read', coverage: 'full', command: 'fiscus pricing --coverage' },
  {
    id: 'reprice', label: 'Reprice history', plain: 'Recalculate past costs against a corrected rate card.',
    territory: 'system', consequence: 'destructive', coverage: 'planned', command: 'fiscus reprice --apply',
    warning: 'Rewrites the recorded cost of past requests. Value snapshots are re-attributed on their own basis, and outcomes are never moved — but the money figures you have already reported will change.',
  },
  { id: 'doctor', label: 'Doctor', plain: 'Check that everything is wired up correctly.', territory: 'system', consequence: 'read', coverage: 'partial', command: 'fiscus doctor' },
  { id: 'guide', label: 'What next', plain: 'The most useful next step, given your setup.', territory: 'system', consequence: 'read', coverage: 'full', command: 'fiscus guide' },
  {
    id: 'team-push', label: 'Push to team server', plain: 'Send a signed, aggregated rollup to your team server.',
    territory: 'system', consequence: 'egress', coverage: 'planned', command: 'fiscus team push',
    warning: 'Sends signed aggregate rollups to the team server you configured — never raw requests, prompts, or file contents. Other explicit provider, refresh, judge, webhook, and billing actions may also use the network; the local dashboard itself does not.',
  },
  {
    id: 'prune', label: 'Delete old data', plain: 'Permanently remove records past the retention window.',
    territory: 'system', consequence: 'destructive', coverage: 'planned', command: 'fiscus prune',
    warning: 'Permanently deletes ledger rows. There is no undo and no backup unless you made one. Derived records that referenced the deleted rows keep their recorded amounts and become unverifiable.',
  },
  {
    id: 'clear-proposals', label: 'Clear proposals', plain: 'Discard captured AI proposals.',
    territory: 'system', consequence: 'destructive', coverage: 'full', command: 'fiscus config --clear-proposals',
    warning: 'Permanently deletes captured proposals. Acceptance rates computed from them cannot be recomputed afterwards.',
  },
];

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
  doctor: { reason: 'Setup state is visible across screens, but the consolidated diagnostic report has no browser renderer.', safeAlternative: 'Use fiscus doctor.' },
  exec: { reason: 'Wrapping an arbitrary local command is too consequential for a generic browser button and requires command/exit-code semantics.', safeAlternative: 'Use fiscus exec -- <command> explicitly.' },
  team: { reason: 'The local value screen exposes privacy-safe cohort summaries, but the complete team CLI workflow has no dedicated browser view.', safeAlternative: 'Use fiscus team; named self-view remains subject to its existing privacy gates.' },
  reprice: { reason: 'Historical repricing rewrites recorded money and needs a dedicated diff/confirmation workflow.', safeAlternative: 'Use fiscus reprice dry-run first; add --apply only after reviewing the exact changes.' },
  'team-push': { reason: 'Cross-machine egress needs a destination/identity/TLS review before a browser action is safe.', safeAlternative: 'Use fiscus team push --dry-run, then supply the team-server URL explicitly.' },
  prune: { reason: 'Pruning is irreversible and needs retention/backup-aware confirmation beyond the generic drawer.', safeAlternative: 'Back up the ledger if needed, then use fiscus prune explicitly.' },
};

export const CAPABILITIES: readonly Capability[] = RAW_CAPABILITIES.map((cap) => {
  if (cap.coverage === 'full') return cap;
  const detail = GAP_DETAILS[cap.id] ?? {
    reason: 'GUI coverage is incomplete for this capability and no narrower reviewed browser workflow exists yet.',
    safeAlternative: `Use ${cap.command} explicitly.`,
  };
  return { ...cap, gapReason: detail.reason, safeAlternative: detail.safeAlternative };
});

export function byTerritory(territory: Territory): Capability[] {
  return CAPABILITIES.filter((c) => c.territory === territory);
}

export function capability(id: string): Capability | undefined {
  return CAPABILITIES.find((c) => c.id === id);
}

export interface ParitySummary {
  total: number;
  full: number;
  partial: number;
  planned: number;
}

export function paritySummary(): ParitySummary {
  return {
    total: CAPABILITIES.length,
    full: CAPABILITIES.filter((c) => c.coverage === 'full').length,
    partial: CAPABILITIES.filter((c) => c.coverage === 'partial').length,
    planned: CAPABILITIES.filter((c) => c.coverage === 'planned').length,
  };
}
