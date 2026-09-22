/**
 * What a valid receipt chain establishes, and what it was being read as.
 *
 * THE COUNTEREXAMPLE. On a machine that has never sent anything, and on a
 * machine whose receipts were never written at all, `fiscus egress verify`
 * printed, in green:
 *
 *   Receipt chain valid
 *   Receipts: 0
 *
 * and exited 0. An operator asking the only question this command exists to
 * answer — did anything leave this machine, and is there a record of it — reads
 * a green "valid" and stops. What the check actually performed was a hash-chain
 * verification over the receipts that are present, which over an empty set is
 * vacuous. Zero receipts is the absence of a record, and the absence of a record
 * is not a finding about what happened.
 *
 * THIS IS THE SAME DEFECT CLASS AS D-140, D-141 AND D-144, one subsystem over: a
 * detector that stayed quiet, rendered as a result. It is also the exact shape
 * AII-002 names — a negative claim inferred from missing observations with no
 * positive evidence that the source could have seen the thing.
 *
 * WHAT FISCUS CAN HONESTLY SAY HERE IS MORE THAN NOTHING, and that is why this
 * is a repair rather than a deletion. Every declared egress path in this
 * repository goes through one chokepoint — `egressFetch` in
 * `src/egress/transport.ts` — and that chokepoint appends a receipt before it
 * forwards, refusing the request if the append fails. So a non-empty chain does
 * carry a real coverage claim over the window it spans, and the instrumentation
 * premise behind that claim is itself checkable: it holds only while no module
 * outside `src/egress/` reaches the network directly. Both halves are asserted
 * below, because a coverage claim resting on an unchecked premise is the thing
 * this file exists to prevent.
 *
 * Recorded at D-148.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendEgressReceipt,
  verifyEgressReceipts,
  type ReceiptInput,
} from '../src/egress/receipts.ts';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function input(at: string): ReceiptInput {
  return {
    event: 'preflight_allowed',
    purpose: 'local_healthcheck',
    dataClass: 'healthcheck',
    method: 'GET',
    targetClass: 'loopback',
    bodyBytes: 0,
    status: 200,
    at: new Date(at),
  };
}

function withHome<T>(fn: (home: string) => T): T {
  const previous = process.env.FISCUS_HOME;
  const home = mkdtempSync(join(tmpdir(), 'fiscus-receipt-coverage-'));
  process.env.FISCUS_HOME = home;
  try {
    return fn(home);
  } finally {
    if (previous === undefined) delete process.env.FISCUS_HOME;
    else process.env.FISCUS_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

test('an empty receipt history is unknown, and is never reported as a verified chain', () => {
  withHome(() => {
    const verified = verifyEgressReceipts();
    assert.equal(verified.receiptCount, 0);
    assert.equal(
      verified.state,
      'unknown',
      'no record exists, so nothing about outbound traffic is supported or refuted',
    );
    assert.equal(verified.basis, 'no_record');
  });
});

test('a chain that verifies over real receipts is supported, and says over what window', () => {
  withHome(() => {
    appendEgressReceipt(input('2026-09-07T01:00:00.000Z'));
    appendEgressReceipt(input('2026-09-07T02:00:00.000Z'));
    const verified = verifyEgressReceipts();
    assert.equal(verified.ok, true);
    assert.equal(verified.receiptCount, 2);
    assert.equal(verified.state, 'supported');
    assert.equal(verified.basis, 'chain_intact');
    assert.equal(verified.coveredFrom, '2026-09-07T01:00:00.000Z');
    assert.equal(verified.coveredThrough, '2026-09-07T02:00:00.000Z');
  });
});

test('a window is never reported for a chain that establishes nothing', () => {
  // A `coveredFrom` on an empty chain would be a period the operator could read
  // as audited. There is no such period.
  withHome(() => {
    const verified = verifyEgressReceipts();
    assert.equal(verified.coveredFrom, null);
    assert.equal(verified.coveredThrough, null);
  });
});

test('a broken chain is refuted, not merely not-ok', () => {
  withHome((home) => {
    appendEgressReceipt(input('2026-09-07T01:00:00.000Z'));
    const path = join(home, 'egress-receipts.jsonl');
    const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.length > 0);
    const record = JSON.parse(lines[0]!) as Record<string, unknown>;
    record.bodyBytes = 999_999;
    writeFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
    const verified = verifyEgressReceipts();
    assert.equal(verified.ok, false);
    assert.equal(verified.state, 'refuted');
    assert.equal(verified.basis, 'chain_broken');
  });
});

test('every verification states what it establishes and what it does not', () => {
  // The limit belongs in the same place as the result, not in a document the
  // operator would have to already suspect something to go and read.
  withHome(() => {
    const empty = verifyEgressReceipts();
    assert.match(empty.doesNotEstablish, /\S/);
    assert.match(
      empty.establishes + ' ' + empty.doesNotEstablish,
      /no record|nothing/i,
      'an empty chain must say plainly that no record exists',
    );

    appendEgressReceipt(input('2026-09-07T01:00:00.000Z'));
    const filled = verifyEgressReceipts();
    assert.match(
      filled.doesNotEstablish,
      /receipt/i,
      'a verified chain must say that a call which appended no receipt leaves no trace here',
    );
  });
});

test('the coverage claim rests on a premise this suite checks, not on an assumption', () => {
  // A non-empty chain covers its window only because ONE chokepoint appends
  // before it forwards. The moment a module outside `src/egress/` reaches the
  // network directly, that premise is false and the coverage claim silently
  // becomes an overclaim — with nothing failing. So the premise is asserted.
  const offenders: string[] = [];
  for (const entry of readdirSync(SRC, { recursive: true, encoding: 'utf8' })) {
    if (!entry.endsWith('.ts')) continue;
    const path = join(SRC, entry);
    // `src/egress/` is the chokepoint itself; the browser app talks only to the
    // local dashboard over same-origin `fetch` and never leaves the machine.
    if (entry.startsWith('egress') || entry.includes(join('web', 'app'))) continue;
    const source = readFileSync(path, 'utf8');
    if (/(^|[^.\w])fetch\s*\(/.test(source) || /\bhttps?\.request\s*\(/.test(source)) {
      offenders.push(entry);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'a module outside src/egress/ reaches the network directly, so the receipt chain does not cover it',
  );
});

test('the verify surface no longer prints a green verdict for an empty chain', () => {
  // The counterexample was CLI output, so the repair has to be pinned at the CLI
  // and not only at the type that feeds it.
  const source = readFileSync(join(SRC, 'cli', 'egressCmd.ts'), 'utf8');
  assert.doesNotMatch(
    source,
    /'\s*Receipt chain '\s*\+\s*\(payload\.ok/,
    'the headline may not be a boolean rendering of chain integrity',
  );
  assert.match(source, /chainHeadline/, 'the headline is chosen from the basis');
  assert.match(source, /establishes/, 'and the result carries what it establishes');
  assert.match(source, /doesNotEstablish/, 'and what it does not, on the same screen');
});

test('green is reserved for the one basis that earns it', () => {
  const source = readFileSync(join(SRC, 'cli', 'egressCmd.ts'), 'utf8');
  const tone = source.slice(source.indexOf('function chainTone'));
  const body = tone.slice(0, tone.indexOf('\n}'));
  assert.match(body, /state === 'supported'\) return C\.green/, 'only a supported chain is green');
  assert.match(body, /C\.yellow/, 'and an unknown one is not dressed as a fault either');
});

test('the diagnostics line does not report OK over zero receipts', () => {
  // `Egress OK (0 receipt(s))` is the same overclaim one surface over. Finding
  // one instance of this class and repairing only that instance is how it kept
  // coming back.
  const source = readFileSync(join(SRC, 'cli', 'diagnosticsCmd.ts'), 'utf8');
  assert.doesNotMatch(source, /bundle\.egress\.status\.toUpperCase\(\)/);
  assert.match(source, /EGRESS_BASIS_LABEL\[bundle\.egress\.basis\]/);
});
