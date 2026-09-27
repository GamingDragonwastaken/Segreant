/**
 * COMPOSITE IDENTITIES ARE INJECTIVE, AND THE CORPUS IS STATED (WP-R10, D-241).
 *
 * D-217 made provider/model identity a JSON tuple in the frontier and the
 * exact attribution path, and left "other composite-key audits" open. This is
 * that audit, as a gate: every IDENTITY-SHAPED site under `src/` that joins
 * two interpolations with a one-character delimiter — an `id:`, `key =`,
 * `eventId:`, `bindingId:`, `sourceId:`, `requestId:` or `return` of such a
 * template — must be listed here with the reason the join cannot alias two
 * distinct inputs. A newcomer fails the gate until it is classified.
 *
 * Three honest reasons exist:
 *   - `tuple`     the parts travel as a JSON array, so the delimiter is not
 *                 load-bearing (the D-217 idiom);
 *   - `constrained` every part but the last is generated or validated to
 *                 exclude the delimiter (a UUID, a numeric, a charset without
 *                 it), so the join parses unambiguously from the left;
 *   - `numeric_tail` the LAST part is numeric and every earlier part may hold
 *                 the delimiter, so the join parses unambiguously from the right.
 *
 * Measured before this gate: `pluginEvidenceId` joined two identifiers whose
 * charset admits ':' (a plugin could alias two records); the causal lineage
 * binding id joined two causal identifiers whose charset admits ':'; the
 * proxy attribution `sourceId` and the reprice summary key joined provider and
 * model with a delimiter a model name may contain. All four are tuples now.
 *
 * Display strings (console output, labels, messages) are deliberately outside
 * the corpus: a collision in a printed line misleads a reader, a collision in
 * an identity merges two records.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

function sourceFiles(dir = join(ROOT, 'src')): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** An identity-shaped site: an id-like binding or a return whose template joins two interpolations with one delimiter. */
const IDENTITY_JOIN = /(?:\b(?:id|Id|key|Key|eventId|bindingId|sourceId|requestId|decisionId)\s*[:=]\s*(?:[a-zA-Z_.]+\s*\?\?\s*)?|\breturn\s+)`[^`\n]*\$\{[^}]+\}[:/|#\-]\$\{/;

type Reason = 'tuple' | 'constrained' | 'numeric_tail';

/** Every site, by file and the exact text the line must still contain, with its reason. */
const CLASSIFIED: ReadonlyArray<{ file: string; contains: string; reason: Reason; why: string }> = [
  { file: 'src/billing/epistemic.ts', contains: 'evidence:billing:${run.importId}:${record.sourceRecordId}', reason: 'constrained', why: 'importId is randomUUID() (src/store/billing.ts), which has no colon; sourceRecordId is the last part' },
  { file: 'src/billing/epistemic.ts', contains: 'claim:billing:billed:${run.importId}:${record.sourceRecordId}', reason: 'constrained', why: 'as above' },
  { file: 'src/billing/epistemic.ts', contains: 'evidence:openai-costs:${run.observationRunId}:${line.observationId}', reason: 'constrained', why: 'observationRunId is randomUUID() (src/store/billing.ts); observationId is the last part' },
  { file: 'src/billing/epistemic.ts', contains: 'claim:billing:provider-observed:${input.run.observationRunId}:${line.observationId}', reason: 'constrained', why: 'as above' },
  { file: 'src/budget/capDecision.ts', contains: '${BUDGET_CAP_PROBLEM.id}:${key}', reason: 'constrained', why: 'the problem id is a literal constant and the key is a hex digest' },
  { file: 'src/connect/codex.ts', contains: 'codex:${forkId ?? sessionId ?? \'unknown\'}:${ordinal++}', reason: 'numeric_tail', why: 'the ordinal is numeric and last; a thread id may hold a colon and still parses from the right' },
  { file: 'src/store/db.ts', contains: '${startMs}:${endMs}:${liveOnly ? \'live\' : \'all\'}', reason: 'constrained', why: 'a process-local cache key: two epoch integers and a literal, none of which can hold a colon' },
  { file: 'src/githubActionsEvidence.ts', contains: 'gha:${value.repository.id}:${value.workflow.runId}:${value.workflow.attempt}:tested:${value.commit}', reason: 'constrained', why: 'repository id, run id and attempt are validated numerics; the commit is a hex sha' },
  { file: 'src/githubActionsEvidence.ts', contains: 'gha:${input.repositoryId}:${input.runId}:${input.attempt}:tested:${input.commit}', reason: 'constrained', why: 'as above' },
  { file: 'src/git/completeness.ts', contains: 'git-revert-scan:${project}:${oldestExaminedMs}', reason: 'numeric_tail', why: 'a project path may hold a colon (a Windows drive); the epoch tail is numeric' },
  { file: 'src/plugins/intake.ts', contains: 'evidence:plugin:${JSON.stringify([pluginId, requestId, evidenceId])}', reason: 'tuple', why: 'safeIdentifier admits a colon in requestId and evidenceId (D-241)' },
  { file: 'src/store/causalProducer.ts', contains: 'lineage:${JSON.stringify([input.studyId, input.decisionId])}', reason: 'tuple', why: 'causal identifiers admit a colon (D-241)' },
  { file: 'src/value/frontier.ts', contains: 'frontier:${JSON.stringify([taskType, incumbent.model, candidate.model])}', reason: 'tuple', why: 'model names are free text (D-241)' },
  { file: 'src/value/realization.ts', contains: 'proxy:${JSON.stringify([proposal.provider, proposal.model])}', reason: 'tuple', why: 'model names are free text (D-241)' },
];

test('every identity-shaped delimiter join under src/ is classified, and every classification still points at a live line', () => {
  const found: Array<{ file: string; line: number; text: string }> = [];
  for (const full of sourceFiles()) {
    const file = relative(ROOT, full).replaceAll('\\', '/');
    readFileSync(full, 'utf8').split('\n').forEach((text, index) => {
      if (text.trim().startsWith('//') || text.trim().startsWith('*')) return;
      if (IDENTITY_JOIN.test(text)) found.push({ file, line: index + 1, text: text.trim() });
    });
  }
  assert.ok(found.length >= 8, `the corpus must be found, not matched away (${found.length} sites)`);

  const unclassified = found.filter((site) => !CLASSIFIED.some((entry) => entry.file === site.file && site.text.includes(entry.contains)));
  assert.deepEqual(unclassified.map((site) => `${site.file}:${site.line}: ${site.text}`), [], 'an identity joins two parts with a delimiter and nothing says why that cannot alias');

  const stale = CLASSIFIED.filter((entry) => !readFileSync(join(ROOT, entry.file), 'utf8').includes(entry.contains));
  assert.deepEqual(stale.map((entry) => `${entry.file}: ${entry.contains}`), [], 'a classification names text the source no longer has');

  const tuples = CLASSIFIED.filter((entry) => entry.reason === 'tuple');
  for (const entry of tuples) assert.ok(entry.contains.includes('JSON.stringify(['), `${entry.file}: a tuple classification must be a JSON array`);
  assert.ok(tuples.length >= 4, 'the four D-241 repairs are tuples');
});
