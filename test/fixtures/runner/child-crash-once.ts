// A test whose spawned child hit the runtime crash on the first run (exit code
// 3221225477 is Windows' access violation), and passes on the second.
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
test('a CLI child exits 2 on bad input', () => {
  const marker = join(process.env.RUNNER_FIXTURE_DIR!, 'child-crashed-once');
  const status = existsSync(marker) ? 2 : (writeFileSync(marker, '1'), 3221225477);
  assert.equal(status, 2);
});
