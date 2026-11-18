// `refit` (FG1's `refit` as the figure kit has it): a part `in=` a closed shape is shrunk toward its centre until it sits
// inside. No renderer clip is needed, so what is drawn is what was measured, and a label's leader lands on what is really there.
//
// Containers are fitted before what is in them, so a chamber in a chamber in a body is held by each in turn. Pure.

import { bounds, centreOf, edgeDistance, flatten, inside, pole, scaleAbout, shift } from './geometry';
import type { Poly } from './geometry';
import type { FigureInput, FigureNote, FigurePart, Pt } from './types';

export interface Resolved {
  readonly part: FigurePart;
  readonly index: number;
  readonly poly: Poly;
  /** the part that holds it, when that is a closed part of this figure */
  readonly parent: string | null;
  /** how many containers above it */
  readonly depth: number;
}

const FLOOR = 0.15;
const STEP = 0.02;

function holds(container: readonly Pt[], pts: readonly Pt[], margin: number): boolean {
  return pts.every((p) => inside(p, container) && edgeDistance(p, container) >= margin);
}

/** The factor a child was shrunk by, and whether it had to be moved: 1 and false when it already sat inside. */
export function refitInto(container: readonly Pt[], child: Poly, margin: number): { readonly poly: Poly; readonly factor: number; readonly moved: boolean } {
  if (child.pts.length === 0 || holds(container, child.pts, margin)) return { poly: child, factor: 1, moved: false };
  let pts = child.pts;
  let centre = centreOf(child);
  let moved = false;
  if (!inside(centre, container) || edgeDistance(centre, container) < margin) {
    // its centre is out: bring the centre to the thick of the container, then shrink
    const target = pole(container).at;
    pts = shift(pts, target.x - centre.x, target.y - centre.y);
    centre = target;
    moved = true;
  }
  for (let f = 1 - STEP; f >= FLOOR; f -= STEP) {
    const scaled = scaleAbout(pts, centre, f);
    if (holds(container, scaled, margin)) return { poly: { pts: scaled, closed: child.closed }, factor: f, moved };
  }
  return { poly: { pts: scaleAbout(pts, centre, FLOOR), closed: child.closed }, factor: FLOOR, moved };
}

/** Every part as a polyline, containers before what is in them, and what `refit` did. */
export function resolveParts(input: FigureInput): { readonly parts: readonly Resolved[]; readonly notes: readonly FigureNote[] } {
  const notes: FigureNote[] = [];
  const byId = new Map<string, FigurePart>();
  input.parts.forEach((part) => byId.set(part.id, part));
  const flat = new Map<string, Poly>();
  for (const part of input.parts) {
    const made = flatten(part.shape, part.smooth === true);
    // a part with a fill is a closed shape, whatever the path said
    const poly: Poly = part.fill !== undefined && !made.poly.closed && made.poly.pts.length > 2 ? { pts: made.poly.pts, closed: true } : made.poly;
    flat.set(part.id, poly);
    if (made.extra > 0) notes.push({ kind: 'extra-lines', part: part.id, detail: `${made.extra} further sub-path(s) of "${part.id}" were left out` });
  }
  const parentOf = (part: FigurePart): string | null => {
    if (part.in === undefined) return null;
    const holder = byId.get(part.in);
    if (holder === undefined) {
      notes.push({ kind: 'unknown-part', part: part.id, detail: `"${part.id}" is in "${part.in}", which is not a part of this figure` });
      return null;
    }
    if (!(flat.get(holder.id)?.closed ?? false)) {
      notes.push({ kind: 'open-container', part: part.id, detail: `"${part.id}" is in "${holder.id}", which is not a closed shape` });
      return null;
    }
    return holder.id;
  };
  const parents = new Map<string, string | null>(input.parts.map((p) => [p.id, parentOf(p)]));
  const depthOf = (id: string, seen: ReadonlySet<string> = new Set()): number => {
    const up = parents.get(id) ?? null;
    return up === null || seen.has(up) ? 0 : 1 + depthOf(up, new Set([...seen, id]));
  };
  const order = input.parts.map((part, index) => ({ part, index, depth: depthOf(part.id) })).sort((a, b) => a.depth - b.depth || a.index - b.index);
  const done = new Map<string, Poly>();
  for (const { part } of order) {
    let poly = flat.get(part.id) as Poly;
    const holder = parents.get(part.id) ?? null;
    if (holder !== null) {
      const container = done.get(holder);
      if (container !== undefined) {
        const margin = Math.max(bounds(container.pts).width, bounds(container.pts).height) * 0.012;
        const made = refitInto(container.pts, poly, margin);
        poly = made.poly;
        if (made.factor < 1 || made.moved) notes.push({ kind: 'refit', part: part.id, detail: `"${part.id}" was ${made.moved ? 'moved and ' : ''}shrunk to ${Math.round(made.factor * 100)}% to sit inside "${holder}"` });
      }
    }
    done.set(part.id, poly);
  }
  const parts: Resolved[] = input.parts.map((part, index) => ({ part, index, poly: done.get(part.id) as Poly, parent: parents.get(part.id) ?? null, depth: depthOf(part.id) }));
  return { parts, notes };
}
