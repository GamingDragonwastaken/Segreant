# Handoff — Fiscus (npm: `fiscus` v0.1.0, formerly AegisFlow)

**State (2026-07-20): publish-ready, awaiting user actions.** `npm test` →
371 tests, 370 pass, 1 skipped by design (POSIX-only permission semantics).
`npx tsc --noEmit` clean.
`team-server/` is a separate package with its own suite (39/39, tsc clean).

## Location & repository
- **Canonical path:** `C:\Users\anasa\Documents\PROJECTS\Side projects, maybe even main but who knows\aegisflow-ts`
- **GitHub (private):** https://github.com/GamingDragonwastaken/aegisflow —
  branch `main`. Repo rename to `fiscus` is a pending USER action (R6).
- Local commits are unpushed — push only on the user's explicit OK.
  Batched-commit rule: user reviews before commit/push. This session's changes
  (R9, below) are **uncommitted** — pending user review.

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
the user's picked mockups (R2) — user eye-check PASSED 2026-07-16. A
dashboard **Settings page** (Overview/Value/Settings nav, real light/dark
theme, setup status, masked provider connection status, budget read/write,
privacy controls) replaces the CLI-only config experience (R9, 2026-07-20).

## Verified this session (2026-07-20)
- R9: proposal-storage retention/purge (privacy fix), README/FAQ/
  RESEARCH-REVIEW.md disclosure, dashboard Settings API + view, dashboard
  nav, light/dark theme system. Browser-probed live against `fiscus-demo`:
  budget edits persist to `config.json`, theme toggle changes computed CSS,
  provider connections show real demo traffic, clear-proposals removes real
  rows, zero non-localhost requests, zero console errors.

## Remaining — ALL user-blocked
1. Review + commit this session's R9 changes (uncommitted).
2. `npm publish --access public --otp=<code>` as 2am_seeker (from repo root).
3. Push the local commits (user OK).
4. Landing-page eye-check (same standard as the dashboard eye-check).
5. R6: GitHub repo rename + later ~/.aegisflow→~/.fiscus migration.
6. R7: 3-min demo recording; deploy landing (GitHub Pages, free tier).

Bedrock/Vertex stays documented-as-unsupported (needs live cloud accounts —
out of scope per the zero-cost ceiling; revisit on real user signal).

## Working preferences
- Batched commits; never push without explicit user OK. Never handle OTP.
- `docs/planning/` is gitignored (internal diligence pack) — keep it so.
- Compat-keep: `~/.aegisflow`, `AEGIS_*` env vars, `aegis.db`,
  `X-Aegis-Source`, GitHub URLs.
- Global hooks from other projects can false-fire here (see
  `cursor-workspace-hooks` memory).
