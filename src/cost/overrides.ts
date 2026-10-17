/**
 * Prices the user declared for models no rate card knows: a private or
 * fine-tuned model, a local model that costs nothing, or a new model the public
 * price list has not caught up with yet. A declaration is the user's claim, not
 * a published list price, so it is recorded under its own basis
 * (`user_declared_price`) and never mixed into "list cost".
 *
 * Three forms:
 * - `rate`: decimal USD per 1M tokens, the same units as the rate card;
 * - `like`: price this model at another model's rate on the current card;
 * - `free`: a local model; every request costs zero.
 *
 * The file is written only by `setPriceOverride` (validated, atomic). A hand
 * edit that breaks it is refused with the reason, never half-read: a price that
 * silently disappeared would change what a cap counts.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { acquireConfigMutationLock, DemoReadOnlyError, isDemo, segreantHome } from '../config.ts';

export type PriceOverride =
  | { kind: 'rate'; input: string; output: string; cacheRead?: string; cacheWrite?: string; declaredAt: string }
  | { kind: 'like'; like: string; declaredAt: string }
  | { kind: 'free'; declaredAt: string };

export type PriceOverrideInput =
  | { kind: 'rate'; input: string; output: string; cacheRead?: string; cacheWrite?: string }
  | { kind: 'like'; like: string }
  | { kind: 'free' };

export interface PriceOverridesFile {
  version: 1;
  models: Record<string, PriceOverride>;
}

export class PriceOverridesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PriceOverridesError';
  }
}

/** A plain non-negative decimal with at most 12 places, e.g. "0.1" or "15". */
const DECIMAL = /^(0|[1-9]\d{0,6})(\.\d{1,12})?$/;
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/;
const MAX_MODELS = 500;

export function overridesPath(): string {
  return join(segreantHome(), 'pricing', 'overrides.json');
}

function validDecimal(value: unknown, positive: boolean): value is string {
  if (typeof value !== 'string' || !DECIMAL.test(value)) return false;
  return !positive || Number(value) > 0;
}

/** The reason a model name cannot carry a declared price, or null. */
export function modelNameError(model: unknown): string | null {
  if (typeof model !== 'string' || !MODEL_NAME.test(model)) {
    return 'model names are 1-200 characters: letters, digits and . _ : @ / + -, starting with a letter or digit';
  }
  if (model === '__proto__' || model === 'constructor' || model === 'prototype') return 'that model name is reserved';
  return null;
}

function overrideError(model: string, raw: unknown, requireDeclaredAt: boolean): string | null {
  const nameError = modelNameError(model);
  if (nameError) return `${JSON.stringify(model)}: ${nameError}`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return `${model}: must be an object`;
  const o = raw as Record<string, unknown>;
  if (requireDeclaredAt && (typeof o['declaredAt'] !== 'string' || Number.isNaN(Date.parse(o['declaredAt'])))) {
    return `${model}: declaredAt must be a timestamp`;
  }
  const allowed = new Set(['kind', 'declaredAt']);
  switch (o['kind']) {
    case 'rate':
      for (const k of ['input', 'output', 'cacheRead', 'cacheWrite']) allowed.add(k);
      // Input and output must be positive: a zero there is what `free` is for,
      // and a typo'd zero would silently stop a cap from counting this model.
      if (!validDecimal(o['input'], true)) return `${model}: input must be a positive decimal (USD per 1M tokens)`;
      if (!validDecimal(o['output'], true)) return `${model}: output must be a positive decimal (USD per 1M tokens)`;
      if (o['cacheRead'] !== undefined && !validDecimal(o['cacheRead'], true)) return `${model}: cacheRead must be a positive decimal`;
      if (o['cacheWrite'] !== undefined && !validDecimal(o['cacheWrite'], true)) return `${model}: cacheWrite must be a positive decimal`;
      break;
    case 'like':
      allowed.add('like');
      if (modelNameError(o['like']) !== null) return `${model}: like must name another model`;
      if (o['like'] === model) return `${model}: cannot be priced like itself`;
      break;
    case 'free':
      break;
    default:
      return `${model}: kind must be rate, like or free`;
  }
  for (const k of Object.keys(o)) if (!allowed.has(k)) return `${model}: unknown field ${k}`;
  return null;
}

/** The first problem with a parsed overrides file, or null when it is valid. */
export function validatePriceOverrides(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'the file is not a JSON object';
  const o = raw as Record<string, unknown>;
  if (o['version'] !== 1) return 'version must be 1';
  const models = o['models'];
  if (!models || typeof models !== 'object' || Array.isArray(models)) return 'models must be an object';
  const entries = Object.entries(models as Record<string, unknown>);
  if (entries.length > MAX_MODELS) return `at most ${MAX_MODELS} declared prices`;
  for (const [model, entry] of entries) {
    const error = overrideError(model, entry, true);
    if (error) return error;
  }
  return null;
}

let cache: { path: string; mtimeMs: number; size: number; file: PriceOverridesFile } | null = null;

/** The declared prices, re-read when the file changes. Throws PriceOverridesError when the file is broken. */
export function loadPriceOverrides(): PriceOverridesFile {
  const path = overridesPath();
  if (!existsSync(path)) {
    cache = null;
    return { version: 1, models: {} };
  }
  const st = statSync(path);
  if (cache && cache.path === path && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.file;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));
  } catch {
    throw new PriceOverridesError(`${path} is not valid JSON; fix it or remove it (segreant pricing unset <model> rewrites it)`);
  }
  const error = validatePriceOverrides(parsed);
  if (error) throw new PriceOverridesError(`${path}: ${error}`);
  const file = parsed as PriceOverridesFile;
  // A null-prototype copy: a model named like an Object method can never resolve to one.
  const models: Record<string, PriceOverride> = Object.create(null);
  for (const [model, entry] of Object.entries(file.models)) models[model] = entry;
  const safe: PriceOverridesFile = { version: 1, models };
  cache = { path, mtimeMs: st.mtimeMs, size: st.size, file: safe };
  return safe;
}

/**
 * The declarations that price requests: none while showing sample data. The
 * demo is advertised as isolated, so a real negotiated rate or private model
 * name must never change or appear in it (PR #146 review).
 */
export function activePriceOverrides(): Record<string, PriceOverride> {
  return isDemo() ? Object.create(null) as Record<string, PriceOverride> : loadPriceOverrides().models;
}

export function priceOverrideFor(model: string): PriceOverride | null {
  return activePriceOverrides()[model] ?? null;
}

function writeOverrides(file: PriceOverridesFile): void {
  const path = overridesPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  const sorted: Record<string, PriceOverride> = {};
  for (const model of Object.keys(file.models).sort()) sorted[model] = file.models[model]!;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, models: sorted }, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
  cache = null;
}

/** Validate and store one declaration. Throws PriceOverridesError with the reason when it is not valid. */
/**
 * One read-modify-write at a time, across processes: two writers that each
 * loaded the same file would otherwise both succeed while the later rename
 * dropped the other's declaration (PR #146 review). The configuration lock is
 * shared, so a price edit also never interleaves with a config edit; a second
 * writer is refused with the reason rather than waiting or losing data.
 */
function withOverridesLock<T>(mutate: () => T): T {
  if (isDemo()) throw new DemoReadOnlyError();
  const lock = acquireConfigMutationLock();
  try {
    cache = null;
    return mutate();
  } finally {
    lock.release();
  }
}

export function setPriceOverride(model: string, input: PriceOverrideInput, now: Date = new Date()): PriceOverride {
  const declared = { ...input, declaredAt: now.toISOString() } as PriceOverride;
  const error = overrideError(model, declared, true);
  if (error) throw new PriceOverridesError(error);
  return withOverridesLock(() => {
    const file = loadPriceOverrides();
    const models: Record<string, PriceOverride> = { ...file.models, [model]: declared };
    if (Object.keys(models).length > MAX_MODELS) throw new PriceOverridesError(`at most ${MAX_MODELS} declared prices`);
    writeOverrides({ version: 1, models });
    return declared;
  });
}

/** Remove a declaration. Returns false when there was none. */
export function removePriceOverride(model: string): boolean {
  return withOverridesLock(() => {
    const file = loadPriceOverrides();
    if (!(model in file.models)) return false;
    const models: Record<string, PriceOverride> = {};
    for (const [name, entry] of Object.entries(file.models)) if (name !== model) models[name] = entry;
    writeOverrides({ version: 1, models });
    return true;
  });
}
