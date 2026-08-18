/** Transport wrapper for the pure four-claim builder. */
import { api } from './api.ts';
import type { Layer } from '../components/spine.ts';
import { buildClaimLayers } from './claimLayers.ts';

export async function loadChain(range: string): Promise<Layer[]> {
  const [overview, billing, allocation, value] = await Promise.allSettled([
    api.overview(range), api.billing(), api.allocation(), api.value(),
  ]);
  const ok = <T,>(r: PromiseSettledResult<T>): T | null => r.status === 'fulfilled' ? r.value : null;
  return buildClaimLayers({ overview: ok(overview), billing: ok(billing), allocation: ok(allocation), value: ok(value) }, range);
}
