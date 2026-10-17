/** User-declared model prices; historical request amounts remain unchanged. */
import { existsSync } from 'node:fs';
import { dbPath, isDemo } from '../config.ts';
import {
  modelNameError, PriceOverridesError, removePriceOverride,
  type PriceOverride, type PriceOverrideInput,
} from '../cost/overrides.ts';
import { declarePrice as declare, unknownModels } from '../cost/declarations.ts';
import { Store } from '../store/db.ts';
import type { Flags } from './flags.ts';
import { printJson, usd } from './ui.ts';

const NEXT_STEP = 'segreant reprice previews re-pricing recorded requests; nothing changes without --apply.';
const SET_WAYS = 'Set a price: segreant pricing set <model> --input <usd> --output <usd> (USD per 1M tokens), --like <known-model>, or --free.';
const PRICE_OPTIONS = ['input', 'output', 'cache-read', 'cache-write', 'like', 'free'];

function priceInput(flags: Flags): PriceOverrideInput {
  // Read every form before choosing one, including cache-only mixtures.
  const input = flags.input;
  const output = flags.output;
  const cacheRead = flags['cache-read'];
  const cacheWrite = flags['cache-write'];
  const like = flags.like;
  const free = flags.free;
  const rate = [input, output, cacheRead, cacheWrite].some((v) => v !== undefined);
  if (Number(rate) + Number(like !== undefined) + Number(free !== undefined) !== 1) {
    throw new PriceOverridesError('Choose exactly one price form: --input with --output, --like, or --free; do not mix them.');
  }
  if (free !== undefined) {
    if (free !== true) throw new PriceOverridesError('--free is a switch; give it no value.');
    return { kind: 'free' };
  }
  if (like !== undefined) {
    if (typeof like !== 'string') throw new PriceOverridesError('--like needs an exact model name from the rate card.');
    return { kind: 'like', like };
  }
  if (typeof input !== 'string' || typeof output !== 'string') {
    throw new PriceOverridesError('A rate needs both --input <usd> and --output <usd> (USD per 1M tokens).');
  }
  if (cacheRead !== undefined && typeof cacheRead !== 'string') throw new PriceOverridesError('--cache-read needs a decimal USD price per 1M tokens.');
  if (cacheWrite !== undefined && typeof cacheWrite !== 'string') throw new PriceOverridesError('--cache-write needs a decimal USD price per 1M tokens.');
  return {
    kind: 'rate', input, output,
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
  };
}

function storedLine(model: string, price: PriceOverride): string {
  if (price.kind === 'free') return `Stored user-declared price for ${model}: free ($0 per request).`;
  if (price.kind === 'like') return `Stored user-declared price for ${model}: like ${price.like} (exact rate-card model).`;
  const cache = [
    ...(price.cacheRead === undefined ? [] : [`cache-read $${price.cacheRead}`]),
    ...(price.cacheWrite === undefined ? [] : [`cache-write $${price.cacheWrite}`]),
  ];
  return `Stored user-declared price for ${model}: input $${price.input}, output $${price.output}${cache.length ? `, ${cache.join(', ')}` : ''} (USD per 1M tokens).`;
}

/** No ledger is created just to inspect historical usage. */
function readLedger<T>(empty: T, read: (store: Store) => T): T {
  const path = dbPath();
  if (!existsSync(path)) return empty;
  // An existing ledger opens as every command opens it; a missing one is not created.
  const store = new Store(path);
  try { return read(store); } finally { store.close(); }
}

/** `flags._` includes the action. Input refusals are one line and exit 2. */
export function cmdPricingDeclare(action: 'set' | 'unset' | 'unknown', flags: Flags): void {
  try {
    const allowed = new Set(['_', 'debug', 'help', 'demo', ...(action === 'set' ? PRICE_OPTIONS : action === 'unknown' ? ['json'] : [])]);
    const unsupported = Object.keys(flags).find((k) => !allowed.has(k));
    if (unsupported) throw new PriceOverridesError(`--${unsupported} does nothing for segreant pricing ${action}.`);
    if (action === 'unknown') {
      if (flags._.length !== 1) throw new PriceOverridesError('Usage: segreant pricing unknown [--json]');
      const models = readLedger<ReturnType<Store['unresolvedModels']>>([], unknownModels);
      if (flags.json) {
        printJson({ models, costBasis: 'recorded cost (estimated)', nextStep: SET_WAYS, demo: isDemo() });
      } else {
        if (isDemo()) console.log('  DEMO DATA — synthetic requests.');
        if (models.length === 0) console.log('  No unresolved models with recorded guessed prices.');
        for (const r of models) {
          console.log(`  ${r.provider}  ${r.model}  ${r.requests} recorded requests  recorded cost (estimated): ${usd(r.costUsd)}  current match: ${r.rateMatchKind}`);
        }
        console.log(`  ${SET_WAYS}`);
      }
      return;
    }
    const model = flags._[1];
    if (flags._.length !== 2 || model === undefined) throw new PriceOverridesError(`Usage: segreant pricing ${action} <model>${action === 'set' ? ' --input <usd> --output <usd> | --like <known-model> | --free' : ''}`);
    const error = modelNameError(model);
    if (error) throw new PriceOverridesError(error);
    if (isDemo()) throw new PriceOverridesError('Demo mode only shows sample data; run without --demo to change a declared price.');
    if (action === 'unset') {
      console.log(removePriceOverride(model) ? `  Removed declared price for ${model}.` : `  No declared price for ${model}.`);
      console.log(`  ${NEXT_STEP}`);
      return;
    }
    const input = priceInput(flags);
    const recorded = readLedger({ requests: 0, costUsd: 0 }, (store) => {
      return store.byModel(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
        .filter((r) => r.label === model)
        .reduce((total, r) => ({ requests: total.requests + r.requests, costUsd: total.costUsd + r.costUsd }), { requests: 0, costUsd: 0 });
    });
    const price = declare(model, input);
    console.log(`  ${storedLine(model, price)}`);
    console.log(`  ${recorded.requests} recorded requests use ${model}; recorded cost (estimated): ${usd(recorded.costUsd)}.`);
    console.log(`  ${NEXT_STEP}`);
  } catch (error) {
    if (!(error instanceof PriceOverridesError)) throw error;
    console.error('  ' + error.message.replace(/[\r\n]+/g, ' '));
    process.exitCode = 2;
  }
}

export type ModelPriceDeclaration = PriceOverride & { model: string };

/** Ask once per model name, with at most one retry; callers own terminal IO. */
export async function promptForUnknownModels(
  models: readonly { model: string }[],
  io: { ask(question: string): Promise<string>; print(line: string): void },
): Promise<ModelPriceDeclaration[]> {
  const made: ModelPriceDeclaration[] = [];
  for (const model of new Set(models.map((m) => m.model))) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const answer = (await io.ask(`price for ${model}? [Enter] skip  l <model> like another  p <in> <out> price per 1M  f free`)).trim();
      if (answer === '' || answer === 's') break;
      const words = answer.split(/\s+/);
      let input: PriceOverrideInput | undefined;
      if (words[0] === 'f' && words.length === 1) input = { kind: 'free' };
      if (words[0] === 'l' && words.length === 2) input = { kind: 'like', like: words[1]! };
      if (words[0] === 'p' && words.length === 3) input = { kind: 'rate', input: words[1]!, output: words[2]! };
      try {
        if (!input) throw new PriceOverridesError('Use Enter or s to skip, l <model>, p <in> <out>, or f.');
        const price = declare(model, input);
        made.push({ model, ...price });
        io.print(`  ${storedLine(model, price)}`);
        break;
      } catch (error) {
        if (!(error instanceof PriceOverridesError)) throw error;
        io.print(`  ${error.message.replace(/[\r\n]+/g, ' ')} ${attempt === 0 ? 'Try once more (Enter skips).' : 'Skipped.'}`);
      }
    }
  }
  return made;
}
