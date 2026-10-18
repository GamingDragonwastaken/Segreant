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
//
// The same fault also reaches a test through a CLI child process it spawns: the
// child dies with Windows' access violation (exit 3221225477) or a WebAssembly
// compile error in Node's own type stripper, and the test then fails on the
// exit code or the output. Those failures carry the crash's signature in their
// message; a file whose ONLY failures carry it is treated as crashed and rerun
// alone too. A real failure in the same file, or the same failure again on the
// rerun, still fails the suite.
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';

// A test that forgets to set SEGREANT_HOME falls back to ~/.segreant, which is
// the developer's real ledger: five files did, and wrote egress receipts and
// market caches there on every run. Point the home directory itself at a
// scratch folder for every test process, so a missing override lands somewhere
// harmless. SEGREANT_HOME is left alone: tests that set or unset it on purpose
// keep their meaning. Child processes inherit both variables.
const scratchUser = mkdtempSync(join(tmpdir(), 'segreant-test-user-'));
process.env.HOME = scratchUser;
process.env.USERPROFILE = scratchUser;
// An exported SEGREANT_HOME (or SEGREANT_DB / SEGREANT_DEMO) outranks the home
// directory, so a developer's own override would route a forgetful test
// straight into that real ledger and past the check below (PR #138 review).
// Tests that need one set it themselves.
for (const name of ['SEGREANT_HOME', 'SEGREANT_DB', 'SEGREANT_DEMO']) delete process.env[name];

const RUNTIME_CRASH = /\b3221225477\b|0xC0000005|STATUS_ACCESS_VIOLATION|WebAssembly\.Module\(\): Compiling function|memory access out of bounds|ERR_INTERNAL_ASSERTION/;

function errorText(error, depth = 0) {
  if (!error || depth > 3) return '';
  return `${error.message ?? ''}\n${error.stack ?? ''}\n${typeof error.actual === 'string' || typeof error.actual === 'number' ? error.actual : ''}\n${errorText(error.cause, depth + 1)}`;
}

const files = (process.argv.length > 2 ? process.argv.slice(2) : readdirSync('test').filter((f) => f.endsWith('.test.ts')).map((f) => join('test', f))).sort();

async function runFiles(list) {
  const failedTests = new Set(); // files with at least one failing test (nesting > 0)
  const failedFiles = new Set(); // files whose top-level run failed
  const childCrashes = new Set(); // files with a test that failed only by a child's runtime crash
  const counts = { tests: 0, pass: 0, fail: 0, skipped: 0 };
  // Same parallelism as `node --test` (availableParallelism - 1); run() defaults to serial.
  const stream = run({ files: list, concurrency: true });
  stream.on('test:fail', (e) => {
    if (!e.file) return;
    // The file-level event is named by the file's own path; tests are named by their titles.
    if (e.nesting === 0 && resolve(e.name) === resolve(e.file)) failedFiles.add(e.file);
    else if (RUNTIME_CRASH.test(errorText(e.details?.error))) childCrashes.add(e.file);
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
  const crashed = [...new Set([...failedFiles, ...childCrashes])].filter((f) => !failedTests.has(f));
  return { counts, crashed, realFailures: failedTests.size };
}

const first = await runFiles(files);
let exitCode = first.counts.fail > 0 ? 1 : 0;
if (first.realFailures === 0 && first.crashed.length > 0) {
  console.log(`\n  ${first.crashed.length} test file(s) crashed with no failing test inside them (or failed only on a child process's runtime crash); rerunning each once, alone:`);
  for (const f of first.crashed) console.log(`    ${f}`);
  const second = await runFiles(first.crashed);
  exitCode = second.counts.fail > 0 ? 1 : 0;
  console.log(exitCode === 0
    ? `  Rerun passed: ${second.counts.pass} test(s) in ${first.crashed.length} file(s). The first run's crash was a Node runtime fault, not a test failure.`
    : '  Rerun failed as well: this is a real failure, not a runtime crash.');
}
// Anything under the scratch home's .segreant came from a test that resolved
// the default home instead of its own: on a developer machine that write would
// have landed in the real ledger directory. Name it and fail.
const leaked = join(scratchUser, '.segreant');
if (existsSync(leaked)) {
  const found = readdirSync(leaked, { recursive: true }).map(String);
  console.log(`\n  A test wrote to the default Segreant home (${found.join(', ')}).`);
  console.log('  Set process.env.SEGREANT_HOME to a temporary directory in that test file.');
  exitCode = 1;
}
process.exitCode = exitCode;
