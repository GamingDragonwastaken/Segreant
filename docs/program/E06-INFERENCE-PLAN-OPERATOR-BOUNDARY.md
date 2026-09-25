# WP-E06 operator-facing inference-plan boundary

The inference ledger and precision planner already persist immutable
pre-registration plans and count reported looks. D-279 adds the missing
operator setup surface:

```text
segreant causal plan --study <study-id> --options <file> [--apply] [--json]
```

The default is a pure preview. It validates the plan and prints the planned
act count and required per-act alpha without opening a Store or creating a
study. `--apply` calls the existing Store-owned immutable registration boundary
and therefore refuses an unknown study, invalid plan, replacement, or any
registration after an inferential act. The plan is registered before the first
look; later reporting uses the same persisted family.

Focused CLI coverage is 1/1 for preview, while the Store persistence tranche
remains green. This closes the operator setup remainder only.

## Still open

The ledger remains per-study. Cross-study family registration, correlation-
adjusted multiplicity, and a probability/power claim for precision remain
deliberately unimplemented. Width planning is not power planning, and a
conservative count-based union bound is not a correlation model.

