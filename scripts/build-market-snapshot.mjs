#!/usr/bin/env node
// Assemble market/snapshot.json from the per-source files a real refresh wrote.
//
// Maintainer tool, not runtime. The data is fetched by the product itself,
// through the egress gate, so the bundle and a user's refresh share one path:
//
//   SEGREANT_HOME=<scratch> node bin/segreant.mjs egress apply ... (per source; the
//     market prints each exact command when a refresh is refused)
//   SEGREANT_HOME=<scratch> node bin/segreant.mjs market --refresh all
//   node scripts/build-market-snapshot.mjs <scratch>
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const home = process.argv[2];
if (!home) {
  console.error('usage: node scripts/build-market-snapshot.mjs <SEGREANT_HOME with market/*.json>');
  process.exit(2);
}
const dir = join(home, 'market');
const ids = ['litellm', 'aider', 'arena-text', 'arena-webdev', 'arena-image'];
const found = new Set(readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)));
const missing = ids.filter((id) => !found.has(id));
if (missing.length) {
  console.error(`refusing to build a partial snapshot; missing: ${missing.join(', ')}`);
  process.exit(1);
}
const sources = {};
for (const id of ids) sources[id] = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8'));
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'market', 'snapshot.json');
writeFileSync(out, JSON.stringify({ schemaVersion: 2, sources }) + '\n');
console.log(`wrote ${out}`);
for (const id of ids) console.log(`  ${id}: fetched ${sources[id].fetchedAt}, published ${sources[id].publishedAt ?? 'undated'}`);
