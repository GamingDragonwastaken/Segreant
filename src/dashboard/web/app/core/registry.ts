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
}

/** Machine-readable contract for a capability and every surface that binds it. */
export type CapabilityAuthority = 'fiscus_local' | 'operator' | 'provider' | 'external_service';
export type CapabilityEgress = 'none' | 'local_filesystem' | 'loopback' | 'declared_cloud' | 'team_server';
export type CapabilityCredentials = 'none' | 'local_tool_logs' | 'operator_environment';
export type CapabilityReversibility = 'read_only' | 'append_only' | 'config_reversible' | 'destructive' | 'external_irreversible';
export type CapabilityAssurance = 'display' | 'recommendation' | 'reviewed_local_apply' | 'credentialed_review' | 'external_egress_review' | 'destructive_confirmation';
export type CapabilitySchemaKind = 'none' | 'flags' | 'file' | 'command' | 'json';

export interface CapabilitySchema {
  kind: CapabilitySchemaKind;
  required: readonly string[];
  optional: readonly string[];
}

export interface CapabilityBindings {
  cli: string;
  api: readonly string[];
  gui: readonly ('modern' | 'classic' | 'action')[];
  docs: readonly string[];
}

export interface CapabilitySpec extends Capability {
  schemaVersion: 1;
  inputSchema: CapabilitySchema;
  previewSchema: CapabilitySchema;
  outputSchema: CapabilitySchema;
  authority: CapabilityAuthority;
  egress: CapabilityEgress;
  credentials: CapabilityCredentials;
  reversibility: CapabilityReversibility;
  assurance: CapabilityAssurance;
  bindings: CapabilityBindings;
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

export const CAPABILITIES: readonly Capability[] = [
  // ---- Spend --------------------------------------------------------------
  { id: 'today', label: 'Today', plain: 'What today has cost so far.', territory: 'spend', consequence: 'read', coverage: 'full', command: 'fiscus today' },
  { id: 'week', label: 'This week', plain: 'The last seven days of spend.', territory: 'spend', consequence: 'read', coverage: 'full', command: 'fiscus week' },
  { id: 'month', label: 'This month', plain: 'The current month of spend.', territory: 'spend', consequence: 'read', coverage: 'full', command: 'fiscus month' },
  { id: 'usage', label: 'Usage detail', plain: 'Requests and tokens broken down.', territory: 'spend', consequence: 'read', coverage: 'full', command: 'fiscus usage' },
  { id: 'report', label: 'Period report', plain: 'A summary you can hand to someone.', territory: 'spend', consequence: 'read', coverage: 'partial', command: 'fiscus report' },
  { id: 'export', label: 'Export CSV', plain: 'Download the ledger as a spreadsheet.', territory: 'spend', consequence: 'read', coverage: 'full', command: 'fiscus export' },

  // ---- Control ------------------------------------------------------------
  { id: 'budget', label: 'Budgets', plain: 'Set a spending cap and see how close you are.', territory: 'control', consequence: 'local', coverage: 'full', command: 'fiscus budget' },
  { id: 'budget-recommend', label: 'Suggest a budget', plain: 'Propose a cap from your actual history.', territory: 'control', consequence: 'read', coverage: 'partial', command: 'fiscus budget --recommend' },
  { id: 'alerts', label: 'Alerts', plain: 'Get told before a cap is hit, not after.', territory: 'control', consequence: 'local', coverage: 'partial', command: 'fiscus alerts' },
  { id: 'exec', label: 'Run under a cap', plain: 'Run a command with a hard spending limit around it.', territory: 'control', consequence: 'local', coverage: 'planned', command: 'fiscus exec -- <command>' },

  // ---- Allocation ---------------------------------------------------------
  { id: 'project', label: 'Projects', plain: 'Which project each request belongs to, and how we know.', territory: 'allocation', consequence: 'read', coverage: 'full', command: 'fiscus project --coverage' },
  { id: 'project-alias', label: 'Merge project names', plain: 'Treat two names as the same project.', territory: 'allocation', consequence: 'local', coverage: 'partial', command: 'fiscus project alias' },
  { id: 'alloc-centres', label: 'Cost centres', plain: 'The teams or budgets that carry the cost.', territory: 'allocation', consequence: 'local', coverage: 'partial', command: 'fiscus alloc centre' },
  { id: 'alloc-rules', label: 'Allocation rules', plain: 'How spend is split across cost centres.', territory: 'allocation', consequence: 'local', coverage: 'partial', command: 'fiscus alloc rule' },
  { id: 'alloc-run', label: 'Run an allocation', plain: 'Apply the rules to a period and record the result.', territory: 'allocation', consequence: 'local', coverage: 'partial', command: 'fiscus alloc run --apply' },

  // ---- Evidence -----------------------------------------------------------
  { id: 'billing-scope', label: 'Declare a provider scope', plain: 'Say which provider project this machine is metering.', territory: 'evidence', consequence: 'local', coverage: 'partial', command: 'fiscus billing scope set' },
  { id: 'billing-readiness', label: 'Reconciliation readiness', plain: 'Whether a provider check would actually match anything.', territory: 'evidence', consequence: 'read', coverage: 'full', command: 'fiscus billing reconcile' },
  { id: 'billing-adopt', label: 'Adopt a provider export', plain: 'Use a costs file you exported, with no credential.', territory: 'evidence', consequence: 'local', coverage: 'partial', command: 'fiscus billing openai-costs adopt --apply' },
  {
    id: 'billing-pull', label: 'Pull provider costs', plain: 'Read your bill directly from the provider.',
    territory: 'evidence', consequence: 'credential', coverage: 'partial', command: 'fiscus billing openai-costs pull',
    warning: 'Reads an OpenAI Admin credential from your environment and makes a network request to OpenAI. Fiscus never stores it. Check readiness first — on a ledger with no proxy traffic on the declared route, a pull reports your entire bill as unexplained.',
  },
  { id: 'billing-reconcile', label: 'Reconcile', plain: 'Compare what we metered against what you were billed.', territory: 'evidence', consequence: 'local', coverage: 'partial', command: 'fiscus billing reconcile --apply' },
  { id: 'receipt', label: 'Receipts', plain: 'The evidence behind a single claim.', territory: 'evidence', consequence: 'read', coverage: 'partial', command: 'fiscus receipt' },
  { id: 'evidence', label: 'Evidence records', plain: 'Signed CI artifacts and verified outcomes.', territory: 'evidence', consequence: 'read', coverage: 'partial', command: 'fiscus evidence' },
  { id: 'audit', label: 'Audit', plain: 'Check the ledger against itself for inconsistencies.', territory: 'evidence', consequence: 'read', coverage: 'partial', command: 'fiscus audit' },

  // ---- Value --------------------------------------------------------------
  { id: 'roi', label: 'Return on Intelligence', plain: 'What the spend produced, with the limits stated.', territory: 'value', consequence: 'read', coverage: 'full', command: 'fiscus roi' },
  { id: 'causal', label: 'Causal studies', plain: 'Registered randomized evidence and its qualification gates.', territory: 'value', consequence: 'local', coverage: 'partial', command: 'fiscus causal status' },
  { id: 'realize', label: 'Realized value', plain: 'Work that actually shipped, not work that was proposed.', territory: 'value', consequence: 'local', coverage: 'partial', command: 'fiscus realize' },
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
  {
    id: 'egress', label: 'Egress assurance', plain: 'Which cloud routes Fiscus itself may use, with local receipts.',
    territory: 'system', consequence: 'egress', coverage: 'partial', command: 'fiscus egress status',
    warning: 'The dashboard shows Fiscus-process status and receipt-chain health. Use the CLI to plan or apply an exact cloud permission. This is not a machine-wide firewall or a provider-retention guarantee.',
  },
  { id: 'settings', label: 'Settings', plain: 'How Fiscus behaves on this machine.', territory: 'system', consequence: 'local', coverage: 'partial', command: 'fiscus config' },
  { id: 'pricing', label: 'Pricing', plain: 'The rate cards used to estimate cost.', territory: 'system', consequence: 'read', coverage: 'partial', command: 'fiscus pricing --coverage' },
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
    warning: 'This is the team-server rollup action. It transmits signed aggregate rollups to the team server you configured — never raw requests, prompts, or file contents. Other explicit outbound paths are documented in DATA-BOUNDARIES.md. The team server is separately gated and is not approved for internet-facing deployment.',
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

type CapabilityMetadata = Omit<CapabilitySpec, keyof Capability>;
type CapabilityMetadataOverride = Partial<Omit<CapabilityMetadata, 'bindings'>> & {
  bindings?: Partial<CapabilityBindings>;
};

function schema(kind: CapabilitySchemaKind, required: readonly string[] = [], optional: readonly string[] = []): CapabilitySchema {
  return Object.freeze({
    kind,
    required: Object.freeze([...required]),
    optional: Object.freeze([...optional]),
  });
}

const API_BINDINGS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  today: ['/api/overview'], week: ['/api/overview'], month: ['/api/overview'], usage: ['/api/value'], report: ['/api/value'], export: ['/api/export.csv'],
  budget: ['/api/settings/update'], 'budget-recommend': ['/api/value'], alerts: ['/api/overview'], project: ['/api/overview'], 'project-alias': ['/api/settings/update'],
  'alloc-centres': ['/api/allocation'], 'alloc-rules': ['/api/allocation'], 'alloc-run': ['/api/allocation'], 'billing-scope': ['/api/billing'],
  'billing-readiness': ['/api/billing'], 'billing-adopt': ['/api/billing'], 'billing-pull': ['/api/billing'], 'billing-reconcile': ['/api/billing'], receipt: ['/api/value'], evidence: ['/api/billing'], audit: ['/api/billing'],
  roi: ['/api/value'], causal: ['/api/causal'], realize: ['/api/value'], frontier: ['/api/value'], saved: ['/api/value'], yield: ['/api/value'], judge: ['/api/judge'], team: ['/api/value'],
  sources: ['/api/overview'], discover: ['/api/importers'], connect: ['/api/importers'], import: ['/api/import'], scan: ['/api/scan'], baseline: ['/api/value'], demo: ['/api/overview'],
  egress: ['/api/settings'], settings: ['/api/settings', '/api/settings/update'], pricing: ['/api/overview'], reprice: ['/api/value'], doctor: ['/api/guide'], guide: ['/api/guide'], 'team-push': [], prune: ['/api/settings'], 'clear-proposals': ['/api/settings/clear-proposals'],
});

const DOC_BINDINGS: Readonly<Record<Territory, readonly string[]>> = Object.freeze({
  spend: ['docs/GETTING-STARTED.md', 'docs/ARCHITECTURE.md'],
  control: ['docs/GETTING-STARTED.md', 'docs/THE-STANDARD.md'],
  allocation: ['docs/ALLOCATION.md', 'docs/ARCHITECTURE.md'],
  evidence: ['docs/EVIDENCE-PROVENANCE.md', 'docs/PROVIDER-RECONCILIATION.md'],
  value: ['docs/RETURN-ON-INTELLIGENCE.md', 'docs/METHODOLOGY.md'],
  data: ['docs/INTEGRATIONS.md', 'docs/DATA-BOUNDARIES.md'],
  system: ['docs/ARCHITECTURE.md', 'docs/RELEASE-GATE.md'],
});

const CAPABILITY_METADATA_OVERRIDES: Readonly<Record<string, CapabilityMetadataOverride>> = Object.freeze({
  'billing-pull': { authority: 'operator', egress: 'declared_cloud', credentials: 'operator_environment', assurance: 'credentialed_review' },
  egress: { egress: 'declared_cloud', assurance: 'external_egress_review' },
  'team-push': { egress: 'team_server', reversibility: 'external_irreversible', assurance: 'external_egress_review' },
  connect: { egress: 'local_filesystem', credentials: 'local_tool_logs' },
  import: { egress: 'local_filesystem', credentials: 'local_tool_logs' },
  scan: { egress: 'local_filesystem', credentials: 'local_tool_logs' },
  reprice: { reversibility: 'destructive', assurance: 'destructive_confirmation' },
  prune: { reversibility: 'destructive', assurance: 'destructive_confirmation' },
  'clear-proposals': { reversibility: 'destructive', assurance: 'destructive_confirmation' },
});

function capabilityMetadata(capability: Capability): CapabilityMetadata {
  const inputSchema = capability.id === 'exec'
    ? schema('command', ['command'], ['kind', 'commit', 'session'])
    : capability.id === 'export'
      ? schema('flags', [], ['days', 'all', 'out', 'json'])
      : capability.consequence === 'read'
        ? schema('flags', [], ['json', 'days', 'all'])
        : schema('flags', [], ['apply', 'json']);
  const defaults: CapabilityMetadata = {
    schemaVersion: 1,
    inputSchema,
    previewSchema: schema('json', ['applicable', 'summary'], ['blockedReason', 'rows', 'notes']),
    outputSchema: schema(capability.coverage === 'planned' ? 'none' : 'json'),
    authority: capability.consequence === 'read' ? 'fiscus_local' : 'operator',
    egress: 'none',
    credentials: 'none',
    reversibility: capability.consequence === 'destructive'
      ? 'destructive'
      : capability.consequence === 'read'
        ? 'read_only'
        : 'append_only',
    assurance: capability.consequence === 'read'
      ? 'display'
      : capability.consequence === 'credential'
        ? 'credentialed_review'
        : capability.consequence === 'egress'
          ? 'external_egress_review'
          : capability.consequence === 'destructive'
            ? 'destructive_confirmation'
            : capability.coverage === 'partial'
              ? 'reviewed_local_apply'
              : 'recommendation',
    bindings: {
      cli: capability.command,
      api: Object.freeze([...(API_BINDINGS[capability.id] ?? [])]),
      gui: Object.freeze(capability.coverage === 'planned' ? [] : ['modern']),
      docs: Object.freeze([...(DOC_BINDINGS[capability.territory] ?? [])]),
    },
  };
  const override = CAPABILITY_METADATA_OVERRIDES[capability.id] ?? {};
  return Object.freeze({
    ...defaults,
    ...override,
    bindings: Object.freeze({ ...defaults.bindings, ...(override.bindings ?? {}) }),
  });
}

/** Canonical capability contract consumed by the System view and future generators. */
export const CAPABILITY_SPECS: readonly CapabilitySpec[] = Object.freeze(
  CAPABILITIES.map((capability) => Object.freeze({ ...capability, ...capabilityMetadata(capability) })),
);

export function capabilitySpec(id: string): CapabilitySpec | undefined {
  return CAPABILITY_SPECS.find((spec) => spec.id === id);
}

export function byTerritory(territory: Territory): Capability[] {
  return CAPABILITY_SPECS.filter((c) => c.territory === territory);
}

export function capability(id: string): Capability | undefined {
  return CAPABILITY_SPECS.find((c) => c.id === id);
}

export interface ParitySummary {
  total: number;
  full: number;
  partial: number;
  planned: number;
}

export function paritySummary(): ParitySummary {
  return {
    total: CAPABILITY_SPECS.length,
    full: CAPABILITY_SPECS.filter((c) => c.coverage === 'full').length,
    partial: CAPABILITY_SPECS.filter((c) => c.coverage === 'partial').length,
    planned: CAPABILITY_SPECS.filter((c) => c.coverage === 'planned').length,
  };
}
