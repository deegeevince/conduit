// What comes over the network is checked, not cast (P2-40): each guard says what a value must be to be used, and
// a value that is not that is refused with a sentence, never half-believed.

import { BRAIN_EFFORTS, BRAIN_MODES } from '@conduit/language';
import type { AppStatus, BrainChoice, BrainEffort, BrainMode, CreateSessionResponse, DataTable, DemoInfo, LeadWindow, ToolChoice } from '@conduit/language';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStrings(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isLead(value: unknown): value is LeadWindow {
  return isRecord(value) && typeof value['low'] === 'number' && typeof value['high'] === 'number';
}

function isMode(value: unknown): value is BrainMode {
  return typeof value === 'string' && (BRAIN_MODES as readonly string[]).includes(value);
}

function isEffort(value: unknown): value is BrainEffort {
  return typeof value === 'string' && (BRAIN_EFFORTS as readonly string[]).includes(value);
}

export function asSessionResponse(value: unknown): CreateSessionResponse | null {
  if (!isRecord(value) || typeof value['session'] !== 'string' || value['session'] === '' || !isLead(value['lead'])) return null;
  return { session: value['session'], lead: value['lead'] };
}

export function asTurnId(value: unknown): string | null {
  return isRecord(value) && typeof value['turn'] === 'string' && value['turn'] !== '' ? value['turn'] : null;
}

export function asBrainChoice(value: unknown): BrainChoice | null {
  if (!isRecord(value) || typeof value['configurable'] !== 'boolean') return null;
  const model = value['model'];
  const effort = value['effort'];
  if (model !== null && typeof model !== 'string') return null;
  if (effort !== null && !isEffort(effort)) return null;
  const mode = isMode(value['mode']) ? value['mode'] : undefined;
  const modes = Array.isArray(value['modes']) ? value['modes'].filter(isMode) : undefined;
  return { configurable: value['configurable'], model, effort, ...(mode === undefined ? {} : { mode }), ...(modes === undefined ? {} : { modes }) };
}

export function asDemos(value: unknown): readonly DemoInfo[] {
  if (!Array.isArray(value)) return [];
  const demos: DemoInfo[] = [];
  for (const item of value) {
    if (isRecord(item) && typeof item['name'] === 'string' && typeof item['title'] === 'string' && typeof item['summary'] === 'string') {
      demos.push({ name: item['name'], title: item['title'], summary: item['summary'] });
    }
  }
  return demos;
}

export function asTools(value: unknown): readonly ToolChoice[] | null {
  if (!Array.isArray(value)) return null;
  const tools: ToolChoice[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item['name'] !== 'string' || typeof item['gist'] !== 'string' || typeof item['on'] !== 'boolean' || typeof item['reads'] !== 'boolean') return null;
    const kind = item['kind'] === 'service' ? 'service' : 'tool';
    tools.push({ name: item['name'], kind, gist: item['gist'], on: item['on'], reads: item['reads'] });
  }
  return tools;
}

export function asStatus(value: unknown): AppStatus | null {
  if (!isRecord(value) || !isStrings(value['live']) || !isStrings(value['building']) || !isStrings(value['waiting'])) return null;
  const updated = value['updated'];
  return { live: value['live'], building: value['building'], waiting: value['waiting'], updated: typeof updated === 'string' ? updated : null };
}

export function asDataTable(value: unknown): DataTable | null {
  if (!isRecord(value) || typeof value['id'] !== 'string' || typeof value['source'] !== 'string') return null;
  const columns = value['columns'];
  const rows = value['rows'];
  if (!isStrings(columns) || !Array.isArray(rows) || !rows.every(isStrings)) return null;
  return { id: value['id'], source: value['source'], columns, rows };
}

/** The standing asks the server holds for this conversation: a list of the user's own words. */
export function asAsks(value: unknown): readonly string[] | null {
  if (isRecord(value) && isStrings(value['asks'])) return value['asks'];
  return isStrings(value) ? value : null;
}

/** The server's own sentence for a refusal when it sent one. */
export function messageOf(body: unknown, fallback: string): string {
  return isRecord(body) && typeof body['message'] === 'string' && body['message'] !== '' ? body['message'] : fallback;
}
