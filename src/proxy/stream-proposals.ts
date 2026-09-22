/**
 * Streaming proposal capture — the moat signal for the traffic that matters.
 *
 * Coding agents (Claude Code, Cursor, Codex) stream by default, so the agent's
 * *proposed* edits arrive as SSE tool-call fragments, not a single JSON body.
 * This accumulator reassembles those fragments back into the same shape the
 * non-streaming path produces, then hands them to `extractProposals` — so
 * streamed and buffered responses go through identical extraction and can never
 * drift. Without this, First-Pass Acceptance (and the Acceptance lens of RoI)
 * would be blind to the dominant real-world request pattern.
 *
 * It reconstructs only the assistant's edit-bearing content; what it can't parse
 * yields no proposal, which downstream reads as an `unknown` Accepted gate —
 * never a false signal.
 */

import { extractProposalsWithCoverage, type ProposedFile } from '../value/proposals.ts';
import type { Provider } from '../cost/pricing.ts';
import { RESOURCE_LIMITS, type CaptureCoverage } from '../util/resource-limits.ts';

interface AnthropicBlock {
  type: string; // 'tool_use' | 'text' | other
  name: string; // tool name (tool_use only)
  jsonParts: string[]; // input_json_delta fragments, concatenated into the tool input
  textParts: string[]; // text_delta fragments
  jsonBytes: number;
}

interface OpenAIToolCall {
  name: string;
  argParts: string[]; // function.arguments fragments, concatenated into a JSON string
  argBytes: number;
}

/**
 * Incrementally reassembles proposed edits from an SSE byte stream without
 * buffering the whole response. Feed it the same decoded text chunks the usage
 * accumulator sees; read `.proposals()` after the stream ends.
 */
export class StreamProposalAccumulator {
  private buffer = '';
  private truncated = false;
  private capturedBytes = 0;
  private fragmentCount = 0;
  private readonly provider: Provider;
  private readonly anthropicBlocks = new Map<number, AnthropicBlock>();
  private readonly openaiToolCalls = new Map<number, OpenAIToolCall>();
  private readonly openaiText: string[] = [];

  constructor(provider: Provider) {
    this.provider = provider;
  }

  get captureCoverage(): CaptureCoverage {
    return this.truncated ? 'truncated' : 'complete';
  }

  /** Feed a decoded chunk of the SSE stream. */
  push(chunk: string): void {
    if (this.truncated) return;
    if (Buffer.byteLength(chunk, 'utf8') > RESOURCE_LIMITS.sseFrameBytes + RESOURCE_LIMITS.sseRemainderBytes) {
      this.truncated = true;
      return;
    }
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n\n')) !== -1) {
      const frame = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      if (Buffer.byteLength(frame, 'utf8') > RESOURCE_LIMITS.sseFrameBytes) {
        this.truncated = true;
        this.buffer = '';
        return;
      }
      this.consumeFrame(frame);
    }
    if (Buffer.byteLength(this.buffer, 'utf8') > RESOURCE_LIMITS.sseRemainderBytes) {
      this.truncated = true;
      this.buffer = '';
    }
  }

  /** Flush any trailing frame at end-of-stream. */
  end(): void {
    if (this.truncated) {
      this.buffer = '';
      return;
    }
    if (this.buffer.trim()) this.consumeFrame(this.buffer);
    this.buffer = '';
  }

  private consumeFrame(frame: string): void {
    for (const line of frame.split('\n')) {
      const trimmed = line.trimStart();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let json: unknown;
      try {
        json = JSON.parse(payload);
      } catch {
        continue; // partial or non-JSON keepalive; skip
      }
      if (this.provider === 'anthropic') this.consumeAnthropic(json);
      else this.consumeOpenAI(json);
    }
  }

  private consumeAnthropic(json: unknown): void {
    const obj = json as {
      type?: string;
      index?: number;
      content_block?: { type?: string; name?: string; text?: string };
      delta?: { type?: string; partial_json?: string; text?: string };
    };
    if (obj.type === 'content_block_start' && typeof obj.index === 'number') {
      if (!Number.isSafeInteger(obj.index) || obj.index < 0) {
        this.truncated = true;
        return;
      }
      if (!this.anthropicBlocks.has(obj.index) && this.anthropicBlocks.size >= RESOURCE_LIMITS.proposalFiles) {
        this.truncated = true;
        return;
      }
      const cb = obj.content_block ?? {};
      if (typeof cb.name === 'string' && cb.name.length > RESOURCE_LIMITS.metadataFieldChars) {
        this.truncated = true;
        return;
      }
      const block: AnthropicBlock = { type: cb.type ?? 'unknown', name: cb.name ?? '', jsonParts: [], textParts: [], jsonBytes: 0 };
      if (typeof cb.text === 'string' && cb.text) this.appendText(block.textParts, cb.text);
      this.anthropicBlocks.set(obj.index, block);
    } else if (obj.type === 'content_block_delta' && typeof obj.index === 'number') {
      if (!Number.isSafeInteger(obj.index) || obj.index < 0) {
        this.truncated = true;
        return;
      }
      const block = this.anthropicBlocks.get(obj.index);
      if (!block || !obj.delta) return;
      if (typeof obj.delta.partial_json === 'string') this.appendJson(block, obj.delta.partial_json);
      if (typeof obj.delta.text === 'string') this.appendText(block.textParts, obj.delta.text);
    }
  }

  private consumeOpenAI(json: unknown): void {
    const obj = json as {
      choices?: Array<{
        delta?: {
          content?: string;
          tool_calls?: Array<{ index?: number; function?: { name?: string; arguments?: string } }>;
        };
      }>;
    };
    if (!Array.isArray(obj.choices)) return;
    for (const choice of obj.choices) {
      const delta = choice?.delta;
      if (!delta) continue;
      if (typeof delta.content === 'string') this.appendText(this.openaiText, delta.content);
      if (!Array.isArray(delta.tool_calls)) continue;
      for (const tc of delta.tool_calls) {
        const i = typeof tc.index === 'number' ? tc.index : 0;
        if (!Number.isSafeInteger(i) || i < 0) {
          this.truncated = true;
          return;
        }
        let entry = this.openaiToolCalls.get(i);
        if (!entry) {
          if (this.openaiToolCalls.size >= RESOURCE_LIMITS.proposalFiles) {
            this.truncated = true;
            return;
          }
          entry = { name: '', argParts: [], argBytes: 0 };
          this.openaiToolCalls.set(i, entry);
        }
        if (tc.function?.name) entry.name = tc.function.name;
        if (typeof tc.function?.arguments === 'string') this.appendArgument(entry, tc.function.arguments);
      }
    }
  }

  /** Reconstruct the response-body shape `extractProposals` expects, then extract. */
  proposals(): ProposedFile[] {
    if (this.provider === 'anthropic') {
      const content = [...this.anthropicBlocks.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, blk]) => {
          if (blk.type === 'tool_use') {
            const raw = blk.jsonParts.join('');
            let input: unknown = {};
            try {
              input = raw ? JSON.parse(raw) : {};
            } catch {
              input = {}; // never let a malformed fragment manufacture a proposal
            }
            return { type: 'tool_use', name: blk.name, input };
          }
          return { type: 'text', text: blk.textParts.join('') };
        });
      const extracted = extractProposalsWithCoverage('anthropic', { content });
      if (extracted.captureCoverage === 'truncated') this.truncated = true;
      return this.limitProposalLines(extracted.files);
    }
    const tool_calls = [...this.openaiToolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, tc]) => ({ function: { name: tc.name, arguments: tc.argParts.join('') } }));
    const message = { content: this.openaiText.join(''), tool_calls };
    const extracted = extractProposalsWithCoverage('openai', { choices: [{ message }] });
    if (extracted.captureCoverage === 'truncated') this.truncated = true;
    return this.limitProposalLines(extracted.files);
  }

  private appendJson(block: AnthropicBlock, value: string): void {
    if (!this.acceptFragment()) return;
    const bytes = Buffer.byteLength(value, 'utf8');
    if (block.jsonBytes + bytes > RESOURCE_LIMITS.toolArgumentBytes
      || this.capturedBytes + bytes > RESOURCE_LIMITS.proposalCaptureBytes) {
      this.truncated = true;
      return;
    }
    block.jsonParts.push(value);
    block.jsonBytes += bytes;
    this.capturedBytes += bytes;
  }

  private appendArgument(entry: OpenAIToolCall, value: string): void {
    if (!this.acceptFragment()) return;
    const bytes = Buffer.byteLength(value, 'utf8');
    if (entry.argBytes + bytes > RESOURCE_LIMITS.toolArgumentBytes
      || this.capturedBytes + bytes > RESOURCE_LIMITS.proposalCaptureBytes) {
      this.truncated = true;
      return;
    }
    entry.argParts.push(value);
    entry.argBytes += bytes;
    this.capturedBytes += bytes;
  }

  private appendText(parts: string[], value: string): void {
    if (!this.acceptFragment()) return;
    const bytes = Buffer.byteLength(value, 'utf8');
    if (this.capturedBytes + bytes > RESOURCE_LIMITS.proposalCaptureBytes) {
      this.truncated = true;
      return;
    }
    parts.push(value);
    this.capturedBytes += bytes;
  }

  private limitProposalLines(files: ProposedFile[]): ProposedFile[] {
    const lineCount = files.reduce((total, file) => total + file.addedLines.length, 0);
    if (lineCount > RESOURCE_LIMITS.proposalLines) this.truncated = true;
    return files;
  }

  private acceptFragment(): boolean {
    if (this.truncated) return false;
    this.fragmentCount += 1;
    if (this.fragmentCount > RESOURCE_LIMITS.sseFragments) {
      this.truncated = true;
      return false;
    }
    return true;
  }
}
