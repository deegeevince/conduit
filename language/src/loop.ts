// The loop's wire types: what the invariants say about a stage, and the decoders that read it back (PLAN-v3-core 2.8, 2.9; package LP1).
// Report-only: nothing here changes what is drawn. Shared by the page (which produces violations) and the server (which will class them).
// Not yet exported from `index.ts` (another package's file): the page and the tools reach it by path until the integrator adds `export * from './loop'`.

export const RULES = ['present', 'inside', 'apart', 'legible', 'reachable', 'steady', 'spoiler', 'shell'] as const;
export type Rule = (typeof RULES)[number];

/** `fault`: the painter's. `note`: a sight note for the brain (an overlap inside a canvas, a small target on a mouse). `blocking`: by rule, whatever weight a critic gives it. */
export const SEVERITIES = ['fault', 'note', 'blocking'] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface ViolationBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Where on the turn's time a check was made: a tick of play (seconds of the turn clock), or the stage at rest. */
export interface CensusMoment {
  readonly kind: 'play' | 'rest';
  readonly time: number;
}

export interface Violation {
  readonly rule: Rule;
  readonly severity: Severity;
  readonly at: CensusMoment;
  /** the element keys it is about, at most four */
  readonly keys: readonly string[];
  readonly detail: string;
  readonly box: ViolationBox | null;
}

/** What rides on a turn's `report` once the hook is made (an absent field reads as none). */
export interface LoopReport {
  /** a short digest of the resting census: the same stage gives the same digest */
  readonly digest: string;
  readonly leaves: number;
  readonly violations: readonly Violation[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function decodeBox(value: unknown): ViolationBox | null {
  if (!isRecord(value)) return null;
  const { x, y, width, height } = value;
  return isNumber(x) && isNumber(y) && isNumber(width) && isNumber(height) ? { x, y, width, height } : null;
}

/** One violation, or null for anything that is not one. */
export function decodeViolation(value: unknown): Violation | null {
  if (!isRecord(value)) return null;
  const { rule, severity, at, keys, detail, box } = value;
  const ruleFound = RULES.find((name) => name === rule);
  const severityFound = SEVERITIES.find((name) => name === severity);
  if (ruleFound === undefined || severityFound === undefined || typeof detail !== 'string' || !isRecord(at) || !Array.isArray(keys)) return null;
  const kind = at['kind'];
  const time = at['time'];
  if ((kind !== 'play' && kind !== 'rest') || !isNumber(time)) return null;
  return { rule: ruleFound, severity: severityFound, at: { kind, time }, keys: keys.filter((key): key is string => typeof key === 'string').slice(0, 4), detail: detail.slice(0, 400), box: decodeBox(box) };
}

/** The loop's part of a report; absent or malformed reads as clean and empty. */
export function decodeLoopReport(value: unknown): LoopReport {
  if (!isRecord(value)) return { digest: '', leaves: 0, violations: [] };
  const violations = Array.isArray(value['violations']) ? value['violations'].map(decodeViolation).filter((one): one is Violation => one !== null) : [];
  return { digest: typeof value['digest'] === 'string' ? value['digest'] : '', leaves: isNumber(value['leaves']) ? value['leaves'] : 0, violations };
}
