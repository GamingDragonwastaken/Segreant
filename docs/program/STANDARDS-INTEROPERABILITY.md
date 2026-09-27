# Segreant standards interoperability map

**Checkpoint:** 2026-09-21

**Purpose.** WP-G04 is a standards-mapping packet, not a license to replace
Segreant's epistemic kernel with a standard that does not make the same claims.
The map records where an existing standard is the right interchange vocabulary,
where Segreant should adapt to it, and where the standard is silent. A standard
conformance claim is never a truth, attribution, causal, provider-authority, or
decision-authorization claim by itself.

## Primary-source map

| Standard | Current primary source/status | Use in Segreant | Boundary / non-equivalence | Adoption decision |
| --- | --- | --- | --- | --- |
| OpenTelemetry general + GenAI semantic conventions | [OpenTelemetry semantic conventions 1.44.0](https://opentelemetry.io/docs/specs/semconv/) and [GenAI attributes](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/). The general conventions are mixed maturity; GenAI conventions have moved to a separate repository and contain development/deprecated entries. | Map provider/model/request/response/token/session metadata at telemetry import/export edges. Prefer `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, reasoning-token and conversation identifiers where the source actually supplies them. | OTel names observations; it does not establish exact billing, provider account authority, outcome quality, causal identification, completeness, or Segreant ClaimProfile axes. Deprecated/moved attributes must not be treated as stable truth. Raw prompts/system instructions remain subject to Segreant minimization and egress boundaries. | Adapter/export compatibility only. No OTel dependency is required for the local core; version and stability are recorded with imported evidence. |
| FOCUS | [FOCUS Cost and Usage v1.3](https://focus.finops.org/docs/specification/v1-3/datasets/cost-and-usage/) and [v1.4 Cost and Usage](https://focus.finops.org/docs/specification/v1-4/datasets/cost-and-usage/). FOCUS separates dimensions from metrics, makes core cost fields typed, and permits supplemental columns. | Use FOCUS as the external cost/usage interchange for provider imports, especially billing/effective/list/contracted cost, currency, billing/charge periods, provider/service/resource and allocation dimensions. Preserve the source column identity and source version in Segreant Evidence. | FOCUS normalizes cost/usage shape; it does not prove issuer authority, completeness of an export, retention coverage, causal effect, realized value, or Segreant's local metering. FOCUS `ConsumedUnit` is not a license to derive pricing from a usage unit when the source does not provide the required basis. | Build an explicit lossless/partial FOCUS adapter around the exact Money and provenance ledger. Never coerce unsupported currencies, missing lineage, or provider claims into Segreant-authoritative amounts. |
| W3C PROV | [PROV overview](https://www.w3.org/TR/prov-overview/) and [PROV semantics](https://www.w3.org/TR/prov-sem/). PROV provides a provenance data model and related specifications. | Use PROV concepts as an export vocabulary for Segreant entities, activities, agents, generation, usage, derivation, and attribution when a portable provenance view is requested. | PROV describes provenance relationships; it does not decide whether a Segreant Claim is true, whether evidence is complete, whether a treatment effect is identified, or whether a recommendation is safe. Segreant's append-only kernel and ClaimProfile remain authoritative for those semantics. | Mapping/export first. Do not replace kernel storage or invent a PROV-to-truth projection. |
| W3C Verifiable Credentials + Data Integrity | [VC Data Model v2.0 Recommendation](https://www.w3.org/TR/vc-data-model-2.0/) and [Data Integrity 1.0 Recommendation](https://www.w3.org/TR/vc-data-integrity/). They define interoperable credential/presentation data and cryptographic integrity/authorship mechanisms. | Use as an optional envelope for portable signed Segreant attestations, with issuer, verification material, proof, status, and selective disclosure handled by the external profile. | A valid proof establishes integrity/authorship under the verifier's trust decision; it does not establish semantic truth, provider billing authority, causal validity, or authorization. VC trust is bilateral rather than an automatic transitive CA-like model. | Keep the existing signed pack/receipt integrity boundary. Add a VC/Data Integrity adapter only when a real external issuer/verifier workflow exists; no credentials or trust anchors are fabricated locally. |
| in-toto / SLSA | [in-toto specifications](https://in-toto.io/docs/specs/) and [SLSA v1.2](https://slsa.dev/spec/v1.2/), including [SLSA provenance](https://slsa.dev/spec/v1.2/provenance). SLSA provenance tracks how software artifacts were produced; in-toto supplies the attestation framework. | Use for software/build/evidence-production provenance where Segreant needs to export the build identity, materials, builder and invocation lineage of an artifact or verifier. | Supply-chain provenance is not an AI-finance observation, provider invoice, causal estimand, outcome, or decision certificate. A signed build attestation does not make the artifact semantically correct. | Interoperate at artifact export and CI evidence boundaries. Reuse the standard predicate/envelope where applicable; preserve Segreant Claim/Evidence non-claims. |
| SCITT | [IETF SCITT architecture draft material](https://datatracker.ietf.org/meeting/116/agenda/scitt-drafts.pdf). The architecture is a draft for signed-statement transparency services, not an approved Segreant dependency. | Use only as a threat-model reference for a future transparency service if Segreant needs independent append-only publication or inclusion proofs. | A transparency log would make statements discoverable/tamper-evident; it would not make their financial, causal, or epistemic content true. It also introduces an external service and trust/availability boundary that conflicts with local-first defaults. | Research-only. No SCITT client, hosted log, secret, deployment, or paid commitment in this packet. |

## Segreant-to-standard semantic boundary

The portable direction is deliberately one-way at first:

```text
local exact ledger / Trusted Epistemic Kernel
        │  lossless or explicitly partial adapter
        ├── FOCUS cost-and-usage interchange
        ├── OpenTelemetry GenAI telemetry interchange
        ├── PROV provenance view
        ├── VC/Data Integrity signed attestation envelope
        └── in-toto/SLSA build/evidence provenance
```

The reverse direction is never assumed to be lossless. An imported standard
record must carry source version, source identity, canonical digest, coverage,
retention window, currency/basis, and any omitted or unsupported fields. It can
become Segreant Evidence only after the source-specific adapter validates that
contract; it cannot directly mint a stronger Claim or causal conclusion.

## Implementation gates

1. Every adapter declares the standard/version, source identity, mapping table,
   unsupported fields, and whether the result is exact, estimated, imported,
   partial, or unknown.
2. FOCUS monetary fields enter the exact Money path; no binary float or
   undocumented FX conversion is permitted.
3. OTel attributes are telemetry observations, not billing authority. Raw
   prompt/system-instruction content remains excluded unless a separate
   declared egress/data-boundary contract permits it.
4. PROV relations map to provenance edges only; they do not bypass
   `causal_transport`, completeness, measurement, monetary, or decision gates.
5. VC/Data Integrity/in-toto/SLSA proofs are classified as integrity/authorship
   or production provenance. Their presence cannot upgrade ClaimProfile axes.
6. Draft standards (including SCITT) cannot be used as a production contract
   without a fresh packet decision and an implementation-time source review.

## Evidence status

This packet closes the current standards research/mapping boundary with primary
source links and explicit non-equivalence rules. It does **not** claim that
Segreant is certified by any standard, that every provider import is FOCUS
conformant, that an OTel exporter exists, or that a VC/SCITT integration is
deployed. Those are separate implementation or external-gate decisions.
