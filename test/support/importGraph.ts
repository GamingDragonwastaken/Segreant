/**
 * The repository's ONE import-graph walker, shared by every test that asks
 * whether a product path reaches a module.
 *
 * This is the walker `test/issuance-map.test.ts` grew and it moved here
 * unchanged, for the reason recorded at D-098 and restated in
 * `src/epistemic/dag.ts`: two implementations of one question in this
 * repository eventually give two answers. `test/module-contracts.test.ts`
 * checks contract sentences of the form "nothing calls X" against the same
 * graph the issuance map is checked against, so a contract and a map cannot
 * disagree about reachability because they counted differently.
 *
 * A regex over relative specifiers is enough here and would not be in general:
 * this repository has no dynamic import with a computed specifier, which
 * `test/issuance-map.test.ts` re-checks rather than assumes.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative as relativePath, resolve, sep } from 'node:path';

/** The repository root, from `test/support/`. */
export const ROOT = join(import.meta.dirname, '..', '..');

/**
 * `bin/fiscus.mjs` runs `dist/cli.js`, compiled from `src/cli.ts`, so that is
 * the entry. `team-server/` is a separate npm project that imports root source
 * directly, so its server is a second one — leaving it out would make the answer
 * depend on the accident that everything it pulls in is reachable from the CLI
 * too.
 */
export const PRODUCT_ENTRIES = ['src/cli.ts', 'team-server/src/server.ts'];

/** Every `.ts` file under `src/`, so a sweep cannot silently miss a directory. */
export function sourceFiles(dir = 'src'): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) found.push(...sourceFiles(relative));
    else if (entry.name.endsWith('.ts')) found.push(relative);
  }
  return found;
}

/** Relative specifiers, static and dynamic, as written in a source file. */
const RELATIVE_SPECIFIERS = /from\s+['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]/g;

/** Everything under `src/` that a product entry point actually imports. */
export function productClosure(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const visit = (file: string): void => {
    const abs = resolve(file);
    if (seen.has(abs) || !existsSync(abs)) return;
    seen.add(abs);
    const source = readFileSync(abs, 'utf8');
    let match: RegExpExecArray | null;
    const specifiers = new RegExp(RELATIVE_SPECIFIERS.source, 'g');
    while ((match = specifiers.exec(source)) !== null) {
      const specifier = match[1] ?? match[2] ?? '';
      // Emitted specifiers are rewritten to `.js`; the source tree is `.ts`.
      visit(join(dirname(abs), specifier.replace(/\.js$/, '.ts')));
    }
  };
  for (const entry of entries) visit(join(ROOT, entry));
  return new Set(
    [...seen]
      .map((file) => relativePath(ROOT, file).split(sep).join('/'))
      .filter((file) => file.startsWith('src/')),
  );
}

/**
 * Every `src/` file that imports `target`, by the same specifier rule.
 *
 * The closure answers "does a product entry reach this?"; this answers "does
 * anything at all reach this?", which is the question a contract sentence like
 * "nothing calls `abstract.ts`: no ledger path, no product path" makes.
 */
export function importersOf(target: string): string[] {
  const wanted = resolve(join(ROOT, target));
  const importers: string[] = [];
  for (const file of sourceFiles()) {
    const abs = resolve(join(ROOT, file));
    if (abs === wanted) continue;
    const source = readFileSync(abs, 'utf8');
    let match: RegExpExecArray | null;
    const specifiers = new RegExp(RELATIVE_SPECIFIERS.source, 'g');
    while ((match = specifiers.exec(source)) !== null) {
      const specifier = match[1] ?? match[2] ?? '';
      if (resolve(join(dirname(abs), specifier.replace(/\.js$/, '.ts'))) === wanted) {
        importers.push(file);
        break;
      }
    }
  }
  return importers;
}
