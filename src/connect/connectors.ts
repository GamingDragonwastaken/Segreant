/**
 * Connectors — turning an AI tool into a SOURCE.
 *
 * The product meters by SOURCE: a tool deliberately routed through Fiscus so
 * its spend is attributed. "Connecting" a tool is two things — point it at the
 * local proxy, and tag its traffic with an `x-aegis-source` header. The tag is
 * stripped before the request leaves the machine (connect, don't intercept), so
 * the provider never sees it.
 *
 * This module is PURE (no fs, no process) so the recipe + config merge are unit
 * testable; the CLI does the file I/O and the friendly printing. Keep it small:
 * when a third config-file connector lands, the per-tool shapes here are the
 * seam to extract a shared Connector abstraction.
 */

import { join } from 'node:path';

export const SOURCE_HEADER = 'x-aegis-source';

/**
 * The project-attribution header. Connecting a tool only tagged its SOURCE, so a
 * correctly connected tool still metered with no project at all — its spend landed
 * under the `default` label as `unattributed`.
 *
 * A connector writes a STATIC config, so this header can only be set where the
 * config's scope really is one project. Baking a label into a config that governs
 * every directory would be worse than leaving it unattributed: every future
 * request, in any repo, would carry one project name and be recorded as
 * `client_declared` — a confident wrong answer instead of an honest blank.
 */
export const PROJECT_HEADER = 'x-aegis-project';

/**
 * Whether an opencode config is scoped to one project, and if so which.
 *
 * Project-scoped means the config file sits in the working directory itself —
 * the per-project `opencode.json(c)` case, which opencode gives highest
 * precedence and which by construction applies to that project only. A global
 * config (`~/.config/opencode/`) or one pointed at by `OPENCODE_CONFIG` governs
 * work in every directory, so no single project label is true for it.
 *
 * Pure: takes the paths, does no I/O, so the decision is unit-testable.
 */
export function opencodeConfigScope(opts: { configPath: string; cwd: string }): {
  scope: 'project' | 'global';
  project: string | null;
} {
  const dir = opts.configPath.slice(0, Math.max(opts.configPath.lastIndexOf('/'), opts.configPath.lastIndexOf('\\')));
  const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();
  if (norm(dir) !== norm(opts.cwd)) return { scope: 'global', project: null };
  const base = opts.cwd
    .split(/[\\/]/)
    .filter(Boolean)
    .pop();
  // A rootless cwd yields no usable label; stay global rather than invent one.
  return base && base.trim() ? { scope: 'project', project: base.trim() } : { scope: 'global', project: null };
}

/**
 * The proxy base URL for an openai-compatible client that appends the request
 * path itself (e.g. opencode's `@ai-sdk/openai-compatible` posts to
 * `${baseURL}/chat/completions`). NO trailing `/v1`: the proxy appends the path
 * and the router matches `/chat/completions` without a version prefix, so a `/v1`
 * here would double-version the upstream URL → 404.
 */
export function proxyBaseUrl(port: number): string {
  return `http://localhost:${port}`;
}

/**
 * Locate the opencode config the user actually uses, mirroring opencode's own
 * resolution order: an explicit `OPENCODE_CONFIG` path, then a project-level
 * `opencode.json(c)` in the working dir, then the global `~/.config/opencode/`.
 * Returns the first that exists (or null). Pure — takes an `exists` probe — so
 * `connect opencode` probes/writes the REAL file instead of only ever the global
 * one (many opencode users keep a per-project config, which is highest-precedence
 * for opencode itself).
 */
export function resolveOpencodeConfigPath(opts: {
  env?: string;
  cwd: string;
  home: string;
  exists: (p: string) => boolean;
}): string | null {
  const { env, cwd, home, exists } = opts;
  if (env && exists(env)) return env;
  for (const name of ['opencode.jsonc', 'opencode.json']) {
    const p = join(cwd, name);
    if (exists(p)) return p;
  }
  for (const name of ['opencode.jsonc', 'opencode.json']) {
    const p = join(home, '.config', 'opencode', name);
    if (exists(p)) return p;
  }
  return null;
}

export interface ConnectorInfo {
  id: string;
  label: string;
  kind: 'config-file' | 'env' | 'local-files';
  summary: string;
}

/** Known connectors. opencode is the first config-file connector; `api` is the generic env recipe. */
export const CONNECTORS: ConnectorInfo[] = [
  { id: 'opencode', label: 'opencode', kind: 'config-file', summary: 'Terminal AI agent — adds a metered provider to opencode.json(c).' },
  { id: 'claude-code', label: 'Claude Code', kind: 'local-files', summary: 'NATIVE, no routing: imports exact usage from local transcripts — works on subscriptions.' },
  { id: 'antigravity', label: 'Antigravity', kind: 'env', summary: 'Google Antigravity IDE — custom OpenAI-compatible provider pointed at the proxy.' },
  { id: 'api', label: 'API / SDK', kind: 'env', summary: 'Any OpenAI-compatible SDK, script, or curl — base URL + one header.' },
];

/**
 * Google's OpenAI-compatible endpoint for Gemini. The free-tier upstream for
 * any tool that speaks the OpenAI protocol: tool → proxy → this, with the
 * user's own Gemini key passing through untouched.
 */
export const GEMINI_OPENAI_COMPAT_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai';

/**
 * The opencode provider block that routes traffic through the proxy and tags it
 * as the `opencode` source. apiKey/model default to the Gemini free tier (the
 * upstream `fiscus start` fronts by default); a user can change them — the
 * merge below preserves whatever they already set.
 */
export function opencodeProviderBlock(port: number, project?: string | null): Record<string, unknown> {
  return {
    npm: '@ai-sdk/openai-compatible',
    name: 'Fiscus (metered)',
    options: {
      baseURL: proxyBaseUrl(port),
      apiKey: '{env:GEMINI_API_KEY}',
      // The project header is added only for a project-scoped config; see
      // PROJECT_HEADER for why a global config must not carry one.
      headers: project ? { [SOURCE_HEADER]: 'opencode', [PROJECT_HEADER]: project } : { [SOURCE_HEADER]: 'opencode' },
    },
    models: { 'gemini-2.5-flash': { name: 'Gemini 2.5 Flash (via Fiscus)' } },
  };
}

/**
 * Strip `//` line + block comments and trailing commas from JSONC → parseable
 * JSON. String-aware in a single pass: comment markers, commas, and `}`/`]`
 * inside double-quoted strings are left untouched (so a value like "a,]" or a
 * URL "http://x" is never corrupted). JSONC strings are double-quoted only.
 */
export function stripJsonc(s: string): string {
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < s.length) {
    const c = s[i]!;
    const n = s[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += n ?? '';
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === ',') {
      // Drop a trailing comma: a comma whose next non-whitespace char closes an
      // object/array. Done here (not via regex) so commas inside strings survive.
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j]!)) j++;
      if (s[j] === '}' || s[j] === ']') {
        i++;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

export interface MergeResult {
  ok: boolean;
  merged?: string;
  alreadyConnected?: boolean;
  error?: string;
}

/**
 * Add (or update) the Fiscus source provider in an opencode config. PRESERVES
 * the user's existing provider settings (apiKey, models, baseURL) — it only
 * ensures the source header (and fills baseURL/npm if absent). Idempotent:
 * re-running on an already-tagged config reports `alreadyConnected` and changes
 * nothing meaningful. On unparseable input it returns `{ ok: false }` so the
 * caller can fall back to printing the snippet instead of writing garbage.
 */
export function mergeOpencodeConfig(raw: string, port: number, project?: string | null): MergeResult {
  let obj: Record<string, unknown>;
  try {
    obj = raw.trim() ? (JSON.parse(stripJsonc(raw)) as Record<string, unknown>) : {};
  } catch (e) {
    return { ok: false, error: `could not parse the existing config: ${String(e)}` };
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return { ok: false, error: 'the config root is not a JSON object' };
  }

  const provider = (obj.provider ??= {}) as Record<string, unknown>;
  const block = opencodeProviderBlock(port, project);
  const existing = provider.fiscus as Record<string, unknown> | undefined;
  let alreadyConnected = false;

  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    const options = (existing.options ??= {}) as Record<string, unknown>;
    const headers = (options.headers ??= {}) as Record<string, unknown>;
    // `alreadyConnected` means nothing meaningful would change — so a config
    // that is tagged but still missing a project label it should now carry is
    // NOT already connected.
    if (headers[SOURCE_HEADER] === 'opencode' && (!project || headers[PROJECT_HEADER] === project)) alreadyConnected = true;
    headers[SOURCE_HEADER] = 'opencode';
    if (project) headers[PROJECT_HEADER] = project;
    options.baseURL ??= (block.options as Record<string, unknown>).baseURL;
    existing.npm ??= block.npm;
  } else {
    provider.fiscus = block;
  }

  return { ok: true, merged: JSON.stringify(obj, null, 2) + '\n', alreadyConnected };
}

export interface OpencodeProvider {
  name: string;
  baseUrl: string | null;
  wrappable: boolean; // has an options.baseURL we can route through the proxy
}

/**
 * List the providers already in an opencode config, with the baseURL each routes
 * to. This is the raw material for the HONEST native connection: rather than add a
 * throwaway stub provider, we wrap a provider the user ALREADY uses. A provider
 * with no `options.baseURL` is a hosted/managed one (e.g. opencode Zen) that talks
 * straight to its own servers — not wrappable by a cooperative proxy, and we say so.
 */
export function listOpencodeProviders(raw: string): OpencodeProvider[] {
  let obj: Record<string, unknown>;
  try {
    obj = raw.trim() ? (JSON.parse(stripJsonc(raw)) as Record<string, unknown>) : {};
  } catch {
    return [];
  }
  const provider = obj.provider;
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) return [];
  const out: OpencodeProvider[] = [];
  for (const [name, v] of Object.entries(provider as Record<string, unknown>)) {
    const opts = v && typeof v === 'object' ? ((v as Record<string, unknown>).options as Record<string, unknown> | undefined) : undefined;
    const baseUrl = typeof opts?.baseURL === 'string' ? (opts.baseURL as string) : null;
    out.push({ name, baseUrl, wrappable: baseUrl !== null });
  }
  return out;
}

export interface WrapResult {
  ok: boolean;
  merged?: string;
  originalBaseUrl?: string; // the base to point Fiscus's upstream at; undefined if already wrapped
  alreadyWrapped?: boolean;
  error?: string;
}

/**
 * Wrap an EXISTING opencode provider so its traffic routes through Fiscus — the
 * honest native connection. It rewrites that provider's `options.baseURL` to the
 * local proxy and tags it `x-aegis-source: opencode`, returning the provider's
 * ORIGINAL baseURL so the caller can set Fiscus's upstream to it (the proxy then
 * forwards there, with the user's own key, unchanged). The provider's apiKey/models
 * are untouched. Idempotent: re-wrapping a provider already pointed at the proxy is
 * a no-op that just ensures the source tag. Fails safe on unparseable input or a
 * provider that has no baseURL to wrap (a hosted/managed provider that can't be
 * metered cooperatively — reported honestly, not silently mangled).
 */
export function wrapOpencodeProvider(raw: string, providerName: string, port: number, project?: string | null): WrapResult {
  let obj: Record<string, unknown>;
  try {
    obj = raw.trim() ? (JSON.parse(stripJsonc(raw)) as Record<string, unknown>) : {};
  } catch (e) {
    return { ok: false, error: `could not parse the existing config: ${String(e)}` };
  }
  const provider = obj.provider as Record<string, unknown> | undefined;
  const target = provider?.[providerName] as Record<string, unknown> | undefined;
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    return { ok: false, error: `provider "${providerName}" not found in the opencode config` };
  }
  const options = (target.options ??= {}) as Record<string, unknown>;
  const currentBase = typeof options.baseURL === 'string' ? (options.baseURL as string) : null;
  if (currentBase === null) {
    return { ok: false, error: `provider "${providerName}" has no options.baseURL — it's a hosted/managed provider a cooperative proxy can't meter` };
  }
  const headers = (options.headers ??= {}) as Record<string, unknown>;
  headers[SOURCE_HEADER] = 'opencode';
  if (project) headers[PROJECT_HEADER] = project;

  if (currentBase.startsWith(`http://localhost:${port}`) || currentBase.startsWith(`http://127.0.0.1:${port}`)) {
    return { ok: true, merged: JSON.stringify(obj, null, 2) + '\n', alreadyWrapped: true };
  }
  options.baseURL = proxyBaseUrl(port);
  return { ok: true, merged: JSON.stringify(obj, null, 2) + '\n', originalBaseUrl: currentBase };
}
