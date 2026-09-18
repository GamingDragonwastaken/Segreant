# Support

## Where to ask

GitHub Issues on this repository. There is no other support channel — no
email, no chat, no forum — and creating one is an owner decision
(`GOVERNANCE.md`).

## No SLA

This is maintained by a single maintainer as documented in `GOVERNANCE.md`.
There is no response-time or resolution-time commitment, for a bug report, a
question, or a security report (`SECURITY.md` covers the vulnerability path
specifically).

## What a useful report contains

- The exact command run, or the GUI action taken.
- Fiscus version (`fiscus version`) and Node version (`node --version`).
- The `git rev-parse HEAD` of the checkout, if built from source.
- What you expected versus what happened, including exact output where
  possible.
- Whether the issue needs a provider credential, browser access, or a
  team-server deployment to reproduce.

Run `fiscus diagnostics` (redacted local runtime/database/egress diagnostics —
see its `--json` output for the full field set) and attach its output when the
report concerns metering, budget enforcement, or egress behavior. It reads
local state only and does not contact a Fiscus-operated service.

## What is not support

Feature requests and design discussion are welcome as issues but are judged
against `PRODUCT.md` and the open items in `docs/program/PACKET-INVENTORY.md`,
not guaranteed a response or a timeline. A request that asks the maintainer to
interpret your own financial or budget data is out of scope — see
`PRODUCT.md`'s "not AI financial advice" line — and will be redirected there.
