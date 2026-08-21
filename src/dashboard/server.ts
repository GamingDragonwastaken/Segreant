/**
 * Local web dashboard.
 *
 * A small read-only HTTP server over the same Store the proxy writes to. It
 * exposes a JSON API and serves a single self-contained HTML page. Bound to
 * localhost only — like everything else, nothing leaves the machine.
 *
 * This file is the ENTRY and the GUARD, and nothing else. It answers three
 * questions in order — is the caller local, which route is this, may this
 * method reach it — and then hands off. The endpoints themselves live in
 * `routes.ts` (one named handler each, plus the table that declares their
 * methods and CSRF gates) and file serving lives in `static.ts`. Splitting
 * matching from handling is what lets a handler be called directly in a test
 * without standing up a socket, and what keeps the security posture of the API
 * readable as a table rather than as a chain of ifs.
 */

import http from 'node:http';
import type { Store } from '../store/db.ts';
import { loadConfig, saveConfig, type FiscusConfig } from '../config.ts';
import { ROUTES, type ConfigPersistence, type Route } from './routes.ts';
import { serveStatic } from './static.ts';

/** Exact-path lookup. Every route path is a distinct literal, so a Map is the match. */
const ROUTE_TABLE: ReadonlyMap<string, Route> = new Map(ROUTES.map((r) => [r.path, r]));

/**
 * Loopback-only Host allowlist. The server is bound to 127.0.0.1, but a remote
 * page could still reach it via DNS-rebinding (rebind a hostname to 127.0.0.1,
 * then read responses as same-origin). Rejecting any non-loopback Host closes
 * that — a rebound request carries the attacker's hostname, not localhost.
 */
function isLocalHost(host: string | undefined): boolean {
  if (!host) return true; // no Host header → only reachable on the loopback we bind to
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return name === 'localhost' || name === '127.0.0.1' || name === '::1';
}

export interface DashboardDeps {
  store: Store;
  config: FiscusConfig;
  /** This package's version — surfaced read-only in the Settings view. */
  version: string;
  /**
   * Config persistence is injectable so the dashboard can be exercised without
   * touching a developer's real local configuration. Production uses the
   * normal on-disk Fiscus config functions by default.
   */
  configPersistence?: ConfigPersistence;
}

export function createDashboardServer(deps: DashboardDeps): http.Server {
  const { store, config, version, configPersistence = { load: loadConfig, save: saveConfig } } = deps;

  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    // Loopback Host guard — defeats DNS-rebinding that could otherwise let a
    // remote page read your local spend/value data despite the 127.0.0.1 bind.
    if (!isLocalHost(req.headers.host)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('forbidden');
      return;
    }

    const route = ROUTE_TABLE.get(url.pathname);
    if (route) {
      // A method the route does not serve never reaches the handler. Every
      // route declares its list — there is no longer an "answers anything"
      // case to fall through, so an unlisted method is always a 405.
      const method = req.method ?? '';
      if (!route.methods.includes(method)) {
        res.writeHead(405, { 'content-type': 'text/plain', allow: route.allow ?? route.methods.join(', ') });
        res.end('method not allowed');
        return;
      }
      // The CSRF gate on every mutating route, enforced in ONE place. A custom
      // header cannot be set cross-origin without a preflight this server never
      // answers, so a malicious page cannot drive the operator's local Fiscus.
      if (route.localOnly?.includes(method) && req.headers['x-aegis-local'] !== '1') {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('forbidden');
        return;
      }
      route.handler({ req, res, url, store, config, version, configPersistence });
      return;
    }

    // The GUI's own modules and stylesheet. Everything else 404s.
    if (req.method === 'GET' && serveStatic(res, url.pathname)) return;

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
}
