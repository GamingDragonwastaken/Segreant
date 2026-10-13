# Contributing to Segreant

Segreant treats accounting truth and evidence boundaries as correctness properties,
not presentation details. A change that makes a number easier to read but weaker
to justify is a regression.

## Licensing of contributions

Contributions are welcome. Segreant is published under the Business Source
License 1.1 (`LICENSE`, explained in `LICENSING.md`), and each version becomes
Apache 2.0 two years after it is published. Both need the maintainer to hold
the right to license every part of the code. By opening a pull request you
grant the maintainer a perpetual, worldwide, non-exclusive, royalty-free,
irrevocable license to use, modify, sublicense and distribute your
contribution under the project's license, under its Change License (Apache
2.0), and under any other terms the maintainer offers for Segreant, and you
confirm that you wrote it or have the right to grant that.
You keep the copyright in your contribution.

## Development baseline

- Node.js 24 or newer.
- `npm ci`
- `npm run typecheck`
- `npm test`
- `npm run build`

The main package intentionally has zero runtime dependencies. Do not add one
without an explicit architectural decision and an update to the product and data
boundary documentation.

### Browser tests with installed Chrome

From a fresh clone, use Node.js 24 or newer and run `npm ci --ignore-scripts`.
The lockfile installs the existing Playwright and axe development tooling; no
manifest change or runtime dependency is needed. If Chrome is already installed,
point `SEGREANT_CHROME` at its executable and run the suite:

```powershell
# PowerShell on Windows
$env:SEGREANT_CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
npm run test:browser
```

```bash
# macOS
SEGREANT_CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:browser
# Linux (adjust to the executable installed on your system)
SEGREANT_CHROME=/usr/bin/google-chrome npm run test:browser
```

This uses installed Chrome without downloading Playwright's Chromium. When
Chrome is unavailable, leave `SEGREANT_CHROME` unset, run
`npx playwright install --with-deps chromium`, then `npm run test:browser`;
that is the browser CI job's path. The suite rebuilds both dashboard domains,
runs axe and the outage checks, and completes Allocate, Close and Statement
against a disposable ordinary ledger. Its phone checks cover all eight routes
at 375 × 812 and require primary buttons to be at least 44 px tall. No provider
key, proxy server, or personal ledger is needed. Servers and browser contexts are
closed in `finally`, including on assertion failure.

The job fixture sets only the browser's date to the preceding month's 15th.
That makes month navigation deterministic and keeps its provider days more than
48 hours in the past for reconciliation on every calendar day. The server keeps
its real clock. To save optional job screenshots, set
`SEGREANT_BROWSER_ARTIFACTS` to a directory before running the suite.

### Three compilation domains, one command checks one

`npm run typecheck` runs only the root Node pass. There are three, and green on
one says nothing about the other two:

```bash
node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.json                       # server/CLI, ships to dist/
node ./node_modules/typescript/bin/tsc --noEmit -p src/dashboard/web/app/tsconfig.json # browser GUI, DOM lib, no node types
cd team-server && node ./node_modules/typescript/bin/tsc --noEmit && npm test          # separate npm project
```

The browser app cannot import server source, so it type-checks against
hand-written interfaces in `src/dashboard/web/app/core/api.ts`. A declaration
that does not match what the server actually sends compiles cleanly and fails
silently at runtime — check a payload's declaration against the wire, not
against the other declaration.

`team-server/` imports root source directly from `src/team/` and `src/value/`.
Run its pass and its own `npm test` whenever a PR touches either directory or
anything they export — this has broken CI twice while every root gate stayed
green.

`npx tsc` breaks on a space-containing checkout path; use the explicit
`node ./node_modules/typescript/bin/tsc` form shown above.

### Write the failing test first

For any behavior change — a bug fix, a new invariant, a correctness property —
reproduce the defect as a concrete counterexample, write the smallest test that
fails against the current code, and record that it actually goes RED (test
name, pass/fail count) before writing the fix. A test added alongside a fix
with no recorded RED run has not demonstrated it catches anything. Reviewers
will ask for the RED count.

## Pull requests

Keep each PR reviewable and bind claims to evidence. Explain the root cause for a
fix, the user-facing consequence, the validation performed, and any boundary that
remains unverified. Add a regression test for every correctness bug when a stable
test seam exists.

"Done" means the full suite is green (`npm test`, all three typecheck domains,
`npm run build`) at the exact commit under review, plus a passing CI run for
that same commit SHA — not a prior run on an earlier commit, and not a
predicted result. `docs/RELEASE-PROCESS.md` defines this discipline at release
granularity; the same rule applies to an ordinary PR at PR granularity.

Preserve these invariants:

1. Metered usage, provider-billed cost, allocated cost, and realized value are
   four different claims with four different evidence standards
   (`metered usage != provider-billed cost != allocated cost != realized value`,
   `CLAUDE.md`). A PR that reports one as another — a local price estimate
   presented as an invoice figure, an RoI comparison presented as causal
   allocation evidence — is a correctness regression, not a wording nit.
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

Prefer small commits that explain *why*. Write the subject line as what changed
and why, in the imperative, without a `fix:`/`feat:` prefix (`git log` shows the
convention — e.g. "Say which alert channels were watching when segreant today
says nothing fired"). The body states the counterexample that showed the
defect, the fix, and the RED/GREEN test counts; it does not carry attribution
lines. Before requesting review, run the same checks CI runs and inspect the
packaged artifact when the change touches build, CLI startup, dashboard assets,
or release behavior. Release claims must follow `docs/RELEASE-PROCESS.md`; a
green test command in a commit message is not release evidence by itself.

## Further reading

[`GOVERNANCE.md`](GOVERNANCE.md) says who decides what.
[`SECURITY.md`](SECURITY.md) is the vulnerability-reporting path.
[`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) states what is stable across a
release. [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) states what the
append-only store and signatures do and do not guarantee.
