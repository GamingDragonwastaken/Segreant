# Cost-Centre Allocation

The third layer of the truth chain:

```text
metered usage != provider-billed cost != ALLOCATED COST != realized business value
```

Allocation answers a question no other layer does: **who has an organization
decided owns this money?** That is not the same question as which folder the
spend arrived under.

---

## 1. Attribution is not allocation

| | Attribution | Allocation |
| --- | --- | --- |
| Answers | Which project label did this spend arrive under? | Which cost centre owns it? |
| Source | A header, a base-URL prefix, or a tool's recorded working directory | A rule an operator wrote |
| Provenance | `attribution_basis` — how reliably the label was obtained | `rule_id` + `version` — which policy placed it |
| The gap | `default` = nobody declared a project. An **instrumentation gap**. | `unallocated` = no rule claimed it. An **accounting position**. |

The two gaps look similar on a dashboard and are completely different problems.
`default` is fixed by instrumenting a tool. `unallocated` is fixed by an
organization deciding something. Conflating them is how a folder name becomes a
chargeback.

Allocation **never** rewrites a project label, never modifies a request row, and
never writes back to the ledger. Every figure it produces is derived and
re-derivable from immutable source rows.

---

## 2. Cost centres

```bash
fiscus alloc centre eng --name "Engineering" --owner cto
fiscus alloc centre platform --name "Platform"
fiscus alloc centres
fiscus alloc centre platform --archive
```

Archiving retains the centre so past runs stay explicable. Spend a rule still
aims at an archived centre is reported as `target_cost_centre_archived` rather
than silently dropped or silently delivered.

---

## 3. Rules

```bash
# Everything in one project goes to one centre.
fiscus alloc rule backend --method direct --centre eng \
    --match-project backend-api --priority 10

# A shared project splits by declared ratio.
fiscus alloc rule web --method fixed_split --centre "eng:0.5,platform:0.5" \
    --match-project web-frontend --priority 11

# A shared pool follows whoever was directly allocated.
fiscus alloc rule infra --method proportional_to_direct --centre shared \
    --match-project shared-infra --priority 50

fiscus alloc rules
fiscus alloc revoke infra
```

Match on any of `--match-project`, `--match-provider`, `--match-model`,
`--match-source`, `--match-user`. An omitted field is a wildcard. Lower priority
wins; ties break on rule id, so a run is deterministic and never depends on
insertion order. **First match wins** — a request is claimed once.

### The three methods

| Method | Behaviour |
| --- | --- |
| `direct` | The whole matched slice goes to exactly one centre |
| `fixed_split` | Splits by declared ratios, which must sum to exactly 1 |
| `proportional_to_direct` | A shared pool, split in proportion to what each centre was *directly* allocated in the same period |

`proportional_to_direct` derives its shares, so declared ratios are refused
rather than accepted and ignored — a number the author believes and the engine
discards is worse than an error.

**A pool with no driver stays unallocated.** If nothing was directly allocated in
the period, there is nothing for the pool to follow, and splitting it evenly
would invent the very driver the method exists to read.

### Ratios are exact to six decimal places

Ratios are summed in integer parts per million, never as floats. A consequence
that looks like a bug and is not: **an exact third is refused**, because
`1/3` is not a six-decimal ratio. Write `0.333333, 0.333333, 0.333334`.

Three equal shares of an odd number of microdollars cannot all be equal, and
someone has to absorb the remainder. Forcing that into the policy makes it
auditable instead of letting the engine choose silently. (The *dollars* are then
distributed by largest remainder, so the declared ratio and the paid amount stay
independent questions.)

### Versions and reversal

Editing a rule creates a **new version**. The previous version keeps its method,
match, targets, and ratios exactly as authored, and is closed at the new
version's effective date:

```text
backend v1  p10  direct  project=backend-api  →  eng       [superseded]
backend v2  p10  direct  project=backend-api  →  platform
```

Rules are matched against **the instant the spend happened**, not the instant the
run is computed. Re-running a closed period after editing a rule therefore
restates nothing: the old period still allocates under the version that was
actually in force. Revoking retains the row and stops it applying from the
revocation instant forward.

---

## 4. Running a period

```bash
fiscus alloc run --from 2026-08-01 --to 2026-09-01
fiscus alloc run --from 2026-08-01 --to 2026-09-01 --apply    # record it
fiscus alloc run --from 2026-08-01 --to 2026-09-01 --json
```

```text
     $53.600093   66.2%  eng                      mixed
     $10.920221   13.5%  data                     local_list_price
      $7.198233    8.9%  platform                 local_list_price

     $71.718547   88.6%  allocated
      $9.195772   11.4%  unallocated
     $80.914319          ledger total for the period

  Why it is unallocated
       $9.195772  no matching rule
                  mostly: default ($8.940961), notebooks ($0.246742)
```

Read-only by default; `--apply` records an immutable derived run. Re-running
produces a *new* record, never an edit.

### Unallocated is an output, not a failure

| Reason | Meaning |
| --- | --- |
| `no_matching_rule` | No rule in force at that instant claimed it |
| `no_driver_for_proportional_pool` | A shared pool matched but nothing was directly allocated |
| `target_cost_centre_archived` | The rule aims at a centre that has been archived |

Each bucket names its largest project labels, so an operator knows what to write
a rule for. A rule set that swept the remainder into a fallback would report
full coverage of an organization it had never described.

### Conservation is enforced, not asserted

`allocated + unallocated == ledger total`, to the microdollar. This is checked on
every run, shipped on the result as `conserves`, and the store **refuses to
record** a run where it is false. An allocation that lost or invented money is
not a record worth keeping — the whole value of this layer is that a budget
owner can add it up.

---

## 5. The basis travels with the money

Every allocation line carries the `cost_basis` of the rows underneath it —
`local_list_price`, `fallback_estimate`, `tool_reported_unverified`, `mixed`, and
so on — and the run reports the distinct bases beneath it as a whole.

This matters more than it looks. Allocating a local rate-card **estimate** is
legitimate: an organization can decide who owns an estimate. Allocating one while
presenting it as settled cost is not. Since the basis is attached to the money,
a showback figure cannot forget what it is made of.

The run's trust label says so outright: `derived_allocation_of_local_estimates`.
It does not upgrade itself on the strength of a well-written rule set.

**Reconcile before you charge anyone.** See
[PROVIDER-RECONCILIATION.md](PROVIDER-RECONCILIATION.md) — a residual you have
not looked at is a residual you would be spreading across cost centres with a
decimal point on it.

---

## 6. What allocation never touches

```text
request_metered_spend · budget_enforcement · roi · model_recommendations
```

Budgets still enforce against live proxy metering. RoI still prices from the
request ledger. An allocation is a view for a budget owner, not an input to a
control. If any of those ever need to consume allocated cost, it will be a
separate, explicit decision with its own gate — not a silent promotion.

---

## 7. Not built yet, deliberately

- **No dashboard surface.** Who the viewer is — a budget owner, a team lead, an
  auditor — changes what the page should show, and shipping a half-considered
  card is worse than shipping none. The CLI and JSON are the interface for now.
- **No approval workflow.** Rules take effect when written. Versioning and
  reversal make that recoverable, but there is no second pair of eyes, and this
  is single-operator by design until the team tier is real.
- **No closed-period lock.** Nothing prevents re-running a period after new
  spend lands in it. Runs are immutable and timestamped, so the history is
  visible, but "closed" is a convention here rather than an enforced state.
- **No chargeback export.** Showback only. A chargeback format implies a
  settlement process this product does not have.
