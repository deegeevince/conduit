// What comes over the event stream is checked, not cast (v2.1 review, W-3): a stage event that is not the shape its type promises is
// refused with a sentence, so the painter never acts on half of one. Only what the painter reads is checked; an extra field is fine.

import { STAGE_EVENT_TYPES } from './wire';
import type { StageEvent, StageEventType } from './wire';

type Shape = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'string|null' | 'number|null';

const SHAPES: Record<StageEventType, Record<string, Shape>> = {
  hello: { session: 'string', lead: 'object', services: 'object' },
  turn: { turn: 'string', input: 'object' },
  reading: { turn: 'string', label: 'string', state: 'string', message: 'string|null' },
  line: { turn: 'string', seq: 'number', text: 'string', issues: 'array' },
  reject: { turn: 'string', raw: 'string', issues: 'array' },
  end: { turn: 'string', reason: 'string', message: 'string|null' },
  pass: { turn: 'string', pass: 'number', state: 'string', reason: 'string|null' },
  asset: { turn: 'string', key: 'string', status: 'string', url: 'string|null', reason: 'string|null' },
  data: { turn: 'string', id: 'string', status: 'string', url: 'string|null', reason: 'string|null' },
  picture: { turn: 'string', id: 'string', url: 'string', credit: 'string', landing: 'string' },
  candidate: { turn: 'string', pass: 'number', lines: 'array' },
  critic: { turn: 'string', finding: 'object' },
  activity: { turn: 'string', id: 'string', tool: 'string', summary: 'string', state: 'string', ms: 'number|null' },
  permission: { turn: 'string', request: 'string', tool: 'string', summary: 'string', risk: 'string', expiresMs: 'number' },
  doc: { turn: 'string|null', document: 'string', title: 'string', root: 'string', nodes: 'array' },
  want: { turn: 'string', request: 'string', what: 'string', target: 'string|null', deadlineMs: 'number' },
};

function isShape(value: unknown, shape: Shape): boolean {
  switch (shape) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'string|null':
      return value === null || typeof value === 'string';
    case 'number|null':
      return value === null || (typeof value === 'number' && Number.isFinite(value));
  }
}

/** The event of this type that `body` is, or why it is not one. An optional field a type allows to be absent is read as null by the painter. */
export function checkStageEvent(type: string, body: unknown): { readonly event: StageEvent } | { readonly why: string } {
  if (!(STAGE_EVENT_TYPES as readonly string[]).includes(type)) return { why: `"${type}" is not a stage event` };
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { why: `a ${type} event whose data is not an object` };
  const record = body as Record<string, unknown>;
  const shapes = SHAPES[type as StageEventType];
  for (const [field, shape] of Object.entries(shapes)) {
    const value = record[field];
    // The server leaves a null out of the JSON now and then; the painter reads a missing one as null.
    if (value === undefined && shape.endsWith('|null')) continue;
    if (!isShape(value, shape)) return { why: `a ${type} event whose ${field} is not ${shape}` };
  }
  return { event: { ...record, type } as StageEvent };
}
