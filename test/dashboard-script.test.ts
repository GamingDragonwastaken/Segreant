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

function assertNoExternalBrowserTransport(label: string, source: string): void {
  const quote = String.fromCharCode(96);
  const absoluteLiteral = new RegExp(
    '["\\x27' + quote + '](https?:)?//[^"\\x27' + quote + '\\s]+["\\x27' + quote + ']',
    'g',
  );
  for (const match of source.matchAll(absoluteLiteral)) {
    const url = match[0].slice(1, -1);
    if (NAMESPACE_URIS.has(url)) continue;
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') continue;
    } catch {
      // The regular expression only reaches syntactically absolute candidates.
      // A malformed candidate is not a safe browser destination.
    }
    assert.fail(label + ': absolute URL ' + match[0] + ' — the GUI may only address a local origin');
  }
  assert.equal(
    /\bnew\s+(WebSocket|EventSource|XMLHttpRequest)\b/.test(source),
    false,
    label + ': opens an external-capable browser transport',
  );
  assert.equal(/\bimportScripts\b/.test(source), false, label + ': imports a worker script');
}

test('GUI source, emitted modules, and inline scripts make no external browser transport', () => {
  const sourceFiles = walk(join(WEB_SRC, 'app'), '.ts');
  const emittedFiles = walk(join(WEB_DIST, 'app'), '.js');
  assert.ok(sourceFiles.length > 5, 'expected the GUI sources');
  assert.ok(emittedFiles.length > 5, 'build the GUI before running this test');

  for (const file of [...sourceFiles, ...emittedFiles]) {
    assertNoExternalBrowserTransport(file, readFileSync(file, 'utf8'));
  }
  for (const [entry, html] of [[SHELL, readFileSync(SHELL, 'utf8')], [CLASSIC, readFileSync(CLASSIC, 'utf8')]] as const) {
    for (const [index, script] of inlineScripts(html).entries()) {
      assertNoExternalBrowserTransport(entry + ' inline script ' + index, script);
    }
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

/**
 * The payload carries two entirely different quantities side by side:
 *
 *   realization.matured.spendOnRealizedUnitsUsd  the attributed SPEND on units that
 *                                         realized (sum of attributedCostUsd)
 *   roi.returnRatio.manualEquivalentValueUsd     the manual-equivalent VALUE those
 *                                         units produced, net of rework
 *
 * They were both spelled `realizedValueUsd` when the bug below happened, which
 * is why nothing caught it. AII-012 gave them distinct identifiers, so the
 * substitution is now a type error too — this grep is the second line.
 *
 * The spine shipped reading the first one into the fourth claim, so the band
 * labelled "Realized" — the value end of
 * `metered != billed != allocated != realized value` — was rendering a cost.
 * That is the exact collapse the whole product exists to refuse, committed by
 * the component built to make the refusal visible, and neither the typecheck nor
 * any test caught it because both fields are real, numeric, and identically
 * named.
 *
 * So this pins the distinction at the source. It is a grep rather than a
 * behavioural assertion because the failure was one of MEANING, not of
 * mechanism: the code ran perfectly and reported the wrong claim.
 *
 * The derivation has since moved out of `chain.ts` — which is now only the
 * fetching half — and into `core/claimLayers.ts`, where it is also covered
 * behaviourally by `test/claim-layers.test.ts`. The grep follows the code. It
 * is kept alongside the behavioural test rather than replaced by it, because a
 * fixture proves the current code reads the right field while the grep is what
 * survives someone rewriting the derivation from memory.
 */
test('the realized band carries the value claim, not the cost of realized work', () => {
  const claims = readFileSync(join(WEB_SRC, 'app', 'core', 'claimLayers.ts'), 'utf8');

  // The realized layer must price itself from the RoI return, which is the only
  // field in the payload that is actually value.
  assert.match(
    claims,
    /returnRatio/,
    'claimLayers.ts must read the realized figure from roi.returnRatio',
  );

  // And it must not fall back to the cost field for that figure.
  assert.equal(
    /valueUsd:\s*matured[?.]*\.spendOnRealizedUnitsUsd/.test(claims),
    false,
    'claimLayers.ts must not use matured.spendOnRealizedUnitsUsd as the realized VALUE figure — that field is attributed spend',
  );

  // A dollar figure is only shown when the payload says it priced one.
  assert.match(
    claims,
    /basis === 'usd'/,
    'claimLayers.ts must require the payload to declare a usd basis before showing dollars',
  );

  // The hazard is documented where the type is declared, so the next person to
  // write this interface from memory meets the warning first.
  const api = readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard', 'shared-types.ts'), 'utf8');
  assert.match(
    api,
    /never the value it produced/,
    'shared dashboard types must warn that matured.spendOnRealizedUnitsUsd is a cost, not a value',
  );

  // The stronger guarantee, added by AII-012: the two quantities no longer share
  // an identifier, so substituting one for the other is a type error rather than
  // something only a comment stands between you and.
  assert.match(api, /spendOnRealizedUnitsUsd/, 'the cost field must be named as a cost');
  assert.match(api, /manualEquivalentValueUsd/, 'the value field must be named as a value');
  assert.doesNotMatch(
    api,
    /(?<![A-Za-z`])realizedValueUsd(?![A-Za-z`])/,
    'the ambiguous identifier must not return to the shared payload types',
  );
});

/**
 * The browser consumes the generated shared BudgetConfig, and a wrong field name
 * SILENT in both directions: reading `budget.dailyCapUsd` off a payload that
 * spells it `dailyUsd` yields undefined, which the Control screen rendered as
 * "no cap set" while a cap was configured and enforcing; and posting the same
 * wrong key to /api/settings/update succeeds with a healthy-looking response,
 * because `applySettingsPatch` copies only the keys it recognises and ignores
 * the rest. No typecheck can catch it — the browser tsconfig cannot see the node
  * source, so the two interfaces used to be structurally unrelated.
 *
 * So the contract is pinned across the boundary: every field the server's
 * BudgetConfig declares must exist in the GUI's, spelled identically.
 */
test('the GUI budget type matches the server budget config field for field', () => {
  const server = readFileSync(join(import.meta.dirname, '..', 'src', 'config.ts'), 'utf8');
  const block = server.slice(server.indexOf('export interface BudgetConfig'));
  const body = block.slice(0, block.indexOf(String.fromCharCode(10) + '}'));
  const fields = [...body.matchAll(/^\s{2}(\w+)[?]?:/gm)].map((m) => m[1]);

  assert.ok(fields.length >= 5, `expected to parse the server BudgetConfig, got ${fields.length} fields`);

  const gui = readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard', 'shared-types.ts'), 'utf8');
  const guiBlock = gui.slice(gui.indexOf('export interface BudgetConfig'));
  const guiBody = guiBlock.slice(0, guiBlock.indexOf(String.fromCharCode(10) + '}'));

  for (const field of fields) {
    assert.match(
      guiBody,
      new RegExp(`\\b${field}[?]?:`),
      `the GUI BudgetConfig is missing "${field}" — a name the server actually uses`,
    );
  }

  // And the names that were invented must not come back. Matched as property
  // access or declaration rather than as a bare word, so the comments that
  // explain the hazard can go on naming it.
  const guiSources = walk(join(WEB_SRC, 'app'), '.ts').map((f) => readFileSync(f, 'utf8')).join(String.fromCharCode(10));
  for (const invented of ['dailyCapUsd', 'sessionCapUsd', 'softWarnRatio']) {
    const used = new RegExp(`[.]${invented}\b|\b${invented}\s*[:?]`).test(guiSources);
    assert.equal(used, false, `${invented} is not a field the server has`);
  }
});

/**
 * Plain register rounds money to cents, which is right until the amount is
 * smaller than a cent. Then `maximumFractionDigits: 2` turns a real figure into
 * "$0.00" — not a rounding but a false claim, and one an operator reads as "no
 * limit set" or "nothing spent".
 *
 * Caught on a live proxy run: a $0.0050 daily cap rendered as "$0.01" and its
 * $0.0020 soft threshold as "$0.00", directly beneath an alert quoting
 * "$0.0052 / $0.0050". Two figures for one quantity, disagreeing, on one screen.
 *
 * Small caps are not a contrived case — they are what anyone testing a budget
 * sets first, which is exactly when trust in the number is being formed.
 */
test('plain-register money never renders a real amount as zero', async () => {
  const { usd } = await import('../src/dashboard/web/app/core/fmt.ts');

  // A true zero is still a true zero.
  assert.equal(usd(0, { precise: false }), '$0.00');

  // Sub-cent amounts keep enough precision to be distinguishable, and to agree
  // with the server-formatted figures they sit beside.
  assert.equal(usd(0.005, { precise: false }), '$0.0050');
  assert.equal(usd(0.002, { precise: false }), '$0.0020');

  // Below the ledger's microdollar resolution, say so rather than print zeros.
  assert.equal(usd(0.0000004, { precise: false }), '<$0.000001');

  // Ordinary amounts are untouched.
  assert.equal(usd(0.01, { precise: false }), '$0.01');
  assert.equal(usd(12.5, { precise: false }), '$12.50');
  assert.equal(usd(1574.42, { precise: false }), '$1,574.42');

  // The invariant, stated directly: no non-zero amount may format as all zeros.
  for (const value of [0.009, 0.005, 0.0011, 0.0002, 0.00001, 0.000001, 5e-7]) {
    const shown = usd(value, { precise: false });
    assert.notEqual(shown, '$0.00', `${value} rendered as $0.00`);
    assert.equal(/^\$0\.0+$/.test(shown), false, `${value} rendered as all zeros: ${shown}`);
  }
});
