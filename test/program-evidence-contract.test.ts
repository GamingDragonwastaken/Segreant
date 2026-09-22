/**
 * Program records are evidence, so they are held to an evidence standard.
 *
 * Twice in this program a checkpoint recorded a CI run identifier and then
 * described its outcome in the future tense — "was queued for this exact head",
 * "remains an external gate until its conclusion is read" — and nobody came
 * back to read it. Both runs had in fact concluded FAILURE. The records did not
 * lie; they simply left a hole shaped exactly like a passing gate, and the next
 * reader filled it in.
 *
 * The rule is the one in CLAUDE.md: write the row PENDING and fill it after
 * observing the run, never predict it. This test makes the first half
 * mechanical. A run identifier that appears without a stated outcome near it is
 * a hole; `PENDING` is an acceptable outcome, and a greppable one, which is the
 * point. What no test can check is whether a PENDING was ever revisited — so
 * the second half stays a discipline, and this test at least makes the debt
 * visible to `grep -rn PENDING docs/`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

/** Every markdown record that is allowed to cite a CI run as evidence. */
function evidenceRecords(): string[] {
  const program = readdirSync(join(ROOT, 'docs', 'program'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => join('docs', 'program', name));
  return [...program, join('docs', 'RELEASE-GATE.md')];
}

/** GitHub Actions run identifiers are 11-digit integers. */
const RUN_ID = /\b\d{11}\b/g;

/**
 * A stated outcome. `PENDING` counts: an openly unread gate is a correct
 * record, where an unstated one is not.
 */
const OUTCOME =
  /\b(success|successful|successfully|passed|passes|pass|green|failure|failed|red|cancelled|canceled|PENDING)\b/i;

/** Outcome words may sit on either side of the identifier they describe. */
const WINDOW = 200;

test('every CI run identifier in a program record states that run’s outcome', () => {
  const holes: string[] = [];
  let identifiers = 0;

  for (const relative of evidenceRecords()) {
    const source = readFileSync(join(ROOT, relative), 'utf8');
    for (const match of source.matchAll(RUN_ID)) {
      identifiers += 1;
      const end = match.index + match[0].length;
      const before = source.slice(Math.max(0, match.index - WINDOW), match.index);
      const after = source.slice(end, end + WINDOW);
      if (!OUTCOME.test(before) && !OUTCOME.test(after)) {
        holes.push(`${relative}: run ${match[0]} cites no outcome`);
      }
    }
  }

  assert.ok(identifiers > 20, `expected the program records to cite many runs, saw ${identifiers}`);
  assert.deepEqual(holes, [], holes.join('\n'));
});

test('program records never predict a CI outcome they have not observed', () => {
  // Each of these asserts a future result. A gate that has not been read is
  // PENDING; it is never "expected to pass".
  const predictions = [
    /\b(?:will|should|expect(?:ed)?\s+to|ought\s+to)\s+(?:pass|be\s+green|succeed)\b/i,
    /\b(?:presumed|assumed|anticipated)\s+(?:green|success|passing)\b/i,
    /\bno\s+reason\s+(?:it\s+)?(?:will\s+not|won'?t|should\s+not|shouldn'?t)\s+pass\b/i,
  ];

  // A quoted phrase is a mention, not a use: the decision log has to be able to
  // write down the phrasing it bans. Same rule the identifier ban applies to
  // backticks.
  const uses = (line: string): string =>
    line.replace(/[“"][^“”"]*[”"]/g, ' ').replace(/`[^`]*`/g, ' ');

  const offences: string[] = [];
  for (const relative of evidenceRecords()) {
    const lines = readFileSync(join(ROOT, relative), 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      const text = uses(line);
      for (const pattern of predictions) {
        if (pattern.test(text)) offences.push(`${relative}:${index + 1}: ${line.trim()}`);
      }
    });
  }

  assert.deepEqual(offences, [], offences.join('\n'));

  // Non-vacuous: an unquoted prediction is still caught, and the quoted form is
  // still excused.
  const bare = 'Run 33477085151 is expected to pass on the exact head.';
  const quoted = 'The record may not say a run is “expected to pass”.';
  assert.ok(predictions.some((p) => p.test(uses(bare))), 'a bare prediction must be caught');
  assert.ok(!predictions.some((p) => p.test(uses(quoted))), 'a quoted prediction is a mention');
});

test('the run-outcome checker is not vacuous', () => {
  // A record shaped like the two that actually failed: an identifier, and a
  // sentence that carefully avoids saying what happened.
  const hole = 'GitHub Actions run `33432485480` was queued for this exact head.';
  const filled = 'GitHub Actions run `33432485480` concluded failure for this exact head.';

  const stated = (text: string) => {
    const match = RUN_ID.exec(text);
    RUN_ID.lastIndex = 0;
    assert.ok(match, 'the fixture must contain a run identifier');
    const after = text.slice(match.index + match[0].length);
    const before = text.slice(0, match.index);
    return OUTCOME.test(before) || OUTCOME.test(after);
  };

  assert.equal(stated(hole), false, 'the checker must reject the shape that failed');
  assert.equal(stated(filled), true, 'the checker must accept a stated outcome');
});
