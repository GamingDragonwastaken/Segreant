/**
 * The only Fiscus-process HTTP(S) dialler. It pins the selected DNS address,
 * never follows redirects, and writes redacted receipts before each dial. A
 * present receipt history that cannot be validated/extended refuses before DNS
 * resolution or socket creation; only an absent history may establish genesis.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { loadConfig, type EgressConfig, type EgressDataClass, type EgressPurpose } from '../config.ts';
import { appendEgressReceipt, EgressReceiptError } from './receipts.ts';
import { evaluateEgressPolicy, type EgressTargetClass } from './policy.ts';

export type EgressErrorCode = 'policy_denied' | 'dns_denied' | 'receipt_integrity_failed' | 'receipt_persistence_failed' | 'transport_failed';

export class EgressError extends Error {
  readonly code: EgressErrorCode;

  constructor(code: EgressErrorCode, message: string) {
    super(message);
    this.name = 'EgressError';
    this.code = code;
  }
}

export type EgressHeaders = Record<string, string> | Array<[string, string]> | Headers;

export interface EgressFetchInit {
  purpose: EgressPurpose;
  dataClass: EgressDataClass;
  method?: string;
  headers?: EgressHeaders;
  body?: string | Uint8Array | ArrayBuffer | null;
  signal?: AbortSignal;
}

interface ResolvedTarget {
  address: string;
  family: 4 | 6;
  targetClass: EgressTargetClass;
}

function bodyByteLength(body: EgressFetchInit['body']): number {
  if (body === null || body === undefined) return 0;
  if (typeof body === 'string') return Buffer.byteLength(body);
  return body.byteLength;
}

function normalAddress(address: string): string {
  const value = address.replace(/(^\[|\]$)/g, '').toLowerCase();
  return value.startsWith('::ffff:') ? value.slice('::ffff:'.length) : value;
}

function isLoopback(address: string): boolean {
  const value = normalAddress(address);
  return value === '127.0.0.1' || value === '::1';
}

function isPublic(address: string): boolean {
  const value = normalAddress(address);
  if (isIP(value) === 4) {
    const parts = value.split('.').map(Number);
    const a = parts[0] ?? -1;
    const b = parts[1] ?? -1;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 0 || b === 168)) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  if (isIP(value) === 6) {
    if (value === '::' || value === '::1') return false;
    if (/^(fc|fd|fe[89ab])/.test(value) || value.startsWith('2001:db8:')) return false;
    return true;
  }
  return false;
}

async function resolveTarget(target: URL, targetClass: EgressTargetClass): Promise<ResolvedTarget> {
  const literal = normalAddress(target.hostname);
  const addresses = isIP(literal)
    ? [{ address: literal, family: isIP(literal) as 4 | 6 }]
    : await dnsLookup(target.hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw new EgressError('dns_denied', 'egress DNS resolution produced no address');
  if (targetClass === 'loopback' && !addresses.every((entry) => isLoopback(entry.address))) {
    throw new EgressError('dns_denied', 'loopback target resolved outside loopback; Fiscus refused the request');
  }
  if (targetClass === 'controlled_cloud' && !addresses.every((entry) => isPublic(entry.address))) {
    throw new EgressError('dns_denied', 'controlled-cloud target resolved to a non-public address; Fiscus refused the request');
  }
  const first = addresses[0]!;
  return { address: normalAddress(first.address), family: first.family as 4 | 6, targetClass };
}

function receipt(input: Parameters<typeof appendEgressReceipt>[0]): void {
  try {
    appendEgressReceipt(input);
  } catch (error) {
    if (error instanceof EgressReceiptError && error.code === 'integrity') {
      throw new EgressError('receipt_integrity_failed', error.message);
    }
    throw new EgressError('receipt_persistence_failed', 'egress receipt persistence failed; Fiscus refused the outbound request');
  }
}

function outboundHeaders(input: EgressHeaders | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(input).forEach((value, key) => {
    if (key !== 'host') out[key] = value;
  });
  return out;
}

function inboundHeaders(input: http.IncomingHttpHeaders): Headers {
  const out = new Headers();
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) value.forEach((part) => out.append(key, part));
    else out.set(key, value);
  }
  return out;
}

export async function egressFetchWithConfig(config: EgressConfig, url: string | URL, init: EgressFetchInit): Promise<Response> {
  const method = (init.method ?? 'GET').trim().toUpperCase();
  const decision = evaluateEgressPolicy(config, { url, purpose: init.purpose, dataClass: init.dataClass, method });
  const bytes = bodyByteLength(init.body);
  if (!decision.allowed || !decision.target || !decision.targetClass) {
    receipt({ event: 'preflight_denied', purpose: init.purpose, dataClass: init.dataClass, method, targetClass: 'denied', target: decision.target, bodyBytes: bytes });
    throw new EgressError('policy_denied', 'egress policy denied this request: ' + decision.reason);
  }
  const common = { purpose: init.purpose, dataClass: init.dataClass, method, targetClass: decision.targetClass, ruleId: decision.ruleId, target: decision.target, bodyBytes: bytes } as const;
  receipt({ ...common, event: 'preflight_allowed' });
  let resolved: ResolvedTarget;
  try {
    resolved = await resolveTarget(decision.target, decision.targetClass);
  } catch (error) {
    receipt({ ...common, event: 'transport_failed' });
    if (error instanceof EgressError) throw error;
    throw new EgressError('dns_denied', 'Fiscus could not resolve an allowed egress target');
  }
  receipt({ ...common, event: 'dial_started' });

  return new Promise<Response>((resolve, reject) => {
    const client = decision.target!.protocol === 'https:' ? https : http;
    let settled = false;
    const fail = (error: EgressError): void => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    const req = client.request({
      protocol: decision.target!.protocol,
      hostname: decision.target!.hostname.replace(/(^\[|\]$)/g, ''),
      port: decision.target!.port || undefined,
      path: decision.target!.pathname + decision.target!.search,
      method,
      headers: outboundHeaders(init.headers),
      servername: decision.target!.hostname.replace(/(^\[|\]$)/g, ''),
      lookup: (_host, _options, callback) => callback(null, resolved.address, resolved.family),
    } as https.RequestOptions, (incoming) => {
      try {
        receipt({ ...common, event: 'response_received', status: incoming.statusCode ?? 0 });
      } catch (error) {
        incoming.resume();
        req.destroy();
        fail(error instanceof EgressError ? error : new EgressError('receipt_persistence_failed', 'egress receipt persistence failed'));
        return;
      }
      if (settled) return;
      settled = true;
      const body = method === 'HEAD' || incoming.statusCode === 204 || incoming.statusCode === 304
        ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
      resolve(new Response(body, { status: incoming.statusCode ?? 502, statusText: incoming.statusMessage ?? '', headers: inboundHeaders(incoming.headers) }));
    });
    req.once('error', () => {
      try {
        receipt({ ...common, event: 'transport_failed' });
      } catch (error) {
        fail(error instanceof EgressError ? error : new EgressError('receipt_persistence_failed', 'egress receipt persistence failed'));
        return;
      }
      fail(new EgressError('transport_failed', 'Fiscus could not complete the permitted outbound request'));
    });
    const abort = (): void => {
      req.destroy(new Error('aborted'));
    };
    if (init.signal?.aborted) abort();
    else {
      init.signal?.addEventListener('abort', abort, { once: true });
      req.once('close', () => init.signal?.removeEventListener('abort', abort));
    }
    if (init.body === null || init.body === undefined) req.end();
    else if (init.body instanceof ArrayBuffer) req.end(Buffer.from(init.body));
    else req.end(init.body);
  });
}

export function egressFetch(url: string | URL, init: EgressFetchInit): Promise<Response> {
  return egressFetchWithConfig(loadConfig().egress, url, init);
}
