// One frame as a vector drawing.

import type { Affine, Clip, ElementFrame, FigureFrame, Frame, PictureFrame, ShapeFrame, SpriteFrame } from '../contracts/frame';
import type { FontResolver, RendererFont } from '../contracts/renderer';
import { layerZ, projectToScreen } from '../contracts/space';
import { chartBoxOf, clipQuad } from '../render/place';
import type { Vec3 } from '../contracts/space';
import type { Layer } from '@conduit/language';
import { mixHex } from '../painter/affine';
import { hasDevice, startsRtl } from '../fonts/fold';
import { INK_PAD } from '../render/formula/drawing';
import { formulaCanvas } from '../render/formula/host';

export interface SvgSize {
  readonly width: number;
  readonly height: number;
}

const LAYER_ORDER: Readonly<Record<Layer, number>> = { far: 0, bg: 1, mid: 2, fg: 3 };

const n = (value: number): string => {
  const rounded = Math.round(value * 100) / 100;
  return String(Object.is(rounded, -0) ? 0 : rounded);
};

const escapeXml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Maps a point of a layer's plane to the screen. Exact: it is the camera's own projection. */
type Projector = (x: number, y: number) => { x: number; y: number; scale: number };

function projectorFor(frame: Frame, layer: Layer): Projector {
  const z = layerZ(layer, frame.viewport);
  return (x, y) => projectToScreen({ x, y, z } satisfies Vec3, frame.camera, frame.viewport);
}

/** The affine that best maps plane coordinates near (cx, cy) to the screen: exact at that point, and the camera's own scale around it. */
function localAffine(project: Projector, cx: number, cy: number): Affine {
  const o = project(cx, cy);
  const px = project(cx + 1, cy);
  const py = project(cx, cy + 1);
  const a = px.x - o.x;
  const b = px.y - o.y;
  const c = py.x - o.x;
  const d = py.y - o.y;
  return { a, b, c, d, e: o.x - (a * cx + c * cy), f: o.y - (b * cx + d * cy) };
}

function multiply(m: Affine, k: Affine): Affine {
  return {
    a: m.a * k.a + m.c * k.b,
    b: m.b * k.a + m.d * k.b,
    c: m.a * k.c + m.c * k.d,
    d: m.b * k.c + m.d * k.d,
    e: m.a * k.e + m.c * k.f + m.e,
    f: m.b * k.e + m.d * k.f + m.f,
  };
}

const matrix = (m: Affine): string => `matrix(${n(m.a)} ${n(m.b)} ${n(m.c)} ${n(m.d)} ${n(m.e)} ${n(m.f)})`;

function apply(m: Affine, x: number, y: number): { x: number; y: number } {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

function meanScale(m: Affine): number {
  return Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
}

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

const dataUrls = new Map<string, Promise<string>>();

function dataUrlOf(url: string, fallbackType: string): Promise<string> {
  const cached = dataUrls.get(url);
  if (cached !== undefined) return cached;
  const pending = (async () => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`could not read ${url} for the drawing`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() || fallbackType;
    return `data:${type};base64,${bytesToBase64(bytes)}`;
  })();
  dataUrls.set(url, pending);
  pending.catch(() => dataUrls.delete(url));
  return pending;
}

function lineBoxFor(element: ElementFrame, y: number): { y: number; height: number } {
  let best = element.lines[0];
  let bestGap = Infinity;
  for (const box of element.lines) {
    const gap = y >= box.y && y <= box.y + box.height ? 0 : Math.min(Math.abs(y - box.y), Math.abs(y - (box.y + box.height)));
    if (gap < bestGap) {
      best = box;
      bestGap = gap;
    }
  }
  return best === undefined ? { y, height: element.fontSize * 1.3 } : { y: best.y, height: best.height };
}

/**
 * Keeps a drawn thing inside its frame (`Clip`): the frame as it lies through the frame's camera, as a clip path in the
 * picture's own coordinates. Nothing of the thing outside it is in the file's drawing.
 */
function framed(svg: string, clip: Clip | undefined, layer: Layer, frame: Frame, defs: string[]): string {
  if (clip === undefined || svg === '') return svg;
  const id = `k-${defs.length}`;
  const points = clipQuad(clip, layer, frame.camera, frame.viewport)
    .map((p) => `${n(p.x)},${n(p.y)}`)
    .join(' ');
  defs.push(`<clipPath id="${id}"><polygon points="${points}"/></clipPath>`);
  return `<g clip-path="url(#${id})">${svg}</g>`;
}

interface Piece {
  readonly layer: number;
  readonly z: number;
  readonly order: number;
  readonly svg: string;
}

function textSvg(element: ElementFrame, frame: Frame, fonts: Map<string, RendererFont>, resolve: FontResolver | undefined): string {
  const project = projectorFor(frame, element.layer);
  const base = localAffine(project, element.x, element.y);
  const cos = Math.cos(element.rotation) * element.scale;
  const sin = Math.sin(element.rotation) * element.scale;
  const local = multiply(base, { a: cos, b: sin, c: -sin, d: cos, e: element.x, f: element.y });
  const out: string[] = [];
  const font = resolve?.(element.face, element.weight === 'bold');
  if (font !== undefined) fonts.set(font.family, font);
  const family = font === undefined ? 'sans-serif' : font.family;
  const stretch = element.stretch > 0 ? element.stretch : 1;

  if (element.plate > 0.001) {
    for (const box of element.lines) {
      out.push(`<rect x="${n(box.x)}" y="${n(box.y)}" width="${n(box.width)}" height="${n(box.height)}" fill="${frame.ground}" fill-opacity="${n(element.plate * element.opacity)}"/>`);
    }
  }
  for (const box of element.lines) {
    if (element.mark === 'invert') out.push(`<rect x="${n(box.x)}" y="${n(box.y)}" width="${n(box.width)}" height="${n(box.height)}" fill="${element.markColour}" fill-opacity="${n(element.opacity)}"/>`);
    if (element.mark === 'box') out.push(`<rect x="${n(box.x + 1)}" y="${n(box.y + 1)}" width="${n(Math.max(0, box.width - 2))}" height="${n(Math.max(0, box.height - 2))}" fill="none" stroke="${element.markColour}" stroke-width="${n(Math.max(1.25 / Math.max(meanScale(local), 0.01), element.fontSize * 0.06))}" stroke-opacity="${n(element.opacity)}"/>`);
    if (element.mark === 'underline') {
      const y = box.y + box.height - element.fontSize * 0.08;
      out.push(`<line x1="${n(box.x)}" y1="${n(y)}" x2="${n(box.x + box.width)}" y2="${n(y)}" stroke="${element.markColour}" stroke-width="${n(Math.max(1.25 / Math.max(meanScale(local), 0.01), element.fontSize * 0.06))}" stroke-opacity="${n(element.opacity)}"/>`);
    }
    const struck = element.mark === 'strike' ? 1 : element.strike;
    if (struck > 0.001) {
      const y = box.y + box.height / 2;
      const ink = element.runs[0]?.colour ?? element.markColour;
      out.push(`<line x1="${n(box.x)}" y1="${n(y)}" x2="${n(box.x + box.width * Math.min(1, struck))}" y2="${n(y)}" stroke="${ink}" stroke-width="${n(Math.max(1.25 / Math.max(meanScale(local), 0.01), element.fontSize * 0.07))}" stroke-opacity="${n(element.opacity)}"/>`);
    }
  }
  for (const run of element.runs) {
    if (run.text === '' || run.opacity * element.opacity <= 0.001 || run.reveal <= 0.001) continue;
    if (element.formula !== undefined) {
      // A typeset formula is its picture, as a chart is: what KaTeX set, drawn on a canvas in the run's ink, at the box the layout gave it and the room round the ink.
      const picture = formulaCanvas(element.formula.tex, element.formula.display, element.formula.raster, run.colour);
      if (picture === null) continue;
      const pad = INK_PAD * element.fontSize;
      const reveal = run.reveal < 0.999 ? ` clip-path="inset(0 ${n((1 - run.reveal) * 100)}% 0 0)"` : '';
      out.push(`<image href="${picture.toDataURL('image/png')}" x="${n(run.x + run.dx - pad)}" y="${n(run.y + run.dy - pad)}" width="${n(run.width + 2 * pad)}" height="${n(element.height + 2 * pad)}" preserveAspectRatio="none"${run.opacity < 0.999 ? ` opacity="${n(run.opacity)}"` : ''}${reveal}/>`);
      continue;
    }
    const box = lineBoxFor(element, run.y);
    const cx = run.x + run.dx + run.width / 2;
    const cy = box.y + run.dy + box.height / 2;
    const clip = run.reveal < 0.999 ? ` clip-path="inset(0 ${n((1 - run.reveal) * 100)}% 0 0)"` : '';
    const transform = run.scale !== 1 ? ` transform="translate(${n(cx)} ${n(cy)}) scale(${n(run.scale)}) translate(${n(-cx)} ${n(-cy)})"` : '';
    // A script the faces lack (Arabic, Indic, Thai, Greek...) is left to the viewer's own shaping: letter spacing would pull joined letters apart, so the run is not
    // stretched to the painter's width, and a run that reads right to left is anchored at its right edge.
    const device = hasDevice(run.text);
    const rtl = device && startsRtl(run.text);
    const x = rtl ? run.x + run.dx + run.width / stretch : run.x + run.dx;
    const fit = device ? (rtl ? ' direction="rtl" unicode-bidi="plaintext" text-anchor="end"' : ' unicode-bidi="plaintext"') : ` textLength="${n(run.width / stretch)}" lengthAdjust="spacing"`;
    out.push(
      `<g${transform}><text x="${n(x)}" y="${n(cy)}" dominant-baseline="central" font-family="${escapeXml(device ? `${family}, sans-serif` : family)}" font-size="${n(element.fontSize)}" fill="${run.colour}" fill-opacity="${n(run.opacity * element.opacity)}"${fit} xml:space="preserve"${stretch !== 1 ? ` transform="translate(${n(run.x + run.dx)} 0) scale(${n(stretch)} 1) translate(${n(-(run.x + run.dx))} 0)"` : ''}${clip}>${escapeXml(run.text)}</text></g>`,
    );
  }
  return `<g id="${escapeXml(element.id)}" transform="${matrix(local)}">${out.join('')}</g>`;
}

/** A value read off stops spread evenly over 0..1, in between by a straight line. */
function across(stops: readonly number[], t: number): number {
  const f = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(f));
  const a = stops[i] ?? 1;
  return a + ((stops[i + 1] ?? a) - a) * (f - i);
}

function colourAcross(stops: readonly string[], t: number): string {
  const f = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(f));
  return mixHex(stops[i] ?? '#000000', stops[i + 1] ?? stops[i] ?? '#000000', f - i);
}

/** A polyline cut at even steps along it, each piece with where along the line (0..1) its middle lies. */
function pieces(points: readonly { x: number; y: number }[], closed: boolean, count: number): { points: { x: number; y: number }[]; middle: number }[] {
  const ring = closed && points.length > 1 ? [...points, points[0] as { x: number; y: number }] : [...points];
  const cumulative = [0];
  for (let i = 1; i < ring.length; i += 1) cumulative.push((cumulative[i - 1] ?? 0) + Math.hypot((ring[i]?.x ?? 0) - (ring[i - 1]?.x ?? 0), (ring[i]?.y ?? 0) - (ring[i - 1]?.y ?? 0)));
  const total = cumulative[cumulative.length - 1] ?? 0;
  if (!(total > 0) || count < 2) return [{ points: [...points], middle: 0.5 }];
  const at = (d: number): { x: number; y: number } => {
    let i = 1;
    while (i < cumulative.length - 1 && (cumulative[i] ?? 0) < d) i += 1;
    const span = (cumulative[i] ?? 0) - (cumulative[i - 1] ?? 0);
    const t = span > 0 ? Math.min(1, Math.max(0, (d - (cumulative[i - 1] ?? 0)) / span)) : 0;
    const p = ring[i - 1] ?? { x: 0, y: 0 };
    const q = ring[i] ?? p;
    return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
  };
  const out: { points: { x: number; y: number }[]; middle: number }[] = [];
  for (let k = 0; k < count; k += 1) {
    const from = (total * k) / count;
    const to = (total * (k + 1)) / count;
    const piece = [at(from)];
    for (let i = 1; i < ring.length - 1; i += 1) if ((cumulative[i] ?? 0) > from && (cumulative[i] ?? 0) < to) piece.push(ring[i] as { x: number; y: number });
    piece.push(at(to));
    out.push({ points: piece, middle: (k + 0.5) / count });
  }
  return out;
}

function shapeSvg(shape: ShapeFrame, frame: Frame, defs: string[]): string {
  const project = projectorFor(frame, shape.layer);
  const a = shape.transform;
  const projected = (lines: ShapeFrame['outline'], matrixOf: Affine = a): { x: number; y: number; scale: number }[][] =>
    lines.map((line) =>
      line.points.map((point) => {
        const plane = apply(matrixOf, point.x, point.y);
        const screen = project(plane.x, plane.y);
        return { x: screen.x, y: screen.y, scale: screen.scale };
      }),
    );
  const polylines = projected(shape.outline);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let scale = 1;
  let counted = 0;
  for (const points of polylines) {
    for (const p of points) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
      scale += p.scale;
      counted += 1;
    }
  }
  if (counted === 0) return '';
  scale = (scale - 1) / counted;
  const unit = meanScale(a) * scale;
  const pathOf = (points: { x: number; y: number }[], closed: boolean): string =>
    points.map((p, i) => `${i === 0 ? 'M' : 'L'}${n(p.x)} ${n(p.y)}`).join('') + (closed ? 'Z' : '');
  const parts: string[] = [];
  const opacity = shape.opacity;
  let fill = 'none';
  let fillOpacity = '';
  if (shape.fill !== null && shape.fill.opacity > 0.001) {
    fillOpacity = ` fill-opacity="${n(shape.fill.opacity)}"`;
    if (shape.fill.to !== null) {
      const id = `g-${defs.length}`;
      const colours = shape.fill.stops ?? [shape.fill.colour, shape.fill.to];
      const stops = colours.map((colour, i) => `<stop offset="${n(i / Math.max(1, colours.length - 1))}" stop-color="${colour}"/>`).join('');
      const centreX = (minX + maxX) / 2;
      const centreY = (minY + maxY) / 2;
      const turn = ((shape.fill.angle ?? 0) * Math.PI) / 180;
      if (shape.fill.radial === true) {
        // From the middle of the box, as wide and as tall as the box: an ellipse in a square box is a circle.
        const half = Math.max((maxX - minX) / 2, 1e-6);
        defs.push(`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${n(centreX)}" cy="${n(centreY)}" r="${n(half)}" gradientTransform="translate(${n(centreX)} ${n(centreY)}) scale(1 ${n((maxY - minY) / 2 / half)}) translate(${n(-centreX)} ${n(-centreY)})">${stops}</radialGradient>`);
      } else {
        const reachX = Math.sin(turn) * (maxX - minX) / 2;
        const reachY = Math.cos(turn) * (maxY - minY) / 2;
        defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${n(centreX - reachX)}" y1="${n(centreY - reachY)}" x2="${n(centreX + reachX)}" y2="${n(centreY + reachY)}">${stops}</linearGradient>`);
      }
      fill = `url(#${id})`;
    } else {
      fill = shape.fill.colour;
    }
  }
  if (fill !== 'none') {
    // A bleeding shape covers the whole picture whatever the camera does (the gradient still runs over the box it would have had).
    const reach = Math.max(frame.viewport.width, frame.viewport.height) * 3;
    const sheet = `M${n(-reach)} ${n(-reach)}H${n(frame.viewport.width + reach)}V${n(frame.viewport.height + reach)}H${n(-reach)}Z`;
    parts.push(`<path d="${shape.bleed ? sheet : polylines.map((points) => pathOf(points, true)).join('')}" fill="${fill}"${fillOpacity} fill-rule="evenodd" stroke="none"/>`);
  }
  const stroke = shape.stroke;
  if (stroke !== null && stroke.progress > 0.0005 && !shape.bleed) {
    const width = Math.max(1.25, stroke.width * unit);
    // The stroke is the dashes when it has been cut into dashes; the fill is always the whole outline.
    const lines = shape.strokeOutline ?? shape.outline;
    const strokes = shape.strokeOutline === undefined ? polylines : projected(lines);
    const lengths = strokes.map((points, i) => {
      let length = 0;
      for (let k = 1; k < points.length; k += 1) length += Math.hypot((points[k]?.x ?? 0) - (points[k - 1]?.x ?? 0), (points[k]?.y ?? 0) - (points[k - 1]?.y ?? 0));
      if (lines[i]?.closed === true && points.length > 1) length += Math.hypot((points[0]?.x ?? 0) - (points[points.length - 1]?.x ?? 0), (points[0]?.y ?? 0) - (points[points.length - 1]?.y ?? 0));
      return length;
    });
    const total = lengths.reduce((sum, length) => sum + length, 0);
    let budget = Math.min(1, stroke.progress) * total;
    const pixel = stroke.character === 'pixel';
    const pressure = stroke.pressure;
    const colours = stroke.along;
    // Pressure and a graded colour are drawn as short pieces, each at the width and colour of where it lies: the stroke's own length is the whole
    // outline when it is dashes and the polyline itself otherwise. While it is still drawing on, it is one piece at the mean.
    const graded = (pressure !== undefined || colours !== undefined) && stroke.progress >= 1 && !pixel;
    let before = 0;
    strokes.forEach((points, i) => {
      const length = lengths[i] ?? 0;
      const closed = lines[i]?.closed ?? false;
      const drawn = Math.min(length, Math.max(0, budget));
      budget -= length;
      const start = before;
      before += length;
      if (drawn <= 0 || points.length === 0) return;
      if (graded && length > 0) {
        const count = Math.max(1, Math.min(32, Math.ceil(length / 8)));
        for (const piece of pieces(points, closed, count)) {
          const where = shape.strokeOutline === undefined ? piece.middle : (start + piece.middle * length) / Math.max(total, 1e-9);
          const w = pressure === undefined ? width : Math.max(1.25, width * across(pressure, where));
          const colour = colours === undefined ? stroke.colour : colourAcross(colours, where);
          parts.push(`<path d="${pathOf(piece.points, false)}" fill="none" stroke="${colour}" stroke-width="${n(w)}" stroke-linecap="round" stroke-linejoin="round"/>`);
        }
        return;
      }
      const mean = pressure === undefined ? 1 : pressure.reduce((sum, share) => sum + share, 0) / pressure.length;
      const dash = drawn >= length - 0.01 ? '' : ` stroke-dasharray="${n(drawn)} ${n(length + 1)}"`;
      const colour = colours === undefined ? stroke.colour : colourAcross(colours, 0.5);
      parts.push(
        `<path d="${pathOf(points, closed)}" fill="none" stroke="${colour}" stroke-width="${n(Math.max(1.25, width * mean))}" stroke-linecap="${pixel ? 'butt' : 'round'}" stroke-linejoin="${pixel ? 'miter' : 'round'}"${dash}/>`,
      );
    });
  }
  // `clip=<id>`: only what lies inside the other shape's outline shows; `blend=`: how it meets what is under it.
  let clipped = '';
  if (shape.clipTo !== undefined && !shape.bleed) {
    const id = `c-${defs.length}`;
    const outline = projected(shape.clipTo.outline, shape.clipTo.transform);
    defs.push(`<clipPath id="${id}"><path d="${outline.map((points) => pathOf(points, true)).join('')}" clip-rule="evenodd"/></clipPath>`);
    clipped = ` clip-path="url(#${id})"`;
  }
  return `<g id="${escapeXml(shape.id)}"${opacity < 0.999 ? ` opacity="${n(opacity)}"` : ''}${clipped}>${parts.join('')}</g>`;
}

function spriteSvg(sprite: SpriteFrame, frame: Frame): string {
  const project = projectorFor(frame, sprite.layer);
  const centre = apply(sprite.transform, 0, 0);
  const local = multiply(localAffine(project, centre.x, centre.y), sprite.transform);
  const out: string[] = [];
  const left = (-sprite.cols * sprite.cell) / 2;
  const top = (-sprite.rows * sprite.cell) / 2;
  const rows = Math.min(sprite.rows, Math.ceil(sprite.landed));
  for (let row = 0; row < rows; row += 1) {
    const rowOpacity = row + 1 <= sprite.landed ? 1 : Math.max(0, sprite.landed - row);
    let col = 0;
    while (col < sprite.cols) {
      const colour = sprite.cells[row * sprite.cols + col] ?? null;
      if (colour === null) {
        col += 1;
        continue;
      }
      let end = col + 1;
      while (end < sprite.cols && sprite.cells[row * sprite.cols + end] === colour) end += 1;
      out.push(
        `<rect x="${n(left + col * sprite.cell)}" y="${n(top + row * sprite.cell)}" width="${n((end - col) * sprite.cell)}" height="${n(sprite.cell)}" fill="${colour}"${rowOpacity < 1 ? ` fill-opacity="${n(rowOpacity)}"` : ''}/>`,
      );
      col = end;
    }
  }
  return `<g id="${escapeXml(sprite.id)}" transform="${matrix(local)}" opacity="${n(sprite.opacity)}" shape-rendering="crispEdges">${out.join('')}</g>`;
}

async function pictureSvg(picture: PictureFrame, frame: Frame, defs: string[]): Promise<string> {
  if (picture.src === null || picture.opacity * picture.develop <= 0.001) return '';
  const project = projectorFor(frame, picture.layer);
  const centre = apply(picture.transform, picture.box.x + picture.box.width / 2, picture.box.y + picture.box.height / 2);
  const local = multiply(localAffine(project, centre.x, centre.y), picture.transform);
  const href = await dataUrlOf(picture.src, 'image/png');
  const { x, y, width, height } = picture.box;
  const id = `p-${defs.length}`;
  let attribute = '';
  if (picture.mask === 'round') {
    defs.push(`<clipPath id="${id}"><rect x="${n(x)}" y="${n(y)}" width="${n(width)}" height="${n(height)}" rx="${n(Math.min(width, height) * 0.08)}"/></clipPath>`);
    attribute = ` clip-path="url(#${id})"`;
  } else if (picture.mask === 'circle') {
    defs.push(`<clipPath id="${id}"><ellipse cx="${n(x + width / 2)}" cy="${n(y + height / 2)}" rx="${n(width / 2)}" ry="${n(height / 2)}"/></clipPath>`);
    attribute = ` clip-path="url(#${id})"`;
  } else if (picture.mask === 'soft') {
    const inset = Math.min(width, height) * 0.08;
    defs.push(`<filter id="${id}f" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="${n(inset * 0.7)}"/></filter><mask id="${id}" maskUnits="userSpaceOnUse" x="${n(x)}" y="${n(y)}" width="${n(width)}" height="${n(height)}"><rect x="${n(x + inset)}" y="${n(y + inset)}" width="${n(width - 2 * inset)}" height="${n(height - 2 * inset)}" fill="#fff" filter="url(#${id}f)"/></mask>`);
    attribute = ` mask="url(#${id})"`;
  } else if (picture.mask === 'torn') {
    let seed = 0;
    for (const ch of picture.key) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };
    const jag = Math.min(width, height) * 0.02;
    const points: string[] = [];
    const steps = 24;
    for (let i = 0; i < steps; i += 1) points.push(`${n(x + (width * i) / steps)},${n(y + random() * jag)}`);
    for (let i = 0; i < steps; i += 1) points.push(`${n(x + width - random() * jag)},${n(y + (height * i) / steps)}`);
    for (let i = steps; i > 0; i -= 1) points.push(`${n(x + (width * i) / steps)},${n(y + height - random() * jag)}`);
    for (let i = steps; i > 0; i -= 1) points.push(`${n(x + random() * jag)},${n(y + (height * i) / steps)}`);
    defs.push(`<clipPath id="${id}"><polygon points="${points.join(' ')}"/></clipPath>`);
    attribute = ` clip-path="url(#${id})"`;
  }
  return `<g id="${escapeXml(picture.id)}" transform="${matrix(local)}" opacity="${n(picture.opacity * picture.develop)}"><image href="${href}" x="${n(x)}" y="${n(y)}" width="${n(width)}" height="${n(height)}" preserveAspectRatio="xMidYMid slice"${attribute}/></g>`;
}

/**
 * A self-contained SVG of `frame` as seen through its camera: shapes as
 * paths with their fills and strokes (a part-drawn stroke as a dash), sprites
 * as crisp rectangles, text as <text> in fonts embedded as data URLs with
 * each run positioned exactly where the painter put it, paintings embedded,
 * the look's flat ground. No surface effects and no fields (weather is named in a
 * `<desc>`): an SVG is the drawing, not the screen it was shown on. `size` is the file's own size
 * (its `viewBox`); the drawing is fitted into it, centred, keeping its aspect.
 */
export async function frameToSvg(frame: Frame, size?: SvgSize, resolve?: FontResolver, chartStill?: (key: string) => HTMLCanvasElement | null): Promise<string> {
  const width = size?.width ?? frame.viewport.width;
  const height = size?.height ?? frame.viewport.height;
  const fit = Math.min(width / frame.viewport.width, height / frame.viewport.height);
  const offsetX = (width - frame.viewport.width * fit) / 2;
  const offsetY = (height - frame.viewport.height * fit) / 2;

  const defs: string[] = [];
  const fonts = new Map<string, RendererFont>();
  const pieces: Piece[] = [];
  let order = 0;

  for (const element of frame.elements) {
    if (element.opacity <= 0.001 || element.runs.length === 0) continue;
    pieces.push({ layer: LAYER_ORDER[element.layer], z: element.z, order: order++, svg: framed(textSvg(element, frame, fonts, resolve), element.clip, element.layer, frame, defs) });
  }
  const figures: readonly FigureFrame[] = frame.figures;
  // A painting the renderer makes itself is a shader's work and has no vector form: its sketch is drawn as it is, whole, and the file says so.
  const sketched = new Map<string, number>();
  const media = new Set<string>();
  for (const figure of figures) {
    if (figure.kind !== 'picture' || figure.medium === undefined || figure.src !== null || figure.opacity * figure.develop <= 0.001) continue;
    media.add(figure.medium);
    for (const key of figure.sketch ?? []) sketched.set(key, figure.opacity);
  }
  for (const figure of figures) {
    const whole = figure.kind === 'shape' ? sketched.get(figure.key) : undefined;
    if (figure.opacity <= 0.001 && whole === undefined) continue;
    let svg = '';
    if (figure.kind === 'shape') svg = shapeSvg(whole === undefined ? figure : { ...figure, opacity: Math.max(figure.opacity, whole), stroke: figure.stroke === null ? null : { ...figure.stroke, progress: Math.max(figure.stroke.progress, 1) } }, frame, defs);
    else if (figure.kind === 'sprite') svg = spriteSvg(figure, frame);
    else svg = await pictureSvg(figure, frame, defs);
    // A shape that bleeds covers the whole picture and is not framed.
    const frameOf = figure.kind === 'shape' && figure.bleed ? undefined : figure.clip;
    // A blend (`blend=`) goes on the outermost group: a clip path makes a group of its own, and a blend inside one finds nothing under it.
    const blend = figure.kind === 'shape' ? figure.blend : undefined;
    const framedSvg = framed(svg, frameOf, figure.layer, frame, defs);
    if (svg !== '') pieces.push({ layer: LAYER_ORDER[figure.layer], z: figure.z, order: order++, svg: blend === undefined ? framedSvg : `<g style="mix-blend-mode:${blend}">${framedSvg}</g>` });
  }
  pieces.sort((p, q) => p.layer - q.layer || p.z - q.z || p.order - q.order);

  // Charts lie over the stage: each is its engine's own still, as a picture, at the box it has on the screen.
  const charts: string[] = [];
  if (chartStill !== undefined) {
    for (const chart of [...(frame.charts ?? [])].sort((a, b) => a.z - b.z)) {
      if (chart.opacity <= 0.001) continue;
      const still = chartStill(chart.key);
      if (still === null) continue;
      const box = chartBoxOf(chart, frame);
      charts.push(framed(`<image id="${escapeXml(chart.id)}" href="${still.toDataURL('image/png')}" x="${n(box.x)}" y="${n(box.y)}" width="${n(box.width)}" height="${n(box.height)}" preserveAspectRatio="none"${chart.opacity < 0.999 ? ` opacity="${n(chart.opacity)}"` : ''}/>`, chart.clip, chart.layer, frame, defs));
    }
  }

  const faces: string[] = [];
  for (const font of fonts.values()) {
    const data = await dataUrlOf(font.url, font.format === 'opentype' ? 'font/otf' : 'font/ttf');
    faces.push(`@font-face{font-family:"${font.family}";src:url(${data}) format("${font.format}");}`);
  }

  const roll = frame.camera.roll;
  const rolled = Math.abs(roll) > 1e-6 ? ` transform="rotate(${n((roll * 180) / Math.PI)} ${n(frame.viewport.width / 2)} ${n(frame.viewport.height / 2)})"` : '';
  const title = escapeXml(frame.spec.name);
  // Weather is the screen's, not the drawing's: say so in the file rather than leave it out without a word.
  const weather = [...new Set(frame.fields.filter((field) => field.opacity > 0.001).map((field) => field.field))];
  const left: string[] = [];
  if (weather.length > 0) left.push(`${escapeXml(weather.join(', '))} (weather belongs to the moving picture)`);
  if (media.size > 0) left.push(`the ${escapeXml([...media].join(', '))} treatment of the painting (a shader's work: its sketch is drawn instead)`);
  const note = left.length === 0 ? '' : `<desc>Not drawn in this file: ${left.join('; ')}.</desc>`;
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n(width)}" height="${n(height)}" viewBox="0 0 ${n(width)} ${n(height)}">`,
    `<title>${title}</title>`,
    ...(note === '' ? [] : [note]),
    `<defs>${faces.length > 0 ? `<style>${faces.join('')}</style>` : ''}${defs.join('')}</defs>`,
    `<rect width="${n(width)}" height="${n(height)}" fill="${frame.ground}"/>`,
    `<g transform="translate(${n(offsetX)} ${n(offsetY)}) scale(${n(fit)})"><svg width="${n(frame.viewport.width)}" height="${n(frame.viewport.height)}" viewBox="0 0 ${n(frame.viewport.width)} ${n(frame.viewport.height)}" overflow="hidden"><g${rolled}>`,
    ...pieces.map((piece) => piece.svg),
    `</g>`,
    ...charts,
    `</svg></g>`,
    `</svg>`,
  ].join('\n');
}
