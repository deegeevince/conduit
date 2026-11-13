import { parsePathData } from './geometry';
import { BUILTIN_STYLE_NAMES, own } from './style';
import type {
  CanvasBox,
  CamLine,
  ColourRef,
  FillRef,
  HexColor,
  Issue,
  IssueCode,
  Line,
  LookProps,
  Near,
  ParseResult,
  Point,
  SceneLine,
  Seconds,
  ShapeGeometry,
  SpriteKey,
  StyleProps,
  Target,
  When,
} from './types';
import {
  ALIGNS,
  AMBIENT_KINDS,
  AMOUNTS,
  ANCHORS,
  BLEEDS,
  BYS,
  CAMERA_MOVES,
  CAMERA_SPEEDS,
  CANVAS_NAMES,
  CLEARS,
  DIRECTIONS,
  ENTER_EFFECTS,
  EXIT_EFFECTS,
  FACES,
  FX_NAMES,
  HIT_GESTURES,
  INK_ROLES,
  LAYERS,
  LAYOUTS,
  LETTERCASES,
  LIMITS,
  LOOPS,
  MARKS,
  MASKS,
  MEDIUMS,
  MOODS,
  PACES,
  RESERVED_IDS,
  SHAPE_VERBS,
  SIDES,
  SIZES,
  STAY_WORDS,
  STROKES,
  VERBS,
  WEIGHTS,
} from './vocabulary';
import type { AmbientKind, Amount, Anchor, CameraMove, CameraSpeed, FxName, ShapeVerb, Verb } from './vocabulary';

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
const MAX_SCALE = 100;
const MAX_FPS = 24;
const COORDINATE_LIMIT = 1000;

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

function readHead(tokens: readonly string[], issues: Issues): Head {
  const head: Head = { words: [], pairs: [], when: undefined };
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

function parseFill(value: string): FillRef | null {
  if (value === 'none') return 'none';
  const parts = value.split('>');
  if (parts.length === 2 && parts[0] !== undefined && parts[1] !== undefined) {
    const from = parseColour(parts[0]);
    const to = parseColour(parts[1]);
    return from === null || to === null ? null : { from, to };
  }
  return parseColour(value);
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
        if (colour !== null) props.stroke = colour;
        else bad(pair, 'none | a colour');
        break;
      }
      case 'bleed':
        if (oneOf(BLEEDS, value)) props.bleed = value;
        else bad(pair, BLEEDS.join(' | '));
        break;
      case 'thick':
      case 'stroke-width': {
        const thick = parseNumber(value, 0, MAX_THICK);
        if (thick !== null) props.thick = thick;
        else bad(pair, 'a number of canvas units');
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
function splitWords(words: readonly string[], idAllowed: boolean, builtinsAreStyles = false): { id: string; numbers: number[]; names: string[] } {
  const numbers: number[] = [];
  const names: string[] = [];
  let id = '-';
  words.forEach((word, index) => {
    if (GEOMETRY_PATTERN.test(word)) {
      for (const part of word.split(/[,x]/)) numbers.push(Math.min(COORDINATE_LIMIT, Math.max(-COORDINATE_LIMIT, Number(part))));
      return;
    }
    if (idAllowed && index === 0 && word !== '-' && isValidElementId(word) && !(builtinsAreStyles && BUILTIN_STYLE_NAMES.has(word))) {
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
  const { id, numbers, names } = splitWords(head.words, true, true);
  if (numbers.length > 0) issues.warn('unknown-word', 'numbers mean nothing on a say line; use at=x,y');
  const { props, rest } = readStyleProps(head.pairs, issues);
  warnUnknownPairs(rest, issues);
  return withWhen({ verb: 'say' as const, id, styles: readStyleNames(names, issues), props, text }, head.when);
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
  const { props, rest } = readStyleProps(afterGeometry, issues);
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
  let styleWords = names;
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
        styleWords = names.filter((name) => name !== 'full');
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
  if (cells.trim() === '') {
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

function parseUse(head: Head, issues: Issues): Line | null {
  const { numbers, names } = splitWords(head.words, false);
  const ids = names.filter((name) => isValidElementId(name));
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
  if (text === null) {
    issues.error('missing-text', 'paint needs what to paint after " | "');
    return null;
  }
  const { id, numbers, names } = splitWords(head.words, true);
  const { props, rest } = readStyleProps(head.pairs, issues);
  const line: { -readonly [K in keyof Extract<Line, { verb: 'paint' }>]: Extract<Line, { verb: 'paint' }>[K] } = {
    verb: 'paint',
    id,
    styles: readStyleNames(names, issues),
    props,
    prompt: text,
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

function parseSet(head: Head, issues: Issues): Line | null {
  const target = readTarget(head.words[0], issues);
  if (target === null) return null;
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

const TRAILING_TIME = /\s(@(?:with|[+-]?\d+(?:\.\d+)?s?))\s*$/i;

/** Verbs whose line carries something after the bar, and how much of it is kept. */
const TEXT_LIMIT: Readonly<Partial<Record<Verb, number>>> = {
  say: LIMITS.text,
  correct: LIMITS.text,
  revise: LIMITS.text,
  path: LIMITS.line,
  paint: LIMITS.prompt,
};

function isShapeVerb(verb: Verb): verb is ShapeVerb {
  return (SHAPE_VERBS as readonly string[]).includes(verb);
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
  source = source.replace(/^(?:[-*•]|\d+[.)])\s+(?=[a-zA-Z])/, '');

  const pipe = source.indexOf('|');
  const headSource = pipe < 0 ? source : source.slice(0, pipe);
  const rawText = pipe < 0 ? null : source.slice(pipe + 1);
  // `circle 80, 45 12`: a space after the comma of a coordinate pair is still the pair.
  const tokens = headSource.trim().replace(/(\d),\s+(?=-?[\d.])/g, '$1,').split(/\s+/).filter((token) => token !== '');
  const verbToken = (tokens[0] ?? '').toLowerCase().replace(/:$/, '');
  let verb = own(VERB_ALIASES, verbToken) ?? verbToken;
  // `strong | Five tips`: the name of a style where the verb goes is speech in that style.
  if (!oneOf(VERBS, verb) && pipe >= 0 && BUILTIN_STYLE_NAMES.has(verbToken)) {
    issues.warn('unknown-verb', `"${verbToken}" is a style, not a verb; read as: say ${verbToken} | …`, verbToken);
    tokens.unshift('say');
    verb = 'say';
  }
  if (!oneOf(VERBS, verb)) {
    issues.error('unknown-verb', verbToken === '' ? 'line has no verb' : `"${verbToken}" is not a verb`, verbToken);
    return { kind: 'reject', issues: issues.list };
  }

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
  } else {
    switch (verb) {
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
      case 'ambient':
        line = parseAmbient(head, issues);
        break;
      case 'set':
        line = parseSet(head, issues);
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
    }
  }

  if (line === null || issues.failed) return { kind: 'reject', issues: issues.list };
  return { kind: 'line', line, issues: issues.list };
}
