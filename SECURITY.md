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
assumption.

The local dashboard is expected to bind to loopback, reject non-local Host values,
make no external browser requests, and require the `x-aegis-local: 1` custom
header on mutating routes. A GET endpoint must not mutate persistent state.
