# Provider Reconciliation

Comparing what Fiscus metered against what the provider reports, at the only
grain where the two join, with the residual stated rather than removed.

This is Stage 1 of [AI-FINANCIAL-OPERATIONS-ROADMAP.md](AI-FINANCIAL-OPERATIONS-ROADMAP.md):
*one organization can compare Fiscus observations with one authoritative
provider cost source.*

---

## 1. What a reconciliation here is, and is not

**It is** a per-day comparison of two totals for one OpenAI project: the amount
the provider's Organization Costs API reported, and the amount Fiscus metered on
the route you declared belongs to that project. The difference is reported per
day with a structural reason.

**It is not** an invoice check, a per-request match, a proof that your route
declaration is true, or a measurement of your total AI spend. The result is
labelled `scope_conditional_reconciliation` and its status is
`reconciled_with_residual` — never `reconciled`. There is always a residual, and
a run that produced a difference of exactly zero would be more suspicious than
one that did not.

### Why project-day totals

The Costs API groups by **line item**, not by model or request. A line item does
not join to a request, and it never will. Attempting a per-request
reconciliation would require inventing an allocation of provider line items
across local requests, which is exactly the force-fitting this product exists to
refuse.

Summing a day's line items and comparing that single number against the same
day's metered total is a *compatible* join. It is coarse, and it is honest.

---

## 2. What it takes to run one

Declare the route scope, get a provider observation for a closed period, then
reconcile. `fiscus billing reconcile` prints exactly which step is outstanding,
so you never have to guess where you are.

**There are two routes to the observation, and they are not equal.**

| | Route A — direct pull | Route B — adopt an export |
| --- | --- | --- |
| Needs | an Admin key with the Costs read scope | nothing but a file you already have |
| Provider side obtained by | Fiscus, from the provider | you, then handed to Fiscus |
| Stamped | `provider_api_pull` | `operator_supplied_export` |
| Conditions on the result | 4 | 5 |
| Arithmetic | identical | identical |

Route A is better evidence and is the recommended path. Route B exists because
being blocked on a **credential** rather than on the **data** was the wrong place
to be stuck: minting an Admin key needs a different permission than reading a
bill, and an owner who can do the second should not be unable to reconcile.

What route B does *not* do is pretend. Nothing in an adopted export was obtained
from the provider by Fiscus, so nothing here can detect a report that was edited
before it was handed over. That fact is stamped on the observation, survives into
every reconciliation built on it, and appears as a fifth permanent condition.

### Step 1 — declare the route scope *(local)*

```bash
fiscus billing scope set --provider openai --base-url https://api.openai.com --account-ref org_yourorg --project-ref proj_yourproject --apply
```

This records your statement that traffic Fiscus proxies to that exact endpoint
belongs to that project. It is stored as `operator_declared_unverified`, because
that is what it is. Requests metered *after* this point carry the declaration;
earlier rows do not and are excluded from every comparison below.

The stored endpoint contains no credentials, query string, or fragment.

### Step 2 — create a least-privilege Admin key *(yours)*

In the OpenAI platform, create an **Admin key** restricted to reading
organization costs. Do not reuse an inference key, and do not grant write
scopes. Fiscus makes exactly one kind of request with it:

```text
GET https://api.openai.com/v1/organization/costs
```

That target is asserted in code before every request and the assertion fails
closed. Redirects are refused. There is no other endpoint, no other method, and
no write path anywhere in the connector.

### Step 3 — supply it for one command *(yours)*

```bash
OPENAI_ADMIN_API_KEY=sk-admin-… fiscus billing openai-costs pull --from 2026-07-01 --to 2026-08-01 --apply
```

The key is read from the environment at the moment of the pull and nowhere else.
It is never written to the database, the config, the logs, or any export. A
`preview` — the default — reads no credential and makes no network request; you
can confirm that with `--json` before ever supplying a key:

```bash
fiscus billing openai-costs preview --from 2026-07-01 --to 2026-08-01 --json
# → "networkAttempted": false, "credentialRead": false
```

What is retained from the pull: the daily project/line-item/currency groupings,
a SHA-256 digest chain over the response pages, the page count, and the fetch
time. Not the raw response, not the key, not prompt or request content.

### Step 3b — or adopt an export instead, with no credential *(route B)*

If you can download a costs report but cannot mint an Admin key, import it and
adopt it as the observation. Both commands are read-only until `--apply`:

```bash
fiscus billing import --file ./your-costs-export.fiscus.json --apply
fiscus billing openai-costs adopt                      # lists adoptable imports
fiscus billing openai-costs adopt --import-id <id>     # preview: what it would observe
fiscus billing openai-costs adopt --import-id <id> --apply
```

Adoption is strict about what it will observe, because the arithmetic downstream
is exact and a sloppy input would produce a confident wrong residual:

- **whole UTC days only** — the provider bucket grain is the only grain that
  joins to the local ledger. Anything hourly or monthly is refused, not resampled.
- **your declared project only** — lines for another project, and account-level
  lines with no project reference at all (credits, most commonly), are excluded.
- **exclusions are reported with their money**, never dropped. A silently
  discarded credit would understate the provider side and surface later as a
  residual that never existed.
- **single-currency USD** — the evidence schema already enforces this at import.

What is retained: the same daily groupings a pull would produce, plus the file's
SHA-256 as the digest of the single "page" that produced them. Not the raw file.

### Step 4 — reconcile *(local)*

```bash
fiscus billing reconcile
fiscus billing reconcile --apply     # persist it as an immutable derived run
fiscus billing reconcile --json --materiality 1.00
```

Read-only by default. `--apply` records the run so the history of what was
claimed when stays inspectable; a later provider snapshot produces a *new* run
and never edits an old one.

---

## 3. Reading the result

```text
Provider reported   $412.880000
Fiscus metered      $377.150000   (local rate-card estimate)
Unexplained         +$35.730000
```

The residual is the output, not an error. Its sign tells you which question to
ask:

| Sign | Reading |
| --- | --- |
| Provider > Fiscus | Usage reached that project without passing through Fiscus, or the local rate card under-prices it. The residual is an **upper bound** on off-path spend, not a measurement of it. |
| Fiscus > provider | The local rate card over-prices, the provider applied credits or discounts, the day is still lagging, or — the one worth checking first — the route declaration is wrong and this traffic belongs to a different project. |

Per-day reasons are structural and say nothing about cause:

| Reason | Meaning |
| --- | --- |
| `exact_match` | The two totals are identical to the microdollar |
| `provider_exceeds_local` | Both sides present, provider higher |
| `local_exceeds_provider` | Both sides present, Fiscus higher |
| `no_local_capture` | The provider reported spend on a day Fiscus metered none |
| `no_provider_report` | Fiscus metered spend on a day the provider reported none |

`materiality` only decides which days are *flagged*. An immaterial day still
reports its real difference and its real reason — a small difference is never
relabelled as a match.

### Snapshot stability

The Costs API documents no finality, so a single snapshot proves nothing about
whether a day has settled. Pull the same period twice, at least a day apart, and
the second reconciliation reports:

- `single_observation` — no independent snapshot exists; finality is unknown
- `stable_across_observations` — the two snapshots agree, day by day
- `changed_across_observations` — with the specific days that moved

This is *observed* stability. It is not the provider attesting anything.

### Refusals

A run refuses rather than producing a soft number when:

| Refusal | Why |
| --- | --- |
| `no_provider_observation` | No complete, successful snapshot exists |
| `observation_period_may_still_accrue` | The period ends within 48h; a variance now could be lag |
| `provider_currency_is_not_usd` | Local amounts are USD and no exchange rate is applied here |
| `provider_reported_multiple_currencies` | The snapshot mixes currencies; the local ledger is single-currency |

---

## 4. The conditions that never go away

Every result carries these four — and a fifth when the provider side was
adopted from an operator export rather than pulled. They are properties of the
method, not defects of your data, and an exactly-matching day does not earn a
cleaner label:

- **`local_route_scope_is_not_provider_verified`** — you declared that an
  endpoint maps to a project. Nothing in Fiscus checks that with the provider.
  Every number is conditional on that declaration being true. This is the one
  condition that could in principle be discharged, and doing so would require
  binding the proxy's API key identity to the project through the Admin API —
  a broader credential scope than this connector has, and a deliberate
  non-decision until there is a reason to make it.
- **`off_path_provider_usage_is_not_observable`** — anything that did not pass
  through Fiscus is invisible. It can only be inferred from the residual.
- **`provider_line_items_do_not_join_to_requests_or_models`** — the reason this
  compares day totals rather than requests.
- **`local_request_amounts_are_rate_card_estimates`** — Fiscus prices from a
  local rate card. The gap between that and the provider report is the subject
  of the comparison, not a flaw in it.
- **`provider_report_is_operator_supplied_and_unverified`** — *route B only.*
  The provider figures were supplied by a person, not read from the provider.
  Fiscus validated their shape and digested the file; it obtained nothing from
  the provider. This condition is absent on a pulled observation, so its
  presence is the signal, not boilerplate.

---

## 5. What a reconciliation never touches

A reconciliation run is a **derived, immutable record**. It does not modify the
request ledger, reprice anything, or change any stored amount. Its
`excludedFrom` list is enforced, not aspirational:

```text
request_metered_spend · budget_enforcement · roi · model_recommendations
```

Budgets still enforce against live proxy metering. RoI still prices from the
request ledger. A provider snapshot does not become a cap, and a variance does
not become a recommendation. If those ever need to consume reconciled cost, it
will be a separate, explicit decision with its own gate — not a silent
promotion.

---

## 6. Related

- [BILLING-EVIDENCE-IMPORT.md](BILLING-EVIDENCE-IMPORT.md) — the operator-supplied
  file path, for when an export exists but a credential is not on the table
- [DATA-BOUNDARIES.md](DATA-BOUNDARIES.md) — what leaves this machine, and when
- [AI-FINANCIAL-OPERATIONS-ROADMAP.md](AI-FINANCIAL-OPERATIONS-ROADMAP.md) — where
  this sits in the staged plan
- [VISION-AUDIT.md](VISION-AUDIT.md) — why allocation must not be built on top of
  this until the residual is understood
