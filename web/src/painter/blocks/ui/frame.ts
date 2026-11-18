// Shapes and words to a Frame: "the kit is drawn from what the painter already draws (rounded rects,
// `soft=` for a shadow, type), so no renderer learns anything". This is the adapter: a rounded rectangle becomes a
// ShapeFrame with a fill, an edge and, under it, a soft shadow; a path becomes a ShapeFrame; a line of text becomes an
// ElementFrame whose runs are placed with the same advance tables the measurer used. Edges are snapped to device
// pixels and nothing sways, so a hairline is a hairline.
//
// Input is in the room's own pixels, origin at its top-left. Output is a Frame with its origin at the room's centre, as
// every Frame is. Pure.

import type { Polyline } from '@conduit/language';
import type { ElementFrame, FigureFrame, Frame, PictureFrame, RunFrame, ShapeFrame } from '../../../contracts/frame';
import { IDENTITY } from '../../../contracts/frame';
import type { LookSpec } from '../../../contracts/look';
import { REST_POSE } from '../../../contracts/space';
import { foldText } from '../../../fonts/fold';
import { prefixEm } from '../../../fonts/measure';
import type { UiClip, UiPart, UiRect } from './types';

export interface FrameOptions {
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
  readonly spec: LookSpec;
  /** seconds on the clock, for the frame's own time fields */
  readonly time?: number;
}

const CELL = 1.4; // the line height the sans face is set in: the renderer centres capitals in a line box this tall

function rrect(w: number, h: number, r: number): { x: number; y: number }[] {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  if (radius < 0.5) return [{ x: -w / 2, y: -h / 2 }, { x: w / 2, y: -h / 2 }, { x: w / 2, y: h / 2 }, { x: -w / 2, y: h / 2 }];
  const steps = Math.max(4, Math.min(20, Math.ceil(radius / 1.5)));
  const pts: { x: number; y: number }[] = [];
  const corner = (cx: number, cy: number, from: number): void => {
    for (let i = 0; i <= steps; i++) {
      const a = from + (i / steps) * (Math.PI / 2);
      pts.push({ x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) });
    }
  };
  corner(w / 2 - radius, -h / 2 + radius, -Math.PI / 2);
  corner(w / 2 - radius, h / 2 - radius, 0);
  corner(-w / 2 + radius, h / 2 - radius, Math.PI / 2);
  corner(-w / 2 + radius, -h / 2 + radius, Math.PI);
  return pts;
}

/** A closed outline cut into dashes: each dash is its own open polyline, as a dashed line is everywhere in the painter. */
function dashed(points: readonly { x: number; y: number }[], on: number, off: number): Polyline[] {
  const out: Polyline[] = [];
  const ring = [...points, points[0] as { x: number; y: number }];
  let draw = true;
  let left = on;
  let current: { x: number; y: number }[] = [ring[0] as { x: number; y: number }];
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1] as { x: number; y: number };
    const b = ring[i] as { x: number; y: number };
    let len = Math.hypot(b.x - a.x, b.y - a.y);
    let at = a;
    while (len > 1e-6) {
      const step = Math.min(left, len);
      const t = step / len;
      const next = { x: at.x + (b.x - at.x) * t, y: at.y + (b.y - at.y) * t };
      if (draw) current.push(next);
      len -= step;
      left -= step;
      at = next;
      if (left <= 1e-6) {
        if (draw && current.length > 1) out.push({ closed: false, points: current });
        draw = !draw;
        left = draw ? on : off;
        current = draw ? [at] : [];
      }
    }
  }
  if (draw && current.length > 1) out.push({ closed: false, points: current });
  return out;
}

export function uiFrame(parts: readonly UiPart[], o: FrameOptions): Frame {
  const { width, height, dpr, spec } = o;
  const snap = (v: number): number => Math.round(v * dpr) / dpr;
  const cx = width / 2;
  const cy = height / 2;
  const figures: FigureFrame[] = [];
  const elements: ElementFrame[] = [];
  let z = 0;

  let clip: UiClip | undefined;
  const boxOf = (c: UiClip | undefined): { x: number; y: number; width: number; height: number } | undefined => (c === undefined ? undefined : { x: c.x - cx, y: c.y - cy, width: c.w, height: c.h });
  const shape = (key: string, owner: string, local: Polyline[], at: { x: number; y: number }, fill: ShapeFrame['fill'], stroke: ShapeFrame['stroke'], geometry: string, soft?: number, opacity = 1): void => {
    const kept = boxOf(clip);
    figures.push({
      kind: 'shape',
      key,
      id: owner,
      layer: 'mid',
      z: z++,
      outline: local,
      geometryKey: geometry,
      transform: { ...IDENTITY, e: at.x - cx, f: at.y - cy },
      fill,
      stroke,
      opacity,
      bleed: false,
      tappable: false,
      ...(soft === undefined ? {} : { soft }),
      ...(kept === undefined ? {} : { clip: kept }),
    });
  };

  const drawRect = (p: UiRect): void => {
    // edges on whole device pixels
    const x0 = snap(p.x);
    const y0 = snap(p.y);
    const x1 = snap(p.x + p.w);
    const y1 = snap(p.y + p.h);
    const w = x1 - x0;
    const h = y1 - y0;
    if (w <= 0 || h <= 0) return;
    const at = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
    if (p.rule !== undefined) {
      const t = 1 / dpr;
      const ry = p.rule === 'bottom' ? y1 - t : y0;
      shape(`${p.key}`, p.owner, [{ closed: true, points: rrect(w, t, 0) }], { x: at.x, y: ry + t / 2 }, { colour: p.edge?.colour ?? '#000000', to: null, opacity: 1 }, null, `rule:${w}`);
      return;
    }
    if (p.shadow !== undefined && p.shadow.alpha > 0) {
      const blur = Math.max(0.5, p.shadow.blur);
      shape(`${p.key}~shadow`, p.owner, [{ closed: true, points: rrect(w, h, p.radius) }], { x: at.x, y: at.y + p.shadow.dy }, { colour: p.shadow.colour, to: null, opacity: p.shadow.alpha }, null, `shadow:${w}x${h}:${p.radius.toFixed(1)}`, blur);
    }
    const fill: ShapeFrame['fill'] = p.fill === null ? null : typeof p.fill === 'string' ? { colour: p.fill, to: null, opacity: p.fillAlpha ?? 1 } : { colour: p.fill.from, to: p.fill.to, opacity: p.fillAlpha ?? 1 };
    const key = `rect:${w}x${h}:${p.radius.toFixed(1)}`;
    if (p.edge !== null && p.edge.dash !== undefined) {
      if (fill !== null) shape(p.key, p.owner, [{ closed: true, points: rrect(w, h, p.radius) }], at, fill, null, key);
      const inset = p.edge.width / 2;
      const pts = rrect(w - inset * 2, h - inset * 2, Math.max(0, p.radius - inset));
      shape(`${p.key}~dash`, p.owner, dashed(pts, p.edge.dash[0], p.edge.dash[1]), at, null, { colour: p.edge.colour, width: p.edge.width, progress: 1, character: 'clean' }, `dash:${w}x${h}:${p.radius.toFixed(1)}:${p.edge.dash[0]}`);
      return;
    }
    if (p.edge === null) {
      shape(p.key, p.owner, [{ closed: true, points: rrect(w, h, p.radius) }], at, fill, null, key);
      return;
    }
    // an edge that sits inside the box, as a CSS border does, and a whole pixel at a hairline
    const bw = Math.max(1 / dpr, p.edge.width);
    const inset = bw / 2;
    shape(p.key, p.owner, [{ closed: true, points: rrect(w - inset * 2, h - inset * 2, Math.max(0, p.radius - inset)) }], at, fill, { colour: p.edge.colour, width: bw, progress: 1, character: 'clean' }, `${key}:edge${bw.toFixed(2)}`);
  };

  for (const p of parts) {
    clip = p.clip;
    if (p.kind === 'rect') {
      drawRect(p);
    } else if (p.kind === 'picture') {
      const x0 = snap(p.x);
      const y0 = snap(p.y);
      const w = snap(p.x + p.w) - x0;
      const h = snap(p.y + p.h) - y0;
      if (w <= 0 || h <= 0) continue;
      const kept = boxOf(clip);
      const picture: PictureFrame = {
        kind: 'picture',
        key: p.key,
        id: p.owner,
        layer: 'mid',
        z: z++,
        box: { x: -w / 2, y: -h / 2, width: w, height: h },
        transform: { ...IDENTITY, e: x0 + w / 2 - cx, f: y0 + h / 2 - cy },
        src: p.url,
        develop: 1,
        mask: p.circle === true ? 'circle' : 'none',
        opacity: 1,
        waiting: false,
        tappable: false,
        ...(kept === undefined ? {} : { clip: kept }),
      };
      figures.push(picture);
    } else if (p.kind === 'path') {
      // the points are in pixels: the shape is centred on its own box so a move changes the transform and not the outline
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const l of p.outline) for (const q of l.points) {
        x0 = Math.min(x0, q.x);
        y0 = Math.min(y0, q.y);
        x1 = Math.max(x1, q.x);
        y1 = Math.max(y1, q.y);
      }
      if (!Number.isFinite(x0)) continue;
      const mx = (x0 + x1) / 2;
      const my = (y0 + y1) / 2;
      const local = p.outline.map((l) => ({ closed: l.closed, points: l.points.map((q) => ({ x: q.x - mx, y: q.y - my })) }));
      shape(p.key, p.owner, local, { x: mx, y: my }, p.fill === null ? null : { colour: p.fill, to: null, opacity: p.alpha ?? 1 }, p.stroke === null ? null : { colour: p.stroke.colour, width: Math.max(1, p.stroke.width), progress: 1, character: 'clean' }, `path:${p.key}:${Math.round(x1 - x0)}x${Math.round(y1 - y0)}:${p.outline.length}:${p.outline[0]?.points.length ?? 0}`, undefined, p.stroke === null ? 1 : (p.alpha ?? 1));
    } else {
      p.lines.forEach((line, i) => {
        if (line.text === '') return;
        const text = foldText(line.text);
        const face = p.face ?? 'sans';
        const prefix = prefixEm(text, face, p.weight);
        const total = (prefix[text.length] ?? 0) * p.size;
        const x0 = p.align === 'left' ? p.x : p.align === 'center' ? p.x + (p.w - total) / 2 : p.x + p.w - total;
        const yc = p.y + i * p.line + p.line / 2;
        const cell = p.size * CELL;
        const runs: RunFrame[] = [];
        let index = 0;
        for (const word of text.split(' ')) {
          if (word.length > 0) {
            const from = (prefix[index] ?? 0) * p.size;
            const to = (prefix[index + word.length] ?? 0) * p.size;
            runs.push({ text: word, x: -total / 2 + from, y: -cell / 2, width: to - from, colour: p.colour, opacity: 1, dx: 0, dy: 0, scale: 1, reveal: 1 });
          }
          index += word.length + 1;
        }
        elements.push({
          key: `${p.key}#${i}`,
          id: p.owner,
          layer: 'mid',
          z: z++,
          face,
          x: x0 + total / 2 - cx,
          y: yc - cy,
          width: total,
          height: cell,
          fontSize: p.size,
          stretch: 1,
          weight: p.weight,
          opacity: 1,
          scale: 1,
          rotation: 0,
          runs,
          lines: [{ x: -total / 2, y: -cell / 2, width: total, height: cell }],
          mark: 'none',
          markColour: p.colour,
          strike: 0,
          ghost: false,
          tappable: false,
          plate: 0,
          ...(boxOf(p.clip) === undefined ? {} : { clip: boxOf(p.clip) }),
        });
      });
    }
  }

  const time = o.time ?? 0;
  return {
    time,
    ambient: time,
    wallTime: 0,
    clock: 'idle',
    viewport: { width, height, dpr },
    look: spec.id,
    spec,
    lookChange: null,
    bodySize: 16,
    margin: 16,
    canvas: { box: { x: -cx, y: -cy, width, height }, unit: 1 },
    gridTop: -cy,
    ground: spec.roles.ground,
    camera: REST_POSE,
    agitation: 0,
    dim: 0,
    reducedMotion: true,
    elements,
    figures,
    fields: [],
    cursor: null,
  };
}
