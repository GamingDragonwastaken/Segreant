export declare const SEGREANT_PACK_SCHEMA: 'segreantpack';
export declare const SEGREANT_PACK_VERSION: 1;
export declare const SEGREANT_PACK_MANIFEST_SCHEMA: 'segreantpack.manifest';
export declare const SEGREANT_PACK_MANIFEST_VERSION: 1;

export interface SegreantPackLimits {
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

export interface VerifySegreantPackOptions {
  readonly limits?: Partial<SegreantPackLimits>;
  /** Canonical base64 SPKI, PEM, or DER bytes for an out-of-band anchor. */
  readonly trustedPublicKey?: string | Uint8Array;
}

export interface SegreantPackVerificationResult {
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
  readonly limits: SegreantPackLimits;
}

export declare const DEFAULT_SEGREANT_PACK_LIMITS: SegreantPackLimits;
export declare function isSafeRelativeAttachmentPath(value: unknown): value is string;
export declare function verifySegreantPack(
  input: unknown,
  options?: VerifySegreantPackOptions,
): SegreantPackVerificationResult;
