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

export interface ResolvedTarget {
  address: string;
  family: 4 | 6;
  targetClass: EgressTargetClass;
}

type EgressDnsLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<ReadonlyArray<{ address: string; family: 4 | 6 }>>;

export type EgressDialHook = (input: {
  target: URL;
  resolved: ResolvedTarget;
  method: string;
  bodyBytes: number;
}) => Promise<Response>;

let egressDnsLookupForTests: EgressDnsLookup | undefined;
let egressDialHookForTests: EgressDialHook | undefined;

/** @internal deterministic DNS seam used only by boundary tests. */
export function setEgressDnsLookupForTests(hook: EgressDnsLookup | undefined): () => void {
  const previous = egressDnsLookupForTests;
  egressDnsLookupForTests = hook;
  return () => {
    egressDnsLookupForTests = previous;
  };
}

/** @internal deterministic dial seam used only by boundary tests. */
export function setEgressDialHookForTests(hook: EgressDialHook | undefined): () => void {
  const previous = egressDialHookForTests;
  egressDialHookForTests = hook;
  return () => {
    egressDialHookForTests = previous;
  };
}

function bodyByteLength(body: EgressFetchInit['body']): number {
  if (body === null || body === undefined) return 0;
  if (typeof body === 'string') return Buffer.byteLength(body);
  return body.byteLength;
}

function normalAddress(address: string): string {
  return address.replace(/(^\[|\]$)/g, '').toLowerCase();
}

function parseIpv6(address: string): bigint | null {
  let value = normalAddress(address);
  if (value.includes('%')) return null;
  if (value.includes('.')) {
    const separator = value.lastIndexOf(':');
    if (separator < 0) return null;
    const ipv4 = value.slice(separator + 1);
    if (isIP(ipv4) !== 4) return null;
    const octets = ipv4.split('.').map(Number);
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    const high = ((octets[0]! << 8) | octets[1]!).toString(16);
    const low = ((octets[2]! << 8) | octets[3]!).toString(16);
    value = value.slice(0, separator + 1) + high + ':' + low;
  }
  const compression = value.indexOf('::');
  if (compression >= 0 && value.indexOf('::', compression + 2) >= 0) return null;
  const leftText = compression >= 0 ? value.slice(0, compression) : value;
  const rightText = compression >= 0 ? value.slice(compression + 2) : '';
  const left = leftText ? leftText.split(':') : [];
  const right = rightText ? rightText.split(':') : [];
  if (compression < 0 && left.length !== 8) return null;
  if (compression >= 0 && left.length + right.length >= 8) return null;
  const groups = compression >= 0
    ? [...left, ...Array.from({ length: 8 - left.length - right.length }, () => '0'), ...right]
    : left;
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  let numeric = 0n;
  for (const group of groups) numeric = (numeric << 16n) | BigInt(parseInt(group, 16));
  return numeric;
}

function inIpv6Cidr(value: bigint, network: bigint, prefixLength: number): boolean {
  const shift = 128n - BigInt(prefixLength);
  return (value >> shift) === (network >> shift);
}

function isGlobalUnicastIpv6(value: bigint): boolean {
  // Global-unicast space is 2000::/3. The IANA special-purpose registry
  // marks the 2001::/23 parent as not globally reachable, with these explicit
  // more-specific globally-reachable entries. Encoding the exceptions keeps
  // this numeric boundary from blanket-denying entries that IANA marks public.
  if (!inIpv6Cidr(value, 0x20000000000000000000000000000000n, 3)) return false;
  if (inIpv6Cidr(value, 0x00000000000000000000000000000000n, 128)) return false;
  if (inIpv6Cidr(value, 0x00000000000000000000000000000001n, 128)) return false;
  if (inIpv6Cidr(value, 0x20010001000000000000000000000001n, 128)) return true;
  if (inIpv6Cidr(value, 0x20010001000000000000000000000002n, 128)) return true;
  if (inIpv6Cidr(value, 0x20010001000000000000000000000003n, 128)) return true;
  if (inIpv6Cidr(value, 0x20010003000000000000000000000000n, 32)) return true;
  if (inIpv6Cidr(value, 0x20010004011200000000000000000000n, 48)) return true;
  if (inIpv6Cidr(value, 0x20010020000000000000000000000000n, 28)) return true;
  if (inIpv6Cidr(value, 0x20010030000000000000000000000000n, 28)) return true;
  if (inIpv6Cidr(value, 0x20010000000000000000000000000000n, 23)) return false;
  if (inIpv6Cidr(value, 0xfc00000000000000000000000000000000n, 7)) return false;
  if (inIpv6Cidr(value, 0xfe80000000000000000000000000000000n, 10)) return false;
  if (inIpv6Cidr(value, 0xfec0000000000000000000000000000000n, 10)) return false;
  if (inIpv6Cidr(value, 0x20010db8000000000000000000000000n, 32)) return false;
  if (inIpv6Cidr(value, 0x20010002000000000000000000000000n, 48)) return false;
  if (inIpv6Cidr(value, 0x20010010000000000000000000000000n, 28)) return false;
  if (inIpv6Cidr(value, 0x20020000000000000000000000000000n, 16)) return false;
  if (inIpv6Cidr(value, 0x3ffe0000000000000000000000000000n, 16)) return false;
  if (inIpv6Cidr(value, 0x3fff0000000000000000000000000000n, 20)) return false;
  if (inIpv6Cidr(value, 0x005f0000000000000000000000000000n, 16)) return false;
  if (inIpv6Cidr(value, 0x0064ff9b000000000000000000000000n, 96)) return false;
  return true;
}

function mappedIpv4(value: bigint): string | null {
  if ((value >> 32n) !== 0xffffn) return null;
  const octets = [24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 0xffn));
  return octets.join('.');
}

function isLoopback(address: string): boolean {
  const value = normalAddress(address);
  if (isIP(value) === 4) return value === '127.0.0.1';
  const numeric = parseIpv6(value);
  if (numeric === null) return false;
  return numeric === 1n || mappedIpv4(numeric) === '127.0.0.1';
}

function isPublic(address: string): boolean {
  const value = normalAddress(address);
  if (isIP(value) === 4) {
    const parts = value.split('.').map(Number);
    const a = parts[0] ?? -1;
    const b = parts[1] ?? -1;
    const c = parts[2] ?? -1;
    const d = parts[3] ?? -1;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    // IANA marks the AS112/AMT ranges 192.31.196.0/24, 192.52.193.0/24,
    // and 192.175.48.0/24 Globally Reachable. Do not classify them as private
    // or special-use solely because they are commonly used by infrastructure.
    // IANA IPv4 special-purpose snapshot: 192.0.0.0/24 is not globally
    // reachable except the explicitly globally reachable .9 and .10 anycast
    // entries; 192.0.1.0/24 remains ordinary globally reachable space.
    if (a === 192 && b === 0 && c === 0 && d !== 9 && d !== 10) return false;
    if (a === 192 && b === 0 && c === 2) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 88 && c === 99) return false;
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (isIP(value) === 6) {
    const numeric = parseIpv6(value);
    return numeric !== null && mappedIpv4(numeric) === null && isGlobalUnicastIpv6(numeric);
  }
  return false;
}

async function resolveTarget(target: URL, targetClass: EgressTargetClass): Promise<ResolvedTarget> {
  const literal = normalAddress(target.hostname);
  const addresses = isIP(literal)
    ? [{ address: literal, family: isIP(literal) as 4 | 6 }]
    : await (egressDnsLookupForTests ?? ((hostname, options) => dnsLookup(hostname, options)))(target.hostname, { all: true, verbatim: true });
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

  if (egressDialHookForTests) {
    try {
      const response = await egressDialHookForTests({ target: decision.target, resolved, method, bodyBytes: bytes });
      receipt({ ...common, event: 'response_received', status: response.status });
      return response;
    } catch (error) {
      try {
        receipt({ ...common, event: 'transport_failed' });
      } catch (receiptError) {
        throw receiptError instanceof EgressError
          ? receiptError
          : new EgressError('receipt_persistence_failed', 'egress receipt persistence failed');
      }
      if (error instanceof EgressError) throw error;
      throw new EgressError('transport_failed', 'Fiscus could not complete the permitted outbound request');
    }
  }

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

/**
 * Release a response body for callers that only need status/headers. A
 * Fiscus-owned transport returns a live stream; leaving it unread can retain a
 * socket and make repeated health/watch operations accumulate resources.
 */
export async function discardResponseBody(response: Response): Promise<void> {
  if (!response.body) return;
  try {
    await response.body.cancel();
  } catch {
    // The caller already has its status/result; cancellation is best effort.
  }
}
