/**
 * Usage extraction + normalization.
 *
 * Both providers report exact token usage in their responses — we never have to
 * tokenize anything locally, which keeps us accurate and keeps prompt bodies out
 * of our hands. The job here is to fold two different shapes into one
 * NormalizedUsage, handling the streaming (SSE) and non-streaming cases.
 *
 * Key cross-provider subtlety:
 *   Anthropic: `usage.input_tokens` is the UNCACHED input; cache reads/writes
 *              are reported in separate fields.
 *   OpenAI:    `usage.prompt_tokens` INCLUDES cached tokens; the cached subset
 *              is in `prompt_tokens_details.cached_tokens`. So uncached input =
 *              prompt_tokens - cached_tokens.
 */

import type { NormalizedUsage, Provider } from '../cost/pricing.ts';

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

export function normalizeAnthropicUsage(u: AnthropicUsage): NormalizedUsage {
  const ephem1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const ephem5m = u.cache_creation?.ephemeral_5m_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? ephem5m + ephem1h;
  // Prefer the longer-TTL flag when the breakdown says most writes were 1h.
  const ttl: '5m' | '1h' = ephem1h > ephem5m ? '1h' : '5m';
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheWriteTokens: cacheWrite,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTtl: ttl,
  };
}

export function normalizeOpenAIUsage(u: OpenAIUsage): NormalizedUsage {
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  const prompt = u.prompt_tokens ?? 0;
  return {
    inputTokens: Math.max(0, prompt - cached),
    outputTokens: u.completion_tokens ?? 0,
    cacheWriteTokens: 0, // OpenAI auto-caches with no separate write charge
    cacheReadTokens: cached,
    reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? 0,
  };
}

export function emptyUsage(): NormalizedUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
  };
}

/**
 * Incrementally extracts usage from an SSE byte stream without buffering the
 * whole response. Feed it decoded text chunks; read `.usage` after the stream
 * ends. It also surfaces the model id if the stream announces one.
 */
export class StreamUsageAccumulator {
  private buffer = '';
  private partial: NormalizedUsage = emptyUsage();
  private seenModel: string | null = null;
  private maxOutput = 0;
  private readonly provider: Provider;

  constructor(provider: Provider) {
    this.provider = provider;
  }

  get model(): string | null {
    return this.seenModel;
  }

  get usage(): NormalizedUsage {
    return { ...this.partial, outputTokens: Math.max(this.partial.outputTokens, this.maxOutput) };
  }

  /** Feed a decoded chunk of the SSE stream. */
  push(chunk: string): void {
    this.buffer += chunk;
    // SSE frames are separated by a blank line. Process all complete frames and
    // keep the trailing partial in the buffer.
    let idx: number;
    while ((idx = this.buffer.indexOf('\n\n')) !== -1) {
      const frame = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      this.consumeFrame(frame);
    }
  }

  /** Flush any trailing frame at end-of-stream. */
  end(): void {
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
    const obj = json as { type?: string; message?: { model?: string; usage?: AnthropicUsage }; usage?: AnthropicUsage };
    if (obj.type === 'message_start' && obj.message) {
      if (obj.message.model) this.seenModel = obj.message.model;
      if (obj.message.usage) {
        const n = normalizeAnthropicUsage(obj.message.usage);
        // message_start carries the final input + cache figures.
        this.partial.inputTokens = n.inputTokens;
        this.partial.cacheWriteTokens = n.cacheWriteTokens;
        this.partial.cacheReadTokens = n.cacheReadTokens;
        this.partial.cacheWriteTtl = n.cacheWriteTtl;
        this.maxOutput = Math.max(this.maxOutput, n.outputTokens);
      }
    } else if (obj.usage) {
      // message_delta carries cumulative output_tokens.
      const out = obj.usage.output_tokens ?? 0;
      this.maxOutput = Math.max(this.maxOutput, out);
    }
  }

  private consumeOpenAI(json: unknown): void {
    const obj = json as { model?: string; usage?: OpenAIUsage | null };
    if (obj.model) this.seenModel = obj.model;
    if (obj.usage) {
      const n = normalizeOpenAIUsage(obj.usage);
      this.partial = { ...n };
      this.maxOutput = Math.max(this.maxOutput, n.outputTokens);
    }
  }
}
