/**
 * Connectors — turning an AI tool into a SOURCE.
 *
 * The product meters by SOURCE: a tool deliberately routed through AegisFlow so
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
  kind: 'config-file' | 'env';
  summary: string;
}

/** Known connectors. opencode is the first config-file connector; `api` is the generic env recipe. */
export const CONNECTORS: ConnectorInfo[] = [
  { id: 'opencode', label: 'opencode', kind: 'config-file', summary: 'Terminal AI agent — adds a metered provider to opencode.json(c).' },
  { id: 'api', label: 'API / SDK', kind: 'env', summary: 'Any OpenAI-compatible SDK, script, or curl — base URL + one header.' },
];

/**
 * The opencode provider block that routes traffic through the proxy and tags it
 * as the `opencode` source. apiKey/model default to the Gemini free tier (the
 * upstream `aegisflow start` fronts by default); a user can change them — the
 * merge below preserves whatever they already set.
 */
export function opencodeProviderBlock(port: number): Record<string, unknown> {
  return {
    npm: '@ai-sdk/openai-compatible',
    name: 'AegisFlow (metered)',
    options: {
      baseURL: proxyBaseUrl(port),
      apiKey: '{env:GEMINI_API_KEY}',
      headers: { [SOURCE_HEADER]: 'opencode' },
    },
    models: { 'gemini-2.5-flash': { name: 'Gemini 2.5 Flash (via AegisFlow)' } },
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
 * Add (or update) the AegisFlow source provider in an opencode config. PRESERVES
 * the user's existing provider settings (apiKey, models, baseURL) — it only
 * ensures the source header (and fills baseURL/npm if absent). Idempotent:
 * re-running on an already-tagged config reports `alreadyConnected` and changes
 * nothing meaningful. On unparseable input it returns `{ ok: false }` so the
 * caller can fall back to printing the snippet instead of writing garbage.
 */
export function mergeOpencodeConfig(raw: string, port: number): MergeResult {
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
  const block = opencodeProviderBlock(port);
  const existing = provider.aegisflow as Record<string, unknown> | undefined;
  let alreadyConnected = false;

  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    const options = (existing.options ??= {}) as Record<string, unknown>;
    const headers = (options.headers ??= {}) as Record<string, unknown>;
    if (headers[SOURCE_HEADER] === 'opencode') alreadyConnected = true;
    headers[SOURCE_HEADER] = 'opencode';
    options.baseURL ??= (block.options as Record<string, unknown>).baseURL;
    existing.npm ??= block.npm;
  } else {
    provider.aegisflow = block;
  }

  return { ok: true, merged: JSON.stringify(obj, null, 2) + '\n', alreadyConnected };
}
