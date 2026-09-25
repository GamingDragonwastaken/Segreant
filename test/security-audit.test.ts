import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditSecurityTree } from '../scripts/check-security.mjs';

test('security audit rejects production secrets and dynamic string execution without scanning fixtures as authority', () => {
  const root = mkdtempSync(join(tmpdir(), 'segreant-security-audit-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'test'), { recursive: true });
    writeFileSync(join(root, 'src', 'safe.ts'), "export const ok = 1;\n");
    writeFileSync(join(root, 'test', 'fixture.ts'), "const fake = 'sk-ant-test-fixture-not-a-secret';\n");
    assert.deepEqual(auditSecurityTree(root).violations, []);

    writeFileSync(join(root, 'src', 'secret.ts'), "export const token = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';\n");
    const secret = auditSecurityTree(root);
    assert.ok(secret.filesScanned >= 2);
    assert.ok(secret.violations.some((v) => v.rule === 'credential-pattern' && v.path.endsWith('secret.ts')));

    rmSync(join(root, 'src', 'secret.ts'));
    writeFileSync(join(root, 'src', 'dynamic.ts'), "export const run = (x) => eval(x);\n");
    const dynamic = auditSecurityTree(root);
    assert.ok(dynamic.violations.some((v) => v.rule === 'dynamic-string-code' && v.path.endsWith('dynamic.ts')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('security audit is non-vacuous on the real repository production corpus', () => {
  const result = auditSecurityTree(join(import.meta.dirname, '..'));
  assert.ok(result.filesScanned > 100, `expected a substantial production corpus, scanned ${result.filesScanned}`);
  assert.deepEqual(result.violations, [], result.violations.map((v) => `${v.rule}: ${v.path}:${v.line}`).join('\n'));
});
