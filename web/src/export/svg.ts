// One frame as a vector drawing.

import type { Affine, ElementFrame, FigureFrame, Frame, PictureFrame, ShapeFrame, SpriteFrame } from '../contracts/frame';
import type { FontResolver, RendererFont } from '../contracts/renderer';
import { layerZ, projectToScreen } from '../contracts/space';
import type { Vec3 } from '../contracts/space';
import type { Layer } from '@conduit/language';

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
    const box = lineBoxFor(element, run.y);
    const cx = run.x + run.dx + run.width / 2;
    const cy = box.y + run.dy + box.height / 2;
    const clip = run.reveal < 0.999 ? ` clip-path="inset(0 ${n((1 - run.reveal) * 100)}% 0 0)"` : '';
    const transform = run.scale !== 1 ? ` transform="translate(${n(cx)} ${n(cy)}) scale(${n(run.scale)}) translate(${n(-cx)} ${n(-cy)})"` : '';
    out.push(
      `<g${transform}><text x="${n(run.x + run.dx)}" y="${n(cy)}" dominant-baseline="central" font-family="${escapeXml(family)}" font-size="${n(element.fontSize)}" fill="${run.colour}" fill-opacity="${n(run.opacity * element.opacity)}" textLength="${n(run.width / stretch)}" lengthAdjust="spacing" xml:space="preserve"${stretch !== 1 ? ` transform="translate(${n(run.x + run.dx)} 0) scale(${n(stretch)} 1) translate(${n(-(run.x + run.dx))} 0)"` : ''}${clip}>${escapeXml(run.text)}</text></g>`,
    );
  }
  return `<g id="${escapeXml(element.id)}" transform="${matrix(local)}">${out.join('')}</g>`;
}

function shapeSvg(shape: ShapeFrame, frame: Frame, defs: string[]): string {
  const project = projectorFor(frame, shape.layer);
  const a = shape.transform;
  const polylines = shape.outline.map((line) =>
    line.points.map((point) => {
      const plane = apply(a, point.x, point.y);
      const screen = project(plane.x, plane.y);
      return { x: screen.x, y: screen.y, scale: screen.scale };
    }),
  );
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
      defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="${n(minY)}" x2="0" y2="${n(maxY)}"><stop offset="0" stop-color="${shape.fill.colour}"/><stop offset="1" stop-color="${shape.fill.to}"/></linearGradient>`);
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
    const lengths = polylines.map((points, i) => {
      let length = 0;
      for (let k = 1; k < points.length; k += 1) length += Math.hypot((points[k]?.x ?? 0) - (points[k - 1]?.x ?? 0), (points[k]?.y ?? 0) - (points[k - 1]?.y ?? 0));
      if (shape.outline[i]?.closed === true && points.length > 1) length += Math.hypot((points[0]?.x ?? 0) - (points[points.length - 1]?.x ?? 0), (points[0]?.y ?? 0) - (points[points.length - 1]?.y ?? 0));
      return length;
    });
    const total = lengths.reduce((sum, length) => sum + length, 0);
    let budget = Math.min(1, stroke.progress) * total;
    const pixel = stroke.character === 'pixel';
    polylines.forEach((points, i) => {
      const length = lengths[i] ?? 0;
      const closed = shape.outline[i]?.closed ?? false;
      const drawn = Math.min(length, Math.max(0, budget));
      budget -= length;
      if (drawn <= 0 || points.length === 0) return;
      const dash = drawn >= length - 0.01 ? '' : ` stroke-dasharray="${n(drawn)} ${n(length + 1)}"`;
      parts.push(
        `<path d="${pathOf(points, closed)}" fill="none" stroke="${stroke.colour}" stroke-width="${n(width)}" stroke-linecap="${pixel ? 'butt' : 'round'}" stroke-linejoin="${pixel ? 'miter' : 'round'}"${dash}/>`,
      );
    });
  }
  return `<g id="${escapeXml(shape.id)}"${opacity < 0.999 ? ` opacity="${n(opacity)}"` : ''}>${parts.join('')}</g>`;
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
export async function frameToSvg(frame: Frame, size?: SvgSize, resolve?: FontResolver): Promise<string> {
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
    pieces.push({ layer: LAYER_ORDER[element.layer], z: element.z, order: order++, svg: textSvg(element, frame, fonts, resolve) });
  }
  const figures: readonly FigureFrame[] = frame.figures;
  for (const figure of figures) {
    if (figure.opacity <= 0.001) continue;
    let svg = '';
    if (figure.kind === 'shape') svg = shapeSvg(figure, frame, defs);
    else if (figure.kind === 'sprite') svg = spriteSvg(figure, frame);
    else svg = await pictureSvg(figure, frame, defs);
    if (svg !== '') pieces.push({ layer: LAYER_ORDER[figure.layer], z: figure.z, order: order++, svg });
  }
  pieces.sort((p, q) => p.layer - q.layer || p.z - q.z || p.order - q.order);

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
  const note = weather.length === 0 ? '' : `<desc>Not drawn in this file: ${escapeXml(weather.join(', '))} (weather belongs to the moving picture).</desc>`;
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n(width)}" height="${n(height)}" viewBox="0 0 ${n(width)} ${n(height)}">`,
    `<title>${title}</title>`,
    ...(note === '' ? [] : [note]),
    `<defs>${faces.length > 0 ? `<style>${faces.join('')}</style>` : ''}${defs.join('')}</defs>`,
    `<rect width="${n(width)}" height="${n(height)}" fill="${frame.ground}"/>`,
    `<g transform="translate(${n(offsetX)} ${n(offsetY)}) scale(${n(fit)})"><svg width="${n(frame.viewport.width)}" height="${n(frame.viewport.height)}" viewBox="0 0 ${n(frame.viewport.width)} ${n(frame.viewport.height)}" overflow="hidden"><g${rolled}>`,
    ...pieces.map((piece) => piece.svg),
    `</g></svg></g>`,
    `</svg>`,
  ].join('\n');
}
