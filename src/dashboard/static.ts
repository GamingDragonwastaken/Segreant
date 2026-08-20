/**
 * Static file serving for the dashboard — the GUI shell and its assets.
 *
 * Separated from the API because it answers to a different threat model. Every
 * other route in this server reads the local ledger; this one reads the
 * operator's DISK, so its correctness is a path-traversal question rather than a
 * provenance question. Keeping it in its own module means the two gates below
 * can be read, reviewed and tested without the API's orchestration around them.
 */

import type http from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const WEB_ROOT = join(__dirname, 'web');
const INDEX_HTML = join(WEB_ROOT, 'index.html');
const CLASSIC_HTML = join(WEB_ROOT, 'classic.html');

/**
 * Local-first CSP. The page must never be able to reach the network, so every
 * fetchable directive is pinned to 'self' and there is no CDN, font host or
 * analytics origin to allow. The two variants differ in one place only: the
 * HTML shells still carry an inline bootstrap script, the served modules and
 * stylesheets do not, so assets get the strictly tighter script-src.
 */
const CSP_ASSET = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const CSP_HTML = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * Static assets the GUI is allowed to fetch, by extension.
 *
 * The GUI is many small files now rather than one, so the server has to serve a
 * directory -- and a directory served naively is a path-traversal bug that reads
 * the operator's disk. Two independent gates: the resolved path must stay inside
 * WEB_ROOT, and the extension must appear here. Nothing else is reachable, which
 * is why an unmatched request 404s rather than falling through to the shell.
 */
export const STATIC_TYPES: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export function serveStatic(res: http.ServerResponse, pathname: string): boolean {
  const relative = decodeURIComponent(pathname).replace(/^\/+/, '');
  // Reject before touching the filesystem: a traversal attempt is not a miss.
  if (relative.includes('..') || relative.includes('\u0000')) return false;

  const ext = relative.slice(relative.lastIndexOf('.'));
  const type = STATIC_TYPES[ext];
  if (!type) return false;

  const resolved = resolve(WEB_ROOT, relative);
  if (resolved !== WEB_ROOT && !resolved.startsWith(WEB_ROOT + sep)) return false;
  if (!existsSync(resolved) || !statSync(resolved).isFile()) return false;

  res.writeHead(200, {
    'content-type': type,
    // Local-first: the page must never be able to reach the network, and a
    // stale cached module must never outlive a rebuild of the same install.
    'cache-control': 'no-cache',
    'content-security-policy': CSP_ASSET,
    'x-content-type-options': 'nosniff',
  });
  res.end(readFileSync(resolved));
  return true;
}

/**
 * The two HTML entry points: '/' (and '/index.html') serve the GUI, '/classic'
 * serves the previous single-file console. Both are read off disk on every
 * request — no cache — so a rebuild is visible on reload.
 */
export function serveHtml(res: http.ServerResponse, pathname: string): void {
  const file = pathname === '/classic' ? CLASSIC_HTML : INDEX_HTML;
  try {
    const html = readFileSync(file, 'utf8');
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache',
      'content-security-policy': CSP_HTML,
      'x-content-type-options': 'nosniff',
    });
    res.end(html);
  } catch {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('dashboard UI not found');
  }
}
