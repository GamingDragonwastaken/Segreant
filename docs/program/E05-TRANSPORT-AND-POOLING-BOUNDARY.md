# WP-E05 treatment identity and transportability boundary

**Status:** `COMPLETED` at the explicit cross-study bridge and pooling review
boundary. This is not external transport validity or a causal effect.

`src/causal/transport.ts` provides two fail-closed contracts:

- `assessTransportBridge()` requires distinct source/target protocol hashes,
  population identifiers, treatment identities, measurement models, time
  horizons, target evidence, and named consistency/exchangeability/positivity
  assumptions. It reports every changed coordinate instead of hiding a change
  behind one bridge label.
- `assessStudyPooling()` refuses silent pooling when any population, treatment,
  measurement, or time coordinate differs. A matching coordinate key makes a
  study set *poolable for review*, not automatically exchangeable or
  independent.

The bounded operator consumer is:

```text
segreant causal transport --options <file> --json
```

Focused RED-first coverage is 6/6 including the packaged CLI path. The
existing kernel `causal_transport` witness remains the persistence/issuance
obligation; this module supplies the operator-facing declaration and pooling
prevention layer without rewriting historical protocol bytes.

## Terminal boundary

Target evidence is retained by identity and digest, not semantically audited
by this local contract. A supported-for-review bridge is not proof of
exchangeability, target-population coverage, treatment consistency, causal
transport validity, business value, or permission to route. Those claims
remain governed-study or external evidence gates.

