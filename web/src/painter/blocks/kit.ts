// What every engine needs: reading a structure's parts, sizing words, drawing
// nodes and connectors, finding clear room for a label, and the fit loop.

import type { ElementSpan, Point, Polyline, Range, SightNote } from '@conduit/language';
import { evalExpr, formatValue, parseTemplate } from '@conduit/language';
import type { BlockPart, MeasuredText, StructureInput, StructureLayout, TextSpec } from '../../contracts/blocks';
import type { Box } from '../../contracts/space';
import { arrowhead, box, boxOfPoints, centreOf, clippedRect, dashes, inflate, lengthOf, overlaps, polylineHitsBox, polylinesCross, right, roundedRect, bottom, trim, atDistance, union } from './geom';

export type Note = { readonly key: string; readonly note: SightNote };

/** The words of an element with any `{…}` worked out from the controls' values. */
export function wordsOf(el: ElementSpan, scope: StructureInput['scope']): { text: string; emphasis: readonly Range[] } {
  if (!el.text.includes('{')) return { text: el.text, emphasis: el.emphasis };
  const parts = parseTemplate(el.text, (name) => Object.hasOwn(scope, name));
  let out = '';
  let changed = false;
  for (const part of parts) {
    if (part.kind === 'text') out += part.text;
    else {
      out += formatValue(evalExpr(part.expr, scope), part.digits);
      changed = true;
    }
  }
  return changed ? { text: out, emphasis: [] } : { text: el.text, emphasis: el.emphasis };
}

/** Everything one layout attempt shares. */
export class Env {
  readonly input: StructureInput;
  readonly shrink: number;
  readonly tight: number;
  readonly body: number;
  readonly stroke: number;
  readonly spec: TextSpec;
  readonly wrapWidth: number;
  private readonly cache = new Map<string, MeasuredText>();

  constructor(input: StructureInput, shrink: number, tight: number, stroke: number) {
    this.input = input;
    this.shrink = shrink;
    this.tight = tight;
    this.body = input.look.body * shrink;
    this.stroke = Math.max(1, stroke);
    const s = input.structure.style;
    this.spec = { size: s.size, weight: s.weight, face: s.face, letterCase: s.case, shrink };
    const sixteen = input.measure('n'.repeat(16), this.spec, 1e9).width;
    this.wrapWidth = Math.max(this.body * 4, Math.min(sixteen, input.room.width / 3 - this.body));
  }

  measure(text: string, maxWidth: number = this.wrapWidth, spec: TextSpec = this.spec): MeasuredText {
    const key = `${maxWidth}|${spec.size}|${spec.shrink}|${text}`;
    let m = this.cache.get(key);
    if (!m) {
      m = this.input.measure(text, spec, maxWidth);
      this.cache.set(key, m);
    }
    return m;
  }

  /** A caption-sized spec: the look's `xs`, for ticks and labels. */
  small(): TextSpec {
    return { ...this.spec, size: 'xs', weight: 'normal' as TextSpec['weight'] };
  }

  get grid(): { width: number; height: number } | null {
    return this.input.look.grid?.cell ?? null;
  }

  /** Rounds a size up, and a position to the nearest, onto the character grid when the look has one. */
  up(v: number, axis: 'x' | 'y'): number {
    const g = this.grid;
    if (!g) return v;
    const c = axis === 'x' ? g.width : g.height;
    return Math.ceil(v / c - 1e-9) * c;
  }
  snap(v: number, axis: 'x' | 'y'): number {
    const g = this.grid;
    if (!g) return v;
    const c = axis === 'x' ? g.width : g.height;
    return Math.round(v / c) * c;
  }

  /** the structure's title, set large at the room's corner; `h` is what it takes from the top */
  title(): { part: (room: Box) => BlockPart | null; h: number } {
    const text = this.input.structure.text.trim();
    if (!text) return { part: () => null, h: 0 };
    const spec: TextSpec = { ...this.spec, size: 'l' };
    const m = this.input.measure(text, spec, this.input.room.width);
    const key = this.input.structure.key;
    return {
      h: this.up(m.height + this.body * 0.8, 'y'),
      part: (room) => ({ kind: 'text', owner: key, part: 'title', text, emphasis: [], box: box(room.x, room.y, m.width, m.height), spec, align: 'left', role: 'title', plate: false }),
    };
  }

  /** a position at or after `v` on the grid */
  after(v: number, axis: 'x' | 'y'): number {
    const g = this.grid;
    if (!g) return v;
    const c = axis === 'x' ? g.width : g.height;
    return Math.ceil(v / c - 1e-9) * c;
  }

  /** `v` snapped to the grid and kept within [lo, hi] where the grid allows */
  within(v: number, lo: number, hi: number, axis: 'x' | 'y'): number {
    const g = this.grid;
    if (!g) return v;
    const c = axis === 'x' ? g.width : g.height;
    let s = Math.round(v / c) * c;
    if (s < lo) s = Math.ceil(lo / c - 1e-9) * c;
    if (s > hi) s = Math.floor(hi / c + 1e-9) * c;
    return s;
  }

  /** the centre of something `extent` wide, moved so that its start sits on the grid */
  centre(v: number, extent: number, axis: 'x' | 'y'): number {
    return this.grid ? this.snap(v - extent / 2, axis) + extent / 2 : v;
  }

  get headLength(): number {
    return Math.max(7, 2 * this.stroke);
  }
}

export interface NodeBox {
  readonly el: ElementSpan;
  readonly text: string;
  readonly emphasis: readonly Range[];
  readonly m: MeasuredText;
  /** the frame's size */
  width: number;
  height: number;
}

/** A node as big as its words need, with half a body line of margin all round. */
export function sizeNode(env: Env, el: ElementSpan, maxWidth: number = env.wrapWidth): NodeBox {
  const w = wordsOf(el, env.input.scope);
  const m = env.measure(w.text, maxWidth);
  const shape = el.figure?.kind === 'node' ? el.figure.shape : 'step';
  let width = m.width + env.body;
  let height = m.height + env.body;
  if (shape === 'end') width = Math.max(width + height * 0.3, height * 1.4);
  if (shape === 'ask') {
    width += height * 0.3;
    height += env.body * 0.2;
  }
  return { el, text: w.text, emphasis: w.emphasis, m, width: env.up(width, 'x'), height: env.up(height, 'y') };
}

export function shapeOf(el: ElementSpan): 'step' | 'ask' | 'end' | 'note' {
  return el.figure?.kind === 'node' ? el.figure.shape : 'step';
}

/** The parts of a node whose frame is at `at`: ground, frame, words. */
export function nodeParts(env: Env, n: NodeBox, at: Box, fills: BlockPart[], frames: BlockPart[], texts: BlockPart[]): void {
  const shape = shapeOf(n.el);
  const radius = env.input.look.radius;
  if (shape !== 'note') {
    const outline: Polyline =
      shape === 'ask' ? clippedRect(at, Math.min(at.height * 0.28, env.body * 0.9)) : shape === 'end' ? roundedRect(at, at.height / 2) : roundedRect(at, radius);
    fills.push({ kind: 'shape', owner: n.el.key, part: 'fill', outline: [outline], role: 'fill' });
    frames.push({ kind: 'shape', owner: n.el.key, part: 'box', outline: [outline], role: 'frame' });
  }
  const tw = n.m.width;
  const th = n.m.height;
  const tx = at.x + env.snap((at.width - tw) / 2, 'x');
  const ty = at.y + env.snap((at.height - th) / 2, 'y');
  texts.push({ kind: 'text', owner: n.el.key, part: 'words', text: n.text, emphasis: n.emphasis, box: box(tx, ty, tw, th), spec: env.spec, align: 'center', role: 'words', plate: false });
}

export interface LinkSpec {
  readonly el: ElementSpan;
  readonly from: string;
  readonly to: string;
  readonly ends: 'arrow' | 'both' | 'plain';
  readonly dashed: boolean;
  readonly label: string;
}

export function linkSpecs(input: StructureInput): LinkSpec[] {
  const keys = new Set(input.nodes.map((n) => n.key));
  const out: LinkSpec[] = [];
  for (const el of input.links) {
    const f = el.figure;
    if (f?.kind !== 'link' || !keys.has(f.from) || !keys.has(f.to) || f.from === f.to) continue;
    out.push({ el, from: f.from, to: f.to, ends: f.ends, dashed: f.dashed, label: wordsOf(el, input.scope).text.trim() });
  }
  return out;
}

/** Draws a connector: the line (shortened under its arrowheads, cut into dashes if dashed) and the heads. `pts` runs from the node it leaves to the node it reaches. */
export function connectorParts(env: Env, l: LinkSpec, pts: readonly Point[], lines: BlockPart[], heads: BlockPart[], owner: string = l.el.key): void {
  const head = env.headLength;
  const half = head * 0.5;
  const total = lengthOf(pts);
  const startHead = l.ends === 'both' && total > head * 3;
  const endHead = l.ends !== 'plain' && total > head * 1.5;
  const body = trim(pts, startHead ? head : 0, endHead ? head : 0);
  if (endHead) {
    const a = atDistance(pts, total - head);
    heads.push({ kind: 'shape', owner, part: 'head', outline: [arrowhead(atDistance(pts, total).point, a.dir, head, half)], role: 'head' });
  }
  if (startHead) {
    const a = atDistance(pts, head);
    heads.push({ kind: 'shape', owner, part: 'head0', outline: [arrowhead(pts[0] as Point, { x: -a.dir.x, y: -a.dir.y }, head, half)], role: 'head' });
  }
  const outline: Polyline[] = l.dashed ? dashes(body, Math.max(6, 4 * env.stroke), Math.max(4, 3 * env.stroke)) : [{ points: body, closed: false }];
  lines.push({ kind: 'shape', owner, part: 'line', outline, role: 'line' });
}

export function labelPart(env: Env, owner: string, text: string, at: Box, m: { width: number; height: number }, plate: boolean): BlockPart {
  return { kind: 'text', owner, part: 'label', text, emphasis: [], box: box(at.x, at.y, m.width, m.height), spec: env.small(), align: 'center', role: 'label', plate };
}

export interface Blockers {
  readonly boxes: readonly Box[];
  readonly lines: readonly Polyline[];
}

/** Penalty of putting `b` here: overlaps with boxes, lines through it. 0 is clear. */
export function clash(b: Box, blockers: Blockers, skipLine: Polyline | null, gap = 1): number {
  let n = 0;
  const g = inflate(b, gap);
  for (const o of blockers.boxes) if (overlaps(g, o)) n += 1;
  for (const l of blockers.lines) if (l !== skipLine && polylineHitsBox(l, g)) n += 1;
  return n;
}

/** First candidate with no clash, else the one with the least (and its penalty). */
export function firstClear(cands: readonly Box[], blockers: Blockers, skipLine: Polyline | null, room: Box | null): { box: Box; penalty: number } | null {
  let best: { box: Box; penalty: number } | null = null;
  for (const c of cands) {
    let p = clash(c, blockers, skipLine);
    if (room && (c.x < room.x - 0.5 || c.y < room.y - 0.5 || right(c) > right(room) + 0.5 || bottom(c) > bottom(room) + 0.5)) p += 3;
    if (p === 0) return { box: c, penalty: 0 };
    if (!best || p < best.penalty) best = { box: c, penalty: p };
  }
  return best;
}

/**
 * The fit loop: spacing first (`tight`), then size (`shrink`) down to the
 * look's least, then the word `crowded`. `build` lays everything out at the
 * origin and reports its extent; `place` finishes it inside the room.
 */
export interface Draft {
  readonly width: number;
  readonly height: number;
  finish(room: Box): { parts: BlockPart[]; boxes: Map<string, Box>; routes: Map<string, Polyline>; notes: Note[] };
}

export function fit(input: StructureInput, stroke: number, build: (env: Env) => Draft, extra?: (draft: Draft) => boolean): StructureLayout {
  const room = input.room;
  const minShrink = Math.max(0.3, input.look.minShrink);
  const cellW = input.look.grid?.cell.width ?? 0;
  const cellH = input.look.grid?.cell.height ?? 0;
  const fits = (d: Draft): boolean => d.width + cellW <= room.width + 0.5 && d.height + cellH <= room.height + 0.5 && (extra ? extra(d) : true);
  let env = new Env(input, 1, 1, stroke);
  let draft = build(env);
  let shrink = 1;
  let tight = 1;
  if (!fits(draft)) {
    tight = 0.6;
    env = new Env(input, 1, tight, stroke);
    draft = build(env);
    for (let i = 0; i < 6 && !fits(draft) && shrink > minShrink + 1e-9; i += 1) {
      const scale = Math.min(room.width / Math.max(1, draft.width), room.height / Math.max(1, draft.height));
      shrink = Math.max(minShrink, Math.min(shrink * 0.97, shrink * scale * 0.985));
      env = new Env(input, shrink, tight, stroke);
      draft = build(env);
    }
  }
  const ok = fits(draft);
  const done = draft.finish(room);
  const notes = [...done.notes];
  if (!ok) notes.push({ key: input.structure.key, note: 'crowded' });
  if (shrink < 1 && ok) notes.push({ key: input.structure.key, note: 'shrunk' });
  const all = [...done.boxes.values()];
  const boxes = done.boxes;
  boxes.set(input.structure.key, union(all));
  return { boxes, parts: done.parts, routes: done.routes, notes, shrink };
}

/** Back to front: grounds, connectors, heads, frames, words. */
export function ordered(...layers: readonly BlockPart[][]): BlockPart[] {
  return layers.flat();
}

export { boxOfPoints, centreOf, polylinesCross };

/** A tidy number for an axis: 1, 2 or 5 times a power of ten, at least `raw`. */
export function niceStep(raw: number): number {
  if (!(raw > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}
