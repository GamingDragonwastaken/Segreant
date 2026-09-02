/** Generated from src/dashboard/shared-types.ts; do not edit by hand. */
export const DASHBOARD_INTERFACE_CONTRACT_SOURCE_SHA256 = "774237a77b7f3045cf9fc8c77d6e5eadfa837f7266f210189f950251e30ce37d";
export const DASHBOARD_INTERFACE_CONTRACTS = {
  "Summary": [
    {
      "name": "requests",
      "optional": false,
      "type": "number"
    },
    {
      "name": "costUsd",
      "optional": false,
      "type": "number"
    },
    {
      "name": "inputTokens",
      "optional": true,
      "type": "number"
    },
    {
      "name": "outputTokens",
      "optional": true,
      "type": "number"
    }
  ],
  "PricingCardProvenancePayload": [
    {
      "name": "schemaVersion",
      "optional": false,
      "type": "1"
    },
    {
      "name": "sourceUrl",
      "optional": false,
      "type": "string | null"
    },
    {
      "name": "sourceUrlSha256",
      "optional": false,
      "type": "string | null"
    },
    {
      "name": "sourceKind",
      "optional": false,
      "type": "string"
    },
    {
      "name": "fetchedAt",
      "optional": false,
      "type": "string"
    },
    {
      "name": "upstreamDeclaredUpdated",
      "optional": false,
      "type": "string | null"
    },
    {
      "name": "cardSha256",
      "optional": false,
      "type": "string"
    },
    {
      "name": "modelCount",
      "optional": false,
      "type": "number"
    },
    {
      "name": "etag",
      "optional": false,
      "type": "string | null"
    },
    {
      "name": "lastModified",
      "optional": false,
      "type": "string | null"
    }
  ],
  "PricingEvidencePayload": [
    {
      "name": "provider",
      "optional": false,
      "type": "string"
    },
    {
      "name": "model",
      "optional": false,
      "type": "string"
    },
    {
      "name": "costBasis",
      "optional": false,
      "type": "string"
    },
    {
      "name": "rateCardSha256",
      "optional": false,
      "type": "string | null"
    },
    {
      "name": "rateCardSourceKind",
      "optional": false,
      "type": "string"
    },
    {
      "name": "rateMatchKind",
      "optional": false,
      "type": "string"
    },
    {
      "name": "rateMatchProvider",
      "optional": false,
      "type": "string | null"
    },
    {
      "name": "rateMatchModel",
      "optional": false,
      "type": "string | null"
    },
    {
      "name": "requests",
      "optional": false,
      "type": "number"
    },
    {
      "name": "costUsd",
      "optional": false,
      "type": "number"
    },
    {
      "name": "estimatedCostUsd",
      "optional": false,
      "type": "number"
    },
    {
      "name": "inputTokens",
      "optional": false,
      "type": "number"
    },
    {
      "name": "outputTokens",
      "optional": false,
      "type": "number"
    },
    {
      "name": "rateCardProvenance",
      "optional": false,
      "type": "PricingCardProvenancePayload | null"
    }
  ],
  "GroupRow": [
    {
      "name": "label",
      "optional": false,
      "type": "string"
    },
    {
      "name": "provider",
      "optional": true,
      "type": "string"
    },
    {
      "name": "requests",
      "optional": false,
      "type": "number"
    },
    {
      "name": "costUsd",
      "optional": false,
      "type": "number"
    },
    {
      "name": "inputTokens",
      "optional": true,
      "type": "number"
    },
    {
      "name": "outputTokens",
      "optional": true,
      "type": "number"
    }
  ],
  "SeriesPoint": [
    {
      "name": "bucketMs",
      "optional": false,
      "type": "number"
    },
    {
      "name": "costUsd",
      "optional": false,
      "type": "number"
    },
    {
      "name": "requests",
      "optional": false,
      "type": "number"
    }
  ],
  "AlertRow": [
    {
      "name": "id",
      "optional": false,
      "type": "string"
    },
    {
      "name": "severity",
      "optional": false,
      "type": "'critical' | 'warn' | 'info'"
    },
    {
      "name": "title",
      "optional": false,
      "type": "string"
    },
    {
      "name": "detail",
      "optional": false,
      "type": "string"
    },
    {
      "name": "metric",
      "optional": false,
      "type": "string | null"
    }
  ],
  "ClaimProfilePayload": [
    {
      "name": "epistemic",
      "optional": false,
      "type": "ClaimEpistemicState"
    },
    {
      "name": "integrity",
      "optional": false,
      "type": "ClaimIntegrityStatus"
    },
    {
      "name": "authenticity",
      "optional": false,
      "type": "ClaimAuthenticityStatus"
    },
    {
      "name": "scope",
      "optional": false,
      "type": "ClaimScopeStatus"
    },
    {
      "name": "coverage",
      "optional": false,
      "type": "ClaimCoverageStatus"
    },
    {
      "name": "measurement",
      "optional": false,
      "type": "ClaimMeasurementStatus"
    },
    {
      "name": "causality",
      "optional": false,
      "type": "ClaimCausalityStatus"
    },
    {
      "name": "monetaryBasis",
      "optional": false,
      "type": "ClaimMonetaryBasis"
    },
    {
      "name": "finality",
      "optional": false,
      "type": "ClaimFinalityStatus"
    },
    {
      "name": "decisionFitness",
      "optional": false,
      "type": "ClaimDecisionFitness"
    }
  ],
  "ClaimSupportPayload": [
    {
      "name": "profile",
      "optional": false,
      "type": "ClaimProfilePayload"
    },
    {
      "name": "epistemic",
      "optional": false,
      "type": "ClaimEpistemicState"
    },
    {
      "name": "coverage",
      "optional": false,
      "type": "ClaimCoverageStatus"
    },
    {
      "name": "monetaryBasis",
      "optional": false,
      "type": "ClaimMonetaryBasis"
    },
    {
      "name": "figure",
      "optional": false,
      "type": "ClaimFigureStatus"
    },
    {
      "name": "note",
      "optional": true,
      "type": "string"
    }
  ],
  "Overview": [
    {
      "name": "demo",
      "optional": false,
      "type": "boolean"
    },
    {
      "name": "claimSupport",
      "optional": false,
      "type": "ClaimSupportPayload"
    },
    {
      "name": "range",
      "optional": false,
      "type": "string"
    },
    {
      "name": "generatedAt",
      "optional": false,
      "type": "string"
    },
    {
      "name": "summary",
      "optional": false,
      "type": "Summary"
    },
    {
      "name": "pricing",
      "optional": false,
      "type": "{"
    },
    {
      "name": "budget",
      "optional": false,
      "type": "{"
    },
    {
      "name": "byModel",
      "optional": false,
      "type": "GroupRow[]"
    },
    {
      "name": "byProject",
      "optional": false,
      "type": "GroupRow[]"
    },
    {
      "name": "attributionEvidence",
      "optional": false,
      "type": "Array<{ project: string; attributionBasis: string; requests: number; costUsd: number }>"
    },
    {
      "name": "bySource",
      "optional": false,
      "type": "GroupRow[]"
    },
    {
      "name": "byUser",
      "optional": false,
      "type": "GroupRow[]"
    },
    {
      "name": "characterization",
      "optional": false,
      "type": "{"
    },
    {
      "name": "dimensions",
      "optional": false,
      "type": "readonly string[]"
    },
    {
      "name": "series",
      "optional": false,
      "type": "SeriesPoint[]"
    },
    {
      "name": "recent",
      "optional": false,
      "type": "unknown[]"
    },
    {
      "name": "alerts",
      "optional": true,
      "type": "AlertRow[] | null"
    }
  ],
  "ReconciliationCoverage": [
    {
      "name": "onDeclaredRouteUsd",
      "optional": false,
      "type": "number"
    },
    {
      "name": "onDeclaredRouteRequests",
      "optional": false,
      "type": "number"
    },
    {
      "name": "importedUsd",
      "optional": false,
      "type": "number"
    },
    {
      "name": "importedRequests",
      "optional": false,
      "type": "number"
    },
    {
      "name": "proxyOffScopeUsd",
      "optional": false,
      "type": "number"
    },
    {
      "name": "proxyOffScopeRequests",
      "optional": false,
      "type": "number"
    }
  ],
  "ReconciliationReadiness": [
    {
      "name": "ready",
      "optional": false,
      "type": "boolean"
    },
    {
      "name": "missing",
      "optional": false,
      "type": "Array<{ step: string; detail: string; ownerAction: boolean }>"
    },
    {
      "name": "coverage",
      "optional": false,
      "type": "ReconciliationCoverage | null"
    }
  ],
  "BillingMappingCoveragePayload": [
    {
      "name": "coverageStatus",
      "optional": false,
      "type": "string"
    },
    {
      "name": "reconciliationStatus",
      "optional": false,
      "type": "string"
    },
    {
      "name": "reconciliationDetail",
      "optional": false,
      "type": "string"
    },
    {
      "name": "providerScopeAuthority",
      "optional": false,
      "type": "string"
    },
    {
      "name": "mappingTrust",
      "optional": false,
      "type": "string"
    },
    {
      "name": "totalRecordCount",
      "optional": false,
      "type": "number"
    },
    {
      "name": "mappedRecordCount",
      "optional": false,
      "type": "number"
    },
    {
      "name": "unmappedRecordCount",
      "optional": false,
      "type": "number"
    },
    {
      "name": "staleMappingRecordCount",
      "optional": false,
      "type": "number"
    },
    {
      "name": "ambiguousMappingRecordCount",
      "optional": false,
      "type": "number"
    },
    {
      "name": "totalMicros",
      "optional": false,
      "type": "number"
    },
    {
      "name": "mappedMicros",
      "optional": false,
      "type": "number"
    },
    {
      "name": "residualMicros",
      "optional": false,
      "type": "number"
    },
    {
      "name": "byStatus",
      "optional": false,
      "type": "Record<string, { recordCount: number; amountMicros: number }>"
    },
    {
      "name": "targets",
      "optional": false,
      "type": "Array<{ targetProject: string; targetAccountRef: string; recordCount: number; amountMicros: number }>"
    },
    {
      "name": "excludedFrom",
      "optional": false,
      "type": "string[]"
    }
  ],
  "BillingKernelClaimSummary": [
    {
      "name": "id",
      "optional": false,
      "type": "string"
    },
    {
      "name": "proposition",
      "optional": false,
      "type": "unknown"
    },
    {
      "name": "profile",
      "optional": false,
      "type": "Record<string, string>"
    },
    {
      "name": "evidenceIds",
      "optional": false,
      "type": "string[]"
    },
    {
      "name": "issuedAt",
      "optional": false,
      "type": "string"
    },
    {
      "name": "monetaryBasis",
      "optional": false,
      "type": "string"
    },
    {
      "name": "finality",
      "optional": false,
      "type": "string"
    }
  ],
  "BillingPayload": [
    {
      "name": "demo",
      "optional": false,
      "type": "boolean"
    },
    {
      "name": "claimSupport",
      "optional": false,
      "type": "ClaimSupportPayload"
    },
    {
      "name": "evidence",
      "optional": false,
      "type": "{ reconciliationStatus: string }"
    },
    {
      "name": "summary",
      "optional": false,
      "type": "{ recordCount: number }"
    },
    {
      "name": "kernel",
      "optional": true,
      "type": "{"
    },
    {
      "name": "readiness",
      "optional": true,
      "type": "ReconciliationReadiness"
    },
    {
      "name": "mapping",
      "optional": true,
      "type": "BillingMappingCoveragePayload"
    },
    {
      "name": "reconciliation",
      "optional": true,
      "type": "{"
    }
  ],
  "EconomicMoney": [
    {
      "name": "amount",
      "optional": false,
      "type": "string"
    },
    {
      "name": "coefficient",
      "optional": false,
      "type": "string"
    },
    {
      "name": "scale",
      "optional": false,
      "type": "number"
    },
    {
      "name": "currency",
      "optional": false,
      "type": "string"
    },
    {
      "name": "basis",
      "optional": false,
      "type": "string"
    }
  ],
  "EconomicCoverage": [
    {
      "name": "amount",
      "optional": false,
      "type": "string"
    },
    {
      "name": "coefficient",
      "optional": false,
      "type": "string"
    },
    {
      "name": "scale",
      "optional": false,
      "type": "number"
    },
    {
      "name": "currency",
      "optional": false,
      "type": "string"
    },
    {
      "name": "basis",
      "optional": false,
      "type": "string"
    },
    {
      "name": "eventIds",
      "optional": false,
      "type": "string[]"
    },
    {
      "name": "sourceBases",
      "optional": false,
      "type": "string[]"
    },
    {
      "name": "requestCount",
      "optional": false,
      "type": "number"
    },
    {
      "name": "unresolvedRequests",
      "optional": false,
      "type": "number"
    },
    {
      "name": "complete",
      "optional": false,
      "type": "boolean"
    }
  ],
  "EconomicBalance": [
    {
      "name": "amount",
      "optional": false,
      "type": "string"
    },
    {
      "name": "coefficient",
      "optional": false,
      "type": "string"
    },
    {
      "name": "scale",
      "optional": false,
      "type": "number"
    },
    {
      "name": "currency",
      "optional": false,
      "type": "string"
    },
    {
      "name": "basis",
      "optional": false,
      "type": "string"
    },
    {
      "name": "role",
      "optional": false,
      "type": "string"
    },
    {
      "name": "eventIds",
      "optional": false,
      "type": "string[]"
    }
  ],
  "EconomicMoneyJson": [
    {
      "name": "coefficient",
      "optional": false,
      "type": "string"
    },
    {
      "name": "scale",
      "optional": false,
      "type": "number"
    },
    {
      "name": "currency",
      "optional": false,
      "type": "string"
    },
    {
      "name": "basis",
      "optional": false,
      "type": "string"
    }
  ],
  "EconomicAttributionPayload": [
    {
      "name": "amount",
      "optional": false,
      "type": "EconomicMoneyJson"
    },
    {
      "name": "amountText",
      "optional": false,
      "type": "string"
    },
    {
      "name": "eventIds",
      "optional": false,
      "type": "string[]"
    },
    {
      "name": "sourceBases",
      "optional": false,
      "type": "string[]"
    },
    {
      "name": "requestCount",
      "optional": false,
      "type": "number"
    },
    {
      "name": "unresolvedRequests",
      "optional": false,
      "type": "number"
    },
    {
      "name": "complete",
      "optional": false,
      "type": "boolean"
    }
  ],
  "EconomicPeriodClosePayload": [
    {
      "name": "periodStartMs",
      "optional": false,
      "type": "number"
    },
    {
      "name": "periodEndMs",
      "optional": false,
      "type": "number"
    },
    {
      "name": "asOf",
      "optional": false,
      "type": "string | null"
    },
    {
      "name": "status",
      "optional": false,
      "type": "'open' | 'finalized' | 'reopened' | 'conflicted'"
    },
    {
      "name": "activeFinalizationId",
      "optional": false,
      "type": "string | null"
    },
    {
      "name": "latestFinalizationId",
      "optional": false,
      "type": "string | null"
    },
    {
      "name": "latestReopenId",
      "optional": false,
      "type": "string | null"
    },
    {
      "name": "projectionDigest",
      "optional": false,
      "type": "string | null"
    },
    {
      "name": "eventCount",
      "optional": false,
      "type": "number | null"
    }
  ],
  "EconomicPayload": [
    {
      "name": "kind",
      "optional": false,
      "type": "'economic_projection'"
    },
    {
      "name": "schemaVersion",
      "optional": false,
      "type": "number"
    },
    {
      "name": "demo",
      "optional": false,
      "type": "boolean"
    },
    {
      "name": "window",
      "optional": false,
      "type": "{"
    },
    {
      "name": "projection",
      "optional": false,
      "type": "{"
    },
    {
      "name": "periodClose",
      "optional": false,
      "type": "EconomicPeriodClosePayload"
    }
  ],
  "RealizationEconomicRollupPayload": [
    {
      "name": "coverage",
      "optional": false,
      "type": "'exact' | 'partial' | 'legacy_unknown'"
    },
    {
      "name": "total",
      "optional": false,
      "type": "EconomicAttributionPayload | null"
    },
    {
      "name": "realized",
      "optional": false,
      "type": "EconomicAttributionPayload | null"
    }
  ],
  "UsageUnitPayload": [
    {
      "name": "sessionId",
      "optional": false,
      "type": "string"
    },
    {
      "name": "costUsd",
      "optional": false,
      "type": "number"
    },
    {
      "name": "requests",
      "optional": false,
      "type": "number"
    },
    {
      "name": "economic",
      "optional": true,
      "type": "EconomicAttributionPayload"
    },
    {
      "name": "maturing",
      "optional": false,
      "type": "boolean"
    },
    {
      "name": "acceptance",
      "optional": false,
      "type": "number | null"
    },
    {
      "name": "reach",
      "optional": false,
      "type": "string | null"
    },
    {
      "name": "realized",
      "optional": false,
      "type": "boolean"
    }
  ],
  "UsagePayload": [
    {
      "name": "units",
      "optional": false,
      "type": "UsageUnitPayload[]"
    },
    {
      "name": "realizedUnits",
      "optional": false,
      "type": "number"
    },
    {
      "name": "totalCostUsd",
      "optional": false,
      "type": "number"
    },
    {
      "name": "outcomeMix",
      "optional": false,
      "type": "{ published: number; resolved: number; used: number; none: number }"
    },
    {
      "name": "economic",
      "optional": true,
      "type": "RealizationEconomicRollupPayload"
    }
  ],
  "ReconciliationRunRecord": [
    {
      "name": "reconciliationRunId",
      "optional": false,
      "type": "string"
    },
    {
      "name": "computedAtMs",
      "optional": false,
      "type": "number"
    },
    {
      "name": "result",
      "optional": false,
      "type": "{"
    }
  ],
  "CostCentre": [
    {
      "name": "id",
      "optional": false,
      "type": "string"
    },
    {
      "name": "label",
      "optional": true,
      "type": "string"
    },
    {
      "name": "name",
      "optional": true,
      "type": "string"
    }
  ],
  "AllocationRule": [
    {
      "name": "id",
      "optional": false,
      "type": "string"
    },
    {
      "name": "version",
      "optional": false,
      "type": "number"
    },
    {
      "name": "method",
      "optional": false,
      "type": "string"
    },
    {
      "name": "targets",
      "optional": true,
      "type": "string[] | null"
    },
    {
      "name": "revokedAtMs",
      "optional": true,
      "type": "number | null"
    },
    {
      "name": "effectiveToMs",
      "optional": true,
      "type": "number | null"
    }
  ],
  "AllocationPayload": [
    {
      "name": "demo",
      "optional": false,
      "type": "boolean"
    },
    {
      "name": "claimSupport",
      "optional": false,
      "type": "ClaimSupportPayload"
    },
    {
      "name": "kind",
      "optional": false,
      "type": "string"
    },
    {
      "name": "trust",
      "optional": false,
      "type": "string"
    },
    {
      "name": "basis",
      "optional": false,
      "type": "string"
    },
    {
      "name": "excludedFrom",
      "optional": false,
      "type": "string[]"
    },
    {
      "name": "costCentres",
      "optional": false,
      "type": "CostCentre[]"
    },
    {
      "name": "rules",
      "optional": false,
      "type": "AllocationRule[]"
    },
    {
      "name": "runs",
      "optional": false,
      "type": "AllocationRunRecord[]"
    },
    {
      "name": "reconciliation",
      "optional": false,
      "type": "{ everRun: boolean; latestComputedAtMs: number | null }"
    }
  ],
  "AllocationRunRecord": [
    {
      "name": "allocationRunId",
      "optional": false,
      "type": "string"
    },
    {
      "name": "computedAtMs",
      "optional": false,
      "type": "number"
    },
    {
      "name": "result",
      "optional": true,
      "type": "Record<string, unknown>"
    }
  ],
  "Matured": [
    {
      "name": "units",
      "optional": false,
      "type": "number"
    },
    {
      "name": "realizedUnits",
      "optional": false,
      "type": "number"
    },
    {
      "name": "realizationRate",
      "optional": false,
      "type": "number"
    },
    {
      "name": "totalCostUsd",
      "optional": false,
      "type": "number"
    },
    {
      "name": "spendOnRealizedUnitsUsd",
      "optional": false,
      "type": "number"
    },
    {
      "name": "acceptanceWeightedSpendUsd",
      "optional": true,
      "type": "number"
    },
    {
      "name": "realizedSpendShare",
      "optional": true,
      "type": "number"
    },
    {
      "name": "wasteByStage",
      "optional": true,
      "type": "Array<{ stage: string; units: number; costUsd: number }>"
    },
    {
      "name": "instrumentation",
      "optional": true,
      "type": "Record<string, number>"
    },
    {
      "name": "gateConflicts",
      "optional": true,
      "type": "Record<string, number>"
    },
    {
      "name": "realizationBounds",
      "optional": true,
      "type": "{ lower: number; upper: number; n: number }"
    },
    {
      "name": "economic",
      "optional": true,
      "type": "RealizationEconomicRollupPayload"
    }
  ],
  "ValueProjectPayload": [
    {
      "name": "project",
      "optional": false,
      "type": "string"
    },
    {
      "name": "units",
      "optional": false,
      "type": "number"
    },
    {
      "name": "costUsd",
      "optional": false,
      "type": "number"
    },
    {
      "name": "realizationRate",
      "optional": false,
      "type": "number"
    },
    {
      "name": "spendOnRealizedUnitsUsd",
      "optional": false,
      "type": "number"
    },
    {
      "name": "acceptanceWeightedSpendUsd",
      "optional": false,
      "type": "number"
    },
    {
      "name": "roiIndex",
      "optional": false,
      "type": "number | null"
    },
    {
      "name": "sources",
      "optional": false,
      "type": "string[]"
    },
    {
      "name": "economic",
      "optional": true,
      "type": "RealizationEconomicRollupPayload"
    }
  ],
  "ValuePayload": [
    {
      "name": "demo",
      "optional": false,
      "type": "boolean"
    },
    {
      "name": "claimSupport",
      "optional": false,
      "type": "ClaimSupportPayload"
    },
    {
      "name": "allocation",
      "optional": false,
      "type": "unknown"
    },
    {
      "name": "projects",
      "optional": true,
      "type": "ValueProjectPayload[]"
    },
    {
      "name": "frontier",
      "optional": true,
      "type": "{ modelSwitches?: Array<{ confidence: string }> } | null"
    },
    {
      "name": "valueSource",
      "optional": true,
      "type": "string | null"
    },
    {
      "name": "gitRepo",
      "optional": true,
      "type": "boolean"
    },
    {
      "name": "projectScoped",
      "optional": true,
      "type": "boolean | null"
    },
    {
      "name": "repo",
      "optional": true,
      "type": "string"
    },
    {
      "name": "realization",
      "optional": true,
      "type": "{"
    },
    {
      "name": "roi",
      "optional": true,
      "type": "{"
    },
    {
      "name": "drift",
      "optional": true,
      "type": "{ n: number; alarm: boolean; recentRate?: number; overallRate?: number } | null"
    },
    {
      "name": "reclaimed",
      "optional": true,
      "type": "{"
    },
    {
      "name": "team",
      "optional": true,
      "type": "{"
    },
    {
      "name": "usage",
      "optional": true,
      "type": "UsagePayload"
    },
    {
      "name": "budget",
      "optional": true,
      "type": "BudgetAdvice | null"
    }
  ],
  "BudgetAdvice": [
    {
      "name": "status",
      "optional": false,
      "type": "string"
    },
    {
      "name": "canApply",
      "optional": false,
      "type": "boolean"
    },
    {
      "name": "minActiveDays",
      "optional": true,
      "type": "number"
    },
    {
      "name": "basisDays",
      "optional": true,
      "type": "number"
    },
    {
      "name": "observed",
      "optional": true,
      "type": "{ medianDaily: number; p90Daily: number; maxDaily: number; avgDaily: number }"
    },
    {
      "name": "recommendedDailyUsd",
      "optional": true,
      "type": "number | null"
    },
    {
      "name": "recommendedSoftUsd",
      "optional": true,
      "type": "number | null"
    },
    {
      "name": "realizedSpendShare",
      "optional": true,
      "type": "number | null"
    },
    {
      "name": "projectedMonthlyWasteUsd",
      "optional": true,
      "type": "number | null"
    },
    {
      "name": "economic",
      "optional": true,
      "type": "{ coverage: 'exact' | 'partial' | 'legacy_unknown'; total: EconomicAttributionPayload | null }"
    },
    {
      "name": "rationale",
      "optional": true,
      "type": "string[]"
    },
    {
      "name": "spendBasis",
      "optional": true,
      "type": "string"
    },
    {
      "name": "windowDays",
      "optional": true,
      "type": "number"
    }
  ],
  "CausalPayload": [
    {
      "name": "demo",
      "optional": false,
      "type": "boolean"
    },
    {
      "name": "generatedAt",
      "optional": false,
      "type": "string"
    },
    {
      "name": "studies",
      "optional": false,
      "type": "Array<{"
    },
    {
      "name": "study",
      "optional": false,
      "type": "{"
    },
    {
      "name": "causalEvidence",
      "optional": false,
      "type": "string"
    },
    {
      "name": "boundary",
      "optional": false,
      "type": "string"
    }
  ],
  "BudgetConfig": [
    {
      "name": "dailyUsd",
      "optional": false,
      "type": "number | null"
    },
    {
      "name": "dailySoftUsd",
      "optional": false,
      "type": "number | null"
    },
    {
      "name": "sessionUsd",
      "optional": false,
      "type": "number | null"
    },
    {
      "name": "runawayWindowSec",
      "optional": false,
      "type": "number"
    },
    {
      "name": "runawayMaxUsd",
      "optional": false,
      "type": "number | null"
    },
    {
      "name": "capIncludesImported",
      "optional": false,
      "type": "boolean"
    }
  ],
  "SettingsSnapshot": [
    {
      "name": "version",
      "optional": false,
      "type": "string"
    },
    {
      "name": "home",
      "optional": false,
      "type": "string"
    },
    {
      "name": "configPath",
      "optional": false,
      "type": "string"
    },
    {
      "name": "dbPath",
      "optional": false,
      "type": "string"
    },
    {
      "name": "proxyPort",
      "optional": false,
      "type": "number"
    },
    {
      "name": "dashboardPort",
      "optional": false,
      "type": "number"
    },
    {
      "name": "retentionDays",
      "optional": false,
      "type": "number"
    },
    {
      "name": "proposalRetentionDays",
      "optional": false,
      "type": "number"
    },
    {
      "name": "metadataOnly",
      "optional": false,
      "type": "boolean"
    },
    {
      "name": "budget",
      "optional": false,
      "type": "BudgetConfig"
    },
    {
      "name": "enforcement",
      "optional": false,
      "type": "BudgetEnforcement"
    },
    {
      "name": "egress",
      "optional": false,
      "type": "{"
    },
    {
      "name": "connections",
      "optional": false,
      "type": "Array<Record<string, unknown>>"
    }
  ],
  "BudgetEnforcement": [
    {
      "name": "localProxy",
      "optional": false,
      "type": "{"
    },
    {
      "name": "importedSpend",
      "optional": false,
      "type": "{ state: 'observed_only'; blockable: false; countsTowardInPathCap: boolean }"
    },
    {
      "name": "providerNative",
      "optional": false,
      "type": "{ state: 'unknown'; inspected: false }"
    },
    {
      "name": "recommendation",
      "optional": false,
      "type": "{ state: 'proposed'; automaticallyApplied: false }"
    }
  ],
  "Importer": [
    {
      "name": "id",
      "optional": false,
      "type": "string"
    },
    {
      "name": "label",
      "optional": false,
      "type": "string"
    },
    {
      "name": "blurb",
      "optional": false,
      "type": "string"
    },
    {
      "name": "available",
      "optional": false,
      "type": "boolean"
    },
    {
      "name": "location",
      "optional": false,
      "type": "string | null"
    }
  ],
  "ScanPayload": [
    {
      "name": "ok",
      "optional": false,
      "type": "boolean"
    },
    {
      "name": "tools",
      "optional": false,
      "type": "Array<{ id: string; label?: string; present?: boolean }>"
    },
    {
      "name": "otherApps",
      "optional": false,
      "type": "Array<{ id?: string; label?: string; name?: string }>"
    },
    {
      "name": "roots",
      "optional": false,
      "type": "string[]"
    },
    {
      "name": "repoCount",
      "optional": false,
      "type": "number"
    },
    {
      "name": "reposWithSpend",
      "optional": false,
      "type": "number"
    },
    {
      "name": "hitBudget",
      "optional": false,
      "type": "boolean"
    },
    {
      "name": "dirsVisited",
      "optional": false,
      "type": "number"
    },
    {
      "name": "unreadableDirs",
      "optional": false,
      "type": "number"
    },
    {
      "name": "diff",
      "optional": true,
      "type": "Record<string, unknown>"
    }
  ],
  "ImportResult": [
    {
      "name": "ok",
      "optional": false,
      "type": "boolean"
    },
    {
      "name": "totalNew",
      "optional": false,
      "type": "number"
    },
    {
      "name": "results",
      "optional": false,
      "type": "Record<string, { inserted: number; costUsd?: number; available: boolean }>"
    }
  ],
  "HealthPayload": [
    {
      "name": "ok",
      "optional": false,
      "type": "boolean"
    },
    {
      "name": "service",
      "optional": false,
      "type": "string"
    }
  ],
  "ImportersPayload": [
    {
      "name": "importers",
      "optional": false,
      "type": "Importer[]"
    }
  ],
  "DiscoveredProjectPayload": [
    {
      "name": "project",
      "optional": false,
      "type": "string"
    },
    {
      "name": "repoPath",
      "optional": false,
      "type": "string"
    },
    {
      "name": "sources",
      "optional": false,
      "type": "string[]"
    },
    {
      "name": "costUsd",
      "optional": false,
      "type": "number"
    },
    {
      "name": "requests",
      "optional": false,
      "type": "number"
    },
    {
      "name": "units",
      "optional": false,
      "type": "number"
    },
    {
      "name": "realizedUnits",
      "optional": false,
      "type": "number"
    }
  ],
  "DiscoverPayload": [
    {
      "name": "ok",
      "optional": false,
      "type": "boolean"
    },
    {
      "name": "foundFolders",
      "optional": false,
      "type": "number"
    },
    {
      "name": "correlated",
      "optional": false,
      "type": "number"
    },
    {
      "name": "discovered",
      "optional": false,
      "type": "DiscoveredProjectPayload[]"
    }
  ],
  "ScanSetupPayload": [
    {
      "name": "ok",
      "optional": false,
      "type": "boolean"
    },
    {
      "name": "totalNew",
      "optional": false,
      "type": "number"
    },
    {
      "name": "imported",
      "optional": false,
      "type": "Record<string, { inserted: number; costUsd: number; available: boolean }>"
    },
    {
      "name": "correlated",
      "optional": false,
      "type": "number"
    },
    {
      "name": "discovered",
      "optional": false,
      "type": "DiscoveredProjectPayload[]"
    }
  ],
  "PricingPayload": [
    {
      "name": "demo",
      "optional": false,
      "type": "boolean"
    },
    {
      "name": "generatedAt",
      "optional": false,
      "type": "string"
    },
    {
      "name": "window",
      "optional": false,
      "type": "{ startMs: number; endMs: number; label: string }"
    },
    {
      "name": "activeRateCard",
      "optional": false,
      "type": "Record<string, unknown>"
    },
    {
      "name": "total",
      "optional": false,
      "type": "{ costUsd: number; requests: number }"
    },
    {
      "name": "provenance",
      "optional": false,
      "type": "PricingEvidencePayload[]"
    },
    {
      "name": "boundary",
      "optional": false,
      "type": "string"
    }
  ],
  "GateResultPayload": [
    {
      "name": "gate",
      "optional": false,
      "type": "GateName"
    },
    {
      "name": "polarity",
      "optional": false,
      "type": "GatePolarity"
    },
    {
      "name": "verdict",
      "optional": false,
      "type": "GateVerdict"
    },
    {
      "name": "detail",
      "optional": false,
      "type": "string"
    }
  ],
  "RealizationFunnelPayload": [
    {
      "name": "results",
      "optional": false,
      "type": "GateResultPayload[]"
    },
    {
      "name": "reachedIndex",
      "optional": false,
      "type": "number"
    },
    {
      "name": "reached",
      "optional": false,
      "type": "GateName | null"
    },
    {
      "name": "diedAt",
      "optional": false,
      "type": "GateName | null"
    },
    {
      "name": "diedAtIndex",
      "optional": false,
      "type": "number | null"
    },
    {
      "name": "realized",
      "optional": false,
      "type": "boolean"
    },
    {
      "name": "conflicts",
      "optional": false,
      "type": "GateName[]"
    },
    {
      "name": "passes",
      "optional": false,
      "type": "number"
    },
    {
      "name": "fails",
      "optional": false,
      "type": "number"
    },
    {
      "name": "unknowns",
      "optional": false,
      "type": "number"
    },
    {
      "name": "instrumented",
      "optional": false,
      "type": "number"
    },
    {
      "name": "realizationScore",
      "optional": false,
      "type": "number"
    }
  ],
  "SerialGatePayload": [
    {
      "name": "gate",
      "optional": false,
      "type": "GateName"
    },
    {
      "name": "alive",
      "optional": false,
      "type": "number"
    },
    {
      "name": "passes",
      "optional": false,
      "type": "number"
    },
    {
      "name": "fails",
      "optional": false,
      "type": "number"
    },
    {
      "name": "q",
      "optional": false,
      "type": "number | null"
    }
  ],
  "SerialRealizationPayload": [
    {
      "name": "sG",
      "optional": false,
      "type": "number | null"
    },
    {
      "name": "gates",
      "optional": false,
      "type": "SerialGatePayload[]"
    },
    {
      "name": "included",
      "optional": false,
      "type": "GateName[]"
    },
    {
      "name": "skipped",
      "optional": false,
      "type": "GateName[]"
    }
  ],
  "RealizationWasteBucketPayload": [
    {
      "name": "stage",
      "optional": false,
      "type": "string"
    },
    {
      "name": "units",
      "optional": false,
      "type": "number"
    },
    {
      "name": "costUsd",
      "optional": false,
      "type": "number"
    }
  ],
  "RealizationUnitPayload": [
    {
      "name": "hash",
      "optional": false,
      "type": "string"
    },
    {
      "name": "tsEpochMs",
      "optional": false,
      "type": "number"
    },
    {
      "name": "subject",
      "optional": false,
      "type": "string"
    },
    {
      "name": "linesAdded",
      "optional": false,
      "type": "number"
    },
    {
      "name": "linesDeleted",
      "optional": false,
      "type": "number"
    },
    {
      "name": "filesChanged",
      "optional": false,
      "type": "number"
    },
    {
      "name": "windowStartMs",
      "optional": false,
      "type": "number"
    },
    {
      "name": "windowEndMs",
      "optional": false,
      "type": "number"
    },
    {
      "name": "attributedCostUsd",
      "optional": false,
      "type": "number"
    },
    {
      "name": "attributedRequests",
      "optional": false,
      "type": "number"
    },
    {
      "name": "attributedOutputTokens",
      "optional": false,
      "type": "number"
    },
    {
      "name": "costPerHundredLines",
      "optional": false,
      "type": "number | null"
    },
    {
      "name": "ageDays",
      "optional": false,
      "type": "number"
    },
    {
      "name": "maturing",
      "optional": false,
      "type": "boolean"
    },
    {
      "name": "survivalRatio",
      "optional": false,
      "type": "number"
    },
    {
      "name": "reverted",
      "optional": false,
      "type": "boolean"
    },
    {
      "name": "hadProposal",
      "optional": false,
      "type": "boolean"
    },
    {
      "name": "acceptance",
      "optional": false,
      "type": "number | null"
    },
    {
      "name": "taskType",
      "optional": false,
      "type": "string"
    },
    {
      "name": "dominantProvider",
      "optional": true,
      "type": "string | null"
    },
    {
      "name": "dominantModel",
      "optional": false,
      "type": "string | null"
    },
    {
      "name": "dominantModelCostUsd",
      "optional": false,
      "type": "number | null"
    },
    {
      "name": "dominantModelCostShare",
      "optional": false,
      "type": "number | null"
    },
    {
      "name": "dominantModelEconomic",
      "optional": true,
      "type": "EconomicAttributionPayload"
    },
    {
      "name": "costStale",
      "optional": false,
      "type": "boolean"
    },
    {
      "name": "dominantModelCostBasis",
      "optional": false,
      "type": "string | null"
    },
    {
      "name": "dominantModelRateCard",
      "optional": false,
      "type": "string | null"
    },
    {
      "name": "economic",
      "optional": true,
      "type": "EconomicAttributionPayload"
    },
    {
      "name": "funnel",
      "optional": false,
      "type": "RealizationFunnelPayload"
    }
  ],
  "RealizationReportPayload": [
    {
      "name": "generatedAt",
      "optional": false,
      "type": "string"
    },
    {
      "name": "windowDays",
      "optional": false,
      "type": "number"
    },
    {
      "name": "acceptanceThreshold",
      "optional": false,
      "type": "number"
    },
    {
      "name": "survivalThreshold",
      "optional": false,
      "type": "number"
    },
    {
      "name": "projectScoped",
      "optional": false,
      "type": "boolean"
    },
    {
      "name": "units",
      "optional": false,
      "type": "RealizationUnitPayload[]"
    },
    {
      "name": "firstPassAcceptance",
      "optional": false,
      "type": "number | null"
    },
    {
      "name": "proposalCoverage",
      "optional": false,
      "type": "number"
    },
    {
      "name": "costStaleUnits",
      "optional": false,
      "type": "number"
    },
    {
      "name": "matured",
      "optional": false,
      "type": "Matured & {"
    }
  ],
  "RealizationPayload": [
    {
      "name": "available",
      "optional": false,
      "type": "boolean"
    },
    {
      "name": "repo",
      "optional": false,
      "type": "string"
    },
    {
      "name": "source",
      "optional": true,
      "type": "'git' | 'store'"
    },
    {
      "name": "report",
      "optional": true,
      "type": "RealizationReportPayload"
    }
  ],
  "GuidePayload": [
    {
      "name": "stage",
      "optional": false,
      "type": "string"
    },
    {
      "name": "headline",
      "optional": false,
      "type": "string"
    },
    {
      "name": "steps",
      "optional": false,
      "type": "Array<{"
    },
    {
      "name": "next",
      "optional": false,
      "type": "{"
    },
    {
      "name": "hint",
      "optional": false,
      "type": "string | null"
    }
  ],
  "JudgePayload": [
    {
      "name": "error",
      "optional": true,
      "type": "string"
    },
    {
      "name": "project",
      "optional": true,
      "type": "string"
    },
    {
      "name": "windowDays",
      "optional": true,
      "type": "number"
    },
    {
      "name": "judgment",
      "optional": true,
      "type": "unknown"
    },
    {
      "name": "session",
      "optional": true,
      "type": "{ sessionId: string; tool: string; requestCount: number }"
    },
    {
      "name": "tier",
      "optional": true,
      "type": "{ tier: string; sendsContentOffDevice: boolean }"
    }
  ],
  "ClearProposalsPayload": [
    {
      "name": "ok",
      "optional": false,
      "type": "boolean"
    },
    {
      "name": "removed",
      "optional": false,
      "type": "number"
    }
  ],
  "DashboardResponseMap": [
    {
      "name": "health",
      "optional": false,
      "type": "HealthPayload"
    },
    {
      "name": "importers",
      "optional": false,
      "type": "ImportersPayload"
    },
    {
      "name": "import",
      "optional": false,
      "type": "ImportResult"
    },
    {
      "name": "discover",
      "optional": false,
      "type": "DiscoverPayload"
    },
    {
      "name": "scan",
      "optional": false,
      "type": "ScanPayload | ScanSetupPayload"
    },
    {
      "name": "overview",
      "optional": false,
      "type": "Overview"
    },
    {
      "name": "billing",
      "optional": false,
      "type": "BillingPayload"
    },
    {
      "name": "allocation",
      "optional": false,
      "type": "AllocationPayload"
    },
    {
      "name": "economic",
      "optional": false,
      "type": "EconomicPayload"
    },
    {
      "name": "pricing",
      "optional": false,
      "type": "PricingPayload"
    },
    {
      "name": "realization",
      "optional": false,
      "type": "RealizationPayload"
    },
    {
      "name": "guide",
      "optional": false,
      "type": "GuidePayload"
    },
    {
      "name": "judge",
      "optional": false,
      "type": "JudgePayload"
    },
    {
      "name": "value",
      "optional": false,
      "type": "ValuePayload"
    },
    {
      "name": "causal",
      "optional": false,
      "type": "CausalPayload"
    },
    {
      "name": "settings",
      "optional": false,
      "type": "SettingsSnapshot"
    }
  ]
} as const;
