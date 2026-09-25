# Threat model

This states what Segreant defends, against whom, and what its integrity
mechanisms do and do not prove. It is a companion to
[`DATA-BOUNDARIES.md`](DATA-BOUNDARIES.md) (what may leave the machine) and
[`SECURITY.md`](../SECURITY.md) (how to report a break of either).

## Assets

- **The local ledger** (`~/.segreant/segreant.db`) — metering rows, cost/pricing
  lineage, budget state, allocation and reconciliation history
  (`src/store/CONTEXT.md`).
- **Provider credentials in flight.** Segreant proxies them to the configured
  upstream but does not store them (`docs/DATA-BOUNDARIES.md`).
  `x-segreant-openai-base` is deliberately ignored so a request cannot redirect a
  caller's credential to an attacker-chosen destination.
  `OPENAI_ADMIN_API_KEY`, read only for an explicit applied
  `billing openai-costs pull`, is never persisted, printed, or logged.
- **Locally captured evidence with disclosure risk of its own** — `requests.cwd`,
  `requests.user`, `git_commits.subject`, `proposals.files_json`,
  `scan_snapshots.repos_json` — enumerated and justified in
  `docs/DATA-BOUNDARIES.md`.
- **The egress receipt chain** (`egress-receipts.*`) — the local record that an
  outbound request was policy-checked before it was dialled.
- **`.segreantpack` bundles and their signatures** — portable evidence bundles
  (`docs/program/PACKET-INVENTORY.md`'s `WP-G05` row; `signSegreantPack()` /
  `verifySegreantPack()`).

## Trust boundaries

Per `docs/DATA-BOUNDARIES.md`: the Segreant process boundary is what this
document and its egress-rule table govern. Outside it — the configured AI
provider, the operating system, other local processes, a machine
administrator, a browser extension in the operator's browser — is explicitly
**not** covered. "Local-first" is a claim about Segreant's own defaults, not a
machine-wide isolation guarantee.

## Adversaries considered

1. **A malicious or compromised local process on the same machine**, competing
   for the SQLite file, the publication lock, or the egress receipt chain.
   `docs/program/DECISION-LOG.md` records lock-contention and
   quarantine-rename hardening (D-072 and its follow-ups) found this way.
2. **A network attacker between the proxy and the configured upstream**,
   attempting to redirect traffic to a different destination or read a
   credential in transit. Mitigated by DNS-pinned egress, refusing
   non-loopback targets in `local_locked` mode, and stripping `Location` from
   upstream redirects before returning the response.
3. **A malformed or adversarial configuration/settings payload**, attempting to
   disable budget enforcement or the egress policy by making persistence fail
   in an unsafe direction. Mitigated by `CLAUDE.md` rule 5: invalid persisted
   state must stop provider forwarding, never fall open.
4. **A tampered ledger or receipt file**, attempting to hide a prior
   observation or forge a chain of custody. See "What signatures do not prove"
   below for the limit of what this defends against.
5. **An operator who misreads a derived figure as a different kind of claim.**
   Not a network adversary, but the failure this product has produced most —
   see `CLAUDE.md`'s four-claims rule and `docs/program/DECISION-LOG.md` for
   the recorded collapses.

## What the append-only store and signatures guarantee — and do not

- **Append-only + trigger protection detects tampering by a normal writer,
  not by an administrator.** `src/store/CONTEXT.md` and D-113 cover adversarial
  schema-integrity regression for tampered triggers. Anyone with filesystem
  write access to the SQLite file and the privilege to disable or rewrite a
  trigger is outside this guarantee — the same limit `docs/DATA-BOUNDARIES.md`
  states for the egress receipt chain ("an administrator who can rewrite both
  the receipt file and the running process is outside the guarantee").
- **A signature proves the bundle was not altered after signing and, with a
  supplied trust anchor, who signed it. It does not prove the claims inside
  the bundle are true.** `.segreantpack` embedded-key verification is
  integrity-only unless the caller supplies a matching trust anchor
  (`PACKET-INVENTORY.md`'s `WP-G05` row) — **signature != truth**, the same
  distinction the money-claims rule draws for cost figures.
- **A digest chain proves the receipt history has not been silently truncated
  or reordered since last verified, not that every permitted request was
  benign.** Verification streams and re-validates the whole history; a missing
  file is the only genesis case, and a present-but-invalid one fails closed
  rather than being treated as a fresh chain.
- **`legacy_unknown` and other provenance sentinels are an honest gap, not a
  security control.** A row recorded before a lineage column existed says so
  and is never backfilled (`CLAUDE.md` rule 2) — this protects against a false
  provenance claim, not against a determined attacker.

## Mitigations, with file pointers

| Threat | Mitigation | Where |
| --- | --- | --- |
| Credential redirected to an attacker-chosen destination | `x-segreant-openai-base` ignored; egress refuses non-loopback targets before DNS in `local_locked` mode | `docs/DATA-BOUNDARIES.md` |
| Invalid config silently disabling budget enforcement | Budget/settings persistence fails closed | `CLAUDE.md` rule 5, `docs/RELEASE-GATE.md`'s "Budget fail-closed integrity" row |
| Upstream redirect used to exfiltrate a follow-up request | `Location` stripped from proxied redirect responses | `docs/DATA-BOUNDARIES.md` |
| Publication-lock race between two Segreant processes | Stale-lock detection requiring no active writer before removal | `docs/program/DECISION-LOG.md` (D-072 and follow-ups) |
| Tampered append-only trigger | Startup integrity check against configured pragmas and trigger authority | `src/store/CONTEXT.md`, D-113, D-139 |
| Forged or altered `.segreantpack` bundle | Canonical-bytes signing/verification, separate integrity/authenticity/truth outcomes | `docs/program/PACKET-INVENTORY.md` `WP-G05` |
| A rollup over-claiming its coverage | Explicit `RollupScope`, server-side containment re-check (never trusts the client) | D-199 |

## Gaps — open packets, not silent holes

- **Runtime sandboxing of plugins is not enforced.** `WP-G03` (Plugin
  isolation) is `PARTIAL`: filesystem, direct-network, credential-access, CPU,
  memory, and descriptor hard limits remain explicitly unenforced.
- **An independent `.segreantpack` verifier does not exist yet.** `WP-G06` is
  `NOT_STARTED`.
- **The team server has no production security review.** TLS termination,
  secrets rotation, real PostgreSQL/OIDC validation, and k-anonymity against
  repeated queries are enumerated as unmet infrastructure requirements in
  `docs/RELEASE-GATE.md`'s separate team-server gate.
- **A machine administrator, or anyone with local filesystem write access to
  the ledger, receipt chain, or a `.segreantpack` file plus its trust anchor, is
  outside every guarantee above.** This is stated once here rather than
  repeated per row, because it is the load-bearing limit of a local-first
  design: Segreant defends against a hostile network and a malformed input, not
  against the machine's own owner or root.
