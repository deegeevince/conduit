// An art sheet: one finished drawing of a named thing, as Series part lines (PLAN-art.md, section 6, "The sheet and the shelf").
//
// A sheet is JSON in a 100 x 100 box centred on 0,0, with a ground line, its parts back to front, colour tokens (the five roles of a look and up
// to three named slots from the house palette), and the facts about it: subject, pose, view, facing, how it was made, its licence, its score.
// It holds Series, never SVG. It is checked when it is read, with the caps of the converter, and every line goes through `parseLine`.
//
// A part line is an ordinary shape line without its `in=` and without a place of its own: `path tail fill=$fur+1 stroke=ink thick=1.8 | M…`.
// In a colour place it holds `none`, a role (`ink dim accent alt ground`), `deep` (the dark of a drawing, see `dressed`), or a slot token: `$fur`, one step lighter `$fur+1`, darker `$fur-2`.

import { LIMITS, SHAPE_VERBS, isValidElementId, parseLine, parsePathData } from '@conduit/language';
import type { InkRole, Line, LookId, Point, ShapeGeometry, ShapeLine } from '@conduit/language';
import { HOUSE_PALETTE, MAX_TONE, isHueName, isRole, slotColour, toned } from './palette';
import type { HueName, LookClass } from './palette';
import { SVG_CAPS } from './svg';

export const SHEET_CAPS = { json: SVG_CAPS.bytes * 2, parts: SVG_CAPS.emitted, minParts: 3, slots: 3, partName: 14, line: LIMITS.line } as const;

export type Facing = 'left' | 'right' | 'front';

export interface SheetPart {
  /** the part's own name: it becomes `<id>-<name>` on stage */
  readonly id: string;
  /** a Series shape line, as described above */
  readonly line: string;
}

export interface SheetSlot {
  readonly name: string;
  readonly hue: HueName;
}

export interface Sheet {
  readonly v: 1;
  /** the normalised subject: `fox`, `oak-tree` */
  readonly subject: string;
  readonly pose: string;
  readonly view: string;
  /** the way it looks in the sheet; asking for the other way mirrors it */
  readonly facing: Facing;
  /** the y of the ground line in the 100 box, measured from its top (the box runs -50..50 in the part lines) */
  readonly ground: number;
  /** the first slot is the main one: `fill=` on a `draw` line recolours it */
  readonly slots: readonly SheetSlot[];
  /** back to front */
  readonly parts: readonly SheetPart[];
  readonly made: { readonly by: string; readonly arm: string; readonly how: string };
  readonly licence: string;
  readonly score?: number;
}

const STRING = (value: unknown, max: number): string | null => (typeof value === 'string' && value.length <= max && !/[\u0000-\u001f]/.test(value) ? value : null);

const TOKEN = /\$([a-z]{1,10})([+-][1-3])?/g;
const COLOUR_VALUE = /^(none|ink|dim|accent|alt|ground|deep|\$[a-z]{1,10}(?:[+-][1-3])?)$/;
const PART_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** the style words a part may carry: nothing places it or times it, and nothing makes it a different kind of element */
const PART_PROPS = new Set(['fill', 'stroke', 'thick', 'opacity', 'brush', 'tex', 'soft', 'loop']);

export type Read = { readonly ok: true; readonly sheet: Sheet } | { readonly ok: false; readonly reason: string };

/** Checks a sheet that came from anywhere: the repo, the cache, a maker. Nothing about it is trusted until this has said yes. */
export function readSheet(raw: unknown): Read {
  const no = (reason: string): Read => ({ ok: false, reason });
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return no('a sheet is an object');
  const o = raw as Record<string, unknown>;
  if (o['v'] !== 1) return no('v must be 1');
  const subject = STRING(o['subject'], 40);
  const pose = STRING(o['pose'], 30);
  const view = STRING(o['view'], 30);
  if (subject === null || !/^[a-z][a-z0-9-]*$/.test(subject)) return no('subject must be lower case words joined by -');
  if (pose === null || !/^[a-z0-9-]*$/.test(pose)) return no('pose must be one lower case word');
  if (view === null || !/^[a-z0-9-]*$/.test(view)) return no('view must be one lower case word');
  const facing = o['facing'];
  if (facing !== 'left' && facing !== 'right' && facing !== 'front') return no('facing must be left, right or front');
  const ground = o['ground'];
  if (typeof ground !== 'number' || !Number.isFinite(ground) || ground < 0 || ground > 100) return no('ground must be a number from 0 to 100');
  if (!Array.isArray(o['slots']) || o['slots'].length > SHEET_CAPS.slots) return no(`at most ${SHEET_CAPS.slots} colour slots`);
  const slots: SheetSlot[] = [];
  for (const slot of o['slots'] as unknown[]) {
    const s = slot as Record<string, unknown> | null;
    const name = STRING(s?.['name'], 10);
    const hue = STRING(s?.['hue'], 12);
    if (name === null || !/^[a-z]{1,10}$/.test(name) || hue === null || !isHueName(hue)) return no(`a slot needs a name and a hue of the house palette (${Object.keys(HOUSE_PALETTE).join(', ')})`);
    if (isRole(name) || name === 'none' || name === 'deep' || slots.some((other) => other.name === name)) return no(`the slot name ${name} is taken`);
    slots.push({ name, hue });
  }
  if (!Array.isArray(o['parts']) || o['parts'].length < SHEET_CAPS.minParts || o['parts'].length > SHEET_CAPS.parts) return no(`${SHEET_CAPS.minParts} to ${SHEET_CAPS.parts} parts`);
  const parts: SheetPart[] = [];
  let commands = 0;
  for (const part of o['parts'] as unknown[]) {
    const p = part as Record<string, unknown> | null;
    const id = STRING(p?.['id'], SHEET_CAPS.partName);
    const text = STRING(p?.['line'], SHEET_CAPS.line);
    if (id === null || !PART_NAME.test(id)) return no('a part needs a short lower case name');
    if (text === null) return no(`the part ${id} has no line, or one over ${SHEET_CAPS.line} characters`);
    if (parts.some((other) => other.id === id)) return no(`the part ${id} is twice`);
    const bad = checkPart(id, text, slots);
    if (bad !== null) return no(`the part ${id}: ${bad}`);
    commands += (text.match(/[MLCQZ]/g) ?? []).length;
    parts.push({ id, line: text });
  }
  if (commands > SVG_CAPS.commands * 2) return no(`more than ${SVG_CAPS.commands * 2} path commands in all`);
  const made = o['made'] as Record<string, unknown> | null;
  const by = STRING(made?.['by'], 40);
  const arm = STRING(made?.['arm'], 40);
  const how = STRING(made?.['how'], 200);
  if (by === null || arm === null || how === null) return no('made needs by, arm and how');
  const licence = STRING(o['licence'], 80);
  if (licence === null || licence === '') return no('a sheet states its licence');
  const score = o['score'];
  if (score !== undefined && (typeof score !== 'number' || !Number.isFinite(score))) return no('score must be a number');
  const aliases: unknown = o['aliases'];
  if (aliases !== undefined && !Array.isArray(aliases)) return no('aliases must be a list');
  const sheet: Sheet = { v: 1, subject, pose, view, facing, ground, slots, parts, made: { by, arm, how }, licence, ...(typeof score === 'number' ? { score } : {}) };
  return { ok: true, sheet };
}

/** A part's line, with its colour tokens given a stand-in colour, read the way the language reads any line. Null when it is sound. */
function checkPart(id: string, text: string, slots: readonly SheetSlot[]): string | null {
  for (const m of text.matchAll(/\b(fill|stroke)=(\S+)/g)) {
    if (!COLOUR_VALUE.test(m[2] ?? '')) return `${m[1]}=${m[2]} is not none, a role, deep or a slot token`;
  }
  for (const m of text.matchAll(TOKEN)) {
    if (!slots.some((slot) => slot.name === m[1])) return `the token ${m[0]} names no slot`;
    if (Math.abs(Number(m[2] ?? 0)) > MAX_TONE) return `the token ${m[0]} is more than ${MAX_TONE} steps of tone`;
  }
  const parsed = parseLine(text.replace(TOKEN, '#808080'));
  if (parsed.kind !== 'line') return `the language rejects it: ${parsed.kind === 'reject' ? parsed.issues.map((i) => i.message).join('; ') : parsed.kind}`;
  if (parsed.issues.length > 0) return `the language repairs it: ${parsed.issues.map((i) => i.message).join('; ')}`;
  const line = parsed.line;
  if (!(SHAPE_VERBS as readonly string[]).includes(line.verb)) return 'a part is a shape: circle, ellipse, rect, line, poly or path';
  const shape = line as ShapeLine;
  if (shape.id !== id) return `its line names it ${shape.id}`;
  if (shape.when !== undefined || shape.styles.length > 0) return 'a part has no time and no style names';
  for (const key of Object.keys(shape.props)) if (!PART_PROPS.has(key)) return `${key}= is not for a part (it is placed and timed by the figure)`;
  if (shape.geometry.shape === 'path') {
    const read = parsePathData(shape.geometry.d);
    if (read.problems.length > 0) return `the path data: ${read.problems[0]}`;
  }
  if (shape.geometry.shape === 'rect' && shape.geometry.full) return 'a part cannot be the whole screen';
  return null;
}

// ---- putting a sheet on stage ----

export interface RoleColours {
  readonly ink: string;
  readonly dim: string;
  readonly accent: string;
  readonly alt: string;
  readonly ground: string;
}

/**
 * The brush a part's outline is drawn with, for every sheet alike (one hand): `null` leaves the look's own stroke. Chosen by looking at the
 * shelf's parts in the paper and night looks (`pnpm art shots`); see the step's report.
 */
export const OUTLINE_BRUSH: string | null = 'ink';

export interface Dress {
  readonly look: LookClass;
  readonly roles: RoleColours;
  /** the colour `fill=` gave the main slot: a house hue, a role or a #hex; null: the sheet's own */
  readonly main: string | null;
  /** the brush for outlines when it is being tried out; absent: `OUTLINE_BRUSH`. `'look'` is the look's own stroke whatever the default is. */
  readonly outline?: string;
}

export interface Placing {
  /** the group's id; the parts are `<id>-<part>` */
  readonly id: string;
  /** where the middle of the box goes, canvas units */
  readonly at: Point;
  /** the side of the 100 box, canvas units */
  readonly size: number;
  /** x is flipped: the sheet faces the other way from the way it was asked for */
  readonly mirror: boolean;
  /** seconds the figure takes to draw in */
  readonly over: number;
}

const r2 = (n: number): number => Math.round(n * 100) / 100 + 0;

function mainColour(sheet: Sheet, slot: SheetSlot, step: number, dress: Dress): string | null {
  if (dress.look === 'line') return null;
  if (slot === sheet.slots[0] && dress.main !== null) {
    const word = dress.main;
    if (isHueName(word)) return slotColour(word, step, dress.look);
    if (isRole(word)) return toned(dress.roles[word], step);
    if (/^#[0-9a-f]{6}$/.test(word)) return toned(word, step);
  }
  return slotColour(slot.hue, step, dress.look);
}

/** The line of a part with its colours given: roles stay as words (the look resolves them), slots become a hex; in a line-only look every fill is the ground. */
function dressed(sheet: Sheet, text: string, dress: Dress): string {
  const coloured = text.replace(/\b(fill|stroke)=(\S+)/g, (_all, key: string, value: string) => {
    const token = /^\$([a-z]{1,10})([+-][1-3])?$/.exec(value);
    // `deep` is the dark of a drawing (hair, pupils, shoes): the look's ink on a light ground, its ground on a dark one, so it never turns pale at night
    if (value === 'deep') return `${key}=${dress.look === 'dark' && key === 'fill' ? 'ground' : dress.look === 'line' && key === 'fill' ? 'ground' : 'ink'}`;
    if (token === null) return key === 'fill' && dress.look === 'line' && value !== 'none' ? 'fill=ground' : `${key}=${value}`;
    const slot = sheet.slots.find((s) => s.name === token[1]);
    const hex = slot === undefined ? null : mainColour(sheet, slot, Number(token[2] ?? 0), dress);
    if (hex === null) return `${key}=${key === 'fill' ? 'ground' : 'ink'}`;
    return `${key}=${hex}`;
  });
  return coloured;
}

function movePoint(p: Point, k: number, mirror: boolean): Point {
  return { x: r2((mirror ? -p.x : p.x) * k), y: r2(p.y * k) };
}

function pathText(commands: readonly { readonly op: string; readonly [key: string]: unknown }[], k: number, mirror: boolean): string {
  const num = (v: unknown, flip: boolean): string => String(r2((flip && mirror ? -(v as number) : (v as number)) * k));
  return commands
    .map((c) => {
      if (c.op === 'Z') return 'Z';
      if (c.op === 'C') return `C${num(c['x1'], true)} ${num(c['y1'], false)} ${num(c['x2'], true)} ${num(c['y2'], false)} ${num(c['x'], true)} ${num(c['y'], false)}`;
      return `${c.op}${num(c['x'], true)} ${num(c['y'], false)}`;
    })
    .join(' ');
}

/** A part's geometry moved into the figure's own size, and mirrored when asked; a path is written out again and read back by the language. */
function remake(geometry: ShapeGeometry, k: number, mirror: boolean): ShapeGeometry {
  switch (geometry.shape) {
    case 'circle':
      return { shape: 'circle', cx: r2((mirror ? -geometry.cx : geometry.cx) * k), cy: r2(geometry.cy * k), r: r2(geometry.r * k) };
    case 'ellipse':
      return { shape: 'ellipse', cx: r2((mirror ? -geometry.cx : geometry.cx) * k), cy: r2(geometry.cy * k), rx: r2(geometry.rx * k), ry: r2(geometry.ry * k) };
    case 'rect': {
      const x = mirror ? -(geometry.x + geometry.w) : geometry.x;
      return { shape: 'rect', x: r2(x * k), y: r2(geometry.y * k), w: r2(geometry.w * k), h: r2(geometry.h * k), r: r2(geometry.r * k), full: false };
    }
    case 'line':
    case 'poly':
      return { shape: geometry.shape, points: geometry.points.map((p) => movePoint(p, k, mirror)) };
    case 'path': {
      const d = pathText(geometry.commands as never, k, mirror);
      return { shape: 'path', d, commands: parsePathData(d).commands };
    }
  }
}

/** The part ids a figure's parts will have: `<id>-<name>`, kept inside the 24 characters of an id and unique. */
export function partIds(id: string, names: readonly string[]): string[] {
  const used = new Set<string>([id]);
  return names.map((name, index) => {
    let candidate = `${id}-${name}`.slice(0, LIMITS.name).replace(/-+$/, '');
    if (!isValidElementId(candidate) || used.has(candidate)) candidate = `${id}-p${index + 1}`.slice(0, LIMITS.name);
    for (let n = 2; used.has(candidate); n += 1) candidate = `${id.slice(0, LIMITS.name - 4)}-${n}x${index}`.slice(0, LIMITS.name);
    used.add(candidate);
    return candidate;
  });
}

/**
 * A sheet as lines for the stage: the group, then every part `in=` it, back to front, all starting together and drawing in over `over` seconds.
 * The parts are ordinary shapes: `move`, `set`, `loop=` and a label `near=<id>-<part>` work on them as on any.
 */
export function expandSheet(sheet: Sheet, placing: Placing, dress: Dress, passed: Readonly<Record<string, unknown>> = {}): Line[] {
  const k = placing.size / 100;
  const lines: Line[] = [{ verb: 'group', id: placing.id, styles: [], props: { ...passed, at: placing.at } }];
  const ids = partIds(placing.id, sheet.parts.map((part) => part.id));
  sheet.parts.forEach((part, index) => {
    const parsed = parseLine(dressed(sheet, part.line, dress));
    if (parsed.kind !== 'line') return;
    const shape = parsed.line as ShapeLine;
    const thick = shape.props.thick === undefined ? undefined : Math.max(0.1, r2(shape.props.thick * k));
    const wanted = dress.outline === undefined ? OUTLINE_BRUSH : dress.outline === 'look' ? null : dress.outline;
    const outlined = wanted !== null && shape.props.stroke !== undefined && shape.props.stroke !== 'none' && shape.props.brush === undefined;
    lines.push({
      ...shape,
      id: ids[index] ?? `${placing.id}-p${index}`,
      geometry: remake(shape.geometry, k, placing.mirror),
      props: { ...shape.props, in: placing.id, ...(thick === undefined ? {} : { thick }), ...(outlined ? { brush: wanted as never } : {}), enter: 'draw', dur: placing.over },
      when: { kind: 'with' },
    });
  });
  return lines;
}

export type { InkRole, LookId };
