/**
 * Antigravity: per-call usage from its conversation databases. The fixture is
 * built with the published field numbers (exa.cortex_pb / codeium_common_pb):
 * a generator row's chat_model (1) carries usage (4) and response_model (19);
 * the same usage repeated in the step metadata and in retry_infos (17) must not
 * be counted again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

process.env.SEGREANT_HOME = mkdtempSync(join(tmpdir(), 'segreant-home-'));
import { Store } from '../src/store/db.ts';
import { importAntigravity } from '../src/connect/antigravity.ts';

// --- a minimal protobuf encoder for the fixture -----------------------------
function varint(n: number): number[] {
  const out: number[] = [];
  let v = BigInt(n);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    out.push(b);
  } while (v > 0n);
  return out;
}
const vfield = (f: number, n: number) => [...varint((f << 3) | 0), ...varint(n)];
const bfield = (f: number, bytes: number[]) => [...varint((f << 3) | 2), ...varint(bytes.length), ...bytes];
const sfield = (f: number, s: string) => bfield(f, [...Buffer.from(s, 'utf8')]);
const timestamp = (ms: number) => [...vfield(1, Math.floor(ms / 1000)), ...vfield(2, (ms % 1000) * 1_000_000)];

const T = Date.parse('2026-09-01T10:00:00.000Z');

function usage(input: number, output: number, cacheRead = 0) {
  return [...vfield(1, 1320), ...vfield(2, input), ...vfield(3, output), ...(cacheRead ? vfield(5, cacheRead) : []), ...sfield(11, 'resp-1')];
}

function conversation(dir: string, name: string, workspace: string) {
  const db = new DatabaseSync(join(dir, `${name}.db`));
  db.exec(`CREATE TABLE trajectory_metadata_blob (id text, data blob);
           CREATE TABLE steps (idx integer, metadata blob);
           CREATE TABLE gen_metadata (idx integer, data blob, size integer)`);
  db.prepare('INSERT INTO trajectory_metadata_blob VALUES (?, ?)').run('main', Uint8Array.from([
    ...bfield(1, sfield(1, pathToFileURL(workspace).href)),
    ...bfield(2, timestamp(T)),
    ...sfield(3, `traj-${name}`),
  ]));
  // Step 1 repeats the call's usage in its metadata (field 9): not counted again.
  db.prepare('INSERT INTO steps VALUES (?, ?)').run(0, Uint8Array.from(bfield(1, timestamp(T))));
  db.prepare('INSERT INTO steps VALUES (?, ?)').run(1, Uint8Array.from([...bfield(1, timestamp(T + 60_000)), ...bfield(9, usage(1000, 50))]));
  // Generator 0: a model call for step 1, with a retry carrying the same usage.
  db.prepare('INSERT INTO gen_metadata VALUES (?, ?, 0)').run(0, Uint8Array.from([
    ...bfield(1, [...vfield(3, 1320), ...bfield(4, usage(1000, 50, 200)), ...bfield(17, bfield(2, usage(1000, 50))), ...sfield(19, 'gemini-3.8-flash')]),
    ...bfield(2, varint(1)),
  ]));
  // Generator 1: an injected response (oneof field 7), no model call.
  db.prepare('INSERT INTO gen_metadata VALUES (?, ?, 0)').run(1, Uint8Array.from(bfield(7, sfield(1, 'injected'))));
  db.close();
}

test('Antigravity: one row per model call, at the step time, in the workspace, priced from the card', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-'));
  const dir = join(root, 'antigravity-cli', 'conversations');
  mkdirSync(dir, { recursive: true });
  const workspace = mkdtempSync(join(tmpdir(), 'agy-ws-'));
  conversation(dir, 'c1', workspace);

  const store = new Store(join(mkdtempSync(join(tmpdir(), 'agy-db-')), 'test.db'));
  const s = await importAntigravity(store, { root });
  assert.equal(s.inserted, 1, 'the step copy, the retry copy and the injected response add nothing');
  const [row] = store.requestsInRange(0, Date.now());
  assert.equal(row!.model, 'gemini-3.8-flash');
  assert.equal(row!.provider, 'google');
  assert.equal(row!.source, 'antigravity');
  assert.equal(row!.tsEpochMs, T + 60_000, 'the first step of the call, not the conversation start');
  assert.equal(row!.inputTokens, 1000);
  assert.equal(row!.outputTokens, 50);
  assert.equal(row!.cacheReadTokens, 200);
  assert.equal(row!.cwd, workspace);
  // $0.75/M in, $3.75/M out, $0.075/M cache read (Google's page, read 2026-10-09).
  const expected = (1000 * 0.75 + 50 * 3.75 + 200 * 0.075) / 1_000_000;
  assert.ok(Math.abs(row!.costUsd - expected) < 1e-12, `${row!.costUsd} vs ${expected}`);
  assert.equal(row!.estimated, false, 'an exact rate on the card');

  const again = await importAntigravity(store, { root });
  assert.equal(again.inserted, 0);
  store.close();
});
