# plans — which plan a tool runs on, and what the person pays for it

<!-- Layer 2 contract. The boundary between list-price work and a subscription's price. -->

## Consumes

- Claude Code's `~/.claude.json` (`oauthAccount`): `organizationType`, the
  rate-limit tier (for the Max multiple) and `billingType`. Nothing else.
- The newest Codex session log under `~/.codex/sessions`: the last
  `"plan_type"` in its final 512 KB.
- `config.plans` (`src/config.ts`): the monthly price the person entered with
  `segreant plan set`, validated on every load.

## Guarantees

- The plan is detected; the **price is never inferred**. A tool reporting
  "pro" does not set a price. Channel (App Store vs web), tax and annual
  billing change what a person pays, so only an entered price is a figure.
- `PUBLIC_PLAN_PRICES` exists to suggest a number when asking, carrying the
  date it was checked. It is never used in a calculation or shown as the
  person's price.
- Not found means `plan: null` with the reason in `evidence`. It is never a
  default plan.
- Every comparison names both bases: the plan price is "what you set", and the
  work is list cost "priced from the rate card".

## Invariants

- **Never read a credentials file.** `~/.claude/.credentials.json` holds
  tokens and is out of bounds, even though it also carries a subscription
  field.
- A detected plan carries plan fields only. No email, account id or
  organisation name leaves `detect.ts`.
- Prices in config are bounded (0 to 100,000 a month), limited to known tools,
  and shaped exactly. An invalid entry stops the config load (hard rule 5).
