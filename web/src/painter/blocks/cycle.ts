// Cycle: nodes evenly round a ring (a circle, or an ellipse in a wide room) from
// twelve o'clock, clockwise; arcs that follow the ring close it. Up to five nodes
// carry their words inside; more become dots with their words outside. The cycle
// never drops an arrow: the ring grows before the type shrinks, and when an arc
// still does not fit a short curved connector joins the facing edges. A narrow
// room sets the cycle as a vertical loop: a column, down, and one line up the side.

import type { Point, Polyline } from '@conduit/language';
import type { BlockPart, StructureInput, StructureLayout, TextSpec } from '../../contracts/blocks';
import type { Box } from '../../contracts/space';
import { box, circle, contains, overlaps, right, bottom, union } from './geom';
import type { Draft, LinkSpec, NodeBox, Note } from './kit';
import { best, connectorParts, knockOut, Env, fit, labelPart, linkSpecs, nodeParts, placeBeside, sizeNode, WRAPS } from './kit';

interface Placed {
  frame: Box;
  words: Box | null;
}

export function layoutCycle(input: StructureInput): StructureLayout {
  const room = input.room;
  const attempts: (() => StructureLayout)[] = [];
  const narrow = room.width <= room.height * 1.05 && input.nodes.length >= 2;
  // in a wide room the ring; in a narrow one the loop, unless the ring is clearly the bigger type
  const ring = (wrap: number) => (): StructureLayout => fit(input, input.look.stroke, (env) => buildCycle(env), undefined, wrap);
  const loop = (wrap: number) => (): StructureLayout => fit(input, input.look.stroke, (env) => buildLoop(env), undefined, wrap);
  for (const wrap of WRAPS) {
    if (narrow) attempts.push(loop(wrap), ring(wrap));
    else attempts.push(ring(wrap));
  }
  return best(attempts);
}

/** where a ray from the centre of a box (or dot) leaves it */
function leave(c: Point, half: { w: number; h: number }, d: Point): Point {
  const t = Math.min(half.w / Math.max(1e-6, Math.abs(d.x)), half.h / Math.max(1e-6, Math.abs(d.y)));
  return { x: c.x + d.x * t, y: c.y + d.y * t };
}

function buildCycle(env: Env): Draft {
  const n = env.input.nodes.length;
  const body = env.body;
  const dots = n > 5;
  const nodes = env.input.nodes.map((el) => sizeNode(env, el));
  const rd = Math.max(4, env.stroke * 1.6);
  const gap = 0.5 * body * env.tight;
  const arcGap = Math.max(gap, env.headLength * 2.4);
  const room0 = env.input.room;
  // a wide room gets a wide ring
  const k = Math.max(1, Math.min(2.2, room0.width / Math.max(1, room0.height)));
  const phi = (i: number): number => (2 * Math.PI * i) / Math.max(1, n);
  const dir = (i: number): Point => ({ x: Math.sin(phi(i)), y: -Math.cos(phi(i)) });

  /** no part of the ring (the ellipse the dots sit on) passes through the words at `b` */
  const ringClear = (b: Box, R: number): boolean => {
    const pad = rd + gap * 0.4;
    const x0 = b.x - pad;
    const x1 = right(b) + pad;
    const y0 = b.y - pad;
    const y1 = bottom(b) + pad;
    for (let q = 0; q < 48; q += 1) {
      const a = (2 * Math.PI * q) / 48;
      const x = k * R * Math.sin(a);
      const y = -R * Math.cos(a);
      if (x > x0 && x < x1 && y > y0 && y < y1) return false;
    }
    return true;
  };

  /** frames (and words) round a centre at the origin, on the ellipse of half-height `R` */
  const arrange = (R: number): Placed[] =>
    nodes.map((nd, i) => {
      const u = dir(i);
      const p = { x: k * R * u.x, y: R * u.y };
      if (!dots) return { frame: box(p.x - nd.width / 2, p.y - nd.height / 2, nd.width, nd.height), words: null };
      const frame = box(p.x - rd, p.y - rd, 2 * rd, 2 * rd);
      const w = nd.m.width;
      const h = nd.m.height;
      const side = Math.abs(u.x) < 0.3 ? (u.y < 0 ? 'top' : 'bottom') : u.x > 0 ? 'right' : 'left';
      const dist = Math.hypot(p.x, p.y);
      for (let s = rd + gap * 0.5; s < rd + gap * 0.5 + 400; s += 2) {
        const q = { x: p.x + s * u.x, y: p.y + s * u.y };
        const b =
          side === 'top' ? box(q.x - w / 2, q.y - h, w, h) : side === 'bottom' ? box(q.x - w / 2, q.y, w, h) : side === 'right' ? box(q.x, q.y - h / 2, w, h) : box(q.x - w, q.y - h / 2, w, h);
        const nx = Math.max(b.x, Math.min(0, right(b)));
        const ny = Math.max(b.y, Math.min(0, bottom(b)));
        if (Math.hypot(nx, ny) >= dist + rd + gap * 0.5 && ringClear(b, R)) return { frame, words: b };
      }
      return { frame, words: box(p.x, p.y, w, h) };
    });
  const spread = (ps: Placed[]): Box => union(ps.flatMap((p) => (p.words ? [p.frame, p.words] : [p.frame])));
  const clean = (ps: Placed[]): boolean => {
    const items = ps.map((p) => (p.words ? union([p.frame, p.words]) : p.frame));
    const pad = dots ? gap * 0.5 : arcGap;
    for (let i = 0; i < items.length; i += 1) for (let j = i + 1; j < items.length; j += 1) if (overlaps(items[i] as Box, items[j] as Box, pad)) return false;
    return true;
  };

  // The smallest ring that keeps everything apart, and apart enough for an arrow between neighbours.
  const biggest = Math.max(0, ...nodes.map((x) => Math.hypot(x.width, x.height) / 2));
  let R = Math.max(rd * 3, n > 1 ? biggest / Math.max(1, k * 0.7) : 0);
  let placed = arrange(R);
  for (let i = 0; i < 500 && n > 1 && !clean(placed); i += 1) {
    R *= 1.025;
    placed = arrange(R);
  }
  const Rmin = R;
  const extent = spread(placed);
  const halfW = Math.max(-extent.x, right(extent));
  const halfH = Math.max(-extent.y, bottom(extent));
  const title = env.input.structure.text.trim();
  // The title stands in the middle of the ring when the ring's own room holds it. A narrow ring has none there ("Water, always moving" did not fit between four nodes on a phone and was
  // left out): its title is then set large above the ring, the way the loop's is, and the ring has the room that is left (fb-044).
  const above = env.title();
  const middleSpec = (inner: number): TextSpec | null => {
    for (const size of ['l', 'm'] as const) {
      for (let sh = 1; sh >= env.input.look.minShrink; sh -= 0.15) {
        const spec = { ...env.spec, size, shrink: env.shrink * sh };
        const m = env.input.measure(title, spec, Math.max(1, inner * 1.5));
        if (inner > 0 && m.width <= inner * 1.7 && m.height <= inner * 1.5 && Math.hypot(m.width / 2, m.height / 2) <= inner) return spec;
      }
    }
    return null;
  };
  const innerAt = (ps: readonly Placed[], r: number, cx: number, cy: number): number => {
    let inner = r * Math.min(1, k);
    for (const p of ps) {
      const f = box(p.frame.x + cx, p.frame.y + cy, p.frame.width, p.frame.height);
      const nx = Math.max(f.x, Math.min(cx, right(f)));
      const ny = Math.max(f.y, Math.min(cy, bottom(f)));
      inner = Math.min(inner, Math.hypot(nx - cx, ny - cy));
    }
    return inner - gap;
  };
  const titleAbove = title !== '' && middleSpec(innerAt(placed, Rmin, 0, 0)) === null;

  const finish = (full: Box): ReturnType<Draft['finish']> => {
    const room = titleAbove ? box(full.x, full.y + above.h, full.width, Math.max(1, full.height - above.h)) : full;
    const cx = env.snap(room.x + room.width / 2, 'x');
    const cy = env.snap(room.y + room.height / 2, 'y');
    const fitsAt = (r: number): Placed[] | null => {
      const ps = arrange(r);
      const e = spread(ps);
      const at = box(cx + e.x, cy + e.y, e.width, e.height);
      return contains(room, at, 0.5) ? ps : null;
    };
    let R2 = Rmin;
    let ps = placed;
    for (let r = Rmin * 1.04; r <= Rmin * 2.2; r *= 1.04) {
      const t = fitsAt(r);
      if (!t) break;
      R2 = r;
      ps = t;
    }
    const boxes = new Map<string, Box>();
    const routes = new Map<string, Polyline>();
    const notes: Note[] = [];
    const fills: BlockPart[] = [];
    const frames: BlockPart[] = [];
    const words: BlockPart[] = [];
    const lines: BlockPart[] = [];
    const heads: BlockPart[] = [];
    const labels: BlockPart[] = [];
    const abs = (b: Box): Box => box(b.x + cx, b.y + cy, b.width, b.height);
    nodes.forEach((nd, i) => {
      const p = ps[i] as Placed;
      const f = abs(p.frame);
      if (!dots) {
        boxes.set(nd.el.key, f);
        nodeParts(env, nd, f, fills, frames, words);
      } else {
        const wb = abs(p.words as Box);
        const u = dir(i);
        const align: 'left' | 'right' | 'center' = Math.abs(u.x) < 0.3 ? 'center' : u.x > 0 ? 'left' : 'right';
        frames.push({ kind: 'shape', owner: nd.el.key, part: 'dot', outline: [circle(f.x + rd, f.y + rd, rd)], role: 'marker' });
        words.push({ kind: 'text', owner: nd.el.key, part: 'words', text: nd.text, emphasis: nd.emphasis, box: wb, spec: env.spec, align, role: 'words', plate: false });
        boxes.set(nd.el.key, union([f, wb]));
      }
    });

    // Arcs. One for every node, always: along the ring when there is room, else a short curved connector between the facing edges.
    const links = linkSpecs(env.input);
    const pair = (a: NodeBox, b: NodeBox): LinkSpec | null => links.find((l) => l.from === a.el.key && l.to === b.el.key) ?? null;
    const g2 = 0.35 * body;
    const inside = (i: number, pt: Point): boolean => {
      const f = ps[i]?.frame as Box;
      if (dots) return Math.hypot(pt.x - (f.x + rd + cx), pt.y - (f.y + rd + cy)) < rd + g2;
      return pt.x > f.x + cx - g2 && pt.x < right(f) + cx + g2 && pt.y > f.y + cy - g2 && pt.y < bottom(f) + cy + g2;
    };
    const at = (a: number): Point => ({ x: cx + k * R2 * Math.sin(a), y: cy - R2 * Math.cos(a) });
    const arcLines: Polyline[] = [];
    const todo: { nd: NodeBox; link: LinkSpec | null; pts: Point[] }[] = [];
    const facing = (i: number, j: number): Point[] => {
      const fi = abs((ps[i] as Placed).frame);
      const fj = abs((ps[j] as Placed).frame);
      const ci = { x: fi.x + fi.width / 2, y: fi.y + fi.height / 2 };
      const cj = { x: fj.x + fj.width / 2, y: fj.y + fj.height / 2 };
      const len = Math.hypot(cj.x - ci.x, cj.y - ci.y) || 1;
      const d = { x: (cj.x - ci.x) / len, y: (cj.y - ci.y) / len };
      const hi = dots ? { w: rd + g2, h: rd + g2 } : { w: fi.width / 2 + g2, h: fi.height / 2 + g2 };
      const hj = dots ? { w: rd + g2, h: rd + g2 } : { w: fj.width / 2 + g2, h: fj.height / 2 + g2 };
      const a = leave(ci, hi, d);
      const b = leave(cj, hj, { x: -d.x, y: -d.y });
      // bulge away from the middle of the ring, so that the connector reads as a piece of the ring
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const out = { x: m.x - cx, y: m.y - cy };
      const ol = Math.hypot(out.x, out.y) || 1;
      const bulge = Math.hypot(b.x - a.x, b.y - a.y) * 0.22;
      const ctl = { x: m.x + (out.x / ol) * bulge, y: m.y + (out.y / ol) * bulge };
      const pts: Point[] = [];
      for (let t = 0; t <= 1.0001; t += 0.125) pts.push({ x: (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * ctl.x + t * t * b.x, y: (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * ctl.y + t * t * b.y });
      return pts;
    };
    if (n > 1) {
      for (let i = 0; i < n; i += 1) {
        const j = (i + 1) % n;
        const a0 = phi(i);
        const a1 = i + 1 === n ? 2 * Math.PI : phi(j);
        const mid = (a0 + a1) / 2;
        let pts: Point[] | null = null;
        if (!inside(i, at(mid)) && !inside(j, at(mid))) {
          let lo = a0;
          let hi = mid;
          for (let q = 0; q < 24; q += 1) {
            const m = (lo + hi) / 2;
            if (inside(i, at(m))) lo = m;
            else hi = m;
          }
          const s0 = hi;
          lo = mid;
          hi = a1;
          for (let q = 0; q < 24; q += 1) {
            const m = (lo + hi) / 2;
            if (inside(j, at(m))) hi = m;
            else lo = m;
          }
          const e0 = lo;
          const sa = at(s0);
          const ea = at(e0);
          if (Math.hypot(ea.x - sa.x, ea.y - sa.y) >= env.headLength * 1.2) {
            const steps = Math.max(3, Math.ceil(((e0 - s0) * R2 * k) / 5));
            pts = [];
            for (let q = 0; q <= steps; q += 1) pts.push(at(s0 + ((e0 - s0) * q) / steps));
          }
        }
        if (pts === null) pts = facing(i, j);
        const link = pair(nodes[i] as NodeBox, nodes[j] as NodeBox);
        todo.push({ nd: nodes[i] as NodeBox, link, pts });
        arcLines.push({ points: pts, closed: false });
      }
    }
    const taken: Box[] = [...boxes.values()];
    for (const t of todo) {
      const spec: LinkSpec = t.link ?? { el: t.nd.el, from: t.nd.el.key, to: t.nd.el.key, ends: 'arrow', dashed: false, label: '' };
      const owner = t.link ? t.link.el.key : t.nd.el.key;
      connectorParts(env, spec, t.pts, lines, heads, owner);
      routes.set(owner, { points: t.pts, closed: false });
      if (t.link) boxes.set(owner, union(t.pts.map((p) => box(p.x, p.y, 0, 0))));
      if (t.link?.label) {
        const m = env.measure(t.link.label, env.wrapWidth, env.label());
        const runs = t.pts.slice(0, -1).map((q, i) => [q, t.pts[i + 1] as Point] as const);
        const mids = [...runs.slice(Math.floor(runs.length / 2)), ...runs.slice(0, Math.floor(runs.length / 2))];
        const pick = placeBeside(mids, m.width, m.height, env.stroke * 1.5 + 3, { boxes: taken, lines: arcLines }, null);
        if (pick) {
          taken.push(pick.box);
          labels.push(labelPart(env, owner, t.link.label, pick.box, m, pick.penalty > 0));
          if (pick.penalty > 0 && knockOut(lines, pick.box, env.stroke * 1.5, taken)) notes.push({ key: owner, note: 'crossed' });
          boxes.set(owner, union([boxes.get(owner) as Box, pick.box]));
        }
      }
    }

    // The title above the ring, or in the middle of it.
    if (titleAbove) {
      const tp = above.part(full);
      if (tp) labels.push(tp);
    } else if (title) {
      let inner = R2 * Math.min(1, k);
      for (const p of ps) {
        const f = abs(p.frame);
        const nx = Math.max(f.x, Math.min(cx, right(f)));
        const ny = Math.max(f.y, Math.min(cy, bottom(f)));
        inner = Math.min(inner, Math.hypot(nx - cx, ny - cy));
      }
      inner -= gap;
      let done = false;
      for (const size of ['l', 'm'] as const) {
        for (let sh = 1; sh >= env.input.look.minShrink && !done; sh -= 0.15) {
          const spec = { ...env.spec, size, shrink: env.shrink * sh };
          const m = env.input.measure(title, spec, Math.max(1, inner * 1.5));
          if (inner > 0 && m.width <= inner * 1.7 && m.height <= inner * 1.5 && Math.hypot(m.width / 2, m.height / 2) <= inner) {
            labels.push({ kind: 'text', owner: env.input.structure.key, part: 'title', text: title, emphasis: [], box: box(cx - m.width / 2, cy - m.height / 2, m.width, m.height), spec, align: 'center', role: 'title', plate: false });
            done = true;
          }
        }
        if (done) break;
      }
      // not in the middle and not above it either: it is the one thing left out, and said
      if (!done) notes.push({ key: env.input.structure.key, note: 'crowded' });
    }
    return { parts: [...fills, ...lines, ...heads, ...frames, ...words, ...labels], boxes, routes, notes };
  };
  return { width: 2 * halfW, height: 2 * halfH + (titleAbove ? above.h : 0), finish };
}

/** A narrow room: nodes in a column of one width, an arrow down each gap, and one line up the right side that closes the loop. */
function buildLoop(env: Env): Draft {
  const body = env.body;
  const nodes = env.input.nodes.map((el) => sizeNode(env, el));
  const n = nodes.length;
  const width = Math.max(...nodes.map((x) => x.width));
  const gapV = env.up(Math.max(2 * body * env.tight, env.headLength * 2.6), 'y');
  const lane = env.up(Math.max(1.1 * body, env.headLength * 2), 'x');
  const title = env.title();
  const column = nodes.reduce((sum, x) => sum + x.height, 0) + (n - 1) * gapV;
  const finish = (room: Box): ReturnType<Draft['finish']> => {
    const total = width + lane;
    const x0 = env.within(room.x + (room.width - total) / 2, room.x, room.x + Math.max(0, room.width - total), 'x');
    let y = env.after(room.y + title.h + Math.max(0, (room.height - title.h - column) / 2), 'y');
    const boxes = new Map<string, Box>();
    const routes = new Map<string, Polyline>();
    const notes: Note[] = [];
    const fills: BlockPart[] = [];
    const frames: BlockPart[] = [];
    const words: BlockPart[] = [];
    const lines: BlockPart[] = [];
    const heads: BlockPart[] = [];
    const labels: BlockPart[] = [];
    const placed: Box[] = [];
    for (const nd of nodes) {
      const at = box(x0, y, width, nd.height);
      nd.width = width;
      placed.push(at);
      boxes.set(nd.el.key, at);
      nodeParts(env, nd, at, fills, frames, words);
      y += nd.height + gapV;
    }
    const links = linkSpecs(env.input);
    const pair = (a: NodeBox, b: NodeBox): LinkSpec | null => links.find((l) => l.from === a.el.key && l.to === b.el.key) ?? null;
    const taken: Box[] = [...placed];
    const all: Polyline[] = [];
    const todo: { nd: NodeBox; link: LinkSpec | null; pts: Point[] }[] = [];
    const midX = x0 + width / 2;
    for (let i = 0; i < n; i += 1) {
      const a = placed[i] as Box;
      const j = (i + 1) % n;
      const b = placed[j] as Box;
      const pts: Point[] =
        i + 1 < n
          ? [{ x: midX, y: bottom(a) }, { x: midX, y: b.y }]
          : [{ x: right(a), y: a.y + a.height / 2 }, { x: right(a) + lane * 0.7, y: a.y + a.height / 2 }, { x: right(a) + lane * 0.7, y: b.y + b.height / 2 }, { x: right(b), y: b.y + b.height / 2 }];
      todo.push({ nd: nodes[i] as NodeBox, link: pair(nodes[i] as NodeBox, nodes[j] as NodeBox), pts });
      all.push({ points: pts, closed: false });
    }
    for (const t of todo) {
      const spec: LinkSpec = t.link ?? { el: t.nd.el, from: t.nd.el.key, to: t.nd.el.key, ends: 'arrow', dashed: false, label: '' };
      const owner = t.link ? t.link.el.key : t.nd.el.key;
      connectorParts(env, spec, t.pts, lines, heads, owner);
      routes.set(owner, { points: t.pts, closed: false });
      if (t.link) boxes.set(owner, union(t.pts.map((p) => box(p.x, p.y, 0, 0))));
      if (t.link?.label) {
        const m = env.measure(t.link.label, env.wrapWidth, env.label());
        const runs = t.pts.slice(0, -1).map((q, i) => [q, t.pts[i + 1] as Point] as const);
        const pick = placeBeside(runs, m.width, m.height, env.stroke * 1.5 + 3, { boxes: taken, lines: all }, null);
        if (pick) {
          taken.push(pick.box);
          labels.push(labelPart(env, owner, t.link.label, pick.box, m, pick.penalty > 0));
          if (pick.penalty > 0 && knockOut(lines, pick.box, env.stroke * 1.5, taken)) notes.push({ key: owner, note: 'crossed' });
          boxes.set(owner, union([boxes.get(owner) as Box, pick.box]));
        }
      }
    }
    const tp = title.part(room);
    return { parts: [...(tp ? [tp] : []), ...fills, ...lines, ...heads, ...frames, ...words, ...labels], boxes, routes, notes };
  };
  return { width: width + lane, height: column + title.h, finish };
}
