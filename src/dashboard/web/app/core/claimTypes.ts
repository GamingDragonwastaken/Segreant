export type LayerId = 'metered' | 'billed' | 'allocated' | 'realized';
export interface ClaimInspection {
  provenance: string; scope: string; freshness: string; coverage: string;
  enforceability: string; evidenceSource: string; assumptions: string[]; missingEvidence: string[];
}
export interface Layer {
  id: LayerId; label: string; claim: string; valueUsd: number | null; established: boolean;
  basis: string; nextStep?: string; inspection: ClaimInspection;
}
