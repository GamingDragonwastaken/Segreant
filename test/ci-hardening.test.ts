import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('CI uses immutable action revisions, least privilege, and bounded jobs', () => {
  const workflow = readFileSync(join(import.meta.dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(workflow, /^permissions:\s*\n\s+contents:\s+read/m);
  assert.match(workflow, /actions\/checkout@[0-9a-f]{40}/);
  assert.match(workflow, /actions\/setup-node@[0-9a-f]{40}/);
  assert.doesNotMatch(workflow, /actions\/(?:checkout|setup-node)@v\d+/);
  const jobCount = (workflow.match(/^  (?:test|package-smoke|team-server-test|candidate-head):\s*$/gm) ?? []).length;
  const timeoutCount = (workflow.match(/^    timeout-minutes:\s+\d+\s*$/gm) ?? []).length;
  assert.ok(jobCount >= 4, 'the workflow should retain candidate-head, test, package-smoke, and team-server jobs');
  assert.equal(timeoutCount, jobCount, 'every CI job needs a bounded timeout');
  assert.match(workflow, /candidate-head:\s*\n\s+if:\s+github\.event_name\s*==\s*'pull_request'/);
  assert.match(workflow, /ref:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\}\}/);
  assert.match(workflow, /EXPECTED_HEAD_SHA/);
  assert.match(workflow, /Assert candidate checkout identity/);
  assert.match(workflow, /Assert integration checkout identity/);
  assert.match(workflow, /EXPECTED_INTEGRATION_SHA/);
  assert.match(workflow, /git rev-parse HEAD/);
});
