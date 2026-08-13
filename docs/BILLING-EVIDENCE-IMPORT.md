# Provider billing evidence import (v1)

This is Fiscus's first financial-truth building block: a **local, immutable
ledger for operator-supplied OpenAI provider-cost evidence**. It is not a
provider connector, an invoice parser, or a reconciliation result.

It exists because these are different claims:

```text
Fiscus metered estimate != provider-reported cost != reconciled billing total
```

Fiscus keeps them in separate tables and exports. Importing billing evidence
does not alter a request's local rate-card evidence, proxy caps, RoI, model
routing, or `fiscus today` totals.

## Use it

The command reads a local JSON file only. It makes no network requests, accepts
no credential flags, and stores only the file digest plus allowlisted normalized
charge fields by default.

```powershell
# Validate and preview; the default performs no write.
fiscus billing import --file .\openai-costs.fiscus.json

# Write immutable evidence after reviewing the preview.
fiscus billing import --file .\openai-costs.fiscus.json --apply

# Inspect or extract the separate evidence ledger.
fiscus billing status
fiscus billing export --csv --out .\fiscus-provider-cost-evidence.csv
fiscus billing export --json
```

## Optional local route-scope declaration

Before a customer grants access to a provider account, an operator can make a
small, auditable **local routing declaration** for future proxy traffic:

```powershell
# Preview only; no database write.
fiscus billing scope set --account-ref finops-production --project-ref proj_123

# Activate after checking the displayed configured endpoint and local references.
fiscus billing scope set --account-ref finops-production --project-ref proj_123 --apply
fiscus billing scope status
fiscus billing scope clear --apply
```

The declaration stores non-secret local references, a sanitized configured
OpenAI upstream display, and a SHA-256 endpoint fingerprint. It applies only
to **new** requests entering the Fiscus proxy on the OpenAI route whose resolved
configured upstream exactly matches that fingerprint. Those rows receive the
immutable status `declared_unverified` and a declaration ID. A changed endpoint,
no active declaration, or a non-OpenAI proxy route is `unscoped`; native
Claude/Codex/OpenCode imports are `not_observed`; pre-feature history stays
`legacy_unknown`. Clearing a declaration affects future rows only.

This is not proof of account ownership, an API login, a provider project
assignment, invoice coverage, or request-level cost. It never reads credentials,
changes the configured upstream, sends a request to a provider, changes caps,
or turns a billing import into reconciliation.

`billing status` always reports `not_reconciled` in v1. A local request record
does not yet hold a verified OpenAI billing-account or provider-project binding,
so Fiscus has no defensible basis to calculate an apparent variance between the
two datasets.

## Strict JSON contract

V1 supports one explicit normal form, rather than trying to guess the meaning
of every provider CSV, PDF, browser export, or API response. This prevents a
provider-format change from becoming a silent financial transformation.

```json
{
  "schemaVersion": 1,
  "source": {
    "system": "operator-export",
    "provider": "openai",
    "exportId": "openai-costs-2026-08-01",
    "billingAccountRef": "acct-example-001",
    "exportedAt": "2026-08-02T09:00:00Z",
    "periodStart": "2026-08-01T00:00:00Z",
    "periodEnd": "2026-09-01T00:00:00Z",
    "coverage": "partial"
  },
  "records": [
    {
      "sourceRecordId": "provider-stable-line-id",
      "observedAt": "2026-08-02T09:00:00Z",
      "chargePeriodStart": "2026-08-01T00:00:00Z",
      "chargePeriodEnd": "2026-08-02T00:00:00Z",
      "service": "api",
      "sku": "model-usage",
      "model": "gpt-5",
      "region": null,
      "providerProjectRef": "proj_example",
      "chargeType": "usage",
      "currency": "USD",
      "amount": "12.345678",
      "usageUnit": "tokens",
      "usageQuantity": "1234567"
    }
  ]
}
```

All object fields shown are required; unknown fields are rejected. Timestamps
must be UTC ISO-8601 strings. Each charge period must be within the source
period. V1 supports USD only and represents `amount` as a decimal **string**
with at most six fractional digits, stored as integer microdollars. JSON number
amounts are rejected to avoid binary-floating-point rounding.

`billingAccountRef` is a non-secret local reference chosen by the operator. Do
not put an API key, bearer token, full billing statement, or sensitive customer
identifier in it. `coverage` is `complete`, `partial`, or `unknown`; it is a
declaration by the local importer, not something Fiscus can verify from a file.

Use `usage`, `credit`, `discount`, `tax`, `adjustment`, `commitment`, or `other`
for `chargeType`. Keep credits, discounts, and adjustments as separate signed
records—do not net or delete them before import.

## Provenance, idempotency, and retention

For every successful import Fiscus retains the file basename, SHA-256 digest,
size, import time, schema/importer version, source export ID, provider/account
reference, source period, coverage declaration, and record counts. It does not
retain the raw evidence file by default; the operator must retain the original
file if it may be needed later.

Each normalized charge line has the natural identity:

```text
source system + provider + billing account reference + source record ID
```

- Re-importing the byte-identical file is a no-op.
- A later file may repeat an unchanged line; Fiscus records the import run but
  does not double-count the line.
- The same natural identity with different normalized content is a hard conflict
  and the entire new import is rejected. Represent a provider correction as a
  new provider record (usually a credit or adjustment); never overwrite an old
  record.

The CSV export protects text cells beginning with spreadsheet formula markers.
It preserves source IDs, hashes, account scope, period, signed amount, cost
basis (`provider_reported`), and trust (`operator_supplied_unverified`).

## What comes next—and what is required first

The first authenticated connector should be a customer-authorized, read-only
OpenAI Organization Costs import. It needs an organization owner to explicitly
provide an Admin API credential in a customer-controlled environment; a normal
model-serving key must not be reused. That connector must retain cursor/page
state, source scope, collection time, raw-evidence digest, connector version,
and partial/failure state.

Reconciliation needs more than a report total. Fiscus must establish a verified
provider-account/project mapping for captured local traffic, a compatible
period/timezone/currency/service grain, coverage rules, and the treatment of
credits, discounts, tax, commitments, and billing lag. Until then a provider
report is correctly displayed as provider-declared evidence—not invoice-closed
cost, not request-level truth, and not a recommended budget action.
