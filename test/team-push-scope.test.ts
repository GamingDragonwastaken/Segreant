/**
 * A scoped push is not a snapshot, and the team server reads it as one (WP-C06).
 *
 * THE DEFECT. `fiscus team push --project <name>` filters the rollup down to one
 * project — the flag is in the command's own help text. The team server treats a
 * developer's LATEST rollup as their complete window snapshot:
 *
 *   WITH latest_rollup_per_dev AS (
 *     SELECT DISTINCT ON (r.key_id) r.id FROM rollups r ... ORDER BY r.key_id, r.received_at DESC, r.id DESC
 *   )
 *   ... WHERE r.id IN (SELECT id FROM latest_rollup_per_dev) GROUP BY rp.project
 *
 * So one scoped push silently erases that developer's every OTHER project from
 * every team total. It is worse than a missing row: `developerCount` for those
 * projects falls too, and `buildProjectReport` suppresses any project below
 * `minCohort` distinct contributors — so a colleague's project can vanish
 * entirely, with the suppression notice blaming k-anonymity rather than a push
 * that had nothing to do with them. The numbers that remain are wrong in the
 * safe-looking direction: they read as a smaller, cheaper team.
 *
 * WHY THE REFUSAL IS ON THE CLIENT AND NOT A SERVER RULE. The server cannot tell
 * a scoped rollup from a complete one: nothing on the wire says which it is.
 * That is the honest repair — a coverage field in the signed body, so a rollup
 * carries the basis of its own completeness, exactly as every other Fiscus
 * figure must — and it is a signed-protocol change with a compatibility story,
 * not a defect fix. Until then the only sound position is that a scoped rollup
 * must not be sent, because there is no way for the receiver to consume it
 * correctly.
 *
 * WHAT IS KEPT. `--project` with `--dry-run` still previews one project's
 * numbers locally, which is the flag's inspection use and sends nothing. What is
 * refused is the combination that corrupts a shared total. Recorded at D-101.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/db.ts';
import { GATE_LADDER, scoreFunnel, type Gate, type GateResult } from '../src/value/gates.ts';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

function runCli(args: string[], dbPath: string, home: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...process.env, FISCUS_DB: dbPath, FISCUS_HOME: home, NODE_OPTIONS: '' } },
      (err, stdout, stderr) => {
        const code = err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
          ? (err as unknown as { code: number }).code
          : err ? 1 : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/** Two realized projects on one machine, which is the whole point of the case. */
function seedTwoProjects(dbPath: string): void {
  const store = new Store(dbPath);
  const now = Date.now();
  const verdicts = Object.fromEntries(
    GATE_LADDER.map((gate) => [gate, { gate, verdict: 'pass', detail: 'fixture' }]),
  ) as Record<Gate, GateResult>;
  const rows = [['alpha', 'a'], ['beta', 'b']].map(([project, seed]) => {
    const unit = {
      hash: seed!.repeat(40), subject: `fixture ${project}`, tsEpochMs: now - 3_600_000,
      linesAdded: 4, linesDeleted: 0, filesChanged: 1,
      windowStartMs: now - 7_200_000, windowEndMs: now, attributedCostUsd: 1, attributedRequests: 1,
      attributedOutputTokens: 10, costPerHundredLines: 25, ageDays: 30, maturing: false, survivalRatio: 1,
      reverted: false, hadProposal: false, acceptance: null, taskType: 'feature', dominantModel: 'gpt-4o',
      dominantModelCostUsd: 1, dominantModelCostShare: 1, dominantModelCostBasis: 'local_list_price',
      dominantModelRateCard: null, costStale: false, funnel: scoreFunnel(verdicts),
    };
    return {
      commitHash: unit.hash,
      project: project!,
      tsEpochMs: unit.tsEpochMs,
      computedAtMs: now,
      attributedCostUsd: 1,
      maturing: false,
      realized: true,
      unitJson: JSON.stringify(unit),
      costScope: 'project' as const,
    };
  });
  store.saveRealizationUnits(rows);
  store.close();
}

async function withUpstream<T>(run: (port: number, connections: () => number) => Promise<T>): Promise<T> {
  let connections = 0;
  const upstream = http.createServer((_req, res) => { res.writeHead(204); res.end(); });
  upstream.on('connection', () => { connections += 1; });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const port = (upstream.address() as { port: number }).port;
  try {
    return await run(port, () => connections);
  } finally {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
}

test('team push refuses to send a rollup scoped to one project', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-team-scope-'));
  try {
    const db = join(dir, 'push.db');
    const home = join(dir, 'home');
    seedTwoProjects(db);

    await withUpstream(async (port, connections) => {
      const r = await runCli(
        ['team', 'push', '--url', `http://127.0.0.1:${port}`, '--project', 'alpha', '--json'],
        db,
        home,
      );
      assert.equal(r.code, 1, `a scoped push must fail rather than corrupt a shared total, stdout: ${r.stdout}`);
      const payload = JSON.parse(r.stdout) as { ok: boolean; error: string };
      assert.equal(payload.ok, false);
      assert.match(payload.error, /--project/, 'the message must name the flag that caused it');
      assert.match(payload.error, /snapshot|complete|every other project|erase/i, 'and say what the server would do with it');
      assert.equal(connections(), 0, 'nothing may reach the team server before the refusal');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('team push still sends the complete snapshot when no project is named', async () => {
  // THE GUARD-RAIL. A refusal that also broke the ordinary push would satisfy
  // the test above and delete the feature.
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-team-scope-ok-'));
  try {
    const db = join(dir, 'push.db');
    const home = join(dir, 'home');
    seedTwoProjects(db);

    await withUpstream(async (port) => {
      const r = await runCli(['team', 'push', '--url', `http://127.0.0.1:${port}`, '--json'], db, home);
      assert.equal(r.code, 0, `an unscoped push must still work, stderr: ${r.stderr}`);
      const payload = JSON.parse(r.stdout) as { ok: boolean; projects: number };
      assert.equal(payload.ok, true);
      assert.equal(payload.projects, 2, 'both projects belong in a complete snapshot');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('team push --project keeps its local preview, which sends nothing', async () => {
  // The inspection use of the flag survives. `--dry-run` reaches no socket at
  // all, so scoping it corrupts nothing.
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-team-scope-dry-'));
  try {
    const db = join(dir, 'push.db');
    const home = join(dir, 'home');
    seedTwoProjects(db);

    const r = await runCli(['team', 'push', '--dry-run', '--project', 'alpha', '--json'], db, home);
    assert.equal(r.code, 0, `a scoped dry run must still preview, stderr: ${r.stderr}`);
    const signed = JSON.parse(r.stdout) as { body: { projects: { project: string }[] } };
    assert.deepEqual(signed.body.projects.map((project) => project.project), ['alpha']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a scoped push with nothing to send is still reported as nothing to send', async () => {
  // Ordering matters: an empty window has no rollup to corrupt anything with, so
  // it keeps the honest "nothing to push" answer rather than being reported as
  // an unsound scope.
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-team-scope-empty-'));
  try {
    const db = join(dir, 'push.db');
    const home = join(dir, 'home');
    const r = await runCli(['team', 'push', '--url', 'http://127.0.0.1:1', '--project', 'alpha', '--json'], db, home);
    assert.equal(r.code, 0, `an empty window is not a failure, stdout: ${r.stdout}`);
    const payload = JSON.parse(r.stdout) as { ok: boolean; projects: number; note?: string };
    assert.equal(payload.ok, true);
    assert.equal(payload.projects, 0);
    assert.match(payload.note ?? '', /nothing to push/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
