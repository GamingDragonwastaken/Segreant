/**
 * Bounded FOCUS v1.4 compatibility projection for provider billing evidence.
 *
 * This is not a FOCUS conformance implementation. It maps only fields whose
 * meaning is supported by the immutable provider-billing record and leaves
 * effective/allocated economics explicitly unmapped. The adapter is pure and
 * read-only; it never changes billing evidence or the request ledger.
 */

import type { BillingEvidenceRecord } from '../store/billing.ts';

export const FOCUS_COMPATIBILITY_VERSION = '1.4';

export interface FocusBillingCompatibilityRow {
  readonly FocusVersion: typeof FOCUS_COMPATIBILITY_VERSION;
  readonly BillingAccountId: string;
  readonly BillingAccountName: null;
  readonly BillingCurrency: 'USD';
  readonly BillingPeriodStart: string;
  readonly BillingPeriodEnd: string;
  readonly ChargePeriodStart: string;
  readonly ChargePeriodEnd: string;
  readonly ChargeCategory: 'Usage' | 'Purchase' | 'Tax' | 'Credit' | 'Adjustment';
  readonly ServiceProviderName: 'OpenAI';
  readonly ServiceName: string;
  readonly SkuId: string;
  readonly ResourceId: null;
  readonly RegionId: string | null;
  readonly BilledCost: number;
  readonly EffectiveCost: null;
  readonly AllocatedCost: null;
  readonly InvoiceIssuerName: null;
  readonly FiscusCostBasis: 'billed';
  readonly FiscusEffectiveCostStatus: 'unmapped';
  readonly FiscusAllocatedCostStatus: 'unmapped';
  readonly FiscusSourceLineage: Readonly<{
    recordId: string;
    sourceRecordId: string;
    sourceRecordSha256: string;
    importId: string;
    exportId: string;
    sourceSystem: 'operator-export';
    trust: 'operator_supplied_unverified';
  }>;
  readonly FiscusAllocationSource: null;
}

function category(record: BillingEvidenceRecord): FocusBillingCompatibilityRow['ChargeCategory'] {
  switch (record.chargeType) {
    case 'usage': return 'Usage';
    case 'commitment': return 'Purchase';
    case 'tax': return 'Tax';
    case 'credit':
    case 'discount': return 'Credit';
    case 'adjustment': return 'Adjustment';
    default: throw new Error(`unsupported charge type for FOCUS compatibility projection: ${record.chargeType}`);
  }
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function project(record: BillingEvidenceRecord): FocusBillingCompatibilityRow {
  if (record.costBasis !== 'provider_reported') {
    throw new Error(`unsupported cost basis for FOCUS compatibility projection: ${record.costBasis}`);
  }
  const row: FocusBillingCompatibilityRow = {
    FocusVersion: FOCUS_COMPATIBILITY_VERSION,
    BillingAccountId: record.billingAccountRef,
    BillingAccountName: null,
    BillingCurrency: record.currency,
    BillingPeriodStart: iso(record.chargePeriodStartMs),
    BillingPeriodEnd: iso(record.chargePeriodEndMs),
    ChargePeriodStart: iso(record.chargePeriodStartMs),
    ChargePeriodEnd: iso(record.chargePeriodEndMs),
    ChargeCategory: category(record),
    ServiceProviderName: 'OpenAI',
    ServiceName: record.service,
    SkuId: record.sku,
    ResourceId: null,
    RegionId: record.region,
    BilledCost: record.amountMicros / 1_000_000,
    EffectiveCost: null,
    AllocatedCost: null,
    InvoiceIssuerName: null,
    FiscusCostBasis: 'billed',
    FiscusEffectiveCostStatus: 'unmapped',
    FiscusAllocatedCostStatus: 'unmapped',
    FiscusSourceLineage: Object.freeze({
      recordId: record.recordId,
      sourceRecordId: record.sourceRecordId,
      sourceRecordSha256: record.sourceRecordSha256,
      importId: record.firstImportId,
      exportId: record.sourceExportId,
      sourceSystem: record.sourceSystem,
      trust: record.trust,
    }),
    FiscusAllocationSource: null,
  };
  return Object.freeze(row);
}

/** Project provider-billed records without mutation, persistence, or network access. */
export function billingEvidenceToFocus(records: readonly BillingEvidenceRecord[]): readonly FocusBillingCompatibilityRow[] {
  return Object.freeze(records.map(project));
}
