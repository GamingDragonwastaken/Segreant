import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

function run(args: string[], home: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, 'egress', ...args], {
      env: { ...process.env, FISCUS_HOME: home, FISCUS_DB: join(home, 'fiscus.db'), NODE_OPTIONS: '' },
    }, (error, stdout, stderr) => {
      const code = error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
        ? (error as unknown as { code: number }).code : error ? 1 : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

const RULE = [
  '--mode', 'controlled_cloud',
  '--id', 'openai-main',
  '--purpose', 'provider_inference',
  '--data-class', 'provider_request',
  '--method', 'POST',
  '--origin', 'https://api.openai.com',
  '--path-prefix', '/v1/',
];

test('egress CLI plans without mutation and requires an explicit apply acknowledgement', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fiscus-egress-cli-'));
  try {
    const before = await run(['status', '--json'], home);
    assert.equal(before.code, 0);
    assert.equal(JSON.parse(before.stdout).mode, 'local_locked');

    const plan = await run(['plan', ...RULE, '--json'], home);
    assert.equal(plan.code, 0);
    assert.equal(JSON.parse(plan.stdout).wouldWrite, false);
    assert.equal(existsSync(join(home, 'config.json')), false);

    const noAcknowledgement = await run(['apply', ...RULE, '--json'], home);
    assert.equal(noAcknowledgement.code, 0);
    assert.equal(JSON.parse(noAcknowledgement.stdout).wouldWrite, false);
    assert.equal(existsSync(join(home, 'config.json')), false);

    const applied = await run(['apply', '--apply', ...RULE, '--json'], home);
    assert.equal(applied.code, 0);
    assert.equal(JSON.parse(applied.stdout).wouldWrite, true);
    const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
    assert.equal(config.egress.mode, 'controlled_cloud');
    assert.deepEqual(config.egress.rules.map((rule: { id: string }) => rule.id), ['openai-main']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
