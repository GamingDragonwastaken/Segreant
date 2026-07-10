/**
 * Usage extraction + normalization.
 *
 * Both providers report exact token usage in their responses — we never have to
 * tokenize anything locally, which keeps us accurate and keeps prompt bodies out
 * of our hands. The job here is to fold these shapes into one NormalizedUsage,
 * handling the streaming (SSE) and non-streaming cases.
 *
 * Key cross-provider subtlety:
 *   Anthropic: `usage.input_tokens` is the UNCACHED input; cache reads/writes
 *              are reported in separate fields.
 *   OpenAI:    both of OpenAI's usage shapes report input INCLUSIVE of cached
 *              tokens, with the cached subset broken out separately — so
 *              uncached input is always (total - cached), never the raw total:
 *                - Chat Completions: prompt_tokens / prompt_tokens_details.cached_tokens
 *                - Responses API:    input_tokens / input_tokens_details.cached_tokens
 *              The inclusive relationship isn't stated plainly in OpenAI's own
 *              docs (unreachable at time of writing — 403s on the API reference
 *              and pricing pages); confirmed instead via litellm's independent
 *              cost-calculation source (github.com/BerriAI/litellm), which
 *              subtracts cached_tokens from prompt_tokens/input_tokens the same
 *              way for both shapes.
 *
 * Responses API streaming subtlety: unlike Chat Completions (which streams
 * usage flat on the final chunk's `usage` field), the Responses API streams
 * semantic events where the full resource — including `usage` and `model` —
 * is nested under a `response` key (e.g. the `response.completed` event has
 * `usage` at `event.response.usage`, not `event.usage`). See consumeOpenAI.
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
  // Chat Completions shape.
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
  // Responses API shape — field names differ, semantics (inclusive cached
  // subset) match. `input_tokens_details.cache_write_tokens` also exists on
  // this shape but is deliberately left unmapped below: unlike the read side,
  // whether OpenAI bills cache writes on the Responses API separately hasn't
  // been verified, so we don't invent a cost dimension we can't confirm.
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
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
  // Responses API and Chat Completions never share field names, so presence
  // of either input_tokens or output_tokens is an unambiguous shape signal.
  if (u.input_tokens !== undefined || u.output_tokens !== undefined) {
    const cached = u.input_tokens_details?.cached_tokens ?? 0;
    const input = u.input_tokens ?? 0;
    return {
      inputTokens: Math.max(0, input - cached),
      outputTokens: u.output_tokens ?? 0,
      cacheWriteTokens: 0, // OpenAI auto-caches with no separate write charge
      cacheReadTokens: cached,
      reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? 0,
    };
  }
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
    // Chat Completions chunks carry model/usage flat. The Responses API instead
    // streams named events (response.created, response.output_text.delta, ...,
    // response.completed) whose payload is the full resource nested under
    // `response` — so model/usage live at `.response.model` / `.response.usage`
    // there, not top-level. Checking both shapes unconditionally is cheap and
    // correct either way, since a Chat Completions chunk never has a `response`
    // key and a Responses event never has a top-level `usage`.
    const obj = json as {
      model?: string;
      usage?: OpenAIUsage | null;
      response?: { model?: string; usage?: OpenAIUsage | null };
    };
    const model = obj.model ?? obj.response?.model;
    if (model) this.seenModel = model;
    const usage = obj.usage ?? obj.response?.usage;
    if (usage) {
      const n = normalizeOpenAIUsage(usage);
      this.partial = { ...n };
      this.maxOutput = Math.max(this.maxOutput, n.outputTokens);
    }
  }
}
