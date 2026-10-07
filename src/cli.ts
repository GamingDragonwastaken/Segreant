/**
 * Segreant command-line interface.
 *
 *   segreant start            start the proxy + local dashboard
 *   segreant today|week|month show spend for a window  (--json for raw)
 *   segreant init             write a default config and print setup steps
 *   segreant budget ...       set soft/hard caps
 *   segreant audit --repo .   correlate spend with git commits
 *   segreant config           show config + paths
 *   segreant prune            prune old rows and compact the database
 */

import './util/quiet.ts';
import { demoDbPath, envOverrideKey } from './config.ts';
import { packageVersion } from './version.ts';

import { parseFlags, UserInputError } from './cli/flags.ts';

// Command modules load on demand. Importing every command up front cost about
// two seconds on every invocation, `--help` included; a command now pays only
// for its own module graph. All specifiers are literal, so the import-closure
// walk in test/support/importGraph.ts still sees every edge.
const importCmd = () => import('./cli/importCmd.ts');
const billingCmd = () => import('./cli/billingCmd.ts');
const allocCmd = () => import('./cli/allocCmd.ts');
const evidenceCmd = () => import('./cli/evidenceCmd.ts');
const valueCmd = () => import('./cli/valueCmd.ts');
const teamCmd = () => import('./cli/teamCmd.ts');
const connectCmd = () => import('./cli/connectCmd.ts');
const egressCmd = () => import('./cli/egressCmd.ts');
const causalCmd = () => import('./cli/causalCmd.ts');
const capitalCmd = () => import('./cli/capitalCmd.ts');
const opsCmd = () => import('./cli/opsCmd.ts');
const showCmd = () => import('./cli/showCmd.ts');
const runCmd = () => import('./cli/runCmd.ts');
const launchCmd = () => import('./cli/launchCmd.ts');
const backupCmd = () => import('./cli/backupCmd.ts');
const diagnosticsCmd = () => import('./cli/diagnosticsCmd.ts');
const packCmd = () => import('./cli/packCmd.ts');
const pluginCmd = () => import('./cli/pluginCmd.ts');
const economicCmd = () => import('./cli/economicCmd.ts');
const outcomeCmd = () => import('./cli/outcomeCmd.ts');
const controlCmd = () => import('./cli/controlCmd.ts');
const featuresCmd = () => import('./cli/featuresCmd.ts');
const marketCmd = () => import('./cli/marketCmd.ts');

/**
 * The first screen a new user reads. It lists only the commands a first week
 * needs; `segreant help all` keeps the complete reference one word away.
 */
function cmdHelpShort(): void {
  console.log(`
  Segreant — meter and cap what your AI coding agents spend, locally.

  Usage: segreant <command> [options]

  Get started
    guide                 Where you are and the single next step (bare "segreant")
    scan                  Find the AI tools and git repos on this machine and preview
                          a setup plan; --setup imports and correlates them
    demo --serve          Every screen on clearly-labeled synthetic data, no API key

  Every day
    today | week | month  Spend for a window                        (--json)
    start                 Start the proxy and the local dashboard
    launch -- <command>   Run a tool metered through the proxy while it runs
    budget                Set caps: --daily N --soft N --session N --runaway N
    realize --repo <path> How much of the AI spend became verified, durable work

  More
    doctor                Health check: config, database, proxy, caps, data quality
    help all              Every command and flag
    --version             Print the Segreant version
`);
}

function cmdHelp(): void {
  console.log(`
  Segreant — meter and cap what your AI coding agents spend, locally.

  Usage: segreant <command> [options]

  Commands
    guide                 Where you are + the single next step, read from your
                          actual state — also what bare "segreant" shows (--json)
    start                 Start the proxy + local dashboard
    egress                Inspect/verify Segreant-process egress; plan exact cloud
                          rules without mutation, then persist only with:
                          egress apply --apply --mode controlled_cloud
                          (--id, --purpose, --data-class, --method, --origin,
                          --path-prefix). Default local_locked permits literal
                          loopback only; this is not a machine-wide firewall.
    causal                Retained randomized-study evidence: status, inspect,
                          replay verification, and review-only OPE from the
                          Store-owned action log. V1 is inspect-only; all causal
                          mutations and v2 public projection remain deferred.
                          Ordinary value, Lift, and price scenarios cannot become
                          causal claims; this command never changes provider routing.
                          causal design --options <file> checks protocol-linked
                          missingness, attrition, interference and exposure declarations;
                          causal transport --options <file> checks explicit
                          cross-study bridge assumptions and target evidence;
                          causal family --options <file> plans cross-study error budgets.
    capital evaluate      Review-only exact AI-capital decomposition from a bounded
                          JSON snapshot (--options <file>, --json). Distinguishes
                          commitment, consumption, showback, opportunity and
                          policy-relative fairness; no chargeback or action.
    today | week | month  Show spend for a window      (--json)
    economic              Inspect exact economic events, roles, bases, and legacy coverage
                          (--days N | --all, --target-currency UNIT, --as-of <ISO>,
                          --effective-at <ISO>, --json). Period controls use canonical
                          UTC instants: --close-status|--finalize|--reopen
                          --from <ISO> --to <ISO> [--recorded-at <ISO>]
                          [--reason <text>] [--as-of <ISO>] [--json]
    sources               Spend by connected source — each AI tool routed here
                          (--all for all-time, --json)
    connect <tool>        Connect an AI tool as a source so its spend is metered:
                          opencode (--write to apply), claude-code (native import),
                          antigravity (custom-provider recipe; --write points the
                          upstream at Gemini free tier), api (generic SDK/curl
                          recipe). No tool lists the connectors.
    import <tool|all>     NATIVE metering, no routing: read the usage a tool
                          already logs locally — works on subscriptions the proxy
                          can never see. Tools: claude-code, opencode, codex (or
                          all). Idempotent. --watch keeps it live (poll every N
                          sec: --every N). Files unchanged since their last full
                          import are skipped; --rescan reads them again.
                          (--root <dir>, --days N, --json)
    billing <action>     Import, inspect, or export LOCAL operator-supplied
                          provider billing evidence. V1 accepts a strict OpenAI
                          evidence JSON only; it never overwrites metered estimates
                          or claims invoice reconciliation. Actions: import --file,
                          status, export, scope set|status|clear, and openai-costs
                          preview|pull|status|coverage. scope set records
                          a local, unverified account reference for future matching
                          OpenAI-proxy traffic only (requires --apply).
    scan [path]           One-command onboarding: find the AI tools + git repos on
                          this machine and preview a setup plan (read-only). --setup
                          imports every detected tool and correlates every repo into
                          per-project RoI. --deep widens the walk. (path defaults to
                          your home; --json)
    discover               Correlate ALREADY-imported projects into per-project RoI,
                          without re-importing — the correlation half of "scan --setup"
                          on its own      (--window D, --json)
    audit --repo <path>   Correlate spend with git commits (--limit N, --json)
    roi --repo <path>     Return on Intelligence: four value lenses (Realization,
                          Acceptance, Lift, Impact) → one composite index
                          (--labor-rate $/hr, --tsf <multiplier> for Lift, --json)
    saved --repo <path>   Manual work-weeks reclaimed vs measured AI hours,
                          honestly banded and split by task type (--window D, --json)
    frontier --repo <p>   Compare models on like tasks; surface lower-cost,
                          same-observed-outcome trials and local headroom (--window D, --json)
    market                Public quality per dollar by kind of work (coding,
                          chat, image) from a bundled dated snapshot. Public
                          evidence, never mixed with yours (--repo P shows yours
                          beside it; --category C, --all, --json).
                          market --refresh <source|all> fetches through egress.
    usage                 RoI for usage WITHOUT code signals — chat, research,
                          drafting, plus coding tools that don't report diffs.
                          Sessions scored from reported outcomes (--days N, --json)
    outcome record        Preview a self-reported chat, image or other result;
                          --apply records it. Link with --request ID, --session ID,
                          or --from ISO --to ISO --tool NAME (inferred).
    outcome report        Cost per accepted and used self-reported result by kind
                          and model (--days N, --json).
    judge                 Score a real session's AI-assisted efficiency —
                          algorithmic by default; opt into a local/hosted LLM
                          judge via config.judge.*. Full-content tiers read a
                          Claude Code session's own transcript ephemerally.
                          (--session <id>, --window D, --project <name>, --json)
    team                  Per-user value: how much of the spend reaches outcomes.
                          Opt-in, distribution-only, k-anonymous. --me <user> for
                          your own view (--days N, --json)
    team push --url <u>   Cross-machine: sign + push this window's per-project
                          value/RoI to a team server YOU run (Segreant hosts
                          nothing). --dry-run to preview, --pubkey to publish
                          this machine's rollup identity, --watch to keep
                          pushing on an interval (--window D, --every N,
                          --json). --project <name> previews one project with
                          --dry-run; a scoped rollup is never sent, because the
                          server reads your latest push as your whole window
    report --kind K       Wire an outcome: code --commit <hash>, non-code --session <id>
                          kinds: tested|merged|shipped|incident|used|resolved|published|…
    evidence github       Signed, offline CI evidence. 'emit' runs in a protected
                          workflow; 'import' verifies a locally pinned key plus
                          exact repository, branch, workflow, and policy binding.
    launch -- <command>   Start a tool metered through the proxy while it runs, and
                          unmetered (with a warning) when it does not. With a budget
                          cap set, a stopped proxy refuses unless --allow-unmetered
    exec -- <command>     AMBIENT outcome capture: run any command and report its
                          exit code as the outcome — wrap "npm test" once, every
                          run reports itself ([--kind tested|shipped|…] [--commit R|--session S])
    realize --repo <path> The Realization Standard: % of AI spend that became
                          verified, durable outcomes (--window DAYS, --limit N, --json)
    receipt --repo <path> Emit signed, verifiable value receipts (--unit <hash>, --json)
                          Publish identity:  receipt --pubkey
                          Verify + pin signer: receipt --verify <file> --key-id <id>
                          Reconcile against this ledger: receipt --reconcile <file>
                          [--as-of <instant>] — agrees / ledger moved / disagrees
    yield --repo <path>   Artifact persistence (legacy yield lens): retained introduced
                          lines per $ — retention and non-retention (--window DAYS,
                          --limit N, --json)
    budget                Set caps: --daily N --soft N --session N --runaway N --window S
                          --include-imported on|off: whether imported subscription
                          spend counts toward cap ENFORCEMENT (default off — the
                          cap governs live proxy traffic, the spend it can block)
    budget --recommend    Suggest a value-aware budget from usage + realized value
                          (--repo <path> for value-based, --apply to write, --json)
    budget --control      Evaluate one bounded autonomous daily-cap control step
                          from a versioned JSON policy (--policy <file>, --repo <path>,
                          --apply to delegate mutation, --json). Deterministic v1
                          exploration is 0; unsafe/expired evidence falls back.
    alerts                Active governance alerts: spend spikes, throttling, runaway,
                          value craters (--repo <path> for value, --json; exits 1 if critical)
                          Deliver to your own webhook: --set-webhook <url>, then --notify
                          (cron it; sends ONLY alert metadata — never prompts/code/keys)
    export                Export the request ledger for BI/finance (--csv default | --json,
                          --economic for exact Money/lineage, --days N | --all,
                          --target-currency UNIT, --as-of <ISO>, --effective-at <ISO>,
                          --out <file>; otherwise stdout)
    init                  Write default config + print setup steps
    doctor                First-run health check: config, DB, proxy, caps, data quality
    config                Show config and file paths    (--json)
    features              List optional subsystems and their switches;
                          features on|off <key> previews, --apply saves.
    pricing               Show the rate card: source, age, model count (--json).
                          Update it:  pricing --refresh  (pulls the latest rates
                          from the community price feed; --url <manifest> to
                          override the source)
                          Self-maintaining: pricing --auto  (refresh on start
                          when stale; --auto off to disable)
                          Evidence: pricing --coverage [--days N|--all] (--json;
                          read-only historical card/match cohorts)
    reprice               Re-cost rows that were priced with a fallback estimate,
                          using the current rate card — only rows the card now
                          resolves EXACTLY are rewritten; remaining estimates are
                          left alone. Dry-run by default; --apply writes (--json)
    baseline               Show the Lift manual-minutes population prior: source,
                          age, task-type count (--json). Update it: baseline
                          --refresh --url <manifest>  (no default source exists —
                          unlike pricing, METR publishes research, not a feed)
    project               Manage project labels. Launch dirs fragment one real
                          project across labels; merge them at query time (raw
                          rows never rewritten):
                            project merge <label...> --into <name>
                            project alias <alias> <canonical> · unalias <alias>
                          Bare "project" lists spend by (merged) project (--json).
                          --coverage reports how each label was obtained: declared
                          by the tool, inferred from its recorded path, or never
                          attributed at all — an assertion, never verified identity
    prune                 Prune old rows and compact the database
    backup --out <file>   Create a verified, local SQLite ledger snapshot
    restore --from <file> --out <file>
                          Preview a backup, or create a new verified database
                          with --apply. The active ledger is never overwritten.
    pack export --out <file>
                          Write the epistemic ledger as a .segreantpack envelope:
                          every record bound by digest, omissions and redactions
                          stated in the manifest ([--sign <private-key.pem>])
    pack verify <file>    Check a pack's bytes: integrity, authenticity (only with
                          --trust <public-key>), truth never evaluated
    pack inspect <file>   Print what a pack's manifest says, evaluating nothing
    plugin run --manifest <file> --request <file> --exec <path> --scope k=v
                          One bounded exchange with a plugin process; preview the
                          kernel Evidence it would append, --apply to append it
    diagnostics [--json]   Emit redacted local runtime/database/egress diagnostics
                          (--out <file> writes an atomic bundle; no telemetry)
    demo                  Generate isolated, clearly-labeled synthetic data so every
                          surface populates without an API key (--serve to launch the
                          dashboard on it; --clear to remove). Add --demo to any read
                          command (today, alerts, usage, start) to view the demo data.
    help                  The short list; "help all" prints this reference
    --version             Print the Segreant version

  Setup
    1) If routing a cloud provider, review its exact rule first:
       segreant egress plan --mode controlled_cloud --id openai-inference
         --purpose provider_inference --data-class provider_request --method POST
         --origin https://api.openai.com --path-prefix /v1/
       Persist the reviewed plan only with the same command as:
         segreant egress apply --apply ...
       (Skip this for a local loopback-only model.)
    2) segreant start
    3) $env:ANTHROPIC_BASE_URL="http://localhost:8090"   (PowerShell)
       $env:OPENAI_BASE_URL="http://localhost:8090/v1"
    4) Run your AI tools as usual. Watch the dashboard.

  Any OpenAI-compatible provider works through the OpenAI path — point your tool
  at http://localhost:8090/v1. Gemini, for example, via Google's free tier:
       $env:OPENAI_BASE_URL="http://localhost:8090/v1"   then use a gemini-* model
`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // Bare `segreant` opens the guide, not the reference: the tool's first job
  // is to tell you where you are and the single next step. `help` is one word away.
  const cmd = argv[0] ?? 'guide';
  // `exec` wraps another command: everything after the bare `--` belongs to the
  // wrapped command verbatim and must never be flag-parsed.
  const sep = argv.indexOf('--');
  const wraps = cmd === 'exec' || cmd === 'launch';
  const flags = parseFlags(wraps && sep !== -1 ? argv.slice(1, sep) : argv.slice(1));
  const wrapped = wraps && sep !== -1 ? argv.slice(sep + 1) : [];

  // Demo mode: point every store-open at an isolated demo.db and flag surfaces
  // to render the DEMO label. One switch covers the CLI and the in-process
  // dashboard, since both resolve the path through dbPath() and read isDemo().
  //
  // These set the PREFERRED spelling deliberately. Both `SEGREANT_DB` and the
  // legacy `SEGREANT_DB` are read, with SEGREANT winning; writing the legacy name
  // here would leave an operator's own exported `SEGREANT_DB` outranking this
  // switch, and demo traffic would land in their real ledger.
  if (cmd === 'demo' || flags.demo) {
    process.env[envOverrideKey('DB')] = demoDbPath();
    process.env[envOverrideKey('DEMO')] = '1';
  }

  // `segreant start --help` used to start the server: no command reads --help
  // itself, so any command asked for help gets the usage text and does nothing.
  if (flags.help === true && !wraps) {
    cmdHelpShort();
    return;
  }

  switch (cmd) {
    case 'demo':
      await (await runCmd()).cmdDemo(flags);
      break;
    case 'start':
      await (await runCmd()).cmdStart(flags);
      break;
    case 'today':
    case 'status':
      (await showCmd()).cmdShow('today', flags);
      break;
    case 'week':
      (await showCmd()).cmdShow('week', flags);
      break;
    case 'month':
      (await showCmd()).cmdShow('month', flags);
      break;
    case 'economic':
    case 'economics':
      (await economicCmd()).cmdEconomic(flags);
      break;
    case 'sources':
      (await showCmd()).cmdSources(flags);
      break;
    case 'connect':
      (await connectCmd()).cmdConnect(flags);
      break;
    case 'egress':
      (await egressCmd()).cmdEgress(flags);
      break;
    case 'causal':
    case 'study':
      (await causalCmd()).cmdCausal(flags);
      break;
    case 'capital':
      (await capitalCmd()).cmdCapital(flags);
      break;
    case 'init':
      (await opsCmd()).cmdInit();
      break;
    case 'config':
      (await showCmd()).cmdConfig(flags);
      break;
    case 'features':
      (await featuresCmd()).cmdFeatures(flags);
      break;
    case 'market':
      await (await marketCmd()).cmdMarket(flags);
      break;
    case 'budget':
      if (flags.control) await (await controlCmd()).cmdBudgetControl(flags);
      else if (flags.recommend) await (await valueCmd()).cmdBudgetAdvisor(flags);
      else (await showCmd()).cmdBudget(flags);
      break;
    case 'alerts':
      await (await opsCmd()).cmdAlerts(flags);
      break;
    case 'export':
      (await showCmd()).cmdExport(flags);
      break;
    case 'guide':
    case 'next':
      await (await opsCmd()).cmdGuide(flags);
      break;
    case 'doctor':
      await (await opsCmd()).cmdDoctor();
      break;
    case 'audit':
      await (await opsCmd()).cmdAudit(flags);
      break;
    case 'yield':
      await (await valueCmd()).cmdYield(flags);
      break;
    case 'realize':
    case 'realization':
      await (await valueCmd()).cmdRealize(flags);
      break;
    case 'roi':
      await (await valueCmd()).cmdRoi(flags);
      break;
    case 'saved':
      await (await valueCmd()).cmdSaved(flags);
      break;
    case 'frontier':
      await (await valueCmd()).cmdFrontier(flags);
      break;
    case 'usage':
      await (await valueCmd()).cmdUsage(flags);
      break;
    case 'outcome':
      (await outcomeCmd()).cmdOutcome(flags);
      break;
    case 'judge':
      await (await teamCmd()).cmdJudge(flags);
      break;
    case 'team':
      // Bare `team` / `team --me <user>` = the existing local, k-anonymous
      // per-user value view (single machine). `team push` = sign and push a
      // cross-project rollup to a separate, BYO team server (multi-machine).
      // Same top-level verb, two scopes — not a naming collision: `push`
      // lands in flags._[0] because `main()` already consumed argv[0] as `cmd`.
      if (flags._[0] === 'push') {
        await (await teamCmd()).cmdTeamPush(flags);
      } else {
        await (await teamCmd()).cmdTeam(flags);
      }
      break;
    case 'report':
      await (await valueCmd()).cmdReport(flags);
      break;
    case 'evidence':
      await (await evidenceCmd()).cmdEvidence(flags);
      break;
    case 'exec':
      await (await valueCmd()).cmdExec(flags, wrapped);
      break;
    case 'launch':
      await (await launchCmd()).cmdLaunch(flags, wrapped);
      break;
    case 'import':
      await (await importCmd()).cmdImport(flags);
      break;
    case 'billing':
      await (await billingCmd()).cmdBilling(flags);
      break;
    case 'alloc':
    case 'allocation':
      (await allocCmd()).cmdAlloc(flags);
      break;
    case 'discover':
      await (await importCmd()).cmdDiscover(flags);
      break;
    case 'scan':
      await (await importCmd()).cmdScan(flags);
      break;
    case 'receipt':
    case 'receipts':
      await (await teamCmd()).cmdReceipt(flags);
      break;
    case 'project':
    case 'projects':
      (await showCmd()).cmdProject(flags);
      break;
    case 'prune':
      (await showCmd()).cmdPrune(flags);
      break;
    case 'backup':
      (await backupCmd()).cmdBackup(flags);
      break;
    case 'restore':
      (await backupCmd()).cmdRestore(flags);
      break;
    case 'pack':
      (await packCmd()).cmdPack(flags);
      break;
    case 'plugin':
      await (await pluginCmd()).cmdPlugin(flags);
      break;
    case 'diagnostics':
    case 'diagnostic':
      (await diagnosticsCmd()).cmdDiagnostics(flags);
      break;
    case 'pricing':
      await (await runCmd()).cmdPricing(flags);
      break;
    case 'reprice':
      (await runCmd()).cmdReprice(flags);
      break;
    case 'baseline':
    case 'baselines':
      await (await runCmd()).cmdBaseline(flags);
      break;
    case 'help':
    case '--help':
    case '-h':
      if (argv[1] === 'all' || flags.all === true) cmdHelp();
      else cmdHelpShort();
      break;
    case 'version':
    case '--version':
    case '-v':
      console.log(`segreant ${packageVersion()}`);
      break;
    default:
      console.error(`  Unknown command: ${cmd}\n  Run "segreant help" for usage.`);
      process.exitCode = 1;
  }
}

// A reader closing early (e.g. `segreant scan | head`) makes further console.log
// writes throw EPIPE — expected, not a real failure. Exit clean instead of an
// uncaught-exception stack trace; any OTHER stdout error still propagates.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

// Defer command dispatch until the launcher has finished importing the compiled
// module and released its publication lock. Some commands (notably `demo`)
// perform substantial synchronous work before their first `await`; invoking
// them directly here would make every concurrent CLI reader hold the build gate
// for the whole command and can starve a legitimate publication queue. Command
// modules imported later resolve inside the launcher's private runtime snapshot,
// which lives until process exit, so publication still cannot create a
// missing-dependency window for this process.
export const cliCompletion = new Promise<void>((resolve) => setImmediate(() => {
  main().catch((err: unknown) => {
    // A mistake in the command is one plain line. Anything else is a fault in
    // Segreant: one line by default, the full trace with --debug.
    const message = err instanceof Error ? err.message : String(err);
    // Usage messages and demo refusals are also about the command typed.
    const userFacing = err instanceof UserInputError
      || (err instanceof Error && (err.name === 'DemoReadOnlyError' || /^usage: /.test(err.message)));
    if (userFacing) {
      console.error(`  ${message}`);
    } else if (process.argv.includes('--debug')) {
      console.error('  Segreant error:', err);
    } else {
      console.error(`  Segreant error: ${message}`);
      console.error('  Run the same command with --debug to see where it failed.');
    }
    process.exitCode = 1;
  }).finally(resolve);
}));
