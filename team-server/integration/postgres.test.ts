import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { PgRollupStore } from '../src/store.ts';
import { keyIdForPem, type KeyPair } from '../../src/value/receipt.ts';
import { signRollup, type RollupBodyV1 } from '../../src/team/rollup.ts';

const { Pool } = pg;

function keyPair(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return { privateKey, publicKey, publicPem, keyId: keyIdForPem(publicPem) };
}

function body(keys: KeyPair, project: string): RollupBodyV1 {
  return {
    v: 1,
    keyId: keys.keyId,
    generatedAt: '2026-09-22T00:00:00.000Z',
    period: { from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z' },
    coverage: 'complete',
    scope: { kind: 'all-projects' },
    projects: [{
      project,
      units: 2,
      costUsd: 1.25,
      realizationRate: 0.5,
      spendOnRealizedUnitsUsd: 0.625,
      acceptanceWeightedSpendUsd: 0.5,
      roiIndex: 60,
      sources: ['postgres-integration'],
    }],
  };
}

test('real PostgreSQL adapter preserves signed rollups, replay identity, restart state, aggregation, and rollback', { timeout: 30_000 }, async () => {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, 'DATABASE_URL is required; run only against a disposable PostgreSQL database');

  const suffix = randomUUID().replaceAll('-', '');
  const project = `postgres-integration-${suffix}`;
  const rejectedProject = `postgres-reject-${suffix}`;
  const constraint = `fiscus_integration_reject_${suffix}`;
  const keys = keyPair();
  const signed = signRollup(body(keys, project), keys);
  const admin = new Pool({ connectionString: databaseUrl });
  let store: PgRollupStore | null = new PgRollupStore(databaseUrl);

  try {
    const schema = readFileSync(join(import.meta.dirname, '..', 'schema.sql'), 'utf8');
    await store.applySchema(schema);
    await store.registerDeveloper(keys.keyId, keys.publicPem, 'Postgres integration probe');

    const developer = await store.findDeveloper(keys.keyId);
    assert.equal(developer?.keyId, keys.keyId);

    const first = await store.insertRollup(signed);
    const retry = await store.insertRollup(signed);
    assert.equal(first.replayed, false);
    assert.equal(retry.replayed, true);
    assert.equal(retry.rollup.id, first.rollup.id);
    assert.equal(retry.rollup.receivedAt, first.rollup.receivedAt);

    await store.close();
    store = new PgRollupStore(databaseUrl);

    const replayed = await store.listRollups({ keyId: keys.keyId, limit: 10 });
    assert.ok(replayed.some((row) => row.id === first.rollup.id), 'rollup must survive a store restart');
    const totals = await store.aggregateProjects();
    const aggregate = totals.find((row) => row.project === project);
    assert.ok(aggregate, 'the persisted project must reach the real SQL aggregate');
    assert.equal(aggregate.developerCount, 1);
    assert.equal(aggregate.totalUnits, 2);
    assert.equal(aggregate.totalCostUsd, 1.25);

    // Force the child insert to fail after the parent rollup INSERT. PgRollupStore
    // must roll the whole transaction back: a parent without its project rows is
    // not an acceptable partial receipt.
    await admin.query(
      `ALTER TABLE rollup_projects ADD CONSTRAINT "${constraint}" CHECK (project <> '${rejectedProject}')`,
    );
    const rejected = signRollup(body(keys, rejectedProject), keys);
    await assert.rejects(() => store!.insertRollup(rejected), /check constraint|violates/i);
    const parent = await admin.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM rollups WHERE key_id = $1 AND body_hash = $2',
      [keys.keyId, rejected.bodyHash],
    );
    assert.equal(Number(parent.rows[0]?.count ?? -1), 0, 'failed child insert must not leave a parent rollup');
  } finally {
    if (store !== null) await store.close().catch(() => undefined);
    await admin.query(`ALTER TABLE rollup_projects DROP CONSTRAINT IF EXISTS "${constraint}"`).catch(() => undefined);
    await admin.query('DELETE FROM rollups WHERE key_id = $1', [keys.keyId]).catch(() => undefined);
    await admin.query('DELETE FROM developers WHERE key_id = $1', [keys.keyId]).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
});
