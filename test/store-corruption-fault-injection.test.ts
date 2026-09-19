/**
 * BYTE-LEVEL CORRUPTION FAULT INJECTION ON THE LEDGER FILE (WP-H01/WP-H03,
 * D-251).
 *
 * D-139 put a full `integrity_check` and append-only trigger authority at Store
 * startup; D-233 injected interruption into the migration itself. What neither
 * did was damage the file: every corruption test so far replaced a whole
 * backup with garbage or tampered a payload digest. This sweep flips one byte
 * at a series of offsets across a real ledger — the header, the schema page,
 * a data page, the tail — and reopens it each time.
 *
 * The oracle is the one the product promises (`CLAUDE.md` rule 5, fail
 * closed): for every injected fault EITHER startup refuses to open the
 * database, OR it opens and the rows written before the fault read back
 * exactly. There is no third outcome in which a damaged ledger opens and
 * answers differently. The sweep must also refuse at least once, so a run in
 * which SQLite absorbed every flip is reported as vacuous rather than green.
 *
 * Not established: corruption that SQLite's own b-tree check cannot see (a
 * flipped bit inside a payload that stays a valid record); the append-only
 * trigger sweep (D-113) and payload-digest revalidation (D-232) cover the
 * tampering this test does not.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type RequestRow } from '../src/store/db.ts';

function request(i: number): RequestRow {
  return {
    requestId: `fault-request-${i}`, sessionId: null, tsEpochMs: 1_700_000_000_000 + i * 1000, provider: 'openai', model: 'gpt-4o',
    project: `fault-fixture-${i % 3}`, taskWeight: 1, inputTokens: 10 + i, outputTokens: 5, cacheWriteTokens: 0, cacheReadTokens: 0,
    reasoningTokens: 0, costUsd: 0.00125 * (i + 1), estimated: false, streamed: false, statusCode: 200, durationMs: 12,
  };
}

const ROWS = 40;

const PROVENANCE_COLUMNS = ['captureCoverage', 'scopeCaptureStatus', 'attributionBasis', 'pricing'] as const;

type Outcome = 'refused_at_open' | 'refused_at_read' | 'exact' | 'drift';

function inject(dir: string, bytes: Buffer, offset: number, expected: RequestRow[]): { outcome: Outcome; detail: string } {
  const damaged = Buffer.from(bytes);
  damaged[offset] = damaged[offset]! ^ 0xff;
  const path = join(dir, 'fault.sqlite');
  writeFileSync(path, damaged);
  let opened: Store;
  try {
    opened = new Store(path);
  } catch (error) {
    return { outcome: 'refused_at_open', detail: (error as Error).message.slice(0, 200) };
  }
  try {
    const rows = opened.requestsInRange(0, Number.MAX_SAFE_INTEGER);
    if (JSON.stringify(rows) === JSON.stringify(expected)) return { outcome: 'exact', detail: '' };
    const changed = new Set<string>();
    for (let i = 0; i < expected.length; i++) {
      const before = expected[i] as unknown as Record<string, unknown>;
      const after = (rows[i] ?? {}) as unknown as Record<string, unknown>;
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changed.add(key);
      }
    }
    return { outcome: 'drift', detail: [...changed].sort().join(',') };
  } catch (error) {
    return { outcome: 'refused_at_read', detail: (error as Error).message.slice(0, 80) };
  } finally {
    opened.close();
  }
}

test('a single-byte fault is refused at open, refused at read, or reads back exactly — and a provenance label never drifts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-fault-'));
  const pristine = join(dir, 'pristine.sqlite');
  try {
    const store = new Store(pristine);
    for (let i = 0; i < ROWS; i++) store.insertRequest(request(i));
    const expected = store.requestsInRange(0, Number.MAX_SAFE_INTEGER);
    store.close();
    assert.equal(expected.length, ROWS);
    const bytes = readFileSync(pristine);

    // Targeted faults: the header magic (SQLite must refuse), and one byte
    // inside a stored provenance label (the read boundary must refuse).
    assert.equal(inject(dir, bytes, 0, expected).outcome, 'refused_at_open');
    const label = bytes.lastIndexOf(Buffer.from('unscoped'));
    assert.ok(label > 0, 'the fixture stores a scope-capture label to damage');
    const labelFault = inject(dir, bytes, label + 3, expected);
    assert.equal(labelFault.outcome, 'refused_at_read', `a damaged provenance label must refuse, not read as unknown: ${labelFault.outcome} ${labelFault.detail}`);
    assert.match(labelFault.detail, /ledger integrity: column scopeCaptureStatus/);

    // One byte inside a column name in the retained DDL: every page stays
    // valid, the column becomes unreachable, and before D-251 the idempotent
    // migration re-added it with its default — resetting capture_coverage to
    // the legacy sentinel on every row, silently. Now refused at open.
    const ddl = bytes.lastIndexOf(Buffer.from('  capture_coverage TEXT NOT NULL DEFAULT'));
    assert.ok(ddl > 0, 'the fixture retains the requests DDL to damage');
    const ddlFault = inject(dir, bytes, ddl + 5, expected);
    assert.equal(ddlFault.outcome, 'refused_at_open', `damaged schema text must refuse at open, not be repaired over: ${ddlFault.outcome} ${ddlFault.detail}`);
    // Store wraps startup refusals in a typed, redacted message (D-139); the
    // underlying reason is the retained-schema identifier check in schema.ts.
    assert.match(ddlFault.detail, /schema text is damaged|retained database was not accepted/);

    // Stride sweep across the whole file.
    const tally: Record<Outcome, number> = { refused_at_open: 0, refused_at_read: 0, exact: 0, drift: 0 };
    const driftColumns = new Set<string>();
    let injected = 0;
    for (let offset = 7; offset < bytes.length; offset += 2503) {
      const result = inject(dir, bytes, offset, expected);
      tally[result.outcome]++;
      injected++;
      if (result.outcome === 'drift') for (const column of result.detail.split(',')) driftColumns.add(column);
    }
    assert.ok(injected >= 250, `the sweep must cover the file (${injected} faults over ${bytes.length} bytes)`);
    assert.ok(tally.refused_at_open >= 1, `no fault was refused at open — the sweep is vacuous: ${JSON.stringify(tally)}`);
    for (const column of PROVENANCE_COLUMNS) {
      assert.equal(driftColumns.has(column), false, `provenance column ${column} drifted under a byte flip instead of refusing: ${JSON.stringify(tally)}`);
    }
    // What this leaves open, stated as the number it is: a flip inside a free
    // text or REAL payload that stays a well-formed record is not seen by
    // integrity_check and request rows carry no row digest (WP-H01 remainder).
    assert.ok(tally.drift <= Math.ceil(injected * 0.02), `silent payload drift exceeded its recorded bound: ${JSON.stringify(tally)} columns ${[...driftColumns].join(',')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
