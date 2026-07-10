# Handoff — AegisFlow

**State:** working, verified. `npm test` → 245/246 pass (1 skipped — POSIX-only
permission semantics, not Windows-reachable). `npx tsc --noEmit` → clean.

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

**Latest (this session):** the Lift baseline-minutes input is no longer a flat
guess — it's a cited METR-anchored population prior blended with the user's own
pre-tracking git history via empirical-Bayes shrinkage (`src/value/liftBaseline.ts`,
`docs/RETURN-ON-INTELLIGENCE.md` §7.1; reachable via `aegisflow baseline`). Deep
Scan's "other tools" inventory (`src/scan/knownApps.ts`) shipped alongside it.
Both verified end-to-end on real machine data, not just unit tests.

## Known limitations / next
See `docs/ARCHITECTURE.md` §7 for the maintained list. Current headline items:
a hosted cross-machine team tier (not scoped — needs an operator), native
Bedrock/Vertex/`/responses` support, a true transcript-judge or A/B time study
for Lift (a larger thing than the baseline-sourcing upgrade above — it would
judge the AI-assisted session itself, not just the manual comparator).

## Working preferences
- Batched-commit: the user reviews the full diff before any commit happens —
  don't commit or push without being asked, even mid-autonomous-task.
- This workspace has global hooks (from other projects) that can false-fire in
  this subfolder — see the `cursor-workspace-hooks` memory if a hook blocks
  something that looks like it shouldn't be blocked.
