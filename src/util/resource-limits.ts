import { readFileSync, statSync } from 'node:fs';

/**
 * Shared resource policy for externally influenced capture paths.
 *
 * These are deliberately conservative operational bounds, not accounting
 * semantics. A path that reaches one of them must either reject before doing
 * work or expose `truncated` capture coverage; it may never silently present a
 * partial observation as complete.
 */

export const RESOURCE_LIMITS = Object.freeze({
  inboundRequestBytes: 8 * 1024 * 1024,
  dashboardRequestBytes: 16 * 1024,
  upstreamResponseBytes: 16 * 1024 * 1024,
  sseFrameBytes: 2 * 1024 * 1024,
  sseRemainderBytes: 2 * 1024 * 1024,
  toolArgumentBytes: 2 * 1024 * 1024,
  proposalCaptureBytes: 8 * 1024 * 1024,
  proposalFiles: 256,
  proposalLines: 200_000,
  sseFragments: 100_000,
  metadataFieldChars: 256,
  transcriptLineBytes: 2 * 1024 * 1024,
  jsonDocumentBytes: 16 * 1024 * 1024,
  judgeResponseBytes: 4 * 1024 * 1024,
  receiptBytes: 4 * 1024 * 1024,
  evidenceArtifactBytes: 1 * 1024 * 1024,
  importFiles: 10_000,
  importDirectories: 50_000,
  importRows: 500_000,
  importDedupeKeys: 500_000,
  canonicalBytes: 16 * 1024 * 1024,
  canonicalNodes: 200_000,
  canonicalDepth: 128,
  canonicalStringBytes: 2 * 1024 * 1024,
});

export type CaptureCoverage = 'complete' | 'truncated';

export type ResourceLimitKind =
  | 'inbound_request_bytes'
  | 'upstream_response_bytes'
  | 'sse_frame_bytes'
  | 'sse_remainder_bytes'
  | 'tool_argument_bytes'
  | 'proposal_capture_bytes'
  | 'proposal_files'
  | 'proposal_lines'
  | 'judge_response_bytes'
  | 'openai_cost_page_bytes'
  | 'dashboard_request_bytes'
  | 'transcript_line_bytes'
  | 'json_document_bytes'
  | 'receipt_bytes'
  | 'evidence_artifact_bytes';

export class ResourceLimitError extends Error {
  readonly code = 'resource_limit' as const;
  readonly kind: ResourceLimitKind;
  readonly limitBytes: number;

  constructor(
    kind: ResourceLimitKind,
    limitBytes: number,
  ) {
    super(`Fiscus resource limit exceeded: ${kind}`);
    this.name = 'ResourceLimitError';
    this.kind = kind;
    this.limitBytes = limitBytes;
  }
}

/** Read a web response incrementally without allowing a chunked body to evade the cap. */
export async function readBoundedResponseBytes(
  response: Response,
  limitBytes: number,
  kind: ResourceLimitKind,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) {
    throw new Error(`invalid resource limit for ${kind}`);
  }
  if (!response.body) return new Uint8Array();
  const declaredLength = Number(response.headers.get('content-length') ?? '');
  if (Number.isSafeInteger(declaredLength) && declaredLength > limitBytes) {
    try { await response.body.cancel('response capture limit exceeded'); } catch { /* preserve typed limit error */ }
    throw new ResourceLimitError(kind, limitBytes);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limitBytes) {
        try { await reader.cancel('response capture limit exceeded'); } catch { /* preserve typed limit error */ }
        throw new ResourceLimitError(kind, limitBytes);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    reader.releaseLock();
  }
}

export async function readBoundedResponseText(
  response: Response,
  limitBytes: number,
  kind: ResourceLimitKind,
): Promise<string> {
  return new TextDecoder().decode(await readBoundedResponseBytes(response, limitBytes, kind));
}

/** Read a local UTF-8 artifact with a stat fast path and a post-read race check. */
export function readBoundedUtf8File(path: string, limitBytes: number, kind: ResourceLimitKind): string {
  if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) throw new Error(`invalid resource limit for ${kind}`);
  const declared = statSync(path);
  if (!declared.isFile() || declared.size > limitBytes) throw new ResourceLimitError(kind, limitBytes);
  const bytes = readFileSync(path);
  if (bytes.byteLength > limitBytes) throw new ResourceLimitError(kind, limitBytes);
  return bytes.toString('utf8');
}
