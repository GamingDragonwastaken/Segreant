/**
 * The repository is public and DATA-BOUNDARIES.md is what a reader trusts
 * instead of reading the source. A boundary claim is therefore only worth the
 * enumeration behind it: every authorization token the code accepts must be
 * declared in that document, every token the document declares must exist in
 * the code, and every retained column that can carry a person's own material
 * must be named rather than folded into a friendly summary.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EGRESS_DATA_CLASSES, EGRESS_PURPOSES } from '../src/egress/policy.ts';
import { appendEgressReceipt, egressReceiptPath } from '../src/egress/receipts.ts';

const DOC_PATH = fileURLToPath(new URL('../docs/DATA-BOUNDARIES.md', import.meta.url));
const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url));

function boundaryDoc(): string {
  return readFileSync(DOC_PATH, 'utf8');
}

/**
 * Rows of the declared egress-path table, whose first two cells are the exact
 * purpose and data-class tokens the policy layer authorizes against.
 */
function declaredEgressRows(): Array<{ purpose: string; dataClass: string }> {
  const rows: Array<{ purpose: string; dataClass: string }> = [];
  for (const line of boundaryDoc().split('\n')) {
    const match = /^\|\s*`([a-z_]+)`\s*\|\s*`([a-z_`, ]+)`\s*\|/.exec(line.trim());
    if (!match) continue;
    for (const dataClass of match[2]!.split(',')) {
      rows.push({ purpose: match[1]!, dataClass: dataClass.trim().replace(/`/g, '') });
    }
  }
  return rows;
}

function sourceFiles(): string[] {
  return readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts'))
    .map((entry) => join(SRC_DIR, entry))
    .filter((path) => !path.includes(join('src', 'egress')));
}

test('every egress purpose the policy layer accepts is declared in DATA-BOUNDARIES.md', () => {
  const declared = new Set(declaredEgressRows().map((row) => row.purpose));
  const undeclared = EGRESS_PURPOSES.filter((purpose) => !declared.has(purpose));
  assert.deepEqual(undeclared, [], 'an authorizable purpose the boundary document does not name is an undeclared egress path');
});

test('every egress data class the policy layer accepts is declared in DATA-BOUNDARIES.md', () => {
  const declared = new Set(declaredEgressRows().map((row) => row.dataClass));
  const undeclared = EGRESS_DATA_CLASSES.filter((dataClass) => !declared.has(dataClass));
  assert.deepEqual(undeclared, [], 'an authorizable data class the boundary document does not name is an undeclared payload shape');
});

test('DATA-BOUNDARIES.md declares no egress path the code cannot actually authorize', () => {
  const purposes = new Set<string>(EGRESS_PURPOSES);
  const dataClasses = new Set<string>(EGRESS_DATA_CLASSES);
  const rows = declaredEgressRows();
  for (const row of rows) {
    assert.equal(purposes.has(row.purpose), true, `documented purpose ${row.purpose} does not exist in EGRESS_PURPOSES`);
    assert.equal(dataClasses.has(row.dataClass), true, `documented data class ${row.dataClass} does not exist in EGRESS_DATA_CLASSES`);
  }
  assert.ok(rows.length >= EGRESS_PURPOSES.length, 'the declared-path table must carry at least one row per purpose');
});

test('every purpose an outbound call site names is one the boundary document declares', () => {
  const declared = new Set(declaredEgressRows().map((row) => row.purpose));
  const used = new Set<string>();
  for (const path of sourceFiles()) {
    for (const match of readFileSync(path, 'utf8').matchAll(/purpose:\s*'([a-z_]+)'/g)) {
      used.add(match[1]!);
    }
  }
  assert.ok(used.size > 0, 'the scan must actually find call sites, or it proves nothing');
  const undeclared = [...used].filter((purpose) => !declared.has(purpose)).sort();
  assert.deepEqual(undeclared, [], 'a call site may not name a purpose the boundary document does not declare');
});

test('a receipt retains no raw origin, path, query, or credential material', () => {
  const previous = process.env.FISCUS_HOME;
  const home = mkdtempSync(join(tmpdir(), 'fiscus-inventory-redaction-'));
  process.env.FISCUS_HOME = home;
  try {
    // Everything identifying in this target is material an operator would not
    // expect a local audit log to keep: a real-looking origin, a project
    // reference inside the path, and a token in the query string.
    const target = new URL('https://api.example-provider.test/v1/organization/project-ref-alpha?admin_token=PLACEHOLDER_NOT_A_SECRET');
    appendEgressReceipt({
      event: 'preflight_allowed',
      purpose: 'provider_cost_observation',
      dataClass: 'provider_cost_aggregate',
      method: 'GET',
      targetClass: 'controlled_cloud',
      ruleId: 'openai-costs',
      target,
      bodyBytes: 0,
    });
    const line = readFileSync(egressReceiptPath(), 'utf8');
    for (const leak of ['api.example-provider.test', 'project-ref-alpha', 'admin_token', 'PLACEHOLDER_NOT_A_SECRET', '/v1/organization']) {
      assert.equal(line.includes(leak), false, `the receipt retained ${leak} verbatim`);
    }
    const receipt = JSON.parse(line.trim()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(receipt).sort(), [
      'at', 'bodyBytes', 'dataClass', 'event', 'hash', 'id', 'method',
      'originSha256', 'pathSha256', 'previousHash', 'purpose', 'ruleId',
      'status', 'targetClass', 'version',
    ], 'the receipt field set is the retention inventory; a new field is a new retained datum');
  } finally {
    if (previous === undefined) delete process.env.FISCUS_HOME;
    else process.env.FISCUS_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

/**
 * Columns confirmed by reading src/store/schema.ts that can carry a person's
 * own material rather than a metering label: an absolute working-directory
 * path, an operator identifier, a commit subject a developer wrote, captured
 * proposal text with its file paths, and discovered repository locations. The
 * document summarized these as "project/session labels", which is a friendlier
 * claim than the schema supports.
 */
const PERSONAL_DATA_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'requests', column: 'cwd' },
  { table: 'requests', column: 'user' },
  { table: 'git_commits', column: 'subject' },
  { table: 'proposals', column: 'files_json' },
  { table: 'scan_snapshots', column: 'repos_json' },
];

test('DATA-BOUNDARIES.md names each retained column that can carry a person\'s own material', () => {
  const schema = readFileSync(fileURLToPath(new URL('../src/store/schema.ts', import.meta.url)), 'utf8');
  const doc = boundaryDoc();
  for (const { table, column } of PERSONAL_DATA_COLUMNS) {
    const tableBody = new RegExp('CREATE TABLE IF NOT EXISTS ' + table + '\\s*\\(([^;]*)\\)', 's').exec(schema)?.[1];
    assert.ok(tableBody, `${table} must still exist in the schema for this inventory row to mean anything`);
    assert.match(tableBody, new RegExp('\\b' + column + '\\b'), `${table}.${column} must still exist for this inventory row to mean anything`);
    assert.match(doc, new RegExp('`' + table + '\\.' + column + '`'), `${table}.${column} is retained locally but the boundary document does not name it`);
  }
});
