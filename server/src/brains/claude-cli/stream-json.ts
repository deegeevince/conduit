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

/** One tool the model has asked to use, from the assistant message that holds it. Only the name, the id and the input; never anything a tool returned. */
export interface ToolUseFacts {
  readonly id: string;
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The `tool_use` blocks of an assistant message; empty for any other event. */
export function toolUsesOf(event: ClaudeStreamEvent): ToolUseFacts[] {
  if (event.type !== 'assistant') return [];
  const message = (event as { message?: unknown }).message;
  const content = isRecord(message) ? message['content'] : undefined;
  if (!Array.isArray(content)) return [];
  const uses: ToolUseFacts[] = [];
  for (const block of content as unknown[]) {
    if (!isRecord(block) || block['type'] !== 'tool_use') continue;
    const { id, name, input } = block;
    if (typeof id === 'string' && typeof name === 'string') uses.push({ id, tool: name, input: isRecord(input) ? input : {} });
  }
  return uses;
}

/** The ids of tool calls that ended, and whether each failed, from the user message the CLI prints after a tool ran or was refused. The result's text is never read. */
export function toolResultsOf(event: ClaudeStreamEvent): { readonly id: string; readonly failed: boolean }[] {
  if (event.type !== 'user') return [];
  const message = (event as { message?: unknown }).message;
  const content = isRecord(message) ? message['content'] : undefined;
  if (!Array.isArray(content)) return [];
  const results: { id: string; failed: boolean }[] = [];
  for (const block of content as unknown[]) {
    if (!isRecord(block) || block['type'] !== 'tool_result') continue;
    const id = block['tool_use_id'];
    if (typeof id === 'string') results.push({ id, failed: block['is_error'] === true });
  }
  return results;
}

/**
 * The text blocks of a tool's result, by the id of the call. Used for the browser's calls only, and only to learn tab ids, addresses and
 * credential fields (`noteBrowserResult`); the text goes nowhere else. Images and anything that is not text are left out.
 */
export function toolResultTextsOf(event: ClaudeStreamEvent): { readonly id: string; readonly failed: boolean; readonly texts: readonly string[] }[] {
  if (event.type !== 'user') return [];
  const message = (event as { message?: unknown }).message;
  const content = isRecord(message) ? message['content'] : undefined;
  if (!Array.isArray(content)) return [];
  const out: { id: string; failed: boolean; texts: string[] }[] = [];
  for (const block of content as unknown[]) {
    if (!isRecord(block) || block['type'] !== 'tool_result' || typeof block['tool_use_id'] !== 'string') continue;
    const body = block['content'];
    const texts: string[] = [];
    if (typeof body === 'string') texts.push(body);
    else if (Array.isArray(body)) for (const part of body as unknown[]) if (isRecord(part) && part['type'] === 'text' && typeof part['text'] === 'string') texts.push(part['text']);
    out.push({ id: block['tool_use_id'], failed: block['is_error'] === true, texts });
  }
  return out;
}

/** What the CLI asks its host before a call: the `can_use_tool` control request. See the notes at the top of warm.ts. */
export interface PermissionAsk {
  readonly requestId: string;
  readonly toolUseId: string;
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export function permissionAskOf(event: ClaudeStreamEvent): PermissionAsk | null {
  if (event.type !== 'control_request') return null;
  const raw = event as { request_id?: unknown; request?: unknown };
  if (typeof raw.request_id !== 'string' || !isRecord(raw.request) || raw.request['subtype'] !== 'can_use_tool') return null;
  const { tool_name: tool, input, tool_use_id: toolUseId } = raw.request;
  if (typeof tool !== 'string') return null;
  return { requestId: raw.request_id, toolUseId: typeof toolUseId === 'string' ? toolUseId : raw.request_id, tool, input: isRecord(input) ? input : {} };
}

/** The CLI withdrew a question it had put to the host (the call was abandoned). Its request id, or null. */
export function cancelledAskOf(event: ClaudeStreamEvent): string | null {
  if (event.type !== 'control_cancel_request') return null;
  const id = (event as { request_id?: unknown }).request_id;
  return typeof id === 'string' ? id : null;
}
