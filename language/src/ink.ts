// Ink: what a hand drew, as it goes up with a turn. Pure types, limits and checks; nothing here knows a canvas.
//
// Strokes are vector JSON in the coordinates of whatever they were drawn on (the stage's pixels, a worksheet's pixels, a card's points), so they
// replay and scale. A turn carries them as `TurnInput.marks` (prompt kind): the cropped picture of the ink (an upload id, so the brain can see it),
// the strokes, what the ink was drawn ON (`on`: a document node, an element, an ask: the view says), the boxes the view defined and which strokes landed
// in each, and a slot for a voice note. Ink only carries marks. What a mark MEANS (a learner's working checked by an ask, "make this bigger" on a
// mock-up, a circled chart point) is the words and the thing it was drawn on, read by the brain; the verdict of a check is the ask piece's.

/** One sample: x, y (in the strokes' space), pressure 0..1 (the pen's, or simulated from speed), milliseconds since the stroke began. */
export type InkPoint = readonly [x: number, y: number, p: number, t: number];

export type InkTool = 'pen' | 'highlighter';

export interface InkStroke {
  /** unique within the document: `s1`, `s2`, ... */
  readonly id: string;
  readonly tool: InkTool;
  /** `#rrggbb` */
  readonly color: string;
  /** the nominal width in the document's units (a pen at full pressure draws about this wide) */
  readonly width: number;
  /** wall-clock milliseconds when the stroke began (for replaying the order and pauses) */
  readonly at: number;
  readonly points: readonly InkPoint[];
}

/** A rectangle in the document's units. */
export interface InkBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** The size of the space strokes live in: the thing drawn on, at the scale its coordinates mean. */
export interface InkSpace {
  readonly w: number;
  readonly h: number;
}

export interface InkDocument {
  readonly v: 1;
  readonly space: InkSpace;
  readonly strokes: readonly InkStroke[];
}

/** A box the view defined: an answer box, a scratch area, or any region worth reporting (an element of a mock-up, a chart's plot). */
export interface InkRegionDef {
  readonly id: string;
  /** `answer` and `scratch` are the worksheet's; `element` is a part of something on the canvas */
  readonly kind: 'answer' | 'scratch' | 'element';
  readonly label?: string;
  readonly box: InkBox;
}

/** A region and the strokes that landed in it (most of the stroke's points inside the box). */
export interface InkRegionHit extends InkRegionDef {
  readonly strokes: readonly string[];
}

/** What the ink was drawn on, in the view's own words: ids the brain and the document already know. All optional; the view fills what it has. */
export interface InkOn {
  /** a node of the document (a question, a scene) */
  readonly node?: string;
  /** an element on the stage or in the node (a mock-up's button, a chart) */
  readonly element?: string;
  /** an ask the working belongs to (the ask piece reads its own verdict from the turn that follows) */
  readonly ask?: string;
  /** a few words for the brain: "question 3 of the worksheet", "the music app mock-up" */
  readonly label?: string;
}

/** Voice goes beside ink in one turn. `text` is on-device dictation when the browser gave it; `audio` is an upload id of a recorded note (the voice note's, not ink's). */
export interface InkVoice {
  readonly text?: string;
  readonly audio?: string;
}

/** `TurnInput.marks`: ink and what it was drawn on, sent as part of a prompt. */
export interface InkMarks {
  /** the upload id of the picture of the ink (cropped to the inked part plus a margin, over its background when it has one) */
  readonly image: string;
  readonly space: InkSpace;
  /** the part of the space `image` shows */
  readonly crop: InkBox;
  readonly strokes: readonly InkStroke[];
  /** the view's boxes with the strokes in each; empty when the view defined none */
  readonly regions: readonly InkRegionHit[];
  /** strokes that landed in no box, when the view defined boxes */
  readonly outside?: readonly string[];
  readonly on?: InkOn;
  /** the upload id of the photo the ink was drawn over, when it was a photo */
  readonly background?: string;
  readonly voice?: InkVoice;
}

/**
 * The most ink a turn carries. Marks are kept in the session log with the turn, so they are bounded: `bytes` is the length of the marks as JSON.
 * A learner's page of working is a few hundred strokes; a stage doodle is tens.
 */
export const INK_LIMITS = {
  strokes: 1500,
  pointsPerStroke: 4000,
  points: 40_000,
  bytes: 600_000,
  regions: 32,
  idChars: 64,
  labelChars: 120,
  voiceChars: 1000,
  maxWidth: 200,
  maxSpace: 20_000,
} as const;

const COLOR = /^#[0-9a-fA-F]{6}$/;
const UPLOAD_ID = /^u[1-9][0-9]{0,3}$/;

/** A reason, or null. Pure: used by the page when it parses saved ink and by the server at the edge. */
export type InkProblem = string | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function checkInkSpace(value: unknown, what = 'space'): InkProblem {
  if (!isRecord(value) || !finite(value['w']) || !finite(value['h'])) return `${what} must be {w, h}`;
  if (value['w'] < 1 || value['h'] < 1 || value['w'] > INK_LIMITS.maxSpace || value['h'] > INK_LIMITS.maxSpace) return `${what} must be between 1 and ${INK_LIMITS.maxSpace}`;
  return null;
}

export function checkInkBox(value: unknown, what: string): InkProblem {
  if (!isRecord(value) || !finite(value['x']) || !finite(value['y']) || !finite(value['w']) || !finite(value['h'])) return `${what} must be {x, y, w, h}`;
  if (value['w'] < 0 || value['h'] < 0) return `${what} must not have a negative size`;
  return null;
}

/** Checks the strokes of a document: shape, bounds and the totals. */
export function checkInkStrokes(value: unknown, what = 'strokes'): InkProblem {
  if (!Array.isArray(value)) return `${what} must be a list`;
  if (value.length > INK_LIMITS.strokes) return `${what} has more than ${INK_LIMITS.strokes} strokes`;
  let total = 0;
  const ids = new Set<string>();
  for (const [index, raw] of value.entries()) {
    if (!isRecord(raw)) return `${what}[${index}] must be an object`;
    const id = raw['id'];
    if (typeof id !== 'string' || id === '' || id.length > INK_LIMITS.idChars) return `${what}[${index}].id must be a short string`;
    if (ids.has(id)) return `${what}[${index}].id repeats ${id}`;
    ids.add(id);
    if (raw['tool'] !== 'pen' && raw['tool'] !== 'highlighter') return `${what}[${index}].tool must be pen or highlighter`;
    if (typeof raw['color'] !== 'string' || !COLOR.test(raw['color'])) return `${what}[${index}].color must be #rrggbb`;
    const width = raw['width'];
    if (!finite(width) || width <= 0 || width > INK_LIMITS.maxWidth) return `${what}[${index}].width is out of range`;
    if (!finite(raw['at'])) return `${what}[${index}].at must be a number`;
    const points = raw['points'];
    if (!Array.isArray(points) || points.length === 0) return `${what}[${index}].points must not be empty`;
    if (points.length > INK_LIMITS.pointsPerStroke) return `${what}[${index}] has more than ${INK_LIMITS.pointsPerStroke} points`;
    total += points.length;
    if (total > INK_LIMITS.points) return `${what} has more than ${INK_LIMITS.points} points in all`;
    for (const point of points) {
      if (!Array.isArray(point) || point.length !== 4 || !point.every(finite)) return `${what}[${index}] has a point that is not [x, y, pressure, time]`;
      const p = point[2] as number;
      if (p < 0 || p > 1) return `${what}[${index}] has a pressure outside 0 to 1`;
    }
  }
  return null;
}

/** Checks a saved document (what `serialize` wrote). */
export function checkInkDocument(value: unknown): InkProblem {
  if (!isRecord(value) || value['v'] !== 1) return 'not ink (version 1)';
  return checkInkSpace(value['space']) ?? checkInkStrokes(value['strokes']);
}

function checkOn(value: unknown): InkProblem {
  if (!isRecord(value)) return 'on must be an object';
  for (const key of ['node', 'element', 'ask', 'label'] as const) {
    const held = value[key];
    if (held === undefined) continue;
    if (typeof held !== 'string' || held.length > (key === 'label' ? INK_LIMITS.labelChars : INK_LIMITS.idChars)) return `on.${key} must be a short string`;
  }
  return null;
}

/** Checks `TurnInput.marks` as it arrives. Whether the upload ids are this conversation's is the conductor's to say. */
export function checkInkMarks(value: unknown): InkProblem {
  if (!isRecord(value)) return 'marks must be an object';
  if (typeof value['image'] !== 'string' || !UPLOAD_ID.test(value['image'])) return 'marks.image must be the id the server gave the picture of the ink (u1, u2, ...)';
  if (value['background'] !== undefined && (typeof value['background'] !== 'string' || !UPLOAD_ID.test(value['background']))) return 'marks.background must be an upload id';
  const problem = checkInkSpace(value['space'], 'marks.space') ?? checkInkBox(value['crop'], 'marks.crop') ?? checkInkStrokes(value['strokes'], 'marks.strokes');
  if (problem !== null) return problem;
  const regions = value['regions'];
  if (!Array.isArray(regions) || regions.length > INK_LIMITS.regions) return `marks.regions must be a list of at most ${INK_LIMITS.regions}`;
  const strokeIds = new Set((value['strokes'] as readonly { id: string }[]).map((stroke) => stroke.id));
  for (const [index, region] of regions.entries()) {
    if (!isRecord(region)) return `marks.regions[${index}] must be an object`;
    if (typeof region['id'] !== 'string' || region['id'] === '' || region['id'].length > INK_LIMITS.idChars) return `marks.regions[${index}].id must be a short string`;
    if (region['kind'] !== 'answer' && region['kind'] !== 'scratch' && region['kind'] !== 'element') return `marks.regions[${index}].kind must be answer, scratch or element`;
    if (region['label'] !== undefined && (typeof region['label'] !== 'string' || region['label'].length > INK_LIMITS.labelChars)) return `marks.regions[${index}].label must be a short string`;
    const boxProblem = checkInkBox(region['box'], `marks.regions[${index}].box`);
    if (boxProblem !== null) return boxProblem;
    const named = region['strokes'];
    if (!Array.isArray(named) || !named.every((id) => typeof id === 'string' && strokeIds.has(id))) return `marks.regions[${index}].strokes must name strokes of marks.strokes`;
  }
  const outside = value['outside'];
  if (outside !== undefined && (!Array.isArray(outside) || !outside.every((id) => typeof id === 'string' && strokeIds.has(id)))) return 'marks.outside must name strokes of marks.strokes';
  if (value['on'] !== undefined) {
    const onProblem = checkOn(value['on']);
    if (onProblem !== null) return onProblem;
  }
  const voice = value['voice'];
  if (voice !== undefined) {
    if (!isRecord(voice)) return 'marks.voice must be an object';
    if (voice['text'] !== undefined && (typeof voice['text'] !== 'string' || voice['text'].length > INK_LIMITS.voiceChars)) return `marks.voice.text must be at most ${INK_LIMITS.voiceChars} characters`;
    if (voice['audio'] !== undefined && (typeof voice['audio'] !== 'string' || !UPLOAD_ID.test(voice['audio']))) return 'marks.voice.audio must be an upload id';
  }
  if (JSON.stringify(value).length > INK_LIMITS.bytes) return `marks are larger than ${INK_LIMITS.bytes} bytes`;
  return null;
}

/** The line the brain reads in place of the strokes: what was drawn on, where the ink landed, and the standing instruction. Never the raw points. */
export function describeInkMarks(marks: InkMarks): string {
  const parts: string[] = [];
  const on = marks.on;
  if (on !== undefined) {
    const named = [on.label, on.node === undefined ? null : `node ${on.node}`, on.element === undefined ? null : `element ${on.element}`, on.ask === undefined ? null : `ask ${on.ask}`].filter((part): part is string => part !== null && part !== undefined);
    if (named.length > 0) parts.push(`It was drawn on: ${named.join('; ')}.`);
  }
  const used = marks.regions.filter((region) => region.strokes.length > 0);
  if (marks.regions.length > 0) {
    const boxes = marks.regions.map((region) => `${region.id}${region.label === undefined ? '' : ` (${region.label})`} [${region.kind}]: ${region.strokes.length === 0 ? 'empty' : `${region.strokes.length} stroke${region.strokes.length === 1 ? '' : 's'}`}`);
    parts.push(`Boxes: ${boxes.join('; ')}${(marks.outside?.length ?? 0) > 0 ? `; ${marks.outside?.length} stroke(s) outside every box` : ''}.`);
    if (used.length === 0) parts.push('Every box is empty.');
  }
  parts.push(`${marks.strokes.length} stroke${marks.strokes.length === 1 ? '' : 's'}.`);
  if (marks.voice?.text !== undefined && marks.voice.text !== '') parts.push(`What was said while drawing (dictated): "${marks.voice.text}".`);
  return parts.join(' ');
}

/** The brief's block for ink. The instruction for a learner's working is the owner's wording: kind, and never the answer. */
export function inkBrief(marks: InkMarks): string {
  return `THE USER WROTE OR DREW (attached): read the handwriting and the drawing; for a learner's working, say kindly what she did and give the next hint, never the answer. When the ink marks up something shown (a circle, an arrow, a note), it points at that thing: do what the words ask about it. ${describeInkMarks(marks)}`;
}
