#!/usr/bin/env node
// The suite runner behind `npm test`.
//
// Node's type stripper occasionally crashes a test process under load
// (ERR_INTERNAL_ASSERTION "memory access out of bounds" inside parseTypeScript),
// which fails a whole file with no test inside it failing. That is a runtime
// crash, not a test result, so this runner reruns such a file once, alone, and
// says so. A file where any test failed is never rerun, and a file that crashes
// again fails the suite: a real import-time error is deterministic and cannot
// hide behind the retry.
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';

const files = (process.argv.length > 2 ? process.argv.slice(2) : readdirSync('test').filter((f) => f.endsWith('.test.ts')).map((f) => join('test', f))).sort();

async function runFiles(list) {
  const failedTests = new Set(); // files with at least one failing test (nesting > 0)
  const failedFiles = new Set(); // files whose top-level run failed
  const counts = { tests: 0, pass: 0, fail: 0, skipped: 0 };
  // Same parallelism as `node --test` (availableParallelism - 1); run() defaults to serial.
  const stream = run({ files: list, concurrency: true });
  stream.on('test:fail', (e) => {
    if (!e.file) return;
    // The file-level event is named by the file's own path; tests are named by their titles.
    if (e.nesting === 0 && resolve(e.name) === resolve(e.file)) failedFiles.add(e.file);
    else failedTests.add(e.file);
  });
  stream.on('test:summary', (e) => {
    if (e.file !== undefined) return; // per-file summaries; keep only the run total
    counts.tests = e.counts.tests; counts.pass = e.counts.passed; counts.fail = e.counts.failed; counts.skipped = e.counts.skipped;
  });
  await new Promise((done, reject) => {
    const out = stream.compose(spec);
    out.on('data', (chunk) => process.stdout.write(chunk));
    out.on('end', done);
    out.on('error', reject);
  });
  // A top-level failure whose file also had a failing test is a test failure,
  // not a crash. Match on the file path the event reported.
  const crashed = [...failedFiles].filter((f) => !failedTests.has(f));
  return { counts, crashed, realFailures: failedTests.size };
}

const first = await runFiles(files);
let exitCode = first.counts.fail > 0 ? 1 : 0;
if (first.realFailures === 0 && first.crashed.length > 0) {
  console.log(`\n  ${first.crashed.length} test file(s) crashed with no failing test inside them; rerunning each once, alone:`);
  for (const f of first.crashed) console.log(`    ${f}`);
  const second = await runFiles(first.crashed);
  exitCode = second.counts.fail > 0 ? 1 : 0;
  console.log(exitCode === 0
    ? `  Rerun passed: ${second.counts.pass} test(s) in ${first.crashed.length} file(s). The first run's crash was a Node runtime fault, not a test failure.`
    : '  Rerun failed as well: this is a real failure, not a runtime crash.');
}
process.exitCode = exitCode;
