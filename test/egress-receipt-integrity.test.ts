import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import type { EgressConfig } from '../src/config.ts';
import {
  appendEgressReceipt,
  EgressReceiptError,
  egressReceiptPath,
  setReceiptContentionLockLstatForTests,
  setReceiptLockReleaseHookForTests,
  setReceiptWriteHookForTests,
  verifyEgressReceipts,
  type EgressReceipt,
  type ReceiptInput,
} from '../src/egress/receipts.ts';
import { EgressError, egressFetchWithConfig } from '../src/egress/transport.ts';

const execFileAsync = promisify(execFile);
const LOCKED: EgressConfig = { mode: 'local_locked', rules: [] };
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

const INPUT: ReceiptInput = {
  event: 'preflight_allowed',
  purpose: 'local_healthcheck',
  dataClass: 'healthcheck',
  method: 'GET',
  targetClass: 'loopback',
  at: new Date('2026-08-23T00:00:00.000Z'),
};

function withHome(label: string): { home: string; restore: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'fiscus-receipt-integrity-' + label + '-'));
  const previous = process.env.FISCUS_HOME;
  process.env.FISCUS_HOME = home;
  return {
    home,
    restore: () => {
      if (previous === undefined) delete process.env.FISCUS_HOME;
      else process.env.FISCUS_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

function receiptLines(home: string): EgressReceipt[] {
  return readFileSync(join(home, 'egress-receipts.jsonl'), 'utf8')
    .trimEnd()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as EgressReceipt);
}

function rewriteReceipt(home: string, index: number, rewrite: (receipt: EgressReceipt) => EgressReceipt): void {
  const lines = receiptLines(home);
  lines[index] = rewrite(lines[index]!);
  writeFileSync(join(home, 'egress-receipts.jsonl'), lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');
}

function receiptHash(receipt: Omit<EgressReceipt, 'hash'>): string {
  return createHash('sha256').update((receipt.previousHash ?? '') + '\n' + JSON.stringify(receipt), 'utf8').digest('hex');
}

async function withDialSpy<T>(
  home: string,
  callback: (url: string, requests: () => number, connections: () => number) => Promise<T>,
): Promise<{ result: T; requestCount: number; connectionCount: number }> {
  let requestCount = 0;
  let connectionCount = 0;
  const server = http.createServer((_req, res) => {
    requestCount++;
    res.writeHead(200);
    res.end('unexpected dial');
  });
  server.on('connection', () => { connectionCount += 1; });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const result = await callback('http://127.0.0.1:' + address.port + '/health', () => requestCount, () => connectionCount);
    return { result, requestCount, connectionCount };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function assertRefusesBeforeDial(
  home: string,
  expectedMessage: RegExp,
  expectedCode: 'receipt_integrity_failed' | 'receipt_persistence_failed' = 'receipt_integrity_failed',
): Promise<void> {
  const observed = await withDialSpy(home, async (url, requests, connections) => {
    await assert.rejects(
      egressFetchWithConfig(LOCKED, url, {
        purpose: 'local_healthcheck',
        dataClass: 'healthcheck',
      }),
      (error: unknown) => {
        assert.ok(error instanceof EgressError);
        assert.equal(error.code, expectedCode);
        assert.match(error.message, expectedMessage);
        return true;
      },
    );
    assert.equal(requests(), 0);
    assert.equal(connections(), 0);
    return undefined;
  });
  assert.equal(observed.requestCount, 0);
  assert.equal(observed.connectionCount, 0);
}

function runEgressCli(args: string[], home: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, 'egress', ...args], {
      env: { ...process.env, FISCUS_HOME: home, FISCUS_DB: join(home, 'fiscus.db'), NODE_OPTIONS: '' },
    }, (error, stdout, stderr) => {
      const code = error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
        ? Number((error as unknown as { code: number }).code)
        : error ? 1 : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

test('an absent receipt history establishes exactly one genesis predecessor', () => {
  const state = withHome('genesis');
  try {
    assert.equal(existsSync(egressReceiptPath()), false);
    const receipt = appendEgressReceipt(INPUT);
    assert.equal(receipt.previousHash, null);
    assert.deepEqual(verifyEgressReceipts(), {
      ok: true,
      receiptCount: 1,
      validThroughHash: receipt.hash,
      errors: [],
    });
  } finally {
    state.restore();
  }
});

test('a valid history appends to the exact retained predecessor', () => {
  const state = withHome('continuation');
  try {
    const first = appendEgressReceipt(INPUT);
    const second = appendEgressReceipt({ ...INPUT, event: 'dial_started' });
    assert.equal(second.previousHash, first.hash);
    assert.equal(verifyEgressReceipts().ok, true);
    assert.equal(verifyEgressReceipts().validThroughHash, second.hash);
  } finally {
    state.restore();
  }
});

test('a valid retained history permits the next transport request', async () => {
  const state = withHome('valid-transport');
  try {
    const prior = appendEgressReceipt(INPUT);
    const observed = await withDialSpy(state.home, async (url) => {
      const response = await egressFetchWithConfig(LOCKED, url, {
        purpose: 'local_healthcheck',
        dataClass: 'healthcheck',
      });
      assert.equal(response.status, 200);
      return response;
    });
    assert.equal(observed.requestCount, 1);
    assert.equal(observed.connectionCount, 1);
    const lines = receiptLines(state.home);
    assert.equal(lines[1]!.previousHash, prior.hash);
    assert.equal(verifyEgressReceipts().ok, true);
  } finally {
    state.restore();
  }
});

test('a malformed final line refuses before any dial and cannot restart genesis', async () => {
  const state = withHome('malformed-tail');
  try {
    appendEgressReceipt(INPUT);
    const original = readFileSync(egressReceiptPath(), 'utf8') + '{"version":1';
    writeFileSync(egressReceiptPath(), original, 'utf8');
    await assertRefusesBeforeDial(state.home, /line 2.*valid receipt JSON/i);
    assert.equal(readFileSync(egressReceiptPath(), 'utf8'), original);
    assert.equal(verifyEgressReceipts().ok, false);
  } finally {
    state.restore();
  }
});

test('a truncated JSON tail refuses before any dial', async () => {
  const state = withHome('truncated-tail');
  try {
    appendEgressReceipt(INPUT);
    appendFileSync(egressReceiptPath(), '{"version":1,"id":"truncated"', 'utf8');
    await assertRefusesBeforeDial(state.home, /line 2.*valid receipt JSON/i);
  } finally {
    state.restore();
  }
});

test('a valid final record without a terminating newline refuses before any dial', async () => {
  const state = withHome('missing-newline');
  try {
    appendEgressReceipt(INPUT);
    const truncated = readFileSync(egressReceiptPath(), 'utf8').replace(/\n$/, '');
    writeFileSync(egressReceiptPath(), truncated, 'utf8');
    await assertRefusesBeforeDial(state.home, /not terminated by a newline/i);
    assert.equal(verifyEgressReceipts().ok, false);
  } finally {
    state.restore();
  }
});

test('an empty present receipt file refuses before any dial and never becomes genesis', async () => {
  const state = withHome('empty');
  try {
    writeFileSync(egressReceiptPath(), '', 'utf8');
    await assertRefusesBeforeDial(state.home, /empty receipt history/i);
    assert.equal(readFileSync(egressReceiptPath(), 'utf8'), '');
  } finally {
    state.restore();
  }
});

test('a hash-invalid tail refuses before any dial', async () => {
  const state = withHome('hash-invalid');
  try {
    const first = appendEgressReceipt(INPUT);
    rewriteReceipt(state.home, 0, (receipt) => ({ ...receipt, hash: '0'.repeat(64) }));
    await assertRefusesBeforeDial(state.home, /line 1.*receipt hash does not match/i);
    assert.equal(readFileSync(egressReceiptPath(), 'utf8').includes(first.hash), false);
  } finally {
    state.restore();
  }
});

test('a broken predecessor link refuses before any dial', async () => {
  const state = withHome('predecessor');
  try {
    appendEgressReceipt(INPUT);
    appendEgressReceipt({ ...INPUT, event: 'dial_started' });
    rewriteReceipt(state.home, 1, (receipt) => {
      const base = { ...receipt, previousHash: null };
      return { ...base, hash: receiptHash(base) };
    });
    await assertRefusesBeforeDial(state.home, /line 2.*previous-hash link does not match/i);
  } finally {
    state.restore();
  }
});

test('a schema-invalid receipt refuses before any dial', async () => {
  const state = withHome('schema-invalid');
  try {
    const receipt = appendEgressReceipt(INPUT);
    rewriteReceipt(state.home, 0, (current) => ({ ...current, bodyBytes: -1 }));
    await assertRefusesBeforeDial(state.home, /line 1.*bodyBytes/i);
    assert.equal(readFileSync(egressReceiptPath(), 'utf8').includes(receipt.hash), true);
  } finally {
    state.restore();
  }
});

test('receipt lock/open failure refuses before any dial', async () => {
  const state = withHome('lock-open-failure');
  try {
    rmSync(state.home, { recursive: true, force: true });
    writeFileSync(state.home, 'the configured Fiscus home is not a directory', 'utf8');
    await assertRefusesBeforeDial(state.home, /receipt (?:lock|persistence)/i, 'receipt_persistence_failed');
  } finally {
    state.restore();
  }
});

test('a non-file receipt lock path refuses before any dial', async () => {
  const state = withHome('lock-path-obstruction');
  try {
    mkdirSync(join(state.home, 'egress-receipts.lock'));
    assert.throws(
      () => appendEgressReceipt(INPUT),
      (error: unknown) => error instanceof EgressReceiptError && error.code === 'lock' && /lock path is not a regular file/i.test(error.message),
    );
    await assertRefusesBeforeDial(state.home, /receipt persistence/i, 'receipt_persistence_failed');
  } finally {
    state.restore();
  }
});

test('unreadable present receipt history refuses before any dial', async () => {
  const state = withHome('unreadable');
  try {
    rmSync(egressReceiptPath(), { force: true });
    // A directory at the receipt path deterministically makes readFileSync fail
    // on Windows and POSIX without relying on administrator-only permissions.
    mkdirSync(egressReceiptPath());
    await assertRefusesBeforeDial(state.home, /read receipt history|receipt persistence/i, 'receipt_persistence_failed');
  } finally {
    state.restore();
  }
});

test('a receipt path replaced after validation refuses before any dial and never appends to the replacement', async () => {
  const state = withHome('identity-race');
  try {
    appendEgressReceipt(INPUT);
    const replacementInput = { ...INPUT } as ReceiptInput;
    Object.defineProperty(replacementInput, 'event', {
      enumerable: true,
      get: () => {
        rmSync(egressReceiptPath(), { force: true });
        writeFileSync(egressReceiptPath(), '', 'utf8');
        return 'dial_started';
      },
    });
    assert.throws(
      () => appendEgressReceipt(replacementInput),
      (error: unknown) => error instanceof EgressReceiptError && error.code === 'persistence' && /changed before append/i.test(error.message),
    );
    assert.equal(readFileSync(egressReceiptPath(), 'utf8'), '');
    await assertRefusesBeforeDial(state.home, /empty receipt history/i);
  } finally {
    state.restore();
  }
});

test('an absent-path creation race refuses rather than creating a null-predecessor genesis', async () => {
  const state = withHome('genesis-race');
  try {
    const racingInput = { ...INPUT } as ReceiptInput;
    Object.defineProperty(racingInput, 'event', {
      enumerable: true,
      get: () => {
        writeFileSync(egressReceiptPath(), '', 'utf8');
        return 'preflight_allowed';
      },
    });
    assert.throws(
      () => appendEgressReceipt(racingInput),
      (error: unknown) => error instanceof EgressReceiptError && error.code === 'persistence' && /appeared after absence/i.test(error.message),
    );
    assert.equal(readFileSync(egressReceiptPath(), 'utf8'), '');
    await assertRefusesBeforeDial(state.home, /empty receipt history/i);
  } finally {
    state.restore();
  }
});

test('a receipt-lock release failure remains a zero-dial refusal and leaves the lock for operator repair', async () => {
  const state = withHome('release-failure');
  try {
    const lockPath = join(state.home, 'egress-receipts.lock');
    const replacingInput = { ...INPUT } as ReceiptInput;
    let replaced = false;
    Object.defineProperty(replacingInput, 'event', {
      enumerable: true,
      get: () => {
        if (!replaced) {
          replaced = true;
          rmSync(lockPath, { force: true });
          mkdirSync(lockPath);
        }
        return 'preflight_allowed';
      },
    });
    assert.throws(
      () => appendEgressReceipt(replacingInput),
      (error: unknown) => error instanceof EgressReceiptError && error.code === 'lock' && /releasing the lock/i.test(error.message),
    );
    assert.equal(existsSync(lockPath), true);
    await assertRefusesBeforeDial(state.home, /receipt persistence/i, 'receipt_persistence_failed');
  } finally {
    state.restore();
  }
});

test('transport refuses before socket creation when pre-dial lock release fails', async () => {
  const state = withHome('transport-release-failure');
  const lockPath = join(state.home, 'egress-receipts.lock');
  const restoreHook = setReceiptLockReleaseHookForTests(() => {
    rmSync(lockPath, { force: true });
    mkdirSync(lockPath);
  });
  try {
    await assertRefusesBeforeDial(state.home, /receipt persistence/i, 'receipt_persistence_failed');
  } finally {
    restoreHook();
    state.restore();
  }
});

test('a present receipt path replaced after the write is refused before any dial', async () => {
  const state = withHome('post-write-identity-race');
  let replaced = false;
  let restoreHook: () => void = () => undefined;
  const installHook = () => setReceiptWriteHookForTests(() => {
    if (replaced) return;
    replaced = true;
    rmSync(egressReceiptPath(), { force: true });
    writeFileSync(egressReceiptPath(), '', 'utf8');
  });
  try {
    appendEgressReceipt(INPUT);
    restoreHook = installHook();
    assert.throws(
      () => appendEgressReceipt({ ...INPUT, event: 'dial_started' }),
      (error: unknown) => error instanceof EgressReceiptError
        && error.code === 'persistence'
        && /changed after append|path identity/i.test(error.message),
    );
    await assertRefusesBeforeDial(state.home, /empty receipt history/i);
  } finally {
    restoreHook();
    state.restore();
  }
});

test('a replacement lock pathname is never unlinked during release', () => {
  const state = withHome('lock-path-replacement');
  const lockPath = join(state.home, 'egress-receipts.lock');
  const restoreHook = setReceiptLockReleaseHookForTests(() => {
    rmSync(lockPath, { force: true });
    writeFileSync(lockPath, 'replacement lock owned by another process', 'utf8');
  });
  try {
    assert.throws(
      () => appendEgressReceipt(INPUT),
      (error: unknown) => error instanceof EgressReceiptError
        && error.code === 'lock'
        && /changed|replacement|releasing/i.test(error.message),
    );
    assert.equal(readFileSync(lockPath, 'utf8'), 'replacement lock owned by another process');
  } finally {
    restoreHook();
    state.restore();
  }
});

test('a lock generation absent during contention inspection is retried even when a regular generation appears afterward', async () => {
  const state = withHome('lock-generation-race');
  const lockPath = join(state.home, 'egress-receipts.lock');
  const first = appendEgressReceipt(INPUT);
  writeFileSync(lockPath, 'initial valid lock generation', 'utf8');
  let inspectionCalls = 0;
  let releaser: Worker | undefined;
  const restoreHook = setReceiptContentionLockLstatForTests((path) => {
    inspectionCalls++;
    assert.equal(path, lockPath);
    assert.equal(readFileSync(path, 'utf8'), 'initial valid lock generation');
    rmSync(path, { force: true });
    let absentError: unknown;
    try {
      lstatSync(path);
    } catch (error) {
      absentError = error;
    }
    assert.equal(
      absentError && typeof absentError === 'object' && 'code' in absentError ? absentError.code : undefined,
      'ENOENT',
    );
    writeFileSync(path, 'recreated valid lock generation', 'utf8');
    releaser = new Worker(`
      const { workerData } = require('node:worker_threads');
      const { rmSync } = require('node:fs');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
      rmSync(workerData.path, { force: true });
    `, { eval: true, workerData: { path } });
    throw absentError;
  });
  try {
    const second = appendEgressReceipt({ ...INPUT, event: 'dial_started' });
    assert.equal(inspectionCalls, 1);
    assert.equal(existsSync(lockPath), false);
    const verification = verifyEgressReceipts();
    assert.equal(verification.ok, true);
    assert.equal(verification.receiptCount, 2);
    const lines = receiptLines(state.home);
    assert.equal(lines.length, 2);
    assert.equal(lines.filter((line) => line.previousHash === null).length, 1);
    assert.equal(lines[0]!.hash, first.hash);
    assert.equal(lines[1]!.hash, second.hash);
    assert.equal(lines[1]!.previousHash, first.hash);
  } finally {
    restoreHook();
    if (releaser !== undefined) await releaser.terminate();
    state.restore();
  }
});

test('a stale regular receipt lock refuses within the bounded timeout and is never auto-deleted', () => {
  const state = withHome('stale-lock');
  try {
    const lockPath = join(state.home, 'egress-receipts.lock');
    writeFileSync(lockPath, 'stale lock owner', 'utf8');
    const startedAt = performance.now();
    assert.throws(
      () => appendEgressReceipt(INPUT),
      (error: unknown) => error instanceof EgressReceiptError && error.code === 'lock' && /lock remained busy/i.test(error.message),
    );
    const elapsedMs = performance.now() - startedAt;
    assert.ok(elapsedMs < 15_000, `the intended ten-second lock bound took ${elapsedMs.toFixed(3)} ms`);
    assert.equal(readFileSync(lockPath, 'utf8'), 'stale lock owner');
  } finally {
    state.restore();
  }
});

test('a symlink receipt path is not treated as absent genesis when the OS permits symlink fixtures', async (t) => {
  const state = withHome('symlink');
  try {
    try {
      symlinkSync(join(state.home, 'does-not-exist.jsonl'), egressReceiptPath(), 'file');
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (code === 'EPERM' || code === 'EACCES') {
        t.skip('Windows symlink creation is unavailable without the required privilege; regular-directory and identity-race fixtures cover the same fail-closed boundary');
        return;
      }
      throw error;
    }
    await assertRefusesBeforeDial(state.home, /symbolic link|receipt persistence/i, 'receipt_persistence_failed');
  } finally {
    state.restore();
  }
});

test('egress verify CLI reports the corruption reason and repair action', async () => {
  const state = withHome('cli-invalid');
  try {
    writeFileSync(egressReceiptPath(), '{"version":1}\n', 'utf8');
    const result = await runEgressCli(['verify', '--json'], state.home);
    assert.equal(result.code, 1);
    const payload = JSON.parse(result.stdout) as { ok: boolean; errors: string[]; action?: string };
    assert.equal(payload.ok, false);
    assert.match(payload.errors.join('\n'), /version must be 1|id must be/i);
    assert.equal(payload.action, 'preserve and repair/restore the present receipt history before retrying; if the lock is stale, confirm no Fiscus writer is active, then remove only that lock and rerun verify; Fiscus will not restart history as genesis.');
  } finally {
    state.restore();
  }
});

test('multiple valid writer processes serialize without forking or resetting the chain', async () => {
  const state = withHome('concurrent');
  try {
    const moduleUrl = new URL('../src/egress/receipts.ts', import.meta.url).href;
    const workerInput = { ...INPUT, at: undefined };
    const script = `import { appendEgressReceipt } from ${JSON.stringify(moduleUrl)}; appendEgressReceipt(${JSON.stringify(workerInput)});`;
    const workers = Array.from({ length: 6 }, () => execFileAsync(process.execPath, [
      '--disable-warning=ExperimentalWarning',
      '--input-type=module',
      '-e',
      script,
    ], {
      cwd: join(import.meta.dirname, '..'),
      env: { ...process.env, FISCUS_HOME: state.home },
    }));
    await Promise.all(workers);
    const verification = verifyEgressReceipts();
    assert.equal(verification.ok, true);
    const lines = receiptLines(state.home);
    assert.equal(lines.length, 6);
    assert.equal(lines.filter((line) => line.previousHash === null).length, 1);
    for (let index = 1; index < lines.length; index++) {
      assert.equal(lines[index]!.previousHash, lines[index - 1]!.hash);
    }
  } finally {
    state.restore();
  }
});
