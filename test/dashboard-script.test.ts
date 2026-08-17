/**
 * The dashboard is one static HTML file with one inline <script>. That means a
 * single bad character anywhere in ~2,000 lines of it does not degrade a card —
 * it kills the entire page, silently. Nothing renders, no view switches, and
 * the API keeps returning perfect JSON the whole time, so every HTTP-level
 * check still passes.
 *
 * This was not hypothetical: an over-escaped apostrophe inside a tooltip string
 * took the whole console down, and the API tests, the typecheck, and the build
 * all stayed green. Parsing the script is the cheapest possible guard against
 * the highest-blast-radius failure this file has.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const HTML = join(import.meta.dirname, '..', 'src', 'dashboard', 'web', 'index.html');

function inlineScripts(html: string): string[] {
  const out: string[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    // Only scripts with a body; a `src=` tag has nothing to parse (and the
    // dashboard ships none — it must stay self-contained and offline).
    if (m[2]!.trim()) out.push(m[2]!);
  }
  return out;
}

test('dashboard: every inline script parses', () => {
  const html = readFileSync(HTML, 'utf8');
  const scripts = inlineScripts(html);
  assert.ok(scripts.length > 0, 'the dashboard must carry its behaviour inline');
  for (const [i, source] of scripts.entries()) {
    // `new vm.Script` compiles without executing: no DOM is needed, and a
    // SyntaxError surfaces exactly where the browser would have hit it.
    assert.doesNotThrow(() => new vm.Script(source), `inline script ${i} does not parse`);
  }
});

test('dashboard: loads no external resource', () => {
  const html = readFileSync(HTML, 'utf8');
  // Local-first is not only a data claim — a dashboard that fetched a font or a
  // chart library would leak the fact that it was opened, and would break
  // offline. The page must stay one self-contained file.
  assert.equal(/<script\b[^>]*\bsrc=/i.test(html), false, 'no external script');
  assert.equal(/<link\b[^>]*\brel=["']?stylesheet/i.test(html), false, 'no external stylesheet');
  for (const m of html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    const value = m[1]!;
    assert.equal(
      /^(?:https?:)?\/\//i.test(value),
      false,
      `remote resource referenced: ${value}`,
    );
  }
});
