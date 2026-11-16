// SVG in, Series lines out, for the art bake-off (PLAN-art.md, section 6 "Validation, whoever made the sheet").
// The document is read by a small strict reader of our own (no DOCTYPE, no entities, no CDATA, no text), checked against an allow-list,
// its transforms baked in, and every part written by `serializeLine` and read back by `parseLine`: the page never receives SVG.
// Nothing here touches the network, the disk or a browser.

import { LIMITS, parseLine, serializeLine } from '@conduit/language';
import type { Line } from '@conduit/language';

export const SVG_CAPS = { bytes: 64 * 1024, parts: 24, commands: 400, depth: 8, emitted: 48 } as const;

export type Converted =
  | { readonly ok: true; readonly lines: readonly Line[]; readonly text: readonly string[]; readonly parts: number; readonly ids: readonly string[] }
  | { readonly ok: false; readonly reason: string };

class Reject extends Error {}
const no = (reason: string): never => {
  throw new Reject(reason);
};

// ---- the reader ----

interface El {
  readonly tag: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: El[];
}

const SHAPE_TAGS = new Set(['path', 'circle', 'ellipse', 'rect', 'polygon', 'polyline', 'line']);
const TAGS = new Set([...SHAPE_TAGS, 'g', 'svg']);
const GEOMETRY: Readonly<Record<string, readonly string[]>> = {
  svg: ['viewBox', 'width', 'height', 'xmlns', 'version'],
  g: [],
  path: ['d'],
  circle: ['cx', 'cy', 'r'],
  ellipse: ['cx', 'cy', 'rx', 'ry'],
  rect: ['x', 'y', 'width', 'height', 'rx', 'ry'],
  polygon: ['points'],
  polyline: ['points'],
  line: ['x1', 'y1', 'x2', 'y2'],
};
const STYLE_ATTRS = ['id', 'fill', 'stroke', 'stroke-width', 'opacity', 'transform'];
/** Harmless presentation hints a model writes by habit; read and ignored. */
const IGNORED_ATTRS = new Set(['stroke-linecap', 'stroke-linejoin', 'fill-rule', 'clip-rule', 'fill-opacity', 'stroke-opacity']);

export function readXml(source: string): El {
  if (Buffer.byteLength(source, 'utf8') > SVG_CAPS.bytes) no(`the document is over ${SVG_CAPS.bytes} bytes`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(source)) no('control characters');
  let at = 0;
  const stack: El[] = [];
  let root: El | null = null;
  const text = source.replace(/^﻿/, '');
  const head = /^\s*<\?xml[^>]*\?>/.exec(text);
  if (head !== null) at = head[0].length;
  while (at < text.length) {
    const open = text.indexOf('<', at);
    const between = text.slice(at, open < 0 ? text.length : open);
    if (between.trim() !== '') no('text inside the document');
    if (open < 0) break;
    if (text.startsWith('<!--', open)) {
      const close = text.indexOf('-->', open + 4);
      if (close < 0) no('an unclosed comment');
      at = close + 3;
      continue;
    }
    if (text[open + 1] === '!' || text[open + 1] === '?') no('a DOCTYPE, entity, CDATA or processing instruction');
    const close = text.indexOf('>', open);
    if (close < 0) no('an unclosed tag');
    const inner = text.slice(open + 1, close);
    at = close + 1;
    if (inner.startsWith('/')) {
      const name = inner.slice(1).trim();
      const top = stack.pop();
      if (top === undefined || top.tag !== name) no(`a mismatched </${name}>`);
      continue;
    }
    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const tagMatch = /^([A-Za-z][A-Za-z0-9]*)((?:\s+[^\s=]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*$/.exec(body);
    if (tagMatch === null) no('a tag the reader cannot take: ' + body.slice(0, 40));
    const [, tag = '', attrText = ''] = tagMatch ?? [];
    if (!TAGS.has(tag)) no(`the element <${tag}> is not allowed`);
    const attrs: Record<string, string> = {};
    for (const m of attrText.matchAll(/\s+([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      const name = m[1] ?? '';
      const value = m[2] ?? m[3] ?? '';
      if (name in attrs) no(`attribute ${name} twice`);
      attrs[name] = value;
    }
    const element: El = { tag, attrs, children: [] };
    const parent = stack[stack.length - 1];
    if (parent === undefined) {
      if (root !== null) no('more than one root element');
      if (tag !== 'svg') no('the root must be <svg>');
      root = element;
    } else {
      if (parent.tag !== 'g' && parent.tag !== 'svg') no(`<${tag}> inside <${parent.tag}>`);
      parent.children.push(element);
    }
    if (!selfClosing) {
      stack.push(element);
      if (stack.length > SVG_CAPS.depth) no('nested too deep');
    }
  }
  if (stack.length > 0) no('an unclosed element');
  if (root === null) no('no <svg> element');
  return root as unknown as El;
}

function checkAttributes(el: El): void {
  const allowed = new Set([...(GEOMETRY[el.tag] ?? []), ...(el.tag === 'svg' ? [] : STYLE_ATTRS), ...(el.tag === 'svg' ? ['id'] : [])]);
  for (const [name, value] of Object.entries(el.attrs)) {
    const lower = name.toLowerCase();
    if (lower.includes('href') || lower.startsWith('on') || lower === 'style' || lower.startsWith('xlink')) no(`the attribute ${name} is not allowed`);
    if (/url\s*\(|javascript:|data:|&|<|@import|expression\s*\(/i.test(value)) no(`the value of ${name} holds something that is not allowed`);
    if (name === 'xmlns') {
      if (value !== 'http://www.w3.org/2000/svg') no('xmlns must be the SVG namespace');
      continue;
    }
    if (IGNORED_ATTRS.has(name)) continue;
    if (!allowed.has(name)) no(`the attribute ${name} on <${el.tag}> is not allowed`);
  }
}

// ---- numbers, colours, transforms ----

type Matrix = readonly [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const times = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const scaleOf = (m: Matrix): number => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
const axisAligned = (m: Matrix): boolean => Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9;

const num = (text: string | undefined, what: string, fallback?: number): number => {
  if (text === undefined || text.trim() === '') {
    if (fallback !== undefined) return fallback;
    return no(`${what} is missing`);
  }
  const t = text.trim().replace(/(px)?$/, '');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return no(`${what} is not a plain number: ${text.slice(0, 20)}`);
  const v = Number(t);
  if (!Number.isFinite(v) || Math.abs(v) > 1e5) return no(`${what} is out of range`);
  return v;
};
const numbers = (text: string, what: string): number[] => {
  const found = text.trim().split(/[\s,]+/).filter((s) => s !== '');
  return found.map((s) => num(s, what));
};

function transformOf(text: string | undefined): Matrix {
  if (text === undefined || text.trim() === '') return IDENTITY;
  let m = IDENTITY;
  let rest = text.trim();
  while (rest !== '') {
    const part = /^(translate|scale|rotate|matrix|skewX|skewY)\s*\(([^)]*)\)\s*,?\s*/.exec(rest);
    if (part === null) return no(`a transform the reader does not take: ${rest.slice(0, 30)}`);
    rest = rest.slice(part[0].length);
    const a = numbers(part[2] ?? '', 'a transform value');
    const at = (i: number, d = 0): number => a[i] ?? d;
    let t: Matrix;
    switch (part[1]) {
      case 'translate': t = [1, 0, 0, 1, at(0), at(1)]; break;
      case 'scale': t = [at(0, 1), 0, 0, at(1, at(0, 1)), 0, 0]; break;
      case 'rotate': {
        const r = (at(0) * Math.PI) / 180;
        const rot: Matrix = [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0];
        t = a.length >= 3 ? times(times([1, 0, 0, 1, at(1), at(2)], rot), [1, 0, 0, 1, -at(1), -at(2)]) : rot;
        break;
      }
      case 'matrix': if (a.length !== 6) return no('matrix() needs six numbers'); t = [at(0), at(1), at(2), at(3), at(4), at(5)]; break;
      case 'skewX': t = [1, 0, Math.tan((at(0) * Math.PI) / 180), 1, 0, 0]; break;
      default: t = [1, Math.tan((at(0) * Math.PI) / 180), 0, 1, 0, 0]; break;
    }
    m = times(m, t);
  }
  return m;
}

const NAMED: Readonly<Record<string, string>> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00', orange: '#ffa500', purple: '#800080',
  pink: '#ffc0cb', brown: '#a52a2a', gray: '#808080', grey: '#808080', silver: '#c0c0c0', gold: '#ffd700', tan: '#d2b48c', beige: '#f5f5dc',
  ivory: '#fffff0', navy: '#000080', teal: '#008080', maroon: '#800000', olive: '#808000', lime: '#00ff00', cyan: '#00ffff', aqua: '#00ffff',
};
const hex2 = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

/** `none` or a #rrggbb. Anything else (a gradient, a pattern, currentColor, inherit) rejects. */
function colourOf(text: string, what: string): string {
  const t = text.trim().toLowerCase();
  if (t === 'none' || t === 'transparent') return 'none';
  const h = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(t);
  if (h !== null) {
    const v = h[1] ?? '';
    return `#${v.length === 3 ? v.split('').map((c) => c + c).join('') : v}`;
  }
  const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(t);
  if (rgb !== null) return `#${hex2(Number(rgb[1]))}${hex2(Number(rgb[2]))}${hex2(Number(rgb[3]))}`;
  const named = NAMED[t];
  if (named !== undefined) return named;
  return no(`${what} is not a colour the reader takes: ${text.slice(0, 24)}`);
}

// ---- paths ----

type Seg = ['M', number, number] | ['L', number, number] | ['C', number, number, number, number, number, number] | ['Q', number, number, number, number] | ['Z'];

/** An SVG arc as cubic Béziers (the standard endpoint-to-centre conversion). */
function arcToCubics(x1: number, y1: number, rxIn: number, ryIn: number, phiDeg: number, large: boolean, sweep: boolean, x2: number, y2: number): Seg[] {
  if (x1 === x2 && y1 === y2) return [];
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0) return [['L', x2, y2]];
  const phi = (phiDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const sign = large === sweep ? -1 : 1;
  const numer = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const denom = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const co = denom === 0 ? 0 : sign * Math.sqrt(Math.max(0, numer / denom));
  const cxp = (co * rx * y1p) / ry;
  const cyp = (-co * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number): number => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  const n = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9));
  const step = delta / n;
  const k = (4 / 3) * Math.tan(step / 4);
  const out: Seg[] = [];
  let t = theta1;
  const point = (a: number): [number, number] => [cx + rx * Math.cos(a) * cos - ry * Math.sin(a) * sin, cy + rx * Math.cos(a) * sin + ry * Math.sin(a) * cos];
  const deriv = (a: number): [number, number] => [-rx * Math.sin(a) * cos - ry * Math.cos(a) * sin, -rx * Math.sin(a) * sin + ry * Math.cos(a) * cos];
  for (let i = 0; i < n; i += 1) {
    const [px, py] = point(t);
    const [qx, qy] = point(t + step);
    const [dpx, dpy] = deriv(t);
    const [dqx, dqy] = deriv(t + step);
    out.push(['C', px + k * dpx, py + k * dpy, qx - k * dqx, qy - k * dqy, i === n - 1 ? x2 : qx, i === n - 1 ? y2 : qy]);
    t += step;
  }
  return out;
}

const ARGS: Readonly<Record<string, number>> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

/** Path data to absolute M, L, C, Q and Z segments; counts the commands read. */
function segmentsOf(d: string): { segs: Seg[]; commands: number } {
  const tokens = d.match(/[a-zA-Z]|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g) ?? [];
  if (tokens.join('').length < d.replace(/[\s,]/g, '').length) no('path data holds something that is not a command or a number');
  const segs: Seg[] = [];
  let i = 0;
  let cmd = '';
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  let lastC: [number, number] | null = null;
  let lastQ: [number, number] | null = null;
  let commands = 0;
  const read = (): number => {
    const t = tokens[i];
    if (t === undefined || /^[a-zA-Z]$/.test(t)) return no('path data is cut short');
    i += 1;
    return Number(t);
  };
  while (i < tokens.length) {
    const t = tokens[i] ?? '';
    if (/^[a-zA-Z]$/.test(t)) {
      if (!(t.toUpperCase() in ARGS)) no(`the path command ${t} is not a command`);
      cmd = t;
      i += 1;
      if (cmd.toUpperCase() === 'Z') {
        segs.push(['Z']);
        x = sx;
        y = sy;
        commands += 1;
        lastC = lastQ = null;
        continue;
      }
    } else if (cmd === '' || cmd.toUpperCase() === 'Z') return no('path data starts with a number');
    commands += 1;
    if (commands > SVG_CAPS.commands) no(`more than ${SVG_CAPS.commands} path commands`);
    const rel = cmd === cmd.toLowerCase();
    const up = cmd.toUpperCase();
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    let nextC: [number, number] | null = null;
    let nextQ: [number, number] | null = null;
    if (up === 'M') {
      x = ox + read();
      y = oy + read();
      sx = x;
      sy = y;
      segs.push(['M', x, y]);
      cmd = rel ? 'l' : 'L';
    } else if (up === 'L') {
      x = ox + read();
      y = oy + read();
      segs.push(['L', x, y]);
    } else if (up === 'H') {
      x = ox + read();
      segs.push(['L', x, y]);
    } else if (up === 'V') {
      y = oy + read();
      segs.push(['L', x, y]);
    } else if (up === 'C' || up === 'S') {
      let x1: number;
      let y1: number;
      if (up === 'C') {
        x1 = ox + read();
        y1 = oy + read();
      } else {
        [x1, y1] = lastC === null ? [x, y] : [2 * x - lastC[0], 2 * y - lastC[1]];
      }
      const x2 = ox + read();
      const y2 = oy + read();
      const ex = ox + read();
      const ey = oy + read();
      segs.push(['C', x1, y1, x2, y2, ex, ey]);
      nextC = [x2, y2];
      x = ex;
      y = ey;
    } else if (up === 'Q' || up === 'T') {
      let x1: number;
      let y1: number;
      if (up === 'Q') {
        x1 = ox + read();
        y1 = oy + read();
      } else {
        [x1, y1] = lastQ === null ? [x, y] : [2 * x - lastQ[0], 2 * y - lastQ[1]];
      }
      const ex = ox + read();
      const ey = oy + read();
      segs.push(['Q', x1, y1, ex, ey]);
      nextQ = [x1, y1];
      x = ex;
      y = ey;
    } else {
      const rx = read();
      const ry = read();
      const rot = read();
      const large = read() !== 0;
      const sweep = read() !== 0;
      const ex = ox + read();
      const ey = oy + read();
      segs.push(...arcToCubics(x, y, rx, ry, rot, large, sweep, ex, ey));
      x = ex;
      y = ey;
    }
    lastC = nextC;
    lastQ = nextQ;
  }
  if (segs.length === 0 || segs[0]?.[0] !== 'M') no('path data does not begin with a move');
  return { segs, commands };
}

const ellipseSegs = (cx: number, cy: number, rx: number, ry: number): Seg[] => {
  const k = 0.5522847498;
  return [
    ['M', cx + rx, cy],
    ['C', cx + rx, cy + k * ry, cx + k * rx, cy + ry, cx, cy + ry],
    ['C', cx - k * rx, cy + ry, cx - rx, cy + k * ry, cx - rx, cy],
    ['C', cx - rx, cy - k * ry, cx - k * rx, cy - ry, cx, cy - ry],
    ['C', cx + k * rx, cy - ry, cx + rx, cy - k * ry, cx + rx, cy],
    ['Z'],
  ];
};

// ---- the walk ----

interface Paint {
  readonly fill: string;
  readonly stroke: string;
  readonly width: number;
  readonly opacity: number;
}

const r1 = (n: number): string => String(Math.round(n * 10) / 10 + 0);
const r2 = (n: number): string => String(Math.round(n * 100) / 100 + 0);

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20);

interface Raw {
  readonly id: string;
  /** the verb's own text after the id: geometry, then props */
  readonly build: (digits: (n: number) => string) => string;
}

/**
 * Converts an SVG document to Series lines: a `group` at the middle of a square canvas and one shape line per part, `in=` that group.
 * The 100 x 100 box maps onto the `square` canvas (100 x 100) centred on the stage; a different viewBox is scaled to fit it.
 */
export function convertSvg(source: string, group = 'fig'): Converted {
  try {
    const root = readXml(source);
    const box = root.attrs['viewBox'] === undefined ? [0, 0, 100, 100] : numbers(root.attrs['viewBox'], 'the viewBox');
    if (box.length !== 4 || (box[2] ?? 0) <= 0 || (box[3] ?? 0) <= 0) no('the viewBox is not four numbers');
    const fit = Math.min(100 / (box[2] ?? 100), 100 / (box[3] ?? 100));
    // into the 100 box, then to the group's own coordinates (centre at 50,50)
    const base: Matrix = times([1, 0, 0, 1, -50, -50], times([fit, 0, 0, fit, 50 - ((box[2] ?? 100) * fit) / 2, 50 - ((box[3] ?? 100) * fit) / 2], [1, 0, 0, 1, -(box[0] ?? 0), -(box[1] ?? 0)]));
    checkAttributes(root);
    const parts: Raw[] = [];
    let leaves = 0;
    let commands = 0;
    const used = new Set<string>([group]);
    const idFor = (el: El, kind: string): string => {
      let id = slug(el.attrs['id'] ?? '') || kind;
      if (/^\d/.test(id)) id = `p-${id}`.slice(0, 22);
      let candidate = id;
      for (let n = 2; used.has(candidate); n += 1) candidate = `${id.slice(0, 20)}${n}`;
      used.add(candidate);
      return candidate;
    };
    const walk = (el: El, matrix: Matrix, inherited: Paint): void => {
      checkAttributes(el);
      const m = times(matrix, transformOf(el.attrs['transform']));
      const own: Paint = {
        fill: el.attrs['fill'] === undefined ? inherited.fill : colourOf(el.attrs['fill'], 'fill'),
        stroke: el.attrs['stroke'] === undefined ? inherited.stroke : colourOf(el.attrs['stroke'], 'stroke'),
        width: el.attrs['stroke-width'] === undefined ? inherited.width : num(el.attrs['stroke-width'], 'stroke-width'),
        opacity: el.attrs['opacity'] === undefined ? inherited.opacity : inherited.opacity * Math.max(0, Math.min(1, num(el.attrs['opacity'], 'opacity'))),
      };
      if (el.tag === 'g' || el.tag === 'svg') {
        for (const child of el.children) walk(child, m, own);
        return;
      }
      leaves += 1;
      if (leaves > SVG_CAPS.parts) no(`more than ${SVG_CAPS.parts} parts`);
      const styleOf = (fill: string, stroke: string): string => {
        const bits = [`fill=${fill}`, `stroke=${stroke}`];
        if (stroke !== 'none') bits.push(`thick=${r2(Math.max(0.1, own.width * scaleOf(m)))}`);
        if (own.opacity < 0.995) bits.push(`opacity=${r2(own.opacity)}`);
        return bits.join(' ');
      };
      const id = idFor(el, el.tag);
      const a = el.attrs;
      const pointsOf = (text: string): [number, number][] => {
        const n = numbers(text, 'points');
        if (n.length < 4 || n.length % 2 !== 0) no('points need pairs');
        if (n.length / 2 > LIMITS.points) no('too many points');
        const out: [number, number][] = [];
        for (let k = 0; k < n.length; k += 2) out.push(apply(m, n[k] ?? 0, n[k + 1] ?? 0));
        return out;
      };
      const pathOf = (segs: Seg[]): void => {
        // Series fills even-odd and SVG fills non-zero, so a compound path is split at each move: one part per sub-path.
        const subs: Seg[][] = [];
        for (const seg of segs) {
          if (seg[0] === 'M') subs.push([]);
          subs[subs.length - 1]?.push(seg);
        }
        subs.forEach((sub, k) => {
          const subId = k === 0 ? id : idFor({ tag: 'path', attrs: { id: `${id}-${k + 1}` }, children: [] }, 'path');
          const mapped = sub.map((s): Seg => {
            if (s[0] === 'Z') return s;
            if (s[0] === 'M' || s[0] === 'L') {
              const [x, y] = apply(m, s[1], s[2]);
              return [s[0], x, y];
            }
            if (s[0] === 'Q') {
              const [x1, y1] = apply(m, s[1], s[2]);
              const [x, y] = apply(m, s[3], s[4]);
              return ['Q', x1, y1, x, y];
            }
            const [x1, y1] = apply(m, s[1], s[2]);
            const [x2, y2] = apply(m, s[3], s[4]);
            const [x, y] = apply(m, s[5], s[6]);
            return ['C', x1, y1, x2, y2, x, y];
          });
          parts.push({
            id: subId,
            build: (digits) => `path ${subId} in=${group} ${styleOf(own.fill, own.stroke)} | ${mapped.map((s) => (s[0] === 'Z' ? 'Z' : `${s[0]}${s.slice(1).map((v) => digits(v as number)).join(' ')}`)).join(' ')}`,
          });
        });
      };
      switch (el.tag) {
        case 'path': {
          const parsed = segmentsOf(a['d'] ?? no('a path with no d'));
          commands += parsed.commands;
          if (commands > SVG_CAPS.commands) no(`more than ${SVG_CAPS.commands} path commands`);
          pathOf(parsed.segs);
          break;
        }
        case 'circle':
        case 'ellipse': {
          const cx = num(a['cx'], 'cx', 0);
          const cy = num(a['cy'], 'cy', 0);
          const rx = num(el.tag === 'circle' ? a['r'] : a['rx'], 'the radius');
          const ry = el.tag === 'circle' ? rx : num(a['ry'], 'ry');
          if (rx <= 0 || ry <= 0) no('a radius is not positive');
          const [x, y] = apply(m, cx, cy);
          if (axisAligned(m)) {
            const sx = Math.abs(m[0]);
            const sy = Math.abs(m[3]);
            if (Math.abs(sx - sy) < 1e-9 && rx === ry) parts.push({ id, build: () => `circle ${id} ${r2(x)},${r2(y)} ${r2(rx * sx)} in=${group} ${styleOf(own.fill, own.stroke)}` });
            else parts.push({ id, build: () => `ellipse ${id} ${r2(x)},${r2(y)} ${r2(rx * sx)}x${r2(ry * sy)} in=${group} ${styleOf(own.fill, own.stroke)}` });
          } else pathOf(ellipseSegs(cx, cy, rx, ry));
          break;
        }
        case 'rect': {
          const x0 = num(a['x'], 'x', 0);
          const y0 = num(a['y'], 'y', 0);
          const w = num(a['width'], 'width');
          const h = num(a['height'], 'height');
          if (w <= 0 || h <= 0) no('a rect with no size');
          if (axisAligned(m)) {
            const [x, y] = apply(m, x0, y0);
            const [x2, y2] = apply(m, x0 + w, y0 + h);
            const radius = a['rx'] === undefined && a['ry'] === undefined ? 0 : Math.min(num(a['rx'] ?? a['ry'], 'rx'), w / 2, h / 2) * Math.abs(m[0]);
            parts.push({ id, build: () => `rect ${id} ${r2(Math.min(x, x2))},${r2(Math.min(y, y2))} ${r2(Math.abs(x2 - x))}x${r2(Math.abs(y2 - y))}${radius > 0 ? ` r=${r2(radius)}` : ''} in=${group} ${styleOf(own.fill, own.stroke)}` });
          } else {
            const corners = [apply(m, x0, y0), apply(m, x0 + w, y0), apply(m, x0 + w, y0 + h), apply(m, x0, y0 + h)];
            parts.push({ id, build: (digits) => `poly ${id} ${corners.map(([px, py]) => `${digits(px)},${digits(py)}`).join(' ')} in=${group} ${styleOf(own.fill, own.stroke)}` });
          }
          break;
        }
        case 'polygon': {
          const pts = pointsOf(a['points'] ?? no('a polygon with no points'));
          parts.push({ id, build: (digits) => `poly ${id} ${pts.map(([px, py]) => `${digits(px)},${digits(py)}`).join(' ')} in=${group} ${styleOf(own.fill, own.stroke)}` });
          break;
        }
        case 'polyline': {
          const pts = pointsOf(a['points'] ?? no('a polyline with no points'));
          const filled = own.fill !== 'none';
          parts.push({ id, build: (digits) => `${filled ? 'poly' : 'line'} ${id} ${pts.map(([px, py]) => `${digits(px)},${digits(py)}`).join(' ')} in=${group} ${styleOf(filled ? own.fill : 'none', own.stroke === 'none' && !filled ? '#000000' : own.stroke)}` });
          break;
        }
        default: {
          const p1 = apply(m, num(a['x1'], 'x1', 0), num(a['y1'], 'y1', 0));
          const p2 = apply(m, num(a['x2'], 'x2', 0), num(a['y2'], 'y2', 0));
          parts.push({ id, build: (digits) => `line ${id} ${digits(p1[0])},${digits(p1[1])} ${digits(p2[0])},${digits(p2[1])} in=${group} ${styleOf('none', own.stroke === 'none' ? '#000000' : own.stroke)}` });
        }
      }
    };
    walk(root, base, { fill: '#000000', stroke: 'none', width: 1, opacity: 1 });
    if (parts.length === 0) no('no drawable parts');
    if (parts.length > SVG_CAPS.emitted) no(`${parts.length} parts after splitting compound paths (at most ${SVG_CAPS.emitted})`);

    const texts: string[] = [`group ${group} at=50,50`];
    for (const part of parts) {
      let text = part.build(r2);
      if (text.length > LIMITS.line) text = part.build(r1);
      if (text.length > LIMITS.line) no(`the part ${part.id} is over ${LIMITS.line} characters`);
      texts.push(text);
    }
    // Written by serializeLine, read back by parseLine: what is sent is what the language itself would write.
    const lines: Line[] = [];
    const canonical: string[] = [];
    for (const raw of texts) {
      const parsed = parseLine(raw);
      if (parsed.kind !== 'line') return { ok: false, reason: `the language rejects "${raw.slice(0, 60)}": ${parsed.kind === 'reject' ? parsed.issues.map((i) => i.message).join('; ') : parsed.kind}` };
      const text = serializeLine(parsed.line);
      const back = parseLine(text);
      if (back.kind !== 'line') return { ok: false, reason: `a part does not read back: ${text.slice(0, 60)}` };
      if (text.length > LIMITS.line) return { ok: false, reason: `a part is over ${LIMITS.line} characters` };
      lines.push(back.line);
      canonical.push(text);
    }
    return { ok: true, lines, text: canonical, parts: parts.length, ids: parts.map((p) => p.id) };
  } catch (error) {
    if (error instanceof Reject) return { ok: false, reason: error.message };
    throw error;
  }
}
