# measurement — what a figure is a measurement OF

The kernel's `MEASUREMENT` axis is a three-rung ladder — `proxy_unvalidated`,
`proxy_validated`, `validated` — and every rung above the bottom is a claim
about the relationship between what was observed and what is being reported.
This module holds the records that make those rungs checkable, and refuses the
readings they cannot support.

The defect this module exists to prevent has one name: **construct laundering**
— reporting one construct as another, or reporting a surrogate for a construct
as the construct itself. A survival ratio reported as value, a token count
reported as effort, an acceptance rate reported as quality.

## Consumes

- `MeasurementModelInput` declarations: an id, the target construct, the
  measurand, the observable, the procedure, the scope, the population, the
  declared `validation` rung, an optional calibration and a stated uncertainty;
- `CompletenessWitness` declarations, which state whether a source could have
  seen the thing whose absence is being reported (`completeness.ts`);
- `SurrogateBridgeInput` declarations: which model, from which surrogate
  construct to which target construct, in which direction, on what basis, with
  which known failure modes, and whether currently contested;
- `measurementModelRef` strings as carried on Evidence and Claim.

## Guarantees

- **A declaration that cannot state how it was validated has not told us it
  was.** An unrecognised `validation` value is treated exactly as
  `proxy_unvalidated`, never as "not the bottom rung, so fine".
- **The ladder is one ladder.** `MEASUREMENT_VALIDATIONS` is the single ordered
  tuple, and every rank comparison here derives from it, so this module cannot
  disagree with `mergeClaimProfiles` about what these words mean.
- **`assessMeasurementFitness` asks the strongest question by default.**
  Omitting `requiredValidation` asks whether the model may stand behind a
  `validated` claim, because the permissive default is the one that lets a
  surrogate be reported as the target.
- **A reference that resolves to nothing is not weak backing; it is no
  backing.** `measurementRegistry` resolves a `measurementModelRef` to a real,
  construct-matched model, and never degrades quietly into the strength the
  caller wanted.
- **Registries are immutable values built from explicit lists.** A registry a
  caller can add to at will is the same hole one indirection further out, since
  whoever needs a reference to resolve could make it resolve. Every entry is
  re-run through its own constructor rather than trusted as given.
- **A bridge is a ceiling, never a promotion.** `assessBridgedMeasurementBacking`
  can only lower the strength a model's own author declared.
- **No bridge ever reaches `validated`.** That rung means the construct itself
  was measured; a surrogate that became the construct would not be a surrogate.
- **Pre-registration is not validation.** Fixing a metric before collection
  rules out choosing it after seeing the data. It says nothing about whether the
  metric measures the construct.
- **A null `measurementModelRef` stays admissible for `proxy_unvalidated`
  only**, matching the rule `claim()` already enforces. Refusing it would force
  every honest weak boundary to invent a model in order to keep working, which
  points the laundering incentive the wrong way.

## Must never break

- Granting a measurement strength because a field was populated rather than
  because it was checked. Every hole closed in this module so far has been a
  version of that.
- Backfilling a `validation`, a construct, or a bridge from context. Unknown
  stays unknown.
- Reading an empty or unresolvable declaration as a weaker positive result
  rather than as the absence of one.

## Does not establish

That a model's procedure actually measures the construct written on it, or that
a bridge's asserted association is real. Construct validity is an argument made
by whoever declared the model, and it is not mechanically checkable here. An
`empirical_association` bridge is checked for the SHAPE of its evidence — a
reference measurement that resolves, is itself directly `validated`, and
measures the same construct — and never for the strength, sign, or
reproducibility of the association. This module refuses to let a declaration be
read as stronger than it is; it cannot make one true.

**Nothing here is enforced at a product boundary yet.** `claim()` still accepts
any non-null `measurementModelRef` at construction, though the ledger bounds a
claim's reference against its cited evidence (D-168). **One production call site
now resolves a model through `measurementRegistry`:** `src/causal/measurement.ts`
builds a registry from the protocol's own quality model, and it is inside the
product import closure. This paragraph said no site did, until D-198 checked.
No surrogate bridge is declared for Fiscus's own
`proxy_validated` claims, and no registry of Fiscus's own models is assembled
anywhere. These are the mechanisms that make enforcement possible; the wiring is
the open remainder of WP-D05 and WP-D07.

## Files

| File | Holds |
|---|---|
| `model.ts` | The `MeasurementModel` declaration and the construct-fitness gate. |
| `registry.ts` | Reference resolution: may a claim about C, asserting S, cite this ref? |
| `surrogate.ts` | Surrogate bridges: what licenses reading a surrogate as its target. |
| `completeness.ts` | Whether a source could have seen the thing whose absence is claimed. |
