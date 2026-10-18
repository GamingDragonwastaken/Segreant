/** Shared CLI/dashboard declarations and the current unresolved-model read model. */
import type { Store } from '../store/db.ts';
import { isDemo } from '../config.ts';
import { modelNameError, PriceOverridesError, setPriceOverride, type PriceOverride, type PriceOverrideInput } from './overrides.ts';
import { cardEntryAnywhere, loadPricing, rateFor, type Provider } from './pricing.ts';

export function declarePrice(model: string, input: PriceOverrideInput, options: { force?: boolean } = {}): PriceOverride {
  if (isDemo()) throw new PriceOverridesError('Demo mode only shows sample data; run without --demo to declare a price.');
  // Only the CLI's --force can store a forced free price; a force arriving in
  // the input itself (a dashboard body) is refused, never honoured.
  if (input.kind === 'free' && (input as { force?: unknown }).force !== undefined) {
    throw new PriceOverridesError('force is set only by segreant pricing set <model> --free --force.');
  }
  if (input.kind === 'free' && options.force === true) return setPriceOverride(model, { ...input, force: true });
  if (input.kind === 'free') {
    // A free price on a model the card prices makes a cap count real cloud
    // spend as $0. A zero rate is refused for the same reason; `free` is for a
    // model that runs locally, so a card match needs an explicit --force
    // (owner decision, 2026-10-18).
    const entry = cardEntryAnywhere(model);
    if (entry) {
      throw new PriceOverridesError(
        `${model} is a cloud model the rate card prices (${entry.provider}: $${entry.input} in / $${entry.output} out per 1M tokens). ` +
        `Declaring it free would make a cap count its spend as $0. If it really runs locally under this name: ` +
        `segreant pricing set ${model} --free --force`);
    }
  }
  if (input.kind === 'like') {
    const error = modelNameError(input.like);
    if (error) throw new PriceOverridesError(`--like: ${error}`);
    // A declaration or family guess is insufficient: point directly at a named card entry.
    if (!Object.values(loadPricing().providers).some((p) => Object.hasOwn(p.models, input.like))) {
      throw new PriceOverridesError(`${input.like} is not an exact rate-card match; segreant pricing --coverage lists models seen.`);
    }
  }
  return setPriceOverride(model, input);
}

/** Recorded guesses that are still guesses under today's card and declarations. */
export function unknownModels(store: Store): ReturnType<Store['unresolvedModels']> {
  const recorded = store.unresolvedModels();
  const models = new Map<string, (typeof recorded)[number]>();
  for (const row of recorded) {
    const match = rateFor(row.provider as Provider, row.model).pricing.rateMatchKind;
    if (match === 'exact_provider' || match === 'exact_cross_provider' || match === 'user_declared' || match === 'user_declared_free') continue;
    const key = JSON.stringify([row.provider, row.model]);
    const prior = models.get(key);
    if (prior) {
      prior.requests += row.requests;
      prior.costUsd += row.costUsd;
    } else {
      models.set(key, { ...row, rateMatchKind: match });
    }
  }
  return [...models.values()].sort((a, b) => b.costUsd - a.costUsd || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
}
