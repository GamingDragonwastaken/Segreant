import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VECTOR_PATH = join(ROOT, 'test', 'fixtures', 'fiscuspack-conformance.json');
const VERIFIER_PATH = join(ROOT, 'standalone', 'fiscuspack-verifier.mjs');

interface Vector {
  readonly name: string;
  readonly pack: unknown;
  readonly options?: Record<string, unknown>;
  readonly expected: {
    readonly ok: boolean;
    readonly integrity: string;
    readonly authenticity: string;
    readonly truth: string;
    readonly signatureStatus: string;
    readonly cryptographicVerification: string;
    readonly pinned: boolean;
    readonly attachmentStatus: string;
    readonly declaredAttachments: number;
    readonly presentAttachments: number;
    readonly errorIncludes?: readonly string[];
  };
}

const vectors = (JSON.parse(readFileSync(VECTOR_PATH, 'utf8')) as { format: string; vectors: Vector[] });

test('fixed conformance vectors are independent of the producer implementation', () => {
  assert.equal(vectors.format, 'fiscuspack-conformance-v1');
  const source = readFileSync(VERIFIER_PATH, 'utf8');
  assert.doesNotMatch(source, /(?:\.\.\/)?src[\\/](?:pack|store|producer)(?:[\\/]|\b)/i);
  assert.doesNotMatch(source, /from\s+['"](?:node_modules|\.\.\/src)/i);
});

test('standalone verifier matches every committed conformance vector', async () => {
  const verifier = await import('../standalone/fiscuspack-verifier.mjs') as {
    verifyFiscusPack: (pack: unknown, options?: Record<string, unknown>) => any;
  };
  for (const vector of vectors.vectors) {
    const result = verifier.verifyFiscusPack(vector.pack, vector.options);
    assert.equal(result.ok, vector.expected.ok, vector.name);
    assert.equal(result.integrity, vector.expected.integrity, vector.name);
    assert.equal(result.authenticity, vector.expected.authenticity, vector.name);
    assert.equal(result.truth, vector.expected.truth, vector.name);
    assert.equal(result.signature.status, vector.expected.signatureStatus, vector.name);
    assert.equal(result.signature.cryptographicVerification, vector.expected.cryptographicVerification, vector.name);
    assert.equal(result.signature.pinned, vector.expected.pinned, vector.name);
    assert.equal(result.attachments.status, vector.expected.attachmentStatus, vector.name);
    assert.equal(result.attachments.declared, vector.expected.declaredAttachments, vector.name);
    assert.equal(result.attachments.present, vector.expected.presentAttachments, vector.name);
    for (const fragment of vector.expected.errorIncludes ?? []) {
      assert.match(result.errors.join('\n'), new RegExp(fragment, 'i'), vector.name);
    }
  }
});

test('standalone verifier CLI accepts JSON on stdin and returns machine-readable evidence', () => {
  const vector = vectors.vectors.find((candidate) => candidate.name === 'valid-unsigned')!;
  const output = execFileSync(process.execPath, [VERIFIER_PATH], {
    cwd: ROOT,
    input: JSON.stringify(vector.pack),
    encoding: 'utf8',
  });
  const result = JSON.parse(output) as { ok: boolean; truth: string; integrity: string };
  assert.equal(result.ok, true);
  assert.equal(result.integrity, 'verified');
  assert.equal(result.truth, 'not_evaluated');
});

test('an embedded signature proves pack integrity but never establishes authenticity without an anchor', async () => {
  const verifier = await import('../standalone/fiscuspack-verifier.mjs') as {
    verifyFiscusPack: (pack: unknown, options?: Record<string, unknown>) => any;
  };
  const vector = vectors.vectors.find((candidate) => candidate.name === 'valid-signature-with-anchor')!;
  const result = verifier.verifyFiscusPack(vector.pack);
  assert.equal(result.ok, true);
  assert.equal(result.integrity, 'verified');
  assert.equal(result.signature.cryptographicVerification, 'verified');
  assert.equal(result.signature.pinned, false);
  assert.equal(result.authenticity, 'not_established');
  assert.equal(result.truth, 'not_evaluated');
});

test('the verifier accepts supplied UTF-8 bytes without mutating the JSON value', async () => {
  const verifier = await import('../standalone/fiscuspack-verifier.mjs') as {
    verifyFiscusPack: (pack: unknown, options?: Record<string, unknown>) => any;
  };
  const vector = vectors.vectors.find((candidate) => candidate.name === 'valid-unsigned')!;
  const before = JSON.stringify(vector.pack);
  const result = verifier.verifyFiscusPack(Buffer.from(before, 'utf8'));
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(vector.pack), before);
  const malformedUtf8 = verifier.verifyFiscusPack(Uint8Array.from([0xff, 0xfe, 0xfd]));
  assert.equal(malformedUtf8.ok, false);
  assert.match(malformedUtf8.errors.join('\n'), /UTF-8/i);
});

test('the package exposes the independent verifier as a standalone executable', () => {
  const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    bin?: Record<string, string>;
    files?: readonly string[];
  };
  assert.equal(packageJson.bin?.['fiscuspack-verify'], 'standalone/fiscuspack-verifier.mjs');
  assert.ok(packageJson.files?.includes('standalone'));
});
