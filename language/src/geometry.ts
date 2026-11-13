// The geometry of drawn shapes, in canvas units. It lives in the language,
// not the painter, for the same reason timing does: how long a stroke takes
// to draw depends on how long it is, and the server and the painter must get
// the same answer from the same line. The painter also uses these functions
// to draw, morph and travel along shapes, so there is one definition of what
// a `path` means.

import type { CanvasBox, PathCommand, Point, ShapeGeometry } from './types';
import { LIMITS } from './vocabulary';

export interface Polyline {
  readonly points: readonly Point[];
  readonly closed: boolean;
}

/** Path numbers are held to the range coordinates are everywhere else, so a stray `1e308` cannot make a length infinite. */
const PATH_LIMIT = 1000;

const COMMAND_LETTERS = 'MmLlHhVvCcSsQqTtAaZz';
const ARGUMENTS: Readonly<Record<string, number>> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

class PathReader {
  private index = 0;
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  private skipSeparators(): void {
    while (this.index < this.source.length && /[\s,]/.test(this.source.charAt(this.index))) this.index += 1;
  }

  get done(): boolean {
    this.skipSeparators();
    return this.index >= this.source.length;
  }

  command(): string | null {
    this.skipSeparators();
    const char = this.source.charAt(this.index);
    if (char === '' || !COMMAND_LETTERS.includes(char)) return null;
    this.index += 1;
    return char;
  }

  number(): number | null {
    this.skipSeparators();
    const match = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(this.source.slice(this.index, this.index + 32));
    if (match === null) return null;
    this.index += match[0].length;
    const value = Number(match[0]);
    return Number.isFinite(value) ? Math.max(-PATH_LIMIT, Math.min(PATH_LIMIT, value)) : null;
  }

  /** Arc flags may be written without a separator (`a1 1 0 01 5 5`), so a flag is exactly one character. */
  flag(): number | null {
    this.skipSeparators();
    const char = this.source.charAt(this.index);
    if (char !== '0' && char !== '1') return null;
    this.index += 1;
    return Number(char);
  }

  skipToCommand(): void {
    while (this.index < this.source.length && !COMMAND_LETTERS.includes(this.source.charAt(this.index))) this.index += 1;
  }
}

function arcToCubics(x0: number, y0: number, rxIn: number, ryIn: number, degrees: number, large: boolean, sweep: boolean, x: number, y: number): PathCommand[] {
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0 || (x0 === x && y0 === y)) return [{ op: 'L', x, y }];
  const phi = (degrees * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x0 - x) / 2;
  const dy = (y0 - y) / 2;
  const x1 = cos * dx + sin * dy;
  const y1 = -sin * dx + cos * dy;
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const numerator = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const factor = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, numerator / denominator));
  const cxp = (factor * rx * y1) / ry;
  const cyp = (-factor * ry * x1) / rx;
  const cx = cos * cxp - sin * cyp + (x0 + x) / 2;
  const cy = sin * cxp + cos * cyp + (y0 + y) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number): number => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const start = angle(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry);
  let delta = angle((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  const segments = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9));
  const step = delta / segments;
  const handle = (4 / 3) * Math.tan(step / 4);
  const out: PathCommand[] = [];
  const point = (theta: number): Point => ({
    x: cx + rx * Math.cos(theta) * cos - ry * Math.sin(theta) * sin,
    y: cy + rx * Math.cos(theta) * sin + ry * Math.sin(theta) * cos,
  });
  const tangent = (theta: number): Point => ({
    x: -rx * Math.sin(theta) * cos - ry * Math.cos(theta) * sin,
    y: -rx * Math.sin(theta) * sin + ry * Math.cos(theta) * cos,
  });
  for (let i = 0; i < segments; i += 1) {
    const a = start + i * step;
    const b = a + step;
    const from = point(a);
    const to = point(b);
    const ta = tangent(a);
    const tb = tangent(b);
    out.push({ op: 'C', x1: from.x + handle * ta.x, y1: from.y + handle * ta.y, x2: to.x - handle * tb.x, y2: to.y - handle * tb.y, x: to.x, y: to.y });
  }
  return out;
}

/**
 * Reads SVG path data. Every command, relative or absolute, is reduced to
 * absolute M, L, C and Z. Reading is forgiving in the way the line parser is:
 * a command that cannot be read is skipped and named in `problems`, and
 * whatever was understood is kept.
 */
export function parsePathData(d: string): { commands: PathCommand[]; problems: string[] } {
  const reader = new PathReader(d);
  const commands: PathCommand[] = [];
  const problems: string[] = [];
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let controlX = 0;
  let controlY = 0;
  let previous = '';
  let letter: string | null = null;

  while (!reader.done && commands.length < LIMITS.points) {
    const next = reader.command();
    if (next !== null) letter = next;
    else if (letter === null || letter === 'Z' || letter === 'z') {
      problems.push('path data must start with M');
      reader.skipToCommand();
      continue;
    } else if (letter === 'M') letter = 'L';
    else if (letter === 'm') letter = 'l';

    const upper = letter.toUpperCase();
    const relative = letter !== upper;
    const count = ARGUMENTS[upper] ?? 0;
    const args: number[] = [];
    let ok = true;
    for (let i = 0; i < count; i += 1) {
      const value = upper === 'A' && (i === 3 || i === 4) ? reader.flag() : reader.number();
      if (value === null) {
        ok = false;
        break;
      }
      args.push(value);
    }
    if (!ok) {
      problems.push(`"${letter}" needs ${count} numbers`);
      reader.skipToCommand();
      continue;
    }
    if (commands.length === 0 && upper !== 'M') {
      // A path that forgets its M starts where it first goes to.
      commands.push({ op: 'M', x, y });
    }
    const ax = (value: number): number => (relative ? x + value : value);
    const ay = (value: number): number => (relative ? y + value : value);
    const arg = (index: number): number => args[index] ?? 0;

    switch (upper) {
      case 'M':
        x = ax(arg(0));
        y = ay(arg(1));
        startX = x;
        startY = y;
        commands.push({ op: 'M', x, y });
        break;
      case 'L':
        x = ax(arg(0));
        y = ay(arg(1));
        commands.push({ op: 'L', x, y });
        break;
      case 'H':
        x = ax(arg(0));
        commands.push({ op: 'L', x, y });
        break;
      case 'V':
        y = ay(arg(0));
        commands.push({ op: 'L', x, y });
        break;
      case 'C': {
        const command: PathCommand = { op: 'C', x1: ax(arg(0)), y1: ay(arg(1)), x2: ax(arg(2)), y2: ay(arg(3)), x: ax(arg(4)), y: ay(arg(5)) };
        controlX = command.x2;
        controlY = command.y2;
        x = command.x;
        y = command.y;
        commands.push(command);
        break;
      }
      case 'S': {
        const smooth = previous === 'C' || previous === 'S';
        const command: PathCommand = {
          op: 'C',
          x1: smooth ? 2 * x - controlX : x,
          y1: smooth ? 2 * y - controlY : y,
          x2: ax(arg(0)),
          y2: ay(arg(1)),
          x: ax(arg(2)),
          y: ay(arg(3)),
        };
        controlX = command.x2;
        controlY = command.y2;
        x = command.x;
        y = command.y;
        commands.push(command);
        break;
      }
      case 'Q':
      case 'T': {
        const smooth = previous === 'Q' || previous === 'T';
        const qx = upper === 'Q' ? ax(arg(0)) : smooth ? 2 * x - controlX : x;
        const qy = upper === 'Q' ? ay(arg(1)) : smooth ? 2 * y - controlY : y;
        const ex = upper === 'Q' ? ax(arg(2)) : ax(arg(0));
        const ey = upper === 'Q' ? ay(arg(3)) : ay(arg(1));
        commands.push({ op: 'C', x1: x + (2 / 3) * (qx - x), y1: y + (2 / 3) * (qy - y), x2: ex + (2 / 3) * (qx - ex), y2: ey + (2 / 3) * (qy - ey), x: ex, y: ey });
        controlX = qx;
        controlY = qy;
        x = ex;
        y = ey;
        break;
      }
      case 'A': {
        const ex = ax(arg(5));
        const ey = ay(arg(6));
        commands.push(...arcToCubics(x, y, arg(0), arg(1), arg(2), arg(3) === 1, arg(4) === 1, ex, ey));
        x = ex;
        y = ey;
        break;
      }
      case 'Z':
        commands.push({ op: 'Z' });
        x = startX;
        y = startY;
        break;
    }
    previous = upper;
  }
  if (!reader.done) problems.push(`path cut off after ${LIMITS.points} steps`);
  return { commands, problems };
}

function cubicPoint(p0: Point, c: Extract<PathCommand, { op: 'C' }>, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const e = 3 * u * t * t;
  const f = t * t * t;
  return { x: a * p0.x + b * c.x1 + e * c.x2 + f * c.x, y: a * p0.y + b * c.y1 + e * c.y2 + f * c.y };
}

function flattenCommands(commands: readonly PathCommand[]): Polyline[] {
  const out: Polyline[] = [];
  let points: Point[] = [];
  let closed = false;
  const finish = (): void => {
    if (points.length > 1) out.push({ points, closed });
    points = [];
    closed = false;
  };
  for (const command of commands) {
    if (command.op === 'M') {
      finish();
      points.push({ x: command.x, y: command.y });
    } else if (command.op === 'L') {
      points.push({ x: command.x, y: command.y });
    } else if (command.op === 'C') {
      const from = points[points.length - 1] ?? { x: command.x1, y: command.y1 };
      const span = Math.hypot(command.x1 - from.x, command.y1 - from.y) + Math.hypot(command.x2 - command.x1, command.y2 - command.y1) + Math.hypot(command.x - command.x2, command.y - command.y2);
      const steps = Math.max(4, Math.min(32, Math.ceil(span / 2)));
      for (let i = 1; i <= steps; i += 1) points.push(cubicPoint(from, command, i / steps));
    } else {
      closed = true;
      const first = points[0];
      finish();
      if (first !== undefined) points.push(first);
    }
  }
  finish();
  return out;
}

function ellipsePoints(cx: number, cy: number, rx: number, ry: number): Point[] {
  const steps = Math.max(24, Math.min(96, Math.ceil((Math.PI * (rx + ry)) / 1.5)));
  const points: Point[] = [];
  // Starts at the top and runs clockwise, the way a hand draws a circle.
  for (let i = 0; i < steps; i += 1) {
    const theta = -Math.PI / 2 + (i / steps) * 2 * Math.PI;
    points.push({ x: cx + rx * Math.cos(theta), y: cy + ry * Math.sin(theta) });
  }
  return points;
}

function rectPoints(x: number, y: number, w: number, h: number, radius: number): Point[] {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  if (r === 0) return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  const points: Point[] = [];
  const corner = (cx: number, cy: number, from: number): void => {
    for (let i = 0; i <= 6; i += 1) {
      const theta = from + (i / 6) * (Math.PI / 2);
      points.push({ x: cx + r * Math.cos(theta), y: cy + r * Math.sin(theta) });
    }
  };
  corner(x + w - r, y + r, -Math.PI / 2);
  corner(x + w - r, y + h - r, 0);
  corner(x + r, y + h - r, Math.PI / 2);
  corner(x + r, y + r, Math.PI);
  return points;
}

/** A shape as polylines in canvas units: what is stroked, filled, morphed and travelled along. */
export function outlineOf(geometry: ShapeGeometry): Polyline[] {
  switch (geometry.shape) {
    case 'circle':
      return [{ points: ellipsePoints(geometry.cx, geometry.cy, geometry.r, geometry.r), closed: true }];
    case 'ellipse':
      return [{ points: ellipsePoints(geometry.cx, geometry.cy, geometry.rx, geometry.ry), closed: true }];
    case 'rect':
      return [{ points: rectPoints(geometry.x, geometry.y, geometry.w, geometry.h, geometry.r), closed: true }];
    case 'line':
      return geometry.points.length > 1 ? [{ points: geometry.points, closed: false }] : [];
    case 'poly':
      return geometry.points.length > 2 ? [{ points: geometry.points, closed: true }] : [];
    case 'path':
      return flattenCommands(geometry.commands);
  }
}

export function polylineLength(line: Polyline): number {
  let total = 0;
  for (let i = 1; i < line.points.length; i += 1) {
    const a = line.points[i - 1];
    const b = line.points[i];
    if (a !== undefined && b !== undefined) total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  const first = line.points[0];
  const last = line.points[line.points.length - 1];
  if (line.closed && first !== undefined && last !== undefined) total += Math.hypot(first.x - last.x, first.y - last.y);
  return total;
}

/** The length of everything a pen would have to travel to draw the shape, canvas units. */
export function lengthOf(geometry: ShapeGeometry): number {
  return outlineOf(geometry).reduce((total, line) => total + polylineLength(line), 0);
}

export function boundsOf(geometry: ShapeGeometry): CanvasBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const line of outlineOf(geometry)) {
    for (const point of line.points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  }
  if (minX === Infinity) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** The point a share `t` (0..1) of the way along a polyline, by length. */
export function pointAlong(line: Polyline, t: number): Point {
  const points = line.closed && line.points[0] !== undefined ? [...line.points, line.points[0]] : line.points;
  const first = points[0];
  if (first === undefined) return { x: 0, y: 0 };
  const target = Math.min(1, Math.max(0, t)) * polylineLength(line);
  let travelled = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    if (a === undefined || b === undefined) continue;
    const segment = Math.hypot(b.x - a.x, b.y - a.y);
    if (travelled + segment >= target && segment > 0) {
      const share = (target - travelled) / segment;
      return { x: a.x + (b.x - a.x) * share, y: a.y + (b.y - a.y) * share };
    }
    travelled += segment;
  }
  return points[points.length - 1] ?? first;
}

/** `count` points evenly spaced by length along a polyline: what two shapes are reduced to before one morphs into the other. */
export function resample(line: Polyline, count: number): Point[] {
  const points: Point[] = [];
  const steps = Math.max(2, count);
  for (let i = 0; i < steps; i += 1) points.push(pointAlong(line, line.closed ? i / steps : i / (steps - 1)));
  return points;
}
