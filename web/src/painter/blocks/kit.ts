// What every engine needs: reading a structure's parts, sizing words, drawing
// nodes and connectors, finding clear room for a label, and the fit loop.

import type { ElementSpan, Point, Polyline, Range, SightNote } from '@conduit/language';
import { evalExpr, formatValue, parseTemplate } from '@conduit/language';
import type { BlockPart, MeasuredText, StructureInput, StructureLayout, TextSpec } from '../../contracts/blocks';
import type { Box } from '../../contracts/space';
import { arrowhead, box, cutOutBox, boxOfPoints, centreOf, diamond, dashes, inflate, lengthOf, overlaps, polylineHitsBox, polylinesCross, right, roundedRect, bottom, trim, atDistance, union } from './geom';

export type Note = { readonly key: string; readonly note: SightNote };

/** The words of an element with any `{…}` worked out from the controls' values. */
export function wordsOf(el: ElementSpan, scope: StructureInput['scope']): { text: string; emphasis: readonly Range[] } {
  return wordsIn(el.text, el.emphasis, scope);
}

/** Any words (a table's cell, a chart's) with `{…}` worked out from the controls' values; the emphasis is kept when nothing was worked out. */
export function wordsIn(source: string, emphasis: readonly Range[], scope: StructureInput['scope']): { text: string; emphasis: readonly Range[] } {
  if (!source.includes('{')) return { text: source, emphasis };
  const parts = parseTemplate(source, (name) => Object.hasOwn(scope, name));
  let out = '';
  let changed = false;
  for (const part of parts) {
    if (part.kind === 'text') out += part.text;
    else {
      out += formatValue(evalExpr(part.expr, scope), part.digits);
      changed = true;
    }
  }
  return changed ? { text: out, emphasis: [] } : { text: source, emphasis };
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

  constructor(input: StructureInput, shrink: number, tight: number, stroke: number, wrap = 1) {
    this.input = input;
    this.shrink = shrink;
    this.tight = tight;
    this.body = input.look.body * shrink;
    this.stroke = Math.max(1, stroke);
    const s = input.structure.style;
    this.spec = { size: s.size, weight: s.weight, face: s.face, letterCase: s.case, shrink };
    const sixteen = input.measure('n'.repeat(16), this.spec, 1e9).width;
    this.wrapWidth = Math.max(this.body * 4, Math.min(sixteen * wrap, (input.room.width / 3 - this.body) * wrap));
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

  /** The size of a word on a link, a branch, a pin or a callout: `s`, in ink. Only an axis tick is `xs`. */
  label(): TextSpec {
    return { ...this.spec, size: 's', weight: 'normal' as TextSpec['weight'] };
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

/** How much bigger than its words a diamond is: the words are a rectangle in its middle, and a rectangle fills half a diamond. */
const DIAMOND = 1.8;

/** A node as big as its words need, with half a body line of margin all round. */
export function sizeNode(env: Env, el: ElementSpan, maxWidth: number = env.wrapWidth): NodeBox {
  const w = wordsOf(el, env.input.scope);
  const shape = el.figure?.kind === 'node' ? el.figure.shape : 'step';
  // a question is a diamond, and the words sit in its middle: they are set narrower and taller, and the frame is as much bigger as it takes
  const m = env.measure(w.text, shape === 'ask' ? Math.max(env.body * 6, maxWidth * 0.7) : maxWidth);
  let width = m.width + env.body;
  let height = m.height + env.body;
  if (shape === 'end') width = Math.max(width + height * 0.3, height * 1.4);
  if (shape === 'ask') {
    width = (m.width + env.body * 0.6) * DIAMOND;
    height = (m.height + env.body * 0.6) * DIAMOND;
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
      shape === 'ask' ? diamond(at) : shape === 'end' ? roundedRect(at, at.height / 2) : roundedRect(at, radius);
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
  return { kind: 'text', owner, part: 'label', text, emphasis: [], box: box(at.x, at.y, m.width, m.height), spec: env.label(), align: 'center', role: 'label', plate };
}

/**
 * A label that could find no clear place beside its line gets a knockout instead: every connector line stretch under the word (and a
 * small margin round it) is taken out, so the line visibly breaks round the word and never runs through it, crossing edges included. True when the
 * word still stands on a box in `others` (a node, another label), which is for the engine to say as `crossed`.
 */
export function knockOut(lines: BlockPart[], at: Box, margin: number, others: readonly Box[]): boolean {
  const hole = inflate(at, margin);
  lines.forEach((part, i) => {
    if (part.kind !== 'shape' || part.role !== 'line') return;
    if (!part.outline.some((o) => polylineHitsBox(o, hole))) return;
    lines[i] = { ...part, outline: part.outline.flatMap((o) => (polylineHitsBox(o, hole) ? cutOutBox(o, hole) : [o])) };
  });
  // what a knockout cannot mend: the word standing on a node or on another word (true then)
  const near = inflate(at, 1);
  return others.some((o) => o !== at && overlaps(near, o));
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

/**
 * Places for a label BESIDE a drawn run (never on it), nearest the middle first: above and below a horizontal run, to the
 * right and left of a vertical one, then the same a third and two thirds of the way along. `off` is the clear space kept
 * between the line and the words.
 */
export function besideRun(a: Point, b: Point, w: number, h: number, off: number): Box[] {
  const out: Box[] = [];
  const horizontal = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
  for (const o of [off, off * 3]) {
    for (const t of [0.5, 0.3, 0.7, 0.15, 0.85]) {
      const c = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      if (horizontal) out.push(box(c.x - w / 2, c.y - h - o, w, h), box(c.x - w / 2, c.y + o, w, h));
      else out.push(box(c.x + o, c.y - h / 2, w, h), box(c.x - o - w, c.y - h / 2, w, h));
    }
  }
  return out;
}

/** The clear place beside the first of `runs` that has one (runs are tried in the order given); null when every place clashes, with the least bad. */
export function placeBeside(runs: readonly (readonly [Point, Point])[], w: number, h: number, off: number, blockers: Blockers, room: Box | null): { box: Box; penalty: number } | null {
  let best: { box: Box; penalty: number } | null = null;
  for (const [a, b] of runs) {
    if (Math.hypot(b.x - a.x, b.y - a.y) < 1) continue;
    const pick = firstClear(besideRun(a, b, w, h, off), blockers, null, room);
    if (pick === null) continue;
    if (pick.penalty === 0) return pick;
    if (best === null || pick.penalty < best.penalty) best = pick;
  }
  return best;
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

/** The least a structure is ever set at: below the look's own floor it is still on the page and inside its room, and says `crowded`. */
export const HARD_SHRINK = 0.3;
/** The tightest spacing between parts a structure is set at, when it will not fit its room otherwise (`tight` in the Env). */
const TIGHTEST = 0.35;

export function fit(input: StructureInput, stroke: number, build: (env: Env) => Draft, extra?: (draft: Draft) => boolean, wrap = 1): StructureLayout {
  const room = input.room;
  const floor = Math.max(HARD_SHRINK, input.look.minShrink);
  const cellW = input.look.grid?.cell.width ?? 0;
  const cellH = input.look.grid?.cell.height ?? 0;
  const fits = (d: Draft, slack = 0): boolean => d.width + cellW <= room.width + 0.5 - slack && d.height + cellH <= room.height + 0.5 - slack && (extra ? extra(d) : true);
  let env = new Env(input, 1, 1, stroke, wrap);
  let draft = build(env);
  let shrink = 1;
  if (!fits(draft)) {
    // Spacing first (tighter gaps and ranks), then size. The loop steps down by a share at a time and snaps as it goes, so it can end at the least size
    // without having tried the sizes between; when the least size fits, the largest that does is found by halving.
    const settle = (tight: number): { env: Env; draft: Draft; shrink: number } => {
      let e = new Env(input, 1, tight, stroke, wrap);
      let d = build(e);
      let s = 1;
      // Down to the look's floor first; then, rather than leave a part outside its room, below it, said as `crowded`.
      for (let i = 0; i < 14 && !fits(d) && s > HARD_SHRINK + 1e-9; i += 1) {
        const scale = Math.min(room.width / Math.max(1, d.width), room.height / Math.max(1, d.height));
        const lower = s > floor + 1e-9 ? floor : HARD_SHRINK;
        s = Math.max(lower, Math.min(s * 0.97, s * scale * 0.985));
        e = new Env(input, s, tight, stroke, wrap);
        d = build(e);
      }
      if (!fits(d) && s > HARD_SHRINK + 1e-9) {
        const smallestEnv = new Env(input, HARD_SHRINK, tight, stroke, wrap);
        const smallest = build(smallestEnv);
        if (fits(smallest)) {
          let lo = HARD_SHRINK;
          let hi = s;
          let kept = { env: smallestEnv, draft: smallest };
          for (let i = 0; i < 8 && hi - lo > 0.005; i += 1) {
            const mid = (lo + hi) / 2;
            const tryEnv = new Env(input, mid, tight, stroke, wrap);
            const tryDraft = build(tryEnv);
            if (fits(tryDraft)) {
              lo = mid;
              kept = { env: tryEnv, draft: tryDraft };
            } else hi = mid;
          }
          return { env: kept.env, draft: kept.draft, shrink: lo };
        }
      }
      return { env: e, draft: d, shrink: s };
    };
    let got = settle(0.6);
    // Still not in its room, or only below the look's floor: ranks and gaps as tight as they go.
    if (!fits(got.draft) || got.shrink < floor - 1e-9) {
      const tighter = settle(TIGHTEST);
      const over = (d: Draft): number => Math.max(0, d.width / Math.max(1, room.width) - 1) + Math.max(0, d.height / Math.max(1, room.height) - 1);
      if (fits(tighter.draft) ? !fits(got.draft) || tighter.shrink > got.shrink * 1.1 : !fits(got.draft) && over(tighter.draft) < over(got.draft)) got = tighter;
    }
    env = got.env;
    draft = got.draft;
    shrink = got.shrink;
  }
  const ok = fits(draft);
  const done = draft.finish(room);
  const notes = [...done.notes];
  if (!ok || shrink < input.look.minShrink - 1e-9) notes.push({ key: input.structure.key, note: 'crowded' });
  else if (shrink < 1) notes.push({ key: input.structure.key, note: 'shrunk' });
  const all = [...done.boxes.values()];
  const boxes = done.boxes;
  boxes.set(input.structure.key, union(all));
  return { boxes, parts: done.parts, routes: done.routes, notes, shrink, overflows: ok ? 0 : Math.max(0, draft.width / Math.max(1, room.width) - 1) + Math.max(0, draft.height / Math.max(1, room.height) - 1) + 1e-6 };
}

export const isCrowded = (l: StructureLayout): boolean => l.notes.some((n) => n.note === 'crowded');

/** How wide a node's words may run, as shares of the usual: a narrow room does better with fewer, longer lines, a short one with more, shorter. */
export const WRAPS: readonly number[] = [1, 0.7, 1.6, 2.4];

/**
 * The best of several attempts, tried in the order given: one that is not `crowded` over one that is, then the larger type; the
 * earlier one unless a later one is clearly better (the first is the one that stays put when a part is appended).
 */
export function best(attempts: readonly (() => StructureLayout)[]): StructureLayout {
  let top: StructureLayout | null = null;
  // what stands outside its room is the worst there is (it is cut off, and words set beside it land on it): any arrangement that fits beats one that does not
  const rank = (l: StructureLayout): number => ((l.overflows ?? 0) > 0 ? 2 : isCrowded(l) ? 1 : 0);
  for (const attempt of attempts) {
    const l = attempt();
    if (top === null) {
      top = l;
      if (rank(l) === 0 && l.shrink >= 1) break;
      continue;
    }
    const a = rank(top);
    const b = rank(l);
    if (b < a) top = l;
    else if (a === 2 && b === 2) {
      if ((l.overflows ?? 0) < (top.overflows ?? 0) - 0.02) top = l;
    } else if (a === b && l.shrink > top.shrink * 1.15) top = l;
  }
  return top as StructureLayout;
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
