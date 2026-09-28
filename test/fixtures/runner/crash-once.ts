// Crashes the process on its first load, passes on the second (marker in RUNNER_FIXTURE_DIR).
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
const marker = join(process.env.RUNNER_FIXTURE_DIR!, 'crashed-once');
if (!existsSync(marker)) { writeFileSync(marker, '1'); process.exit(7); }
test('passes after the crash', () => {});
