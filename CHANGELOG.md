# Changelog

Fiscus is pre-1.0. This file records user-visible changes from the point at which
release discipline was formalized; Git history remains the authoritative record
for earlier development.

The format follows Keep a Changelog and releases will use Semantic Versioning.

## [Unreleased]

### Fixed

- Correct partial-instrumentation RoI semantics: an observed-only, renormalized
  index is no longer described as an upper bound; full-index identification bounds
  retain all four fixed weights.
- Keep dashboard scan previews read-only instead of advancing scan state on GET.
- Read provider reconciliation history from the immutable run collection the
  server actually returns.

### Repository

- Added security, contribution, pull-request, issue, and dependency-update policy
  surfaces for public maintenance.
