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
      registry.ts    THE PARITY MAP — every capability, tier, coverage
      actions.ts     preview/commit builders per capability
    components/
      drawer.ts      the action drawer: preview → consequence → command → commit
    views/           one per territory
```

## Guarantees

- **The GUI reaches for CLI parity, and says where it has not.** `registry.ts` is
  the single source for navigation, action cards, and the parity table rendered
  in System. A capability with no screen is visible in the product as unbuilt.
- **Nothing happens without a preview.** Every action opens the drawer, which
  states the consequence in words, shows the computed preview, prints the
  equivalent command, and only then offers the commit.
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
- **Mutating routes require `x-aegis-local: 1`.** A cross-origin page cannot set
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
