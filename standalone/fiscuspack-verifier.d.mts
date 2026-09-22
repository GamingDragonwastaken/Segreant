export declare const FISCUS_PACK_SCHEMA: 'fiscuspack';
export declare const FISCUS_PACK_VERSION: 1;
export declare const FISCUS_PACK_MANIFEST_SCHEMA: 'fiscuspack.manifest';
export declare const FISCUS_PACK_MANIFEST_VERSION: 1;

export interface FiscusPackLimits {
  readonly maxEnvelopeBytes: number;
  readonly maxManifestBytes: number;
  readonly maxIncludedRecords: number;
  readonly maxOmissions: number;
  readonly maxRedactions: number;
  readonly maxExternalReferences: number;
  readonly maxAttachments: number;
  readonly maxCanonicalNodes: number;
  readonly maxCanonicalDepth: number;
  readonly maxCanonicalStringBytes: number;
  readonly maxIdentifierChars: number;
  readonly maxReasonChars: number;
  readonly maxFieldChars: number;
  readonly maxExternalUriChars: number;
  readonly maxSignatureChars: number;
  readonly maxAttachmentPathChars: number;
  readonly maxAttachmentSizeBytes: number;
  readonly maxAttachmentBytes: number;
}

export interface VerifyFiscusPackOptions {
  readonly limits?: Partial<FiscusPackLimits>;
  /** Canonical base64 SPKI, PEM, or DER bytes for an out-of-band anchor. */
  readonly trustedPublicKey?: string | Uint8Array;
}

export interface FiscusPackVerificationResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly manifestDigest: string | null;
  readonly canonical: 'verified' | 'not_verified';
  readonly integrity: 'verified' | 'not_verified';
  readonly authenticity: 'verified' | 'not_established';
  readonly truth: 'not_evaluated';
  readonly signature: {
    readonly status: 'absent' | 'metadata_only' | 'valid' | 'invalid';
    readonly cryptographicVerification: 'not_performed' | 'verified' | 'failed';
    readonly pinned: boolean;
    readonly keyId: string | null;
    readonly signedDigest: string | null;
  };
  readonly attachments: {
    readonly status: 'none' | 'partial' | 'complete';
    readonly declared: number;
    readonly present: number;
  };
  readonly limits: FiscusPackLimits;
}

export declare const DEFAULT_FISCUS_PACK_LIMITS: FiscusPackLimits;
export declare function isSafeRelativeAttachmentPath(value: unknown): value is string;
export declare function verifyFiscusPack(
  input: unknown,
  options?: VerifyFiscusPackOptions,
): FiscusPackVerificationResult;
