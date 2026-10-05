/**
 * The public site (web/) is a claim surface and a supply-chain surface. These
 * tests pin the fixes from the 2026-09-30 rebuild so they cannot quietly regress:
 *
 * - every file the pages load is bundled in web/ (no CDN, font host or analytics);
 * - every sample figure is labelled as sample data;
 * - the limits that change a decision sit beside the claim they limit
 *   (cap scope, streaming cost headers, receipt signatures, team privacy);
 * - external factual claims carry their sources;
 * - features the product does not offer are listed as not offered, never sold.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const WEB = join(import.meta.dirname, '..', 'web');
const read = (...parts: string[]) => readFileSync(join(WEB, ...parts), 'utf8');
const PAGES = ['index.html', 'method.html'] as const;

test('pages load only files bundled in web/', () => {
  for (const page of PAGES) {
    const html = read(page);
    for (const m of html.matchAll(/<(?:script|link|img|source|iframe)\b[^>]*\b(?:src|href)="([^"]+)"/gi)) {
      const url = m[1]!;
      assert.doesNotMatch(url, /^(?:https?:)?\/\//i, `${page} loads a remote resource: ${url}`);
      assert.ok(existsSync(join(WEB, url.split('#')[0]!)), `${page} references a missing file: ${url}`);
    }
    const tracker = /https?:\/\/[^"'\s]*(?:fonts\.googleapis|fonts\.gstatic|googletagmanager|google-analytics|plausible\.io|segment\.(?:io|com))/i;
    assert.ok(!tracker.test(html), `${page} must not reference a font host or analytics service`);
  }
});

test('every url() in the stylesheet resolves to a bundled file', () => {
  const css = read('assets', 'site.css');
  const urls = [...css.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1]!);
  assert.ok(urls.length > 0);
  for (const url of urls) {
    assert.doesNotMatch(url, /^(?:https?:|data:)/i, `stylesheet must not load ${url}`);
    assert.ok(existsSync(join(WEB, 'assets', url)), `site.css references a missing file: ${url}`);
  }
  assert.ok(existsSync(join(WEB, 'assets', 'fonts', 'OFL.txt')), 'bundled OFL fonts must ship with their licence');
});

test('sample figures are labelled wherever they appear', () => {
  const index = read('index.html');
  // hero note, statement, receipt: each carries its own label
  const cert = index.slice(index.indexOf('class="note-cert'), index.indexOf('</figure>', index.indexOf('class="note-cert')));
  assert.match(cert, /class="sample">Sample</, 'the hero note shows a sample figure and must say so');
  const statement = index.slice(index.indexOf('class="statement'), index.indexOf('</article>'));
  assert.match(statement, /Sample data/, 'the sample statement must be labelled');
  const slip = index.slice(index.indexOf('class="slip'), index.indexOf('</section>', index.indexOf('class="slip')));
  assert.match(slip, /class="sample">Sample</, 'the sample receipt must be labelled');
  assert.match(read('method.html'), /class="sample">Illustrative</, 'the illustrative funnel must be labelled');
});

test('decision-changing limits sit beside the claims they limit', () => {
  const index = read('index.html');
  assert.match(index, /Caps cover requests sent through Segreant\./, 'cap scope belongs in the first line of the caps section');
  assert.match(index, /imported[^.]*can't be stopped/i, 'imported usage is outside the cap');
  assert.match(index, /Caps are off until you set one/);
  assert.match(index, /non-streaming response carries its cost[^.]*X-Segreant-Cost-USD/i, 'cost headers are scoped to non-streaming responses');
  assert.doesNotMatch(index, /cost headers? (?:come|comes) back on every response/i);
  assert.match(index, /signature proves where the record came from, not that the checks inside were right/i);
  assert.match(index, /hide any group smaller than five people/i, 'the team privacy floor is stated');
  assert.match(index, /No telemetry by default\. Requests you route through Segreant still go to your AI provider\./);
});

test('names match the product: kept work is a cost, not "realized value"', () => {
  for (const page of PAGES) {
    const html = read(page);
    assert.doesNotMatch(html, /Realized Value/, `${page}: the product calls this spend that went into kept work`);
    assert.doesNotMatch(html, /claude-opus-4-8|gpt-4o\b/, `${page}: sample models must be current`);
  }
});

test('external factual claims carry their sources', () => {
  const index = read('index.html');
  if (/KiroRank/.test(index)) assert.match(index, /href="https:\/\/www\.cio\.com\//, 'KiroRank claim needs its source');
  if (/Meta/.test(index)) assert.match(index, /href="https:\/\/fortune\.com\//, 'Meta leaderboard claim needs its source');
  assert.doesNotMatch(index, /10×|10x in six months/i, 'the unsourced 10x figure must not return');
  const method = read('method.html');
  for (const figure of ['63.8%', '0.2%']) {
    const at = method.indexOf(figure);
    assert.ok(at > 0, `${figure} expected on the method page`);
    const after = method.slice(at, at + 900);
    assert.match(after, /test\/(?:anytime|drift)\.test\.ts/, `${figure} must link to the test that measures it`);
  }
});

test('the shadow price appears only as not offered', () => {
  assert.doesNotMatch(read('index.html'), /shadow price|μ\s*=/i, 'the landing page must not sell the shadow price');
  const method = read('method.html');
  const notOffered = method.slice(method.indexOf('id="not-offered"'));
  assert.match(notOffered, /shadow price/i);
  assert.doesNotMatch(method.slice(0, method.indexOf('id="not-offered"')), /shadow price/i, 'shadow price is described only under Not offered');
});

test('the primary route works from a fresh clone', () => {
  const index = read('index.html');
  const install = index.slice(index.indexOf('id="install-cmds"'), index.indexOf('</pre>', index.indexOf('id="install-cmds"')));
  assert.match(install, /git clone https:\/\/github\.com\/GamingDragonwastaken\/Segreant\.git/);
  assert.match(install, /npm install/);
  assert.match(install, /npm run demo/);
  const pkg = JSON.parse(readFileSync(join(dirname(WEB), 'package.json'), 'utf8')) as { scripts: Record<string, string>; engines: { node: string } };
  assert.ok(pkg.scripts.demo, 'the page tells people to run npm run demo');
  assert.match(index, new RegExp(`Node ${pkg.engines.node.replace(/[^0-9]/g, '').slice(0, 2)} or later`), 'stated Node version must match package.json engines');
});

test('the loop-guard simulation is labelled and quotes the guard it simulates', () => {
  const index = read('index.html');
  const loop = index.slice(index.indexOf('class="loop'), index.indexOf('</figure>', index.indexOf('class="loop')));
  assert.match(loop, /class="sample">Simulation</, 'the simulated loop must say it is a simulation');
  // The verdict must keep the shape of the product's real block reason, so the
  // page cannot drift into an error message Segreant never prints.
  const guard = readFileSync(join(dirname(WEB), 'src', 'budget', 'guard.ts'), 'utf8');
  assert.match(guard, /Runaway loop guard: \$\$\{window\.costUsd\.toFixed\(2\)\} spent in the last \$\{cfg\.runawayWindowSec\}s exceeds the \$\$\{cfg\.runawayMaxUsd!\.toFixed\(2\)\} threshold\./);
  assert.match(loop, /Runaway loop guard: \$2\.04 spent in the last 60s exceeds the \$2\.00 threshold\./);
});
