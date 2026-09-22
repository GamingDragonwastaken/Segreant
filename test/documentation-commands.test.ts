/**
 * A command in a code fence is an instruction, and nothing checked that any of
 * them exist (WP-I06).
 *
 * WHAT THIS PACKET IS FOR. Documentation is the operator's first executable
 * surface: `docs/GETTING-STARTED.md` is a sequence of commands somebody types
 * before they have any way to tell a real one from a stale one. A dead command
 * there is the same failure this repository refuses everywhere else -- a claim
 * with no basis -- except that it fails in the reader's terminal rather than in
 * a number. Nothing in the suite read a doc's commands against the CLI's own
 * dispatch, so the two could drift silently and had no reason not to.
 *
 * WHAT THE MEASUREMENT FOUND IN THE DOCS, WHICH IS ALMOST NOTHING. Across
 * `README.md` and the 25 operator-facing files in `docs/`, 244 `fiscus
 * <action>` invocations appear inside code fences or inline code spans,
 * covering 40 distinct commands and 49 distinct flags. Two command names did
 * not resolve against the CLI's dispatch: `fiscus lab` and `fiscus lift`.
 * Every flag occurs in `src/`, every `npm run <script>` resolves against
 * `package.json`, and every port named in a doc matches `DEFAULT_CONFIG`. So
 * the documented command surface was already sound, and this file is a gate
 * over a property that currently holds rather than a repair of a broken one --
 * the same shape as D-156's literal-rung sweep, and worth the same amount: it
 * cannot drift back without failing.
 *
 * WHAT THE MEASUREMENT FOUND IN ITSELF, WHICH WAS NOT NOTHING. The first
 * working version of this sweep read `README.md` and matched none of its
 * fenced blocks, because that file has CRLF line endings and the fence pattern
 * required a bare `\n` after the language tag. It reported no violations over
 * the repository's most important operator document without having read a line
 * of it. `codeChunks` records the fix; the point worth carrying is that the
 * invocation-count assertion in the vacuity test is the only thing that
 * noticed, and a sweep without one is indistinguishable from a sweep that
 * matches nothing.
 *
 * THE TWO THAT DID NOT RESOLVE, HANDLED DIFFERENTLY ON PURPOSE.
 * `fiscus lab complexity` is introduced by its own document under "Proposed
 * product boundary" and again as "Build the Complexity Lab", so the text
 * already tells the reader it does not exist; it is allowlisted here with that
 * reason recorded rather than silently skipped. `fiscus lift` was not marked at
 * all -- it sat in two prose sentences describing an open item, phrased as
 * though the command were there to be invoked -- so those two lines are
 * corrected instead of allowlisted. An exception with a stated reason is a
 * record; an exception without one is a hole.
 *
 * SCOPED TO CODE SPANS AND FENCES, DELIBERATELY. "The fiscus for your AI spend"
 * in `docs/DESIGN-DIRECTION.md` is prose about the project's name, and the URL
 * bar of a device mockup on the landing page is a picture. Neither is an
 * instruction, and a sweep that flagged them would have to be taught to ignore
 * them by name -- which is how allowlists grow until they mean nothing. Reading
 * only what is marked as code is the principled boundary, and it carries a
 * second rule that the two corrected lines above follow: code formatting means
 * "type this", so a command that does not exist must not be set as code even
 * in a sentence saying it does not exist.
 *
 * WHAT THIS DOES NOT ESTABLISH. That any documented command WORKS -- only that
 * its name reaches a dispatch case and its flags exist somewhere in `src/`.
 * It does not execute anything, does not check that a flag is accepted by the
 * command it is documented under, and says nothing about whether the output
 * shown beside a command is what that command still prints. Those are the rest
 * of WP-I06 and are not claimed here.
 *
 * Recorded at D-166.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../src/config.ts';

const ROOT = join(import.meta.dirname, '..');
const read = (relative: string): string => readFileSync(join(ROOT, relative), 'utf8');

/**
 * Commands a document introduces as not yet built, with the reason each one is
 * allowed to appear. Adding a name here is a decision that has to be defensible
 * in review; leaving one out is what makes the sweep worth running.
 */
const PLANNED: Record<string, string> = {
  lab: 'docs/TOKEN-GOVERNANCE-AND-COMPLEXITY-LAB.md introduces `fiscus lab complexity` under "Proposed product '
    + 'boundary" and lists "Build the Complexity Lab" as future work, so its own text tells the reader it does not exist',
};

/**
 * Operator-facing Markdown: README plus `docs/`, minus the program record.
 *
 * `docs/RELEASE-GATE.md` is excluded and the exclusion is load-bearing: it is a
 * commit-bound record of what was observed at particular candidate SHAs, not
 * instructions. Its commands ran against isolated ports (`--port 18390`)
 * precisely so they could not touch a real ledger, and holding a historical
 * observation to today's defaults would be asking a record to change.
 * `docs/program/**` is already out of scope by not being read at all.
 *
 * Paths are joined with `/` rather than `join()` so the strings this file
 * reports and compares are the same on every platform.
 */
const PROGRAM_RECORDS = new Set(['RELEASE-GATE.md']);

function operatorDocs(): string[] {
  const docs = readdirSync(join(ROOT, 'docs'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && !PROGRAM_RECORDS.has(entry.name))
    .map((entry) => `docs/${entry.name}`);
  return ['README.md', ...docs];
}

/**
 * Fenced blocks and inline code spans: what a reader would copy, and nothing else.
 *
 * `\r?\n` and `[^\n]*` are both load-bearing, and the first was found the hard
 * way. `README.md` has CRLF line endings, so a fence opener reads
 * "```bash\r\n"; against `[a-z]*\n` the language tag consumed `bash` and `\n`
 * was then asked to match `\r`, which fails. The sweep therefore matched ZERO
 * fenced blocks in the repository's most important operator document and
 * reported no violations over a corpus it had not read -- the same
 * absence-reported-as-a-result this program has now recorded eleven times,
 * this time inside the tool built to catch it. The invocation-count assertion
 * in the vacuity test below is what surfaced it, which is the entire reason
 * that assertion exists.
 */
function codeChunks(markdown: string): string[] {
  const fences = [...markdown.matchAll(/```[^\n]*\r?\n([\s\S]*?)```/g)].map((m) => m[1]!);
  const inline = [...markdown.matchAll(/`([^`\r\n]+)`/g)].map((m) => m[1]!);
  return [...fences, ...inline];
}

interface Invocation {
  file: string;
  command: string;
  flags: string[];
}

function invocations(files: readonly string[]): Invocation[] {
  const found: Invocation[] = [];
  for (const file of files) {
    for (const chunk of codeChunks(read(file))) {
      for (const match of chunk.matchAll(/(?:npx )?fiscus ([a-z][a-z0-9-]*)([^\n`|]*)/g)) {
        found.push({
          file,
          command: match[1]!,
          flags: [...(match[2] ?? '').matchAll(/--[a-z][a-z0-9-]*/g)].map((m) => m[0]),
        });
      }
    }
  }
  return found;
}

/** The CLI's own dispatch table, read from the switch rather than from a second list. */
function dispatchActions(): Set<string> {
  const cli = read('src/cli.ts');
  const switchAt = cli.indexOf('  switch (cmd) {');
  assert.notEqual(switchAt, -1, 'src/cli.ts must dispatch through a switch, or this test is reading the wrong thing');
  return new Set([...cli.slice(switchAt).matchAll(/^ {4}case '([^']+)':/gm)].map((m) => m[1]!));
}

function sourceText(): string {
  const parts: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (entry.name.endsWith('.ts')) parts.push(readFileSync(join(ROOT, dir, entry.name), 'utf8'));
    }
  };
  walk('src');
  return parts.join('\n');
}

test('every documented fiscus command reaches a real dispatch case', () => {
  const actions = dispatchActions();
  const unresolved = invocations(operatorDocs())
    .filter((entry) => !actions.has(entry.command) && !(entry.command in PLANNED))
    .map((entry) => `${entry.file}: fiscus ${entry.command}`);

  assert.deepEqual(
    [...new Set(unresolved)].sort(),
    [],
    'a command in a code fence is an instruction; these resolve to nothing the CLI dispatches',
  );
});

test('every documented flag exists somewhere in the source that would have to accept it', () => {
  // The weaker half of the pair, and its weakness is the point: this proves the
  // flag is not a fiction, not that the command it is documented under accepts
  // it. Pinning flag-to-command would need the CLI to declare its own flags per
  // action, which it does not, and inventing that mapping here would be a
  // second opinion about what the CLI takes rather than a reading of it.
  const src = sourceText();
  const missing = new Set<string>();
  for (const entry of invocations(operatorDocs())) {
    for (const flag of entry.flags) {
      if (!src.includes(flag) && !src.includes(flag.slice(2))) missing.add(`${entry.file}: ${flag}`);
    }
  }
  assert.deepEqual([...missing].sort(), []);
});

test('every documented npm script is a script this package defines', () => {
  const scripts = new Set(Object.keys(JSON.parse(read('package.json')).scripts as Record<string, string>));
  // `npm run deploy` appears once, as the READER's own project script inside a
  // `fiscus exec --kind shipped -- npm run deploy` example. It is an argument
  // to a Fiscus command, not a Fiscus script, and requiring it to exist here
  // would be requiring this repository to define the reader's deploy step.
  const READER_OWNED = new Set(['deploy']);
  const missing = new Set<string>();
  for (const file of operatorDocs()) {
    for (const chunk of codeChunks(read(file))) {
      for (const match of chunk.matchAll(/npm run ([a-z][a-z0-9:_-]*)/g)) {
        const name = match[1]!;
        if (!scripts.has(name) && !READER_OWNED.has(name)) missing.add(`${file}: npm run ${name}`);
      }
    }
  }
  assert.deepEqual([...missing].sort(), []);
});

test('the ports a document tells an operator to open are the ports this build listens on', () => {
  // A wrong port is a dead first run that looks like a broken install.
  const known = new Set([String(DEFAULT_CONFIG.port), String(DEFAULT_CONFIG.dashboardPort)]);
  const wrong = new Set<string>();
  for (const file of operatorDocs()) {
    for (const chunk of codeChunks(read(file))) {
      // `\b...\b` on purpose: an unanchored `\d{4}` matched the first four
      // digits of the isolated five-digit port `18390` and reported `1839`,
      // which is not a port anybody documented.
      for (const match of chunk.matchAll(/localhost:(\d{4,5})\b|--port (\d{4,5})\b|--dashboard-port (\d{4,5})\b/g)) {
        const port = match[1] ?? match[2] ?? match[3]!;
        if (!known.has(port)) wrong.add(`${file}: ${port}`);
      }
    }
  }
  assert.deepEqual([...wrong].sort(), [], `documented ports must match DEFAULT_CONFIG (${[...known].join(', ')})`);
});

test('the sweep is not vacuous: it reads real invocations and would catch a dead one', () => {
  // A sweep that matches nothing passes every assertion above while proving
  // none of them. Both halves are checked: that the extractor finds the real
  // corpus, and that a fabricated dead command does not survive it.
  const found = invocations(operatorDocs());
  // 244 at the time of writing. The threshold is what caught the CRLF bug that
  // made this sweep read none of README's fenced blocks, so it is deliberately
  // high enough that losing one large document fails rather than passes.
  assert.ok(found.length > 200, `expected the documented corpus to be substantial; found ${found.length}`);
  assert.ok(
    found.some((entry) => entry.file === 'README.md'),
    'README is CRLF and was silently unread once already; if it drops out again this must fail',
  );
  assert.ok(
    found.some((entry) => entry.file === 'docs/GETTING-STARTED.md'),
    'the getting-started path is the one a new operator actually types, and must be in scope',
  );

  const actions = dispatchActions();
  assert.ok(actions.has('demo') && actions.has('start'), 'the dispatch reader must find real cases');
  assert.equal(actions.has('definitely-not-a-command'), false);

  const synthetic = codeChunks('Run `fiscus definitely-not-a-command --json` to break this test.');
  const names = synthetic.flatMap((chunk) => [...chunk.matchAll(/(?:npx )?fiscus ([a-z][a-z0-9-]*)/g)].map((m) => m[1]!));
  assert.deepEqual(names, ['definitely-not-a-command']);
});

test('prose is out of scope, and that is a boundary rather than an exception list', () => {
  // "The fiscus for your AI spend" is a sentence about the project's name.
  // Reading only marked code is what keeps it out, without teaching the sweep
  // to ignore particular phrases -- which is how an allowlist grows until it
  // means nothing.
  const chunks = codeChunks('The **fiscus** for your AI spend, and `fiscus demo` to try it.');
  assert.deepEqual(chunks, ['fiscus demo']);
});

test('every planned-command exception names the document that marks it as unbuilt', () => {
  // The allowlist is a record, not a mute button: each entry states why, and
  // the document it points at has to actually be one that uses the command.
  const actions = dispatchActions();
  for (const [command, reason] of Object.entries(PLANNED)) {
    assert.equal(actions.has(command), false, `${command} is dispatched now and no longer needs an exception`);
    assert.match(reason, /docs\/[A-Z-]+\.md/, `the exception for ${command} must name the document it applies to`);
    const cited = /docs\/[A-Z-]+\.md/.exec(reason)![0];
    assert.ok(
      codeChunks(read(cited)).some((chunk) => chunk.includes(`fiscus ${command}`)),
      `${cited} must actually be where \`fiscus ${command}\` appears`,
    );
  }
});
