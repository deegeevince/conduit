// Small pure builders for what a control is drawn from: rectangles, circles,
// chevrons, parts. Everything is in the control's own coordinates (stage
// units, origin at its centre).

import type { Polyline } from '@conduit/language';
import type { BlockPart, TextSpec } from '../../contracts/blocks';
import type { Box } from '../../contracts/space';

type Role = Extract<BlockPart, { kind: 'shape' }>['role'];
type TextRole = Extract<BlockPart, { kind: 'text' }>['role'];

/** A closed rectangle, corners rounded by `radius` (clamped), clockwise from the top-left. */
export function rectLine(box: Box, radius = 0): Polyline {
  const { x, y, width: w, height: h } = box;
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  if (r < 0.5) {
    return {
      points: [
        { x, y },
        { x: x + w, y },
        { x: x + w, y: y + h },
        { x, y: y + h },
      ],
      closed: true,
    };
  }
  const steps = Math.max(2, Math.ceil(r / 3));
  const points: { x: number; y: number }[] = [];
  const corner = (cx: number, cy: number, from: number): void => {
    for (let i = 0; i <= steps; i += 1) {
      const a = from + (i / steps) * (Math.PI / 2);
      points.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
    }
  };
  corner(x + w - r, y + r, -Math.PI / 2);
  corner(x + w - r, y + h - r, 0);
  corner(x + r, y + h - r, Math.PI / 2);
  corner(x + r, y + r, Math.PI);
  return { points, closed: true };
}

export function circleLine(cx: number, cy: number, r: number): Polyline {
  const n = Math.max(12, Math.min(40, Math.ceil(r * 1.5)));
  const points = Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
  });
  return { points, closed: true };
}

export function segment(x0: number, y0: number, x1: number, y1: number): Polyline {
  return {
    points: [
      { x: x0, y: y0 },
      { x: x1, y: y1 },
    ],
    closed: false,
  };
}

/** A chevron pointing `dir`, `size` tall, centred on (cx, cy). */
export function chevron(cx: number, cy: number, size: number, dir: 'left' | 'right' | 'down'): Polyline {
  const s = size / 2;
  const t = s / 2;
  const points =
    dir === 'down'
      ? [
          { x: cx - s, y: cy - t },
          { x: cx, y: cy + t },
          { x: cx + s, y: cy - t },
        ]
      : dir === 'left'
        ? [
            { x: cx + t, y: cy - s },
            { x: cx - t, y: cy },
            { x: cx + t, y: cy + s },
          ]
        : [
            { x: cx - t, y: cy - s },
            { x: cx + t, y: cy },
            { x: cx - t, y: cy + s },
          ];
  return { points, closed: false };
}

export function shapePart(owner: string, part: string, role: Role, outline: readonly Polyline[]): BlockPart {
  return { kind: 'shape', owner, part, role, outline };
}

export function textPart(owner: string, part: string, role: TextRole, text: string, box: Box, spec: TextSpec, align: 'left' | 'center' | 'right', plate = false): BlockPart {
  return { kind: 'text', owner, part, text, emphasis: [], box, spec, align, role, plate };
}

export function inflate(box: Box, by: number): Box {
  return { x: box.x - by, y: box.y - by, width: box.width + 2 * by, height: box.height + 2 * by };
}

/** The box with its shorter side grown to at least `min`, about its centre: a target no smaller than a finger. */
export function atLeast(box: Box, min: number): Box {
  const width = Math.max(box.width, min);
  const height = Math.max(box.height, min);
  return { x: box.x - (width - box.width) / 2, y: box.y - (height - box.height) / 2, width, height };
}

export function contains(box: Box, x: number, y: number): boolean {
  return x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height;
}
