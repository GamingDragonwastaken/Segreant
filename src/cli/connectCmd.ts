/**
 * `aegisflow connect <tool>` — per-tool connection recipes (opencode wrap
 * flows, Antigravity, generic OpenAI-compatible APIs). Extracted verbatim
 * from cli.ts in the per-command-module split; only cmdConnect is exported,
 * the per-tool flows stay module-internal.
 */

import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { loadConfig, saveConfig, type AegisConfig } from '../config.ts';
import {
  SOURCE_HEADER,
  CONNECTORS,
  GEMINI_OPENAI_COMPAT_BASE,
  opencodeProviderBlock,
  mergeOpencodeConfig,
  resolveOpencodeConfigPath,
  listOpencodeProviders,
  wrapOpencodeProvider,
} from '../connect/connectors.ts';
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
  const snippet = JSON.stringify({ aegisflow: block }, null, 2);
  console.log('');
  for (const line of snippet.split('\n')) console.log(color(tty, C.cyan, '    ' + line));
  console.log('');
}

/** The shared closing note: where the key/model come from + how to verify. */
function finishConnectOpencode(tty: boolean): void {
  console.log(color(tty, C.gray, '  apiKey/model are whatever provider you actually route through AegisFlow — point'));
  console.log(color(tty, C.gray, "  AegisFlow's upstream at that provider. (The example block shows the Gemini free tier;"));
  console.log(color(tty, C.gray, '  swap in the provider + key you already use.) Then run opencode and check:'));
  console.log(color(tty, C.green, '    aegisflow sources'));
  console.log('');
}

/**
 * The honest NATIVE connection: wrap an opencode provider the user ALREADY has.
 * Rewrites that provider's baseURL to the proxy (+ source tag) and sets AegisFlow's
 * upstream to the provider's real base, so opencode keeps working exactly as before
 * but its traffic is metered and forwarded with the user's own key. Two local files
 * change on --write (opencode config + AegisFlow config); read-only preview otherwise.
 */
function wrapOpencodeFlow(cfg: AegisConfig, flags: Flags, tty: boolean, providerName: string, path: string | null): void {
  if (!path) {
    console.log(color(tty, C.yellow, '  No opencode config found to wrap. Run `aegisflow connect opencode` to see your options.'));
    console.log('');
    return;
  }
  let raw = '';
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    /* handled by the parse below */
  }
  const res = wrapOpencodeProvider(raw, providerName, cfg.port);

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
    console.log(color(tty, C.green, `  ✓ "${providerName}" already routes through AegisFlow.`));
    console.log(color(tty, C.gray, `    AegisFlow openai upstream: ${cfg.upstreams.openai}`));
    console.log('');
    return;
  }
  console.log(color(tty, C.gray, `  opencode keeps using "${providerName}" as-is — but its requests now go to the proxy,`));
  console.log(color(tty, C.gray, `  which forwards them to ${res.originalBaseUrl} with your own key. Your key never`));
  console.log(color(tty, C.gray, "  touches AegisFlow's author, and opencode Zen (if any) is unaffected."));
  console.log('');

  if (!flags.write) {
    console.log(color(tty, C.gray, '  Two local changes (preview — nothing written yet):'));
    console.log(color(tty, C.cyan, `    1. opencode  ${providerName}.options.baseURL → http://localhost:${cfg.port}  (+ ${SOURCE_HEADER}: opencode)`));
    console.log(color(tty, C.cyan, `    2. AegisFlow upstreams.openai          → ${res.originalBaseUrl}`));
    console.log('');
    console.log(color(tty, C.green, `    aegisflow connect opencode --wrap ${providerName} --write`));
    console.log('');
    return;
  }

  try {
    copyFileSync(path, path + '.bak');
    writeFileSync(path, res.merged!, 'utf8');
    saveConfig({ ...cfg, upstreams: { ...cfg.upstreams, openai: res.originalBaseUrl! } });
    console.log(color(tty, C.green, `  ✓ Wrapped "${providerName}". opencode now routes through AegisFlow.`));
    console.log(color(tty, C.gray, `    opencode config: ${path}  (backup at ${path}.bak)`));
    console.log(color(tty, C.gray, `    AegisFlow upstreams.openai → ${res.originalBaseUrl}`));
    console.log(color(tty, C.gray, '    JSON comments were reformatted away; your settings + keys are preserved.'));
    console.log('');
    console.log(color(tty, C.gray, '  Restart AegisFlow (aegisflow start), run opencode, then:  aegisflow sources'));
  } catch (e) {
    console.log(color(tty, C.yellow, `  Could not write: ${String(e)}`));
  }
  console.log('');
}

function connectOpencode(cfg: AegisConfig, flags: Flags, tty: boolean): void {
  const port = cfg.port;
  const block = opencodeProviderBlock(port);
  const path = opencodeConfigPath();

  if (typeof flags.wrap === 'string' && flags.wrap) {
    wrapOpencodeFlow(cfg, flags, tty, flags.wrap, path);
    return;
  }

  console.log('');
  console.log(color(tty, C.bold, '  Connect opencode as a source'));
  console.log(color(tty, C.gray, '  ' + '─'.repeat(46)));
  console.log(color(tty, C.gray, `  Routes opencode through AegisFlow on http://localhost:${port} and tags its`));
  console.log(color(tty, C.gray, `  traffic with  ${SOURCE_HEADER}: opencode  (stripped before it leaves your machine).`));
  console.log('');
  console.log(color(tty, C.gray, '  This meters traffic you ROUTE through AegisFlow. opencode Zen and other managed/'));
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
    const probe = mergeOpencodeConfig(raw, port);
    if (probe.ok && probe.alreadyConnected && !flags.write) {
      console.log(color(tty, C.green, '  ✓ opencode is already connected as a source.'));
      console.log(color(tty, C.gray, `    Config: ${path}`));
      console.log(color(tty, C.gray, '    Run opencode, then:  aegisflow sources'));
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
      console.log(color(tty, C.green, `    aegisflow connect opencode --wrap <provider> --write`));
      const hosted = providers.filter((p) => !p.wrappable).map((p) => p.name);
      if (hosted.length) console.log(color(tty, C.gray, `    (hosted/managed — can't be metered cooperatively: ${hosted.join(', ')})`));
      console.log('');
      console.log(color(tty, C.gray, '  Or add a dedicated metered provider block:'));
    } else {
      console.log(color(tty, C.gray, '  Add this to the "provider" object in your opencode config:'));
    }
    printOpencodeSnippet(block, tty);
    console.log(color(tty, C.gray, '  …or let AegisFlow apply the block for you:'));
    console.log(color(tty, C.green, '    aegisflow connect opencode --write'));
    console.log('');
    finishConnectOpencode(tty);
    return;
  }

  // --write: create a fresh config if none exists.
  if (!path) {
    const dest = join(homedir(), '.config', 'opencode', 'opencode.json');
    const fresh = JSON.stringify({ $schema: 'https://opencode.ai/config.json', provider: { aegisflow: block } }, null, 2) + '\n';
    try {
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, fresh, 'utf8');
      console.log(color(tty, C.green, '  ✓ Created an opencode config with the AegisFlow source:'));
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
  const res = mergeOpencodeConfig(raw, port);
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
function connectAntigravity(cfg: AegisConfig, flags: Flags, tty: boolean): void {
  const base = `http://localhost:${cfg.port}/v1`;

  if (flags.write) {
    const next: AegisConfig = { ...cfg, upstreams: { ...cfg.upstreams, openai: GEMINI_OPENAI_COMPAT_BASE } };
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
  console.log(color(tty, C.green, '       aegisflow connect antigravity --write'));
  console.log(color(tty, C.gray, `       (sets upstreams.openai → ${GEMINI_OPENAI_COMPAT_BASE})`));
  console.log('');
  console.log(`  2) ${color(tty, C.bold, 'In Antigravity')}: Settings → Models → add a custom provider:`);
  console.log(color(tty, C.cyan, '       Provider type   OpenAI-compatible'));
  console.log(color(tty, C.cyan, `       Base URL        ${base}`));
  console.log(color(tty, C.cyan, '       API key         your provider key (passes through the proxy; never stored)'));
  console.log(color(tty, C.cyan, '       Model           e.g. gemini-2.5-flash'));
  console.log('');
  console.log(`  3) ${color(tty, C.bold, 'Run it')}: aegisflow start, use Antigravity with that model, then:`);
  console.log(color(tty, C.green, '       aegisflow today') + color(tty, C.gray, '   — the requests and their cost appear live'));
  console.log('');
  console.log(color(tty, C.gray, '  Note: without a custom-headers field the spend lands under the "direct"'));
  console.log(color(tty, C.gray, '  source. Metering, caps, and RoI all work the same.'));
  console.log('');
}

function connectGenericApi(cfg: AegisConfig, flags: Flags, tty: boolean): void {
  const port = cfg.port;
  // Optional custom source name: `aegisflow connect api my-script`.
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
  console.log(color(tty, C.gray, '  Run it, then check:'));
  console.log(color(tty, C.green, '    aegisflow sources'));
  console.log('');
}

/**
 * `aegisflow connect [<tool>] [--write] [--list]` — turn an AI tool into a source.
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
    console.log(color(tty, C.gray, '  A source is one tool routed through AegisFlow so its spend is metered,'));
    console.log(color(tty, C.gray, "  honestly, at the depth it exposes — connect, don't intercept."));
    console.log('');
    for (const c of CONNECTORS) {
      console.log(`  ${color(tty, C.green, c.id.padEnd(12))} ${color(tty, C.gray, c.summary)}`);
    }
    console.log('');
    console.log(color(tty, C.gray, '  Usage:  aegisflow connect <tool>          e.g. aegisflow connect opencode'));
    console.log(color(tty, C.gray, '          aegisflow connect opencode --write  apply it for you (backs up first)'));
    console.log('');
    console.log(color(tty, C.gray, '  No base URL to wire? Meter subscription tools natively — no routing, no key:'));
    console.log(color(tty, C.green, '          aegisflow import claude-code | opencode | codex | all   ') + color(tty, C.gray, '(--watch = live)'));
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
    console.log(color(tty, C.green, '    aegisflow import claude-code'));
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

