import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function rejectedDeepImport(specifier: string): void {
  assert.throws(
    () => import.meta.resolve(specifier),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as NodeJS.ErrnoException).code, 'ERR_PACKAGE_PATH_NOT_EXPORTED');
      return true;
    },
  );
}

test('causal package boundary preserves the command and rejects internal deep imports', () => {
  rejectedDeepImport('fiscus');
  rejectedDeepImport('fiscus/src/causal/assignment.ts');
  rejectedDeepImport('fiscus/src/store/causalInternal.ts');
  rejectedDeepImport('fiscus/test/support/causalDeterministicRng.ts');

  const command = spawnSync(process.execPath, [
    '--disable-warning=ExperimentalWarning',
    'bin/fiscus.mjs',
    '--help',
  ], { encoding: 'utf8' });
  assert.equal(command.status, 0, command.stderr);
  assert.match(command.stdout, /Usage:\s+fiscus/i);
});

test('clean production artifact physically omits every causal deterministic and fault-injection module', async () => {
  const internalArtifact = resolve('dist/store/causalInternal.js');
  assert.equal(existsSync(internalArtifact), false, 'test-only causalInternal must not ship in dist');
  await assert.rejects(
    import(pathToFileURL(internalArtifact).href),
    (error: unknown) => error instanceof Error && (error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND',
  );
  const production = await import(pathToFileURL(resolve('dist/store/causal.js')).href);
  const forbidden = Object.keys(production).filter((name) =>
    /rng|entropy|randomizationMaterial|fault|derive.*assignment|verify.*assignment|precomputed/i.test(name),
  );
  assert.deepEqual(forbidden, []);

  const retainedAssignment = await import(pathToFileURL(resolve('dist/causal/assignment.js')).href);
  assert.deepEqual(
    Object.keys(retainedAssignment).sort(),
    ['verifyBlockedAssignmentPlan'],
    'production assignment artifact may verify retained v1 rows but cannot create allocations',
  );
  const assignmentArtifact = readFileSync(resolve('dist/causal/assignment.js'), 'utf8');
  assert.doesNotMatch(assignmentArtifact, /\brandomBytes\b|createBlockedAssignmentPlan|BlockedAssignmentInput/);
  const cliArtifact = readFileSync(resolve('dist/cli/causalCmd.js'), 'utf8');
  assert.doesNotMatch(cliArtifact, /createBlockedAssignmentPlan|randomizationMaterialHex/);
});

test('clean production artifact omits the research-only causal experiment module', async () => {
  const researchArtifact = resolve('dist/value/causalExperiment.js');
  assert.equal(
    existsSync(researchArtifact),
    false,
    'research-only causalExperiment must not ship in the production build',
  );
  await assert.rejects(
    import(pathToFileURL(researchArtifact).href),
    (error: unknown) => error instanceof Error && (error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND',
  );
});
