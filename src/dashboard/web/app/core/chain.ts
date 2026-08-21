/**
 * Loads the four payloads the evidence chain is derived from.
 *
 * This module is the I/O half only. What each claim MEANS — whether it is
 * established, what it rests on, what evidence it is missing — is derived in
 * `claimLayers.ts`, which is a pure function of the four payloads and is tested
 * directly against fixtures. Splitting them means the product's claims are no
 * longer reachable only through four live endpoints, a socket and a ledger.
 *
 * What stays here is the failure behaviour: the reads are INDEPENDENT, so one
 * slow endpoint does not delay the whole spine and a failing one degrades its
 * own layer rather than the page. A rejected read becomes `null`, and `null`
 * is exactly the input the derivation already treats as "this claim could not
 * be substantiated" — so a dead endpoint reads as missing evidence, never as a
 * zero.
 */

import { api } from './api.ts';
import { buildClaimLayers } from './claimLayers.ts';
import type { Layer } from './claimTypes.ts';

export async function loadChain(range: string): Promise<Layer[]> {
  const [overview, billing, allocation, value] = await Promise.allSettled([
    api.overview(range),
    api.billing(),
    api.allocation(),
    api.value(),
  ]);

  const ok = <T,>(r: PromiseSettledResult<T>): T | null => (r.status === 'fulfilled' ? r.value : null);

  return buildClaimLayers({
    overview: ok(overview),
    billing: ok(billing),
    allocation: ok(allocation),
    value: ok(value),
  }, range);
}
