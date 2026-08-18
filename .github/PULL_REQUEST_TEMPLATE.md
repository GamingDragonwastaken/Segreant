## What changed

<!-- Describe the smallest coherent change. -->

## Why

<!-- Root cause / decision and the user or operator consequence. -->

## Truth and data boundaries

- [ ] Metered, billed, allocated, and realized figures remain distinct.
- [ ] Unknown provenance remains unknown.
- [ ] No new egress or credential access, or the data-boundary docs were updated.
- [ ] Read/preview paths remain non-mutating.

## Validation

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build` when build/package/UI behavior changed
- [ ] Regression test added for a correctness fix
- [ ] Packaged/runtime smoke checked when applicable

## Remaining limits

<!-- Name anything this PR does not prove. Do not turn an unverified assumption into a claim. -->
