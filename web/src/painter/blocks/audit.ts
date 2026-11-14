// Counts what must be zero: the painter measures every layout with this, and
// the bench measures thousands. Pure.

import type { Polyline } from '@conduit/language';
import type { CalloutInput, CalloutLayout, StructureInput, StructureLayout } from '../../contracts/blocks';
import type { Box } from '../../contracts/space';
import { bottom, contains, inflate, overlaps, polylineHitsBox, polylinesCross, right, segmentsCross } from './geom';
import type { Point } from '@conduit/language';

export interface StructureAudit {
  /** text on text, and node frames on node frames */
  readonly overlappingText: number;
  /** connectors through a node that is not one of their ends */
  readonly connectorsThroughNodes: number;
  /** a drawn line (connector, leader, axis, rule) through someone else's words */
  readonly crossedLabels: number;
  /** parts outside the room */
  readonly outside: number;
}

const shrinkBox = (b: Box, d: number): Box => ({ x: b.x + d, y: b.y + d, width: Math.max(0, b.width - 2 * d), height: Math.max(0, b.height - 2 * d) });

function boundsOf(lines: readonly Polyline[]): Box | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const l of lines) for (const p of l.points) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return x0 > x1 ? null : { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export function auditStructure(layout: StructureLayout, input: StructureInput): StructureAudit {
  const texts = layout.parts.flatMap((p) => (p.kind === 'text' ? [p] : []));
  let overlappingText = 0;
  for (let i = 0; i < texts.length; i += 1) for (let j = i + 1; j < texts.length; j += 1) {
    if (overlaps(shrinkBox((texts[i] as { box: Box }).box, 0.75), shrinkBox((texts[j] as { box: Box }).box, 0.75))) overlappingText += 1;
  }
  // node frames
  const frames = new Map<string, Box>();
  for (const p of layout.parts) if (p.kind === 'shape' && p.role === 'frame') {
    const b = boundsOf(p.outline);
    if (b) frames.set(p.owner, b);
  }
  const names = [...frames.keys()];
  for (let i = 0; i < names.length; i += 1) for (let j = i + 1; j < names.length; j += 1) {
    if (overlaps(shrinkBox(frames.get(names[i] as string) as Box, 0.75), shrinkBox(frames.get(names[j] as string) as Box, 0.75))) overlappingText += 1;
  }
  // ends of each route
  const ends = new Map<string, readonly string[]>();
  for (const l of input.links) if (l.figure?.kind === 'link') ends.set(l.key, [l.figure.from, l.figure.to]);
  input.nodes.forEach((n, i) => {
    if (!ends.has(n.key)) ends.set(n.key, [n.key, (input.nodes[(i + 1) % input.nodes.length] ?? n).key]);
  });
  let connectorsThroughNodes = 0;
  for (const [key, line] of layout.routes) {
    const e = ends.get(key) ?? [];
    for (const [owner, f] of frames) {
      if (e.includes(owner)) continue;
      if (polylineHitsBox(line, shrinkBox(f, 1))) connectorsThroughNodes += 1;
    }
    // through someone else's words
  }
  let crossedLabels = 0;
  const drawn: { owner: string; line: Polyline; own: boolean }[] = [];
  for (const [key, line] of layout.routes) drawn.push({ owner: key, line, own: true });
  for (const p of layout.parts) {
    if (p.kind !== 'shape') continue;
    if (p.role === 'line' && (p.part === 'leader' || p.part === 'axis' || p.part === 'route' || p.part.startsWith('rule'))) for (const line of p.outline) drawn.push({ owner: p.owner, line, own: p.part === 'leader' });
    if (p.role === 'bar' || (p.role === 'marker' && p.part === 'dot')) for (const line of p.outline) drawn.push({ owner: p.owner, line, own: false });
  }
  for (const t of texts) {
    const hit = shrinkBox(t.box, 1);
    for (const d of drawn) {
      if (t.plate && d.owner === t.owner) continue;
      if (d.own && d.owner === t.owner) continue;
      if (t.owner === d.owner && t.role === 'label' && d.line.closed) continue;
      if (polylineHitsBox(d.line, hit)) {
        crossedLabels += 1;
        break;
      }
    }
  }
  let outside = 0;
  const room = inflate(input.room, 1);
  for (const t of texts) if (!contains(room, t.box)) outside += 1;
  for (const p of layout.parts) if (p.kind === 'shape') {
    const b = boundsOf(p.outline);
    if (b && !contains(room, b)) outside += 1;
  }
  return { overlappingText, connectorsThroughNodes, crossedLabels, outside };
}

export interface CalloutAudit {
  readonly overlappingLabels: number;
  readonly labelsOnStrokes: number;
  readonly leadersCrossing: number;
  readonly leadersThroughLabels: number;
  readonly leadersCrossingStrokes: number;
}

export function auditCallouts(layout: CalloutLayout, input: CalloutInput): CalloutAudit {
  const keys = input.labels.map((l) => l.key);
  let overlappingLabels = 0;
  let labelsOnStrokes = 0;
  let leadersCrossing = 0;
  let leadersThroughLabels = 0;
  let leadersCrossingStrokes = 0;
  const stroke = Math.max(1, input.look.stroke);
  for (let i = 0; i < keys.length; i += 1) {
    const bi = layout.boxes.get(keys[i] as string) as Box;
    for (let j = i + 1; j < keys.length; j += 1) {
      const bj = layout.boxes.get(keys[j] as string) as Box;
      if (overlaps(bi, bj)) overlappingLabels += 1;
      if (polylinesCross(layout.leaders.get(keys[i] as string) as Polyline, layout.leaders.get(keys[j] as string) as Polyline) > 0) leadersCrossing += 1;
    }
    for (const o of input.obstacles) if (overlaps(bi, o)) overlappingLabels += 1;
    if (!contains(inflate(input.room, 1), bi)) overlappingLabels += 1;
    for (const s of input.strokes) if (polylineHitsBox(s, bi)) {
      labelsOnStrokes += 1;
      break;
    }
    for (let j = 0; j < keys.length; j += 1) {
      if (j === i) continue;
      if (polylineHitsBox(layout.leaders.get(keys[i] as string) as Polyline, shrinkBox(layout.boxes.get(keys[j] as string) as Box, 0.5))) leadersThroughLabels += 1;
    }
    const lead = (layout.leaders.get(keys[i] as string) as Polyline).points;
    const a = lead[0] as Point;
    const e = lead[1] as Point;
    const len = Math.hypot(e.x - a.x, e.y - a.y);
    const cut = Math.min(len, stroke * 3 + 2);
    const f = len === 0 ? 0 : (len - cut) / len;
    const e2 = { x: a.x + (e.x - a.x) * f, y: a.y + (e.y - a.y) * f };
    outer: for (const s of input.strokes) {
      const pts = s.points;
      const m = s.closed ? pts.length : pts.length - 1;
      for (let k = 0; k < m; k += 1) if (segmentsCross(a, e2, pts[k] as Point, pts[(k + 1) % pts.length] as Point)) {
        leadersCrossingStrokes += 1;
        break outer;
      }
    }
  }
  void right;
  void bottom;
  return { overlappingLabels, labelsOnStrokes, leadersCrossing, leadersThroughLabels, leadersCrossingStrokes };
}
