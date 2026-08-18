# Controlled real-provider reconciliation runbook

This is the empirical gate for claiming that Fiscus has reconciled a real provider
bill. Synthetic fixtures and imported coding-tool spend do **not** satisfy it.

## Preconditions

- A dedicated OpenAI organization project whose identifier is known.
- An operator credential authorized to read Organization Costs.
- A fixed UTC observation window that can be allowed to finalize.
- All controlled requests in that window routed through the Fiscus proxy and
  tagged into the declared provider/project scope.

## Procedure

1. Start with a fresh or clearly isolated Fiscus home. Record the Fiscus commit.
2. Preview and then apply the exact billing scope declaration for the known project.
3. Route a controlled request set through Fiscus. Keep the request count and local
   metered total as observations, not expected answers.
4. Wait until the provider Costs window is final enough for the product's finality
   rules. Do not reconcile an accruing window.
5. Run the credential-free readiness/preview commands first.
6. Perform the applied provider Costs pull; retain the immutable evidence id/hash.
7. Run reconciliation. Record provider total, comparable metered total, residual,
   per-day residuals, permanent conditions, and materiality flags.
8. Independently account for residual categories (off-path use, project-scope
   mismatch, credits/adjustments, lag). Do not relabel an unexplained residual as
   reconciled.
9. Repeat the provider observation when required to establish finality.

## Pass criterion

The gate passes only when a real provider observation and the local declared-scope
ledger are compared by the shipped reconciliation engine, the run is immutable,
and every residual remains either explained by evidence or explicitly unresolved.
The acceptable residual is not predeclared: setting a tolerance before seeing the
data would turn the gate into a target.

## Current status

**UNPROVEN.** The repository contains a reconciliation engine and synthetic
end-to-end tests, but this runbook requires operator credentials, provider-side
evidence, finalized time, and controlled real traffic that repository CI cannot
honestly manufacture.
