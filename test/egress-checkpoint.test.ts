import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendEgressReceipt, egressReceiptPath, verifyEgressReceipts, type ReceiptInput } from '../src/egress/receipts.ts';

function input(event: ReceiptInput['event']): ReceiptInput {
  return {
    event,
    purpose: 'local_healthcheck',
    dataClass: 'healthcheck',
    method: 'GET',
    targetClass: 'loopback',
    bodyBytes: 0,
    status: 200,
    at: new Date('2026-08-28T00:00:00.000Z'),
  };
}

test('valid receipt appends persist a redacted checkpoint for the next O(1) append', () => {
  const previousHome = process.env.FISCUS_HOME;
  const home = mkdtempSync(join(tmpdir(), 'fiscus-egress-checkpoint-'));
  process.env.FISCUS_HOME = home;
  try {
    appendEgressReceipt(input('preflight_allowed'));
    appendEgressReceipt(input('dial_started'));
    const checkpointPath = join(home, 'egress-receipts.checkpoint.json');
    assert.equal(existsSync(checkpointPath), true);
    const checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8')) as Record<string, unknown>;
    assert.equal(checkpoint.receiptCount, 2);
    assert.equal(typeof checkpoint.validThroughHash, 'string');
    assert.equal(typeof checkpoint.checkpointHash, 'string');
    assert.deepEqual(Object.keys(checkpoint).sort(), [
      'checkpointHash', 'fileIdentity', 'receiptCount', 'validThroughHash', 'version',
    ]);
    assert.equal(verifyEgressReceipts().ok, true);
  } finally {
    if (previousHome === undefined) delete process.env.FISCUS_HOME;
    else process.env.FISCUS_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('a malformed checkpoint is overwritten after a verified append', () => {
  const previousHome = process.env.FISCUS_HOME;
  const home = mkdtempSync(join(tmpdir(), 'fiscus-egress-checkpoint-repair-'));
  process.env.FISCUS_HOME = home;
  try {
    appendEgressReceipt(input('preflight_allowed'));
    const checkpointPath = join(home, 'egress-receipts.checkpoint.json');
    writeFileSync(checkpointPath, '{"version":1,"receiptCount":999}\n', 'utf8');
    appendEgressReceipt(input('dial_started'));
    const checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8')) as { receiptCount?: number };
    assert.equal(checkpoint.receiptCount, 2);
    assert.equal(verifyEgressReceipts(egressReceiptPath()).receiptCount, 2);
  } finally {
    if (previousHome === undefined) delete process.env.FISCUS_HOME;
    else process.env.FISCUS_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('receipt verification does not materialize the complete JSONL history as an array', () => {
  const sourcePath = fileURLToPath(new URL('../src/egress/receipts.ts', import.meta.url));
  const source = readFileSync(sourcePath, 'utf8');
  assert.equal(source.includes('const lines = text.split'), false, 'verification must stream lines instead of splitting the full log');
  assert.equal(source.includes('const records: Array<EgressReceipt | null>'), false, 'verification must not retain every parsed receipt in memory');
});

test('malformed receipt history reports a bounded error summary', () => {
  const previousHome = process.env.FISCUS_HOME;
  const home = mkdtempSync(join(tmpdir(), 'fiscus-egress-error-bound-'));
  process.env.FISCUS_HOME = home;
  try {
    writeFileSync(egressReceiptPath(), Array.from({ length: 500 }, () => '{"bad":true}\n').join(''), 'utf8');
    const verified = verifyEgressReceipts();
    assert.equal(verified.ok, false);
    assert.equal(verified.errors.length <= 65, true, 'error diagnostics must remain bounded');
    assert.equal(verified.errors.some((error) => /additional|omitted/i.test(error)), true);
  } finally {
    if (previousHome === undefined) delete process.env.FISCUS_HOME;
    else process.env.FISCUS_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('a forged self-hashed checkpoint never authorizes a fresh-process append', async () => {
  const previousHome = process.env.FISCUS_HOME;
  const home = mkdtempSync(join(tmpdir(), 'fiscus-egress-forged-checkpoint-'));
  process.env.FISCUS_HOME = home;
  try {
    appendEgressReceipt(input('preflight_allowed'));
    const receiptPath = egressReceiptPath();
    const checkpointPath = join(home, 'egress-receipts.checkpoint.json');
    const checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8')) as Record<string, unknown>;
    checkpoint.validThroughHash = '0'.repeat(64);
    const { checkpointHash: _ignored, ...base } = checkpoint;
    checkpoint.checkpointHash = createHash('sha256').update(JSON.stringify(base), 'utf8').digest('hex');
    writeFileSync(checkpointPath, JSON.stringify(checkpoint) + '\n', 'utf8');
    const before = JSON.parse(readFileSync(receiptPath, 'utf8').trim()) as { hash: string };
    const fresh = await import(`../src/egress/receipts.ts?fresh=${Date.now()}-${Math.random()}`);
    fresh.appendEgressReceipt(input('dial_started'));
    const lines = readFileSync(receiptPath, 'utf8').trim().split(/\r?\n/);
    const after = JSON.parse(lines.at(-1)!) as { previousHash: string };
    assert.equal(after.previousHash, before.hash, 'append must derive from a freshly verified chain, not checkpoint text');
  } finally {
    if (previousHome === undefined) delete process.env.FISCUS_HOME;
    else process.env.FISCUS_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});
