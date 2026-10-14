/** Deterministic, synthetic Antigravity conversation databases for import profiling. */
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function option(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  if (i + 1 >= process.argv.length) throw new Error(`--${name} needs a value`);
  return process.argv[i + 1];
}

function count(name, fallback, max) {
  const n = Number(option(name, fallback));
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(`--${name} must be an integer from 1 to ${max}`);
  return n;
}

const outArg = option('out', null);
if (!outArg) throw new Error('pass --out with a new scratch directory');
const out = resolve(outArg);
const files = count('files', 100, 10_000);
const generatorsPerFile = count('generators-per-file', 100, 5_000);
const projects = count('projects', 54, 1_000);
const paddingBytes = count('padding-bytes', 1_024, 65_536);
if (files * generatorsPerFile > 500_000) throw new Error('generator rows exceed the importer resource limit');

function varint(value) {
  let n = BigInt(value);
  const out = [];
  do {
    let byte = Number(n & 0x7fn);
    n >>= 7n;
    if (n) byte |= 0x80;
    out.push(byte);
  } while (n);
  return out;
}
const vfield = (field, n) => [...varint(field << 3), ...varint(n)];
const bfield = (field, bytes) => [...varint((field << 3) | 2), ...varint(bytes.length), ...bytes];
const sfield = (field, value) => bfield(field, Buffer.from(value));
const timestamp = (ms) => [...vfield(1, Math.floor(ms / 1_000)), ...vfield(2, (ms % 1_000) * 1_000_000)];
const usage = (n) => [...vfield(2, 900 + n % 400), ...vfield(3, 80 + n % 120), ...vfield(5, 100 + n % 200)];
const models = ['gemini-3.8-flash', 'gemini-3.8-flash', 'gemini-3.8-flash', 'gemini-3.8-flash', 'gemini-3.8-flash', 'gemini-3.8-flash', 'claude-sonnet-4-5', 'claude-sonnet-4-5', 'claude-sonnet-4-5', 'gpt-5'];
const pad = Buffer.alloc(paddingBytes, 0x61);
const extra = bfield(120, pad);
const day = 86_400_000;
const anchor = Date.now() - 20 * day;

// mkdir without recursive mode refuses an existing destination. A benchmark
// must never overwrite the operator's real tool database or a prior run.
await mkdir(out);
const root = join(out, 'source');
const conversations = join(root, 'antigravity', 'conversations');
const workspaces = join(out, 'synthetic-projects');
await mkdir(root);
await mkdir(join(root, 'antigravity'));
await mkdir(conversations);
await mkdir(workspaces);
for (let project = 0; project < projects; project++) {
  await mkdir(join(workspaces, `project-${String(project).padStart(3, '0')}`));
}

let expectedCalls = 0;
let expectedRecentCalls = 0;
let databaseBytes = 0;
const modelCounts = Object.fromEntries([...new Set(models)].map((model) => [model, 0]));
for (let file = 0; file < files; file++) {
  const name = `synthetic-${String(file).padStart(5, '0')}`;
  const dbPath = join(conversations, `${name}.db`);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE trajectory_metadata_blob (id TEXT, data BLOB); CREATE TABLE steps (idx INTEGER, metadata BLOB); CREATE TABLE gen_metadata (idx INTEGER, data BLOB, size INTEGER)');
    const workspace = join(workspaces, `project-${String(file % projects).padStart(3, '0')}`);
    db.prepare('INSERT INTO trajectory_metadata_blob VALUES (?, ?)').run('main', Uint8Array.from([
      ...bfield(1, sfield(1, pathToFileURL(workspace).href)),
      ...bfield(2, timestamp(anchor)),
      ...sfield(3, name),
    ]));
    const insertStep = db.prepare('INSERT INTO steps VALUES (?, ?)');
    const insertGenerator = db.prepare('INSERT INTO gen_metadata VALUES (?, ?, ?)');
    db.exec('BEGIN');
    try {
      for (let index = 0; index < generatorsPerFile; index++) {
        const ordinal = file * generatorsPerFile + index;
        // One quarter is older than the recent-month window. One in ten
        // generator rows is an injected response, so it contributes no usage.
        const at = anchor - (ordinal % 4 === 0 ? 40 * day : 0) + (ordinal % 19) * 60_000;
        insertStep.run(index, Uint8Array.from([...bfield(1, timestamp(at)), ...extra]));
        if (ordinal % 10 === 0) {
          insertGenerator.run(index, Uint8Array.from([...bfield(7, sfield(1, 'synthetic-injection')), ...extra]), paddingBytes);
          continue;
        }
        const stats = usage(ordinal);
        const model = models[ordinal % models.length];
        modelCounts[model]++;
        insertGenerator.run(index, Uint8Array.from([
          ...bfield(1, [...vfield(3, 1320), ...bfield(4, stats), ...bfield(17, bfield(2, stats)), ...sfield(19, model)]),
          ...bfield(2, varint(index)),
          ...extra,
        ]), paddingBytes);
        expectedCalls++;
        if (ordinal % 4 !== 0) expectedRecentCalls++;
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.close();
  }
  databaseBytes += (await stat(dbPath)).size;
}

const manifest = {
  synthetic: true, schemaVersion: 1, root, files, generatorsPerFile,
  generatorRows: files * generatorsPerFile, stepRows: files * generatorsPerFile,
  projects, paddingBytes, databaseBytes, expectedCalls, expectedRecentCalls,
  modelCounts,
  injectedEvery: 10, olderEvery: 4,
};
await writeFile(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(manifest)}\n`);
