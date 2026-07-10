# Handoff — AegisFlow

**State:** working, verified. `npm test` (root) → 309/310 pass (1 skipped —
POSIX-only permission semantics). `npx tsc --noEmit` (root) → clean.
`team-server/` is a SEPARATE package with its own suite: `npm test` there →
39/39 pass, `npx tsc --noEmit` there → clean (see below).

## Location & repository
- **Canonical path:** `C:\Users\anasa\Documents\PROJECTS\Side projects, maybe even main but who knows\aegisflow-ts`
- **GitHub (private):** https://github.com/GamingDragonwastaken/aegisflow — branch `main`.
- The sibling folder `...\aegisflow` (no `-ts`) is the user's deprecated Rust
  trial — left untouched.

## What's done
Full detail lives in `README.md` (Status section) and `docs/ARCHITECTURE.md`
(component table + §7 roadmap) — this is a pointer, not a duplicate. Headline
surfaces: reverse proxy (Anthropic/OpenAI/Gemini/any OpenAI-compatible base),
native import (Claude Code, opencode, Codex CLI — zero base-URL wiring),
`scan`/`discover` one-command onboarding (+ a read-only inventory of other AI
tools seen: Cursor, Windsurf, Aider, Continue, Zed), self-refreshing pricing,
budget guard + value-aware allocation, per-project realized value with a
budget-owner view, opt-in k-anonymous per-user value, signed value receipts,
the Realization Standard funnel, and the RoI Index (Realization × Acceptance ×
Lift × Impact, geometric mean, partial-identification interval).

**Latest (this session, IN PROGRESS — building out the judge + team-tier designs
per explicit user direction that reversed the earlier design-only instruction):**
Lift AI-side judge built end to end except real full-content judging and a
CLI/dashboard caller (`src/judge/*` — 42 tests across tier/payload/call/
orchestrate — plus `src/value/liftEfficiency.ts`'s own 8, 50 total; real
finding: AegisFlow never persisted transcript text, so `judgeSession`
downgrades payload AND reported confidence together rather than claim fidelity
it can't deliver — `docs/LIFT-AI-SIDE-JUDGE-DESIGN.md` §2).

Team tier, built in four verified slices — all done:
1. **Client** — `src/team/rollup.ts` + `aegisflow team push` (`--url`,
   `--dry-run`, `--pubkey`, `--window`, `--project`), 5 tests. Bug caught +
   fixed: CLI dispatch had two `case 'team':` labels (dead code) — merged,
   branching on `flags._[0] === 'push'`.
2. **Server ingest** — `team-server/` (separate npm package, `pg` its only
   dep). `POST /developers` (admin-token-gated, fails closed) + `POST
   /rollups` (signature pinned to the *registered* key, blocks an
   unregistered forgery). Honest gap: real SQL not run against live Postgres
   this session (Docker didn't boot in time) — compensated by a genuine
   end-to-end run of the real CLI against the real server (fake store),
   proving the wire format, both accept and reject paths.
3. **OIDC** — `team-server/src/oidc.ts`'s `verifyIdToken`, `node:crypto` only,
   gating a real `GET /me` route. Alg whitelisted to RS256/ES256 (rejects
   `alg:"none"` and HS256 algorithm-confusion). ES256 needs `dsaEncoding:
   'ieee-p1363'` — JWT's raw signature encoding differs from crypto's DER
   default, a real gotcha this closes out. Proven against genuine signatures
   via a fake in-process IdP (`test/fakeIdp.ts`), not just compiled.
4. **Aggregate dashboard** — `GET /dashboard/projects` + `GET
   /dashboard/developers`, both OIDC-gated, both further gated by
   `team-server/src/aggregate.ts`'s privacy layer. Real finding:
   `ProjectValue.realizationRate` is a unit-count ratio, not a dollar ratio —
   naively summing dollars would've silently redefined the metric between the
   single-machine and team views, so the query weights it
   `SUM(rate_i × units_i)/SUM(units_i)` instead (exact, no schema change
   needed). A project's numbers are suppressed if too few developers
   contributed to it (re-identification risk, same reasoning as
   `src/value/cohort.ts` one level down); the developer breakdown gets
   `cohort.ts`'s full opt-in + k-anonymity treatment, distribution only,
   never a named list. Docker was still unavailable — same honest SQL-vs-
   Postgres gap as slice 2, now covering two more queries; the fake-store
   tests replicate the real SQL's weighting exactly and 39/39 pass.
   `team-server/` suite: 24→39 tests (9 pure privacy-gating tests, 6 new
   HTTP-level dashboard tests including a hand-computed weighted-math proof).

**Next:** task #51 — a full verification pass across everything built this
session (judge + team tier). Beyond that, remaining open items: a rendered
dashboard UI over the now-real aggregate API, linking an OIDC identity to a
developer `keyId` for a self-view, the judge feature's own CLI/dashboard
caller, and native Bedrock/Vertex wire formats. If this note looks stale,
check task state / recent commits.

## Known limitations / next
See `docs/ARCHITECTURE.md` §7 for the maintained list: a hosted cross-machine
team tier (client + server-ingest + OIDC + aggregate API all built; no
rendered UI, no OIDC-to-keyId self-view), native Bedrock/Vertex wire formats
(genuinely different envelopes AND auth models — not yet started), and real
transcript capture + full-content judging + a CLI/dashboard trigger for the
Lift judge ladder.

## Working preferences
- Batched-commit: the user reviews the full diff before any commit happens —
  don't commit or push without being asked, even mid-autonomous-task.
- This workspace has global hooks (from other projects) that can false-fire in
  this subfolder — see the `cursor-workspace-hooks` memory if a hook blocks
  something that looks like it shouldn't be blocked.
