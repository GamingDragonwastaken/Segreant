import { egressFetchWithConfig, EgressError } from './transport.ts';
import type { FiscusConfig } from '../config.ts';
import type { ProxyStatus } from '../guide.ts';

export const RECEIPT_REPAIR_ACTION = 'run fiscus egress verify; preserve and repair/restore the present receipt history before retrying; if the lock is stale, confirm no Fiscus writer is active, then remove only that lock; Fiscus will not restart history as genesis';
export const EGRESS_RULE_ACTION = 'run fiscus egress verify and review the exact configured rule before retrying';

function isBoundaryRefusal(error: EgressError): boolean {
  return error.code !== 'transport_failed';
}

/** Probe the local proxy while preserving whether failure was local policy or transport. */
export async function probeProxyState(config: FiscusConfig): Promise<ProxyStatus> {
  try {
    // The proxy binds to IPv4 loopback. Use the literal address so health
    // itself never depends on ambient localhost DNS ordering or aliases.
    const response = await egressFetchWithConfig(config.egress, 'http://127.0.0.1:' + config.port + '/__fiscus/health', {
      purpose: 'local_healthcheck',
      dataClass: 'healthcheck',
      signal: AbortSignal.timeout(800),
    });
    return response.ok
      ? { kind: 'up' }
      : { kind: 'down', message: `proxy health endpoint returned HTTP ${response.status}` };
  } catch (error) {
    if (error instanceof EgressError && isBoundaryRefusal(error)) {
      const receiptRefusal = error.code === 'receipt_integrity_failed' || error.code === 'receipt_persistence_failed';
      return {
        kind: 'blocked_by_egress',
        code: error.code,
        message: error.message,
        action: receiptRefusal ? RECEIPT_REPAIR_ACTION : EGRESS_RULE_ACTION,
      };
    }
    return { kind: 'down', message: error instanceof Error ? error.message : String(error) };
  }
}
