# WP-E04 missingness, attrition, and interference design boundary

**Status:** `COMPLETED` at the protocol-linked, review-only design boundary.
This is not a claim that a real study has complete outcomes or that
interference is absent.

`src/causal/design.ts` defines a versioned `CausalDesignPlan` linked to the
committed causal protocol by its SHA-256 hash. The plan requires:

- an explicit target population and scope;
- missingness indicators, reason codes, a declared mechanism (including
  `unknown`), and an attrition-sensitivity range bounded in `[0,1]`;
- an interference assumption, optional cluster identity source, and a
  versioned exposure mapping when the requested estimand needs one; and
- an explicit estimand set (`itt`, `cluster_itt`, or `exposure_effect`).

`assessCausalDesign()` is a fail-closed qualification function. It withholds
cluster and exposure estimands without a cluster declaration and mapping, and
it withholds a design that has not even declared the interference assumption.
It retains unknown missingness as unknown, never imputes or reweights, and
labels a `none_declared` interference assumption as an assumption rather than
as measured absence. The bounded operator consumer is:

```text
fiscus causal design --options <file> --json
```

Focused RED-first coverage is 6/6, including the packaged CLI path; root
typecheck and build pass.

## Terminal boundary

The plan is a design declaration, not a study result. The module does not
observe missing outcomes, estimate attrition, validate a cluster mapping in the
world, or establish transportability. Those require retained governed study
records and remain external evidence gates. The existing ITT estimator keeps
its conservative no-imputation/no-reweighting behavior; this packet makes the
design prerequisites inspectable without widening that estimator's claims.

