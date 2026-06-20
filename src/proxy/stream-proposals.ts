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

import { extractProposals, type ProposedFile } from '../value/proposals.ts';
import type { Provider } from '../cost/pricing.ts';

interface AnthropicBlock {
  type: string; // 'tool_use' | 'text' | other
  name: string; // tool name (tool_use only)
  jsonParts: string[]; // input_json_delta fragments, concatenated into the tool input
  textParts: string[]; // text_delta fragments
}

interface OpenAIToolCall {
  name: string;
  argParts: string[]; // function.arguments fragments, concatenated into a JSON string
}

/**
 * Incrementally reassembles proposed edits from an SSE byte stream without
 * buffering the whole response. Feed it the same decoded text chunks the usage
 * accumulator sees; read `.proposals()` after the stream ends.
 */
export class StreamProposalAccumulator {
  private buffer = '';
  private readonly provider: Provider;
  private readonly anthropicBlocks = new Map<number, AnthropicBlock>();
  private readonly openaiToolCalls = new Map<number, OpenAIToolCall>();
  private readonly openaiText: string[] = [];

  constructor(provider: Provider) {
    this.provider = provider;
  }

  /** Feed a decoded chunk of the SSE stream. */
  push(chunk: string): void {
    this.buffer += chunk;
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
    const obj = json as {
      type?: string;
      index?: number;
      content_block?: { type?: string; name?: string; text?: string };
      delta?: { type?: string; partial_json?: string; text?: string };
    };
    if (obj.type === 'content_block_start' && typeof obj.index === 'number') {
      const cb = obj.content_block ?? {};
      const block: AnthropicBlock = { type: cb.type ?? 'unknown', name: cb.name ?? '', jsonParts: [], textParts: [] };
      if (typeof cb.text === 'string' && cb.text) block.textParts.push(cb.text);
      this.anthropicBlocks.set(obj.index, block);
    } else if (obj.type === 'content_block_delta' && typeof obj.index === 'number') {
      const block = this.anthropicBlocks.get(obj.index);
      if (!block || !obj.delta) return;
      if (typeof obj.delta.partial_json === 'string') block.jsonParts.push(obj.delta.partial_json);
      if (typeof obj.delta.text === 'string') block.textParts.push(obj.delta.text);
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
      if (typeof delta.content === 'string') this.openaiText.push(delta.content);
      if (!Array.isArray(delta.tool_calls)) continue;
      for (const tc of delta.tool_calls) {
        const i = typeof tc.index === 'number' ? tc.index : 0;
        let entry = this.openaiToolCalls.get(i);
        if (!entry) {
          entry = { name: '', argParts: [] };
          this.openaiToolCalls.set(i, entry);
        }
        if (tc.function?.name) entry.name = tc.function.name;
        if (typeof tc.function?.arguments === 'string') entry.argParts.push(tc.function.arguments);
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
      return extractProposals('anthropic', { content });
    }
    const tool_calls = [...this.openaiToolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, tc]) => ({ function: { name: tc.name, arguments: tc.argParts.join('') } }));
    const message = { content: this.openaiText.join(''), tool_calls };
    return extractProposals('openai', { choices: [{ message }] });
  }
}
