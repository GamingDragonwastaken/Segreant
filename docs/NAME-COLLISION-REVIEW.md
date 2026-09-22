# Name collision review

**Date of this check: 2026-09-14.** This records exactly what a check of the
public npm registry and GitHub found for the name `fiscus`. It makes **no
rename recommendation** — that decision, and any action on it, is
owner-reserved (`GOVERNANCE.md`, `docs/RELEASE-GATE.md`'s "Required before
public npm/GitHub release" item 1: "Confirm the public package name/scope is
available and that the publisher account is authorized to use it").

## npm registry

The registry lookup for the bare name (`npm view` on it), run 2026-09-14, returned an **already-published package**:

```
fiscus@0.0.0 | UNLICENSED | deps: none | versions: 1
Programmable payment infrastructure for AI agents. Placeholder — package under active development.

keywords: fiscus, agent-payments, usdc, solana, mcp

maintainers:
- fiscuslabs <hello@fiscus.sh>

dist-tags:
latest: 0.0.0

published a month ago by fiscuslabs <hello@fiscus.sh>
```

Published (the registry `time` record, read with `npm view` and `--json`): `created` / `0.0.0` /
`modified` all `2026-07-23T02:23:27*Z` — roughly seven weeks before this check,
one version only. This is the exact bare name this repository's `package.json`
currently declares (`"name": "fiscus"`). The registered package's description —
"Programmable payment infrastructure for AI agents" — is in the same general
subject area (AI agents and money) as this project, which raises the
collision's salience above a coincidental homograph, though it targets a
different function (agent payment rails, not FinOps/metering).

Near names checked the same way, all returned `404 Not Found` (unregistered as
of this check): `fiscus-cli`, `@fiscus/cli`, `fiscusai`, `fiscus-finops`,
`get-fiscus`.

## GitHub

`https://api.github.com/search/repositories?q=fiscus+in:name`, run
2026-09-14 (unauthenticated, read-only): **101 total repositories** with
"fiscus" in the name. The highest-starred results, none dominant:

| Repository | Stars | Description |
| --- | --- | --- |
| `m4dd0c/fiscus-app` | 4 | "AI-powered platform ... to help families track, manage, and optimize their financial assets" |
| `a9na/fiscus` | 2 | "Web application for personal finance management Fiscus" |
| `dukiki/fiscus` | 1 | "The world's most advanced personal finance management system!" |
| `thomasjvalenzuela/fiscus-Ai-finance` | 1 | "AI-powered personal finance dashboard ... local-first storage" |
| `dhinojosa/fiscus` | 1 | "Dependency Injection Framework for Scala" (unrelated domain) |
| `Fiscus-fyi/*` (several repos) | 1 each | An org named `Fiscus-fyi`, unrelated crypto/NFT projects |

No repository in the results exceeds single-digit stars, and none is an
official trademark holder, standards body, or clearly the origin of the name
in this space. Several are personal-finance or AI-finance projects with
overlapping subject matter to this one, at low visibility.

## What this establishes, and what it does not

- **The bare npm name `fiscus` is unavailable today** and has been since
  2026-07-23 — publishing this project under that exact name would require
  either a scoped package (`@org/fiscus`) or a different name, an owner
  decision.
- The GitHub name space has many low-visibility uses of "fiscus" and
  "fiscus-app" in adjacent (personal/AI finance) domains, but no entity with
  enough visibility to constitute an obvious trademark conflict was found by
  this check.
- **This is not a legal opinion.** It did not check registered trademarks,
  the USPTO or equivalent registries in other jurisdictions, or whether the
  npm maintainer `fiscuslabs` has any claim beyond registry-name-first-come.
- **What counsel would check that this review did not:** trademark
  registrability and existing registrations for "Fiscus" in relevant
  classes (software, financial services), the `fiscus.sh` domain's
  registrant and any live product there, whether `fiscuslabs`'s use
  constitutes prior use in commerce, and jurisdiction-specific
  common-law trademark exposure.
