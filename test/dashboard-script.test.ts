/**
 * The GUI's highest-blast-radius failure is a page that does not run at all.
 *
 * When the dashboard was one file with one inline script, a single bad character
 * anywhere in it killed the whole page silently — nothing rendered, no view
 * switched, and the API kept returning perfect JSON the entire time, so every
 * HTTP-level check still passed. That was not hypothetical: an over-escaped
 * apostrophe inside a tooltip string took the console down while the API tests,
 * the typecheck, and the build all stayed green.
 *
 * Splitting into modules changed the shape of that failure but not its severity.
 * A module that fails to parse, or an import specifier the browser cannot
 * resolve, takes the whole app down just as completely — and `tsc` will not
 * catch a bad specifier, because it type-checks the source tree while the
 * browser resolves the EMITTED one.
 *
 * So this walks what actually ships: both HTML entry points, every emitted
 * module, and every import specifier between them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import vm from 'node:vm';

const WEB_SRC = join(import.meta.dirname, '..', 'src', 'dashboard', 'web');
const WEB_DIST = join(import.meta.dirname, '..', 'dist', 'dashboard', 'web');
const SHELL = join(WEB_SRC, 'index.html');
const CLASSIC = join(WEB_SRC, 'classic.html');

function inlineScripts(html: string): string[] {
  const out: string[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[2]!.trim()) out.push(m[2]!);
  }
  return out;
}

function walk(dir: string, ext: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, ext));
    else if (entry.endsWith(ext)) out.push(full);
  }
  return out;
}

test('classic dashboard: every inline script parses', () => {
  const html = readFileSync(CLASSIC, 'utf8');
  const scripts = inlineScripts(html);
  assert.ok(scripts.length > 0, 'the classic dashboard carries its behaviour inline');
  for (const [i, source] of scripts.entries()) {
    // `new vm.Script` compiles without executing: no DOM needed, and a
    // SyntaxError surfaces exactly where the browser would have hit it.
    assert.doesNotThrow(() => new vm.Script(source), `inline script ${i} does not parse`);
  }
});

/**
 * The emitted modules are not parse-checked here, deliberately. They come out of
 * `tsc`, which cannot emit syntactically invalid JavaScript, so a parse test over
 * them would assert a property the compiler already guarantees. `classic.html`
 * above IS parse-checked, because its script is hand-written.
 *
 * What `tsc` genuinely cannot catch is below: it type-checks the SOURCE tree
 * while the browser resolves the EMITTED one, so a specifier that resolves for
 * the compiler and 404s in the browser passes every other gate in this repo.
 */
test('GUI: every import specifier resolves to a file that ships', () => {
  const modules = walk(join(WEB_DIST, 'app'), '.js');
  assert.ok(modules.length > 5, 'build the GUI before running this test');

  let checked = 0;
  for (const file of modules) {
    const source = readFileSync(file, 'utf8');
    for (const m of source.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s+["']([^"']+)["']/g)) {
      const spec = m[1]!;
      // A bare specifier would need an import map the page does not ship.
      assert.ok(spec.startsWith('.') || spec.startsWith('/'), `${file}: bare specifier "${spec}" cannot resolve in a browser`);
      // The browser will not add an extension for you.
      assert.ok(spec.endsWith('.js'), `${file}: specifier "${spec}" has no .js extension`);
      const target = resolve(dirname(file), spec);
      assert.ok(existsSync(target), `${file}: imports "${spec}" which does not exist at ${target}`);
      checked++;
    }
  }
  assert.ok(checked > 0, 'expected the GUI modules to import each other');
});

test('GUI: the shell references only modules that ship', () => {
  const html = readFileSync(SHELL, 'utf8');
  for (const m of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)) {
    const target = join(WEB_DIST, m[1]!.replace(/^\//, ''));
    assert.ok(existsSync(target), `shell loads ${m[1]} which is not in the build`);
  }
  for (const m of html.matchAll(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi)) {
    const href = m[1]!;
    if (href.startsWith('data:')) continue;
    const target = join(WEB_DIST, href.replace(/^\//, ''));
    assert.ok(existsSync(target), `shell links ${href} which is not in the build`);
  }
});

/**
 * Local-first is not only a data claim. A page that fetched a font or a chart
 * library would leak the fact that it was opened, break offline, and turn "this
 * makes no external requests" from something an operator can verify by reading
 * the file into something they have to take on trust.
 */
for (const [label, path] of [['shell', SHELL], ['classic', CLASSIC]] as const) {
  test(`${label}: loads no external resource`, () => {
    const html = readFileSync(path, 'utf8');
    for (const m of html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
      const value = m[1]!;
      assert.equal(/^(?:https?:)?\/\//i.test(value), false, `remote resource referenced: ${value}`);
    }
  });
}

const NAMESPACE_URIS = new Set([
  'http://www.w3.org/2000/svg',
  'http://www.w3.org/1999/xhtml',
  'http://www.w3.org/1999/xlink',
]);

test('GUI sources: no module reaches the network', () => {
  const sources = walk(join(WEB_SRC, 'app'), '.ts');
  assert.ok(sources.length > 5, 'expected the GUI sources');
  for (const file of sources) {
    const source = readFileSync(file, 'utf8');
    // `fetch` is how the GUI talks to its own server, so the ban is on absolute
    // URLs and on the transports that have no same-origin story at all.
    //
    // XML namespace URIs are the one exception, and a real one: `createElementNS`
    // requires the literal SVG namespace string, and no browser has ever
    // dereferenced it. Exempting them by exact value rather than by pattern keeps
    // the check from being talked out of anything else.
    for (const m of source.matchAll(/["'`](https?:)?\/\/[^"'`\s]+["'`]/g)) {
      const url = m[0].slice(1, -1);
      if (NAMESPACE_URIS.has(url)) continue;
      assert.fail(`${file}: absolute URL ${m[0]} — the GUI may only address its own origin`);
    }
    assert.equal(/\bnew\s+(WebSocket|EventSource)\b/.test(source), false, `${file}: opens a socket`);
    assert.equal(/\bimportScripts\b/.test(source), false, `${file}: importScripts`);
  }
});

/**
 * Ledger data is operator-supplied: project names come from folder names, model
 * ids from provider responses, cost-centre labels from a config file. None of it
 * should ever be able to become markup, so the GUI has no HTML-parsing sink at
 * all and this pins that shut.
 */
test('GUI sources: no HTML injection sink', () => {
  const sources = walk(join(WEB_SRC, 'app'), '.ts');
  for (const file of sources) {
    const source = readFileSync(file, 'utf8');
    assert.equal(/\.innerHTML\s*=/.test(source), false, `${file}: assigns innerHTML`);
    assert.equal(/\.outerHTML\s*=/.test(source), false, `${file}: assigns outerHTML`);
    assert.equal(/insertAdjacentHTML/.test(source), false, `${file}: insertAdjacentHTML`);
    assert.equal(/\bdocument\.write\b/.test(source), false, `${file}: document.write`);
  }
});

/**
 * Serving the classic dashboard without a return link made it a one-way door:
 * an operator who clicked through had no route back except editing the URL. The
 * link between the two surfaces has to exist in both directions, so both are
 * pinned rather than only the one that was noticed.
 */
test('the two interfaces link to each other in both directions', () => {
  // The GUI builds its footer in TypeScript, so the outbound link lives in the
  // source rather than the shell markup.
  const gui = walk(join(WEB_SRC, 'app'), '.ts').map((f) => readFileSync(f, 'utf8')).join(String.fromCharCode(10));
  const classic = readFileSync(CLASSIC, 'utf8');
  assert.match(gui, /href: '\/classic'/, 'the GUI must offer the classic dashboard');
  assert.match(classic, /class="backlink" href="\/"/, 'the classic dashboard must offer a way back');
});
