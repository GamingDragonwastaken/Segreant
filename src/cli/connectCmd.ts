/**
 * `fiscus connect <tool>` — per-tool connection recipes (opencode wrap
 * flows, Antigravity, generic OpenAI-compatible APIs). Extracted verbatim
 * from cli.ts in the per-command-module split; only cmdConnect is exported,
 * the per-tool flows stay module-internal.
 */

import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { loadConfig, saveConfig, type FiscusConfig } from '../config.ts';
import {
  SOURCE_HEADER,
  CONNECTORS,
  GEMINI_OPENAI_COMPAT_BASE,
  opencodeProviderBlock,
  mergeOpencodeConfig,
  resolveOpencodeConfigPath,
  opencodeConfigScope,
  PROJECT_HEADER,
  listOpencodeProviders,
  wrapOpencodeProvider,
} from '../connect/connectors.ts';
import { projectKey } from '../value/characterization.ts';
import { C, color } from './ui.ts';
import { type Flags } from './flags.ts';

/** Locate the user's opencode config (env override → project-level → global). */
function opencodeConfigPath(): string | null {
  return resolveOpencodeConfigPath({
    env: process.env.OPENCODE_CONFIG,
    cwd: process.cwd(),
    home: homedir(),
    exists: existsSync,
  });
}

/** Print the provider block, indented under the "provider" key it goes inside. */
function printOpencodeSnippet(block: Record<string, unknown>, tty: boolean): void {
  const snippet = JSON.stringify({ fiscus: block }, null, 2);
  console.log('');
  for (const line of snippet.split('\n')) console.log(color(tty, C.cyan, '    ' + line));
  console.log('');
}

/**
 * Say what project this connection will (or won't) attribute spend to.
 *
 * Connecting a tool used to tag only its source, so its spend metered as
 * `unattributed` under the `default` label — a correctly-followed setup that
 * still produced unattributable money. A project-scoped config can carry a real
 * label; a global one cannot, and that limit is stated instead of being papered
 * over with a guess that would be wrong in every other directory.
 */
function printAttributionNote(
  attribution: { scope: 'project' | 'global'; project: string | null },
  path: string | null,
  tty: boolean,
): void {
  if (attribution.project) {
    console.log(color(tty, C.gray, `  This config is project-scoped, so its traffic is also tagged`));
    console.log(color(tty, C.cyan, `    ${PROJECT_HEADER}: ${attribution.project}`));
    console.log(color(tty, C.gray, '  and its spend rolls up under that project instead of "unattributed".'));
  } else {
    console.log(color(tty, C.gray, `  ${path ? 'This config is global' : 'A new config here would be global'}, so Fiscus will NOT tag a project:`));
    console.log(color(tty, C.gray, '  one label baked into a config that governs every directory would be wrong'));
    console.log(color(tty, C.gray, '  everywhere else. This spend meters as "unattributed" until a project is sent.'));
    console.log(color(tty, C.gray, `  To attribute it, keep an opencode.json in the repo and re-run connect there,`));
    console.log(color(tty, C.gray, `  or have the tool send  ${PROJECT_HEADER}: <name>  per request.`));
    console.log(color(tty, C.gray, '  Check either way with:  fiscus project --coverage'));
  }
  console.log('');
}

/** The shared closing note: where the key/model come from + how to verify. */
function finishConnectOpencode(tty: boolean): void {
  console.log(color(tty, C.gray, '  apiKey/model are whatever provider you actually route through Fiscus — point'));
  console.log(color(tty, C.gray, "  Fiscus's upstream at that provider. (The example block shows the Gemini free tier;"));
  console.log(color(tty, C.gray, '  swap in the provider + key you already use.) Then run opencode and check:'));
  console.log(color(tty, C.green, '    fiscus sources'));
  console.log('');
}

/**
 * The honest NATIVE connection: wrap an opencode provider the user ALREADY has.
 * Rewrites that provider's baseURL to the proxy (+ source tag) and sets Fiscus's
 * upstream to the provider's real base, so opencode keeps working exactly as before
 * but its traffic is metered and forwarded with the user's own key. Two local files
 * change on --write (opencode config + Fiscus config); read-only preview otherwise.
 */
function wrapOpencodeFlow(cfg: FiscusConfig, flags: Flags, tty: boolean, providerName: string, path: string | null): void {
  if (!path) {
    console.log(color(tty, C.yellow, '  No opencode config found to wrap. Run `fiscus connect opencode` to see your options.'));
    console.log('');
    return;
  }
  let raw = '';
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    /* handled by the parse below */
  }
  // Only a config that lives in THIS directory is provably about one project.
  const attribution = opencodeConfigScope({ configPath: path, cwd: process.cwd() });
  const res = wrapOpencodeProvider(raw, providerName, cfg.port, attribution.project);

  console.log('');
  console.log(color(tty, C.bold, `  Connect opencode natively — wrap your "${providerName}" provider`));
  console.log(color(tty, C.gray, '  ' + '─'.repeat(46)));
  if (!res.ok) {
    console.log(color(tty, C.yellow, `  Can't wrap "${providerName}": ${res.error}`));
    const wrappable = listOpencodeProviders(raw).filter((p) => p.wrappable).map((p) => p.name);
    if (wrappable.length) console.log(color(tty, C.gray, `  Wrappable providers: ${wrappable.join(', ')}`));
    console.log('');
    return;
  }
  if (res.alreadyWrapped) {
    console.log(color(tty, C.green, `  ✓ "${providerName}" already routes through Fiscus.`));
    console.log(color(tty, C.gray, `    Fiscus openai upstream: ${cfg.upstreams.openai}`));
    console.log('');
    return;
  }
  console.log(color(tty, C.gray, `  opencode keeps using "${providerName}" as-is — but its requests now go to the proxy,`));
  console.log(color(tty, C.gray, `  which forwards them to ${res.originalBaseUrl} with your own key. Your key never`));
  console.log(color(tty, C.gray, "  touches Fiscus's author, and opencode Zen (if any) is unaffected."));
  console.log('');
  printAttributionNote(attribution, path, tty);

  if (!flags.write) {
    console.log(color(tty, C.gray, '  Two local changes (preview — nothing written yet):'));
    console.log(color(tty, C.cyan, `    1. opencode  ${providerName}.options.baseURL → http://localhost:${cfg.port}  (+ ${SOURCE_HEADER}: opencode)`));
    console.log(color(tty, C.cyan, `    2. Fiscus upstreams.openai          → ${res.originalBaseUrl}`));
    console.log('');
    console.log(color(tty, C.green, `    fiscus connect opencode --wrap ${providerName} --write`));
    console.log('');
    return;
  }

  try {
    copyFileSync(path, path + '.bak');
    writeFileSync(path, res.merged!, 'utf8');
    saveConfig({ ...cfg, upstreams: { ...cfg.upstreams, openai: res.originalBaseUrl! } });
    console.log(color(tty, C.green, `  ✓ Wrapped "${providerName}". opencode now routes through Fiscus.`));
    console.log(color(tty, C.gray, `    opencode config: ${path}  (backup at ${path}.bak)`));
    console.log(color(tty, C.gray, `    Fiscus upstreams.openai → ${res.originalBaseUrl}`));
    console.log(color(tty, C.gray, '    JSON comments were reformatted away; your settings + keys are preserved.'));
    console.log('');
    console.log(color(tty, C.gray, '  Restart Fiscus (fiscus start), run opencode, then:  fiscus sources'));
  } catch (e) {
    console.log(color(tty, C.yellow, `  Could not write: ${String(e)}`));
  }
  console.log('');
}

function connectOpencode(cfg: FiscusConfig, flags: Flags, tty: boolean): void {
  const port = cfg.port;
  const path = opencodeConfigPath();
  // A project label is only true for a config scoped to this directory. When the
  // config is global (or would be created global), the block carries no project
  // header and the note below says so rather than leaving the gap silent.
  const attribution = path
    ? opencodeConfigScope({ configPath: path, cwd: process.cwd() })
    : { scope: 'global' as const, project: null };
  const block = opencodeProviderBlock(port, attribution.project);

  if (typeof flags.wrap === 'string' && flags.wrap) {
    wrapOpencodeFlow(cfg, flags, tty, flags.wrap, path);
    return;
  }

  console.log('');
  console.log(color(tty, C.bold, '  Connect opencode as a source'));
  console.log(color(tty, C.gray, '  ' + '─'.repeat(46)));
  console.log(color(tty, C.gray, `  Routes opencode through Fiscus on http://localhost:${port} and tags its`));
  console.log(color(tty, C.gray, `  traffic with  ${SOURCE_HEADER}: opencode  (stripped before it leaves your machine).`));
  console.log('');
  console.log(color(tty, C.gray, '  This meters traffic you ROUTE through Fiscus. opencode Zen and other managed/'));
  console.log(color(tty, C.gray, '  closed paths go straight to their own servers, so they cannot be metered this way —'));
  console.log(color(tty, C.gray, "  that's the cooperative model (connect, don't intercept), not a gap being hidden."));
  console.log('');

  // Read-only state probe (reading the user's config is fine; we only WRITE on --write).
  let raw = '';
  if (path) {
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      /* unreadable → treated as absent below */
    }
    const probe = mergeOpencodeConfig(raw, port, attribution.project);
    if (probe.ok && probe.alreadyConnected && !flags.write) {
      console.log(color(tty, C.green, '  ✓ opencode is already connected as a source.'));
      console.log(color(tty, C.gray, `    Config: ${path}`));
      console.log(color(tty, C.gray, '    Run opencode, then:  fiscus sources'));
      console.log('');
      return;
    }
    console.log(color(tty, C.gray, `  Found your opencode config: ${path}`));
  } else {
    console.log(color(tty, C.gray, '  No opencode config found (checked $OPENCODE_CONFIG, ./opencode.json, ~/.config/opencode/).'));
  }

  // Default (no --write): recommend wrapping a provider the user already has (the
  // honest native path — their key, all their traffic), then offer the stub block.
  if (!flags.write) {
    const providers = raw ? listOpencodeProviders(raw) : [];
    const wrappable = providers.filter((p) => p.wrappable);
    if (wrappable.length) {
      console.log(color(tty, C.bold, '  Recommended — wrap a provider you already use (native; your key, all its traffic):'));
      for (const p of wrappable) console.log(color(tty, C.gray, `    • ${p.name}  → ${p.baseUrl}`));
      console.log(color(tty, C.green, `    fiscus connect opencode --wrap <provider> --write`));
      const hosted = providers.filter((p) => !p.wrappable).map((p) => p.name);
      if (hosted.length) console.log(color(tty, C.gray, `    (hosted/managed — can't be metered cooperatively: ${hosted.join(', ')})`));
      console.log('');
      console.log(color(tty, C.gray, '  Or add a dedicated metered provider block:'));
    } else {
      console.log(color(tty, C.gray, '  Add this to the "provider" object in your opencode config:'));
    }
    printOpencodeSnippet(block, tty);
    console.log(color(tty, C.gray, '  …or let Fiscus apply the block for you:'));
    console.log(color(tty, C.green, '    fiscus connect opencode --write'));
    console.log('');
    printAttributionNote(attribution, path, tty);
    finishConnectOpencode(tty);
    return;
  }

  // --write: create a fresh config if none exists.
  if (!path) {
    const dest = join(homedir(), '.config', 'opencode', 'opencode.json');
    const fresh = JSON.stringify({ $schema: 'https://opencode.ai/config.json', provider: { fiscus: block } }, null, 2) + '\n';
    try {
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, fresh, 'utf8');
      console.log(color(tty, C.green, '  ✓ Created an opencode config with the Fiscus source:'));
      console.log(color(tty, C.gray, `    ${dest}`));
    } catch (e) {
      console.log(color(tty, C.yellow, `  Could not write the config: ${String(e)}`));
      console.log(color(tty, C.gray, '  Add this provider block yourself instead:'));
      printOpencodeSnippet(block, tty);
    }
    console.log('');
    finishConnectOpencode(tty);
    return;
  }

  // --write with an existing config: safe-merge, backing up first.
  const res = mergeOpencodeConfig(raw, port, attribution.project);
  if (!res.ok || !res.merged) {
    console.log(color(tty, C.yellow, `  Could not safely auto-edit the config (${res.error ?? 'unknown error'}).`));
    console.log(color(tty, C.gray, '  Add this provider block yourself instead:'));
    printOpencodeSnippet(block, tty);
    console.log('');
    finishConnectOpencode(tty);
    return;
  }
  if (res.alreadyConnected) {
    console.log(color(tty, C.green, '  ✓ Already connected — no change needed.'));
    console.log('');
    finishConnectOpencode(tty);
    return;
  }
  try {
    copyFileSync(path, path + '.bak');
    writeFileSync(path, res.merged, 'utf8');
    console.log(color(tty, C.green, `  ✓ Connected. Updated ${path}`));
    console.log(color(tty, C.gray, `    A backup of the original is at ${path}.bak`));
    console.log(color(tty, C.gray, '    Note: JSON comments were reformatted away; your settings + keys are preserved.'));
  } catch (e) {
    console.log(color(tty, C.yellow, `  Could not write the config: ${String(e)}`));
    console.log(color(tty, C.gray, '  Add this provider block yourself instead:'));
    printOpencodeSnippet(block, tty);
  }
  console.log('');
  finishConnectOpencode(tty);
}

/**
 * Antigravity's BUILT-IN Gemini agent routes through Google's own servers — a
 * managed backend no cooperative proxy can meter (same class as opencode Zen).
 * But Antigravity supports CUSTOM OpenAI-compatible providers (base URL + key),
 * and those we meter fully: provider → proxy → the upstream of your choice.
 * `--write` points the proxy's OpenAI upstream at Gemini's OpenAI-compatible
 * endpoint, the free-tier test path; the user's key passes through untouched.
 */
function connectAntigravity(cfg: FiscusConfig, flags: Flags, tty: boolean): void {
  const base = `http://localhost:${cfg.port}/v1`;

  if (flags.write) {
    const next: FiscusConfig = { ...cfg, upstreams: { ...cfg.upstreams, openai: GEMINI_OPENAI_COMPAT_BASE } };
    saveConfig(next);
    console.log('');
    console.log(`  ${color(tty, C.green, '✓')} OpenAI-path upstream set to Gemini's OpenAI-compatible endpoint:`);
    console.log(color(tty, C.cyan, `      ${GEMINI_OPENAI_COMPAT_BASE}`));
    console.log(color(tty, C.gray, '    (undo: set upstreams.openai back to https://api.openai.com in config)'));
  }

  console.log('');
  console.log(color(tty, C.bold, '  Connect Google Antigravity as a source'));
  console.log(color(tty, C.gray, '  ' + '─'.repeat(52)));
  console.log(color(tty, C.gray, '  Antigravity’s built-in Gemini agent runs on Google’s servers — unmeterable'));
  console.log(color(tty, C.gray, '  by any cooperative proxy. Its CUSTOM providers, however, meter fully:'));
  console.log('');
  console.log(`  1) ${color(tty, C.bold, 'Choose the upstream')} the proxy forwards to. For the Gemini free tier:`);
  console.log(color(tty, C.green, '       fiscus connect antigravity --write'));
  console.log(color(tty, C.gray, `       (sets upstreams.openai → ${GEMINI_OPENAI_COMPAT_BASE})`));
  console.log('');
  const here = projectKey(process.cwd(), 'my-project');
  console.log(`  2) ${color(tty, C.bold, 'In Antigravity')}: Settings → Models → add a custom provider:`);
  console.log(color(tty, C.cyan, '       Provider type   OpenAI-compatible'));
  console.log(color(tty, C.cyan, `       Base URL        ${base}`));
  console.log(color(tty, C.cyan, '       API key         your provider key (passes through the proxy; never stored)'));
  console.log(color(tty, C.cyan, '       Model           e.g. gemini-2.5-flash'));
  console.log('');
  console.log(`  3) ${color(tty, C.bold, 'Run it')}: fiscus start, use Antigravity with that model, then:`);
  console.log(color(tty, C.green, '       fiscus today') + color(tty, C.gray, '   — the requests and their cost appear live'));
  console.log('');
  // Antigravity's form has no headers field, so `x-aegis-project` is simply
  // unavailable — which is why the proxy also accepts the project in the PATH.
  // It is offered, never applied: the provider entry is IDE-global, so baking in
  // whatever directory this command happened to run in would tag every future
  // request in every repo with one confidently wrong project.
  console.log(color(tty, C.bold, '  Attributing this traffic to a project'));
  console.log(color(tty, C.gray, '  Antigravity\'s custom-provider form has no custom-headers field, so the'));
  console.log(color(tty, C.gray, `  usual ${PROJECT_HEADER} header is not available. Put the project in the`));
  console.log(color(tty, C.gray, '  Base URL instead — Fiscus strips it before forwarding, so the provider'));
  console.log(color(tty, C.gray, '  sees an unchanged request:'));
  console.log('');
  console.log(color(tty, C.cyan, `       Base URL        http://localhost:${cfg.port}/fiscus/${here}/v1`));
  console.log('');
  console.log(color(tty, C.gray, '  A provider entry is IDE-wide, not per-workspace, so this is only true if'));
  console.log(color(tty, C.gray, '  you add ONE ENTRY PER PROJECT and pick the matching one. Fiscus will not'));
  console.log(color(tty, C.gray, '  set it for you: a global entry carrying whichever directory you happened'));
  console.log(color(tty, C.gray, '  to run this in would mislabel every other repo you work in.'));
  console.log('');
  console.log(color(tty, C.gray, `  Leave the plain ${base} and the traffic meters as`));
  console.log(color(tty, C.gray, '  "unattributed" instead — spend, caps and cost stay exact, Fiscus just'));
  console.log(color(tty, C.gray, '  will not claim a project it cannot know. Either way it lands under the'));
  console.log(color(tty, C.gray, `  "direct" source; a headers field, if one ever appears, takes ${SOURCE_HEADER}.`));
  console.log(color(tty, C.gray, '  Check what stuck with:  fiscus project --coverage'));
  console.log('');
}

function connectGenericApi(cfg: FiscusConfig, flags: Flags, tty: boolean): void {
  const port = cfg.port;
  // Optional custom source name: `fiscus connect api my-script`.
  const source = (typeof flags._[1] === 'string' ? flags._[1] : 'api').toLowerCase();
  // The standard OpenAI-SDK convention DOES include /v1 (the SDK appends
  // /chat/completions to it); the proxy forwards the whole path upstream.
  const base = `http://localhost:${port}/v1`;

  console.log('');
  console.log(color(tty, C.bold, `  Connect a raw API / SDK as a source ("${source}")`));
  console.log(color(tty, C.gray, '  ' + '─'.repeat(46)));
  console.log(color(tty, C.gray, '  Point any OpenAI-compatible client at the proxy and tag it with one header:'));
  console.log('');
  console.log(color(tty, C.cyan, `    OPENAI_BASE_URL = ${base}`));
  console.log(color(tty, C.cyan, `    header           ${SOURCE_HEADER}: ${source}`));
  console.log('');
  console.log(color(tty, C.gray, '  OpenAI SDK:'));
  console.log(color(tty, C.cyan, `    new OpenAI({ baseURL: "${base}", defaultHeaders: { "${SOURCE_HEADER}": "${source}" } })`));
  console.log(color(tty, C.gray, '  curl:'));
  console.log(color(tty, C.cyan, `    curl ${base}/chat/completions -H "${SOURCE_HEADER}: ${source}" ...`));
  console.log('');
  // The source tag alone leaves spend unattributed to any project. Unlike a
  // config file, this recipe is a per-caller snippet, so the caller is the only
  // one who knows which project the work belongs to — offer it, don't guess it.
  console.log(color(tty, C.gray, '  Optional — attribute the spend to a project (otherwise it meters as'));
  console.log(color(tty, C.gray, '  "unattributed" under the default label):'));
  console.log(color(tty, C.cyan, `    header           ${PROJECT_HEADER}: <project>`));
  console.log(color(tty, C.gray, '  Send it per request from the code that knows the project. Setting it once as'));
  console.log(color(tty, C.gray, '  a shell env var follows the SHELL, not the directory, so it will mislabel'));
  console.log(color(tty, C.gray, '  work after you cd elsewhere — a wrong project reads as a declared one.'));
  console.log('');
  // Some clients expose a base URL and no header hook at all. The path prefix is
  // the same declaration by another route, and it travels with the config rather
  // than with the shell — so it is the better option when the base URL itself
  // lives in a per-project file.
  console.log(color(tty, C.gray, '  If your client has no way to set headers, put the project in the URL — Fiscus'));
  console.log(color(tty, C.gray, '  strips it before forwarding, so the provider sees an unchanged request:'));
  console.log(color(tty, C.cyan, `    OPENAI_BASE_URL = http://localhost:${port}/fiscus/<project>/v1`));
  console.log(color(tty, C.gray, '  The header wins if you send both. Either way it is your declaration, recorded'));
  console.log(color(tty, C.gray, '  as such — Fiscus does not verify that the label is true.'));
  console.log('');
  console.log(color(tty, C.gray, '  Run it, then check:'));
  console.log(color(tty, C.green, '    fiscus sources'));
  console.log(color(tty, C.gray, '    fiscus project --coverage   # what the spend is attributed to, and how'));
  console.log('');
}

/**
 * `fiscus connect [<tool>] [--write] [--list]` — turn an AI tool into a source.
 * No tool (or --list) shows the menu; opencode writes/prints its provider block;
 * `api` prints the generic env + header recipe (with an optional custom source name).
 */
export function cmdConnect(flags: Flags): void {
  const tty = process.stdout.isTTY ?? false;
  const cfg = loadConfig();
  const tool = (typeof flags._[0] === 'string' ? flags._[0] : '').toLowerCase();

  if (!tool || flags.list) {
    console.log('');
    console.log(color(tty, C.bold, '  Connect an AI tool as a source'));
    console.log(color(tty, C.gray, '  A source is one tool routed through Fiscus so its spend is metered,'));
    console.log(color(tty, C.gray, "  honestly, at the depth it exposes — connect, don't intercept."));
    console.log('');
    for (const c of CONNECTORS) {
      console.log(`  ${color(tty, C.green, c.id.padEnd(12))} ${color(tty, C.gray, c.summary)}`);
    }
    console.log('');
    console.log(color(tty, C.gray, '  Usage:  fiscus connect <tool>          e.g. fiscus connect opencode'));
    console.log(color(tty, C.gray, '          fiscus connect opencode --write  apply it for you (backs up first)'));
    console.log('');
    console.log(color(tty, C.gray, '  No base URL to wire? Meter subscription tools natively — no routing, no key:'));
    console.log(color(tty, C.green, '          fiscus import claude-code | opencode | codex | all   ') + color(tty, C.gray, '(--watch = live)'));
    console.log('');
    return;
  }

  if (tool === 'opencode') {
    connectOpencode(cfg, flags, tty);
    return;
  }
  if (tool === 'antigravity') {
    connectAntigravity(cfg, flags, tty);
    return;
  }
  if (tool === 'claude-code' || tool === 'claudecode') {
    console.log('');
    console.log(color(tty, C.bold, '  Connect Claude Code — natively, no routing'));
    console.log(color(tty, C.gray, '  ' + '─'.repeat(52)));
    console.log(color(tty, C.gray, '  Claude Code already writes exact usage (model, tokens, cache splits) to'));
    console.log(color(tty, C.gray, '  local transcripts — including on Pro/Max subscriptions that never touch a'));
    console.log(color(tty, C.gray, '  proxy. No base URL to change, no key to move. Import it:'));
    console.log('');
    console.log(color(tty, C.green, '    fiscus import claude-code'));
    console.log('');
    console.log(color(tty, C.gray, '  Idempotent — re-run any time (or cron it); only new traffic is added.'));
    console.log('');
    return;
  }
  if (tool === 'api' || tool === 'sdk' || tool === 'openai' || tool === 'generic') {
    connectGenericApi(cfg, flags, tty);
    return;
  }

  console.log('');
  console.log(color(tty, C.yellow, `  Unknown tool "${tool}".`) + color(tty, C.gray, ' Known connectors:'));
  for (const c of CONNECTORS) console.log(`    ${color(tty, C.green, c.id)}  ${color(tty, C.gray, c.summary)}`);
  console.log('');
}

