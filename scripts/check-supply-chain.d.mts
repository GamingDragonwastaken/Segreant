export interface SupplyChainWorkflow {
  name: string;
  text: string;
}

export interface SupplyChainInputs {
  packageJson: Record<string, unknown>;
  packageLock: Record<string, unknown>;
  teamServerLock: Record<string, unknown> | null;
  workflows: SupplyChainWorkflow[];
}

export declare function readSupplyChainInputs(root?: string): SupplyChainInputs;
export declare function auditSupplyChain(inputs: SupplyChainInputs): string[];
