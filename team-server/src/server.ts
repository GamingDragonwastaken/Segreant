/**
 * The team server's HTTP surface. Unlike AegisFlow's own dashboard
 * (loopback-only — see src/dashboard/server.ts's isLocalHost guard), this
 * server is MEANT to be reached across the network: developer machines push
 * rollups to whatever host/port the operator deploys this on. TLS/network
 * exposure is the operator's job (a reverse proxy, load balancer, etc. — see
 * team-server/README.md); this process speaks plain HTTP and trusts whatever
 * fronts it to terminate TLS, matching "AegisFlow provides the software,
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
import { verifyRollup, type SignedRollup } from '../../src/team/rollup.ts';
import { keyIdForPem } from '../../src/value/receipt.ts';
import type { RollupStore, PeriodFilter } from './store.ts';
import { verifyIdToken, type OidcConfig } from './oidc.ts';
import { buildProjectReport, buildDeveloperReport, type TeamAggregateConfig } from './aggregate.ts';

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
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

/** `periodFrom`/`periodTo` query params, validated as parseable timestamps. 'invalid' means the caller should 400. */
function parsePeriodFilter(params: URLSearchParams): PeriodFilter | 'invalid' {
  const periodFrom = params.get('periodFrom');
  const periodTo = params.get('periodTo');
  if (periodFrom !== null && Number.isNaN(Date.parse(periodFrom))) return 'invalid';
  if (periodTo !== null && Number.isNaN(Date.parse(periodTo))) return 'invalid';
  return { ...(periodFrom !== null ? { periodFrom } : {}), ...(periodTo !== null ? { periodTo } : {}) };
}

/** A loose structural check before handing untrusted network input to verifyRollup. */
function isPlausibleSignedRollup(x: unknown): x is SignedRollup {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  if (typeof r['bodyHash'] !== 'string' || typeof r['keyId'] !== 'string') return false;
  if (typeof r['publicKey'] !== 'string' || typeof r['signature'] !== 'string') return false;
  if (typeof r['body'] !== 'object' || r['body'] === null) return false;
  const b = r['body'] as Record<string, unknown>;
  if (b['v'] !== 1 || typeof b['keyId'] !== 'string' || typeof b['generatedAt'] !== 'string') return false;
  if (typeof b['period'] !== 'object' || b['period'] === null) return false;
  if (!Array.isArray(b['projects'])) return false;
  return true;
}

export interface TeamServerDeps {
  store: RollupStore;
  /** Admin bearer token for POST /developers. null disables that route entirely (fail-closed). */
  adminToken: string | null;
  /** OIDC issuer/audience for human-facing routes (GET /me and beyond). null disables them (fail-closed). */
  oidc: OidcConfig | null;
  /** k-anonymity floor + developer-breakdown opt-in for the /dashboard/* routes. See aggregate.ts. */
  aggregate: TeamAggregateConfig;
  /** Caps request bodies well above any realistic rollup (many projects, still numeric-only). */
  maxBodyBytes?: number;
}

export function createTeamServer(deps: TeamServerDeps): http.Server {
  const { store, adminToken, oidc, aggregate } = deps;
  const maxBodyBytes = deps.maxBodyBytes ?? 2 * 1024 * 1024;

  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/health') {
      return json(res, 200, { ok: true, service: 'aegisflow-team-server' });
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
      void (async () => {
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
          return json(res, 400, { ok: false, error: `bad request: ${String(err)}` });
        }
      })();
      return;
    }

    if (url.pathname === '/rollups') {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'text/plain', allow: 'POST' });
        res.end('method not allowed');
        return;
      }
      void (async () => {
        let parsed: unknown;
        try {
          const raw = await readBody(req, maxBodyBytes);
          parsed = JSON.parse(raw.toString('utf8'));
        } catch (err) {
          return json(res, 400, { ok: false, error: `bad request: ${String(err)}` });
        }
        if (!isPlausibleSignedRollup(parsed)) {
          return json(res, 400, { ok: false, error: 'malformed rollup: expected a SignedRollup envelope' });
        }
        const developer = await store.findDeveloper(parsed.keyId).catch(() => null);
        if (!developer) {
          return json(res, 403, { ok: false, error: 'unregistered key — ask a team admin to register your `aegisflow team push --pubkey` output first' });
        }
        const result = verifyRollup(parsed, { trustedPublicKeyPem: developer.publicKey });
        if (!result.valid) {
          return json(res, 401, { ok: false, error: result.reason });
        }
        try {
          const stored = await store.insertRollup(parsed);
          return json(res, 201, { ok: true, id: stored.id, keyId: stored.keyId, projects: stored.body.projects.length });
        } catch (err) {
          console.error('team-server: insertRollup failed:', err);
          return json(res, 500, { ok: false, error: 'storage failure' });
        }
      })();
      return;
    }

    if (url.pathname === '/me') {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'text/plain', allow: 'GET' });
        res.end('method not allowed');
        return;
      }
      void (async () => {
        const subject = await requireOidcSubject(req, res, oidc);
        if (subject === null) return; // response already sent
        return json(res, 200, { ok: true, subject });
      })();
      return;
    }

    if (url.pathname === '/dashboard/projects') {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'text/plain', allow: 'GET' });
        res.end('method not allowed');
        return;
      }
      void (async () => {
        const subject = await requireOidcSubject(req, res, oidc);
        if (subject === null) return;
        const filter = parsePeriodFilter(url.searchParams);
        if (filter === 'invalid') {
          return json(res, 400, { ok: false, error: 'periodFrom/periodTo must be valid ISO 8601 timestamps' });
        }
        const totals = await store.aggregateProjects(filter);
        return json(res, 200, { ok: true, projects: buildProjectReport(totals, aggregate.minCohort) });
      })();
      return;
    }

    if (url.pathname === '/dashboard/developers') {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'text/plain', allow: 'GET' });
        res.end('method not allowed');
        return;
      }
      void (async () => {
        const subject = await requireOidcSubject(req, res, oidc);
        if (subject === null) return;
        if (!aggregate.exposeDeveloperBreakdown) {
          // Skip the query entirely — the report would be suppressed anyway; no point paying for it.
          return json(res, 200, { ok: true, report: buildDeveloperReport([], aggregate) });
        }
        const filter = parsePeriodFilter(url.searchParams);
        if (filter === 'invalid') {
          return json(res, 400, { ok: false, error: 'periodFrom/periodTo must be valid ISO 8601 timestamps' });
        }
        const totals = await store.aggregateDevelopers(filter);
        return json(res, 200, { ok: true, report: buildDeveloperReport(totals, aggregate) });
      })();
      return;
    }

    json(res, 404, { ok: false, error: 'not found' });
  });
}
