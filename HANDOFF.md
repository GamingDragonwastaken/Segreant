# Handoff — Fiscus (npm: `fiscus` v0.1.0, formerly AegisFlow)

**State (2026-07-18): publish-ready, awaiting user actions.** `npm test` →
360 tests, 359 pass, 1 skipped by design (POSIX-only permission semantics).
`npx tsc --noEmit` clean.
`team-server/` is a separate package with its own suite (39/39, tsc clean).

## Location & repository
- **Canonical path:** `C:\Users\anasa\Documents\PROJECTS\Side projects, maybe even main but who knows\aegisflow-ts`
- **GitHub (private):** https://github.com/GamingDragonwastaken/aegisflow —
  branch `main`. Repo rename to `fiscus` is a pending USER action (R6).
- **17 local commits are unpushed** — push only on the user's explicit OK.
  Batched-commit rule: user reviews before commit/push.

## What's done (headlines — details in README Status + docs/ARCHITECTURE.md §7)
Reverse proxy (Anthropic/OpenAI/Gemini/any OpenAI-compatible base) + native
import (Claude Code / opencode / Codex), `scan --setup` onboarding,
self-refreshing pricing + `reprice`, budget guard (cap governs LIVE proxy
spend by default; `budget --include-imported on` for total), project
aliasing (`fiscus project merge`), RoI Index with partial-identification
math, Lift judge ladder with REAL transcript excerpts for **all three**
importers (ephemeral read of each tool's own on-disk log — nothing
persisted), a dashboard judge trigger (`POST /api/judge`), **Time
Reclaimed** (`fiscus saved` + a dashboard card) — manual work-weeks a
project's realized work would have cost at its task baselines vs the
AI-assisted time actually measured, honestly banded and split by task type
so died/unrealized work never inflates the number — signed receipts,
opt-in k-anonymous team tier + separate team-server. Dashboard rebuilt from
the user's picked mockups (R2) — user eye-check PASSED 2026-07-16.

## Verified this session (2026-07-16..18)
- R3 dogfood batch, R4 judge transcripts, R8 Part A (opencode + Codex
  transcript extractors, judge registry, dashboard judge trigger), R8 Part B
  (Time Reclaimed engine, `fiscus saved` CLI, dashboard card).
- All new surfaces browser-verified end-to-end (demo data + real repo).
  Both HTML surfaces re-verified zero external requests after every change.

## Remaining — ALL user-blocked
1. `npm publish --access public --otp=<code>` as 2am_seeker (from repo root).
2. Push the local commits (user OK).
3. Landing-page eye-check (same standard as the dashboard eye-check).
4. R6: GitHub repo rename + later ~/.aegisflow→~/.fiscus migration.
5. R7: 3-min demo recording; deploy landing (GitHub Pages, free tier).

Bedrock/Vertex stays documented-as-unsupported (needs live cloud accounts —
out of scope per the zero-cost ceiling; revisit on real user signal).

## Working preferences
- Batched commits; never push without explicit user OK. Never handle OTP.
- `docs/planning/` is gitignored (internal diligence pack) — keep it so.
- Compat-keep: `~/.aegisflow`, `AEGIS_*` env vars, `aegis.db`,
  `X-Aegis-Source`, GitHub URLs.
- Global hooks from other projects can false-fire here (see
  `cursor-workspace-hooks` memory).
