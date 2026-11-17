import { STANDING_LIMITS } from './context';
import { parsePathData } from './geometry';
import type { StageSlot } from './lesson';
import { isLessonId, isLessonVerb, isSpan, readCrop, readShow, splitValues, tagWord } from './lesson';
import type { LessonLine } from './lesson';
import { BUILTIN_STYLE_NAMES, own } from './style';
import { splitCells } from './text';
import { TUNE_TEMPO_RANGE } from './tune';
import { APPROX_FROM } from './types';
import type {
  BindOn,
  CanvasBox,
  CamLine,
  Approx,
  CardLine,
  ColourRef,
  ControlLine,
  FillRef,
  HexColor,
  Issue,
  IssueCode,
  Line,
  LinkLine,
  LookProps,
  Near,
  NodeLine,
  ParseResult,
  Point,
  SceneLine,
  Seconds,
  ShapeGeometry,
  SpriteKey,
  StructureLine,
  StyleProps,
  Target,
  When,
} from './types';
import {
  PROBLEM_WAYS,
  PROBLEM_WAY_WORDS,
  ALIGNS,
  AMBIENT_KINDS,
  AMOUNTS,
  ANCHORS,
  BLEEDS,
  BLENDS,
  BYS,
  CAMERA_MOVES,
  CAMERA_SPEEDS,
  CANVAS_NAMES,
  CHART_KINDS,
  CHART_WORDS,
  CLEARS,
  CODE_LANGUAGES,
  TUNE_VOICES,
  APP_HEIGHT,
  APP_SHELVES,
  APP_SHELF_ALIASES,
  CONTROL_VERBS,
  DIRECTIONS,
  ENTER_EFFECTS,
  EXIT_EFFECTS,
  FACES,
  FX_NAMES,
  GROWTHS,
  HIT_GESTURES,
  INK_ROLES,
  LAYERS,
  LAYOUTS,
  LETTERCASES,
  LIMITS,
  LINK_ENDS,
  LOOPS,
  MARKS,
  MASKS,
  MEDIUMS,
  MOODS,
  NODE_SHAPES,
  PACES,
  PICK_FORMS,
  RESERVED_IDS,
  SHAPE_VERBS,
  SIDES,
  SIZES,
  STAY_WORDS,
  STROKES,
  STRUCTURE_VERBS,
  TEXTURES,
  VERBS,
  WEIGHTS,
  LESSON_LIMITS,
} from './vocabulary';
import { REFINE_LIMITS } from './wire';
import type { AmbientKind, Amount, AppShelf, Anchor, CameraMove, CameraSpeed, ControlVerb, FxName, ShapeVerb, StructureVerb, Verb } from './vocabulary';

const NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;
const HEX_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/;
const NUMBER_PATTERN = /^(?:\d+\.?\d*|\.\d+)$/;
const SIGNED_PATTERN = /^-?(?:\d+\.?\d*|\.\d+)$/;
/** `12`, `10,20`, `40x25`, `-3.5,8`: the ways geometry is written between the id and the properties. */
const GEOMETRY_PATTERN = /^-?(?:\d+\.?\d*|\.\d+)(?:[,x]-?(?:\d+\.?\d*|\.\d+))*$/;

// Accepted, never emitted: the words a model reaches for first.
const VERB_ALIASES: Readonly<Record<string, Verb>> = {
  camera: 'cam',
  text: 'say',
  sprite: 'pix',
  pixel: 'pix',
  pixels: 'pix',
  colour: 'color',
  polygon: 'poly',
  polyline: 'line',
  image: 'paint',
  picture: 'paint',
  weather: 'ambient',
  particles: 'ambient',
  flowchart: 'flow',
  graph: 'flow',
  diagram: 'flow',
  edge: 'link',
  connect: 'link',
  pin: 'node',
  event: 'node',
  switch: 'toggle',
  checkbox: 'toggle',
  textbox: 'input',
  bars: 'chart',
  barchart: 'chart',
  candles: 'chart',
  candlestick: 'chart',
  plot: 'chart',
  tabs: 'pick',
  menu: 'pick',
  stepper: 'pick',
  select: 'pick',
  dropdown: 'pick',
  radio: 'pick',
};

/** Aliases that say more than the verb: the word they stand for is put back after it (`tabs | a | b` reads as `pick tabs | a | b`). */
const ALIAS_WORDS: Readonly<Record<string, string>> = {
  bars: 'columns',
  barchart: 'columns',
  candles: 'candles',
  candlestick: 'candles',
  tabs: 'tabs',
  menu: 'menu',
  dropdown: 'menu',
  select: 'menu',
  stepper: 'steps',
};

const CAMERA_ALIASES: Readonly<Record<string, CameraMove>> = {
  'push-in': 'push',
  'pull-back': 'pull',
  'pull-out': 'pull',
  zoom: 'push',
  reset: 'rest',
};

const MAX_BEATS = 20;
const MAX_CAMERA_SECONDS = 20;
const MAX_SCENE_LINES = 12;
const MAX_THICK = 40;
const MAX_DASH = 200;
/** Colours in a gradient or along a stroke. */
const MAX_STOPS = 8;
const MAX_SCALE = 100;
const MAX_FPS = 24;
const MAX_SOFT = 40;
const COORDINATE_LIMIT = 1000;
/** A node's number may be a year or a count far larger than any coordinate. */
const VALUE_LIMIT = 1e9;
/** `0..90`, `-10..40`, `60..20`: a span of numbers, on a slider or a bind. */
const SPAN_PATTERN = /^(-?(?:\d+\.?\d*|\.\d+))\.\.(-?(?:\d+\.?\d*|\.\d+))$/;

interface Pair {
  readonly key: string;
  /** lower-cased */
  readonly value: string;
  /** as written; a sprite key's characters keep their case */
  readonly raw: string;
  readonly token: string;
}

interface Head {
  readonly words: string[];
  readonly pairs: Pair[];
  when: When | undefined;
}

class Issues {
  readonly list: Issue[] = [];

  warn(code: IssueCode, message: string, token?: string): void {
    this.list.push(token === undefined ? { code, severity: 'warn', message } : { code, severity: 'warn', message, token });
  }

  error(code: IssueCode, message: string, token?: string): void {
    this.list.push(token === undefined ? { code, severity: 'error', message } : { code, severity: 'error', message, token });
  }

  get failed(): boolean {
    return this.list.some((issue) => issue.severity === 'error');
  }
}

function oneOf<T extends string>(list: readonly T[], value: string): value is T {
  return (list as readonly string[]).includes(value);
}

export function isValidName(value: string): boolean {
  return NAME_PATTERN.test(value) && value.length <= LIMITS.name;
}

export function isValidElementId(value: string): boolean {
  return isValidName(value) && !oneOf(RESERVED_IDS, value);
}

function parseSeconds(token: string): number | null {
  const body = token.endsWith('s') ? token.slice(0, -1) : token;
  if (!NUMBER_PATTERN.test(body)) return null;
  const value = Number(body);
  return Number.isFinite(value) ? value : null;
}

function parseNumber(token: string, min: number, max: number): number | null {
  if (!SIGNED_PATTERN.test(token)) return null;
  const value = Number(token);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : null;
}

function parseWhen(token: string): When | null {
  const body = token.slice(1);
  if (body === 'with') return { kind: 'with' };
  if (body.startsWith('+')) {
    const seconds = parseSeconds(body.slice(1));
    return seconds === null ? null : { kind: 'after', seconds: Math.min(seconds, LIMITS.wait) };
  }
  if (body.startsWith('-')) {
    const seconds = parseSeconds(body.slice(1));
    return seconds === null ? null : { kind: 'before', seconds: Math.min(seconds, LIMITS.wait) };
  }
  const seconds = parseSeconds(body);
  return seconds === null ? null : { kind: 'at', seconds };
}

/** L1. A value written in quotes (`label="right atrium"`, `chord="C major"`) is one token: its spaces are held as this mark until the head is read. */
const SPACE_MARK = '\u0001';
const QUOTED_VALUE = /([=:])["\u201c]([^"\u201d]*)["\u201d]/g;

/** A head with its quoted values made single tokens. Only a quote that follows `=` or `:` opens one, so a word in quotes elsewhere is left alone. */
function holdQuoted(head: string): string {
  return head.replace(QUOTED_VALUE, (_all, mark: string, inner: string) => `${mark}${inner.trim().replace(/\s+/g, SPACE_MARK)}`);
}

/** Where the bar that starts the words is: the first one that is not inside a quoted value. */
function barOf(source: string): number {
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' || char === '\u201d') quoted = false;
    } else if ((char === '"' || char === '\u201c') && (source[index - 1] === '=' || source[index - 1] === ':') && /["\u201d]/.test(source.slice(index + 1))) quoted = true;
    else if (char === '|') return index;
  }
  return -1;
}

function readHead(rawTokens: readonly string[], issues: Issues): Head {
  const head: Head = { words: [], pairs: [], when: undefined };
  const tokens = rawTokens.map((token) => token.replaceAll(SPACE_MARK, ' '));
  for (const token of tokens) {
    if (token.startsWith('@')) {
      const when = parseWhen(token.toLowerCase());
      if (when === null) issues.warn('bad-time', `"${token}" is not a time; use @with, @+N, @-N or @N`, token);
      else head.when = when;
      continue;
    }
    const equals = token.indexOf('=');
    if (equals > 0) {
      const raw = token.slice(equals + 1);
      head.pairs.push({ key: token.slice(0, equals).toLowerCase(), value: raw.toLowerCase(), raw, token });
      continue;
    }
    head.words.push(token.toLowerCase());
  }
  return head;
}

function parsePoint(value: string): Point | null {
  const parts = value.split(',');
  if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) return null;
  const x = parseNumber(parts[0], -COORDINATE_LIMIT, COORDINATE_LIMIT);
  const y = parseNumber(parts[1], -COORDINATE_LIMIT, COORDINATE_LIMIT);
  return x === null || y === null ? null : { x, y };
}

function parseTap(value: string): boolean | null {
  if (value === 'yes' || value === 'true' || value === '1') return true;
  if (value === 'no' || value === 'false' || value === '0') return false;
  return null;
}

function parseHex(value: string): HexColor | null {
  return HEX_PATTERN.test(value) ? (value as HexColor) : null;
}

/** A role, an exact colour, or a name to be looked up when the line is scheduled. */
function parseColour(value: string): ColourRef | null {
  if (oneOf(INK_ROLES, value)) return value;
  const hex = parseHex(value);
  if (hex !== null) return hex;
  return isValidName(value) && value !== 'none' ? { named: value } : null;
}

/** Colours joined by `>`, two to `MAX_STOPS` of them. */
function parseStops(value: string): ColourRef[] | null {
  const parts = value.split('>');
  if (parts.length < 2 || parts.length > MAX_STOPS) return null;
  const stops: ColourRef[] = [];
  for (const part of parts) {
    const colour = parseColour(part);
    if (colour === null) return null;
    stops.push(colour);
  }
  return stops;
}

function parseFill(value: string): FillRef | null {
  if (value === 'none') return 'none';
  if (value.includes('>')) {
    const stops = parseStops(value);
    const from = stops?.[0];
    const to = stops?.[stops.length - 1];
    if (stops === null || from === undefined || to === undefined) return null;
    return stops.length > 2 ? { from, to, mid: stops.slice(1, -1) } : { from, to };
  }
  return parseColour(value);
}

/** `a>b>c`: widths along a stroke. */
function parseWidths(value: string): number[] | null {
  const parts = value.split('>');
  if (parts.length < 2 || parts.length > MAX_STOPS) return null;
  const widths: number[] = [];
  for (const part of parts) {
    const width = parseNumber(part, 0, MAX_THICK);
    if (width === null) return null;
    widths.push(width);
  }
  return widths;
}

/** What a bare `dashed` on a shape means: `dash=3,2`, canvas units. */
const DEFAULT_DASH: [number, number] = [3, 2];

/** `on,off` (or one number for both), in canvas units: never so fine that a stroke becomes thousands of dashes. */
function parseDash(value: string): [number, number] | null {
  const parts = value.split(',');
  if (parts.length < 1 || parts.length > 2) return null;
  const on = parseNumber(parts[0] ?? '', 0.05, MAX_DASH);
  const off = parts[1] === undefined ? on : parseNumber(parts[1], 0.05, MAX_DASH);
  return on === null || off === null ? null : [on, off];
}

function parseNear(value: string): Near | null {
  const [id, side] = value.split(':');
  if (id === undefined || !isValidElementId(id)) return null;
  if (side === undefined) return { id, side: 'auto' };
  return oneOf(SIDES, side) ? { id, side } : null;
}

/** Reads every style property out of `pairs`; anything it does not know is left in `rest`. */
function readStyleProps(pairs: readonly Pair[], issues: Issues): { props: StyleProps; rest: Pair[] } {
  const props: { -readonly [K in keyof StyleProps]: StyleProps[K] } = {};
  const rest: Pair[] = [];
  const bad = (pair: Pair, expected: string): void => {
    issues.warn('bad-value', `${pair.key}=${pair.value} ignored; expected ${expected}`, pair.token);
  };
  for (const pair of pairs) {
    const { key, value } = pair;
    switch (key) {
      case 'size':
        if (oneOf(SIZES, value)) props.size = value;
        else bad(pair, SIZES.join(' | '));
        break;
      case 'ink':
      case 'color':
      case 'colour': {
        const colour = parseColour(value);
        if (colour !== null) props.ink = colour;
        else bad(pair, `${INK_ROLES.join(' | ')} | a colour name | #rrggbb`);
        break;
      }
      case 'fill': {
        const fill = parseFill(value);
        if (fill !== null) props.fill = fill;
        else bad(pair, 'none | a colour | top>bottom');
        break;
      }
      case 'stroke': {
        const colour = value === 'none' ? 'none' : parseColour(value);
        if (value.includes('>')) {
          const stops = parseStops(value);
          if (stops !== null) {
            props.stroke = stops[0] ?? 'ink';
            props.strokeAlong = stops.slice(1);
          } else bad(pair, 'c1>c2');
        } else if (colour !== null) props.stroke = colour;
        else bad(pair, 'none | a colour | c1>c2');
        break;
      }
      case 'bleed':
        if (oneOf(BLEEDS, value)) props.bleed = value;
        else bad(pair, BLEEDS.join(' | '));
        break;
      case 'thick':
      case 'stroke-width': {
        const widths = value.includes('>') ? parseWidths(value) : null;
        const thick = widths !== null ? Math.max(...widths) : parseNumber(value, 0, MAX_THICK);
        if (thick !== null) {
          props.thick = thick;
          if (widths !== null) props.thickAlong = widths;
        } else bad(pair, 'a number of canvas units | a>b>c');
        break;
      }
      case 'dash': {
        const dash = parseDash(value);
        if (dash !== null) props.dash = dash;
        else bad(pair, 'on,off in canvas units');
        break;
      }
      case 'clip':
        if (value === 'none' || isValidElementId(value)) props.clip = value;
        else bad(pair, 'the id of a shape');
        break;
      case 'blend':
        if (oneOf(BLENDS, value)) props.blend = value;
        else bad(pair, BLENDS.join(' | '));
        break;
      case 'radial': {
        const radial = parseTap(value);
        if (radial !== null) props.radial = radial;
        else bad(pair, 'yes | no');
        break;
      }
      case 'angle': {
        const angle = parseNumber(value, -360, 360);
        if (angle !== null) props.angle = angle;
        else bad(pair, 'degrees');
        break;
      }
      case 'brush':
        if (oneOf(STROKES, value)) props.brush = value;
        else bad(pair, STROKES.join(' | '));
        break;
      case 'tex':
      case 'texture':
        if (oneOf(TEXTURES, value)) props.tex = value;
        else bad(pair, TEXTURES.join(' | '));
        break;
      case 'soft': {
        const soft = parseNumber(value, 0, MAX_SOFT);
        if (soft !== null) props.soft = soft;
        else bad(pair, 'a number of canvas units');
        break;
      }
      case 'leader': {
        const leader = parseTap(value);
        if (leader !== null) props.leader = leader;
        else bad(pair, 'yes | no');
        break;
      }
      case 'weight':
        if (oneOf(WEIGHTS, value)) props.weight = value;
        else bad(pair, WEIGHTS.join(' | '));
        break;
      case 'face':
      case 'font':
        if (oneOf(FACES, value)) props.face = value;
        else bad(pair, FACES.join(' | '));
        break;
      case 'enter':
        if (oneOf(ENTER_EFFECTS, value)) props.enter = value;
        else bad(pair, ENTER_EFFECTS.join(' | '));
        break;
      case 'by':
        if (oneOf(BYS, value)) props.by = value;
        else bad(pair, BYS.join(' | '));
        break;
      case 'exit':
        if (oneOf(EXIT_EFFECTS, value)) props.exit = value;
        else bad(pair, EXIT_EFFECTS.join(' | '));
        break;
      case 'loop':
        if (oneOf(LOOPS, value)) props.loop = value;
        else bad(pair, LOOPS.join(' | '));
        break;
      case 'mark':
        if (oneOf(MARKS, value)) props.mark = value;
        else bad(pair, MARKS.join(' | '));
        break;
      case 'case':
        if (oneOf(LETTERCASES, value)) props.case = value;
        else bad(pair, LETTERCASES.join(' | '));
        break;
      case 'stay': {
        if (oneOf(STAY_WORDS, value)) {
          props.stay = value;
          break;
        }
        const seconds = parseSeconds(value);
        if (seconds !== null && seconds > 0) props.stay = { seconds } satisfies Seconds;
        else bad(pair, `${STAY_WORDS.join(' | ')} | Ns`);
        break;
      }
      case 'layer':
        if (oneOf(LAYERS, value)) props.layer = value;
        else bad(pair, LAYERS.join(' | '));
        break;
      case 'at': {
        if (oneOf(ANCHORS, value)) {
          props.at = value;
          break;
        }
        const point = parsePoint(value);
        if (point !== null) props.at = point;
        else bad(pair, `${ANCHORS.join(' | ')} | x,y`);
        break;
      }
      case 'near': {
        const near = parseNear(value);
        if (near !== null) props.near = near;
        else bad(pair, `an element id, or id:${SIDES.join('|')}`);
        break;
      }
      case 'in':
        if (isValidElementId(value)) props.in = value;
        else bad(pair, 'a group id');
        break;
      case 'scale': {
        const scale = parseNumber(value, 0.01, MAX_SCALE);
        if (scale !== null) props.scale = scale;
        else bad(pair, 'a number');
        break;
      }
      case 'rot':
      case 'rotate': {
        const rot = parseNumber(value, -3600, 3600);
        if (rot !== null) props.rot = rot;
        else bad(pair, 'degrees');
        break;
      }
      case 'opacity': {
        const opacity = parseNumber(value, 0, 1);
        if (opacity !== null) props.opacity = opacity;
        else bad(pair, '0..1');
        break;
      }
      case 'tap': {
        const tap = parseTap(value);
        if (tap !== null) props.tap = tap;
        else bad(pair, 'yes | no');
        break;
      }
      case 'dur': {
        const seconds = parseSeconds(value);
        if (seconds !== null && seconds > 0) props.dur = Math.min(seconds, LIMITS.enter);
        else bad(pair, 'seconds, e.g. dur=0.8s');
        break;
      }
      default:
        rest.push(pair);
    }
  }
  return { props, rest };
}

function warnUnknownPairs(pairs: readonly Pair[], issues: Issues): void {
  for (const pair of pairs) issues.warn('unknown-key', `"${pair.key}" is not a property here; ignored`, pair.token);
}

function warnUnknownWords(words: readonly string[], issues: Issues): void {
  for (const word of words) issues.warn('unknown-word', `"${word}" means nothing here; ignored`, word);
}

function readStyleNames(words: readonly string[], issues: Issues): string[] {
  const names: string[] = [];
  for (const word of words) {
    if (isValidName(word)) names.push(word);
    else issues.warn('unknown-word', `"${word}" cannot be a style name; ignored`, word);
  }
  return names;
}

function readTarget(word: string | undefined, issues: Issues): Target | null {
  if (word === undefined) {
    issues.error('missing-id', 'expected an element id, "scene" or "all"');
    return null;
  }
  if (word === 'all') return { kind: 'all' };
  if (word === 'scene') return { kind: 'scene' };
  if (!isValidElementId(word)) {
    issues.error('bad-id', `"${word}" is not an element id`, word);
    return null;
  }
  return { kind: 'id', id: word };
}

function readElementId(word: string | undefined, issues: Issues): string | null {
  if (word === undefined) {
    issues.error('missing-id', 'expected an element id');
    return null;
  }
  if (!isValidElementId(word)) {
    issues.error('bad-id', `"${word}" is not an element id`, word);
    return null;
  }
  return word;
}

function cleanText(text: string | null, limit: number, issues: Issues): string | null {
  if (text === null) return null;
  let cleaned = text.trim();
  // One pair of quotes around the whole text is wrapping; quotes anywhere else are the text's own (dialogue).
  if (cleaned.length >= 2 && cleaned.startsWith('"') && cleaned.endsWith('"') && !cleaned.slice(1, -1).includes('"')) cleaned = cleaned.slice(1, -1).trim();
  if (cleaned === '') return null;
  if (cleaned.length > limit) {
    const cut = cleaned.lastIndexOf(' ', limit - 1);
    cleaned = `${cleaned.slice(0, cut > limit / 2 ? cut : limit - 1)}…`;
    issues.warn('text-too-long', `text cut to ${limit} characters; say less per line`);
  }
  return cleaned;
}

function withWhen<T extends object>(line: T, when: When | undefined): T & { when?: When } {
  return when === undefined ? line : { ...line, when };
}

/**
 * Splits the words after a verb into an optional leading id, the geometry
 * numbers, and whatever is left (style names, vocabulary words). The id is
 * optional everywhere something is created. On a `say` line a first word
 * that names a built-in style is that style, not an id (`say strong | …`);
 * the built-in styles are all about text, so on anything drawn the first
 * word is always the id (`pix ghost`, `circle stamp`).
 */
function splitWords(
  words: readonly string[],
  idAllowed: boolean,
  builtinsAreStyles = false,
  /** words of the verb's own vocabulary: never an id, even first (`flow down`, `toggle on`) */
  notIds: readonly string[] = [],
  limit = COORDINATE_LIMIT,
): { id: string; numbers: number[]; names: string[] } {
  const numbers: number[] = [];
  const names: string[] = [];
  let id = '-';
  words.forEach((word, index) => {
    if (GEOMETRY_PATTERN.test(word)) {
      for (const part of word.split(/[,x]/)) numbers.push(Math.min(limit, Math.max(-limit, Number(part))));
      return;
    }
    if (idAllowed && index === 0 && word !== '-' && isValidElementId(word) && !notIds.includes(word) && !(builtinsAreStyles && BUILTIN_STYLE_NAMES.has(word))) {
      id = word;
      return;
    }
    if (word !== '-') names.push(word);
  });
  return { id, numbers, names };
}

function parseScene(head: Head, issues: Issues): Line {
  const line: { -readonly [K in keyof SceneLine]: SceneLine[K] } = { verb: 'scene' };
  for (const word of head.words) {
    if (oneOf(LAYOUTS, word)) line.layout = word;
    else if (oneOf(MOODS, word)) line.mood = word;
    else if (oneOf(PACES, word)) line.pace = word;
    else if (oneOf(CANVAS_NAMES, word)) line.canvas = word;
    else if (line.id === undefined && isValidElementId(word)) line.id = word;
    else issues.warn('unknown-word', `"${word}" means nothing in a scene header; ignored`, word);
  }
  for (const pair of head.pairs) {
    const { key, value } = pair;
    if (key === 'layout' && oneOf(LAYOUTS, value)) line.layout = value;
    else if (key === 'mood' && oneOf(MOODS, value)) line.mood = value;
    else if (key === 'pace' && oneOf(PACES, value)) line.pace = value;
    else if (key === 'align' && oneOf(ALIGNS, value)) line.align = value;
    else if (key === 'clear' && oneOf(CLEARS, value)) line.clear = value;
    else if (key === 'canvas' && oneOf(CANVAS_NAMES, value)) line.canvas = value;
    else if (key === 'lines' && /^\d+$/.test(value) && Number(value) >= 1) line.lines = Math.min(Number(value), MAX_SCENE_LINES);
    else if (['layout', 'mood', 'pace', 'align', 'clear', 'lines', 'canvas'].includes(key)) {
      issues.warn('bad-value', `${key}=${value} ignored`, pair.token);
    } else issues.warn('unknown-key', `"${key}" is not part of a scene header; ignored`, pair.token);
  }
  return withWhen(line, head.when);
}

function parsePlan(head: Head, issues: Issues): Line | null {
  const line: { verb: 'plan'; lines?: number; mood?: (typeof MOODS)[number]; pace?: (typeof PACES)[number] } = { verb: 'plan' };
  for (const word of head.words) {
    if (oneOf(MOODS, word)) line.mood = word;
    else if (oneOf(PACES, word)) line.pace = word;
    else issues.warn('unknown-word', `"${word}" means nothing here; ignored`, word);
  }
  for (const pair of head.pairs) {
    const { key, value } = pair;
    if (key === 'mood' && oneOf(MOODS, value)) line.mood = value;
    else if (key === 'pace' && oneOf(PACES, value)) line.pace = value;
    else if (key === 'lines' && /^\d+$/.test(value) && Number(value) >= 1) line.lines = Math.min(Number(value), MAX_SCENE_LINES);
    else issues.warn('bad-value', `${pair.token} ignored; plan takes lines=N, mood= and pace=`, pair.token);
  }
  if (line.lines === undefined && line.mood === undefined && line.pace === undefined) {
    issues.error('nothing-to-do', 'plan needs at least one of lines=N, mood=, pace=');
    return null;
  }
  return line;
}

function parseStyle(head: Head, issues: Issues): Line | null {
  const name = head.words[0];
  if (name === undefined) {
    issues.error('missing-argument', 'style needs a name');
    return null;
  }
  if (!isValidName(name) || oneOf(RESERVED_IDS, name)) {
    issues.error('reserved-name', `"${name}" cannot be a style name`, name);
    return null;
  }
  const { props, rest } = readStyleProps(head.pairs, issues);
  let like = head.words[1];
  warnUnknownWords(head.words.slice(2), issues);
  const others: Pair[] = [];
  for (const pair of rest) {
    if (pair.key === 'like') like = pair.value;
    else others.push(pair);
  }
  warnUnknownPairs(others, issues);
  if (like !== undefined && !isValidName(like)) {
    issues.warn('bad-value', `like=${like} ignored`, like);
    like = undefined;
  }
  if (like === undefined && Object.keys(props).length === 0) {
    issues.error('nothing-to-do', 'style needs at least one property');
    return null;
  }
  return like === undefined ? { verb: 'style', name, props } : { verb: 'style', name, like, props };
}

function parseColor(head: Head, issues: Issues): Line | null {
  warnUnknownWords(head.words, issues);
  const colors: Record<string, HexColor> = {};
  for (const pair of head.pairs) {
    const hex = parseHex(pair.value);
    if (!isValidName(pair.key) || oneOf(INK_ROLES, pair.key) || oneOf(RESERVED_IDS, pair.key)) issues.warn('reserved-name', `"${pair.key}" cannot be a colour name; ignored`, pair.token);
    else if (hex === null) issues.warn('bad-value', `${pair.token} ignored; a colour is #rgb or #rrggbb`, pair.token);
    else colors[pair.key] = hex;
  }
  if (Object.keys(colors).length === 0) {
    issues.error('nothing-to-do', 'color needs at least one name=#hex');
    return null;
  }
  return { verb: 'color', colors };
}

function parseLook(head: Head, issues: Issues): Line | null {
  const name = head.words[0];
  if (name === undefined || !isValidName(name) || oneOf(RESERVED_IDS, name)) {
    issues.error('unknown-look', 'look needs a name: a preset, or a name of your own with properties', name);
    return null;
  }
  warnUnknownWords(head.words.slice(1), issues);
  const props: { -readonly [K in keyof LookProps]: LookProps[K] } = {};
  let like: string | undefined;
  for (const pair of head.pairs) {
    const { key, value } = pair;
    if (key === 'like' && isValidName(value)) like = value;
    else if (key === 'ground' || key === 'ink' || key === 'dim' || key === 'accent' || key === 'alt') {
      const hex = parseHex(value);
      if (hex !== null) props[key] = hex;
      else issues.warn('bad-value', `${pair.token} ignored; a look's colours are #rgb or #rrggbb`, pair.token);
    } else if ((key === 'face' || key === 'font') && oneOf(FACES, value)) props.face = value;
    else if (key === 'stroke' && oneOf(STROKES, value)) props.stroke = value;
    else if (key === 'enter' && oneOf(ENTER_EFFECTS, value)) props.enter = value;
    else if (key === 'by' && oneOf(BYS, value)) props.by = value;
    else if (key === 'exit' && oneOf(EXIT_EFFECTS, value)) props.exit = value;
    else if (key === 'fx') {
      const fx: FxName[] = [];
      for (const part of value.split(',')) {
        if (part === '' || part === 'none') continue;
        if (oneOf(FX_NAMES, part)) fx.push(part);
        else issues.warn('bad-value', `fx "${part}" does not exist; ignored`, part);
      }
      props.fx = fx;
    } else if (['like', 'face', 'font', 'stroke', 'enter', 'by', 'exit'].includes(key)) issues.warn('bad-value', `${pair.token} ignored`, pair.token);
    else issues.warn('unknown-key', `"${key}" is not part of a look; ignored`, pair.token);
  }
  return withWhen(like === undefined ? { verb: 'look' as const, look: name, props } : { verb: 'look' as const, look: name, like, props }, head.when);
}

function parseSay(head: Head, text: string | null, issues: Issues): Line | null {
  if (text === null) {
    issues.error('missing-text', 'say needs text after " | "');
    return null;
  }
  const { id, numbers, names } = splitWords(head.words, true, true, ['approx', 'optional']);
  if (numbers.length > 0) issues.warn('unknown-word', 'numbers mean nothing on a say line; use at=x,y');
  const { props, rest } = readStyleProps(head.pairs, issues);
  let href: string | undefined;
  const unknown: Pair[] = [];
  let approx: Approx | undefined;
  for (const pair of rest) {
    if (pair.key === 'href' || pair.key === 'link' || pair.key === 'url') {
      const address = readAddress(pair.raw);
      if (address === null) issues.warn('bad-value', `${pair.key}=… ignored; a link is an http or https address`, pair.token);
      else href = address;
    } else if ((pair.key === 'from' || pair.key === 'approx') && oneOf(APPROX_FROM, pair.value)) approx = pair.value;
    else unknown.push(pair);
  }
  warnUnknownPairs(unknown, issues);
  // L3. `approx` and `optional` are words of the head; `long || short` is the same words said shorter.
  const flags = names.filter((name) => name === 'approx' || name === 'optional');
  if (flags.includes('approx')) approx ??= 'yes';
  const [long = text, ...shorter] = text.split(/\s+\|\|\s+/).map((form) => form.trim()).filter((form) => form !== '');
  const alts = shorter.slice(0, 2);
  const line = {
    verb: 'say' as const,
    id,
    styles: readStyleNames(names.filter((name) => name !== 'approx' && name !== 'optional'), issues),
    props,
    text: long,
    ...(approx !== undefined && { approx }),
    ...(alts.length > 0 && { alts }),
    ...(flags.includes('optional') && { optional: true }),
  };
  return withWhen(href === undefined ? line : { ...line, href }, head.when);
}

/** An address a link may open: `http:` or `https:` and nothing else, so a link can never run script or leave the browser's own tab. */
export function readAddress(raw: string): string | null {
  const address = raw.replace(/^<|>$/g, '').trim();
  return address.length > LIMITS.href || !/^https?:\/\/[^\s"'<>]+\.[^\s"'<>]+$|^https?:\/\/localhost\b[^\s"'<>]*$/i.test(address) ? null : address;
}

/** Geometry may also arrive as SVG attributes, which is how a model first reaches for it. */
function geometryPairs(pairs: readonly Pair[]): { found: Record<string, number>; rest: Pair[] } {
  const found: Record<string, number> = {};
  const rest: Pair[] = [];
  for (const pair of pairs) {
    const value = ['cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'width', 'height', 'w', 'h'].includes(pair.key) ? parseNumber(pair.value, -COORDINATE_LIMIT, COORDINATE_LIMIT) : null;
    if (value === null) rest.push(pair);
    else found[pair.key] = value;
  }
  return { found, rest };
}

function pointsOf(numbers: readonly number[]): Point[] {
  const points: Point[] = [];
  for (let i = 0; i + 1 < numbers.length && points.length < LIMITS.points; i += 2) points.push({ x: numbers[i] ?? 0, y: numbers[i + 1] ?? 0 });
  return points;
}

function parseShape(verb: ShapeVerb, head: Head, text: string | null, issues: Issues): Line | null {
  const { id, numbers, names } = splitWords(head.words, true);
  const { found, rest: afterGeometry } = geometryPairs(head.pairs);
  const read = readStyleProps(afterGeometry, issues);
  const { rest } = read;
  // `radial` on its own is the gradient running out from the middle, as `full` is the whole screen.
  const radialWord = names.includes('radial');
  const radialProps: StyleProps = radialWord && read.props.radial === undefined ? { ...read.props, radial: true } : read.props;
  // `dashed` on its own is `dash=` at its default, as it is on a link; an explicit `dash=` wins.
  const dashedWord = names.includes('dashed');
  const props: StyleProps = dashedWord && radialProps.dash === undefined ? { ...radialProps, dash: DEFAULT_DASH } : radialProps;
  warnUnknownPairs(rest, issues);
  const pick = (index: number, ...keys: string[]): number | undefined => {
    for (const key of keys) {
      const value = found[key];
      if (value !== undefined) return value;
    }
    return numbers[index];
  };
  const need = (form: string): null => {
    issues.error('bad-geometry', `${verb} needs ${form}`);
    return null;
  };

  let geometry: ShapeGeometry;
  let styleWords = names.filter((name) => !(radialWord && name === 'radial') && name !== 'dashed');
  switch (verb) {
    case 'circle': {
      const cx = pick(0, 'cx', 'x');
      const cy = pick(1, 'cy', 'y');
      const r = pick(2, 'r');
      if (cx === undefined || cy === undefined || r === undefined || r <= 0) return need('a centre and a radius: circle 80,45 12');
      geometry = { shape: 'circle', cx, cy, r };
      break;
    }
    case 'ellipse': {
      const cx = pick(0, 'cx', 'x');
      const cy = pick(1, 'cy', 'y');
      const rx = pick(2, 'rx');
      const ry = pick(3, 'ry');
      if (cx === undefined || cy === undefined || rx === undefined || ry === undefined || rx <= 0 || ry <= 0) return need('a centre and two radii: ellipse 80,45 30x12');
      geometry = { shape: 'ellipse', cx, cy, rx, ry };
      break;
    }
    case 'rect': {
      const radius = Math.max(0, found.r ?? 0);
      if (names.includes('full')) {
        styleWords = styleWords.filter((name) => name !== 'full');
        geometry = { shape: 'rect', x: 0, y: 0, w: 0, h: 0, r: 0, full: true };
        break;
      }
      const x = pick(0, 'x');
      const y = pick(1, 'y');
      const w = pick(2, 'width', 'w');
      const h = pick(3, 'height', 'h');
      if (x === undefined || y === undefined || w === undefined || h === undefined || w <= 0 || h <= 0) return need('a corner and a size: rect 10,60 40x25 (or: rect full)');
      geometry = { shape: 'rect', x, y, w, h, r: radius, full: false };
      break;
    }
    case 'line': {
      const points = pointsOf(numbers);
      if (points.length < 2) return need('at least two points: line 10,80 150,80');
      geometry = { shape: 'line', points };
      break;
    }
    case 'poly': {
      const points = pointsOf(numbers);
      if (points.length < 3) return need('at least three points: poly 40,60 60,40 80,60');
      geometry = { shape: 'poly', points };
      break;
    }
    case 'path': {
      const d = text === null ? '' : text.trim();
      const { commands, problems } = parsePathData(d);
      for (const problem of problems) issues.warn('bad-path', problem);
      if (commands.length < 2) {
        issues.error('bad-path', 'path needs SVG path data after " | ", e.g. path | M10 80 C40 10 65 10 95 80');
        return null;
      }
      geometry = { shape: 'path', d, commands };
      break;
    }
  }
  return withWhen({ verb, id, styles: readStyleNames(styleWords, issues), props, geometry }, head.when);
}

function parseSpriteKey(raw: string, issues: Issues): SpriteKey {
  const key: Record<string, ColourRef | 'none'> = {};
  for (const part of raw.split(',')) {
    const char = part.charAt(0);
    const value = part.slice(2).toLowerCase();
    const colour = value === 'none' ? 'none' : parseColour(value);
    if (part.charAt(1) !== ':' || char === '' || colour === null) issues.warn('bad-value', `key entry "${part}" ignored; write one character, a colon and a colour: key=o:accent`, part);
    else key[char] = colour;
  }
  return key;
}

function parsePix(head: Head, issues: Issues): Line {
  const { id, numbers, names } = splitWords(head.words, true);
  if (numbers.length > 0) issues.warn('unknown-word', 'numbers mean nothing on a pix line; the rows give its size, at=x,y its place');
  const { props, rest } = readStyleProps(head.pairs, issues);
  let fps: number | undefined;
  let key: SpriteKey = {};
  for (const pair of rest) {
    if (pair.key === 'fps') {
      const value = parseNumber(pair.value, 0.5, MAX_FPS);
      if (value !== null) fps = value;
      else issues.warn('bad-value', `${pair.token} ignored; expected frames per second`, pair.token);
    } else if (pair.key === 'key') key = parseSpriteKey(pair.raw, issues);
    else issues.warn('unknown-key', `"${pair.key}" is not a property here; ignored`, pair.token);
  }
  const line = { verb: 'pix' as const, id, styles: readStyleNames(names, issues), props, key };
  return withWhen(fps === undefined ? line : { ...line, fps }, head.when);
}

/** The cells of a row: the one space that separates them from the bar is not a cell; any other space is an empty one, and the schedule reads it as such. */
function rowCells(afterBar: string): string {
  return (afterBar.startsWith(' ') ? afterBar.slice(1) : afterBar).replace(/\s+$/, '');
}

function parseRowVerb(head: Head, rawText: string | null, issues: Issues): Line | null {
  // The written-out form: `row cat | ..0..0..`. The short form `| ..0..0..` never reaches here.
  const cells = rawText === null ? '' : rowCells(rawText);
  // `row x1 |` with nothing after the bar is an empty row: a blank line inside a block of code. Without a bar there is nothing to say.
  if (rawText === null) {
    issues.error('missing-text', 'row needs its cells after " | "');
    return null;
  }
  const word = head.words[0];
  return { verb: 'row', id: word !== undefined && isValidElementId(word) ? word : '-', cells };
}

function parseFrame(head: Head, issues: Issues): Line {
  const word = head.words[0];
  warnUnknownWords(head.words.slice(1), issues);
  warnUnknownPairs(head.pairs, issues);
  return { verb: 'frame', id: word !== undefined && isValidElementId(word) ? word : '-' };
}

function parseGroup(head: Head, issues: Issues): Line | null {
  const id = readElementId(head.words[0], issues);
  if (id === null) return null;
  const { numbers, names } = splitWords(head.words.slice(1), false);
  const { props, rest } = readStyleProps(head.pairs, issues);
  warnUnknownPairs(rest, issues);
  const at = props.at === undefined && numbers.length >= 2 ? { x: numbers[0] ?? 0, y: numbers[1] ?? 0 } : props.at;
  return withWhen({ verb: 'group' as const, id, styles: readStyleNames(names, issues), props: at === undefined ? props : { ...props, at } }, head.when);
}

/** The longest figure the brain may ask for, canvas units (a canvas is at most 160 long). */
const DRAW_MAX_SIZE = 200;

/**
 * `draw [id] <subject> [at=x,y] [size=N] [fill=…] [as=<name>] [new] [in=<group>] [| pose, view, mood]`. The first bare word is the id when it
 * ends in a digit and a subject follows it; a word that is already on stage is an id too, but only the server can tell, so it keeps every word.
 * `size=` is a number here (the figure's height), not the text size word.
 */
function parseDraw(head: Head, text: string | null, issues: Issues): Line | null {
  const words: string[] = [];
  let fresh = false;
  for (const word of head.words) {
    if (GEOMETRY_PATTERN.test(word) || word === '-') continue;
    if (word === 'new') fresh = true;
    else words.push(word.toLowerCase().replace(/[^a-z0-9'-]/g, '')) ;
  }
  const spoken = words.filter((word) => word !== '');
  if (spoken.length === 0) {
    issues.error('missing-argument', 'draw needs a subject: draw fox | sitting');
    return null;
  }
  const first = spoken[0] ?? '';
  const named = spoken.length >= 2 && /\d$/.test(first) && isValidElementId(first);
  let size: number | undefined;
  let as: string | undefined;
  const others: Pair[] = [];
  for (const pair of head.pairs) {
    if (pair.key === 'size') {
      const value = parseNumber(pair.value, 1, DRAW_MAX_SIZE);
      if (value !== null) size = value;
      else issues.warn('bad-value', `${pair.token} ignored; expected a height in canvas units`, pair.token);
    } else if (pair.key === 'as') {
      if (isValidElementId(pair.value)) as = pair.value;
      else issues.warn('bad-value', `${pair.token} ignored; expected a name`, pair.token);
    } else others.push(pair);
  }
  const { props, rest } = readStyleProps(others, issues);
  warnUnknownPairs(rest, issues);
  const line = { verb: 'draw' as const, id: named ? first : '-', words: spoken, subject: (named ? spoken.slice(1) : spoken).join(' '), props, detail: (text ?? '').trim() };
  return withWhen({ ...line, ...(size === undefined ? {} : { size }), ...(as === undefined ? {} : { as }), ...(fresh ? { fresh } : {}) }, head.when);
}

function parseUse(head: Head, issues: Issues): Line | null {
  const { numbers, names } = splitWords(head.words, false);
  const ids = names.filter((name) => isValidElementId(name));
  // Drawing memory: `use [id…] from=<turn>` brings parts of an earlier turn's drawing back; every id named is one to bring.
  const from = head.pairs.find((pair) => pair.key === 'from');
  if (from !== undefined) {
    if (!/^t\d+$/.test(from.value)) {
      issues.error('bad-value', `${from.token} is not a turn; say from=t5, a turn in DRAWING MEMORY`, from.token);
      return null;
    }
    if (ids.length === 0) {
      issues.error('missing-id', 'use … from= needs the ids of the parts to bring back: use bridge sun from=t5');
      return null;
    }
    const { props: held, rest: left } = readStyleProps(head.pairs.filter((pair) => pair !== from), issues);
    warnUnknownPairs(left, issues);
    const place = held.at === undefined && numbers.length >= 2 ? { x: numbers[0] ?? 0, y: numbers[1] ?? 0 } : held.at;
    return withWhen({ verb: 'use' as const, id: '-', source: ids[0] as string, sources: ids, from: from.value, styles: [], props: place === undefined ? held : { ...held, at: place } }, head.when);
  }
  const source = ids.length >= 2 ? ids[1] : ids[0];
  if (source === undefined) {
    issues.error('missing-id', 'use needs the id of what to copy: use tree2 tree at=70,72');
    return null;
  }
  const id = ids.length >= 2 ? (ids[0] ?? '-') : '-';
  const { props, rest } = readStyleProps(head.pairs, issues);
  warnUnknownPairs(rest, issues);
  const at = props.at === undefined && numbers.length >= 2 ? { x: numbers[0] ?? 0, y: numbers[1] ?? 0 } : props.at;
  return withWhen({ verb: 'use' as const, id, source, styles: readStyleNames(ids.slice(2), issues), props: at === undefined ? props : { ...props, at } }, head.when);
}

function parsePaint(head: Head, text: string | null, issues: Issues): Line | null {
  const { id, numbers, names } = splitWords(head.words, true);
  const { props, rest } = readStyleProps(head.pairs, issues);
  const line: { -readonly [K in keyof Extract<Line, { verb: 'paint' }>]: Extract<Line, { verb: 'paint' }>[K] } = {
    verb: 'paint',
    id,
    styles: readStyleNames(names, issues),
    props,
    prompt: text ?? '',
  };
  const [x, y, w, h] = numbers;
  if (x !== undefined && y !== undefined && w !== undefined && h !== undefined && w > 0 && h > 0) line.box = { x, y, w, h } satisfies CanvasBox;
  else if (numbers.length > 0) issues.warn('bad-geometry', 'paint takes a corner and a size (10,10 80x60), or nothing for the whole canvas');
  for (const pair of rest) {
    const { key, value } = pair;
    if (key === 'over' && isValidElementId(value)) line.over = value;
    else if ((key === 'as' || key === 'medium') && oneOf(MEDIUMS, value)) line.medium = value;
    else if (key === 'sketch' && (value === 'fade' || value === 'keep')) line.sketch = value;
    else if (key === 'mask' && oneOf(MASKS, value)) line.mask = value;
    else if (['over', 'as', 'medium', 'sketch', 'mask'].includes(key)) issues.warn('bad-value', `${pair.token} ignored`, pair.token);
    else issues.warn('unknown-key', `"${key}" is not a property here; ignored`, pair.token);
  }
  return withWhen(line, head.when);
}

function parseAmbient(head: Head, issues: Issues): Line | null {
  let id = '-';
  let kind: AmbientKind | 'none' | undefined;
  let amount: Amount | undefined;
  const names: string[] = [];
  head.words.forEach((word, index) => {
    if (kind === undefined && (word === 'none' || word === 'off')) kind = 'none';
    else if (kind === undefined && oneOf(AMBIENT_KINDS, word)) kind = word;
    else if (oneOf(AMOUNTS, word)) amount = word;
    else if (index === 0 && isValidElementId(word)) id = word;
    else if (word !== '-') names.push(word);
  });
  const { props, rest } = readStyleProps(head.pairs, issues);
  for (const pair of rest) {
    if (pair.key === 'amount' && oneOf(AMOUNTS, pair.value)) amount = pair.value;
    else issues.warn('unknown-key', `"${pair.key}" is not a property here; ignored`, pair.token);
  }
  if (kind === undefined) {
    issues.error('missing-argument', `ambient needs a kind: ${AMBIENT_KINDS.join(' | ')} | none`);
    return null;
  }
  const line = { verb: 'ambient' as const, id, kind, styles: readStyleNames(names, issues), props };
  return withWhen(amount === undefined ? line : { ...line, amount }, head.when);
}

/** A corner and a size among the bare numbers of a line: the room a structure, a card or a painting is given. */
function boxOf(numbers: readonly number[], issues: Issues, what: string): CanvasBox | undefined {
  const [x, y, w, h] = numbers;
  if (x !== undefined && y !== undefined && w !== undefined && h !== undefined && w > 0 && h > 0) return { x, y, w, h };
  if (numbers.length > 0) issues.warn('bad-geometry', `${what} takes a corner and a size (10,10 80x60), or nothing for the whole canvas`);
  return undefined;
}

function parseStructure(verb: StructureVerb, head: Head, text: string | null, issues: Issues): Line {
  const own: readonly string[] =
    verb === 'flow' || verb === 'tree' ? GROWTHS : verb === 'chart' ? [...CHART_KINDS, ...CHART_WORDS] : verb === 'map' ? ['route'] : verb === 'table' ? ['bars'] : verb === 'code' ? CODE_LANGUAGES : verb === 'tune' ? TUNE_VOICES : verb === 'figure' ? ['cutaway', 'exploded'] : [];
  const { id, numbers, names } = splitWords(head.words, true, false, own);
  const { props, rest } = readStyleProps(head.pairs, issues);
  const line: { -readonly [K in keyof StructureLine]: StructureLine[K] } = { verb, id, styles: [], props };
  const styleWords: string[] = [];
  for (const name of names) {
    if ((verb === 'flow' || verb === 'tree') && oneOf(GROWTHS, name)) line.grow = name;
    else if (verb === 'chart' && oneOf(CHART_KINDS, name)) line.chart = name;
    else if (verb === 'chart' && oneOf(CHART_WORDS, name)) line.words = CHART_WORDS.filter((word) => word === name || (line.words ?? []).includes(word));
    else if (verb === 'chart' && (name === 'candlestick' || name === 'candlesticks')) line.chart = 'candles';
    else if (verb === 'chart' && (name === 'bars' || name === 'bar' || name === 'histogram')) line.chart = 'columns';
    else if (verb === 'map' && name === 'route') line.route = true;
    else if (verb === 'table' && name === 'bars') line.bars = true;
    else if (verb === 'code' && line.lang === undefined && (oneOf(CODE_LANGUAGES, name) || /[+#]/.test(name))) line.lang = name;
    else if (verb === 'tune' && oneOf(TUNE_VOICES, name)) line.voice = name;
    else if (verb === 'figure' && (name === 'cutaway' || name === 'exploded')) line.mode = name;
    else styleWords.push(name);
  }
  for (const pair of rest) {
    const { key, value } = pair;
    if ((key === 'grow' || key === 'dir') && (verb === 'flow' || verb === 'tree') && oneOf(GROWTHS, value)) line.grow = value;
    else if ((key === 'kind' || key === 'type') && verb === 'chart' && oneOf(CHART_KINDS, value)) line.chart = value;
    else if (key === 'data' && verb === 'chart' && isValidElementId(value)) line.data = value;
    else if ((key === 'lang' || key === 'language') && verb === 'code' && /^[a-z][a-z0-9+#_.-]{0,15}$/.test(value)) line.lang = value;
    else if (key === 'file' && verb === 'code' && pair.raw !== '') line.file = pair.raw.slice(0, LIMITS.file);
    else if ((key === 'answer' || key === 'is') && verb === 'problem') line.answer = splitValues(pair.raw).filter((value) => value.length <= LESSON_LIMITS.answer).slice(0, LESSON_LIMITS.accepted);
    else if (key === 'ways' && verb === 'problem') {
      const wanted = value.split(/[,+]+/).filter((word) => word !== '');
      const known = wanted.flatMap((word) => {
        const way = PROBLEM_WAY_WORDS[word];
        if (way === undefined) issues.warn('bad-value', `ways=${word} is not one of ${PROBLEM_WAYS.join(' | ')}; ignored`, pair.token);
        return way === undefined ? [] : [way];
      });
      if (known.length > 0) line.ways = [...new Set(known)];
    } else if (key === 'for' && verb === 'problem') {
      if (/^[a-z]{1,16}$/.test(value)) line.for = value;
      else issues.warn('bad-value', `for=${value} is a word such as child or adult; ignored`, pair.token);
    }
    else if ((key === 'voice' || key === 'instrument' || key === 'sound') && verb === 'tune' && oneOf(TUNE_VOICES, value)) line.voice = value;
    else if ((key === 'voice' || key === 'instrument' || key === 'sound') && verb === 'tune') issues.warn('bad-value', `voice=${value} is not one of ${TUNE_VOICES.join(' | ')}; a piano is used`, pair.token);
    else if ((key === 'tempo' || key === 'bpm') && verb === 'tune' && /^\d+(\.\d+)?$/.test(value) && Number(value) >= TUNE_TEMPO_RANGE.min && Number(value) <= TUNE_TEMPO_RANGE.max) line.tempo = Number(value);
    else if ((key === 'uses' || key === 'use' || key === 'with') && verb === 'app') {
      const asked: AppShelf[] = [];
      for (const word of value.split(/[,+\s]+/).filter((entry) => entry !== '')) {
        const shelf = oneOf(APP_SHELVES, word) ? word : APP_SHELF_ALIASES[word];
        if (shelf === undefined) issues.warn('bad-value', `uses=${word} is not on the shelf (${APP_SHELVES.join(' | ')}); ignored`, pair.token);
        else if (!asked.includes(shelf)) asked.push(shelf);
      }
      if (asked.length > 0) line.uses = asked;
    } else if (key === 'height' && verb === 'app' && /^\d+(\.\d+)?$/.test(value)) line.height = Math.max(APP_HEIGHT.min, Math.min(APP_HEIGHT.max, Number(value)));
    else if (key === 'height' && verb === 'app') issues.warn('bad-value', `height=${value} is not a number of canvas units from ${APP_HEIGHT.min} to ${APP_HEIGHT.max}; ${APP_HEIGHT.default} is used`, pair.token);
    else if ((key === 'tempo' || key === 'bpm') && verb === 'tune') issues.warn('bad-value', `tempo=${value} is not a number of beats a minute from ${TUNE_TEMPO_RANGE.min} to ${TUNE_TEMPO_RANGE.max}; the score's own is used`, pair.token);
    else issues.warn('unknown-key', `"${key}" is not a property here; ignored`, pair.token);
  }
  line.styles = readStyleNames(styleWords, issues);
  const box = boxOf(numbers, issues, verb);
  if (box !== undefined) line.box = box;
  if (text !== null) line.title = text;
  return withWhen(line, head.when);
}

/** `pic [id] from=u1 [x,y WxH]`: a picture the user gave, put on stage. */
function parsePic(head: Head, issues: Issues): Line | null {
  const { id, numbers, names } = splitWords(head.words, true);
  const { props, rest } = readStyleProps(head.pairs, issues);
  let from: string | undefined;
  for (const pair of rest) {
    if ((pair.key === 'from' || pair.key === 'upload' || pair.key === 'src') && isValidElementId(pair.value)) from = pair.value;
    else issues.warn('unknown-key', `"${pair.key}" is not a property here; ignored`, pair.token);
  }
  // `pic u1`: the one word that names the upload, when nothing else does.
  const bare = from === undefined && id !== '-' && /^u\d+$/.test(id);
  if (bare) from = id;
  if (from === undefined) {
    issues.error('missing-argument', 'pic needs the id of the picture the user gave: pic photo from=u1');
    return null;
  }
  const box = boxOf(numbers, issues, 'pic');
  const line = { verb: 'pic' as const, id: bare ? '-' : id, styles: readStyleNames(names, issues), props, from };
  return withWhen(box === undefined ? line : { ...line, box }, head.when);
}

function parseDeck(head: Head, text: string | null, issues: Issues): Line {
  warnUnknownWords(head.words, issues);
  warnUnknownPairs(head.pairs, issues);
  return withWhen({ verb: 'deck' as const, title: text ?? '' }, head.when);
}

/** `standing | <words>` holds an ask; `standing drop 2` and `standing drop all` let go of one or every ask. */
function parseStanding(head: Head, text: string | null, issues: Issues): Line | null {
  warnUnknownPairs(head.pairs, issues);
  if (head.words[0] === 'drop' || head.words[0] === 'forget' || head.words[0] === 'clear') {
    const which = head.words[1];
    if (which === undefined || which === 'all') return { verb: 'standing', drop: 'all' };
    if (/^\d+$/.test(which) && Number(which) >= 1) return { verb: 'standing', drop: Number(which) };
    issues.error('bad-value', 'standing drop takes the number of the ask in the brief, or all', which);
    return null;
  }
  warnUnknownWords(head.words, issues);
  if (text === null) {
    issues.error('missing-text', 'standing needs the user\'s words after " | ": standing | a visual with every reply');
    return null;
  }
  return { verb: 'standing', text };
}

function parseRefine(head: Head, text: string | null, issues: Issues): Line {
  warnUnknownPairs(head.pairs.filter((pair) => pair.key !== 'passes'), issues);
  const given = head.words[0] ?? head.pairs.find((pair) => pair.key === 'passes')?.value;
  const words = text !== null && text.trim() !== '' ? text.trim().slice(0, 400) : undefined;
  if (given === undefined) return words === undefined ? { verb: 'refine' } : { verb: 'refine', text: words };
  const passes = /^\d+$/.test(given) ? Number(given) : null;
  // `refine more light on the water` without a bar: the words are the note
  if (passes === null) return { verb: 'refine', text: words ?? head.words.join(' ').slice(0, 400) };
  warnUnknownWords(head.words.slice(1), issues);
  return { verb: 'refine', passes: Math.min(REFINE_LIMITS.max, Math.max(1, passes)), ...(words === undefined ? {} : { text: words }) };
}

function parseNode(head: Head, text: string | null, issues: Issues): Line | null {
  if (text === null) {
    issues.error('missing-text', 'node needs its words after " | "');
    return null;
  }
  const { id, numbers, names } = splitWords(head.words, true, false, [...NODE_SHAPES, 'approx'], VALUE_LIMIT);
  const { props, rest } = readStyleProps(head.pairs, issues);
  const line: { -readonly [K in keyof NodeLine]: NodeLine[K] } = { verb: 'node', id, styles: [], props, values: numbers.slice(0, 2), text };
  const styleWords: string[] = [];
  let arrowLabel = '';
  for (const name of names) {
    if (oneOf(NODE_SHAPES, name)) line.shape = name;
    else if (name === 'approx') line.approx ??= 'yes';
    else styleWords.push(name);
  }
  for (const pair of rest) {
    // L3. `from=recalled` is where the words came from, not a node called that, unless one is.
    if ((pair.key === 'from' || pair.key === 'approx') && oneOf(APPROX_FROM, pair.value)) line.approx = pair.value;
    else if (pair.key === 'from' || pair.key === 'after' || pair.key === 'parent') {
      // The id is a word of the language; the label is the brain's own and keeps its case.
      const colon = pair.raw.indexOf(':');
      const from = (colon < 0 ? pair.raw : pair.raw.slice(0, colon)).toLowerCase();
      const label = colon < 0 ? '' : pair.raw.slice(colon + 1);
      if (!isValidElementId(from)) issues.warn('bad-value', `${pair.token} ignored; from= names the node this one follows`, pair.token);
      else line.from = label === '' ? { id: from } : { id: from, label };
    } else if (pair.key === 'shape' && oneOf(NODE_SHAPES, pair.value)) line.shape = pair.value;
    // `from=a label=yes`: the word on the arrow, written as a property.
    else if ((pair.key === 'label' || pair.key === 'link') && pair.raw !== '') arrowLabel = pair.raw;
    // `year=1969`, `date=1969`: the number a timeline node gives first.
    else if ((pair.key === 'year' || pair.key === 'when' || pair.key === 'date') && parseNumber(pair.value, -VALUE_LIMIT, VALUE_LIMIT) !== null) line.values = [Number(pair.value), ...line.values].slice(0, 2);
    // A mark on a chart. `x` is kept as written: what it means (a date, a year, a name) is the chart's to say.
    else if (pair.key === 'x' && pair.raw !== '') line.x = pair.raw.slice(0, LIMITS.name);
    else if (pair.key === 'y') {
      const y = parseNumber(pair.value.replace(/[,$%]/g, ''), -VALUE_LIMIT, VALUE_LIMIT);
      if (y !== null) line.y = y;
      else issues.warn('bad-value', `${pair.token} ignored; y= is a number on the chart's scale`, pair.token);
    } else issues.warn('unknown-key', `"${pair.key}" is not a property here; ignored`, pair.token);
  }
  line.styles = readStyleNames(styleWords, issues);
  if (arrowLabel !== '' && line.from !== undefined && line.from.label === undefined) line.from = { id: line.from.id, label: arrowLabel };
  return withWhen(line, head.when);
}

function parseLink(head: Head, text: string | null, issues: Issues): Line | null {
  const { props, rest } = readStyleProps(head.pairs, issues);
  const line: { -readonly [K in keyof LinkLine]: LinkLine[K] } = { verb: 'link', id: '-', nodes: [], props };
  const nodes: string[] = [];
  for (const word of head.words) {
    if (word === 'dashed') line.dashed = true;
    else if (oneOf(LINK_ENDS, word)) line.ends = word;
    else if (word === '>' || word === '->' || word === 'to') continue;
    else if (isValidElementId(word)) nodes.push(word);
    else issues.warn('unknown-word', `"${word}" means nothing in a link; ignored`, word);
  }
  for (const pair of rest) {
    if (pair.key === 'id' && isValidElementId(pair.value)) line.id = pair.value;
    else if (pair.key === 'ends' && oneOf(LINK_ENDS, pair.value)) line.ends = pair.value;
    else issues.warn('unknown-key', `"${pair.key}" is not a property here; ignored`, pair.token);
  }
  if (nodes.length < 2) {
    issues.error('missing-argument', 'link needs the ids of two nodes: link rain river | runs off');
    return null;
  }
  line.nodes = nodes.slice(0, LIMITS.nodes);
  if (text !== null) line.text = text;
  return withWhen(line, head.when);
}

function parseControl(verb: ControlVerb, head: Head, text: string | null, issues: Issues): Line | null {
  const own: readonly string[] = verb === 'toggle' ? ['on', 'off', 'send'] : verb === 'pick' ? [...PICK_FORMS, 'send'] : ['send'];
  // `slider angle 0..90 30` and `slider angle 0 90 30` read the same.
  const words = head.words.flatMap((word) => {
    const span = verb === 'slider' ? SPAN_PATTERN.exec(word) : null;
    return span === null ? [word] : [span[1] ?? '0', span[2] ?? '0'];
  });
  const { id, numbers, names } = splitWords(words, true, false, own, VALUE_LIMIT);
  const { props, rest } = readStyleProps(head.pairs, issues);
  const line: { -readonly [K in keyof ControlLine]: ControlLine[K] } = { verb, id, styles: [], props };
  const styleWords: string[] = [];
  for (const name of names) {
    if (name === 'send') line.send = true;
    else if (verb === 'toggle' && (name === 'on' || name === 'off')) line.initial = name === 'on';
    else if (verb === 'pick' && oneOf(PICK_FORMS, name)) line.form = name;
    else styleWords.push(name);
  }
  let step: number | undefined;
  let value: number | undefined;
  const ends: { min?: number; max?: number } = {};
  for (const pair of rest) {
    const { key } = pair;
    if (key === 'send') {
      const send = parseTap(pair.value);
      if (send !== null) line.send = send;
    } else if (key === 'step' && verb === 'slider') {
      const parsed = parseNumber(pair.value, 0, VALUE_LIMIT);
      if (parsed !== null && parsed > 0) step = parsed;
      else issues.warn('bad-value', `${pair.token} ignored; expected a step larger than zero`, pair.token);
    } else if (key === 'unit' && verb === 'slider') line.unit = pair.raw.slice(0, 8);
    else if (key === 'value' || key === 'at') {
      const parsed = parseNumber(pair.value, -VALUE_LIMIT, VALUE_LIMIT);
      if (parsed !== null && (verb === 'slider' || verb === 'pick')) value = parsed;
      else if (verb === 'toggle' && parseTap(pair.value) !== null) line.initial = parseTap(pair.value) ?? false;
      else issues.warn('bad-value', `${pair.token} ignored`, pair.token);
    } else if (key === 'form' && verb === 'pick' && oneOf(PICK_FORMS, pair.value)) line.form = pair.value;
    else if ((key === 'min' || key === 'max') && verb === 'slider' && parseNumber(pair.value, -VALUE_LIMIT, VALUE_LIMIT) !== null) ends[key] = Number(pair.value);
    else issues.warn('unknown-key', `"${key}" is not a property here; ignored`, pair.token);
  }
  line.styles = readStyleNames(styleWords, issues);

  if (verb === 'slider') {
    let [min, max] = numbers;
    if (min === undefined && ends.min !== undefined) min = ends.min;
    if (max === undefined && ends.max !== undefined) max = ends.max;
    if (min === undefined || max === undefined) {
      issues.warn('missing-argument', 'slider needs its two ends (slider angle 0 90 | Angle); used 0 to 100');
      min = 0;
      max = 100;
    }
    if (min === max) {
      issues.error('bad-value', 'the two ends of a slider must differ');
      return null;
    }
    if (min > max) [min, max] = [max, min];
    line.range = step === undefined ? { min, max } : { min, max, step };
    const initial = value ?? numbers[2];
    if (initial !== undefined) line.initial = Math.min(max, Math.max(min, initial));
  } else if (numbers.length > 0 && verb !== 'pick') issues.warn('unknown-word', `numbers mean nothing on a ${verb} line; ignored`);

  if (verb === 'pick') {
    let options = text === null ? [] : splitCells(text).filter((option) => option !== '');
    // `pick view | Day, Night`, `Day / Night`: one cell that lists its options.
    if (options.length === 1 && /,|\s\/\s/.test(options[0] ?? '')) {
      options = (options[0] ?? '').split(/\s*(?:,|\s\/\s)\s*/).filter((option) => option !== '');
      if (options.length >= 2) issues.warn('missing-text', 'options are separated by " | ": pick view | Day | Night');
    }
    if (options.length < 2) {
      issues.error('missing-text', 'pick needs its options after the bar: pick view | Day | Night');
      return null;
    }
    if (options.length > LIMITS.options) issues.warn('structure-limit', `a pick has at most ${LIMITS.options} options; the rest were ignored`);
    line.options = options.slice(0, LIMITS.options);
    const chosen = value ?? numbers[0];
    if (chosen !== undefined) line.initial = Math.min(line.options.length, Math.max(1, Math.round(chosen)));
  } else if (text !== null) line.text = text;
  else if (verb === 'button') {
    issues.error('missing-text', 'button needs its label after " | "');
    return null;
  }
  return withWhen(line, head.when);
}

function parseCard(head: Head, text: string | null, issues: Issues): Line {
  const { id, numbers, names } = splitWords(head.words, true);
  const { props, rest } = readStyleProps(head.pairs, issues);
  warnUnknownPairs(rest, issues);
  const line: { -readonly [K in keyof CardLine]: CardLine[K] } = { verb: 'card', id, styles: readStyleNames(names, issues), props };
  const box = boxOf(numbers, issues, 'card');
  if (box !== undefined) line.box = box;
  if (text !== null) line.title = text;
  return withWhen(line, head.when);
}

/** `bind angle | …`, `bind angle 20..60 | …`, `bind mode=night | …`: the control, when the change applies, and the change itself as a line of its own. */
function parseBind(head: Head, rawText: string | null, issues: Issues): Line | null {
  let control: string | undefined;
  let on: BindOn = { kind: 'whole' };
  // `bind chord=C major | …`: the words after a `name=value` are the rest of an option written with spaces.
  const lead = head.pairs[0];
  const spoken = lead !== undefined && lead.key !== 'is' && lead.key !== 'when' && isValidElementId(lead.key);
  const rest: string[] = [];
  for (const word of head.words) {
    const span = SPAN_PATTERN.exec(word);
    if (span !== null) on = { kind: 'range', from: Number(span[1]), to: Number(span[2]) };
    else if (spoken) rest.push(word);
    else if (control === undefined && isValidElementId(word)) control = word;
    else issues.warn('unknown-word', `"${word}" means nothing in a bind; ignored`, word);
  }
  for (const pair of head.pairs) {
    if (control === undefined && isValidElementId(pair.key)) {
      control = pair.key;
      on = { kind: 'is', value: [pair.value, ...rest.map((w) => w.toLowerCase())].join(' ') };
    } else if (pair.key === 'is' || pair.key === 'when') on = { kind: 'is', value: pair.value };
    else issues.warn('unknown-key', `"${pair.key}" is not part of a bind; ignored`, pair.token);
  }
  if (control === undefined) {
    issues.error('missing-id', 'bind needs the id of a control: bind angle | move sun along=arc');
    return null;
  }
  const inner = rawText === null ? null : parseLine(rawText);
  if (inner === null || inner.kind !== 'line') {
    issues.error('bad-bind', 'bind needs the change after " | ": a set, move, correct or shape line');
    return null;
  }
  let change = inner.line;
  // L1. `set <id> | words` reads as a `revise`; under a control it changes the words in plain sight, which is what `correct` does.
  if (change.verb === 'revise') {
    const bare = change.styles.length === 0 && Object.keys(change.props).length === 0 && change.text !== undefined;
    change = bare ? { verb: 'correct', id: change.id, text: change.text ?? '' } : { verb: 'set', target: { kind: 'id', id: change.id }, styles: change.styles, props: change.props };
  }
  const drawn = isShapeVerb(change.verb as Verb);
  if (change.verb !== 'set' && change.verb !== 'move' && change.verb !== 'correct' && !drawn) {
    issues.error('bad-bind', `a control cannot drive "${change.verb}"; it drives set, move, correct, or a shape declared again`);
    return null;
  }
  if ('id' in change && change.id === '-') {
    issues.error('bad-bind', 'the shape a control changes must be named: draw it first under an id, then bind its new form');
    return null;
  }
  for (const issue of inner.issues) issues.warn(issue.code, issue.message, issue.token);
  // Narrowed above: only the four kinds of change reach here.
  return { verb: 'bind', control, on, change: change as Extract<Line, { verb: 'bind' }>['change'] };
}

function readSpeedAndOver(pairs: readonly Pair[], issues: Issues): { speed?: CameraSpeed; over?: number; rest: Pair[] } {
  const out: { speed?: CameraSpeed; over?: number; rest: Pair[] } = { rest: [] };
  for (const pair of pairs) {
    if (pair.key === 'over') {
      const seconds = parseSeconds(pair.value);
      if (seconds !== null && seconds > 0) out.over = Math.min(seconds, MAX_CAMERA_SECONDS);
      else issues.warn('bad-value', `over=${pair.value} ignored; expected seconds`, pair.token);
    } else if (pair.key === 'speed' && oneOf(CAMERA_SPEEDS, pair.value)) out.speed = pair.value;
    else out.rest.push(pair);
  }
  return out;
}

const TABLE_PART = /^([a-z][a-z0-9_-]*)\.(row|cell)(\d+)(?:,(\d+))?$/;

function parseSet(head: Head, text: string | null, issues: Issues): Line | null {
  // `set t1.row2 mark=box`, `set t1.cell2,3 mark=box`: a row or a cell of a table
  const tablePart = TABLE_PART.exec(head.words[0] ?? '');
  if (tablePart?.[1] !== undefined && isValidElementId(tablePart[1]) && (tablePart[2] === 'row' ? tablePart[4] === undefined : tablePart[4] !== undefined)) {
    const part = tablePart[2] === 'row' ? { row: Number(tablePart[3]) } : { cell: [Number(tablePart[3]), Number(tablePart[4])] as const };
    const { props, rest } = readStyleProps(head.pairs, issues);
    warnUnknownPairs(rest, issues);
    return withWhen({ verb: 'set' as const, target: { kind: 'id' as const, id: tablePart[1] }, part, styles: [], props: { mark: props.mark ?? ('box' as const) } }, head.when);
  }
  const target = readTarget(head.words[0], issues);
  if (target === null) return null;
  // L1. `set <id> [style…] [prop=value…] | <new text>` is what `revise` was: the engine makes it quiet when the line has not played and visible when it has.
  if (text !== null && text.trim() !== '' && target.kind === 'id') {
    const revised = parseRevise({ ...head, words: [target.id, ...head.words.slice(1)] }, text, issues);
    if (revised !== null) return revised;
  }
  const timing = readSpeedAndOver(head.pairs, issues);
  const { props: given, rest } = readStyleProps(timing.rest, issues);
  warnUnknownPairs(rest, issues);
  let speed = timing.speed;
  let placed: Point | undefined;
  const names: string[] = [];
  for (const word of head.words.slice(1)) {
    if (oneOf(CAMERA_SPEEDS, word)) speed = word;
    else if (GEOMETRY_PATTERN.test(word)) {
      // `set b 62,36` is a place. A size cannot be set: a shape is resized by declaring it again.
      const point = given.at === undefined && placed === undefined && !word.includes('x') ? parsePoint(word) : null;
      if (point !== null) placed = point;
      else issues.warn('bad-geometry', `"${word}" ignored: set moves and restyles; to change a shape's size, declare it again under the same id`, word);
    } else names.push(word);
  }
  const props: StyleProps = placed === undefined ? given : { ...given, at: placed };
  const styles = readStyleNames(names, issues);
  if (styles.length === 0 && Object.keys(props).length === 0) {
    issues.error('nothing-to-do', 'set needs a style or a property');
    return null;
  }
  return withWhen(
    {
      verb: 'set' as const,
      target,
      styles,
      props,
      ...(speed !== undefined && { speed }),
      ...(timing.over !== undefined && { over: timing.over }),
    },
    head.when,
  );
}

function parseMove(head: Head, issues: Issues): Line | null {
  const id = readElementId(head.words[0], issues);
  if (id === null) return null;
  const timing = readSpeedAndOver(head.pairs, issues);
  let speed = timing.speed;
  let to: Anchor | Point | undefined;
  let along: string | undefined;
  const { numbers, names } = splitWords(head.words.slice(1), false);
  if (numbers.length >= 2) to = { x: numbers[0] ?? 0, y: numbers[1] ?? 0 };
  for (const word of names) {
    if (oneOf(CAMERA_SPEEDS, word)) speed = word;
    else if (to === undefined && oneOf(ANCHORS, word)) to = word;
    else issues.warn('unknown-word', `"${word}" means nothing in a move; ignored`, word);
  }
  for (const pair of timing.rest) {
    if (pair.key === 'along' && isValidElementId(pair.value)) along = pair.value;
    else if (pair.key === 'to' || pair.key === 'at') {
      const point = oneOf(ANCHORS, pair.value) ? pair.value : parsePoint(pair.value);
      if (point !== null) to = point;
      else issues.warn('bad-value', `${pair.token} ignored; expected x,y or an anchor`, pair.token);
    } else issues.warn('unknown-key', `"${pair.key}" is not part of a move; ignored`, pair.token);
  }
  if (to === undefined && along === undefined) {
    issues.error('missing-argument', 'move needs somewhere to go: move sun 120,20 slow');
    return null;
  }
  return withWhen(
    {
      verb: 'move' as const,
      id,
      ...(to !== undefined && { to }),
      ...(speed !== undefined && { speed }),
      ...(timing.over !== undefined && { over: timing.over }),
      ...(along !== undefined && { along }),
    },
    head.when,
  );
}

function parseDrop(head: Head, issues: Issues): Line | null {
  const target = readTarget(head.words[0], issues);
  if (target === null) return null;
  // `drop a1 a2 a3` drops all three.
  const also: string[] = [];
  const stray: string[] = [];
  for (const word of head.words.slice(1)) {
    if (target.kind === 'id' && isValidElementId(word)) also.push(word);
    else stray.push(word);
  }
  warnUnknownWords(stray, issues);
  let exit: (typeof EXIT_EFFECTS)[number] | undefined;
  for (const pair of head.pairs) {
    if (pair.key === 'exit' && oneOf(EXIT_EFFECTS, pair.value)) exit = pair.value;
    else issues.warn('bad-value', `${pair.token} ignored; drop takes exit=${EXIT_EFFECTS.join('|')}`, pair.token);
  }
  const dropped = { verb: 'drop' as const, target, ...(also.length > 0 && { also }), ...(exit !== undefined && { exit }) };
  return withWhen(dropped, head.when);
}

function parseHit(head: Head, issues: Issues): Line | null {
  const id = readElementId(head.words[0], issues);
  if (id === null) return null;
  let gesture: (typeof HIT_GESTURES)[number] = 'pulse';
  const word = head.words[1];
  if (word !== undefined) {
    if (oneOf(HIT_GESTURES, word)) gesture = word;
    else issues.warn('unknown-word', `"${word}" is not a gesture (${HIT_GESTURES.join(' | ')}); used pulse`, word);
  }
  warnUnknownWords(head.words.slice(2), issues);
  warnUnknownPairs(head.pairs, issues);
  return withWhen({ verb: 'hit' as const, id, gesture }, head.when);
}

function parseCam(head: Head, issues: Issues): Line | null {
  const first = head.words[0];
  if (first === undefined) {
    issues.error('missing-argument', `cam needs a move: ${CAMERA_MOVES.join(' | ')}`);
    return null;
  }
  let move = own(CAMERA_ALIASES, first) ?? first;
  // `zoom out` pulls back and `zoom in` pushes closer; the bare alias is the closer one.
  if (first === 'zoom' && head.words[1] === 'out') move = 'pull';
  if (!oneOf(CAMERA_MOVES, move)) {
    issues.error('bad-value', `"${first}" is not a camera move (${CAMERA_MOVES.join(' | ')})`, first);
    return null;
  }
  const line: { -readonly [K in keyof CamLine]: CamLine[K] } = { verb: 'cam', move };
  for (const word of head.words.slice(1)) {
    if (first === 'zoom' && (word === 'in' || word === 'out')) continue;
    if (oneOf(CAMERA_SPEEDS, word)) line.speed = word;
    else if (line.direction === undefined && oneOf(DIRECTIONS, word)) line.direction = word;
    else if (line.target === undefined && isValidElementId(word)) line.target = word;
    else issues.warn('unknown-word', `"${word}" means nothing in a camera move; ignored`, word);
  }
  for (const pair of head.pairs) {
    const { key, value } = pair;
    if (key === 'over') {
      const seconds = parseSeconds(value);
      if (seconds !== null && seconds > 0) line.over = Math.min(seconds, MAX_CAMERA_SECONDS);
      else issues.warn('bad-value', `over=${value} ignored; expected seconds`, pair.token);
    } else if (key === 'amount') {
      const amount = Number(value);
      if (value !== '' && Number.isFinite(amount)) line.amount = Math.min(1, Math.max(0, amount));
      else issues.warn('bad-value', `amount=${value} ignored; expected 0..1`, pair.token);
    } else if (key === 'speed' && oneOf(CAMERA_SPEEDS, value)) line.speed = value;
    else issues.warn('unknown-key', `"${key}" is not part of a camera move; ignored`, pair.token);
  }
  if (move === 'focus' && line.target === undefined) {
    issues.error('missing-argument', 'cam focus needs the id of the element to frame');
    return null;
  }
  if (move === 'pan' && line.direction === undefined) {
    issues.warn('missing-argument', 'cam pan needs left, right, up or down; panned right');
    line.direction = 'right';
  }
  return withWhen(line, head.when);
}

function parseWait(head: Head, issues: Issues): Line {
  const word = head.words[0];
  warnUnknownWords(head.words.slice(1), issues);
  warnUnknownPairs(head.pairs, issues);
  if (word === undefined) return { verb: 'wait', beats: 1 };
  const value = parseSeconds(word);
  if (value === null || value <= 0) {
    issues.warn('bad-value', `"${word}" is not a length; waited one beat`, word);
    return { verb: 'wait', beats: 1 };
  }
  if (word.endsWith('s')) return { verb: 'wait', seconds: Math.min(value, LIMITS.wait) };
  return { verb: 'wait', beats: Math.min(value, MAX_BEATS) };
}

function parseCorrect(head: Head, text: string | null, issues: Issues): Line | null {
  const id = readElementId(head.words[0], issues);
  if (id === null) return null;
  if (text === null) {
    issues.error('missing-text', 'correct needs the new text after " | "');
    return null;
  }
  warnUnknownWords(head.words.slice(1), issues);
  warnUnknownPairs(head.pairs, issues);
  return withWhen({ verb: 'correct' as const, id, text }, head.when);
}

function parseRevise(head: Head, text: string | null, issues: Issues): Line | null {
  const id = readElementId(head.words[0], issues);
  if (id === null) return null;
  const { props, rest } = readStyleProps(head.pairs, issues);
  warnUnknownPairs(rest, issues);
  const styles = readStyleNames(head.words.slice(1), issues);
  if (text === null && styles.length === 0 && Object.keys(props).length === 0) {
    issues.error('nothing-to-do', 'revise needs new text, a style or a property');
    return null;
  }
  return text === null ? { verb: 'revise', id, styles, props } : { verb: 'revise', id, styles, props, text };
}

function parseCancel(head: Head, issues: Issues): Line | null {
  const word = head.words[0];
  warnUnknownWords(head.words.slice(1), issues);
  warnUnknownPairs(head.pairs, issues);
  if (word === undefined || word === 'all') return { verb: 'cancel' };
  if (!isValidElementId(word)) {
    issues.error('bad-id', `"${word}" is not an element id`, word);
    return null;
  }
  return { verb: 'cancel', id: word };
}

/** v3. `part <id> [in=<part>] [tag=<word>] [for=<ask>] | <title>`: a place in the document. */
function parsePart(head: Head, text: string | null, issues: Issues): LessonLine | null {
  const id = head.words[0];
  if (id === undefined) {
    issues.error('missing-id', 'part needs an id: part q1 | the question');
    return null;
  }
  if (!isLessonId(id)) {
    issues.error('bad-id', `"${id}" is not a part id (lower case, digits, - and _, up to ${LIMITS.name})`, id);
    return null;
  }
  warnUnknownWords(head.words.slice(1), issues);
  let parent: string | undefined;
  let tag: string | null = null;
  let helps: string | undefined;
  let cropped: string | null = null;
  let photo: string | undefined;
  const rest: Pair[] = [];
  for (const pair of head.pairs) {
    if (pair.key === 'in') {
      if (isLessonId(pair.value)) parent = pair.value;
      else issues.warn('bad-id', `"${pair.value}" is not a part id; in= ignored`, pair.token);
    } else if (pair.key === 'crop') {
      cropped = pair.value;
    } else if (pair.key === 'from') {
      if (isLessonId(pair.value)) photo = pair.value;
      else issues.warn('bad-id', `"${pair.value}" is not a photo id; from= ignored`, pair.token);
    } else if (pair.key === 'tag') {
      tag = tagWord(pair.value);
      if (tag === null) issues.warn('bad-value', `"${pair.value}" is not a tag (one lower-case word); tag ignored`, pair.token);
    } else if (pair.key === 'for') {
      if (isLessonId(pair.value)) helps = pair.value;
      else issues.warn('bad-id', `"${pair.value}" is not an ask or part id; for= ignored`, pair.token);
    } else rest.push(pair);
  }
  warnUnknownPairs(rest, issues);
  if (text === null) {
    issues.error('missing-text', 'part needs its title after " | ": part q1 | 64 - 30 =');
    return null;
  }
  let crop: ReturnType<typeof readCrop> = null;
  if (cropped !== null) {
    crop = readCrop(cropped, photo);
    if (crop === null) issues.warn('bad-value', `crop= is x,y,w,h in whole percents of the photo, inside it (crop=10,20,80,6); "${cropped}" ignored`, `crop=${cropped}`);
  } else if (photo !== undefined) issues.warn('bad-value', 'from= names the photo a crop= is of; without crop= it is ignored', `from=${photo}`);
  return { verb: 'part', id, ...(parent === undefined ? {} : { in: parent }), ...(tag === null ? {} : { tag }), ...(helps === undefined ? {} : { for: helps }), ...(crop === null ? {} : { crop }), title: text };
}

/** v3. `step [id] [in=<part>] [show=<visual> [a..b] [key=value…]] | <words>`: one reveal. */
function parseStep(head: Head, text: string | null, issues: Issues): LessonLine | null {
  let id = '-';
  const spans: string[] = [];
  head.words.forEach((word, index) => {
    if (isSpan(word)) spans.push(word);
    else if (index === 0 && isLessonId(word)) id = word;
    else issues.warn('unknown-word', `"${word}" means nothing here; ignored`, word);
  });
  let parent: string | undefined;
  let visual: string | undefined;
  const args: Pair[] = [];
  for (const pair of head.pairs) {
    if (pair.key === 'in') {
      if (isLessonId(pair.value)) parent = pair.value;
      else issues.warn('bad-id', `"${pair.value}" is not a part id; in= ignored`, pair.token);
    } else if (pair.key === 'show') visual = pair.value;
    else args.push(pair);
  }
  const report = (code: IssueCode, message: string, token?: string): void => issues.warn(code, message, token);
  const show = visual === undefined ? null : readShow(visual, spans, args, report);
  if (visual === undefined) {
    warnUnknownPairs(args, issues);
    for (const word of spans) issues.warn('unknown-word', `"${word}" is a span, and a step with no show= has no picture; ignored`, word);
  }
  if (text === null && show === null) {
    issues.error('missing-text', 'step needs its words after " | ", or a picture to show');
    return null;
  }
  return { verb: 'step', id, ...(parent === undefined ? {} : { in: parent }), ...(show === null ? {} : { show }), text: text ?? '' };
}

/** v3. `ask <id> [in=<part>] is=<a>[,<b>…] [pick=<x>,<y>,<z>] [unit=<unit>] [check=working|order] | <question>`: a try. */
function parseAsk(head: Head, text: string | null, issues: Issues): LessonLine | null {
  let id = '-';
  head.words.forEach((word, index) => {
    if (index === 0 && isLessonId(word)) id = word;
    else issues.warn('unknown-word', `"${word}" means nothing here; ignored`, word);
  });
  let parent: string | undefined;
  let accepted: string[] = [];
  let pick: string[] | undefined;
  let unit: string | undefined;
  let check: 'working' | 'order' | 'any' | 'done' | undefined;
  let send: boolean | undefined;
  let stage: StageSlot | undefined;
  const rest: Pair[] = [];
  for (const pair of head.pairs) {
    if (pair.key === 'in') {
      if (isLessonId(pair.value)) parent = pair.value;
      else issues.warn('bad-id', `"${pair.value}" is not a part id; in= ignored`, pair.token);
    } else if (pair.key === 'stage') {
      // written by the normaliser, so that the page knows the ask stands on the stage: `stage=2:s1` is the second ask, after s1
      const found = /^(\d{1,2})(?::(\S+))?$/.exec(pair.value);
      if (found !== null) stage = { n: Number(found[1]), after: found[2] ?? null };
    } else if (pair.key === 'send') {
      if (pair.value === 'yes' || pair.value === 'true') send = true;
      else if (pair.value === 'no' || pair.value === 'false') send = false;
      else issues.warn('bad-value', `send= is yes or no; "${pair.value}" ignored`, pair.token);
    } else if (pair.key === 'check') {
      if (pair.value === 'working' || pair.value === 'order' || pair.value === 'any' || pair.value === 'done') check = pair.value;
      else issues.warn('bad-value', `check= is working, order, any or done; "${pair.value}" ignored`, pair.token);
    } else if (pair.key === 'is' || pair.key === 'answer') accepted = splitValues(pair.raw).filter((value) => value.length <= LESSON_LIMITS.answer);
    else if (pair.key === 'pick' || pair.key === 'choices') pick = splitValues(pair.raw).filter((value) => value.length <= LESSON_LIMITS.answer).slice(0, LESSON_LIMITS.pick);
    else if (pair.key === 'unit') {
      if (/^[a-z£$€%]{1,16}$/.test(pair.value)) unit = pair.value;
      else issues.warn('bad-value', `"${pair.value}" is not a unit word; ignored`, pair.token);
    } else rest.push(pair);
  }
  warnUnknownPairs(rest, issues);
  if (accepted.length === 0 && check !== 'any' && check !== 'done') {
    issues.error('missing-argument', 'ask needs the answers it accepts: ask a1 in=q1a is=34 | Where did you land?');
    return null;
  }
  if (text === null) {
    issues.error('missing-text', 'ask needs its question after " | "');
    return null;
  }
  return { verb: 'ask', id, ...(parent === undefined ? {} : { in: parent }), is: accepted.slice(0, LESSON_LIMITS.accepted), ...(pick === undefined || pick.length === 0 ? {} : { pick }), ...(unit === undefined ? {} : { unit }), ...(check === undefined ? {} : { check }), ...(send === undefined ? {} : { send }), ...(stage === undefined ? {} : { stage }), text };
}

/** v3. `hint [in=<ask>] | <words>`. */
function parseHint(head: Head, text: string | null, issues: Issues): LessonLine | null {
  let ask: string | undefined;
  let stage = false;
  const words = [...head.words];
  const first = words[0];
  if (first !== undefined && isLessonId(first)) {
    ask = first;
    words.shift();
  }
  warnUnknownWords(words, issues);
  const rest: Pair[] = [];
  for (const pair of head.pairs) {
    if (pair.key === 'in' || pair.key === 'for' || pair.key === 'ask') {
      if (isLessonId(pair.value)) ask = pair.value;
      else issues.warn('bad-id', `"${pair.value}" is not an ask id; ignored`, pair.token);
    } else if (pair.key === 'stage') stage = true;
    else rest.push(pair);
  }
  warnUnknownPairs(rest, issues);
  if (text === null) {
    issues.error('missing-text', 'hint needs its words after " | "');
    return null;
  }
  return { verb: 'hint', ...(ask === undefined ? {} : { in: ask }), ...(stage ? { stage: true as const } : {}), text };
}

function parseLesson(verb: Extract<LessonLine['verb'], string>, head: Head, text: string | null, issues: Issues): LessonLine | null {
  switch (verb) {
    case 'part':
      return parsePart(head, text, issues);
    case 'step':
      return parseStep(head, text, issues);
    case 'ask':
      return parseAsk(head, text, issues);
    case 'hint':
      return parseHint(head, text, issues);
    case 'reply':
      warnUnknownWords(head.words, issues);
      warnUnknownPairs(head.pairs, issues);
      if (text === null) {
        issues.error('missing-text', 'reply needs its words after " | ": reply | Five twelves is sixty.');
        return null;
      }
      return { verb: 'reply', text };
    case 'end':
      warnUnknownWords(head.words, issues);
      warnUnknownPairs(head.pairs, issues);
      return { verb: 'end' };
  }
}

const TRAILING_TIME = /\s(@(?:with|[+-]?\d+(?:\.\d+)?s?))\s*$/i;

/** Verbs whose line carries something after the bar, and how much of it is kept. */
const TEXT_LIMIT: Readonly<Partial<Record<Verb, number>>> = {
  say: LIMITS.text,
  correct: LIMITS.text,
  revise: LIMITS.text,
  set: LIMITS.text,
  path: LIMITS.line,
  paint: LIMITS.prompt,
  refine: LIMITS.line,
  flow: LIMITS.text,
  tree: LIMITS.text,
  cycle: LIMITS.text,
  timeline: LIMITS.text,
  map: LIMITS.text,
  table: LIMITS.text,
  chart: LIMITS.text,
  node: LIMITS.text,
  link: LIMITS.text,
  button: LIMITS.text,
  toggle: LIMITS.text,
  slider: LIMITS.text,
  pick: LIMITS.text,
  input: LIMITS.text,
  card: LIMITS.text,
  bind: LIMITS.line,
  code: LIMITS.text,
  tune: LIMITS.text,
  figure: LIMITS.text,
  problem: LIMITS.text,
  fill: LIMITS.text,
  app: LIMITS.text,
  screen: LIMITS.text,
  deck: LIMITS.text,
  standing: STANDING_LIMITS.chars,
};

function isShapeVerb(verb: Verb): verb is ShapeVerb {
  return (SHAPE_VERBS as readonly string[]).includes(verb);
}

function isStructureVerb(verb: Verb): verb is StructureVerb {
  return (STRUCTURE_VERBS as readonly string[]).includes(verb);
}

function isControlVerb(verb: Verb): verb is ControlVerb {
  return (CONTROL_VERBS as readonly string[]).includes(verb);
}

/** Properties a model writes as `key: value` or `key:value` where Series writes `key=value`. */
const COLON_KEYS: ReadonlySet<string> = new Set(['is', 'tag', 'pick', 'show', 'from', 'x', 'y', 'at', 'in', 'near', 'data', 'grow', 'unit', 'step', 'value', 'send', 'form', 'layout', 'canvas', 'mood', 'pace', 'align', 'clear', 'lines', 'fill', 'stroke', 'ink', 'size', 'thick', 'enter', 'exit', 'over', 'speed', 'dur', 'scale', 'rot', 'opacity', 'layer', 'loop', 'mark', 'id', 'min', 'max', 'year', 'kind', 'type']);

/** Verbs whose words come after the bar; written without one, the words are found by other signs. */
const WORDED: ReadonlySet<string> = new Set(['fill', 'say', 'node', 'button', 'toggle', 'input', 'correct', 'card', 'bind', 'deck', 'standing', 'part', 'step', 'ask', 'hint', 'reply']);

const ARROW = /\s(?:->|-->|=>|→)\s/;
const RANGE = /^(-?\d+(?:\.\d+)?)[-–—](\d+(?:\.\d+)?)$/;

/** A model's Markdown habits, taken off the line before it is read: a quote marker, backticks or quotes round the whole line, a verb in bold. */
function unwrap(raw: string): string {
  let source = raw.replace(/^>\s*/, '');
  const ticks = /^`([^`]+)`$/.exec(source);
  if (ticks?.[1] !== undefined) source = ticks[1].trim();
  const quoted = /^["“]([^"”]+)["”]$/.exec(source);
  if (quoted?.[1] !== undefined && /^[a-z]+\b/i.test(quoted[1]) && quoted[1].includes('|')) source = quoted[1].trim();
  return source.replace(/^(\*\*|__|\*|_)([a-z]+):?\1:?(?=\s|$)/i, '$2');
}

/**
 * Words a head carries that mean what a property means but are written the way
 * a model writes them: `from: a`, `from:a`, `0-90`, `0 to 90`, `1961-72`.
 */
function tidyHead(verb: string, tokens: string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    const lower = token.toLowerCase();
    const named = /^([a-z]+):(.+)$/i.exec(token);
    if (named?.[1] !== undefined && named[2] !== undefined && COLON_KEYS.has(named[1].toLowerCase()) && !named[2].startsWith('//')) {
      out.push(`${named[1]}=${named[2]}`);
      continue;
    }
    const bare = /^([a-z]+):$/i.exec(token);
    const next = tokens[index + 1];
    if (bare?.[1] !== undefined && COLON_KEYS.has(bare[1].toLowerCase()) && next !== undefined) {
      out.push(`${bare[1]}=${next}`);
      index += 1;
      continue;
    }
    if (index > 0 && token.length > 1 && token.endsWith(':') && !token.includes('=') && out.length === index) {
      out.push(token.slice(0, -1));
      continue;
    }
    const range = RANGE.exec(token);
    if (range?.[1] !== undefined && range[2] !== undefined && Number(range[1]) < Number(range[2]) && (verb === 'slider' || verb === 'node' || verb === 'bind')) {
      if (verb === 'bind') out.push(`${range[1]}..${range[2]}`);
      else out.push(range[1], range[2]);
      continue;
    }
    // `slider angle 0 to 90`: the "to" is only a word.
    if (lower === 'to' && verb === 'slider' && /^-?\d/.test(tokens[index - 1] ?? '') && /^-?\d/.test(tokens[index + 1] ?? '')) continue;
    out.push(token);
  }
  return out;
}

/**
 * Parses one raw line of Series.
 *
 * The parser is deliberately forgiving about everything except meaning: an
 * unknown property is dropped with a warning and the line survives, because
 * losing a sentence over a typo is worse than losing a flourish. A line is
 * rejected only when there is nothing left to act on.
 *
 * It keeps no state. Two things a brain may leave implicit are settled
 * afterwards by `LineNormalizer`: which sprite a `| row` belongs to, and the
 * ids of elements the brain did not name.
 */
export function parseLine(raw: string): ParseResult {
  let source = raw.replace(/\r$/, '').trim();
  if (source === '') return { kind: 'blank' };
  if (source.startsWith('#')) return { kind: 'comment', text: source.slice(1).trim() };

  const issues = new Issues();
  if (source.startsWith('```')) {
    issues.warn('not-a-line', 'code fence ignored; write bare lines');
    return { kind: 'reject', issues: issues.list };
  }
  if (source.length > LIMITS.line) {
    issues.error('too-long', `line is longer than ${LIMITS.line} characters`);
    return { kind: 'reject', issues: issues.list };
  }
  if (source.startsWith('|')) {
    const cells = rowCells(source.slice(1));
    if (cells.trim() === '') return { kind: 'blank' };
    return { kind: 'line', line: { verb: 'row', id: '-', cells }, issues: [] };
  }
  source = unwrap(source.replace(/^(?:[-*•]|\d+[.)])\s+(?=[a-zA-Z])/, ''));

  let pipe = barOf(source);
  // a problem's answers may be written with spaces or quotes inside (`answer=250,two hundred fifty`, `answer="3000,3 000"`): a space inside the value is a `_`
  if (pipe >= 0 && /^problem\b/i.test(source)) {
    const head = source.slice(0, pipe);
    const tidy = head.replace(/\b(answer|is)=("[^"]*"|“[^”]*”|.*?)(?=\s+[a-z]+=|\s*$)/i, (_all, key: string, value: string) => `${key}=${value.replace(/["“”]/g, '').split(',').map((part) => part.trim().replace(/\s+/g, '_')).filter((part) => part !== '').join(',')}`);
    if (tidy !== head) {
      source = `${tidy.trimEnd()} ${source.slice(pipe)}`;
      pipe = barOf(source);
    }
  }
  // `a -> b | then`: an arrow between two ids is a link.
  const shorthand = /^([a-z][a-z0-9_-]*)\s*(?:->|-->|=>|→)\s*([a-z][a-z0-9_-]*)(.*)$/i.exec(source);
  if (shorthand?.[1] !== undefined && shorthand[2] !== undefined && !oneOf(VERBS, shorthand[1].toLowerCase()) && isValidElementId(shorthand[1].toLowerCase())) {
    source = `link ${shorthand[1]} ${shorthand[2]}${shorthand[3] ?? ''}`;
    pipe = barOf(source);
  }
  const firstWord = (/^([a-z]+):?(?=\s|$)/i.exec(source)?.[1] ?? '').toLowerCase();
  const firstVerb = own(VERB_ALIASES, firstWord) ?? firstWord;
  // `pick view: Day | Night`: the first option was written after the id's colon.
  const picked = pipe >= 0 && firstVerb === 'pick' ? /^(\S+\s+[a-z][a-z0-9_-]*):\s+([^|=]+?)\s*\|(.*)$/i.exec(source) : null;
  if (picked?.[1] !== undefined && picked[2] !== undefined) {
    source = `${picked[1]} | ${picked[2]} |${picked[3] ?? ''}`;
    pipe = barOf(source);
  }
  let wordsAsWritten: string | null = null;
  if (pipe < 0 && WORDED.has(firstVerb)) {
    // Where the bar should be: after the arrow of a bind, at the quotes round a label, at the colon that follows the head.
    const arrow = firstVerb === 'bind' ? ARROW.exec(source) : null;
    const quoted = /^(.*?\S)\s+["“](.+?)["”]\s*$/.exec(source);
    const colon = /^([^:=]*?\S):\s+(.+)$/.exec(source);
    if (arrow !== null) source = `${source.slice(0, arrow.index)} | ${source.slice(arrow.index + arrow[0].length)}`;
    else if (quoted?.[1] !== undefined && quoted[2] !== undefined && firstVerb !== 'say') source = `${quoted[1]} | ${quoted[2]}`;
    else if (colon?.[1] !== undefined && colon[2] !== undefined && !COLON_KEYS.has((colon[1].split(/\s+/).pop() ?? '').toLowerCase())) source = `${colon[1]} | ${colon[2]}`;
    else if (firstVerb === 'say' || firstVerb === 'button' || firstVerb === 'deck' || firstVerb === 'reply' || (firstVerb === 'standing' && !/^standing\s+(?:drop|forget|clear)\b/i.test(source))) {
      // `say hello there`, `button go`: no bar, so the rest of the line is the words.
      const rest = source.replace(/^\S+\s*/, '').trim();
      if (rest !== '' && !/^\w+=/.test(rest)) {
        source = `${firstVerb} | ${rest}`;
        wordsAsWritten = `${firstVerb} had no " | "; the words after it were taken as its text`;
      }
    }
    pipe = barOf(source);
  }
  const headSource = holdQuoted(pipe < 0 ? source : source.slice(0, pipe));
  const rawText = pipe < 0 ? null : source.slice(pipe + 1);
  // `circle 80, 45 12`: a space after the comma of a coordinate pair is still the pair.
  const verbWord = (headSource.trim().split(/\s+/)[0] ?? '').toLowerCase().replace(/:$/, '');
  const tokens = tidyHead(own(VERB_ALIASES, verbWord) ?? verbWord, headSource.trim().replace(/(\d),\s+(?=-?[\d.])/g, '$1,').split(/\s+/).filter((token) => token !== ''));
  const verbToken = (tokens[0] ?? '').toLowerCase().replace(/:$/, '');
  let verb = own(VERB_ALIASES, verbToken) ?? verbToken;
  const aliasWord = own(ALIAS_WORDS, verbToken);
  if (aliasWord !== undefined && verb !== verbToken) tokens.splice(1, 0, aliasWord);
  // `strong | Five tips`: the name of a style where the verb goes is speech in that style.
  if (!oneOf(VERBS, verb) && pipe >= 0 && BUILTIN_STYLE_NAMES.has(verbToken)) {
    issues.warn('unknown-verb', `"${verbToken}" is a style, not a verb; read as: say ${verbToken} | …`, verbToken);
    tokens.unshift('say');
    verb = 'say';
  }
  // v3: the words of a document and a lesson are a table of their own (`LESSON_VERB`), read here and not by the rows of the stage's verbs.
  if (isLessonVerb(verb)) {
    if (wordsAsWritten !== null) issues.warn('missing-text', wordsAsWritten);
    const lessonHead = readHead(tokens.slice(1), issues);
    const lessonText = verb === 'end' ? null : cleanText(rawText, LIMITS.text, issues);
    const lesson = parseLesson(verb, lessonHead, lessonText, issues);
    if (lesson === null || issues.failed) return { kind: 'reject', issues: issues.list };
    return { kind: 'line', line: lesson, issues: issues.list };
  }
  if (verb === 'draw') {
    if (wordsAsWritten !== null) issues.warn('missing-text', wordsAsWritten);
    const drawn = parseDraw(readHead(tokens.slice(1), issues), cleanText(rawText, LIMITS.text, issues), issues);
    if (drawn === null || issues.failed) return { kind: 'reject', issues: issues.list };
    return { kind: 'line', line: drawn, issues: issues.list };
  }
  if (verb === 'restore') {
    const word = readHead(tokens.slice(1), issues).words[0]?.toLowerCase() ?? '';
    if (!/^(t\d+|undo|back|prev|previous)$/.test(word)) {
      issues.error('missing-argument', 'restore needs a turn: restore t5 (a turn in DRAWING MEMORY)');
      return { kind: 'reject', issues: issues.list };
    }
    return { kind: 'line', line: { verb: 'restore', turn: word }, issues: issues.list };
  }
  if (!oneOf(VERBS, verb)) {
    issues.error('unknown-verb', verbToken === '' ? 'line has no verb' : `"${verbToken}" is not a verb`, verbToken);
    return { kind: 'reject', issues: issues.list };
  }

  if (wordsAsWritten !== null) issues.warn('missing-text', wordsAsWritten);
  const head = readHead(tokens.slice(1), issues);
  const limit = own(TEXT_LIMIT as Record<string, number>, verb);
  let spoken = rawText;
  // A time written at the end of a spoken line (`say | Then it rained. @with`) is the line's time, not part of the words.
  if (spoken !== null && (verb === 'say' || verb === 'correct')) {
    const trailing = TRAILING_TIME.exec(spoken);
    const when = trailing?.[1] === undefined ? null : parseWhen(trailing[1].toLowerCase());
    if (trailing !== null && when !== null) {
      spoken = spoken.slice(0, trailing.index);
      head.when ??= when;
    }
  }
  const text = limit === undefined ? null : cleanText(spoken, limit, issues);
  if (rawText !== null && rawText.trim() !== '' && limit === undefined && verb !== 'row') issues.warn('unexpected-text', `${verb} takes no text; the text was ignored`);

  let line: Line | null;
  if (isShapeVerb(verb)) {
    line = parseShape(verb, head, text, issues);
  } else if (isStructureVerb(verb)) {
    line = parseStructure(verb, head, text, issues);
  } else if (isControlVerb(verb)) {
    line = parseControl(verb, head, text, issues);
  } else {
    switch (verb) {
      case 'node':
        line = parseNode(head, text, issues);
        break;
      case 'link':
        line = parseLink(head, text, issues);
        break;
      case 'card':
        line = parseCard(head, text, issues);
        break;
      case 'bind':
        line = parseBind(head, rawText, issues);
        break;
      case 'scene':
        line = parseScene(head, issues);
        break;
      case 'plan':
        line = parsePlan(head, issues);
        break;
      case 'style':
        line = parseStyle(head, issues);
        break;
      case 'color':
        line = parseColor(head, issues);
        break;
      case 'look':
        line = parseLook(head, issues);
        break;
      case 'say':
        line = parseSay(head, text, issues);
        break;
      case 'pix':
        line = parsePix(head, issues);
        break;
      case 'row':
        line = parseRowVerb(head, rawText, issues);
        break;
      case 'frame':
        line = parseFrame(head, issues);
        break;
      case 'group':
        line = parseGroup(head, issues);
        break;
      case 'use':
        line = parseUse(head, issues);
        break;
      case 'paint':
        line = parsePaint(head, text, issues);
        break;
      case 'pic':
        line = parsePic(head, issues);
        break;
      case 'deck':
        line = parseDeck(head, text, issues);
        break;
      case 'standing':
        line = parseStanding(head, text, issues);
        break;
      case 'refine':
        line = parseRefine(head, text, issues);
        break;
      case 'ambient':
        line = parseAmbient(head, issues);
        break;
      case 'set':
        line = parseSet(head, text, issues);
        break;
      case 'move':
        line = parseMove(head, issues);
        break;
      case 'drop':
        line = parseDrop(head, issues);
        break;
      case 'hit':
        line = parseHit(head, issues);
        break;
      case 'cam':
        line = parseCam(head, issues);
        break;
      case 'wait':
        line = parseWait(head, issues);
        break;
      case 'correct':
        line = parseCorrect(head, text, issues);
        break;
      case 'revise':
        line = parseRevise(head, text, issues);
        break;
      case 'cancel':
        line = parseCancel(head, issues);
        break;
      case 'fill': {
        const target = head.words[0];
        warnUnknownPairs(head.pairs, issues);
        line = null;
        if (target === undefined || !isValidElementId(target)) issues.error('missing-argument', 'fill needs the id of the problem or ask: fill p1 | 12');
        else if (text === null || text.trim() === '') issues.error('missing-text', 'fill needs the answer after " | ": fill p1 | 12');
        else line = { verb: 'fill', id: target, text: text.trim().slice(0, 60) };
        break;
      }
    }
  }

  if (line === null || issues.failed) return { kind: 'reject', issues: issues.list };
  return { kind: 'line', line, issues: issues.list };
}
