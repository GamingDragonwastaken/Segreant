# Changelog

Fiscus is pre-1.0. This repository carries no tag and no GitHub release, so
everything below is unreleased. This file records user-visible changes from the
point at which release discipline was formalized; Git history remains the
authoritative record for earlier development, and `docs/RELEASE-GATE.md` remains
the release authority — an entry here is not release evidence.

The format follows Keep a Changelog and releases will use Semantic Versioning.

## [Unreleased]

### Security

- The local dashboard no longer exits on a malformed percent-escape in an asset
  path. `decodeURIComponent` threw a `URIError` out of the request handler with
  nothing to catch it, so any page the operator visited could stop Fiscus with a
  single `<img src>`. A path that does not decode now 404s.
- `GET /api/scan` no longer writes. It recorded its own filesystem walk as the
  new scan baseline, which made it the one store write reachable without the
  `x-fiscus-local: 1` header — and destroyed the drift it had just reported. The
  baseline now advances only on the guarded `POST`.
- Read-only dashboard routes answer only the methods they serve. Ten of them
  previously answered anything, so `DELETE /api/value` returned 200 and a full
  payload; they now return 405 with an `Allow` header. No route answers
  `OPTIONS`, which is what keeps the same-origin header gate meaningful.

### Fixed

- The Return on Intelligence index is no longer described as an upper bound on
  the real conversion. An observed-only, renormalized index is not a ceiling:
  measuring a missing lens can move it either way. `instrumentationInterval`
  reports a partial-identification interval that evaluates unknown lenses at
  their admissible endpoints 0 and 1 under the full four-lens weight vector, and
  the observed-only score is reported alongside as the different quantity it is.
- The Impact lens is no longer reconstructed from the `merged` / `shipped` /
  `survived` verdicts that already determine Realization, which had made a lens
  sold as orthogonal move with the one it was meant to be independent of. Impact
  now requires an explicit orthogonal outcome signal or reports as
  uninstrumented.
- Amounts below one cent no longer render as `$0.00`. A $0.0020 soft threshold
  read as "no warning set" directly beneath a server alert quoting the real
  figure. Sub-cent amounts now carry two significant figures.
- The Control view reads the budget configuration by the field names the server
  actually sends, so a configured cap is no longer reported as absent and a
  cap-setting action is no longer accepted and silently discarded.
- The Realized band of the four-claim spine no longer renders attributed spend
  where it claims to report produced value. Both quantities are spelled
  `realizedValueUsd` on the payload and only their definitions distinguish them.

### Changed

- `npm test` builds what it needs. Two GUI tests read built output and failed on
  a clean checkout unless `npm ci` had already run; a `pretest` step declares
  that dependency instead of inheriting it from an install side effect.
- The CLI and the dashboard compose value through one shared sequence rather
  than assembling the same primitives independently in two places.

### Repository

- Added security, contribution, pull-request, issue, and dependency-update
  policy surfaces for public maintenance.
