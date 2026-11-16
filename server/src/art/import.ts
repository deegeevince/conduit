// SVG in, sheet out: the dev-time half of the shelf (`pnpm art import`). The SVG is read by the strict converter (`svg.ts`), and its colours are
// restyled to the house palette: darks become the look's ink, creams its ground, and the rest is gathered into at most three slots of a hue each
// (a part that is lighter or darker than its slot says so in steps of tone), with a fourth and fifth family given to the look's `alt` and `accent`.

import { boundsOf, parseLine } from '@conduit/language';
import type { ShapeLine } from '@conduit/language';
import { HOUSE_PALETTE, MAX_TONE, TONE_STEP, nearestHue, toHsl } from './palette';
import type { HueName } from './palette';
import { SHEET_CAPS, readSheet } from './sheet';
import type { Facing, Sheet, SheetPart, SheetSlot } from './sheet';
import { convertSvg } from './svg';

export interface ImportMeta {
  readonly subject: string;
  readonly pose: string;
  readonly view: string;
  readonly facing: Facing;
  readonly by: string;
  readonly arm: string;
  readonly how: string;
  readonly licence: string;
  readonly ground?: number;
  readonly score?: number;
  /** a brush for the outline of every part that has one: absent keeps the look's own stroke */
  readonly brush?: string;
}

// ---- CIELAB, for telling colours apart the way an eye does ----

function lab(hex: string): { L: number; a: number; b: number; C: number; h: number } {
  const lin = (v: number): number => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const r = lin(parseInt(hex.slice(1, 3), 16));
  const g = lin(parseInt(hex.slice(3, 5), 16));
  const bl = lin(parseInt(hex.slice(5, 7), 16));
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * bl) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * bl) / 1.08883;
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const L = 116 * f(y) - 16;
  const a = 500 * (f(x) - f(y));
  const b = 200 * (f(y) - f(z));
  return { L, a, b, C: Math.hypot(a, b), h: (Math.atan2(b, a) * 180) / Math.PI };
}

function alike(p: string, q: string): boolean {
  const x = lab(p);
  const y = lab(q);
  if (Math.abs(x.L - y.L) > 38 || Math.abs(x.C - y.C) > 30) return false;
  if (x.C < 15 || y.C < 15) return true;
  const dh = Math.abs(x.h - y.h);
  return Math.min(dh, 360 - dh) <= 30;
}

const stepOf = (hex: string, hue: HueName): number => {
  const base = toHsl(HOUSE_PALETTE[hue].light)[2];
  return Math.max(-MAX_TONE, Math.min(MAX_TONE, Math.round((toHsl(hex)[2] - base) / TONE_STEP)));
};

const signed = (n: number): string => (n === 0 ? '' : n > 0 ? `+${n}` : String(n));

interface Raw {
  readonly name: string;
  readonly text: string;
  readonly fill: string | null;
  readonly stroke: string | null;
  readonly area: number;
}

const partName = (id: string, taken: Set<string>): string => {
  let name = id.slice(0, SHEET_CAPS.partName).replace(/-+$/, '');
  for (let n = 2; taken.has(name); n += 1) name = `${id.slice(0, SHEET_CAPS.partName - 2)}${n}`.replace(/-+$/, '');
  taken.add(name);
  return name;
};

export type Imported = { readonly ok: true; readonly sheet: Sheet; readonly notes: readonly string[] } | { readonly ok: false; readonly reason: string };

export function importSvg(svg: string, meta: ImportMeta): Imported {
  const converted = convertSvg(svg, 'g');
  if (!converted.ok) return { ok: false, reason: converted.reason };
  const notes: string[] = [];
  const raws: Raw[] = [];
  const taken = new Set<string>();
  for (const text of converted.text.slice(1)) {
    const parsed = parseLine(text);
    if (parsed.kind !== 'line') return { ok: false, reason: `a part does not read: ${text.slice(0, 50)}` };
    const shape = parsed.line as ShapeLine;
    const fill = /\bfill=(#[0-9a-f]{6})\b/.exec(text)?.[1] ?? null;
    const stroke = /\bstroke=(#[0-9a-f]{6})\b/.exec(text)?.[1] ?? null;
    const box = boundsOf(shape.geometry);
    raws.push({ name: partName(shape.id, taken), text: text.replace(/ in=g\b/, ''), fill, stroke, area: Math.max(1, box.w * box.h) });
  }

  // which colours are the look's own: the darks are its ink, the creams its ground, a shadow on the floor its dim
  const isShadow = (raw: Raw): boolean => raw.name === 'shadow';
  // a cream stays cream on a dark ground (a pale chest is not a hole in the fox), so it is a hue like any other and not the look's ground
  const role = (hex: string): 'ink' | null => (lab(hex).L < 24 ? 'ink' : null);
  // a dark outline is the look's ink; a dark fill is `deep`, which stays dark on a dark ground

  // the rest is gathered into families of one hue, heaviest first
  const weight = new Map<string, number>();
  for (const raw of raws) {
    if (isShadow(raw)) continue;
    if (raw.fill !== null && role(raw.fill) === null) weight.set(raw.fill, (weight.get(raw.fill) ?? 0) + raw.area);
    if (raw.stroke !== null && role(raw.stroke) === null && lab(raw.stroke).L > 35) weight.set(raw.stroke, (weight.get(raw.stroke) ?? 0) + raw.area / 4);
  }
  const families: { centre: string; members: string[]; area: number }[] = [];
  for (const [hex, area] of [...weight].sort((a, b) => b[1] - a[1])) {
    const home = families.find((family) => alike(family.centre, hex));
    if (home !== undefined) {
      home.members.push(hex);
      home.area += area;
    } else families.push({ centre: hex, members: [hex], area });
  }
  families.sort((a, b) => b.area - a.area);

  const slots: SheetSlot[] = [];
  const tokenOf = new Map<string, string>();
  const usedRoles = new Set<string>();
  families.forEach((family, index) => {
    if (index < SHEET_CAPS.slots) {
      const hue = nearestHue(family.centre);
      let name: string = hue;
      for (let n = 2; slots.some((slot) => slot.name === name); n += 1) name = `${hue.slice(0, 8)}${String.fromCharCode(96 + n)}`;
      slots.push({ name, hue });
      for (const member of family.members) tokenOf.set(member, `$${name}${signed(stepOf(member, hue))}`);
      return;
    }
    // a fourth and fifth family belong to the look's own second signals: cool is `alt`, warm is `accent`
    const h = lab(family.centre).h;
    const cool = h > -150 && h < -20;
    // a pale family left over joins the palest slot rather than taking a signal colour of the look
    const pale = lab(family.centre).L > 80;
    const word = pale ? null : cool && !usedRoles.has('alt') ? 'alt' : !usedRoles.has('accent') ? 'accent' : !usedRoles.has('alt') ? 'alt' : null;
    if (word !== null) usedRoles.add(word);
    else notes.push(`${family.members.length} colour(s) folded into a slot`);
    const palest = [...slots].sort((a, b) => lab(HOUSE_PALETTE[b.hue].light).L - lab(HOUSE_PALETTE[a.hue].light).L)[0];
    const target = word ?? `$${(pale ? palest : slots[0])?.name ?? 'ink'}`;
    for (const member of family.members) tokenOf.set(member, target);
  });
  const colourWord = (hex: string, raw: Raw, as: 'fill' | 'stroke'): string => (isShadow(raw) ? 'dim' : role(hex) !== null ? (as === 'fill' ? 'deep' : 'ink') : (tokenOf.get(hex) ?? 'ink'));

  const parts: SheetPart[] = raws.map((raw) => {
    let line = raw.text;
    if (raw.fill !== null) line = line.replace(/\bfill=#[0-9a-f]{6}\b/, `fill=${colourWord(raw.fill, raw, 'fill')}`);
    if (raw.stroke !== null) line = line.replace(/\bstroke=#[0-9a-f]{6}\b/, `stroke=${lab(raw.stroke).L < 35 ? 'ink' : colourWord(raw.stroke, raw, 'stroke')}`);
    // the second word of a line is its id: the sheet's own short name for it
    line = line.replace(/^(\S+) \S+/, `$1 ${raw.name}`);
    if (meta.brush !== undefined && raw.stroke !== null) {
      const bar = line.indexOf(' | ');
      line = bar < 0 ? `${line} brush=${meta.brush}` : `${line.slice(0, bar)} brush=${meta.brush}${line.slice(bar)}`;
    }
    return { id: raw.name, line };
  });

  const sheet = {
    v: 1,
    subject: meta.subject,
    pose: meta.pose,
    view: meta.view,
    facing: meta.facing,
    ground: meta.ground ?? groundOf(raws),
    slots,
    parts,
    made: { by: meta.by, arm: meta.arm, how: meta.how },
    licence: meta.licence,
    ...(meta.score === undefined ? {} : { score: meta.score }),
  };
  const read = readSheet(sheet);
  if (!read.ok) return { ok: false, reason: `the sheet does not pass its own reader: ${read.reason}` };
  return { ok: true, sheet: read.sheet, notes };
}

/** The ground line: the lowest edge of the figure, from the top of the box (the parts are centred, so the box runs -50..50). */
function groundOf(raws: readonly Raw[]): number {
  let low = -50;
  for (const raw of raws) {
    if (raw.name === 'shadow') continue;
    const parsed = parseLine(raw.text);
    if (parsed.kind !== 'line') continue;
    const box = boundsOf((parsed.line as ShapeLine).geometry);
    low = Math.max(low, box.y + box.h);
  }
  return Math.round(Math.max(0, Math.min(100, low + 50)) * 10) / 10;
}
