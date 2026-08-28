# dashboard — the web GUI and its local server

<!-- Layer 2 contract. This is a GUI for operating Fiscus, not a read-only dashboard. -->

## Consumes

- `src/store/db.ts` (read, and write on the mutating routes), `src/config.ts`.
- The value, billing, alloc and cost modules for computed payloads.
- Nothing from the network. Not at build time, not at run time.

## Layout

```
server.ts            entry + guards: loopback Host, route matching, method/CSRF
routes.ts            one named handler per endpoint, plus the ROUTES table
static.ts            asset serving and the two HTML entry points
settings.ts          settings snapshot / patch
web/
  index.html         the GUI shell. Carries the DIRECTION CONTRACT comment.
  classic.html       the previous single-file dashboard, served at /classic
  styles/app.css     the Night Vault design system
  app/
    tsconfig.json    its own compiler config: DOM lib, no node types
    main.ts          shell, rail, routing, first-run register choice
    core/
      signal.ts      reactive primitive (~80 lines, no framework)
      dom.ts         h() / render(); no HTML-parsing sink anywhere
      fmt.ts         money, dates, and the plain/precise REGISTER
      api.ts         typed client for this server
      claimTypes.ts  Layer + ClaimInspection: the shape of a claim's evidence
      claimLayers.ts the four claims, DERIVED from payloads. Pure; tested.
      chain.ts       the I/O half: four independent reads, each degrading alone
      registry.ts    THE PARITY MAP — every capability, tier, coverage
      actions.ts     preview/commit builders per capability
    components/
      spine.ts       the four bands and the ≠ between them
      drawer.ts      the action drawer: preview → consequence → command → commit
      claimInspector.ts  the long form of a band's basis. Reads; never acts.
    views/           one per territory
```

## Guarantees

- **The GUI reaches for CLI parity, and says where it has not.** `registry.ts` is
  the single source for navigation, action cards, and the parity table rendered
  in System. A capability with no screen is visible in the product as unbuilt.
- **The test prerequisite is explicit.** `npm test` performs a full build before
  running tests because package-boundary checks inspect both browser and Node
  artifacts in `dist/`. The build script's `--web` mode remains a targeted GUI
  iteration tool, not the ordinary test contract.
- **Nothing happens without a preview.** Every action opens the drawer, which
  states the consequence in words, shows the computed preview, prints the
  equivalent command, and only then offers the commit.
- **Classic is an explicitly legacy compatibility view.** `/classic` preserves
  the earlier single-file dashboard and its direct settings controls; it does
  not provide the modern preview-first action flow and must not be presented as
  GUI parity. The modern `/` surface is the preview/consequence/apply contract.
- **Consequence tiers gate the commit**: `read` has none, `local` needs a loaded
  preview, `credential` and `egress` name what is read or sent, `destructive`
  requires typing the capability id.
- **Two audiences, one screen.** The `register` signal switches wording and
  precision, never the data. `plain` and `precise` show the same figures.
- **Zero external requests.** No fonts, no CDN, no analytics, no absolute URLs.
- **Static serving is doubly gated**: the resolved path must stay inside
  `web/`, and the extension must be in `STATIC_TYPES`. Everything else 404s.

## Invariants

- **No HTML-parsing sink.** `dom.ts` sets text through `textContent` and
  attributes through `setAttribute`. No `innerHTML`, `outerHTML`,
  `insertAdjacentHTML`, or `document.write` anywhere in `app/`. Ledger data is
  operator-supplied — project names come from folder names — and must never be
  able to become markup. Pinned by `test/dashboard-script.test.ts`.
- **Mutating routes require `x-fiscus-local: 1`.** A cross-origin page cannot set
  a custom header without a preflight this server never answers, so a malicious
  site cannot drive the operator's local Fiscus. Never relax this. The gate is
  DECLARED per route (`localOnly`) and enforced once, in `server.ts`, so it can
  be audited as a table instead of by reading every branch. A new mutating route
  adds itself to `MUTATING` in `test/dashboard-routes.test.ts`, which fails if
  the route ships without its gate.
- **A GET writes nothing.** GET is the one method no `localOnly` gate covers —
  a cross-origin page can issue one with no custom header, so no preflight to
  refuse — which makes "read-only" a security boundary here and not a style
  preference. A route that wants to persist what its preview saw does it on the
  guarded method. `GET /api/scan` broke this by recording its own walk as the
  new scan baseline; the baseline now moves only on `POST`.
- **Route matching is separate from route handling.** `routes.ts` declares what
  each path answers; `server.ts` enforces those declarations and calls the
  handler. No handler re-implements a 405, a 403, or a Host check, and no
  handler is a closure over the server — each is a named export that takes a
  `RouteContext`, so it can be called directly in a test with no socket.
- **Every route declares its methods; there is no "answers anything".** `Route.
  methods` is a required list, so a route cannot fall open by omission — an
  unlisted method is always a 405 with an `Allow`. Ten read routes carried a
  `null` here (inherited from the if-chain, which never method-checked them) and
  answered `DELETE`/`PATCH` with 200 and a full payload. They are `GET, HEAD`
  now. HEAD stays because Node drops the body itself, so it already worked;
  removing it would have traded a fall-open for a regression.
- **A CLI/GUI parity claim is a shared function, never a comment.** Where a
  route answers the same question as a CLI verb, both call one module:
  `/api/value` and the value commands compose `src/value/report.ts`;
  `/api/pricing` and `pricing --coverage` compose `src/cost/coverage.ts`. This
  repo has already paid for the alternative — five comments in the dashboard
  asserting its arithmetic matched the CLI's, which is asserting, not enforcing.
  A new route that restates a CLI computation inline is the defect.
- **A request the asset path cannot parse is a miss, never an exception.**
  `static.ts` reads the operator's disk, so it is reachable with input no other
  route sees. `decodeURIComponent` throws on a malformed escape (`%ZZ`, a
  trailing `%`, a truncated multi-byte sequence), and unguarded that URIError
  left the request handler as an **uncaught exception and ended the process** —
  one `<img src>` on any page the operator visited stopped their dashboard.
  Anything that fails to decode returns `false` and 404s. A new parsing step
  here inherits the same rule.
- **No route answers `OPTIONS`.** The CSRF gate above is worth exactly as much
  as this server's refusal to answer a preflight, so OPTIONS 405s like any other
  unserved method — a 405 carries no `Access-Control-Allow-Origin`, and no
  browser reads it as permission to send the real request. Adding an OPTIONS
  responder is the one change that could undo `localOnly` without touching it.
- **`Allow` headers are part of the response contract.** They are pinned to
  their historical values by test, including `/api/settings` advertising
  `GET, POST` while serving only GET. Correcting one is a behaviour change.
  `test/dashboard-routes.test.ts` keeps two pinned maps — inherited values in
  `HISTORICAL_ALLOW`, the newly-restricted reads in `READ_ONLY_ALLOW` — and
  asserts they together account for every route, so a new path cannot ship
  without a deliberate decision about which methods it answers.
- **The browser app never imports node code, and the server never imports the
  browser app.** Enforced structurally: `app/tsconfig.json` has the DOM lib and
  no node types, and the root configs exclude `app/**`.
- **Asynchronous evidence is announced.** Modern loading/error states expose
  status/alert semantics, and the classic view exposes current navigation/range
  state plus a text alternative for the spend chart. Source contracts improve
  the baseline, but they do not replace exact-candidate browser and screen-reader
  verification in the release gate.
- **A claim's meaning is derived, not fetched.** `claimLayers.ts` turns four
  payloads into four claims as a PURE function; `chain.ts` only reads the
  endpoints. The claims are where this product commits itself, so they must be
  reachable from a test with no socket and no ledger — the realized band spent a
  release rendering a cost, and the only thing that could catch it was a grep.
  A `null` payload means "that endpoint did not answer" and degrades exactly one
  layer, which is why a dead endpoint reads as missing evidence, never as zero.
- **Every claim answers all six evidence dimensions, and no claim is dated by
  another claim's evidence.** `ClaimInspection` requires provenance, scope,
  freshness, coverage, enforceability and evidence source; where one is not
  established the string says so, because a blank renders identically to a
  dimension nobody thought about. Freshness is a recorded instant or the words
  "not established" — never `new Date()`, which would report the age of the
  screen. `/api/allocation` carries the BILLING reconciliation as a deliberate
  cross-reference; reading it as allocation freshness dated a claim with zero
  runs by a provider reconciliation, and belongs in `assumptions` instead.
- **The browser's declared payload types are the wire's, and are corrected
  against it.** The app compiles against hand-written interfaces — it cannot
  import the node source that builds the payload — so a wrong declaration
  type-checks perfectly and fails silently at runtime. Two shipped that way:
  `reconciliation.runs` declared a number while the server sent an array (so
  `runs > 0` coerced through `NaN` and the Billed band could never light up),
  and a phantom `reconciliation.latest` the Evidence view read forever. A field
  that is on the wire and undeclared is the same defect facing the other way —
  it forces a cast. Presence-checking contract tests do not cover this; the
  shape does, against a record that actually exists.
- **Overlays mount once, on `body`, outside the shell's render root.** The shell
  effect re-runs on every register change and `render(root, …)` clears `#app`.
  Mounting inside it appended a fresh host and a never-disposed effect per
  toggle, so the panel was rebuilt N times into detached elements. Anything that
  reads `isPrecise()` inside a host effect is rebuilt in place, so its listeners
  and focus traps release through `onCleanup` — which runs before the next run —
  and never through a nested effect watching for close.
- **View effects are scoped to their rendered region.** View factories use
  `scopedEffect`, which registers their disposer with the active render binding;
  navigation therefore tears down fetch subscriptions. The Metered range fetch
  also aborts/sequence-checks stale responses and rejects a payload whose
  declared range differs from the selected range.
- **The Claim Inspector reads and never acts.** The drawer owns everything that
  changes state. A panel that argues the evidence and offers the button in the
  same box is the shape of every tool this one exists to disagree with.
- **`demo: true` must reach the screen.** Any payload that can be seeded is
  rendered with its demo banner. A screen that cannot say it is showing sample
  data is the one lie this product cannot afford.
- **Import specifiers must be relative and end in `.js`.** `tsc` type-checks the
  source tree while the browser resolves the emitted one, so a specifier that is
  fine for the compiler can still 404 in the browser. Pinned by test.
- **Adding a CLI verb means adding a registry row.** Otherwise the parity table
  silently overstates coverage, which is the exact failure mode this product
  exists to refuse.

## Verify

```bash
npm run build && npm test -- --test-name-pattern="dashboard|GUI"
```

The build must run first: three of these tests read the emitted `dist/` tree,
because that is what a browser actually loads.
