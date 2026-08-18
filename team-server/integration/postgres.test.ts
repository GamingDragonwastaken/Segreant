import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { PgRollupStore } from '../src/store.ts';

function signedRollup(keyId: string, privateKey: any) {
  const body = {
    schemaVersion: 1, generatedAt: new Date().toISOString(),
    period: { from: '2026-08-01T00:00:00.000Z', to: '2026-08-02T00:00:00.000Z' },
    projects: [{ project: 'ci-real-pg', units: 2, costUsd: 1.25, realizationRate: 0.5, realizedValueUsd: 2, netRealizedValueUsd: 1.5, roiIndex: 60, sources: ['ci'] }],
  };
  const canonical = JSON.stringify(body);
  const bodyHash = createHash('sha256').update(canonical).digest('hex');
  const signature = sign(null, Buffer.from(canonical), privateKey).toString('base64');
  return { keyId, bodyHash, signature, body } as any;
}

test('PgRollupStore persists and replays an exact signed envelope transactionally', async () => {
  const url = process.env.DATABASE_URL;
  assert.ok(url, 'DATABASE_URL required for PostgreSQL integration test');
  const store = new PgRollupStore(url);
  try {
    const schema = readFileSync(join(import.meta.dirname, '..', 'schema.sql'), 'utf8');
    await store.applySchema(schema);
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const keyId = createHash('sha256').update(pub).digest('hex').slice(0, 16);
    await store.registerDeveloper(keyId, pub, 'CI developer');
    assert.equal((await store.findDeveloper(keyId))?.keyId, keyId);
    const envelope = signedRollup(keyId, privateKey);
    const first = await store.insertRollup(envelope);
    const retry = await store.insertRollup(envelope);
    assert.equal(first.replayed, false);
    assert.equal(retry.replayed, true);
    assert.equal(retry.rollup.id, first.rollup.id);
    const projects = await store.aggregateProjects();
    const row = projects.find((x) => x.project === 'ci-real-pg');
    assert.ok(row);
    assert.equal(row!.developerCount, 1);
    assert.equal(row!.totalUnits, 2);
  } finally { await store.close(); }
});
