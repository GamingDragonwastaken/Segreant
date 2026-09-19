# decision — conservative utility and evidence-acquisition rules

## Consumes

- finite utility intervals supplied by a caller's evidence/measurement layer;
- finite posterior scenario probabilities and conditional expected utilities;
- an explicitly declared measurement cost.

`currentExpectedUtilities` is an optional compatibility assertion only. The
scenario mixture is the sole authority for the prior: each action's prior
expectation is derived as the probability-weighted sum of its conditional
scenario utilities, and a supplied compatibility map must agree within the
documented tolerance. Utility magnitudes above `Number.MAX_SAFE_INTEGER` are
rejected so expected-value arithmetic cannot silently lose materially relevant
precision.

## Guarantees

- strict robust dominance is certified only when one action's lower bound clears every rival's upper bound;
- `decisionCountermodels` emits one explicit, actionable witness for each declared interval-certificate assumption; live witnesses withhold certification rather than becoming a recommendation;
- overlapping intervals remain `undetermined`;
- minimax regret and value of information identify their rule and assumptions;
- `buildDecisionKernelIssuance` is a side-effect-free preview; `issueDecisionToKernel` persists an explicit certificate bundle as immutable kernel Evidence with the decision-problem identity/version, action set, dependency IDs, rule, assumptions, dominance result, and validity/revalidation metadata;
- `readDecisionCertificateBundle` revalidates the stored bundle, checks its recorded dependencies, and applies the ledger's as-of revocation projection; a revoked prerequisite returns `invalidated` without deleting history;
- every persisted bundle has explicit `actionSemantics.mode: 'no_action'`, `permitted: false`, and a read result with `canAutoAct: false`; persistence and reads never execute, approve, route, or change a provider/model/budget;
- gross perfect-information value is non-negative under one coherent scenario
  mixture; measurement cost is applied only afterward;
- invalid, duplicate, non-finite, or mismatched inputs fail closed;
- ties are returned in deterministic action-identifier order.
- `control.ts` models shadow → simulated effect → canary → monitored expansion → full rollout and rollback as an immutable, preview-then-commit, revision-checked state machine; it never executes, authorizes, or persists an external action. Nothing calls `control.ts` from a product path, by decision (D-250): the product's one spend-changing action has its shadow phase as the replay inside `decideBudgetCap`, refuses authorization by construction, and has no external target; a persisted lifecycle nothing advances would be the unwired-mechanism state D-220 ended.
- `assurance.ts` DERIVES a Decision Assurance Level from the ten-axis `ClaimProfile` of every declared input claim and from the dominance certificate's own result. A caller cannot assert a level; there is no field to assert one with. `buildDecisionKernelIssuance` refuses to issue when a declared consequence class requires more than the declared inputs reach, and `issueDecisionToKernel` therefore cannot persist past a refusal.

## Invariants

- a rule-selected action is not labelled objectively best;
- a proven dominance result is decision fitness under the declared interval rule, not authorization to execute the selected action;
- expiry and revalidation are read-time statuses; the adapter records conditions but does not evaluate them or silently renew a certificate;
- regret assumes a rectangular interval uncertainty set;
- VOI scenarios are finite, exhaustive, mutually exclusive, and use one utility basis;
- measurement cost is subtracted from gross decision-loss reduction exactly once.
- control transitions fail closed on stale/revoked/conflicted/incomplete evidence, changed treatment/model/pricing/environment regime, degraded completeness, broken measurement, harmful or unobservable outcomes, and expired policy TTL; a rollback is terminal and idempotent.
- an assurance level classifies evidential support for acting and is never authorization to act: `authorizesAction` is permanently `false`, and execution stays outside this module.
- `decisionFitness` is excluded from the assurance ladder, because it is the axis being assessed; including it would let a claim assert its own decision fitness and have that assertion raise the level governing it.
- every assurance cap is the WEAKEST declared input on an axis, never an average, and no axis compensates for another: a randomized estimand does not buy back missing coverage.
- no declared inputs is `DAL-0`, not "nothing contrary was found"; an undeclared consequence is held to the strictest requirement, not the loosest; an issuance that declares no consequence reports `assurance: null`, which means NOT ASSESSED and never assessed-and-fine.

## Verify

```bash
node --test --experimental-strip-types test/decision-engine.test.ts
node --test --experimental-strip-types test/decision-control.test.ts
node --test --experimental-strip-types test/decision-assurance.test.ts
node --test --experimental-strip-types test/advice-assurance-reach.test.ts
node --test --experimental-strip-types test/frontier-assurance-gate.test.ts
```

## Does not establish

One product path reaches this module (D-220): `src/budget/capDecision.ts`
frames the budget advisor's cap as a decision between `apply_recommended` and
`keep_current`, normalizes its intervals through `buildUtilityIntervalProblem`
and evaluates a declared six-member admissible preference set through
`preferenceRobustness` (D-249; a diagnostic rendered beside the certificate
that never moves standing), calls `certifyDecision`, `minimaxRegret`,
`decisionCountermodels`, `decisionInvalidatingAssumptionSets` and
`gateDecisionForConsequence`, renders the result in `fiscus budget
--recommend`, and routes a certified cap through `issueDecisionToKernel` on
`--apply`. A review-only or under-assured decision is rendered with its
shortfalls and `--apply` is refused (D-213). `decisionCertificationStructure`
and `decisionInvalidatingAssumptionSets` (D-195) are this module's own adapter
onto `minimalInvalidatingAssumptionSets` in `src/epistemic/countermodel.ts`,
declaring the one support a strict-interval-dominance certificate rests on and
reporting the `minimaxRegret` rectangularity assumption as inert to it. A
second product path reaches this module since D-240: `src/value/frontier.ts`
certifies each model-switch comparison over its two anytime-valid realization
intervals and gates it for `advisory_only` and `changes_spend` with the
comparison's own profile (`observational` only when the separation held,
`estimated` money, `proxy_unvalidated` outcome), so every recommendation
carries a derived level, the CLI sentence and the Value view print it, and no
observational comparison reaches DAL-3. Since D-248 no other advisory surface
exists: `test/advice-assurance-reach.test.ts` enumerates every exported
producer named for recommending or advising and requires each to be gated
(`recommendBudget`, `budgetAdvice`), withheld with no product caller
(`recommendAllocation`), or a consumer that refuses to act below the bar
(`cmdBudgetAdvisor`); the budget advisor's frontier cells are never ranked
into an action (the input is accepted and not read; the dead branch is gone),
and the usage path issues no advice — its exposure line is labelled as none.
The assurance ladder is a Fiscus policy choice, not a derived threshold, and it
assumes the declared input set is complete — an undeclared input cannot lower
the level it was left out of; that completeness is the evidence holder's claim
and is not evaluated by this module.
