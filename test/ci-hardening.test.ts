import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('CI uses immutable action revisions, least privilege, and bounded jobs', () => {
  const workflow = readFileSync(join(import.meta.dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(workflow, /^permissions:\s*\n\s+contents:\s+read/m);
  assert.match(workflow, /actions\/checkout@[0-9a-f]{40}/);
  assert.match(workflow, /actions\/setup-node@[0-9a-f]{40}/);
  assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40}/);
  assert.doesNotMatch(workflow, /actions\/(?:checkout|setup-node|upload-artifact)@v\d+/);
  // D-237: the runtime SBOM is generated and checked in the package job, and the
  // check is the script, so a workflow edit cannot keep the upload and drop the rule.
  assert.match(workflow, /npm run --silent sbom > fiscus-runtime\.cdx\.json/);
  assert.match(workflow, /node scripts\/check-sbom\.mjs fiscus-runtime\.cdx\.json/);
  const jobsBlock = workflow.split(/^jobs:\s*$/m)[1] ?? '';
  const jobCount = (jobsBlock.match(/^  [a-z0-9-]+:\s*$/gm) ?? []).length;
  const timeoutCount = (jobsBlock.match(/^    timeout-minutes:\s+\d+\s*$/gm) ?? []).length;
  assert.ok(jobCount >= 6, 'the workflow should retain candidate-head, test, package-smoke, team-server, browser, and security jobs');
  assert.match(workflow, /^  security:\s*$/m);
  assert.match(workflow, /npm run verify:security/);
  assert.match(workflow, /npm run verify:supply-chain/);
  assert.match(workflow, /npm run audit:runtime/);
  assert.equal(timeoutCount, jobCount, 'every CI job needs a bounded timeout');
  assert.match(workflow, /candidate-head:\s*\n\s+if:\s+github\.event_name\s*==\s*'pull_request'/);
  assert.match(workflow, /ref:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\}\}/);
  assert.match(workflow, /EXPECTED_HEAD_SHA/);
  assert.match(workflow, /Assert candidate checkout identity/);
  assert.match(workflow, /Assert integration checkout identity/);
  assert.match(workflow, /EXPECTED_INTEGRATION_SHA/);
  assert.match(workflow, /git rev-parse HEAD/);
});
