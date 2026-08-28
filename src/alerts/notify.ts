/**
 * Alert delivery — the "notify" half of governance.
 *
 * Detecting a budget breach is only useful if someone hears about it when they
 * aren't staring at the dashboard. This POSTs alert metadata to a user-configured
 * webhook (their own Slack/Teams/PagerDuty endpoint).
 *
 * Privacy boundary, enforced by construction: the payload is built ONLY from the
 * Alert fields (id, severity, title, detail, metric). There is no code path here
 * that can read a prompt, a response body, source code, or an API key — so the
 * "no prompt or code leaves your device" promise holds even with delivery on.
 */

import type { Alert, AlertSeverity } from './detect.ts';
import { discardResponseBody, egressFetch, EgressError, type EgressErrorCode } from '../egress/transport.ts';

const SEV_RANK: Record<AlertSeverity, number> = { info: 0, warn: 1, critical: 2 };

/** One delivered alert — exactly the fields that leave the device, nothing more. */
export interface AlertWire {
  id: string;
  severity: AlertSeverity;
  title: string;
  detail: string;
  metric: string | null;
}

export interface WebhookPayload {
  source: 'fiscus';
  generatedAt: string;
  alerts: AlertWire[];
}

/** Build the exact payload that would be sent. Pure — used in tests to prove the boundary. */
export function buildWebhookPayload(
  alerts: Alert[],
  minSeverity: AlertSeverity = 'warn',
  now: number = Date.now(),
): WebhookPayload {
  const min = SEV_RANK[minSeverity];
  return {
    source: 'fiscus',
    generatedAt: new Date(now).toISOString(),
    alerts: alerts
      .filter((a) => SEV_RANK[a.severity] >= min)
      .map((a) => ({ id: a.id, severity: a.severity, title: a.title, detail: a.detail, metric: a.metric })),
  };
}

export interface NotifyResult {
  delivered: boolean;
  posted: number; // how many alerts met the severity threshold
  status?: number;
  error?: string;
  /** Stable boundary category; never collapse receipt refusal into network failure. */
  failureCode?: EgressErrorCode | 'network_error';
  /** Safe operator action for a local receipt refusal. */
  action?: string;
}

function egressRepairAction(code: EgressErrorCode): string | undefined {
  if (code === 'receipt_integrity_failed' || code === 'receipt_persistence_failed') {
    return 'restore or repair the local egress receipt history, then retry; if a lock is stale, confirm no Fiscus writer owns it and remove only that lock';
  }
  return undefined;
}

/**
 * POST the alert metadata to `url`. Fire-and-forget with a timeout; a failed
 * delivery never throws (governance must not depend on a reachable webhook).
 */
export async function notifyWebhook(
  url: string,
  alerts: Alert[],
  opts: { minSeverity?: AlertSeverity; timeoutMs?: number; now?: number } = {},
): Promise<NotifyResult> {
  const payload = buildWebhookPayload(alerts, opts.minSeverity ?? 'warn', opts.now);
  if (payload.alerts.length === 0) return { delivered: false, posted: 0 };
  try {
    const res = await egressFetch(url, {
      purpose: 'alert_delivery',
      dataClass: 'alert_metadata',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 4000),
    });
    const delivered = res.ok;
    const status = res.status;
    await discardResponseBody(res);
    return { delivered, posted: payload.alerts.length, status };
  } catch (e) {
    if (e instanceof EgressError) {
      return {
        delivered: false,
        posted: payload.alerts.length,
        error: e.message,
        failureCode: e.code,
        action: egressRepairAction(e.code),
      };
    }
    return { delivered: false, posted: payload.alerts.length, error: String(e), failureCode: 'network_error' };
  }
}
