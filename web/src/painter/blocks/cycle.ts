// Cycle: nodes evenly round a circle from twelve o'clock, clockwise; arcs that
// follow the circle close it. Up to five nodes carry their words inside; more
// become dots with their words outside, each on its own radius.

import type { Point, Polyline } from '@conduit/language';
import type { BlockPart, StructureInput, StructureLayout } from '../../contracts/blocks';
import type { Box } from '../../contracts/space';
import { box, circle, contains, inflate, overlaps, right, bottom, union } from './geom';
import type { Draft, LinkSpec, NodeBox, Note } from './kit';
import { connectorParts, Env, fit, labelPart, linkSpecs, nodeParts, sizeNode, firstClear } from './kit';

interface Placed {
  frame: Box;
  words: Box | null;
}

export function layoutCycle(input: StructureInput): StructureLayout {
  return fit(input, input.look.stroke, (env) => buildCycle(env));
}

function buildCycle(env: Env): Draft {
  const n = env.input.nodes.length;
  const body = env.body;
  const dots = n > 5;
  const nodes = env.input.nodes.map((el) => sizeNode(env, el));
  const rd = Math.max(4, env.stroke * 1.6);
  const gap = 0.5 * body * env.tight;
  const phi = (i: number): number => (2 * Math.PI * i) / Math.max(1, n);
  const dir = (i: number): Point => ({ x: Math.sin(phi(i)), y: -Math.cos(phi(i)) });

  /** frames (and words) round a centre at the origin */
  const arrange = (R: number): Placed[] =>
    nodes.map((nd, i) => {
      const u = dir(i);
      const p = { x: R * u.x, y: R * u.y };
      if (!dots) return { frame: box(p.x - nd.width / 2, p.y - nd.height / 2, nd.width, nd.height), words: null };
      const frame = box(p.x - rd, p.y - rd, 2 * rd, 2 * rd);
      const w = nd.m.width;
      const h = nd.m.height;
      const side = Math.abs(u.x) < 0.3 ? (u.y < 0 ? 'top' : 'bottom') : u.x > 0 ? 'right' : 'left';
      for (let s = rd + gap * 0.5; s < rd + gap * 0.5 + 400; s += 2) {
        const q = { x: (R + s) * u.x, y: (R + s) * u.y };
        const b =
          side === 'top' ? box(q.x - w / 2, q.y - h, w, h) : side === 'bottom' ? box(q.x - w / 2, q.y, w, h) : side === 'right' ? box(q.x, q.y - h / 2, w, h) : box(q.x - w, q.y - h / 2, w, h);
        const nx = Math.max(b.x, Math.min(0, right(b)));
        const ny = Math.max(b.y, Math.min(0, bottom(b)));
        if (Math.hypot(nx, ny) >= R + rd + gap * 0.5) return { frame, words: b };
      }
      return { frame, words: box(p.x, p.y, w, h) };
    });
  const spread = (ps: Placed[]): Box => union(ps.flatMap((p) => (p.words ? [p.frame, p.words] : [p.frame])));
  const clean = (ps: Placed[]): boolean => {
    const items = ps.map((p) => (p.words ? union([p.frame, p.words]) : p.frame));
    const pad = dots ? gap * 0.5 : gap;
    for (let i = 0; i < items.length; i += 1) for (let j = i + 1; j < items.length; j += 1) if (overlaps(items[i] as Box, items[j] as Box, pad)) return false;
    return true;
  };

  // The smallest ring that keeps everything apart.
  const biggest = Math.max(0, ...nodes.map((x) => Math.hypot(x.width, x.height) / 2));
  let R = Math.max(rd * 3, n > 1 ? biggest : 0);
  let placed = arrange(R);
  for (let i = 0; i < 400 && n > 1 && !clean(placed); i += 1) {
    R *= 1.025;
    placed = arrange(R);
  }
  const Rmin = R;
  const extent = spread(placed);
  const halfW = Math.max(-extent.x, right(extent));
  const halfH = Math.max(-extent.y, bottom(extent));

  const finish = (room: Box): ReturnType<Draft['finish']> => {
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
        const side = wb.x + wb.width / 2 > cx + 1 && Math.abs(wb.x + wb.width / 2 - (f.x + f.width / 2)) > wb.width / 2 - 1 ? 'x' : 'y';
        void side;
        const u = dir(i);
        const align: 'left' | 'right' | 'center' = Math.abs(u.x) < 0.3 ? 'center' : u.x > 0 ? 'left' : 'right';
        frames.push({ kind: 'shape', owner: nd.el.key, part: 'dot', outline: [circle(f.x + rd, f.y + rd, rd)], role: 'marker' });
        words.push({ kind: 'text', owner: nd.el.key, part: 'words', text: nd.text, emphasis: nd.emphasis, box: wb, spec: env.spec, align, role: 'words', plate: false });
        boxes.set(nd.el.key, union([f, wb]));
      }
    });

    // Arcs.
    const links = linkSpecs(env.input);
    const pair = (a: NodeBox, b: NodeBox): LinkSpec | null => links.find((l) => l.from === a.el.key && l.to === b.el.key) ?? null;
    const small = env.small();
    const g2 = 0.35 * body;
    const inside = (i: number, pt: Point): boolean => {
      const f = ps[i]?.frame as Box;
      if (dots) return Math.hypot(pt.x - (f.x + rd + cx), pt.y - (f.y + rd + cy)) < rd + g2;
      return pt.x > f.x + cx - g2 && pt.x < right(f) + cx + g2 && pt.y > f.y + cy - g2 && pt.y < bottom(f) + cy + g2;
    };
    const at = (a: number): Point => ({ x: cx + R2 * Math.sin(a), y: cy - R2 * Math.cos(a) });
    const arcLines: Polyline[] = [];
    const todo: { nd: NodeBox; link: LinkSpec | null; pts: Point[] }[] = [];
    if (n > 1) {
      for (let i = 0; i < n; i += 1) {
        const j = (i + 1) % n;
        const a0 = phi(i);
        const a1 = i + 1 === n ? 2 * Math.PI : phi(j);
        const mid = (a0 + a1) / 2;
        if (inside(i, at(mid)) || inside(j, at(mid))) {
          notes.push({ key: (nodes[i] as NodeBox).el.key, note: 'crowded' });
          continue;
        }
        let lo = a0;
        let hi = mid;
        for (let k = 0; k < 24; k += 1) {
          const m = (lo + hi) / 2;
          if (inside(i, at(m))) lo = m;
          else hi = m;
        }
        const s = hi;
        lo = mid;
        hi = a1;
        for (let k = 0; k < 24; k += 1) {
          const m = (lo + hi) / 2;
          if (inside(j, at(m))) hi = m;
          else lo = m;
        }
        const e = lo;
        if (e - s < (env.headLength * 1.2) / R2) {
          notes.push({ key: (nodes[i] as NodeBox).el.key, note: 'crowded' });
          continue;
        }
        const steps = Math.max(3, Math.ceil(((e - s) * R2) / 5));
        const pts: Point[] = [];
        for (let k = 0; k <= steps; k += 1) pts.push(at(s + ((e - s) * k) / steps));
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
        const m = env.measure(t.link.label, env.wrapWidth, small);
        const c = t.pts[Math.floor(t.pts.length / 2)] as Point;
        const own = routes.get(owner) as Polyline;
        const pick = firstClear([box(c.x - m.width / 2, c.y - m.height / 2, m.width, m.height)], { boxes: taken.filter((b) => !overlaps(b, box(c.x, c.y, 0.1, 0.1))), lines: arcLines }, own, null);
        if (pick) {
          taken.push(pick.box);
          labels.push(labelPart(env, owner, t.link.label, pick.box, m, true));
          if (pick.penalty > 0) notes.push({ key: owner, note: 'crossed' });
        }
      }
    }

    // The title in the middle of the ring.
    const title = env.input.structure.text.trim();
    if (title) {
      let inner = R2;
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
      if (!done) notes.push({ key: env.input.structure.key, note: 'crowded' });
    }
    return { parts: [...fills, ...lines, ...heads, ...frames, ...words, ...labels], boxes, routes, notes };
  };
  void inflate;
  return { width: 2 * halfW, height: 2 * halfH, finish };
}
