/**
 * Native-metering commands — `import` (one-shot + --watch), `discover`, and
 * `scan`. Moved verbatim from cli.ts in the per-command-module split; the
 * import registry (IMPORT_RUNNERS) lives here because every entry point that
 * reads a tool's local data drives off it.
 */

import { join } from 'node:path';
import { Store } from '../store/db.ts';
import { dbPath, loadConfig } from '../config.ts';
import { pricingStatus } from '../cost/pricing.ts';
import {
  realizeDiscoveredProjects, projectValueBreakdown, CLI_PERIOD_DAYS, CLI_GIT_BUDGET_MS, SCAN_VALUE_BUDGET_MS,
  type DiscoveredResult,
} from '../value/realization.ts';
import { scanWithDiff, saveScan, type ScanDiff } from '../scan/scan.ts';
import { importClaudeCode, defaultClaudeCodeRoot } from '../connect/claudeCode.ts';
import { importOpencode, defaultOpencodeDbPath } from '../connect/opencode.ts';
import { importCodex, defaultCodexRoot } from '../connect/codex.ts';
import { importAntigravity, defaultAntigravityRoot } from '../connect/antigravity.ts';
import { type ImportSummary } from '../connect/importShared.ts';
import { C, color, usd, num, printJson } from './ui.ts';
import { rangeFor, type Flags } from './flags.ts';

/**
 * Live import: poll the source(s) on an interval and fold in new traffic as it
 * appears. Reads are read-only snapshots (SQLite WAL / streamed JSONL), so the
 * tool being metered keeps writing uninterrupted. Idempotent inserts mean a
 * re-scan only ever adds what's new — this is the import equivalent of the
 * proxy's live feed, minus the base-URL wiring.
 */
async function cmdImportWatch(
  targets: string[],
  opts: { root?: string; sinceMs?: number; intervalMs?: number },
): Promise<void> {
  const tty = process.stdout.isTTY ?? false;
  const intervalMs = Math.max(2000, opts.intervalMs ?? 5000);
  const store = new Store(dbPath());
  // Advancing watermark keeps each poll cheap; a lookback covers out-of-order or
  // mid-write events (idempotency makes any re-read harmless anyway).
  const lookbackMs = 5 * 60 * 1000;
  let watermark = opts.sinceMs ?? 0;

  const labels = targets.map((t) => IMPORT_RUNNERS[t]!.label).join(', ');
  console.log('');
  console.log(color(tty, C.bold, `  Live import — watching ${labels}`));
  console.log(color(tty, C.gray, `  Polling every ${Math.round(intervalMs / 1000)}s · read-only, never blocks the tool · Ctrl+C to stop`));
  console.log('');

  let running = true;
  const tick = async (first: boolean): Promise<void> => {
    let newlyInserted = 0;
    let latest = 0;
    for (const id of targets) {
      const runner = IMPORT_RUNNERS[id]!;
      const useRoot = targets.length === 1 ? opts.root : undefined;
      const sum = await runner.run(store, { root: useRoot, sinceMs: first ? watermark : Math.max(0, watermark - lookbackMs) });
      newlyInserted += sum.inserted;
      if (sum.latestMs) latest = Math.max(latest, sum.latestMs);
      if (first) {
        renderImportSummary(tty, id, runner.location(useRoot), sum);
      }
    }
    if (latest) watermark = Math.max(watermark, latest);
    if (first) {
      console.log('');
      console.log(color(tty, C.gray, '  Watching for new traffic…'));
    } else if (newlyInserted > 0) {
      const time = new Date().toLocaleTimeString('en-US', { hour12: false });
      console.log(color(tty, C.gray, `  ${time}  `) + color(tty, C.green, `+${num(newlyInserted)} new request${newlyInserted === 1 ? '' : 's'} imported`));
    }
  };

  await tick(true);
  const timer = setInterval(() => {
    if (running) void tick(false);
  }, intervalMs);

  await new Promise<void>((resolve) => {
    const stop = () => {
      running = false;
      clearInterval(timer);
      store.close();
      console.log('\n  Stopped watching.');
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}

/**
 * The import registry — one entry per native-metering source. Each knows how to
 * find its local data and how to read it into the store idempotently. Adding a
 * tool is adding a row here; the CLI, `all`, watch mode, and the dashboard all
 * drive off this list.
 */
interface ImportRunner {
  label: string;
  /** Human-readable location of the source data (for the report + "not found"). */
  location: (root?: string) => string;
  run: (store: Store, opts: { root?: string; sinceMs?: number; rescan?: boolean; modifiedSinceMs?: number }) => ImportSummary | Promise<ImportSummary>;
  /** Whether `modifiedSinceMs` splits this source into a recent pass and a backfill (file-based sources). */
  recentFirst?: boolean;
}

const IMPORT_RUNNERS: Record<string, ImportRunner> = {
  'claude-code': {
    label: 'Claude Code',
    location: (r) => r ?? defaultClaudeCodeRoot(),
    run: (store, opts) => importClaudeCode(store, opts),
    recentFirst: true,
  },
  opencode: {
    label: 'opencode',
    location: (r) => r ?? defaultOpencodeDbPath() ?? '(opencode not found on this machine)',
    run: (store, opts) => importOpencode(store, opts),
  },
  codex: {
    label: 'Codex CLI',
    location: (r) => r ?? defaultCodexRoot() ?? '(Codex not found on this machine)',
    run: (store, opts) => importCodex(store, opts),
    recentFirst: true,
  },
  antigravity: {
    label: 'Antigravity',
    location: (r) => r ?? defaultAntigravityRoot() ?? '(Antigravity not found on this machine)',
    run: (store, opts) => importAntigravity(store, opts),
    recentFirst: true,
  },
};

/** Normalize the aliases users actually type. */
function resolveImporterId(what: string): string | null {
  const w = what.toLowerCase();
  if (w === 'claude-code' || w === 'claudecode' || w === 'claude') return 'claude-code';
  if (w === 'opencode') return 'opencode';
  if (w === 'codex' || w === 'codex-cli') return 'codex';
  if (w === 'antigravity' || w === 'agy' || w === 'gemini') return 'antigravity';
  return null;
}

/**
 * One source's two passes as one summary. The backfill counted every file
 * again (the recent ones as unchanged), so file and truncation totals come
 * from it; rows and money add, because each pass inserted different rows.
 */
function mergeImportSummaries(recent: ImportSummary | undefined, rest: ImportSummary): ImportSummary {
  if (recent === undefined) return rest;
  const byModel: ImportSummary['byModel'] = {};
  for (const part of [recent.byModel, rest.byModel]) {
    for (const [model, v] of Object.entries(part)) {
      const into = byModel[model] ?? { requests: 0, costUsd: 0 };
      into.requests += v.requests;
      into.costUsd += v.costUsd;
      byModel[model] = into;
    }
  }
  const lo = [recent.earliestMs, rest.earliestMs].filter((v): v is number => v !== null);
  const hi = [recent.latestMs, rest.latestMs].filter((v): v is number => v !== null);
  const conflicts = (recent.conflictingObservations ?? 0) + (rest.conflictingObservations ?? 0);
  return {
    ...rest,
    inserted: recent.inserted + rest.inserted,
    eventsSeen: recent.eventsSeen + rest.eventsSeen,
    costUsd: recent.costUsd + rest.costUsd,
    estimatedCostUsd: recent.estimatedCostUsd + rest.estimatedCostUsd,
    byModel,
    earliestMs: lo.length > 0 ? Math.min(...lo) : null,
    latestMs: hi.length > 0 ? Math.max(...hi) : null,
    relabelled: [...recent.relabelled, ...rest.relabelled],
    ...(conflicts > 0 ? { conflictingObservations: conflicts } : {}),
  };
}

/** "kept $1,643 · not kept $408": a project's answer from git, or why there is none yet. */
function keptLine(tty: boolean, d: DiscoveredResult): string {
  if (!d.measured) return color(tty, C.gray, d.skipped === 'no-spend' ? 'no priced spend' : 'not measured in this run');
  const k = d.kept;
  if (k === undefined || k.kept.units + k.notKept.units + k.unknown.units === 0) {
    return color(tty, C.gray, k !== undefined && k.maturing.units > 0 ? 'maturing (commits under 14 days)' : 'no commits to judge');
  }
  const parts: string[] = [];
  if (k.kept.costUsd >= 0.005) parts.push(color(tty, C.green, `kept ${usd(k.kept.costUsd)}`));
  if (k.notKept.costUsd >= 0.005) parts.push(color(tty, C.yellow, `not kept ${usd(k.notKept.costUsd)}`));
  if (k.unknown.costUsd >= 0.005) parts.push(color(tty, C.gray, `not measured yet ${usd(k.unknown.costUsd)}`));
  if (k.maturing.costUsd >= 0.005) parts.push(color(tty, C.gray, `maturing ${usd(k.maturing.costUsd)}`));
  if (parts.length === 0) return color(tty, C.gray, 'no spend on its commits');
  return parts.join(color(tty, C.gray, ' · '));
}

/** Repositories the shared deadline did not reach: named, with the command that measures them. */
function printUnmeasured(tty: boolean, discovered: DiscoveredResult[]): void {
  const left = discovered.filter((d) => d.skipped === 'deadline');
  if (left.length === 0) return;
  const spend = left.reduce((s, d) => s + (d.periodCostUsd ?? d.costUsd), 0);
  console.log(color(tty, C.gray, `    ${left.length} smaller project(s) (${usd(spend)} of spend) were not measured in the time this scan allows.`));
  console.log(color(tty, C.gray, `    Measure one with: segreant realize --repo "${left[0]!.repoPath}"`));
}

/** "3 files, 507 lines" — the parts of an import that hit a resource bound. */
function truncationDetail(sum: ImportSummary): string {
  return [
    sum.truncatedFiles ? `${num(sum.truncatedFiles)} files` : '',
    sum.truncatedLines ? `${num(sum.truncatedLines)} lines` : '',
    sum.truncatedRows ? `${num(sum.truncatedRows)} rows` : '',
  ].filter(Boolean).join(', ') || 'bounds reached';
}

function renderImportSummary(tty: boolean, id: string, location: string, sum: ImportSummary): void {
  const label = IMPORT_RUNNERS[id]!.label;
  console.log('');
  console.log(color(tty, C.bold, `  ${label} import — native, no routing`));
  console.log(color(tty, C.gray, '  ' + '─'.repeat(58)));
  console.log(`  Source       ${color(tty, C.gray, location)}${sum.files > 1 ? color(tty, C.gray, `  (${num(sum.files)} files)`) : ''}`);
  if (sum.eventsSeen === 0) {
    if (sum.filesUnchanged) {
      // Every file was already imported in full: that is "nothing new", never "nothing found".
      console.log(color(tty, C.gray, `  Up to date   ${num(sum.filesUnchanged)} file(s) unchanged since they were last imported in full (--rescan reads them again)`));
      if (sum.captureCoverage === 'truncated') {
        console.log(color(tty, C.yellow, `  Coverage     TRUNCATED (${truncationDetail(sum)}) — imported values are not a complete source capture.`));
      }
    } else {
      console.log(color(tty, C.gray, `  No usage entries found — has ${label} run on this machine?`));
    }
    console.log('');
    return;
  }
  const span =
    sum.earliestMs !== null && sum.latestMs !== null
      ? `${new Date(sum.earliestMs).toISOString().slice(0, 10)} → ${new Date(sum.latestMs).toISOString().slice(0, 10)}`
      : '—';
  console.log(`  Requests     ${num(sum.eventsSeen)} found · ${color(tty, C.green, `${num(sum.inserted)} new`)} imported  (${span})`);
  if (sum.filesUnchanged) {
    console.log(color(tty, C.gray, `  Skipped      ${num(sum.filesUnchanged)} file(s) unchanged since they were last imported in full (--rescan reads them again)`));
  }
  console.log(`  Consumption  ${color(tty, C.green, usd(sum.costUsd))}${sum.estimatedCostUsd > 0 ? color(tty, C.yellow, `  (~est ${usd(sum.estimatedCostUsd)})`) : ''}`);
  const models = Object.entries(sum.byModel).sort((a, b) => b[1].costUsd - a[1].costUsd).slice(0, 5);
  for (const [m, v] of models) console.log(`    ${m.padEnd(26)} ${usd(v.costUsd).padStart(10)}  ${color(tty, C.gray, `${num(v.requests)} req`)}`);
  if (sum.captureCoverage === 'truncated') {
    console.log(color(tty, C.yellow, `  Coverage     TRUNCATED (${truncationDetail(sum)}) — imported values are not a complete source capture.`));
  }
  if (sum.conflictingObservations) {
    console.log(color(tty, C.yellow, `  Conflicts    ${num(sum.conflictingObservations)} request(s) already recorded with a different charge — kept the first record, left these out.`));
  }
  // Rows already in the ledger keep the label they were written with, so a
  // relabel means the same work now appears under two names. Say so and hand
  // over the merge — silently splitting a project's money is the worse failure.
  if (sum.relabelled.length > 0) {
    console.log('');
    console.log(color(tty, C.gray, '  Attributed to the git repository rather than the folder name:'));
    for (const r of sum.relabelled) {
      console.log(color(tty, C.cyan, `    ${r.from} → ${r.to}`));
    }
    console.log(color(tty, C.gray, '  Earlier rows keep their original label — the ledger is never rewritten.'));
    console.log(color(tty, C.gray, `  Merge them at read time with:  segreant project alias ${sum.relabelled[0]!.from} ${sum.relabelled[0]!.to}`));
  }
}

/**
 * `segreant import <tool|all> [--root <dir>] [--days N] [--watch] [--json]` —
 * native metering for managed/subscription tools: read the usage each tool
 * already writes to local disk. Idempotent (request_id is the natural key), so
 * it is safe to re-run or poll; each run adds only new traffic. `--watch` keeps
 * it live (see cmdImportWatch).
 */
export async function cmdImport(flags: Flags): Promise<void> {
  const tty = process.stdout.isTTY ?? false;
  const what = typeof flags._[0] === 'string' ? flags._[0] : '';
  const targets: string[] =
    what.toLowerCase() === 'all'
      ? Object.keys(IMPORT_RUNNERS)
      : (() => {
          const id = resolveImporterId(what);
          return id ? [id] : [];
        })();

  if (targets.length === 0) {
    console.error(`  Usage: segreant import <${Object.keys(IMPORT_RUNNERS).join('|')}|all>  [--root <dir>] [--days N] [--watch] [--json]`);
    console.error('  Native metering — no base URL, no key. Reads what the tool already logs locally.');
    process.exitCode = 1;
    return;
  }

  const days = typeof flags.days === 'string' ? Number(flags.days) : null;
  const sinceMs = days && days > 0 ? Date.now() - days * 24 * 60 * 60 * 1000 : 0;
  const root = typeof flags.root === 'string' ? flags.root : undefined;

  if (flags.watch) {
    await cmdImportWatch(targets, { root, sinceMs, intervalMs: typeof flags.every === 'string' ? Number(flags.every) * 1000 : undefined });
    return;
  }

  const store = new Store(dbPath());
  const results: Array<{ id: string; location: string; sum: ImportSummary }> = [];
  for (const id of targets) {
    const runner = IMPORT_RUNNERS[id]!;
    // `all` with a single --root would mis-point the other tools; only pass it for a single target.
    const useRoot = targets.length === 1 ? root : undefined;
    const sum = await runner.run(store, { root: useRoot, sinceMs, rescan: Boolean(flags.rescan) });
    results.push({ id, location: runner.location(useRoot), sum });
  }
  store.close();

  if (flags.json) {
    printJson(targets.length === 1 ? results[0]!.sum : Object.fromEntries(results.map((r) => [r.id, r.sum])));
    return;
  }

  for (const r of results) renderImportSummary(tty, r.id, r.location, r.sum);
  const totalNew = results.reduce((n, r) => n + r.sum.inserted, 0);
  console.log('');
  if (totalNew > 0) {
    console.log(color(tty, C.gray, '  On a subscription this is consumption valued at list rates — what the traffic'));
    console.log(color(tty, C.gray, '  WOULD bill via API — not your invoice. Don’t also proxy the same tool for the'));
    console.log(color(tty, C.gray, '  same period, or it would count twice.'));
    console.log('');
    console.log(color(tty, C.gray, '  Safe to re-run (or add --watch to keep it live). See it: segreant today · segreant start'));
  } else {
    console.log(color(tty, C.gray, '  Nothing new to import. Add --watch to fold in new traffic as it happens.'));
  }
  console.log('');
}

/**
 * Discover the git repos behind imported projects and auto-correlate each into
 * per-project RoI — the "no --repo, no wiring" native path. Opt-in: the user runs
 * it (or clicks the dashboard button) to scan the projects the ledger already knows
 * a working directory for, realize the ones that are git repos, and persist a
 * per-project snapshot that then lights up `roi`, `today`, and the dashboard. Each
 * project is reported with the TOOLS that coded it (repo↔project↔tool).
 */
/**
 * A one-line, redrawn progress report on stderr while repositories are measured.
 * Silent for --json and when stderr is not a terminal, so piped output and
 * parsers never see it. Returns the callback and a function that clears the line.
 */
function repoProgress(flags: Flags): { onProgress?: (done: number, total: number, project: string) => void; finish: () => void } {
  const err = process.stderr;
  if (flags.json || !err.isTTY) return { finish: () => {} };
  const write = (text: string) => { err.write('\r\x1b[2K' + text); };
  write('  Measuring what your AI work kept, repo by repo…');
  return {
    onProgress: (done, total, project) => write(`  Measuring what your AI work kept… ${done}/${total} repos (last: ${project})`),
    finish: () => { err.write('\r\x1b[2K'); },
  };
}

export async function cmdDiscover(flags: Flags): Promise<void> {
  const tty = process.stdout.isTTY ?? false;
  const windowDays = flags.window ? Number(flags.window) : undefined;
  const store = new Store(dbPath());
  const paths = store.projectPaths();
  const progress = repoProgress(flags);
  const discovered = await realizeDiscoveredProjects(store, {
    windowDays, onProgress: progress.onProgress, sinceDays: CLI_PERIOD_DAYS, gitScanBudgetMs: CLI_GIT_BUDGET_MS,
    stageBudgetMs: SCAN_VALUE_BUDGET_MS,
  });
  progress.finish();
  const projects = projectValueBreakdown(store, { windowDays });
  store.close();

  if (flags.json) {
    printJson({ discovered, projects });
    return;
  }

  console.log('');
  console.log(color(tty, C.bold, '  Discover — correlate imported projects into per-project RoI'));
  console.log(color(tty, C.gray, '  ' + '─'.repeat(64)));

  if (paths.length === 0) {
    console.log(color(tty, C.gray, '  No project working directories on record yet. Import a tool first:'));
    console.log(color(tty, C.gray, '    segreant import claude-code | codex | opencode | all'));
    console.log(color(tty, C.gray, '  Imports capture each project’s folder — that is what Discover correlates.'));
    console.log('');
    return;
  }

  if (discovered.length === 0) {
    console.log(color(tty, C.yellow, `  Found ${paths.length} project folder(s), but none are git repositories — nothing to correlate.`));
    console.log(color(tty, C.gray, '  RoI needs git history (the committed/survived/clean gates); spend is still metered.'));
    console.log('');
    return;
  }

  console.log(color(tty, C.gray, `  Correlated ${discovered.length} of ${paths.length} project folder(s) that are git repos:`));
  console.log('');
  const roiByProject = new Map(projects.map((p) => [p.project, p.roiIndex]));
  for (const d of discovered) {
    const roi = roiByProject.get(d.project);
    const roiStr =
      roi == null
        ? color(tty, C.gray, 'RoI —')
        : color(tty, roi > 60 ? C.green : roi > 30 ? C.yellow : C.red, `RoI ${Math.round(roi)}`);
    const tools = d.sources.length ? d.sources.join(', ') : 'unknown';
    console.log(`  ${color(tty, C.bold, d.project.padEnd(22))} ${usd(d.costUsd).padStart(10)}   ${keptLine(tty, d)}   ${roiStr}`);
    console.log(color(tty, C.gray, `    ${d.repoPath}`));
    console.log(color(tty, C.gray, `    coded with: ${tools}`));
  }
  printUnmeasured(tty, discovered);
  console.log('');
  console.log(color(tty, C.gray, '  RoI here scores every stored unit (all time); "segreant roi --repo" scopes to a window — the two can differ.'));
  console.log(color(tty, C.gray, '  Now live in: segreant roi · segreant today · the dashboard (By project).'));
  console.log('');
}

/** Render "what changed since your last scan of these roots" — silent on a first scan. */
function renderScanDiff(tty: boolean, diff: ScanDiff): void {
  if (!diff.comparable) return; // first scan of these roots — nothing to compare against
  const since = diff.sinceMs ? ` on ${new Date(diff.sinceMs).toISOString().slice(0, 10)}` : '';
  const bits: string[] = [];
  if (diff.newRepos.length) bits.push(color(tty, C.green, `+${diff.newRepos.length} new repo(s)`));
  if (diff.newTools.length) bits.push(color(tty, C.green, `+${diff.newTools.length} new tool(s)`));
  if (diff.goneRepos.length) bits.push(color(tty, C.gray, `−${diff.goneRepos.length} gone`));
  if (bits.length === 0) {
    console.log(color(tty, C.gray, `  No change since your last scan${since}.`));
  } else {
    console.log(color(tty, C.bold, `  Since your last scan${since}:  `) + bits.join(color(tty, C.gray, ' · ')));
    for (const r of diff.newRepos.slice(0, 8)) console.log(color(tty, C.green, `    + ${r}`));
    for (const id of diff.newTools) console.log(color(tty, C.green, `    + tool detected: ${id}`));
  }
  console.log('');
}

/**
 * `segreant scan [path] [--deep] [--setup] [--json]` — the proactive, opt-in
 * discovery pass. It inspects the machine: which supported AI tools have local
 * usage data, and which folders under `path` (default: your home) are git repos.
 * Also surfaces a wider, best-effort inventory of OTHER AI coding tools it
 * recognizes (config-dir or PATH-binary checks only — see src/scan/knownApps.ts) —
 * inventory only, never a claim of import capability. Read-only and bounded by
 * default — it PREVIEWS a setup plan and changes nothing. `--setup` is the
 * deliberate second step: import every detected tool, then correlate every
 * discovered repo into per-project RoI (the same engines as import + discover),
 * so one command turns a fresh machine into a full AI-capital map. `--deep` widens
 * the walk (depth + budget) for large or unusually nested trees.
 */
export async function cmdScan(flags: Flags): Promise<void> {
  const tty = process.stdout.isTTY ?? false;
  const root = typeof flags._[0] === 'string' ? flags._[0] : undefined;
  const deep = Boolean(flags.deep);
  const scanOpts = deep ? { maxDepth: 12, maxDirs: 80000 } : undefined;

  const store = new Store(dbPath());
  // Diff against the last scan of these roots BEFORE we overwrite the snapshot.
  const { plan, diff } = scanWithDiff(store, { roots: root ? [root] : undefined, scan: scanOpts });
  saveScan(store, plan); // remember this scan so the next one can report what changed
  const present = plan.tools.filter((t) => t.present);

  if (flags.json && !flags.setup) {
    printJson({ ...plan, diff });
    store.close();
    return;
  }

  // This preamble (banner, tool list, repo list, diff) is human-readable rendering
  // only — nothing here has a side effect the --setup path depends on (the diff
  // was already computed and the new baseline already saved above). Gated behind
  // !flags.json so `scan --setup --json` doesn't fall through to here and print
  // prose ahead of the JSON blob (this block sits BEFORE the `!flags.setup` branch,
  // so both dry-run and --setup reach it — only the line-1481 early return skips it,
  // and that early return deliberately excludes --setup).
  if (!flags.json) {
    console.log('');
    console.log(color(tty, C.bold, '  Scan — find your AI tools and repos, then set it all up'));
    console.log(color(tty, C.gray, '  ' + '─'.repeat(64)));
    console.log(color(tty, C.gray, '  Read-only: reads what exists on disk. Nothing is imported or sent.'));
    console.log('');

    // Detected tools.
    console.log(color(tty, C.bold, '  AI coding tools on this machine'));
    for (const t of plan.tools) {
      const mark = t.present ? color(tty, C.green, '  ✓') : color(tty, C.gray, '  ·');
      const where = t.present ? color(tty, C.gray, t.dataPath ?? '') : color(tty, C.gray, 'not found');
      console.log(`${mark} ${t.label.padEnd(16)} ${where}`);
    }
    console.log('');

    // Other AI tools we merely SEE — inventory only, never a claim we can import
    // from them. Silent when none are found, so an all-clear machine doesn't get
    // a hollow section header.
    const otherPresent = plan.otherApps.filter((a) => a.present);
    if (otherPresent.length > 0) {
      console.log(color(tty, C.bold, '  Other AI tools detected (not yet natively supported)'));
      for (const a of otherPresent) {
        console.log(`  ${color(tty, C.gray, '·')} ${a.label.padEnd(16)} ${color(tty, C.gray, a.notReadBecause ? `not read: ${a.notReadBecause}` : a.evidence ?? '')}`);
      }
      console.log(color(tty, C.gray, '    We see these exist, but don\'t read their usage data yet — spend from them isn\'t counted above.'));
      console.log('');
    }

    // Discovered repos.
    const roots = plan.roots.length ? plan.roots.join(', ') : '(none existed)';
    console.log(color(tty, C.bold, `  Git repositories under ${roots}`));
    if (plan.repos.length === 0) {
      console.log(color(tty, C.gray, '    None found. Point the scan at your code folder:  segreant scan <path>'));
    } else {
      console.log(
        `    ${color(tty, C.green, `${plan.repos.length} repo(s)`)} found` +
          `   ${color(tty, C.gray, `(${plan.reposWithSpend.length} already have AI spend on record → RoI-ready)`)}`,
      );
      for (const r of plan.repos.slice(0, 12)) {
        const ready = plan.reposWithSpend.includes(r);
        const tag = ready ? color(tty, C.green, '  ✓ has AI spend → RoI-ready') : color(tty, C.gray, '  no AI spend recorded yet');
        console.log(`    ${color(tty, C.gray, r)}${tag}`);
      }
      if (plan.repos.length > 12) console.log(color(tty, C.gray, `    …and ${plan.repos.length - 12} more`));
    }
    if (plan.scan.hitBudget) {
      console.log('');
      console.log(color(tty, C.yellow, `    Stopped after ${num(plan.scan.dirsVisited)} folders (budget) — results are partial.`));
      console.log(color(tty, C.gray, '    Point at a narrower folder, or the results above are a representative sample.'));
    }
    if (plan.scan.unreadableDirs.length > 0) {
      console.log('');
      console.log(
        color(tty, C.yellow, `    ${num(plan.scan.unreadableDirs.length)} folder(s) could not be read (permissions) — repo count may be incomplete.`),
      );
    }
    console.log('');

    renderScanDiff(tty, diff);
  }

  // Imported rows keep the price they were recorded at, so a stale card turns
  // every model newer than it into a fallback estimate for good (until a
  // reprice). Say so BEFORE the import, where it can still be avoided.
  const prices = pricingStatus(loadConfig().pricing.maxAgeDays);
  if (prices.stale && !flags.json) {
    const age = prices.ageDays === null ? 'of unknown age' : `${num(prices.ageDays)} days old`;
    console.log(color(tty, C.yellow, `  Prices are ${age}: models released since then will be priced by a fallback estimate.`));
    console.log(color(tty, C.gray, '  Update them first with  segreant pricing --refresh  (it prints the one permission it needs),'));
    console.log(color(tty, C.gray, '  or afterwards with  segreant reprice  to re-price what was imported.'));
    console.log('');
  }

  if (!flags.setup) {
    // Dry run: tell them exactly what --setup would do, and why it is safe.
    if (present.length === 0 && plan.repos.length === 0) {
      console.log(color(tty, C.gray, '  Nothing to set up yet — no supported tools and no repos found here.'));
      console.log(color(tty, C.gray, '  If your code lives elsewhere, try:  segreant scan <path-to-your-projects>'));
    } else {
      const toolNames = present.map((t) => t.label).join(', ') || 'no detected tools';
      console.log(color(tty, C.bold, '  Ready to set up:'));
      console.log(color(tty, C.gray, `    • import usage from: ${toolNames}`));
      // Correlation follows the SPEND — it values every project the tools actually
      // ran in (which may live outside this folder), not the raw repo count above.
      console.log(color(tty, C.gray, '    • correlate every project your tools ran in into per-project RoI'));
      console.log('');
      console.log(`  Do it in one step:  ${color(tty, C.bold, 'segreant scan' + (root ? ` ${root}` : '') + ' --setup')}`);
      console.log(color(tty, C.gray, '  Then re-run scan to see which repos here got valued.'));
    }
    console.log('');
    store.close();
    return;
  }

  // --setup: the deliberate, mutating step. Import every present tool, then correlate.
  // The work always runs; every line below is human-readable progress output, gated
  // behind !flags.json so `--setup --json` emits clean, parseable JSON like every
  // other command in this file (cmdImport, cmdDiscover, …) — never mixed with prose.
  if (!flags.json) console.log(color(tty, C.bold, '  Setting up…'));
  let totalNew = 0;
  // Newest first: the logs of the last 30 days, then the month's number, then
  // the older history. The month is exact after the first pass (see
  // ImportOptions.modifiedSinceMs); the backfill only adds older rows.
  const month = rangeFor('month');
  const reading = !flags.json && process.stderr.isTTY;
  const recent = new Map<string, ImportSummary>();
  for (const t of present) {
    const runner = IMPORT_RUNNERS[t.id];
    if (!runner) continue;
    if (reading) process.stderr.write(`    Reading the last 30 days of ${t.label} logs…`);
    recent.set(t.id, await runner.run(store, runner.recentFirst ? { modifiedSinceMs: month.startMs } : {}));
    if (reading) process.stderr.write('\r\x1b[2K');
  }
  if (!flags.json && recent.size > 0) {
    const m = store.summary(month.startMs, month.endMs);
    console.log(`    ${color(tty, C.bold, 'Last 30 days')}  ${color(tty, C.green, usd(m.costUsd))} list cost  ${color(tty, C.gray, `(${num(m.requests)} requests · priced from the rate card · an estimate, not your bill)`)}`);
    console.log(color(tty, C.gray, '    Now reading older history, then measuring what the work produced…'));
  }
  for (const t of present) {
    const runner = IMPORT_RUNNERS[t.id];
    if (!runner) {
      if (!flags.json) {
        console.log(color(tty, C.yellow, `    ! ${t.label.padEnd(16)} detected, but no importer is registered — skipped`));
      }
      continue;
    }
    const first = recent.get(t.id);
    let sum: ImportSummary;
    if (runner.recentFirst) {
      if (reading) process.stderr.write(`    Reading older ${t.label} logs…`);
      sum = mergeImportSummaries(first, await runner.run(store, {}));
      if (reading) process.stderr.write('\r\x1b[2K');
    } else {
      sum = first!;
    }
    totalNew += sum.inserted;
    if (!flags.json) {
      console.log(
        `    ${color(tty, C.green, '✓')} ${t.label.padEnd(16)} ${color(tty, C.green, `${num(sum.inserted)} new`)}` +
          `  ${color(tty, C.gray, `(${num(sum.eventsSeen)} seen · ${usd(sum.costUsd)})`)}`,
      );
      if (sum.conflictingObservations) {
        console.log(color(tty, C.yellow, `      ${num(sum.conflictingObservations)} request(s) already recorded with a different charge — kept the first record, left these out.`));
      }
    }
  }
  if (present.length === 0 && !flags.json) console.log(color(tty, C.gray, '    No detected tools to import.'));

  const progress = repoProgress(flags);
  const discovered = await realizeDiscoveredProjects(store, {
    onProgress: progress.onProgress, sinceDays: CLI_PERIOD_DAYS, gitScanBudgetMs: CLI_GIT_BUDGET_MS,
    stageBudgetMs: SCAN_VALUE_BUDGET_MS,
  });
  progress.finish();
  store.close();

  if (!flags.json) {
    console.log('');
    const shown = discovered.filter((d) => d.skipped !== 'no-spend');
    console.log(color(tty, C.bold, `  Did the AI work stay in the code?`) + color(tty, C.gray, `   last ${CLI_PERIOD_DAYS} days by project · list cost (estimate), not your bill`));
    for (const d of shown.slice(0, 12)) {
      const tools = d.sources.length ? d.sources.join(', ') : 'unknown';
      console.log(`    ${color(tty, C.bold, d.project.padEnd(24))} ${usd(d.periodCostUsd ?? d.costUsd).padStart(10)}   ${keptLine(tty, d)}   ${color(tty, C.gray, `coded with: ${tools}`)}`);
    }
    if (shown.length > 12) console.log(color(tty, C.gray, `    …and ${shown.length - 12} more (segreant discover lists them all)`));
    const idle = discovered.length - shown.length;
    if (idle > 0) console.log(color(tty, C.gray, `    ${idle} more repositor${idle === 1 ? 'y has' : 'ies have'} no priced AI spend in the last ${CLI_PERIOD_DAYS} days.`));
    printUnmeasured(tty, discovered);
    console.log('');
    console.log(color(tty, C.gray, '  Kept: most of a commit\'s lines are still in the code after 14 days. Not kept: rewritten, removed or reverted.'));
    console.log(color(tty, C.gray, '  The full picture for one project: segreant realize --repo <path> · value against your time: segreant roi'));
    console.log(color(tty, C.gray, `  Imported ${num(totalNew)} new request(s). Now live in: segreant today · month · the dashboard.`));
    console.log(color(tty, C.gray, '  Safe to re-run any time to fold in new tools, repos, and traffic.'));
    console.log('');
  }

  if (flags.json) printJson({ setup: true, totalNew, discovered });
}
