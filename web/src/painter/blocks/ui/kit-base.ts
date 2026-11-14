// What every part of the kit is made of (split out of kit.ts so that the richer parts can be made of it too): the node and its item,
// the kit a screen is built with, a box of flex, a rectangle, a block of words that wraps to the room it is given, an icon.
//
// Pure: no DOM, no clock. Text is sized through the measurer it is handed; colours, radii, type and shadows come from the
// look's tokens; the live parts read a `UiState`.

import type { UiDevice, UiTextToken, UiTokens } from './lang';
import { hasIcon, placeIcon } from './icons';
import type { UiMeasure } from './measure';
import type { Align, Box as FlexBox, Node, Style } from './solve';
import type { UiAction, UiPart, UiRect, UiShadow, UiState } from './types';

// ------------------------------------------------------------------ what a node carries

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Where a node draws itself, and what it is. */
export interface Item {
  readonly id: string;
  /** the part's kind (`button`), or `row`, `col`, `screen`, or a piece of one (`button.label`) */
  readonly part: string;
  /** sits at the start of a container that stretches, instead of being stretched */
  readonly hug?: boolean;
  readonly paint?: (b: Rect, out: Out) => void;
  readonly action?: UiAction;
  /** a thing a finger uses: its box must be 44 points each way */
  readonly target?: boolean;
  /** words set in this box: lint checks they fit */
  readonly words?: true;
  /** the width the words need on one line, when they must not wrap */
  readonly need?: number;
  /** not a part to lint (a rule, a spacer, a glyph) */
  readonly quiet?: boolean;
  /** this part is a real chart's room */
  readonly slot?: string;
  /** the parts this one is made of belong to it, for lint's "words outside their part" */
  readonly owner?: string;
  /** a row that moves sideways under a finger, kept under this id: what is inside it is shifted by the offset and kept inside this box */
  readonly scroll?: string;
}

export type N = Node<Item>;

/** The sink the paint functions write into. */
export interface Out {
  readonly parts: UiPart[];
  key(owner: string, what: string): string;
}

export interface Kit {
  readonly t: UiTokens;
  readonly device: UiDevice;
  readonly measure: UiMeasure;
  readonly state: UiState;
  /** the type scale for this device: a desk sets its type larger than a phone */
  readonly type: UiTokens['type'];
}

// ------------------------------------------------------------------ scale

const DESK_TYPE: Partial<Record<keyof UiTokens['type'], UiTextToken>> = {
  note: { size: 14, line: 20, weight: 'normal' },
  body: { size: 16, line: 24, weight: 'normal' },
  label: { size: 16, line: 24, weight: 'bold' },
  title: { size: 20, line: 28, weight: 'bold' },
  heading: { size: 32, line: 40, weight: 'bold' },
  display: { size: 48, line: 56, weight: 'bold' },
  hero: { size: 64, line: 72, weight: 'bold' },
};

/** A type scale with nothing set smaller than `min` points; a role that is taken up keeps its proportions and stays on the four-point grid. */
function atLeast(type: UiTokens['type'], min: number | undefined): UiTokens['type'] {
  if (min === undefined) return type;
  const out = { ...type };
  for (const role of Object.keys(type) as (keyof UiTokens['type'])[]) {
    const token = type[role];
    if (token.size >= min) continue;
    out[role] = { ...token, size: min, line: Math.max(token.line, Math.ceil((min * 1.4) / 4) * 4) };
  }
  return out;
}

export function makeKit(t: UiTokens, device: UiDevice, measure: UiMeasure, state: UiState): Kit {
  const desk = device === 'desktop' || device === 'browser';
  // a desk sets its type larger, in the face the screen's `type=` chose for that role
  const scaled = { ...t.type };
  if (desk) for (const role of Object.keys(DESK_TYPE) as (keyof UiTokens['type'])[]) scaled[role] = { ...t.type[role], ...DESK_TYPE[role] } as UiTextToken;
  return { t, device, measure, state, type: atLeast(scaled, t.minText) };
}

/** How closely a screen is set: the style's `density=`, as a step from the look's own measure (-1 compact, 0 as the look has it, 1 comfortable). */
export function packOf(k: Kit): -1 | 0 | 1 {
  return k.t.pack === 'compact' ? -1 : k.t.pack === 'comfortable' ? 1 : 0;
}

/** The side margin of a screen: what loose parts are kept in from its edge. */
export function gutterOf(k: Kit): number {
  const desk = k.device === 'desktop' || k.device === 'browser';
  return desk ? 40 : 16 + packOf(k) * 4;
}

export const px4 = (n: number): number => Math.round(n / 4) * 4;

// ------------------------------------------------------------------ small constructors

export function mk(style: Style, box: FlexBox | null, leaf: N['leaf'], children: readonly N[], item: Item): N {
  return { style, box, leaf, children, payload: item };
}

export function flex(dir: 'row' | 'col', o: Partial<Omit<FlexBox, 'dir' | 'pad'>> & { readonly pad?: number | readonly [number, number, number, number] }): FlexBox {
  const pad = o.pad === undefined ? ([0, 0, 0, 0] as const) : typeof o.pad === 'number' ? ([o.pad, o.pad, o.pad, o.pad] as const) : o.pad;
  return { dir, gap: o.gap ?? 0, pad, align: o.align ?? (dir === 'row' ? 'center' : 'stretch'), justify: o.justify ?? 'start', wrap: o.wrap ?? false };
}

export function rectOf(out: Out, owner: string, what: string, b: Rect, o: { radius?: number; fill?: UiRect['fill']; fillAlpha?: number; edge?: UiRect['edge']; shadow?: UiShadow; rule?: UiRect['rule'] }): void {
  out.parts.push({ kind: 'rect', key: out.key(owner, what), owner, x: b.x, y: b.y, w: b.w, h: b.h, radius: o.radius ?? 0, fill: o.fill ?? null, edge: o.edge ?? null, ...(o.fillAlpha === undefined ? {} : { fillAlpha: o.fillAlpha }), ...(o.shadow === undefined ? {} : { shadow: o.shadow }), ...(o.rule === undefined ? {} : { rule: o.rule }) });
}

export function shadowOf(k: Kit, level: 'low' | 'high'): UiShadow | undefined {
  const e = k.t.elevation[level];
  return e.alpha === 0 && e.dy === 0 ? undefined : { colour: k.t.colour.shadow, dy: e.dy, blur: e.blur, alpha: e.alpha };
}

export interface TextOpts {
  readonly id: string;
  readonly nowrap?: boolean;
  /** may be squeezed below its words (a title in a bar, a value in a field): lint reports it when it happens */
  readonly squeeze?: boolean;
  readonly align?: 'left' | 'center' | 'right';
  readonly colour: string;
  readonly width?: Style['width'];
  readonly grow?: number;
  readonly what?: string;
  readonly self?: Style['self'];
  readonly maxLines?: number;
}

/** The lines of `words` set across `width`, kept to `most` of them: when there are more, the last one that is kept ends in an ellipsis that fits. */
export function clampedLines(m: UiMeasure, words: string, token: UiTextToken, width: number, most: number): { readonly text: string; readonly width: number }[] {
  const face = token.face ?? 'sans';
  const wrapped = m.wrap(words, token.size, token.weight, width, face).lines;
  if (wrapped.length <= most) return [...wrapped];
  const kept = wrapped.slice(0, most);
  const last = kept[most - 1];
  if (last === undefined) return kept;
  const rest = wrapped.slice(most - 1).map((line) => line.text).join(' ');
  let cut = rest;
  while (cut.length > 1 && m.width(`${cut.trimEnd()}\u2026`, token.size, token.weight, face) > width) cut = cut.slice(0, -1);
  const shown = `${cut.trimEnd()}\u2026`;
  return [...kept.slice(0, most - 1), { text: shown, width: m.width(shown, token.size, token.weight, face) }];
}

/** One block of words. It wraps to the room it is given, and says how narrow and how tall it needs to be. `maxLines` keeps it to that many, the last ending in an ellipsis. */
export function text(k: Kit, words: string, token: UiTextToken, o: TextOpts): N {
  const m = k.measure;
  const face = token.face ?? 'sans';
  const single = (): number => m.width(words, token.size, token.weight, face);
  const fit = (maxW: number): { w: number; h: number } => {
    if (o.nowrap === true || !Number.isFinite(maxW)) {
      const lines = o.nowrap === true ? 1 : Math.min(o.maxLines ?? 99, m.wrap(words, token.size, token.weight, Number.POSITIVE_INFINITY, face).lines.length);
      return { w: single(), h: lines * token.line };
    }
    const r = m.wrap(words, token.size, token.weight, maxW, face);
    return { w: r.widest, h: Math.min(r.lines.length, o.maxLines ?? 99) * token.line };
  };
  const minW = o.nowrap === true ? (o.squeeze === true ? 0 : single()) : o.maxLines !== undefined ? 0 : m.longestWord(words, token.size, token.weight, face);
  const style: Style = { width: o.width ?? 'hug', height: 'hug', ...(o.grow === undefined ? {} : { grow: o.grow }), ...(o.self === undefined ? {} : { self: o.self }) };
  const paint = (b: Rect, out: Out): void => {
    const lines = o.nowrap === true ? [{ text: words, width: single() }] : o.maxLines !== undefined ? clampedLines(m, words, token, b.w, o.maxLines) : m.wrap(words, token.size, token.weight, b.w, face).lines;
    out.parts.push({ kind: 'text', key: out.key(o.id, o.what ?? 'words'), owner: o.id, x: b.x, y: b.y, w: b.w, h: b.h, lines, size: token.size, line: token.line, weight: token.weight, colour: o.colour, align: o.align ?? 'left', ...(face === 'sans' ? {} : { face }) });
  };
  return mk(style, null, { fit, minW }, [], { id: o.id, part: 'text', words: true, quiet: true, paint, owner: o.id, ...(o.nowrap === true ? { need: single() } : {}) });
}

/** An icon as a leaf `size` square. */
export function icon(id: string, name: string, size: number, colour: string, width = 2, filled = false): N {
  const paint = (b: Rect, out: Out): void => {
    out.parts.push({ kind: 'path', key: out.key(id, `icon:${name}`), owner: id, outline: placeIcon(hasIcon(name) ? name : 'info', b.x + (b.w - size) / 2, b.y + (b.h - size) / 2, size), fill: filled ? colour : null, stroke: { colour, width: width * (size / 24) } });
  };
  return mk({ width: size, height: size, shrink: 0 }, null, { fit: () => ({ w: size, h: size }), minW: size }, [], { id, part: 'icon', quiet: true, paint, owner: id });
}

export function gapOf(v: number | null, fallback: number): number {
  return v ?? fallback;
}

// ------------------------------------------------------------------ the parts

export interface Ctx {
  /** the container the part is in */
  readonly dir: 'row' | 'col';
  readonly align: Align;
}

