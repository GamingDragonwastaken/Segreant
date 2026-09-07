/**
 * Retention is not free and deletion is not free either. The egress receipt
 * history is the only local evidence that Fiscus can say what it sent; these
 * tests pin what Fiscus may claim once some of that evidence is gone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEgressReceipt, verifyEgressReceipts, type ReceiptInput } from '../src/egress/receipts.ts';

function input(event: ReceiptInput['event']): ReceiptInput {
  return {
    event,
    purpose: 'local_healthcheck',
    dataClass: 'healthcheck',
    method: 'GET',
    targetClass: 'loopback',
    bodyBytes: 0,
    status: 200,
    at: new Date('2026-09-07T00:00:00.000Z'),
  };
}

function withHome<T>(prefix: string, fn: (home: string) => T): T {
  const previous = process.env.FISCUS_HOME;
  const home = mkdtempSync(join(tmpdir(), prefix));
  process.env.FISCUS_HOME = home;
  try {
    return fn(home);
  } finally {
    if (previous === undefined) delete process.env.FISCUS_HOME;
    else process.env.FISCUS_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

test('deleting the receipt history while its checkpoint survives is a discontinuity, not a fresh chain', () => {
  withHome('fiscus-retention-discontinuity-', (home) => {
    appendEgressReceipt(input('preflight_allowed'));
    appendEgressReceipt(input('dial_started'));
    appendEgressReceipt(input('response_received'));

    const historyPath = join(home, 'egress-receipts.jsonl');
    const checkpointPath = join(home, 'egress-receipts.checkpoint.json');
    assert.equal(existsSync(checkpointPath), true, 'the appends published a checkpoint');
    rmSync(historyPath);

    const verified = verifyEgressReceipts();
    assert.equal(verified.ok, false, 'a chain whose evidence was deleted cannot verify as valid');
    assert.match(
      verified.errors.join(' '),
      /checkpoint/i,
      'the refusal must name the surviving evidence that contradicts the absence',
    );

    assert.throws(
      () => appendEgressReceipt(input('preflight_allowed')),
      /checkpoint/i,
      'Fiscus must not silently restart a deleted history as genesis',
    );
    assert.equal(existsSync(historyPath), false, 'the refused append writes no new genesis record');
  });
});

test('a genuinely fresh Fiscus home still establishes genesis', () => {
  withHome('fiscus-retention-genesis-', (home) => {
    const empty = verifyEgressReceipts();
    assert.equal(empty.ok, true);
    assert.equal(empty.receiptCount, 0);
    assert.deepEqual(empty.errors, []);

    const receipt = appendEgressReceipt(input('preflight_allowed'));
    assert.equal(receipt.previousHash, null, 'genesis has no predecessor');
    assert.equal(existsSync(join(home, 'egress-receipts.jsonl')), true);
    assert.equal(verifyEgressReceipts().receiptCount, 1);
  });
});

test('archiving the history together with its checkpoint is the documented operator repair', () => {
  withHome('fiscus-retention-archive-', (home) => {
    appendEgressReceipt(input('preflight_allowed'));
    appendEgressReceipt(input('dial_started'));

    // An operator who deliberately preserves/archives the audit history takes
    // the checkpoint with it. Only then is the absence genuinely an absence.
    rmSync(join(home, 'egress-receipts.jsonl'));
    rmSync(join(home, 'egress-receipts.checkpoint.json'));

    assert.equal(verifyEgressReceipts().ok, true);
    const receipt = appendEgressReceipt(input('preflight_allowed'));
    assert.equal(receipt.previousHash, null, 'the new chain declares that it extends nothing');
    assert.equal(verifyEgressReceipts().receiptCount, 1);
  });
});
