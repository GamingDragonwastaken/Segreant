# Security Policy

## Supported versions

Fiscus is pre-1.0. Security fixes are made on the current `main` branch. Until a
stable release line exists, older commits are not maintained as supported
security branches.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability that could expose local
credentials, source material, billing data, or permit unintended local mutation.
Use GitHub's private vulnerability reporting for this repository when available.
If private reporting is unavailable, open a public issue containing **no exploit,
secret, personal path, or sensitive payload** and ask the maintainer for a private
contact channel.

A useful report includes the affected commit, platform and Node version, the
trust boundary crossed, minimal reproduction steps, and whether the issue needs
local access, browser access, provider credentials, or a team-server deployment.

## Security model

Fiscus is local-first, not offline-only. Proxy traffic goes to the provider the
operator configured, and explicitly invoked features can perform other outbound
requests. The canonical disclosure is `docs/DATA-BOUNDARIES.md`; security reports
should be evaluated against that document rather than a generic "no network"
assumption. `docs/THREAT-MODEL.md` states the assets, trust boundaries, and
adversaries this repository designs against, and what a signature or the
append-only store does and does not guarantee.

## In scope

- **Budget/config fail-closed behavior.** Malformed or unenforceable budget
  configuration, an oversized or malformed dashboard settings body, or a ledger
  read/write failure must refuse further provider forwarding rather than
  silently allow an unlimited or unmetered path (`CLAUDE.md` rule 5). A report
  that finds a path where invalid state does not stop the proxy circuit is a
  security bug.
- **The egress policy boundary.** Any way to reach a non-loopback destination,
  bypass an egress rule, or exfiltrate a credential/prompt/ledger row through a
  path not listed in `docs/DATA-BOUNDARIES.md`'s declared-egress table.
- **Team-server authentication and authorization.** `team-server/`'s OIDC
  discovery, token validation, and role checks — see `docs/TEAM-TIER-DESIGN.md`
  for the intended model and `docs/RELEASE-GATE.md`'s separate team-server gate
  for what is and is not validated against real infrastructure today.

## Not a vulnerability

- **The local dashboard binding to loopback.** This is the intended boundary,
  not an incomplete one; see `docs/DATA-BOUNDARIES.md`. It is expected to
  reject non-local `Host` values, make no external browser requests, and
  require the `x-fiscus-local: 1` header on mutating routes. A GET endpoint
  that mutates persistent state, or a way to reach the dashboard from a
  non-loopback origin, *is* in scope above.
- Proxy traffic reaching the AI provider the operator configured — that is the
  product's function, not a leak.
- The team server lacking a production-hardened deployment (TLS termination,
  secrets rotation, real PostgreSQL validation): tracked as open infrastructure
  work in `docs/RELEASE-GATE.md`'s separate team-server gate, not a
  vulnerability report against this repository.
