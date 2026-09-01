/**
 * The team server's HTTP surface. Unlike Fiscus's own dashboard
 * (loopback-only — see src/dashboard/server.ts's isLocalHost guard), this
 * server is MEANT to be reached across the network: developer machines push
 * rollups to whatever host/port the operator deploys this on. TLS/network
 * exposure is the operator's job (a reverse proxy, load balancer, etc. — see
 * team-server/README.md); this process speaks plain HTTP and trusts whatever
 * fronts it to terminate TLS, matching "Fiscus provides the software,
 * never the operation" (docs/TEAM-TIER-DESIGN.md §1).
 *
 * Three trust domains, three auth mechanisms:
 *  - POST /developers (admin registers a developer's rollup-signing public
 *    key) is gated by a shared admin bearer token (TEAM_SERVER_ADMIN_TOKEN).
 *  - POST /rollups (a developer machine pushes a signed rollup) is gated by
 *    the rollup's own ed25519 signature, verified against the PINNED public
 *    key from the developers table — never the key embedded in the payload
 *    itself, which would let anyone self-sign a fabricated rollup with a
 *    freshly generated keypair. See src/team/rollup.ts's verifyRollup.
 *  - GET /me, GET /dashboard/projects, and GET /dashboard/developers are all
 *    gated by an OIDC ID token (a human's SSO login), verified against the
 *    operator's own issuer via oidc.ts. This is the human-facing layer —
 *    a separate trust domain from the machine-to-machine rollup signature
 *    above, on purpose (docs/TEAM-TIER-DESIGN.md §3).
 *
 * The two /dashboard/* routes additionally run through aggregate.ts's privacy
 * gate before anything is returned: /dashboard/projects suppresses any single
 * project's numbers if too few distinct developers contributed to it, and
 * /dashboard/developers is opt-in and k-anonymized — a distribution, never a
 * named list. OIDC authentication answers "is this a real team member?";
 * aggregate.ts separately answers "is this specific data safe to hand back
 * even to a real team member?". Passing the first never skips the second.
 */

import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { validateRollupBody, verifyRollup, type SignedRollup } from '../../src/team/rollup.ts';
import { keyIdForPem } from '../../src/value/receipt.ts';
import type { RollupStore, PeriodFilter } from './store.ts';
import { verifyIdToken, type OidcConfig } from './oidc.ts';
import { buildProjectReport, buildDeveloperReport, type TeamAggregateConfig } from './aggregate.ts';

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

class BodyTooLargeError extends Error {
  readonly code = 'resource_limit' as const;
  readonly limitBytes: number;

  constructor(limitBytes: number) {
    super('request body too large');
    this.name = 'BodyTooLargeError';
    this.limitBytes = limitBytes;
  }
}

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('max body bytes must be a positive safe integer');
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const declared = Number(req.headers['content-length'] ?? '');
    if (Number.isSafeInteger(declared) && declared > maxBytes) {
      settled = true;
      req.resume();
      reject(new BodyTooLargeError(maxBytes));
      return;
    }
    req.on('data', (c: Buffer) => {
      if (settled) return;
      total += c.length;
      if (total > maxBytes) {
        settled = true;
        // Drain for connection hygiene, but never retain or parse the excess.
        // The typed rejection lets the route return a stable 413 envelope.
        req.resume();
        reject(new BodyTooLargeError(maxBytes));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, total));
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

/** Ensure every asynchronous route turns storage/auth failures into a response. */
function runAsyncRoute(res: http.ServerResponse, route: () => Promise<void>): void {
  void route().catch(() => {
    // Never leak database/identity details through an unhandled rejection. If
    // headers are already committed, close the stream; otherwise return a
    // generic temporary-unavailable response that callers can retry.
    if (res.headersSent || res.writableEnded) {
      res.destroy();
      return;
    }
    json(res, 503, { ok: false, error: 'team-server route unavailable' });
  });
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Shared OIDC gate for every human-facing route (GET /me and the dashboard
 * routes below). On failure, writes the appropriate response itself and
 * returns null; callers just need to bail out when they get null back — one
 * copy of the "config missing / no token / bad token" decision tree instead
 * of three drifting ones.
 */
async function requireOidcSubject(req: http.IncomingMessage, res: http.ServerResponse, oidc: OidcConfig | null): Promise<string | null> {
  if (oidc === null) {
    json(res, 503, { ok: false, error: 'OIDC is not configured on this server' });
    return null;
  }
  const authz = req.headers['authorization'];
  const token = typeof authz === 'string' && authz.startsWith('Bearer ') ? authz.slice('Bearer '.length) : null;
  if (!token) {
    json(res, 401, { ok: false, error: 'missing bearer token' });
    return null;
  }
  const result = await verifyIdToken(token, oidc);
  if (!result.valid) {
    json(res, 401, { ok: false, error: result.reason });
    return null;
  }
  return result.subject;
}

/**
 * Dashboard aggregates are more sensitive than proving a caller's identity.
 * A valid token alone must not grant them access: an operator must explicitly
 * configure exact OIDC `sub` values. An absent or empty policy is a server
 * configuration problem (503), while an authenticated subject not in that
 * policy is an authorization denial (403). `/me` intentionally uses only
 * requireOidcSubject so it remains an identity-verification diagnostic.
 */
async function requireDashboardSubject(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  oidc: OidcConfig | null,
  dashboardAllowedSubjects: ReadonlySet<string> | null | undefined,
): Promise<string | null> {
  if (!dashboardAllowedSubjects || dashboardAllowedSubjects.size === 0) {
    json(res, 503, {
      ok: false,
      error: 'dashboard access is disabled: OIDC_DASHBOARD_ALLOWED_SUBJECTS must contain at least one allowed OIDC subject',
    });
    return null;
  }
  const subject = await requireOidcSubject(req, res, oidc);
  if (subject === null) return null;
  if (!dashboardAllowedSubjects.has(subject)) {
    json(res, 403, { ok: false, error: 'dashboard access denied for this authenticated OIDC subject' });
    return null;
  }
  return subject;
}

/**
 * Rollups are cumulative snapshots, not time-granular ledger rows. Filtering a
 * snapshot by an overlapping time window would present its *whole* total as
 * though it belonged to that partial window. Refuse that request until the
 * team protocol has a separately designed, time-granular evidence shape.
 */
function parsePeriodFilter(params: URLSearchParams): PeriodFilter | 'unsupported' {
  if (params.has('periodFrom') || params.has('periodTo')) return 'unsupported';
  return {};
}

/** A loose structural check before handing untrusted network input to verifyRollup. */
function isPlausibleSignedRollup(x: unknown): x is SignedRollup {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  if (typeof r['bodyHash'] !== 'string' || typeof r['keyId'] !== 'string') return false;
  if (typeof r['publicKey'] !== 'string' || typeof r['signature'] !== 'string') return false;
  if (typeof r['body'] !== 'object' || r['body'] === null) return false;
  const b = r['body'] as Record<string, unknown>;
  if (b['v'] !== 1 && b['v'] !== 2 || typeof b['keyId'] !== 'string' || typeof b['generatedAt'] !== 'string') return false;
  if (typeof b['period'] !== 'object' || b['period'] === null) return false;
  if (!Array.isArray(b['projects'])) return false;
  return true;
}

const MAX_PROJECTS = 1_000;
const MAX_PROJECT_NAME_CHARS = 200;
const MAX_SOURCES_PER_PROJECT = 32;
const MAX_SOURCE_NAME_CHARS = 128;
const MAX_STRATA = 4_000;
const MAX_TASK_TYPE_CHARS = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, maxChars: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxChars && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function safeNonNegativeInteger(value: unknown): value is number {
  return finiteNonNegative(value) && Number.isSafeInteger(value);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validateSources(value: unknown, label: string): string | null {
  if (!Array.isArray(value) || value.length > MAX_SOURCES_PER_PROJECT) return `${label}.sources must be an array of at most ${MAX_SOURCES_PER_PROJECT} source names`;
  const seen = new Set<string>();
  for (const source of value) {
    if (!boundedText(source, MAX_SOURCE_NAME_CHARS)) return `${label}.sources contains an invalid source name`;
    if (seen.has(source)) return `${label}.sources must not contain duplicate source names`;
    seen.add(source);
  }
  return null;
}

/**
 * Validate the signed content's business shape before it reaches storage.
 * Signature verification proves a registered machine signed these bytes; it
 * does not by itself make NaN-like values, duplicate project rows, or an
 * impossible time interval safe to aggregate later.
 */
function validateRollupSemantics(signed: SignedRollup): string | null {
  const body = signed.body as unknown as Record<string, unknown>;
  if (body['keyId'] !== signed.keyId) return 'body.keyId must equal the envelope keyId';
  if (!validTimestamp(body['generatedAt'])) return 'body.generatedAt must be a valid timestamp';

  const period = body['period'];
  if (!isRecord(period) || !validTimestamp(period['from']) || !validTimestamp(period['to'])) {
    return 'body.period must contain valid from and to timestamps';
  }
  if (Date.parse(period['from']) >= Date.parse(period['to'])) return 'body.period.from must be before body.period.to';

  const projects = body['projects'];
  if (!Array.isArray(projects) || projects.length > MAX_PROJECTS) return `body.projects must be an array of at most ${MAX_PROJECTS} project rows`;
  const projectNames = new Set<string>();
  for (let index = 0; index < projects.length; index += 1) {
    const project = projects[index];
    const label = `body.projects[${index}]`;
    if (!isRecord(project)) return `${label} must be an object`;
    if (!boundedText(project['project'], MAX_PROJECT_NAME_CHARS)) return `${label}.project must be a non-empty project name`;
    if (projectNames.has(project['project'])) return 'body.projects must not contain duplicate project names';
    projectNames.add(project['project']);
    if (!safeNonNegativeInteger(project['units'])) return `${label}.units must be a finite non-negative integer`;
    if (!finiteNonNegative(project['costUsd']) || !finiteNonNegative(project['spendOnRealizedUnitsUsd']) || !finiteNonNegative(project['acceptanceWeightedSpendUsd'])) {
      return `${label} dollar values must be finite and non-negative`;
    }
    if (!finiteNonNegative(project['realizationRate']) || (project['realizationRate'] as number) > 1) return `${label}.realizationRate must be between 0 and 1`;
    if (project['roiIndex'] !== null && (!finiteNonNegative(project['roiIndex']) || (project['roiIndex'] as number) > 100)) return `${label}.roiIndex must be null or between 0 and 100`;
    const sourceError = validateSources(project['sources'], label);
    if (sourceError) return sourceError;
  }

  if (body['v'] === 2) {
    const exactError = validateRollupBody(signed.body);
    if (exactError !== null) return exactError;
  }

  const strata = body['strata'];
  if (strata === undefined) return null;
  if (!Array.isArray(strata) || strata.length > MAX_STRATA) return `body.strata must be an array of at most ${MAX_STRATA} rows`;
  const strataKeys = new Set<string>();
  for (let index = 0; index < strata.length; index += 1) {
    const row = strata[index];
    const label = `body.strata[${index}]`;
    if (!isRecord(row)) return `${label} must be an object`;
    if (!boundedText(row['project'], MAX_PROJECT_NAME_CHARS) || !projectNames.has(row['project'])) return `${label}.project must name a project in body.projects`;
    if (!boundedText(row['taskType'], MAX_TASK_TYPE_CHARS)) return `${label}.taskType must be a non-empty task type`;
    if (!safeNonNegativeInteger(row['units']) || !safeNonNegativeInteger(row['realizedUnits']) || (row['realizedUnits'] as number) > (row['units'] as number)) {
      return `${label} units must be finite non-negative integers with realizedUnits no greater than units`;
    }
    if (!finiteNonNegative(row['costUsd'])) return `${label}.costUsd must be finite and non-negative`;
    const key = `${row['project']}\u0000${row['taskType']}`;
    if (strataKeys.has(key)) return 'body.strata must not contain duplicate project/taskType rows';
    strataKeys.add(key);
  }
  return null;
}

export interface TeamServerDeps {
  store: RollupStore;
  /** Admin bearer token for POST /developers. null disables that route entirely (fail-closed). */
  adminToken: string | null;
  /** OIDC issuer/audience for human-facing routes (GET /me and beyond). null disables them (fail-closed). */
  oidc: OidcConfig | null;
  /**
   * Exact OIDC `sub` values allowed to read /dashboard/* aggregates. Omit,
   * null, or an empty set to disable those routes (503); this is deliberately
   * distinct from OIDC authentication and from generic role/group inference.
   */
  dashboardAllowedSubjects?: ReadonlySet<string> | null;
  /** k-anonymity floor + developer-breakdown opt-in for the /dashboard/* routes. See aggregate.ts. */
  aggregate: TeamAggregateConfig;
  /** Caps request bodies well above any realistic rollup (many projects, still numeric-only). */
  maxBodyBytes?: number;
}

export function createTeamServer(deps: TeamServerDeps): http.Server {
  const { store, adminToken, oidc, dashboardAllowedSubjects, aggregate } = deps;
  const maxBodyBytes = deps.maxBodyBytes ?? 2 * 1024 * 1024;

  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/health') {
      return json(res, 200, { ok: true, service: 'fiscus-team-server' });
    }

    if (url.pathname === '/developers') {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'text/plain', allow: 'POST' });
        res.end('method not allowed');
        return;
      }
      if (adminToken === null) {
        return json(res, 503, { ok: false, error: 'admin registration is disabled: TEAM_SERVER_ADMIN_TOKEN is not set on this server' });
      }
      const authz = req.headers['authorization'];
      const presented = typeof authz === 'string' && authz.startsWith('Bearer ') ? authz.slice('Bearer '.length) : null;
      if (!presented || !constantTimeEqual(presented, adminToken)) {
        return json(res, 401, { ok: false, error: 'missing or invalid admin bearer token' });
      }
      runAsyncRoute(res, async () => {
        try {
          const raw = await readBody(req, 64 * 1024);
          const parsed: unknown = JSON.parse(raw.toString('utf8'));
          if (typeof parsed !== 'object' || parsed === null) return json(res, 400, { ok: false, error: 'malformed body' });
          const p = parsed as Record<string, unknown>;
          const keyId = p['keyId'];
          const publicKey = p['publicKey'];
          if (typeof keyId !== 'string' || typeof publicKey !== 'string') {
            return json(res, 400, { ok: false, error: 'expected { keyId: string, publicKey: string, label?: string }' });
          }
          const label = typeof p['label'] === 'string' ? p['label'] : null;
          // Never trust the claimed keyId — recompute it from the public key itself,
          // the same discipline verifyRollup uses for the embedded key.
          const recomputed = keyIdForPem(publicKey);
          if (recomputed !== keyId) {
            return json(res, 400, { ok: false, error: `keyId does not match the given publicKey (expected ${recomputed})` });
          }
          await store.registerDeveloper(keyId, publicKey, label);
          return json(res, 201, { ok: true, keyId });
        } catch (err) {
          if (err instanceof BodyTooLargeError) return json(res, 413, { ok: false, error: 'request body too large', code: err.code, limitBytes: err.limitBytes });
          return json(res, 400, { ok: false, error: `bad request: ${String(err)}` });
        }
      });
      return;
    }

    if (url.pathname === '/rollups') {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'text/plain', allow: 'POST' });
        res.end('method not allowed');
        return;
      }
      runAsyncRoute(res, async () => {
        let parsed: unknown;
        try {
          const raw = await readBody(req, maxBodyBytes);
          parsed = JSON.parse(raw.toString('utf8'));
        } catch (err) {
          if (err instanceof BodyTooLargeError) return json(res, 413, { ok: false, error: 'request body too large', code: err.code, limitBytes: err.limitBytes });
          return json(res, 400, { ok: false, error: `bad request: ${String(err)}` });
        }
        if (!isPlausibleSignedRollup(parsed)) {
          return json(res, 400, { ok: false, error: 'malformed rollup: expected a SignedRollup envelope' });
        }
        const semanticError = validateRollupSemantics(parsed);
        if (semanticError) {
          return json(res, 400, { ok: false, error: `malformed rollup: ${semanticError}` });
        }
        const developer = await store.findDeveloper(parsed.keyId).catch(() => null);
        if (!developer) {
          return json(res, 403, { ok: false, error: 'unregistered key — ask a team admin to register your `fiscus team push --pubkey` output first' });
        }
        const result = verifyRollup(parsed, { trustedPublicKeyPem: developer.publicKey });
        if (!result.valid) {
          return json(res, 401, { ok: false, error: result.reason });
        }
        try {
          const result = await store.insertRollup(parsed);
          const { rollup: stored } = result;
          return json(res, result.replayed ? 200 : 201, {
            ok: true,
            id: stored.id,
            keyId: stored.keyId,
            projects: stored.body.projects.length,
            ...(result.replayed ? { replayed: true } : {}),
          });
        } catch (err) {
          console.error('team-server: insertRollup failed:', err);
          return json(res, 500, { ok: false, error: 'storage failure' });
        }
      });
      return;
    }

    if (url.pathname === '/me') {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'text/plain', allow: 'GET' });
        res.end('method not allowed');
        return;
      }
      runAsyncRoute(res, async () => {
        const subject = await requireOidcSubject(req, res, oidc);
        if (subject === null) return; // response already sent
        return json(res, 200, { ok: true, subject });
      });
      return;
    }

    if (url.pathname === '/dashboard/projects') {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'text/plain', allow: 'GET' });
        res.end('method not allowed');
        return;
      }
      runAsyncRoute(res, async () => {
        const subject = await requireDashboardSubject(req, res, oidc, dashboardAllowedSubjects);
        if (subject === null) return;
        const filter = parsePeriodFilter(url.searchParams);
        if (filter === 'unsupported') {
          return json(res, 400, { ok: false, error: 'periodFrom/periodTo are unavailable: cumulative rollup snapshots cannot support partial historical windows' });
        }
        const totals = await store.aggregateProjects(filter);
        return json(res, 200, { ok: true, projects: buildProjectReport(totals, aggregate.minCohort) });
      });
      return;
    }

    if (url.pathname === '/dashboard/developers') {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'text/plain', allow: 'GET' });
        res.end('method not allowed');
        return;
      }
      runAsyncRoute(res, async () => {
        const subject = await requireDashboardSubject(req, res, oidc, dashboardAllowedSubjects);
        if (subject === null) return;
        const filter = parsePeriodFilter(url.searchParams);
        if (filter === 'unsupported') {
          return json(res, 400, { ok: false, error: 'periodFrom/periodTo are unavailable: cumulative rollup snapshots cannot support partial historical windows' });
        }
        if (!aggregate.exposeDeveloperBreakdown) {
          // Skip the query entirely — the report would be suppressed anyway; no point paying for it.
          return json(res, 200, { ok: true, report: buildDeveloperReport([], aggregate) });
        }
        const totals = await store.aggregateDevelopers(filter);
        return json(res, 200, { ok: true, report: buildDeveloperReport(totals, aggregate) });
      });
      return;
    }

    json(res, 404, { ok: false, error: 'not found' });
  });
}
