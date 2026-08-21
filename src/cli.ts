/**
 * Fiscus command-line interface.
 *
 *   fiscus start            start the proxy + local dashboard
 *   fiscus today|week|month show spend for a window  (--json for raw)
 *   fiscus init             write a default config and print setup steps
 *   fiscus budget ...       set soft/hard caps
 *   fiscus audit --repo .   correlate spend with git commits
 *   fiscus config           show config + paths
 *   fiscus prune            prune old rows and compact the database
 */

import './util/quiet.ts';
import { demoDbPath, envOverrideKey } from './config.ts';
import { packageVersion } from './version.ts';

import { parseFlags } from './cli/flags.ts';
import { cmdImport, cmdDiscover, cmdScan } from './cli/importCmd.ts';
import { cmdBilling } from './cli/billingCmd.ts';
import { cmdAlloc } from './cli/allocCmd.ts';
import { cmdEvidence } from './cli/evidenceCmd.ts';
import { cmdYield, cmdRealize, cmdReport, cmdExec, cmdUsage, cmdRoi, cmdSaved, cmdBudgetAdvisor, cmdFrontier } from './cli/valueCmd.ts';
import { cmdTeam, cmdReceipt, cmdJudge, cmdTeamPush } from './cli/teamCmd.ts';
import { cmdConnect } from './cli/connectCmd.ts';
import { cmdAlerts, cmdDoctor, cmdInit, cmdGuide, cmdAudit } from './cli/opsCmd.ts';
import { cmdShow, cmdSources, cmdExport, cmdConfig, cmdBudget, cmdPrune, cmdProject } from './cli/showCmd.ts';
import { cmdStart, cmdDemo, cmdPricing, cmdBaseline, cmdReprice } from './cli/runCmd.ts';

function cmdHelp(): void {
  console.log(`
  Fiscus — meter and cap what your AI coding agents spend, locally.

  Usage: fiscus <command> [options]

  Commands
    guide                 Where you are + the single next step, read from your
                          actual state — also what bare "fiscus" shows (--json)
    start                 Start the proxy + local dashboard
    today | week | month  Show spend for a window      (--json)
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
                          sec: --every N). (--root <dir>, --days N, --json)
    billing <action>      Import, inspect, or export LOCAL operator-supplied
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
    usage                 RoI for usage WITHOUT code signals — chat, research,
                          drafting, plus coding tools that don't report diffs.
                          Sessions scored from reported outcomes (--days N, --json)
    judge                 Score a real session's AI-assisted efficiency —
                          algorithmic by default; opt into a local/hosted LLM
                          judge via config.judge.*. Full-content tiers read a
                          Claude Code session's own transcript ephemerally.
                          (--session <id>, --window D, --project <name>, --json)
    team                  Per-user value: how much of the spend reaches outcomes.
                          Opt-in, distribution-only, k-anonymous. --me <user> for
                          your own view (--days N, --json)
    team push --url <u>   Cross-machine: sign + push this window's per-project
                          value/RoI to a team server YOU run (Fiscus hosts
                          nothing). --dry-run to preview, --pubkey to publish
                          this machine's rollup identity, --watch to keep
                          pushing on an interval (--window D, --project
                          <name>, --every N, --json)
    report --kind K       Wire an outcome: code --commit <hash>, non-code --session <id>
                          kinds: tested|merged|shipped|incident|used|resolved|published|…
    evidence github       Signed, offline CI evidence. 'emit' runs in a protected
                          workflow; 'import' verifies a locally pinned key plus
                          exact repository, branch, workflow, and policy binding.
    exec -- <command>     AMBIENT outcome capture: run any command and report its
                          exit code as the outcome — wrap "npm test" once, every
                          run reports itself ([--kind tested|shipped|…] [--commit R|--session S])
    realize --repo <path> The Realization Standard: % of AI spend that became
                          verified, durable outcomes (--window DAYS, --limit N, --json)
    receipt --repo <path> Emit signed, verifiable value receipts (--unit <hash>, --json)
                          Publish identity:  receipt --pubkey
                          Verify + pin signer: receipt --verify <file> --key-id <id>
    yield --repo <path>   AI Yield (survival lens): durable lines per $ — survival, churn
                          (--window DAYS, --limit N, --json)
    budget                Set caps: --daily N --soft N --session N --runaway N --window S
                          --include-imported on|off: whether imported subscription
                          spend counts toward cap ENFORCEMENT (default off — the
                          cap governs live proxy traffic, the spend it can block)
    budget --recommend    Suggest a value-aware budget from usage + realized value
                          (--repo <path> for value-based, --apply to write, --json)
    alerts                Active governance alerts: spend spikes, throttling, runaway,
                          value craters (--repo <path> for value, --json; exits 1 if critical)
                          Deliver to your own webhook: --set-webhook <url>, then --notify
                          (cron it; sends ONLY alert metadata — never prompts/code/keys)
    export                Export the request ledger for BI/finance (--csv default | --json,
                          --days N | --all, --out <file>; otherwise stdout)
    init                  Write default config + print setup steps
    doctor                First-run health check: config, DB, proxy, caps, data quality
    config                Show config and file paths    (--json)
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
    demo                  Generate isolated, clearly-labeled synthetic data so every
                          surface populates without an API key (--serve to launch the
                          dashboard on it; --clear to remove). Add --demo to any read
                          command (today, alerts, usage, start) to view the demo data.
    help                  This message
    --version             Print the Fiscus version

  Setup
    1) fiscus start
    2) $env:ANTHROPIC_BASE_URL="http://localhost:8090"   (PowerShell)
       $env:OPENAI_BASE_URL="http://localhost:8090/v1"
    3) Run your AI tools as usual. Watch the dashboard.

  Any OpenAI-compatible provider works through the OpenAI path — point your tool
  at http://localhost:8090/v1. Gemini, for example, via Google's free tier:
       $env:OPENAI_BASE_URL="http://localhost:8090/v1"   then use a gemini-* model
`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // Bare `fiscus` opens the guide, not the reference: the tool's first job
  // is to tell you where you are and the single next step. `help` is one word away.
  const cmd = argv[0] ?? 'guide';
  // `exec` wraps another command: everything after the bare `--` belongs to the
  // wrapped command verbatim and must never be flag-parsed.
  const sep = argv.indexOf('--');
  const flags = parseFlags(cmd === 'exec' && sep !== -1 ? argv.slice(1, sep) : argv.slice(1));
  const wrapped = cmd === 'exec' && sep !== -1 ? argv.slice(sep + 1) : [];

  // Demo mode: point every store-open at an isolated demo.db and flag surfaces
  // to render the DEMO label. One switch covers the CLI and the in-process
  // dashboard, since both resolve the path through dbPath() and read isDemo().
  //
  // These set the PREFERRED spelling deliberately. Both `FISCUS_DB` and the
  // legacy `FISCUS_DB` are read, with FISCUS winning; writing the legacy name
  // here would leave an operator's own exported `FISCUS_DB` outranking this
  // switch, and demo traffic would land in their real ledger.
  if (cmd === 'demo' || flags.demo) {
    process.env[envOverrideKey('DB')] = demoDbPath();
    process.env[envOverrideKey('DEMO')] = '1';
  }

  switch (cmd) {
    case 'demo':
      await cmdDemo(flags);
      break;
    case 'start':
      await cmdStart(flags);
      break;
    case 'today':
    case 'status':
      cmdShow('today', flags);
      break;
    case 'week':
      cmdShow('week', flags);
      break;
    case 'month':
      cmdShow('month', flags);
      break;
    case 'sources':
      cmdSources(flags);
      break;
    case 'connect':
      cmdConnect(flags);
      break;
    case 'init':
      cmdInit();
      break;
    case 'config':
      cmdConfig(flags);
      break;
    case 'budget':
      if (flags.recommend) await cmdBudgetAdvisor(flags);
      else cmdBudget(flags);
      break;
    case 'alerts':
      await cmdAlerts(flags);
      break;
    case 'export':
      cmdExport(flags);
      break;
    case 'guide':
    case 'next':
      await cmdGuide(flags);
      break;
    case 'doctor':
      await cmdDoctor();
      break;
    case 'audit':
      await cmdAudit(flags);
      break;
    case 'yield':
      await cmdYield(flags);
      break;
    case 'realize':
    case 'realization':
      await cmdRealize(flags);
      break;
    case 'roi':
      await cmdRoi(flags);
      break;
    case 'saved':
      await cmdSaved(flags);
      break;
    case 'frontier':
      await cmdFrontier(flags);
      break;
    case 'usage':
      await cmdUsage(flags);
      break;
    case 'judge':
      await cmdJudge(flags);
      break;
    case 'team':
      // Bare `team` / `team --me <user>` = the existing local, k-anonymous
      // per-user value view (single machine). `team push` = sign and push a
      // cross-project rollup to a separate, BYO team server (multi-machine).
      // Same top-level verb, two scopes — not a naming collision: `push`
      // lands in flags._[0] because `main()` already consumed argv[0] as `cmd`.
      if (flags._[0] === 'push') {
        await cmdTeamPush(flags);
      } else {
        await cmdTeam(flags);
      }
      break;
    case 'report':
      await cmdReport(flags);
      break;
    case 'evidence':
      await cmdEvidence(flags);
      break;
    case 'exec':
      await cmdExec(flags, wrapped);
      break;
    case 'import':
      await cmdImport(flags);
      break;
    case 'billing':
      await cmdBilling(flags);
      break;
    case 'alloc':
    case 'allocation':
      cmdAlloc(flags);
      break;
    case 'discover':
      await cmdDiscover(flags);
      break;
    case 'scan':
      await cmdScan(flags);
      break;
    case 'receipt':
    case 'receipts':
      await cmdReceipt(flags);
      break;
    case 'project':
    case 'projects':
      cmdProject(flags);
      break;
    case 'prune':
      cmdPrune();
      break;
    case 'pricing':
      await cmdPricing(flags);
      break;
    case 'reprice':
      cmdReprice(flags);
      break;
    case 'baseline':
    case 'baselines':
      await cmdBaseline(flags);
      break;
    case 'help':
    case '--help':
    case '-h':
      cmdHelp();
      break;
    case 'version':
    case '--version':
    case '-v':
      console.log(`fiscus ${packageVersion()}`);
      break;
    default:
      console.error(`  Unknown command: ${cmd}\n  Run "fiscus help" for usage.`);
      process.exitCode = 1;
  }
}

// A reader closing early (e.g. `fiscus scan | head`) makes further console.log
// writes throw EPIPE — expected, not a real failure. Exit clean instead of an
// uncaught-exception stack trace; any OTHER stdout error still propagates.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

main().catch((err) => {
  console.error('  Fiscus error:', err);
  process.exitCode = 1;
});
