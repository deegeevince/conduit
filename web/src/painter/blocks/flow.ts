// Flow: a layered layout. Ranks by longest path (back edges reversed first),
// order by the barycentre of what is already placed (a single downward sweep,
// so a late part never reshuffles an early rank), cross positions by least
// squares under a minimum separation, connectors orthogonal in the gaps
// between ranks and through reserved columns where they skip a rank.

import type { Point, Polyline } from '@conduit/language';
import type { BlockPart, StructureInput, StructureLayout } from '../../contracts/blocks';
import type { Box } from '../../contracts/space';
import { box, boxOfPoints, packOrdered, polylinesCross, simplify, union } from './geom';
import type { Draft, LinkSpec, NodeBox, Note } from './kit';
import { best, connectorParts, knockOut, Env, fit, isCrowded, labelPart, linkSpecs, nodeParts, placeBeside, sizeNode, WRAPS } from './kit';

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
  return flowLayout(input, true);
}

function flowLayout(input: StructureInput, mayFold: boolean): StructureLayout {
  const f = input.structure.figure;
  const forced = f?.kind === 'structure' ? f.grow : null;
  const preferred: Grow = forced ?? (input.room.width >= input.room.height ? 'right' : 'down');
  const other: Grow = preferred === 'right' ? 'down' : 'right';
  const attempts: (() => StructureLayout)[] = [];
  // the direction asked for, at the usual width of words; then the other direction; then each with words wider and narrower
  for (const wrap of WRAPS) for (const grow of mayFold ? [preferred, other] : [preferred]) attempts.push(() => fit(input, input.look.stroke, (env) => buildFlow(env, grow), undefined, wrap));
  let chosen = best(attempts);
  // Nothing fits its room: words set at widths in between the usual ones may (a narrow room and a tall chain: wider boxes, fewer ranks of lines)
  if ((chosen.overflows ?? 0) > 0) {
    const more: (() => StructureLayout)[] = [() => chosen];
    for (const wrap of [1.3, 1.5, 1.7, 1.8, 1.9, 2, 2.1, 2.2, 2.6]) more.push(() => fit(input, input.look.stroke, (env) => buildFlow(env, preferred), undefined, wrap));
    chosen = best(more);
  }
  // A tall narrow room and a long chain: two columns, read down the first and on down the second (a snake), before anything is shrunk to a crawl
  if (mayFold && input.nodes.length >= 6 && input.room.height >= input.room.width * 1.15 && (isCrowded(chosen) || (chosen.overflows ?? 0) > 0 || chosen.shrink < 0.85)) {
    const snake = best([1, 0.8, 1.25].map((wrap) => () => fit(input, input.look.stroke, (env) => buildSnake(env), undefined, wrap)));
    if ((snake.overflows ?? 0) === 0 && ((chosen.overflows ?? 0) > 0 || (isCrowded(chosen) ? snake.shrink >= chosen.shrink + 0.1 : !isCrowded(snake) && snake.shrink >= chosen.shrink + 0.1))) return snake;
  }
  if (!mayFold || !isCrowded(chosen)) return chosen;
  // A long chain that fits no way is set like text: in rows, each row left to right, the end of one joined to the start of the next.
  const folded = foldChain(input);
  if (folded === null || isCrowded(folded)) return chosen;
  // a fold that runs its connectors across one another is no better than a layout that merely fits
  const links = linkSpecs(input);
  const crossings = (l: StructureLayout): number => {
    let n = 0;
    for (let i = 0; i < links.length; i += 1)
      for (let j = i + 1; j < links.length; j += 1) {
        const a = links[i] as LinkSpec;
        const b = links[j] as LinkSpec;
        if (a.from === b.from || a.to === b.to || a.from === b.to || a.to === b.from) continue;
        const p = l.routes.get(a.el.key);
        const q = l.routes.get(b.el.key);
        if (p !== undefined && q !== undefined) n += polylinesCross(p, q);
      }
    return n;
  };
  return (chosen.overflows ?? 0) > 0 || crossings(folded) <= crossings(chosen) ? folded : chosen;
}

/** The nodes in the order of a single path through every one of them, when the links are exactly that. */
function chainOrder(input: StructureInput, links: readonly LinkSpec[]): string[] | null {
  const n = input.nodes.length;
  const ends = new Set<string>();
  for (const l of links) {
    ends.add(l.from);
    ends.add(l.to);
  }
  // nodes with no link at all follow the chain, in the order written
  if (n < 4 || ends.size < 3 || links.length !== ends.size - 1) return null;
  const next = new Map<string, LinkSpec>();
  const hasIn = new Set<string>();
  for (const l of links) {
    if (next.has(l.from) || hasIn.has(l.to)) return null;
    next.set(l.from, l);
    hasIn.add(l.to);
  }
  const head = input.nodes.find((el) => ends.has(el.key) && !hasIn.has(el.key));
  if (head === undefined) return null;
  const order: string[] = [head.key];
  for (let at = next.get(head.key); at !== undefined; at = next.get(at.to)) {
    if (order.includes(at.to)) return null;
    order.push(at.to);
  }
  if (order.length !== ends.size) return null;
  for (const el of input.nodes) if (!ends.has(el.key)) order.push(el.key);
  return order.length === n ? order : null;
}

/** Rows of a chain: the fewest, then the largest type, in which every row fits. Null when the structure is not a chain. */
/** a folded chain may be set smaller than a single row may: more of it is on the page, and rows keep it readable */
const FOLD_MIN_SHRINK = 0.5;
function foldChain(input: StructureInput): StructureLayout | null {
  const f = input.structure.figure;
  if (f?.kind !== 'structure') return null;
  const links = linkSpecs(input);
  // a chain is folded in the order of its path; any other graph in the order written (what is written first is read first), its crossing links routed through the gutters
  const order = chainOrder(input, links) ?? (input.nodes.length >= 4 && links.length > 0 ? input.nodes.map((el) => el.key) : null);
  if (order === null) return null;
  const byKey = new Map(input.nodes.map((el) => [el.key, el]));
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
    const bandOf = new Map<string, number>();
    groups.forEach((group, i) => group.forEach((k) => bandOf.set(k, i)));
    const crossing = links.filter((l) => bandOf.get(l.from) !== bandOf.get(l.to));
    // a link that skips a band, or goes back up, runs down a lane at the room's right edge
    const laned = crossing.filter((l) => (bandOf.get(l.to) ?? 0) !== (bandOf.get(l.from) ?? 0) + 1);
    const laneW = laned.length === 0 ? 0 : 10 + 7 * laned.length;
    if (bandH < base.body * 0.7) break;
    const bands: StructureLayout[] = [];
    groups.forEach((group, i) => {
      const keys = new Set(group);
      const inside = links.filter((l) => keys.has(l.from) && keys.has(l.to)).map((l) => l.el);
      const room: Box = { x: input.room.x, y: input.room.y + title.h + i * (bandH + gap), width: input.room.width - laneW, height: bandH };
      const structure = { ...input.structure, text: '', figure: { ...f, grow: 'right' as const } };
      bands.push(flowLayout({ ...input, look: { ...input.look, minShrink: Math.min(input.look.minShrink, FOLD_MIN_SHRINK) }, structure, nodes: group.map((k) => byKey.get(k) as (typeof input.nodes)[number]), links: inside, room }, false));
    });
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
      // links between bands: down through the gutter below the source's band, along it, then down into the target; a link that skips a band or
      // goes back up runs along a lane at the room's right edge
      const bandBox = bands.map((band) => union([...band.boxes].filter(([k]) => k !== input.structure.key).map(([, v]) => v)));
      const gutter = (k: number): number => (k < 0 ? (bandBox[0] as Box).y - gap / 2 : Math.min(input.room.y + input.room.height - 2, (bandBox[k] as Box).y + (bandBox[k] as Box).height + gap / 2));
      let lane = 0;
      // the words already set in the bands stay clear of the words set in the gutters
      const taken: Box[] = parts.flatMap((p) => (p.kind === 'text' && p.role === 'label' ? [p.box] : []));
      for (const link of crossing) {
        const from = boxes.get(link.from);
        const to = boxes.get(link.to);
        const i = bandOf.get(link.from) ?? 0;
        const j = bandOf.get(link.to) ?? 0;
        if (from === undefined || to === undefined) continue;
        const pts: Point[] = [{ x: from.x + from.width / 2, y: from.y + from.height }, { x: from.x + from.width / 2, y: gutter(i) }];
        let along = gutter(i);
        if (j === i + 1) pts.push({ x: to.x + to.width / 2, y: gutter(i) });
        else {
          const x = input.room.x + input.room.width - 4 - 7 * lane;
          lane += 1;
          const above = gutter(j - 1);
          pts.push({ x, y: gutter(i) }, { x, y: above }, { x: to.x + to.width / 2, y: above });
          along = above;
        }
        pts.push({ x: to.x + to.width / 2, y: to.y });
        connectorParts(env, link, pts, lines, heads);
        routes.set(link.el.key, { points: pts, closed: false });
        let area = boxOfPoints(pts);
        if (link.label !== '') {
          const m = env.measure(link.label, env.wrapWidth, env.label());
          // beside the line, longest run first, never on it; with no clear place the lines break round the word
          const runs: (readonly [Point, Point])[] = [];
          for (let i = 0; i + 1 < pts.length; i += 1) runs.push([pts[i] as Point, pts[i + 1] as Point]);
          const len = (r: readonly [Point, Point]): number => Math.hypot(r[1].x - r[0].x, r[1].y - r[0].y);
          runs.sort((x, y) => len(y) - len(x));
          const nodeBoxes = input.nodes.flatMap((el) => boxes.get(el.key) ?? []);
          const pick = placeBeside(runs, m.width, m.height, env.stroke * 1.5 + 3, { boxes: [...nodeBoxes, ...taken], lines: [...routes.values()] }, input.room);
          const at = pick?.box ?? box(((pts[1] as Point).x + (pts[2] as Point).x) / 2 - m.width / 2, along - m.height / 2, m.width, m.height);
          if ((pick === null || pick.penalty > 0) && knockOut(lines, at, env.stroke * 1.5, [...nodeBoxes, ...taken])) notes.push({ key: link.el.key, note: 'crossed' });
          taken.push(at);
          labels.push(labelPart(env, link.el.key, link.label, at, m, pick === null || pick.penalty > 0));
          area = union([area, at]);
        }
        boxes.set(link.el.key, area);
      }
      parts.push(...lines, ...heads, ...labels);
      const whole = union([...boxes.values()]);
      boxes.set(input.structure.key, whole);
      // the gutters and lanes are laid between the bands after the bands were fitted, so the whole may stand outside the room: such a fold is no answer
      if (whole.x < input.room.x - 1 || whole.y < input.room.y - 1 || whole.x + whole.width > input.room.x + input.room.width + 1 || whole.y + whole.height > input.room.y + input.room.height + 1) continue;
      notes.push({ key: input.structure.key, note: worst >= 1 ? 'crowded' : 'shrunk' });
      if (worst >= 1) notes.pop();
      best = { layout: { boxes, parts, routes, notes: worst > 0 ? notes : [...notes, { key: input.structure.key, note: 'crowded' }], shrink }, score: worst };
      if (worst >= 1) break;
    }
  }
  return best === null || best.score <= 0 ? null : best.layout;
}

/**
 * A snake: the nodes in the order written, the first half stacked down the left column and the rest read up the right, so the eye goes
 * down one and on up the other and the turn from one to the next is a short step across at the foot. Links between neighbours in a column
 * are straight. Every other link leaves the side of its node that faces its lane, runs along a lane of its own and enters the side that faces
 * its target: between the columns for a link from one column to the other, outside the column for a link that skips within one. The
 * lanes are ordered so that none crosses another where that can be, and the place where the columns turn is the one that crosses least.
 */
type Zone = 'gutter' | 'left' | 'right';

/** the order of lanes along a strip (left to right) that crosses least: for each link, the y it leaves and enters, and the x of the side its node stands on (0 left of the lanes, 1 right of them) */
function laneOrder(ya: readonly number[], yb: readonly number[], sa: readonly (0 | 1)[], sb: readonly (0 | 1)[]): { perm: number[]; cross: number } {
  const cnt = ya.length;
  const cross = (perm: readonly number[]): number => {
    let c = 0;
    for (let p = 0; p < cnt; p += 1)
      for (let q = 0; q < cnt; q += 1) {
        if (p === q) continue;
        const xp = 1 + (perm[p] as number);
        const xq = 1 + (perm[q] as number);
        const y0 = Math.min(ya[q] as number, yb[q] as number);
        const y1 = Math.max(ya[q] as number, yb[q] as number);
        for (const [hy, hs] of [[ya[p] as number, sa[p] as 0 | 1], [yb[p] as number, sb[p] as 0 | 1]] as const) {
          const hx = hs === 0 ? 0 : cnt + 1;
          if (hy > y0 + 0.5 && hy < y1 - 0.5 && xq > Math.min(hx, xp) && xq < Math.max(hx, xp)) c += 1;
        }
      }
    return c;
  };
  let best: number[] = ya.map((_, i) => i);
  let bestC = cross(best);
  if (cnt > 1 && cnt <= 6) {
    const walk = (rest: number[], took: number[]): void => {
      if (rest.length === 0) {
        const c = cross(took);
        if (c < bestC) {
          bestC = c;
          best = took;
        }
        return;
      }
      rest.forEach((v, i) => walk([...rest.slice(0, i), ...rest.slice(i + 1)], [...took, v]));
    };
    walk(best, []);
  }
  return { perm: best, cross: bestC };
}

function buildSnake(env: Env): Draft {
  const input = env.input;
  const body = env.body;
  const links = linkSpecs(input);
  const order = input.nodes.map((el) => el.key);
  const n = order.length;
  const index = new Map(order.map((k, i) => [k, i]));
  const head = env.headLength;
  const laneStep = Math.max(env.stroke * 2.5, 0.55 * body * env.tight);
  const margin = (head * 1.6 + 0.2 * body) * Math.min(1, env.tight + 0.4);
  const gapY = env.up(Math.max(1.5 * body * env.tight, head * 2.4), 'y');
  const adjacent = (l: LinkSpec, split: number): boolean => {
    const a = index.get(l.from) as number;
    const b = index.get(l.to) as number;
    return b === a + 1 && (a < split) === (b < split);
  };
  const zoneOf = (l: LinkSpec, split: number): Zone => {
    const a = index.get(l.from) as number;
    const b = index.get(l.to) as number;
    if ((a < split) !== (b < split)) return 'gutter';
    return a < split ? 'left' : 'right';
  };
  const stripOf = (laned: number): number => (laned === 0 ? 0 : 2 * margin + (laned - 1) * laneStep);
  const half = Math.ceil(n / 2);
  const lanesAt = (split: number, zone: Zone): number => links.filter((l) => !adjacent(l, split) && zoneOf(l, split) === zone).length;
  const textW = Math.max(body * 4, (input.room.width - stripOf(lanesAt(half, 'gutter')) - Math.max(2 * margin, 0) - stripOf(lanesAt(half, 'left')) - stripOf(lanesAt(half, 'right'))) / 2 - body * 1.2);
  const boxes = input.nodes.map((el) => sizeNode(env, el, Math.min(textW, Math.max(env.wrapWidth, textW * 0.9))));
  const colHeight = (a: number, b: number): number => {
    let h = 0;
    for (let i = a; i < b; i += 1) h += (boxes[i] as NodeBox).height + (i > a ? gapY : 0);
    return h;
  };
  // the second column is read upward: both columns stand on one baseline
  const centreY = (i: number, k: number): number => {
    const base = Math.max(colHeight(0, k), colHeight(k, n));
    const h = (boxes[i] as NodeBox).height;
    return i < k ? base - colHeight(0, k) + colHeight(0, i) + (i > 0 ? gapY : 0) + h / 2 : base - colHeight(k, i) - (i > k ? gapY : 0) - h / 2;
  };
  const crossingsAt = (k: number): number => {
    let total = 0;
    for (const zone of ['gutter', 'left', 'right'] as const) {
      const laned = links.filter((l) => !adjacent(l, k) && zoneOf(l, k) === zone);
      const sideOf = (i: number): 0 | 1 => (zone === 'gutter' ? ((i < k ? 0 : 1) as 0 | 1) : zone === 'left' ? 1 : 0);
      total += laneOrder(laned.map((l) => centreY(index.get(l.from) as number, k)), laned.map((l) => centreY(index.get(l.to) as number, k)), laned.map((l) => sideOf(index.get(l.from) as number)), laned.map((l) => sideOf(index.get(l.to) as number))).cross;
    }
    return total;
  };
  let split = half;
  let least = Infinity;
  for (let k = 2; k <= n - 2; k += 1) least = Math.min(least, Math.max(colHeight(0, k), colHeight(k, n)));
  let leastCross = Infinity;
  for (let k = 2; k <= n - 2; k += 1) {
    const h = Math.max(colHeight(0, k), colHeight(k, n));
    if (h > least * 1.3) continue;
    const c = crossingsAt(k);
    if (c < leastCross || (c === leastCross && h < Math.max(colHeight(0, split), colHeight(split, n)) - 1e-9)) {
      leastCross = c;
      split = k;
    }
  }
  const col = (i: number): 0 | 1 => (i < split ? 0 : 1);
  const colW = [0, 0];
  boxes.forEach((b, i) => (colW[col(i)] = Math.max(colW[col(i)] as number, b.width)));
  const lanedLinks = links.filter((l) => !adjacent(l, split));
  // the word on a link that runs along a lane is set narrow (two short lines) and given a clear stretch beside its first run
  const labelM = new Map(links.map((l) => [l, l.label ? env.measure(l.label, adjacent(l, split) ? env.wrapWidth : body * 3.4, env.label()) : null]));
  // each strip has, beside the node side a link leaves, a stretch for its word; the stretch is on the side of the lanes the nodes are
  const stretch = { gutterLeft: 0, gutterRight: 0, left: 0, right: 0 };
  for (const l of lanedLinks) {
    const m = labelM.get(l);
    if (!m) continue;
    const w = m.width + body * 0.4;
    const zone = zoneOf(l, split);
    if (zone === 'gutter') {
      if (col(index.get(l.from) as number) === 0) stretch.gutterLeft = Math.max(stretch.gutterLeft, w);
      else stretch.gutterRight = Math.max(stretch.gutterRight, w);
    } else stretch[zone] = Math.max(stretch[zone], w);
  }
  const count = { gutter: lanesAt(split, 'gutter'), left: lanesAt(split, 'left'), right: lanesAt(split, 'right') };
  const gutter = stripOf(count.gutter) + stretch.gutterLeft + stretch.gutterRight;
  const outerLeft = count.left === 0 ? 0 : stripOf(count.left) + stretch.left;
  const outerRight = count.right === 0 ? 0 : stripOf(count.right) + stretch.right;
  const title = env.title();
  const width = outerLeft + (colW[0] as number) + gutter + (colW[1] as number) + outerRight;
  // a word beside the first run of the topmost link may stand above it: a little air under the title for it
  const headroom = body * 0.9;
  const total = Math.max(colHeight(0, split), colHeight(split, n));

  const finish = (room: Box): ReturnType<Draft['finish']> => {
    const ox = env.after(room.x + Math.max(0, (room.width - width) / 2), 'x');
    const oy = env.after(room.y + title.h + headroom, 'y');
    const xA = ox + outerLeft;
    const gx0 = xA + (colW[0] as number);
    const xB = gx0 + gutter;
    const xs = [xA, xB];
    const at: Box[] = [];
    const base = oy + total;
    const tops = [base - colHeight(0, split), base];
    boxes.forEach((b, i) => {
      const c = col(i);
      const x = (xs[c] as number) + ((colW[c] as number) - b.width) / 2;
      if (c === 0) {
        at.push(box(env.snap(x, 'x'), tops[0] as number, b.width, b.height));
        tops[0] = (tops[0] as number) + b.height + gapY;
      } else {
        tops[1] = (tops[1] as number) - b.height;
        at.push(box(env.snap(x, 'x'), tops[1] as number, b.width, b.height));
        tops[1] = (tops[1] as number) - gapY;
      }
    });
    const out = new Map<string, Box>();
    const routes = new Map<string, Polyline>();
    const notes: Note[] = [];
    const fills: BlockPart[] = [];
    const frames: BlockPart[] = [];
    const words: BlockPart[] = [];
    const lines: BlockPart[] = [];
    const heads: BlockPart[] = [];
    const labels: BlockPart[] = [];
    boxes.forEach((b, i) => {
      const r = at[i] as Box;
      b.width = r.width;
      b.height = r.height;
      out.set(b.el.key, r);
      nodeParts(env, b, r, fills, frames, words);
    });
    // the side of a node a link leaves or enters: the one that faces its lane
    const sideLeft = (i: number, zone: Zone): boolean => (zone === 'gutter' ? col(i) === 1 : zone === 'left');
    const sideX = (i: number, zone: Zone): number => ((at[i] as Box).x + (sideLeft(i, zone) ? 0 : (at[i] as Box).width));
    const isAsk = (i: number): boolean => (boxes[i] as NodeBox).el.figure?.kind === 'node' && ((boxes[i] as NodeBox).el.figure as { shape?: string }).shape === 'ask';
    const portY = (i: number, k: number, cnt: number): number => {
      const r = at[i] as Box;
      const f = isAsk(i) ? 0.5 + ((k + 1) / (cnt + 1) - 0.5) * 0.35 : (k + 1) / (cnt + 1);
      return r.y + f * r.height;
    };
    // ports: the links leaving or entering one side of a node share it, in the order of what they reach
    const yOut = new Map<LinkSpec, number>();
    const yIn = new Map<LinkSpec, number>();
    const sideOut = new Map<string, LinkSpec[]>();
    const sideIn = new Map<string, LinkSpec[]>();
    for (const l of lanedLinks) {
      const z = zoneOf(l, split);
      const a = index.get(l.from) as number;
      const b = index.get(l.to) as number;
      const ka = `${a}:${sideLeft(a, z)}`;
      const kb = `${b}:${sideLeft(b, z)}`;
      sideOut.set(ka, [...(sideOut.get(ka) ?? []), l]);
      sideIn.set(kb, [...(sideIn.get(kb) ?? []), l]);
    }
    for (const [key, list] of sideOut) {
      list.sort((p, q) => (at[index.get(p.to) as number] as Box).y - (at[index.get(q.to) as number] as Box).y);
      list.forEach((l, k) => yOut.set(l, portY(Number(key.split(':')[0]), k, list.length)));
    }
    for (const [key, list] of sideIn) {
      list.sort((p, q) => (at[index.get(p.from) as number] as Box).y - (at[index.get(q.from) as number] as Box).y);
      list.forEach((l, k) => yIn.set(l, portY(Number(key.split(':')[0]), k, list.length)));
    }
    // lanes of each strip: x of the first lane, and the order along it
    const laneAt = new Map<LinkSpec, number>();
    for (const zone of ['gutter', 'left', 'right'] as const) {
      const group = lanedLinks.filter((l) => zoneOf(l, split) === zone);
      if (group.length === 0) continue;
      const sideOf = (i: number): 0 | 1 => (zone === 'gutter' ? ((col(i) === 0 ? 0 : 1) as 0 | 1) : zone === 'left' ? 1 : 0);
      const { perm } = laneOrder(group.map((l) => yOut.get(l) as number), group.map((l) => yIn.get(l) as number), group.map((l) => sideOf(index.get(l.from) as number)), group.map((l) => sideOf(index.get(l.to) as number)));
      const first = zone === 'gutter' ? gx0 + margin + stretch.gutterLeft : zone === 'left' ? ox + margin : xB + (colW[1] as number) + margin + stretch.right;
      group.forEach((l, i) => laneAt.set(l, first + (perm[i] as number) * laneStep));
    }
    const taken: Box[] = [];
    const routed: { link: LinkSpec; pts: Point[] }[] = [];
    for (const l of links) {
      const a = index.get(l.from) as number;
      const b = index.get(l.to) as number;
      let pts: Point[];
      if (adjacent(l, split)) {
        const from = at[a] as Box;
        const to = at[b] as Box;
        pts = col(a) === 0 ? [{ x: from.x + from.width / 2, y: from.y + from.height }, { x: to.x + to.width / 2, y: to.y }] : [{ x: from.x + from.width / 2, y: from.y }, { x: to.x + to.width / 2, y: to.y + to.height }];
      } else {
        const z = zoneOf(l, split);
        const lx = laneAt.get(l) as number;
        const y0 = yOut.get(l) as number;
        const y1 = yIn.get(l) as number;
        pts = [{ x: sideX(a, z), y: y0 }, { x: lx, y: y0 }, { x: lx, y: y1 }, { x: sideX(b, z), y: y1 }];
        if (Math.abs(y0 - y1) < 0.5 && z === 'gutter') pts = [pts[0] as Point, pts[3] as Point];
      }
      pts = simplify(pts);
      routes.set(l.el.key, { points: pts, closed: false });
      routed.push({ link: l, pts });
      connectorParts(env, l, pts, lines, heads);
    }
    const nodeBoxes = [...at];
    for (const { link: l, pts } of routed) {
      const m = labelM.get(l) ?? null;
      let area = boxOfPoints(pts);
      if (m !== null) {
        const runs: (readonly [Point, Point])[] = [];
        for (let i = 0; i + 1 < pts.length; i += 1) runs.push([pts[i] as Point, pts[i + 1] as Point]);
        const len = (r: readonly [Point, Point]): number => Math.hypot(r[1].x - r[0].x, r[1].y - r[0].y);
        const ordered = [...runs.slice(0, 1), ...runs.slice(1).sort((x, y) => len(y) - len(x))];
        const blockers = { boxes: [...nodeBoxes, ...taken], lines: [...routes.values()] };
        const pick = placeBeside(ordered, m.width, m.height, env.stroke * 1.5 + 3, blockers, room);
        if (pick !== null) {
          if (pick.penalty > 0 && knockOut(lines, pick.box, env.stroke * 1.5, [...nodeBoxes, ...taken])) notes.push({ key: l.el.key, note: 'crossed' });
          taken.push(pick.box);
          labels.push(labelPart(env, l.el.key, l.label, pick.box, m, pick.penalty > 0));
          area = union([area, pick.box]);
        }
      }
      out.set(l.el.key, area);
    }
    const tp = title.part(room);
    return { parts: [...(tp ? [tp] : []), ...fills, ...lines, ...heads, ...frames, ...words, ...labels], boxes: out, routes, notes };
  };

  return { width, height: total + title.h + headroom, finish };
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
  // A node nothing joins, beside a diagram that has links, belongs after it (the last step the brain wrote and did not link).
  const joined = new Set<number>();
  ends.forEach((e) => {
    joined.add(e.u);
    joined.add(e.v);
  });
  if (joined.size > 0 && joined.size < nodes.length) {
    const after = Math.max(...[...joined].map((i) => rank[i] as number)) + 1;
    nodes.forEach((_, i) => {
      if (!joined.has(i)) rank[i] = after;
    });
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
  // a link meets a diamond near its points, so its ports gather in the middle of the side; a box spreads them along it
  const portAt = (v: V, k: number, n: number): number => (v.real ? v.pos - v.c / 2 + (v.real.el.figure?.kind === 'node' && v.real.el.figure.shape === 'ask' ? 0.5 + (((k + 1) / (n + 1)) - 0.5) * 0.35 : (k + 1) / (n + 1)) * v.c : v.pos);
  for (const [v, list] of outs) {
    list.sort((x, y) => x.v.pos - y.v.pos || x.edge - y.edge);
    list.forEach((s, k) => (s.out = portAt(v, k, list.length)));
  }
  for (const [v, list] of ins) {
    list.sort((x, y) => x.u.pos - y.u.pos || x.edge - y.edge);
    list.forEach((s, k) => (s.inn = portAt(v, k, list.length)));
  }

  // The gaps between ranks: lanes for the runs across, and room for a label on the first stretch.
  const small = env.label();
  const labelM = edges.map((e) => (e.spec.label ? env.measure(e.spec.label, env.wrapWidth, small) : null));
  const labelA = (m: { width: number; height: number } | null): number => (m ? (down ? m.height : m.width) : 0);
  const head = env.headLength;
  // the run into a node after a lane: the arrowhead and a little more; the tightest spacing keeps only the head and a bare margin
  const tail = (head * 1.6 + 0.2 * body) * Math.min(1, tight + 0.4);
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
      const w = m.width;
      const h = m.height;
      const pts = p.pts;
      // beside the line, never on it: its first stretch first, then the longest runs
      const runs: (readonly [Point, Point])[] = [];
      for (let i = 0; i + 1 < pts.length; i += 1) runs.push([pts[i] as Point, pts[i + 1] as Point]);
      const len = (r: readonly [Point, Point]): number => Math.hypot(r[1].x - r[0].x, r[1].y - r[0].y);
      const ordered2 = [...runs.slice(0, 1), ...runs.slice(1).sort((x, y) => len(y) - len(x))];
      const blockers = { boxes: [...nodeBoxes, ...taken], lines: allLines };
      const off = env.stroke * 1.5 + 3;
      const pick = placeBeside(ordered2, w, h, off, blockers, room);
      if (!pick) continue;
      if (pick.penalty > 0 && knockOut(lines, pick.box, env.stroke * 1.5, blockers.boxes)) notes.push({ key: p.edge.spec.el.key, note: 'crossed' });
      taken.push(pick.box);
      labels.push(labelPart(env, p.edge.spec.el.key, p.edge.spec.label, pick.box, m, pick.penalty > 0));
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
