/**
 * The lines `claude -p --output-format stream-json --include-partial-messages
 * --verbose` prints, as far as this adapter cares. Confirmed against Claude
 * Code 2.1.322; see docs/technology.md for a captured run. Every other event
 * type is ignored.
 */
export type ClaudeStreamEvent =
  | { readonly type: 'system'; readonly subtype: string; readonly tools?: readonly string[]; readonly mcp_servers?: readonly unknown[]; readonly model?: string }
  | {
      readonly type: 'stream_event';
      readonly event:
        | { readonly type: 'content_block_delta'; readonly index: number; readonly delta: { readonly type: 'text_delta'; readonly text: string } | { readonly type: string } }
        | { readonly type: string };
    }
  | { readonly type: 'result'; readonly subtype: string; readonly is_error: boolean; readonly result?: string; readonly api_error_status?: number | null }
  | { readonly type: string };

/** Parses one stdout line. Returns null for a line that is not JSON, which is logged and skipped, never fatal. */
export function parseStreamLine(line: string): ClaudeStreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string') return value as ClaudeStreamEvent;
  } catch {
    return null;
  }
  return null;
}

/** The text a `content_block_delta` / `text_delta` event carries, or null for any other event. Thinking deltas are not text. */
export function textDeltaOf(event: ClaudeStreamEvent): string | null {
  if (event.type !== 'stream_event') return null;
  const inner = (event as { event?: { type?: unknown; delta?: { type?: unknown; text?: unknown } } }).event;
  if (inner?.type !== 'content_block_delta' || inner.delta?.type !== 'text_delta') return null;
  return typeof inner.delta.text === 'string' ? inner.delta.text : null;
}

/** The failure a `result` event reports, or null when it reports success or is not a result. */
export function failureOf(event: ClaudeStreamEvent): string | null {
  if (event.type !== 'result') return null;
  const result = event as { subtype?: unknown; is_error?: unknown; result?: unknown; api_error_status?: unknown };
  if (result.is_error !== true && (typeof result.subtype !== 'string' || result.subtype === 'success')) return null;
  const detail = typeof result.result === 'string' && result.result.trim() !== '' ? result.result.trim() : `result ${String(result.subtype)}`;
  const status = typeof result.api_error_status === 'number' ? ` (API status ${result.api_error_status})` : '';
  return `${detail}${status}`;
}

export interface ClaudeResultFacts {
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  readonly thinkingTokens: number | null;
  /** cumulative for the process, not for the turn */
  readonly totalCostUsd: number | null;
  readonly ttftMs: number | null;
}

/** The numbers a `result` event carries, or null for any other event. Absent counts are 0 (the CLI omits what is zero), never guessed. */
export function resultFactsOf(event: ClaudeStreamEvent): ClaudeResultFacts | null {
  if (event.type !== 'result') return null;
  const r = event as { usage?: Record<string, unknown>; total_cost_usd?: unknown; ttft_ms?: unknown };
  const u = r.usage ?? {};
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const details = u['output_tokens_details'];
  const thinking = typeof details === 'object' && details !== null ? (details as { thinking_tokens?: unknown }).thinking_tokens : undefined;
  return {
    inputTokens: num(u['input_tokens']),
    cacheReadTokens: num(u['cache_read_input_tokens']),
    cacheWriteTokens: num(u['cache_creation_input_tokens']),
    outputTokens: num(u['output_tokens']),
    thinkingTokens: typeof thinking === 'number' ? thinking : null,
    totalCostUsd: typeof r.total_cost_usd === 'number' ? r.total_cost_usd : null,
    ttftMs: typeof r.ttft_ms === 'number' ? r.ttft_ms : null,
  };
}
