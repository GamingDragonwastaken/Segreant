export interface SecurityViolation {
  readonly rule: 'credential-pattern' | 'dynamic-string-code';
  readonly path: string;
  readonly line: number;
}

export interface SecurityAuditResult {
  readonly filesScanned: number;
  readonly violations: readonly SecurityViolation[];
}

export function auditSecurityTree(root: string): SecurityAuditResult;
