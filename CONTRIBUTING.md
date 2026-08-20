# Contributing to Fiscus

Fiscus treats accounting truth and evidence boundaries as correctness properties,
not presentation details. A change that makes a number easier to read but weaker
to justify is a regression.

## Development baseline

- Node.js 24 or newer.
- `npm ci`
- `npm run typecheck`
- `npm test`
- `npm run build`

The main package intentionally has zero runtime dependencies. Do not add one
without an explicit architectural decision and an update to the product and data
boundary documentation.

## Pull requests

Keep each PR reviewable and bind claims to evidence. Explain the root cause for a
fix, the user-facing consequence, the validation performed, and any boundary that
remains unverified. Add a regression test for every correctness bug when a stable
test seam exists.

Preserve these invariants:

1. Metered usage, provider-billed cost, allocated cost, and realized value are
   distinct claims.
2. Unknown provenance stays unknown; do not infer a historical fact merely
   because it is convenient.
3. Derived accounting records are immutable or versioned; raw evidence is not
   rewritten to make later reports agree.
4. Preview/read endpoints do not persist changes. Consequential writes are
   explicit and guarded.
5. No browser CDN, analytics, web font, or other external GUI request.
6. Never commit credentials, private keys, provider exports, real user data, or
   personal filesystem paths.

## Commit and review discipline

Prefer small commits that explain *why*. Before requesting review, run the same
checks CI runs and inspect the packaged artifact when the change touches build,
CLI startup, dashboard assets, or release behavior. Release claims must follow
`docs/RELEASE-GATE.md`; a green test command in a commit message is not release
evidence by itself.
