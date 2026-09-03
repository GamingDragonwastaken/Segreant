/**
 * Team/attestation command cluster — team (cohort view), receipt
 * (signed attestations), judge (AI-side efficiency), and team push
 * (signed rollups to a team server, one-shot or --watch). Extracted
 * verbatim from cli.ts in the per-command-module split; signAndPushRollup
 * and cmdTeamPushWatch stay module-internal.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../store/db.ts';
import { loadConfig, dbPath, fiscusHome } from '../config.ts';
import { discardResponseBody, egressFetch, EgressError, type EgressErrorCode } from '../egress/transport.ts';
import { isGitRepo, projectName } from '../git/correlate.ts';
import {
  computeRealization,
  projectValueBreakdown,
  projectTaskStrata,
  type ProjectValue,
  type ProjectTaskStratum,
} from '../value/realization.ts';
import { computeCohort, userValueRows, selfView } from '../value/cohort.ts';
import {
  loadOrCreateKeyPair,
  buildReceiptBody,
  buildEconomicReceiptBody,
  signReceipt,
  verifyReceipt,
  type SignedReceipt,
  type VerifyOptions,
  type KeyPair,
} from '../value/receipt.ts';
import { buildEconomicRollupBody, buildRollupBody, signRollup, type EconomicProjectValue, type SignedRollup } from '../team/rollup.ts';
import { judgeSessionFromStore } from '../judge/orchestrate.ts';
import { C, color, usd, pct, printNotAGitRepo, printJson } from './ui.ts';
import { type Flags } from './flags.ts';
import { readBoundedUtf8File, RESOURCE_LIMITS } from '../util/resource-limits.ts';

export async function cmdTeam(flags: Flags): Promise<void> {
  const cfg = loadConfig();
  const store = new Store(dbPath());
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const days = flags.days ? Number(flags.days) : 30;
  const window = { startMs: now - days * dayMs, endMs: now + 1000 };
  const opts = { enabled: cfg.perUser.enabled, minCohort: cfg.perUser.minCohort };
  const tty = process.stdout.isTTY ?? false;

  // --me <user>: a person's own view of themselves. Their own number is always
  // theirs to see; the peer comparison is gated by opt-in + cohort size.
  if (typeof flags.me === 'string') {
    const rows = userValueRows(store, window);
    const view = selfView(rows, flags.me, opts);
    store.close();
    if (flags.json) {
      printJson(view);
      return;
    }
    console.log('');
    if (!view) {
      console.log(color(tty, C.gray, `  No attributed sessions for "${flags.me}" in the last ${days}d.`));
      console.log('');
      return;
    }
    console.log(color(tty, C.bold, `  Your AI value — ${view.user}`));
    console.log(color(tty, C.gray, '  ' + '─'.repeat(64)));
    console.log(`  Extraction          ${color(tty, C.cyan, pct(view.extraction))}   ${color(tty, C.gray, 'of your session-scored AI spend (usage without code signals) reached a realized outcome')}`);
    // The shrinkage mixing weight, named as what it is. It says how much of the
    // figure above is your own sessions rather than the cohort prior — not how
    // confident anyone should be that the figure is right.
    console.log(`  Own-data weight     ${pct(view.localDataWeight)}   ${color(tty, C.gray, `${view.sessions} sessions of evidence; the rest is the cohort prior`)}`);
    if (view.cohortComparable && view.percentile !== null && view.vsMedianPct !== null) {
      const sign = view.vsMedianPct >= 0 ? '+' : '';
      console.log(`  vs. team median     ${color(tty, view.vsMedianPct >= 0 ? C.green : C.yellow, `${sign}${(view.vsMedianPct * 100).toFixed(0)}%`)}   ${color(tty, C.gray, `you extract more than ${(view.percentile * 100).toFixed(0)}% of the team`)}`);
    } else {
      console.log(color(tty, C.gray, '  Peer comparison withheld (per-user value off, or team below the k-anonymity floor).'));
    }
    console.log('');
    console.log(color(tty, C.gray, '  This is your own data. The org view never sees your name — only the distribution.'));
    console.log('');
    return;
  }

  // Org view: distribution + coaching lever only. Never a ranked list of people.
  const rep = computeCohort(store, { ...window, ...opts });
  store.close();
  if (flags.json) {
    printJson(rep);
    return;
  }
  console.log('');
  console.log(color(tty, C.bold, '  Team value — how session-scored AI spend (usage without code signals) converts to outcomes'));
  console.log(color(tty, C.gray, '  ' + '─'.repeat(64)));
  if (rep.suppressed || !rep.distribution) {
    console.log(color(tty, C.yellow, '  Per-user value is withheld.'));
    console.log(color(tty, C.gray, `  ${rep.reason}.`));
    console.log('');
    if (!rep.enabled) {
      console.log(color(tty, C.gray, '  It is OFF by default on purpose: attributing value to named people is the'));
      console.log(color(tty, C.gray, '  surveillance-prone axis. Enable deliberately in config (perUser.enabled),'));
      console.log(color(tty, C.gray, '  and even then this stays a distribution — never a leaderboard.'));
    }
    console.log('');
    console.log(color(tty, C.gray, '  A person can always see their OWN value:  fiscus team --me <user>'));
    console.log('');
    return;
  }
  const d = rep.distribution;
  console.log(color(tty, C.gray, `  ${d.cohortSize} people · individuals not identified · distribution only`));
  console.log('');
  console.log(`  Extraction          median ${color(tty, C.cyan, pct(d.medianExtraction))}   ${color(tty, C.gray, `range ${pct(d.p25Extraction)}–${pct(d.p75Extraction)} (p25–p75)`)}`);
  console.log(`  Spread              ${d.broadBased ? color(tty, C.green, 'broad-based') : color(tty, C.yellow, 'concentrated')}   ${color(tty, C.gray, `dispersion ${d.dispersion.toFixed(2)}`)}`);
  // Spend, not value: the share of attributed cost that reached a kept outcome.
  console.log(`  Spend that realized ${color(tty, C.gray, `${usd(d.totalSpendOnRealizedUnitsUsd)} of ${usd(d.totalCostUsd)} spent reached a kept outcome`)}`);
  console.log('');
  console.log(color(tty, C.bold, `  Coaching headroom   ${color(tty, C.green, usd(d.coachingHeadroomUsd))}`));
  console.log(color(tty, C.gray, '  Latent value if everyone below the median were enabled up to it — at their'));
  console.log(color(tty, C.gray, '  own current spend. A case for training/support, not a ranking of people.'));
  console.log('');
}

export async function cmdReceipt(flags: Flags): Promise<void> {
  const tty = process.stdout.isTTY ?? false;

  // Publish this machine's signing identity so others can pin it when verifying.
  if (flags.pubkey) {
    const keys = loadOrCreateKeyPair(join(fiscusHome(), 'receipt-key.json'));
    if (flags.json) {
      process.stdout.write(JSON.stringify({ keyId: keys.keyId, publicKey: keys.publicPem }, null, 2) + '\n');
      return;
    }
    console.log('');
    console.log(color(tty, C.bold, '  Fiscus signing identity') + color(tty, C.gray, '   publish this so others can verify your receipts'));
    console.log(`  keyId: ${color(tty, C.cyan, keys.keyId)}`);
    console.log('');
    process.stdout.write(keys.publicPem.endsWith('\n') ? keys.publicPem : keys.publicPem + '\n');
    console.log(color(tty, C.gray, '  A buyer/auditor verifies your receipts against this identity with:'));
    console.log(color(tty, C.gray, `    fiscus receipt --verify <file> --key-id ${keys.keyId}`));
    console.log('');
    return;
  }

  if (flags.verify) {
    const file = String(flags.verify);
    let receipt: SignedReceipt;
    try {
      receipt = JSON.parse(readBoundedUtf8File(file, RESOURCE_LIMITS.receiptBytes, 'receipt_bytes')) as SignedReceipt;
    } catch (e) {
      console.error(`  Could not read receipt: ${String(e)}`);
      process.exitCode = 1;
      return;
    }
    // Optional out-of-band trust anchor: pin the expected signer.
    const opts: VerifyOptions = {};
    if (typeof flags['key-id'] === 'string') opts.trustedKeyId = flags['key-id'];
    if (typeof flags.key === 'string') {
      try {
        opts.trustedPublicKeyPem = readFileSync(String(flags.key), 'utf8');
      } catch (e) {
        console.error(`  Could not read pinned key file: ${String(e)}`);
        process.exitCode = 1;
        return;
      }
    }
    const res = verifyReceipt(receipt, opts);
    console.log('');
    console.log(`  Receipt for unit ${receipt.body.unit.slice(0, 7)} · signed by key ${res.keyId || receipt.keyId}`);
    if (res.valid) {
      console.log(color(tty, C.green, '  ✓ INTACT — signature and body hash check out'));
      if (res.pinned) {
        console.log(color(tty, C.green, '  ✓ AUTHENTIC — signed by the key you pinned'));
      } else {
        console.log(color(tty, C.yellow, `  ! NOT PINNED — integrity only. Confirm key ${res.keyId} is the signer you expect,`));
        console.log(color(tty, C.yellow, '    or re-run with --key-id <fingerprint> / --key <publisher.pem> to prove authenticity.'));
      }
    } else {
      console.log(color(tty, C.red, `  ✗ INVALID — ${res.reason}`));
      process.exitCode = 1; // scriptable for CI / auditors
    }
    console.log('');
    return;
  }

  const repo = (flags.repo as string) ?? process.cwd();
  const windowDays = flags.window ? Number(flags.window) : 14;
  const limit = flags.limit ? Number(flags.limit) : 30;
  if (!(await isGitRepo(repo))) {
    printNotAGitRepo(repo);
    process.exitCode = 1;
    return;
  }
  const store = new Store(dbPath());
  const report = await computeRealization(store, repo, { limit, windowDays, persist: false });
  const project = await projectName(repo);
  const keys = loadOrCreateKeyPair(join(fiscusHome(), 'receipt-key.json'));

  const units = report.units.filter(
    (u) => !u.maturing && (!flags.unit || u.hash.startsWith(String(flags.unit))),
  );
  const receipts = units.map((u) => {
    // Emit the strict v2 body only when the exact effective amount has complete
    // coverage and can be represented by the legacy numeric compatibility field.
    // Oversized exact amounts remain valid v1 integrity receipts rather than
    // being rounded or making the command fail; the exact export remains the
    // authoritative handoff for those values.
    const exact = u.economic;
    const body = exact?.complete && Number.isFinite(Number(exact.amountText))
      ? buildEconomicReceiptBody(u.hash, project, u.attributedCostUsd, u.acceptance, u.funnel, exact)
      : buildReceiptBody(u.hash, project, u.attributedCostUsd, u.acceptance, u.funnel);
    return signReceipt(body, keys);
  });
  for (const r of receipts) {
    store.saveReceipt({ unit: r.body.unit, project, tsEpochMs: Date.now(), realized: r.body.realized, receiptJson: JSON.stringify(r) });
  }

  if (flags.json) {
    process.stdout.write(JSON.stringify(receipts, null, 2) + '\n');
    store.close();
    return;
  }

  console.log('');
  console.log(color(tty, C.bold, '  Value Receipts') + color(tty, C.gray, `   signed with key ${keys.keyId} (ed25519)`));
  console.log(color(tty, C.gray, '  Portable, verifiable proof of cost → outcome.'));
  console.log(color(tty, C.gray, `  Publish your identity:  fiscus receipt --pubkey   (keyId ${keys.keyId})`));
  console.log(color(tty, C.gray, '  Others verify + pin it: fiscus receipt --verify <file> --key-id <keyId>'));
  console.log(color(tty, C.gray, '  ' + '─'.repeat(64)));
  if (receipts.length === 0) {
    console.log(color(tty, C.gray, `  No matured units to certify yet (need commits older than ${windowDays}d).`));
  }
  for (const r of receipts.slice(0, 16)) {
    const v = r.body.realized ? color(tty, C.green, 'VERIFIED VALUE') : color(tty, C.yellow, `died:${r.body.diedAt ?? '—'}`);
    console.log(`    ${r.body.unit.slice(0, 7)}  ${usd(r.body.costUsd).padStart(9)}  ${v}`);
  }
  if (receipts.length) {
    console.log('');
    console.log(color(tty, C.gray, '  Example receipt (canonical, signed):'));
    console.log(color(tty, C.gray, JSON.stringify(receipts[0], null, 2).split('\n').map((l) => '    ' + l).join('\n')));
  }
  console.log('');
  store.close();
}

/**
 * Judge a REAL session's AI-assisted efficiency (src/judge/orchestrate.ts).
 * Sessions are looked up from the store (`--session <id>` or, by default, the
 * one with the most recent activity in the window) — never invented, so the
 * structural summary the judge sees is built from that session's actual turns.
 * With no judge.* tier configured (the default), this always returns the
 * zero-cost algorithmic signal — that's the expected steady state, not a
 * degraded one. For the full-content tiers, a Claude Code session's own
 * on-disk transcript is read ephemerally (judge/transcript.ts) — nothing is
 * persisted. See docs/LIFT-AI-SIDE-JUDGE-DESIGN.md §4 for the trust ladder.
 */
export async function cmdJudge(flags: Flags): Promise<void> {
  const tty = process.stdout.isTTY ?? false;
  const repo = (flags.repo as string) ?? process.cwd();

  let project: string;
  if (typeof flags.project === 'string') {
    project = flags.project;
  } else {
    if (!(await isGitRepo(repo))) {
      printNotAGitRepo(repo);
      process.exitCode = 1;
      return;
    }
    project = await projectName(repo);
  }

  const windowDays = flags.window ? Number(flags.window) : 1;
  const windowEndMs = Date.now();
  const windowStartMs = windowEndMs - windowDays * 86_400_000;

  const cfg = loadConfig();
  const store = new Store(dbPath());

  const sessions = store.sessionsInWindow(project, windowStartMs, windowEndMs);
  let picked: { sessionId: string; tool: string; requestCount: number } | null = null;
  if (typeof flags.session === 'string' && flags.session.trim()) {
    const wanted = flags.session.trim();
    picked = sessions.find((s) => s.sessionId === wanted) ?? { sessionId: wanted, tool: store.getSessionMeta(wanted)?.tool ?? 'unknown', requestCount: 0 };
  } else if (sessions.length > 0) {
    picked = sessions[0]!;
  }

  if (!picked) {
    store.close();
    if (flags.json) {
      process.stdout.write(
        JSON.stringify({ error: 'no-sessions-in-window', project, windowDays, sessions: 0 }, null, 2) + '\n',
      );
      return;
    }
    console.log('');
    console.log(color(tty, C.bold, `  Fiscus — session judge · ${project}`));
    console.log(color(tty, C.gray, `  No sessions with request activity in the last ${windowDays}d for this project.`));
    console.log(color(tty, C.gray, '  Route traffic through the proxy or run fiscus scan --setup, then retry.'));
    console.log('');
    return;
  }

  const judgment = await judgeSessionFromStore(store, project, picked.sessionId, windowStartMs, windowEndMs, cfg.judge);
  store.close();

  if (flags.json) {
    printJson(judgment);
    return;
  }

  // Escalating ladder, matching the design doc's "a richer source must never
  // look as cheap as algorithmic" principle (§3) — confidence is the most
  // load-bearing field here, so it gets the most visually distinct color.
  const confColor: string =
    judgment.confidence === 'algorithmic' ? C.gray
    : judgment.confidence === 'local-llm' ? C.cyan
    : judgment.confidence === 'hosted-llm-structural' ? C.yellow
    : C.red; // 'hosted-llm-full'

  console.log('');
  console.log(color(tty, C.bold, `  Fiscus — session judge · ${project}`));
  console.log(color(tty, C.gray, '  ' + '─'.repeat(46)));
  console.log(color(tty, C.gray, `  window: last ${windowDays}d · session ${picked.sessionId}`));
  console.log(color(tty, C.gray, `  tool: ${picked.tool} · ${picked.requestCount} requests in window${sessions.length > 1 ? ` · ${sessions.length} sessions available (pick one with --session <id>)` : ''}`));
  console.log('');
  console.log(`  Efficiency    ${color(tty, judgment.efficiencyMultiplier >= 1 ? C.green : C.yellow, judgment.efficiencyMultiplier.toFixed(2) + 'x')}`);
  console.log(`  Confidence    ${color(tty, confColor, judgment.confidence)}`);
  console.log('');
  console.log(color(tty, C.gray, `  ${judgment.rationale}`));
  if (judgment.confidence === 'algorithmic') {
    console.log('');
    console.log(color(tty, C.gray, '  No LLM judge tier is configured — this is the always-on algorithmic signal.'));
    console.log(color(tty, C.gray, '  Opt into a local or hosted LLM judge via config.judge.* — see docs/LIFT-AI-SIDE-JUDGE-DESIGN.md §4.'));
  }
  console.log('');
}

type PushResult =
  | { status: 'empty'; message: string }
  | { status: 'dry-run'; signed: SignedRollup }
  | { status: 'ok'; keyId: string; projectCount: number }
  | { status: 'error'; message: string; failureCode?: TeamPushFailureCode; action?: string };

type TeamPushFailureCode = `egress_${EgressErrorCode}` | 'network_error';

function egressRepairAction(code: EgressErrorCode): string | undefined {
  return code === 'receipt_integrity_failed' || code === 'receipt_persistence_failed'
    ? 'Repair or restore the local receipt history before retrying; if the lock is stale, confirm no Fiscus writer is active, then remove only that lock and rerun verify.'
    : undefined;
}

/**
 * Team rollups can include the local developer's numeric usage and outcome
 * evidence. Refuse to send that payload over plaintext outside a local
 * development loopback endpoint. This is deliberately hostname-based rather
 * than DNS-based: resolving a name here would make the safety check dependent
 * on mutable network state.
 */
function teamPushTransportError(rawUrl: string): string | null {
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    // Preserve the existing fetch error for malformed URLs. This guard only
    // adds a safety boundary for otherwise-valid plaintext HTTP endpoints.
    return null;
  }

  if (target.protocol !== 'http:') return null;

  // URL.hostname normalizes DNS names and keeps IPv6 literals bracketed.
  // Permit local development with or without an explicit port, but never
  // treat a lookalike hostname (for example localhost.example.com) as local.
  const isLoopback = target.hostname === 'localhost'
    || target.hostname === '127.0.0.1'
    || target.hostname === '[::1]';
  if (isLoopback) return null;

  return `refusing plaintext HTTP team push to non-loopback endpoint "${target.origin}" — use HTTPS, or a local loopback URL such as http://127.0.0.1:8787`;
}

/**
 * A rollup scoped to one project is not a snapshot, and the server reads it as
 * one.
 *
 * `aggregateProjects` keeps only `latest_rollup_per_dev` — `SELECT DISTINCT ON
 * (r.key_id) ... ORDER BY r.key_id, r.received_at DESC` — and treats that one
 * rollup as the developer's complete window. So a `--project` push silently
 * erases every OTHER project this machine contributed to from every team total.
 * It is worse than a missing row: `developerCount` falls with it, and
 * `buildProjectReport` suppresses any project under `minCohort` contributors, so
 * a colleague's project can disappear behind a k-anonymity notice that has
 * nothing to do with them. The totals that remain are wrong in the direction
 * that looks fine — a smaller, cheaper team.
 *
 * WHY THE CLIENT REFUSES RATHER THAN THE SERVER REJECTING. Nothing on the wire
 * distinguishes a scoped rollup from a complete one, so the server cannot tell.
 * Putting the coverage in the signed body is the honest repair — a rollup
 * carrying the basis of its own completeness, which is rule one of this project
 * applied to a shared figure — and it is a signed-protocol change with a
 * compatibility story rather than a defect fix. Until it exists, the only sound
 * position is that a rollup no receiver can consume correctly must not be sent.
 *
 * `--dry-run` keeps the flag's inspection use: it prints the scoped rollup and
 * sends nothing, so it corrupts nothing. Recorded at D-101.
 */
function scopedPushRefusal(projectFilter: string | null): string | null {
  if (projectFilter === null) return null;
  return `refusing to push a rollup scoped with --project "${projectFilter}" — the team server keeps only your `
    + 'latest rollup and reads it as your complete window, so this push would erase every other project on this '
    + 'machine from the shared totals. Push the complete snapshot (drop --project), or use --project with '
    + '--dry-run to preview one project without sending anything.';
}

/**
 * Sign and (unless dryRun) push a rollup of the given projects. Pure: no
 * printing, no process.exitCode — callers decide how to present each
 * PushResult. Shared by the one-shot and --watch paths (cmdTeamPush,
 * cmdTeamPushWatch) so both stay in lockstep on message text and JSON shape.
 */
async function signAndPushRollup(
  projects: ProjectValue[],
  opts: { windowDays: number; projectFilter: string | null; keys: KeyPair; url: string | null; dryRun: boolean; strata?: ProjectTaskStratum[] },
): Promise<PushResult> {
  if (projects.length === 0) {
    const message = opts.projectFilter
      ? `no realized units found for project "${opts.projectFilter}" in the last ${opts.windowDays}d — nothing to push`
      : `no realized units found in the last ${opts.windowDays}d — nothing to push`;
    return { status: 'empty', message };
  }

  // After the empty check, deliberately: a window with nothing in it has no
  // rollup to corrupt a total with, and "nothing to push" is the truer answer.
  // Before signing, so a rollup that may not be sent is never minted.
  const scopeRefusal = scopedPushRefusal(opts.dryRun ? null : opts.projectFilter);
  if (scopeRefusal !== null) return { status: 'error', message: scopeRefusal };

  const to = new Date();
  const from = new Date(to.getTime() - opts.windowDays * 86_400_000);
  const period = { from: from.toISOString(), to: to.toISOString() };
  const body = projects.every((project) => project.economic !== undefined)
    ? buildEconomicRollupBody(opts.keys, projects as EconomicProjectValue[], period, opts.strata)
    : buildRollupBody(opts.keys, projects, period, opts.strata);
  const signed: SignedRollup = signRollup(body, opts.keys);

  if (opts.dryRun) {
    return { status: 'dry-run', signed };
  }

  try {
    const res = await egressFetch(opts.url!.replace(/\/$/, '') + '/rollups', {
      purpose: 'team_rollup',
      dataClass: 'team_rollup',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(signed),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const message = `push failed: HTTP ${res.status} from ${opts.url}${detail ? ` — ${detail.slice(0, 200)}` : ''}`;
      return { status: 'error', message, failureCode: 'network_error' };
    }
    await discardResponseBody(res);
    return { status: 'ok', keyId: opts.keys.keyId, projectCount: projects.length };
  } catch (e) {
    if (e instanceof EgressError) {
      const action = egressRepairAction(e.code);
      return {
        status: 'error',
        message: `Fiscus egress boundary refused team push (${e.code}): ${e.message}${action ? ` ${action}` : ''}`,
        failureCode: `egress_${e.code}`,
        action,
      };
    }
    return { status: 'error', message: `push failed: ${String(e)}`, failureCode: 'network_error' };
  }
}

/**
 * Push a signed, numeric-only rollup of this machine's per-project value/RoI to
 * an enterprise-run team server. See docs/TEAM-TIER-DESIGN.md — Fiscus hosts
 * nothing; --url points at infrastructure the team already runs and trusts.
 * Uses a SEPARATE keypair from `receipt --pubkey` on purpose (src/team/rollup.ts).
 * `--watch` keeps pushing on an interval (--every seconds) — see cmdTeamPushWatch,
 * the same pattern as `import --watch` (cmdImportWatch).
 */
export async function cmdTeamPush(flags: Flags): Promise<void> {
  const tty = process.stdout.isTTY ?? false;
  const keyPath = join(fiscusHome(), 'team-key.json');
  const sub = typeof flags._[0] === 'string' ? flags._[0] : '';

  if (sub !== 'push') {
    console.log('');
    console.log(color(tty, C.bold, '  Team tier — push a signed rollup to a team server you run'));
    console.log(color(tty, C.gray, '  Fiscus hosts nothing; --url points at infrastructure your team already trusts.'));
    console.log('');
    console.log(color(tty, C.gray, '  Usage:  fiscus team push --url <url>          send this window\'s per-project value/RoI'));
    console.log(color(tty, C.gray, '          fiscus team push --dry-run             preview without sending'));
    console.log(color(tty, C.gray, '          fiscus team push --pubkey              print this machine\'s rollup signing identity'));
    console.log(color(tty, C.gray, '          fiscus team push --url <url> --window 7'));
    console.log(color(tty, C.gray, '          fiscus team push --dry-run --project <name>   preview ONE project; a'));
    console.log(color(tty, C.gray, '                                                        scoped rollup is never sent'));
    console.log(color(tty, C.gray, '          fiscus team push --url <url> --watch --every 3600   background interval (seconds)'));
    console.log('');
    return;
  }

  if (flags.pubkey) {
    const keys = loadOrCreateKeyPair(keyPath);
    if (flags.json) {
      process.stdout.write(JSON.stringify({ keyId: keys.keyId, publicKey: keys.publicPem }, null, 2) + '\n');
      return;
    }
    console.log('');
    console.log(color(tty, C.bold, '  Fiscus team-rollup identity') + color(tty, C.gray, '   register this with your team server'));
    console.log(`  keyId: ${color(tty, C.cyan, keys.keyId)}`);
    console.log('');
    process.stdout.write(keys.publicPem.endsWith('\n') ? keys.publicPem : keys.publicPem + '\n');
    console.log('');
    return;
  }

  const url = typeof flags['url'] === 'string' ? flags['url'] : null;
  const dryRun = Boolean(flags['dry-run']);
  if (!url && !dryRun) {
    const msg = 'no team server URL given — pass one your team runs: fiscus team push --url <url>  (or --dry-run to preview without sending)';
    if (flags.json) {
      console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
      process.exitCode = 1;
      return;
    }
    console.error(`  ${color(tty, C.yellow, '✗')} ${msg}`);
    process.exitCode = 1;
    return;
  }

  if (url) {
    const transportError = teamPushTransportError(url);
    if (transportError) {
      if (flags.json) {
        console.log(JSON.stringify({ ok: false, error: transportError }, null, 2));
      } else {
        console.error(`  ${color(tty, C.red, 'âœ—')} ${transportError}`);
      }
      process.exitCode = 1;
      return;
    }
  }

  const windowDays = flags.window ? Number(flags.window) : 30;
  const projectFilter = typeof flags['project'] === 'string' ? flags['project'] : null;

  if (flags.watch) {
    // The loop would otherwise reprint the same refusal on every tick.
    const scopeRefusal = scopedPushRefusal(projectFilter);
    if (scopeRefusal !== null) {
      if (flags.json) {
        console.log(JSON.stringify({ ok: false, error: scopeRefusal }, null, 2));
      } else {
        console.error(`  ${color(tty, C.red, '✗')} ${scopeRefusal}`);
      }
      process.exitCode = 1;
      return;
    }
    if (!url) {
      const msg = 'no team server URL given — --watch needs somewhere to push: fiscus team push --url <url> --watch';
      if (flags.json) {
        console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
        process.exitCode = 1;
        return;
      }
      console.error(`  ${color(tty, C.yellow, '✗')} ${msg}`);
      process.exitCode = 1;
      return;
    }
    await cmdTeamPushWatch({ keyPath, url, windowDays, projectFilter, intervalMs: typeof flags.every === 'string' ? Number(flags.every) * 1000 : undefined });
    return;
  }

  const store = new Store(dbPath());
  let projects = projectValueBreakdown(store, { windowDays });
  // Task strata travel with the rollup so the server can standardize on a fixed
  // task basket (src/team/standardize.ts) — same project filter as the totals.
  let strata = projectTaskStrata(store, { windowDays });
  store.close();
  if (projectFilter) {
    projects = projects.filter((p) => p.project === projectFilter);
    strata = strata.filter((s) => s.project === projectFilter);
  }

  const keys = loadOrCreateKeyPair(keyPath);
  const result = await signAndPushRollup(projects, { windowDays, projectFilter, keys, url, dryRun, strata });

  if (result.status === 'empty') {
    if (flags.json) {
      console.log(JSON.stringify({ ok: true, projects: 0, note: result.message }, null, 2));
      return;
    }
    console.log(`  ${color(tty, C.dim, result.message)}`);
    return;
  }

  if (result.status === 'dry-run') {
    if (flags.json) {
      console.log(JSON.stringify(result.signed, null, 2));
      return;
    }
    console.log('');
    console.log(color(tty, C.bold, `  Dry run — would push ${projects.length} project(s), signed by key ${keys.keyId}`));
    for (const p of projects) {
      const roiStr = p.roiIndex === null ? 'RoI —' : `RoI ${Math.round(p.roiIndex)}`;
      console.log(`    ${p.project.padEnd(24)} ${usd(p.costUsd).padStart(12)}   ${roiStr}`);
    }
    console.log(color(tty, C.gray, `  Nothing was sent. Re-run with --url <url> to actually push.`));
    console.log('');
    return;
  }

  if (result.status === 'error') {
    if (flags.json) {
      console.log(JSON.stringify({ ok: false, error: result.message, failureCode: result.failureCode, action: result.action }, null, 2));
      process.exitCode = 1;
      return;
    }
    console.error(`  ${color(tty, C.red, '✗')} ${result.message}`);
    process.exitCode = 1;
    return;
  }

  if (flags.json) {
    console.log(JSON.stringify({ ok: true, keyId: result.keyId, projects: result.projectCount }, null, 2));
    return;
  }
  console.log(`  ${color(tty, C.green, '✓')} Pushed ${result.projectCount} project(s) to ${url}, signed by key ${result.keyId}`);
}

/**
 * Live team push: re-sign and push the rolling window on an interval — same
 * poll/print-one-line/Ctrl+C-to-stop pattern as cmdImportWatch. Keeps the store
 * open across ticks (the one-shot path above opens, reads, and closes once) and
 * re-queries project totals fresh each tick, so a long-running watch reflects
 * work completed after it started.
 */
async function cmdTeamPushWatch(opts: {
  keyPath: string;
  url: string;
  windowDays: number;
  projectFilter: string | null;
  intervalMs?: number;
}): Promise<void> {
  const tty = process.stdout.isTTY ?? false;
  const intervalMs = Math.max(2000, opts.intervalMs ?? 5000);
  const store = new Store(dbPath());
  const keys = loadOrCreateKeyPair(opts.keyPath);

  console.log('');
  console.log(color(tty, C.bold, `  Team push — watching, pushing every ${Math.round(intervalMs / 1000)}s`));
  console.log(
    color(
      tty,
      C.gray,
      `  Window: last ${opts.windowDays}d${opts.projectFilter ? ` · project ${opts.projectFilter}` : ''} · target ${opts.url} · Ctrl+C to stop`,
    ),
  );
  console.log('');

  let running = true;
  const tick = async (): Promise<void> => {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    try {
      let projects = projectValueBreakdown(store, { windowDays: opts.windowDays });
      let strata = projectTaskStrata(store, { windowDays: opts.windowDays });
      if (opts.projectFilter) {
        projects = projects.filter((p) => p.project === opts.projectFilter);
        strata = strata.filter((s) => s.project === opts.projectFilter);
      }
      const result = await signAndPushRollup(projects, {
        windowDays: opts.windowDays,
        projectFilter: opts.projectFilter,
        keys,
        url: opts.url,
        dryRun: false,
        strata,
      });
      if (result.status === 'ok') {
        console.log(color(tty, C.gray, `  ${time}  `) + color(tty, C.green, `✓ pushed ${result.projectCount} project(s)`));
      } else if (result.status === 'empty') {
        console.log(color(tty, C.gray, `  ${time}  ${result.message}`));
      } else if (result.status === 'error') {
        console.log(color(tty, C.gray, `  ${time}  `) + color(tty, C.red, `✗ ${result.message}`));
      }
    } catch (e) {
      console.log(color(tty, C.gray, `  ${time}  `) + color(tty, C.red, `✗ push tick failed: ${String(e)}`));
    }
  };

  await tick();
  const timer = setInterval(() => {
    if (running) void tick();
  }, intervalMs);

  await new Promise<void>((resolve) => {
    const stop = () => {
      running = false;
      clearInterval(timer);
      store.close();
      console.log('\n  Stopped watching.');
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}
