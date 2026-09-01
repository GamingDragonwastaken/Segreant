import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Publish a generated file atomically.
 *
 * These land inside the live source tree, which other processes read: the
 * browser compiler root during a concurrent build, and `dashboard-script`'s
 * source sweep, which walks `src/dashboard/web/app` while `build-race` is
 * running two builds through it. A plain `writeFileSync` leaves a window in
 * which that reader sees a truncated file or, mid-rewrite on Windows, no file
 * at all. Same-directory rename removes the window rather than asking readers
 * to retry around it.
 */
function publishGenerated(path, contents) {
  const temp = `${path}.${process.pid}-${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, contents, 'utf8');
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
const sourcePath = join(root, 'src', 'dashboard', 'shared-types.ts');
const targetPath = join(root, 'src', 'dashboard', 'web', 'app', 'core', 'generated-payload-contract.ts');
const generatedTypesPath = join(root, 'src', 'dashboard', 'web', 'app', 'core', 'generated-types.ts');

function parseInterfaces(source) {
  const raw = new Map();
  const re = /export interface (\w+)(?:\s+extends\s+([\w,\s]+))?\s*\{/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const name = match[1];
    if (!name) continue;
    const parents = (match[2] ?? '').split(',').map((value) => value.trim()).filter(Boolean);

    let depth = 0;
    let i = re.lastIndex - 1;
    const start = i;
    for (; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const body = source.slice(start + 1, i);
    const fields = [];
    let nested = 0;
    for (const rawLine of body.split(String.fromCharCode(10))) {
      const line = rawLine.trim();
      const fieldMatch = nested === 0 ? /^(\w+)(\??):\s*(.+?);?$/.exec(line) : null;
      if (fieldMatch && fieldMatch[1] && !line.startsWith('//') && !line.startsWith('*')) {
        fields.push({
          name: fieldMatch[1],
          optional: fieldMatch[2] === '?',
          type: (fieldMatch[3] ?? '').trim(),
        });
      }
      for (const ch of rawLine) {
        if (ch === '{') nested += 1;
        else if (ch === '}') nested -= 1;
      }
    }
    raw.set(name, { parents, fields });
  }
  return raw;
}

function flattenInterfaces(raw) {
  const cache = new Map();
  function flatten(name, visiting = new Set()) {
    if (cache.has(name)) return cache.get(name);
    const item = raw.get(name);
    if (!item || visiting.has(name)) return [];
    const nextVisiting = new Set(visiting);
    nextVisiting.add(name);
    const merged = new Map();
    for (const parent of item.parents) {
      for (const field of flatten(parent, nextVisiting)) merged.set(field.name, field);
    }
    for (const field of item.fields) merged.set(field.name, field);
    const result = [...merged.values()];
    cache.set(name, result);
    return result;
  }
  return Object.fromEntries([...raw.keys()].map((name) => [name, flatten(name)]));
}

const source = readFileSync(sourcePath, 'utf8');
const sourceSha256 = createHash('sha256').update(source, 'utf8').digest('hex');
const interfaces = flattenInterfaces(parseInterfaces(source));
const generated = [
  '/** Generated from src/dashboard/shared-types.ts; do not edit by hand. */',
  `export const DASHBOARD_INTERFACE_CONTRACT_SOURCE_SHA256 = ${JSON.stringify(sourceSha256)};`,
  `export const DASHBOARD_INTERFACE_CONTRACTS = ${JSON.stringify(interfaces, null, 2)} as const;`,
  '',
].join('\n');
publishGenerated(targetPath, generated);

// The browser compiler intentionally has a rootDir of web/app and cannot import
// the server-side shared source directly. Copy the canonical declarations into
// that root as a hash-bound, type-only build artifact; api.ts consumes this copy,
// while server code and contract tests consume src/dashboard/shared-types.ts.
const generatedTypes = [
  '/** Generated from src/dashboard/shared-types.ts; do not edit by hand. */',
  `/** Source SHA-256: ${sourceSha256} */`,
  source.trim(),
  '',
].join('\n');
publishGenerated(generatedTypesPath, generatedTypes);
