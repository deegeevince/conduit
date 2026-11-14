// Flow: a layered layout. Ranks by longest path (back edges reversed first),
// order by the barycentre of what is already placed (a single downward sweep,
// so a late part never reshuffles an early rank), cross positions by least
// squares under a minimum separation, connectors orthogonal in the gaps
// between ranks and through reserved columns where they skip a rank.

import type { Point, Polyline } from '@conduit/language';
import type { BlockPart, StructureInput, StructureLayout } from '../../contracts/blocks';
import type { Box } from '../../contracts/space';
import { box, boxOfPoints, packOrdered, simplify, union } from './geom';
import type { Draft, LinkSpec, NodeBox, Note } from './kit';
import { connectorParts, Env, firstClear, fit, labelPart, linkSpecs, nodeParts, sizeNode } from './kit';

type Grow = 'right' | 'down';

interface V {
  readonly id: number;
  readonly real: NodeBox | null;
  readonly index: number;
  rank: number;
  /** extent along the growing axis, and across it */
  a: number;
  readonly c: number;
  /** centre across */
  pos: number;
  /** centre along (after the ranks are placed) */
  at: number;
}

interface Seg {
  readonly edge: number;
  readonly u: V;
  readonly v: V;
  out: number;
  inn: number;
  lane: number;
  first: boolean;
}

interface Edge {
  readonly spec: LinkSpec;
  readonly reversed: boolean;
  chain: V[];
  segs: Seg[];
}

export function layoutFlow(input: StructureInput): StructureLayout {
  const f = input.structure.figure;
  const forced = f?.kind === 'structure' ? f.grow : null;
  const preferred: Grow = forced ?? (input.room.width >= input.room.height ? 'right' : 'down');
  const first = fit(input, input.look.stroke, (env) => buildFlow(env, preferred));
  if (forced) {
    if (!first.notes.some((n) => n.note === 'crowded')) return first;
    const folded = foldChain(input);
    return folded !== null && !folded.notes.some((n) => n.note === 'crowded') ? folded : first;
  }
  if (first.shrink === 1 && !first.notes.some((n) => n.note === 'crowded')) return first;
  const other: Grow = preferred === 'right' ? 'down' : 'right';
  const second = fit(input, input.look.stroke, (env) => buildFlow(env, other));
  const crowded = (l: StructureLayout): boolean => l.notes.some((n) => n.note === 'crowded');
  if (crowded(first) && !crowded(second)) return second;
  if (!crowded(first) && !crowded(second) && second.shrink > first.shrink * 1.15) return second;
  const best = crowded(first) && crowded(second) ? (second.shrink > first.shrink ? second : first) : first;
  // A long chain that fits neither way is set like text: in rows, each row left to right, the end of one joined to the start of the next.
  if (crowded(best)) {
    const folded = foldChain(input);
    if (folded !== null && !crowded(folded)) return folded;
  }
  return best;
}

/** The nodes in the order of a single path through every one of them, when the links are exactly that. */
function chainOrder(input: StructureInput, links: readonly LinkSpec[]): string[] | null {
  const n = input.nodes.length;
  if (n < 4 || links.length !== n - 1) return null;
  const next = new Map<string, LinkSpec>();
  const hasIn = new Set<string>();
  for (const l of links) {
    if (next.has(l.from) || hasIn.has(l.to)) return null;
    next.set(l.from, l);
    hasIn.add(l.to);
  }
  const head = input.nodes.find((el) => !hasIn.has(el.key));
  if (head === undefined) return null;
  const order: string[] = [head.key];
  for (let at = next.get(head.key); at !== undefined; at = next.get(at.to)) {
    if (order.includes(at.to)) return null;
    order.push(at.to);
  }
  return order.length === n ? order : null;
}

/** Rows of a chain: the fewest, then the largest type, in which every row fits. Null when the structure is not a chain. */
/** a folded chain may be set smaller than a single row may: more of it is on the page, and rows keep it readable */
const FOLD_MIN_SHRINK = 0.5;
let folding = false;
function foldChain(input: StructureInput): StructureLayout | null {
  if (folding) return null;
  const f = input.structure.figure;
  if (f?.kind !== 'structure') return null;
  const links = linkSpecs(input);
  const order = chainOrder(input, links);
  if (order === null) return null;
  const byKey = new Map(input.nodes.map((el) => [el.key, el]));
  const linkBetween = (a: string): LinkSpec => links.find((l) => l.from === a) as LinkSpec;
  const base = new Env(input, 1, 1, input.look.stroke);
  const title = base.title();
  const gap = Math.max(base.body * 0.9, 16);
  let best: { layout: StructureLayout; score: number } | null = null;
  for (let rows = 2; rows <= Math.min(order.length, 8); rows += 1) {
    const per = Math.ceil(order.length / rows);
    const groups: string[][] = [];
    for (let i = 0; i < order.length; i += per) groups.push(order.slice(i, i + per));
    if (groups.length < rows) continue;
    const bandH = (input.room.height - title.h - (groups.length - 1) * gap) / groups.length;
    if (bandH < base.body * 0.7) break;
    const bands: StructureLayout[] = [];
    folding = true;
    try {
    groups.forEach((group, i) => {
      const keys = new Set(group);
      const inside = links.filter((l) => keys.has(l.from) && keys.has(l.to)).map((l) => l.el);
      const room: Box = { x: input.room.x, y: input.room.y + title.h + i * (bandH + gap), width: input.room.width, height: bandH };
      const structure = { ...input.structure, text: '', figure: { ...f, grow: 'right' as const } };
      bands.push(layoutFlow({ ...input, look: { ...input.look, minShrink: Math.min(input.look.minShrink, FOLD_MIN_SHRINK) }, structure, nodes: group.map((k) => byKey.get(k) as (typeof input.nodes)[number]), links: inside, room }));
    });
    } finally {
      folding = false;
    }
    const worst = Math.min(...bands.map((b) => (b.notes.some((n) => n.note === 'crowded') ? 0 : b.shrink)));
    if (best === null || worst > best.score + 1e-9) {
      const shrink = Math.max(0.3, worst);
      const env = new Env(input, shrink, 1, input.look.stroke);
      const boxes = new Map<string, Box>();
      const routes = new Map<string, Polyline>();
      const notes: Note[] = [];
      const parts: BlockPart[] = [];
      const lines: BlockPart[] = [];
      const heads: BlockPart[] = [];
      const labels: BlockPart[] = [];
      const tp = title.part(input.room);
      if (tp !== null) parts.push(tp);
      for (const band of bands) {
        parts.push(...band.parts);
        for (const [k, v] of band.boxes) if (k !== input.structure.key) boxes.set(k, v);
        for (const [k, v] of band.routes) routes.set(k, v);
        notes.push(...band.notes.filter((n) => n.note !== 'crowded'));
      }
      // the bridge from the last node of a row to the first of the next: down through the gap, along it, down again
      for (let i = 0; i + 1 < groups.length; i += 1) {
        const from = boxes.get((groups[i] as string[])[(groups[i] as string[]).length - 1] as string);
        const to = boxes.get((groups[i + 1] as string[])[0] as string);
        if (from === undefined || to === undefined) continue;
        const link = linkBetween((groups[i] as string[])[(groups[i] as string[]).length - 1] as string);
        const mid = (from.y + from.height + to.y) / 2;
        const pts = [
          { x: from.x + from.width / 2, y: from.y + from.height },
          { x: from.x + from.width / 2, y: mid },
          { x: to.x + to.width / 2, y: mid },
          { x: to.x + to.width / 2, y: to.y },
        ];
        connectorParts(env, link, pts, lines, heads);
        routes.set(link.el.key, { points: pts, closed: false });
        let area = boxOfPoints(pts);
        if (link.label !== '') {
          const m = env.measure(link.label, env.wrapWidth, env.small());
          const at = box((pts[1] as Point).x / 2 + (pts[2] as Point).x / 2 - m.width / 2, mid - m.height / 2, m.width, m.height);
          labels.push(labelPart(env, link.el.key, link.label, at, m, true));
          area = union([area, at]);
        }
        boxes.set(link.el.key, area);
      }
      parts.push(...lines, ...heads, ...labels);
      boxes.set(input.structure.key, union([...boxes.values()]));
      notes.push({ key: input.structure.key, note: worst >= 1 ? 'crowded' : 'shrunk' });
      if (worst >= 1) notes.pop();
      best = { layout: { boxes, parts, routes, notes: worst > 0 ? notes : [...notes, { key: input.structure.key, note: 'crowded' }], shrink }, score: worst };
      if (worst >= 1) break;
    }
  }
  return best === null || best.score <= 0 ? null : best.layout;
}

function buildFlow(env: Env, grow: Grow): Draft {
  const input = env.input;
  const body = env.body;
  const tight = env.tight;
  const down = grow === 'down';
  const nodes = input.nodes.map((el) => sizeNode(env, el));
  const aOf = (n: NodeBox): number => (down ? n.height : n.width);
  const cOf = (n: NodeBox): number => (down ? n.width : n.height);
  const index = new Map(nodes.map((n, i) => [n.el.key, i]));
  const links = linkSpecs(env.input);

  // Back edges: found by a depth-first walk in the order written.
  const out: number[][] = nodes.map(() => []);
  links.forEach((l, i) => out[index.get(l.from) as number]?.push(i));
  const state = nodes.map(() => 0);
  const reversed = new Set<number>();
  const walk = (u: number): void => {
    state[u] = 1;
    for (const e of out[u] ?? []) {
      const v = index.get((links[e] as LinkSpec).to) as number;
      if (state[v] === 1) reversed.add(e);
      else if (state[v] === 0) walk(v);
    }
    state[u] = 2;
  };
  nodes.forEach((_, i) => {
    if (state[i] === 0) walk(i);
  });
  const ends = links.map((l, i) => {
    const a = index.get(l.from) as number;
    const b = index.get(l.to) as number;
    return reversed.has(i) ? { u: b, v: a } : { u: a, v: b };
  });

  // Ranks by longest path.
  const rank = nodes.map(() => 0);
  const indeg = nodes.map(() => 0);
  const succ: number[][] = nodes.map(() => []);
  ends.forEach((e, i) => {
    succ[e.u]?.push(i);
    indeg[e.v] = (indeg[e.v] ?? 0) + 1;
  });
  const queue: number[] = [];
  nodes.forEach((_, i) => {
    if (indeg[i] === 0) queue.push(i);
  });
  for (let h = 0; h < queue.length; h += 1) {
    const u = queue[h] as number;
    for (const e of succ[u] ?? []) {
      const v = (ends[e] as { v: number }).v;
      rank[v] = Math.max(rank[v] as number, (rank[u] as number) + 1);
      indeg[v] = (indeg[v] as number) - 1;
      if (indeg[v] === 0) queue.push(v);
    }
  }
  const rankCount = Math.max(0, ...rank) + 1;

  // Ranks share a thickness along the growing axis.
  const thick = new Array<number>(rankCount).fill(0);
  nodes.forEach((n, i) => {
    thick[rank[i] as number] = Math.max(thick[rank[i] as number] as number, aOf(n));
  });

  // Vertices: the nodes, then a placeholder for every rank a connector skips.
  const lane = Math.max(env.stroke * 3, 0.5 * body * tight);
  const vs: V[] = nodes.map((n, i) => ({ id: i, real: n, index: i, rank: rank[i] as number, a: thick[rank[i] as number] as number, c: cOf(n), pos: 0, at: 0 }));
  const layers: V[][] = Array.from({ length: rankCount }, () => []);
  vs.forEach((v) => layers[v.rank]?.push(v));
  const edges: Edge[] = links.map((spec, i) => {
    const e = ends[i] as { u: number; v: number };
    const chain: V[] = [vs[e.u] as V];
    for (let r = (rank[e.u] as number) + 1; r < (rank[e.v] as number); r += 1) {
      const d: V = { id: vs.length, real: null, index: nodes.length + vs.length, rank: r, a: 0, c: lane, pos: 0, at: 0 };
      vs.push(d);
      layers[r]?.push(d);
      chain.push(d);
    }
    chain.push(vs[e.v] as V);
    return { spec, reversed: reversed.has(i), chain, segs: [] };
  });
  const preds = new Map<V, V[]>();
  edges.forEach((e, ei) => {
    for (let k = 0; k + 1 < e.chain.length; k += 1) {
      const u = e.chain[k] as V;
      const v = e.chain[k + 1] as V;
      e.segs.push({ edge: ei, u, v, out: 0, inn: 0, lane: -1, first: k === 0 });
      const list = preds.get(v) ?? [];
      list.push(u);
      preds.set(v, list);
    }
  });

  // One downward sweep: order by the barycentre of what is placed, then pack.
  const gapC = (a: V, b: V): number => env.up(a.real && b.real ? 0.9 * body * tight : 0.45 * body * tight, down ? 'x' : 'y') + (a.c + b.c) / 2;
  layers.forEach((layer, r) => {
    if (r === 0) {
      layer.sort((x, y) => x.index - y.index);
    } else {
      const want = new Map<V, number>();
      for (const v of layer) {
        const p = preds.get(v) ?? [];
        want.set(v, p.length ? p.reduce((s, q) => s + q.pos, 0) / p.length : 0);
      }
      layer.sort((x, y) => (want.get(x) as number) - (want.get(y) as number) || x.index - y.index);
      const prevOrder = new Map<V, number>(layers[r - 1]?.map((v, i) => [v, i]));
      const cross = (a: V, b: V): number => {
        let n = 0;
        for (const pa of preds.get(a) ?? []) for (const pb of preds.get(b) ?? []) if ((prevOrder.get(pa) as number) > (prevOrder.get(pb) as number)) n += 1;
        return n;
      };
      for (let pass = 0; pass < 4; pass += 1) {
        let moved = false;
        for (let i = 0; i + 1 < layer.length; i += 1) {
          const a = layer[i] as V;
          const b = layer[i + 1] as V;
          if (cross(a, b) > cross(b, a)) {
            layer[i] = b;
            layer[i + 1] = a;
            moved = true;
          }
        }
        if (!moved) break;
      }
      layer.forEach((v) => {
        const p = preds.get(v) ?? [];
        want.set(v, p.length ? p.reduce((s, q) => s + q.pos, 0) / p.length : 0);
      });
      const desired = layer.map((v) => want.get(v) as number);
      const min = layer.slice(1).map((v, i) => gapC(layer[i] as V, v));
      const pos = packOrdered(desired, min, layer.map((v) => (v.real ? 1 : 3)));
      layer.forEach((v, i) => {
        v.pos = v.real ? env.centre(pos[i] as number, v.c, down ? 'x' : 'y') : (pos[i] as number);
      });
      return;
    }
    const min = layer.slice(1).map((v, i) => gapC(layer[i] as V, v));
    const pos = packOrdered(layer.map(() => 0), min, layer.map(() => 1));
    layer.forEach((v, i) => {
      v.pos = v.real ? env.centre(pos[i] as number, v.c, down ? 'x' : 'y') : (pos[i] as number);
    });
  });

  // Ports: connectors leaving or entering a side share it evenly, in the order of what they reach.
  const outs = new Map<V, Seg[]>();
  const ins = new Map<V, Seg[]>();
  for (const e of edges)
    for (const s of e.segs) {
      outs.set(s.u, [...(outs.get(s.u) ?? []), s]);
      ins.set(s.v, [...(ins.get(s.v) ?? []), s]);
    }
  const portAt = (v: V, k: number, n: number): number => (v.real ? v.pos - v.c / 2 + ((k + 1) / (n + 1)) * v.c : v.pos);
  for (const [v, list] of outs) {
    list.sort((x, y) => x.v.pos - y.v.pos || x.edge - y.edge);
    list.forEach((s, k) => (s.out = portAt(v, k, list.length)));
  }
  for (const [v, list] of ins) {
    list.sort((x, y) => x.u.pos - y.u.pos || x.edge - y.edge);
    list.forEach((s, k) => (s.inn = portAt(v, k, list.length)));
  }

  // The gaps between ranks: lanes for the runs across, and room for a label on the first stretch.
  const small = env.small();
  const labelM = edges.map((e) => (e.spec.label ? env.measure(e.spec.label, env.wrapWidth, small) : null));
  const labelA = (m: { width: number; height: number } | null): number => (m ? (down ? m.height : m.width) : 0);
  const head = env.headLength;
  const tail = head * 1.6 + 0.2 * body;
  const gapOf: number[] = [];
  const reserve: number[] = [];
  const laneStep = Math.max(env.stroke * 2.5, 0.55 * body * tight);
  const laneCount: number[] = [];
  for (let r = 0; r + 1 < rankCount; r += 1) {
    const segs = edges.flatMap((e) => e.segs).filter((s) => s.u.rank === r);
    let r0 = 0.5 * body * tight;
    for (const s of segs) if (s.first) r0 = Math.max(r0, labelA(labelM[s.edge] ?? null) + 0.5 * body);
    const runs = segs.filter((s) => Math.abs(s.out - s.inn) > 0.5).sort((x, y) => Math.min(x.out, x.inn) - Math.min(y.out, y.inn) || x.edge - y.edge);
    const laneEnd: number[] = [];
    for (const s of runs) {
      const lo = Math.min(s.out, s.inn) - env.stroke * 2;
      const hi = Math.max(s.out, s.inn) + env.stroke * 2;
      let k = laneEnd.findIndex((end) => end < lo);
      if (k < 0) {
        k = laneEnd.length;
        laneEnd.push(hi);
      } else laneEnd[k] = hi;
      s.lane = k;
    }
    const K = laneEnd.length;
    const labelled = segs.some((s) => (labelM[s.edge] ?? null) !== null);
    const need = K > 0 ? r0 + (K - 1) * laneStep + tail : Math.max(head * 2.2, labelled ? r0 + head : 0);
    gapOf.push(env.up(Math.max(2.4 * body * tight, need), down ? 'y' : 'x'));
    reserve.push(r0);
    laneCount.push(K);
  }

  // Along the growing axis.
  const start: number[] = [];
  let cursor = 0;
  for (let r = 0; r < rankCount; r += 1) {
    start.push(cursor);
    cursor += (thick[r] as number) + (gapOf[r] ?? 0);
  }
  const total = rankCount > 0 ? cursor - (gapOf[rankCount - 1] ?? 0) : 0;
  for (const v of vs) {
    v.at = (start[v.rank] as number) + (thick[v.rank] as number) / 2;
    v.a = thick[v.rank] as number;
  }
  let cMin = Infinity;
  let cMax = -Infinity;
  for (const v of vs) {
    cMin = Math.min(cMin, v.pos - v.c / 2);
    cMax = Math.max(cMax, v.pos + v.c / 2);
  }
  if (!(cMin <= cMax)) {
    cMin = 0;
    cMax = 0;
  }
  const crossExtent = cMax - cMin;
  const title = env.title();
  const T = (a: number, c: number): Point => (down ? { x: c, y: a } : { x: a, y: c });

  const finish = (room: Box): ReturnType<Draft['finish']> => {
    // The first node of the first rank is the anchor: it sits at the middle of the room across, and the rest
    // follows, moved only as far as keeping everything inside needs. Nothing shifts when a part is appended.
    const lo = down ? room.x : room.y + title.h;
    const hi = down ? room.x + room.width : room.y + room.height;
    const anchor = (layers[0]?.[0] ?? vs[0])?.pos ?? 0;
    let dc0 = (lo + hi) / 2 - anchor;
    const fitsAcross = cMax - cMin <= hi - lo;
    if (fitsAcross) dc0 = Math.max(lo - cMin, Math.min(hi - cMax, dc0));
    else dc0 = (lo + hi) / 2 - (cMin + cMax) / 2;
    const dc = fitsAcross ? env.within(dc0, lo - cMin, hi - cMax, down ? 'x' : 'y') : env.snap(dc0, down ? 'x' : 'y');
    const da = env.after(down ? room.y + title.h : room.x, down ? 'y' : 'x');
    const P = (a: number, c: number): Point => T(a + da, c + dc);
    const boxes = new Map<string, Box>();
    const routes = new Map<string, Polyline>();
    const notes: Note[] = [];
    const fills: BlockPart[] = [];
    const frames: BlockPart[] = [];
    const words: BlockPart[] = [];
    const lines: BlockPart[] = [];
    const heads: BlockPart[] = [];
    const labels: BlockPart[] = [];

    const nodeBoxes: Box[] = [];
    for (const v of vs) {
      if (!v.real) continue;
      const n = v.real;
      const top = P(v.at - v.a / 2, v.pos - v.c / 2);
      const w = down ? v.c : v.a;
      const h = down ? v.a : v.c;
      const at = box(top.x, top.y, w, h);
      n.width = w;
      n.height = h;
      boxes.set(n.el.key, at);
      nodeBoxes.push(at);
      nodeParts(env, n, at, fills, frames, words);
    }

    // Routes, in the layered direction, then turned to run from the node the link leaves.
    const placed: { edge: Edge; pts: Point[]; zone: Point | null; stemEnd: number }[] = [];
    edges.forEach((e) => {
      const pts: Point[] = [];
      let zone: Point | null = null;
      let stemEnd = 0;
      e.segs.forEach((s, k) => {
        const aOut = (start[s.u.rank] as number) + (thick[s.u.rank] as number);
        const aIn = start[s.v.rank] as number;
        const r = s.u.rank;
        if (k === 0) pts.push(P(aOut, s.out));
        else pts.push(P(aOut, s.out));
        if (s.lane >= 0) {
          const ly = aOut + (reserve[r] as number) + s.lane * laneStep;
          const lyS = env.snap(down ? ly + da : ly + da, down ? 'y' : 'x') - da;
          pts.push(P(lyS, s.out), P(lyS, s.inn));
          if (k === 0) {
            zone = P(aOut + (reserve[r] as number) / 2, s.out);
            stemEnd = lyS - aOut;
          }
        } else if (k === 0) {
          zone = P(aOut + Math.min((aIn - aOut) / 2, (reserve[r] as number) / 2 + 0), s.out);
          stemEnd = aIn - aOut;
        }
        pts.push(P(aIn, s.inn));
      });
      let line = simplify(pts);
      if (e.reversed) line = line.reverse();
      routes.set(e.spec.el.key, { points: line, closed: false });
      placed.push({ edge: e, pts: line, zone, stemEnd });
    });
    for (const p of placed) connectorParts(env, p.edge.spec, p.pts, lines, heads);

    // Labels: on the first stretch of the connector, on a plate; else the first clear place along it.
    const taken: Box[] = [];
    const allLines = [...routes.values()];
    for (const p of placed) {
      const m = labelM[edges.indexOf(p.edge)] ?? null;
      if (!m) continue;
      const own = routes.get(p.edge.spec.el.key) as Polyline;
      const w = m.width;
      const h = m.height;
      const at = (c: Point): Box => box(c.x - w / 2, c.y - h / 2, w, h);
      const on: Box[] = [];
      if (p.zone) on.push(at(p.zone));
      const pts = p.pts;
      for (let i = 0; i + 1 < pts.length; i += 1) {
        const a = pts[i] as Point;
        const b = pts[i + 1] as Point;
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len >= (down ? h : w) + env.headLength) on.push(at({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }));
      }
      const blockers = { boxes: [...nodeBoxes, ...taken], lines: allLines };
      let pick = firstClear(on, blockers, own, null);
      if (!pick || pick.penalty > 0) {
        const z = p.zone ?? (pts[0] as Point);
        const off = (down ? w : h) / 2 + env.stroke * 2 + 2;
        const beside = [at({ x: z.x + (down ? off : 0), y: z.y + (down ? 0 : off) }), at({ x: z.x - (down ? off : 0), y: z.y - (down ? 0 : off) })];
        const alt = firstClear(beside, blockers, null, null);
        if (alt && (!pick || alt.penalty < pick.penalty)) pick = { box: alt.box, penalty: alt.penalty };
      }
      if (!pick) continue;
      if (pick.penalty > 0) notes.push({ key: p.edge.spec.el.key, note: 'crossed' });
      taken.push(pick.box);
      labels.push(labelPart(env, p.edge.spec.el.key, p.edge.spec.label, pick.box, m, true));
      const lb = boxes.get(p.edge.spec.el.key);
      boxes.set(p.edge.spec.el.key, lb ? union([lb, pick.box]) : pick.box);
    }
    for (const p of placed) {
      const key = p.edge.spec.el.key;
      const lb = boxes.get(key);
      const rb = boxOfPoints(p.pts);
      boxes.set(key, lb ? union([lb, rb]) : rb);
    }
    const tp = title.part(room);
    return { parts: [...(tp ? [tp] : []), ...fills, ...lines, ...heads, ...frames, ...words, ...labels], boxes, routes, notes };
  };

  return { width: down ? crossExtent : total, height: (down ? total : crossExtent) + title.h, finish };
}
