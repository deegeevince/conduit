import { PROCEDURAL_MEDIA, STROKES, TEXTURES, chartModelOf } from '@conduit/language';
import type { AmbientKind, ClockState, InkRole, Layer, LookId, Mark, Mask, Size, StrokeCharacter } from '@conduit/language';
import type { ChartState } from '../contracts/chart';
import type { ChartTheme } from '../contracts/chart';
import type { ChartFrame, ElementFrame, FigureFrame, FieldFrame, Frame, PictureFrame, Quality, RunFrame, ShapeFrame, SpriteFrame } from '../contracts/frame';
import type { LookSpec } from '../contracts/look';
import { planeScale } from '../contracts/space';
import type { Box, CameraPose, Viewport } from '../contracts/space';
import { prefixEm } from '../fonts/measure';
import { LOOKS } from '../looks';
import { fitCanvas } from '../painter/canvas';
import { safeFrame } from '../painter/layout/metrics';

/** What the bench draws besides text: one of each figure, and a field. */
export interface FixtureFigures {
  /** `text`, `figures` or `both` */
  readonly content: 'text' | 'figures' | 'both' | 'paint';
  /** how much of the wavy path is drawn, 0..1 */
  readonly progress: number;
  /** how many rows of the sprite have landed */
  readonly landed: number;
  /** how far the painting has grown, 0..1 */
  readonly develop: number;
  readonly mask: Mask;
  /** a blob URL of a painting, already preloaded, or null */
  readonly picture: string | null;
  readonly character: StrokeCharacter;
  readonly field: AmbientKind | null;
  readonly fieldLayer: Layer;
  readonly density: number;
  readonly strokeWidth: number;
}

export const NO_FIGURES: FixtureFigures = {
  content: 'text',
  progress: 0.5,
  landed: 3.5,
  develop: 0.5,
  mask: 'none',
  picture: null,
  character: 'clean',
  field: null,
  fieldLayer: 'mid',
  density: 0.5,
  strokeWidth: 3,
};

export interface FixtureOptions {
  /** replaces the preset's spec: the bench's custom looks and effect sliders */
  readonly spec?: LookSpec;
  readonly figures?: FixtureFigures;
  /** the reveal sweeps, one element slides, the cursor blinks */
  readonly animate?: boolean;
  readonly agitation?: number;
  readonly dim?: number;
  readonly reducedMotion?: boolean;
  readonly clock?: ClockState;
  readonly wallTime?: number;
  readonly quality?: Quality;
}

interface Spec {
  readonly key: string;
  readonly text: string;
  readonly size: Size;
  readonly role: InkRole;
  readonly mark?: Mark;
  readonly markRole?: InkRole;
  readonly reveal?: number;
  readonly opacity?: number;
  readonly ghost?: boolean;
  readonly strike?: number;
  readonly bold?: boolean;
  readonly tappable?: boolean;
}

/** The same arithmetic the painter uses, kept here so the bench needs no painter. */
export function benchBodySize(viewport: Viewport, look: LookSpec): number {
  const margin = Math.max(16, look.margin * Math.min(viewport.width, viewport.height));
  const wanted = (viewport.width - 2 * margin) / (look.type.targetCols * look.type.advance);
  return Math.round(Math.min(look.type.maxBody, Math.max(look.type.minBody, wanted)));
}

function build(look: LookSpec, body: number, spec: Spec, left: number, top: number, layerScale: number, dx: number): ElementFrame {
  const scale = look.type.sizes[spec.size];
  const unit = body / layerScale;
  const natural = unit * scale.y;
  const fontSize = Math.max(look.type.minFont / layerScale, natural);
  const k = fontSize / natural;
  const cellH = unit * look.type.lineHeight * scale.y * k;
  const weight = spec.bold === true ? 'bold' : 'normal';
  const prefix = prefixEm(spec.text, look.type.face, weight);
  const toStage = fontSize * (scale.x / scale.y);
  const width = (prefix[spec.text.length] ?? 0) * toStage;
  const runs: RunFrame[] = [];
  let index = 0;
  for (const word of spec.text.split(' ')) {
    if (word.length > 0) {
      const from = (prefix[index] ?? 0) * toStage;
      const to = (prefix[index + word.length] ?? 0) * toStage;
      runs.push({
        text: word,
        x: -width / 2 + from,
        y: -cellH / 2,
        width: to - from,
        colour: look.roles[spec.role],
        opacity: 1,
        dx: 0,
        dy: 0,
        scale: 1,
        reveal: spec.reveal ?? 1,
      });
    }
    index += word.length + 1;
  }
  const line: Box = { x: -width / 2, y: -cellH / 2, width, height: cellH };
  const invert = spec.mark === 'invert';
  return {
    key: spec.key,
    id: spec.key,
    layer: 'mid',
    x: (left + dx) / layerScale + width / 2,
    y: top / layerScale + cellH / 2,
    width,
    height: cellH,
    fontSize,
    stretch: scale.x / scale.y,
    weight: spec.bold === true ? 'bold' : 'normal',
    opacity: spec.opacity ?? 1,
    scale: 1,
    rotation: 0,
    runs: invert ? runs.map((run) => ({ ...run, colour: look.roles.ground })) : runs,
    lines: [line],
    mark: spec.mark ?? 'none',
    markColour: look.roles[spec.markRole ?? (invert ? 'ink' : spec.role)],
    strike: spec.strike ?? 0,
    ghost: spec.ghost ?? false,
    tappable: spec.tappable ?? false,
    z: 0,
    face: look.type.face,
    plate: 0,
  };
}

/**
 * A hand-built Frame that exercises everything a renderer must draw: all
 * three layers, every size, every ink role, every mark, a half-revealed run,
 * a struck ghost and a cursor.
 */
export function fixtureFrame(look: LookId, viewport: Viewport, camera: CameraPose, ambient: number, options: FixtureOptions = {}): Frame {
  const spec = options.spec ?? LOOKS[look];
  const shown = options.figures ?? NO_FIGURES;
  const body = benchBodySize(viewport, spec);
  const margin = Math.max(16, spec.margin * Math.min(viewport.width, viewport.height));
  const left = -viewport.width / 2 + margin;
  const lineH = body * spec.type.lineHeight;
  const animate = options.animate === true;
  const wide = viewport.width >= 700;
  const midScale = 1;

  const elements: ElementFrame[] = [];
  let top = -viewport.height / 2 + margin;
  const grid = spec.type.snapToCells ? lineH : 0;
  const onGrid = (y: number): number => {
    if (grid === 0) return y;
    const origin = -viewport.height / 2 + margin;
    return origin + Math.ceil((y - origin) / grid - 1e-6) * grid;
  };
  const push = (item: Spec, x: number, y: number, dx = 0): ElementFrame => {
    const element = build(spec, body, item, x, onGrid(y), midScale, dx);
    elements.push(element);
    return element;
  };

  const showText = shown.content !== 'figures' && shown.content !== 'paint';
  const sizes: readonly Size[] = ['xs', 's', 'm', 'l', 'xl', 'xxl'];
  const roles: readonly InkRole[] = ['ink', 'dim', 'accent', 'alt', 'ink', 'accent'];
  sizes.forEach((size, i) => {
    const label = size === 'xxl' ? 'Xxl' : `Size ${size}`;
    const element = push({ key: `size-${size}`, text: label, size, role: roles[i] ?? 'ink', bold: size === 'm' }, left, top);
    top = onGrid(top) + element.height + lineH * 0.2;
  });

  const rightColumn = wide ? -viewport.width / 2 + viewport.width * 0.5 : left;
  let rightTop = wide ? -viewport.height / 2 + margin : top + lineH * 0.4;
  const place = (item: Spec, dx = 0): ElementFrame => {
    const element = push(item, rightColumn, rightTop, dx);
    rightTop = onGrid(rightTop) + element.height + lineH * 0.45;
    return element;
  };

  place({ key: 'underline', text: 'Underlined text', size: 'm', role: 'ink', mark: 'underline' });
  place({ key: 'box', text: 'Boxed label', size: 'm', role: 'accent', mark: 'box' });
  place({ key: 'invert', text: ' Inverted bar ', size: 'm', role: 'ink', mark: 'invert', markRole: 'accent' });
  place({ key: 'strike', text: 'Struck, withdrawn', size: 'm', role: 'dim', mark: 'strike', strike: 0 });
  // The shapes the painter really sends: a line written with mark=strike keeps strike at 0; a correction leaves mark 'none' and lets strike rise to 1.
  place({ key: 'ghost', text: 'A corrected ghost', size: 'm', role: 'dim', mark: 'none', ghost: true, strike: 1 });
  const sweepReveal = animate ? (ambient / 4) % 1 : 0.5;
  const reveal = place({ key: 'reveal', text: 'Revealed halfway', size: 'm', role: 'ink', reveal: sweepReveal });
  place({ key: 'faded', text: 'Half opacity', size: 'm', role: 'ink', opacity: 0.5 });
  const slide = animate ? Math.sin(ambient * 0.9) * viewport.width * 0.08 : 0;
  place({ key: 'moving', text: 'Sliding', size: 'm', role: 'alt', tappable: true }, slide);

  const bgScale = planeScale('bg', viewport);
  const bgSpec: Spec = { key: 'bg-word', text: 'BEHIND', size: 'xxl', role: 'dim' };
  const bgBody = body * 1.6;
  const bg = build(spec, bgBody, bgSpec, -(6 * 3.4 * bgBody * spec.type.advance) / 2 + viewport.width * 0.05, viewport.height * 0.12, bgScale, 0);
  elements.push({ ...bg, layer: 'bg' });

  const fgScale = planeScale('fg', viewport);
  const fgSpec: Spec = { key: 'fg-stamp', text: 'FRONT', size: 'xl', role: 'accent', bold: true };
  const fg = build(spec, body, fgSpec, viewport.width * (wide ? 0.12 : 0.02), viewport.height * 0.18, fgScale, 0);
  elements.push({ ...fg, layer: 'fg' });

  if (!showText) elements.length = 0;
  const blinkOn = !animate || Math.floor(ambient / (spec.motion.blink / 2)) % 2 === 0;
  const lastReveal = reveal.runs[reveal.runs.length - 1];
  const cursor =
    lastReveal === undefined
      ? null
      : {
          layer: 'mid' as const,
          x: reveal.x + lastReveal.x + lastReveal.width + body * spec.type.advance,
          y: reveal.y - reveal.height / 2,
          width: body * spec.type.advance,
          height: reveal.height,
          colour: spec.roles.accent,
          lit: blinkOn,
          shape: 'block' as const,
        };

  const fit = fitCanvas('wide', 'free', viewport, spec);
  return {
    time: ambient,
    ambient,
    wallTime: options.wallTime ?? Date.now(),
    clock: options.clock ?? 'playing',
    viewport,
    look: spec.id,
    spec,
    lookChange: null,
    bodySize: body,
    margin: Math.max(16, spec.margin * Math.min(viewport.width, viewport.height)),
    canvas: { box: fit.box, unit: fit.unit },
    gridTop: safeFrame(viewport, spec).y,
    ground: spec.roles.ground,
    camera,
    agitation: options.agitation ?? spec.mood.neutral.agitation,
    dim: options.dim ?? 0,
    reducedMotion: options.reducedMotion ?? false,
    elements,
    figures: shown.content === 'text' ? [] : shown.content === 'paint' ? paintFigures(spec, viewport, shown.develop) : figuresFor(spec, viewport, shown),
    fields: shown.field === null ? [] : [fieldFor(spec, shown, ambient, fit.flow)],
    cursor: showText ? cursor : null,
  };
}

const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

function fieldFor(spec: LookSpec, shown: FixtureFigures, ambient: number, flow: FieldFrame['flow']): FieldFrame {
  const kind = shown.field ?? 'rain';
  const accented = kind === 'embers' || kind === 'fireflies' ? spec.roles.accent : kind === 'stars' ? spec.roles.ink : spec.roles.dim;
  return { kind: 'field', key: `field:${kind}`, layer: shown.fieldLayer, field: kind, density: shown.density, colour: accented, opacity: 1, seed: 7, time: ambient, flow };
}

function ring(cx: number, cy: number, radius: number, count: number, rotate = 0, squash = 1): { x: number; y: number }[] {
  return Array.from({ length: count }, (_, i) => {
    const angle = rotate + (i / count) * Math.PI * 2;
    return { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius * squash };
  });
}

/**
 * One of each figure the renderer draws, in stage units on the layer's plane. Everything is in the shape's own
 * units with an identity transform except the sprite and the picture, which are placed by theirs.
 */
export function figuresFor(spec: LookSpec, viewport: Viewport, shown: FixtureFigures): FigureFrame[] {
  const W = viewport.width;
  const H = viewport.height;
  const figures: FigureFrame[] = [];
  const stroke = (colour: string, width = shown.strokeWidth, progress = 1) => ({ colour, width, progress, character: shown.character });

  const sky = planeBoundsOf('far', viewport);
  figures.push({
    kind: 'shape',
    key: 'sky@1',
    id: 'sky',
    layer: 'far',
    z: -5,
    outline: [{ points: [{ x: sky.x, y: sky.y }, { x: sky.x + sky.width, y: sky.y }, { x: sky.x + sky.width, y: sky.y + sky.height * 0.55 }, { x: sky.x, y: sky.y + sky.height * 0.55 }], closed: true }],
    geometryKey: `sky:${sky.width}`,
    transform: IDENTITY,
    fill: { colour: spec.roles.dim, to: spec.roles.alt, opacity: 0.5 },
    stroke: null,
    opacity: 1,
    bleed: true,
    tappable: false,
  });

  const wave = Array.from({ length: 80 }, (_, i) => ({ x: -W * 0.42 + (i / 79) * W * 0.34, y: H * 0.25 + Math.sin((i / 79) * Math.PI * 3) * H * 0.06 }));
  figures.push({
    kind: 'shape',
    key: 'wave@2',
    id: 'wave',
    layer: 'mid',
    z: 1,
    outline: [{ points: wave, closed: false }],
    geometryKey: 'wave',
    transform: IDENTITY,
    fill: null,
    stroke: stroke(spec.roles.ink, shown.strokeWidth, shown.progress),
    opacity: 1,
    bleed: false,
    tappable: true,
  });

  figures.push({
    kind: 'shape',
    key: 'hex@3',
    id: 'hex',
    layer: 'mid',
    z: 2,
    outline: [{ points: ring(0, 0, H * 0.11, 6), closed: true }],
    geometryKey: 'hex',
    transform: { a: 1, b: 0, c: 0, d: 1, e: W * 0.2, f: H * 0.22 },
    fill: { colour: spec.roles.accent, to: spec.roles.alt, opacity: 0.9 },
    stroke: stroke(spec.roles.ink, shown.strokeWidth, 1),
    opacity: 1,
    bleed: false,
    tappable: true,
  });

  const star = Array.from({ length: 10 }, (_, i) => {
    const angle = -Math.PI / 2 + (i / 10) * Math.PI * 2;
    const r = i % 2 === 0 ? H * 0.1 : H * 0.04;
    return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
  });
  figures.push({
    kind: 'shape',
    key: 'star@4',
    id: 'star',
    layer: 'mid',
    z: 3,
    outline: [{ points: star, closed: true }],
    geometryKey: 'star',
    transform: { a: 1, b: 0, c: 0, d: 1, e: W * 0.36, f: H * 0.22 },
    fill: null,
    stroke: stroke(spec.roles.accent, shown.strokeWidth, 1),
    opacity: 1,
    bleed: false,
    tappable: false,
  });

  const box = [
    { x: -H * 0.1, y: -H * 0.07 },
    { x: H * 0.1, y: -H * 0.07 },
    { x: H * 0.1, y: H * 0.07 },
    { x: -H * 0.1, y: H * 0.07 },
  ];
  figures.push({
    kind: 'shape',
    key: 'box@5',
    id: 'box',
    layer: 'mid',
    z: 2,
    outline: [{ points: box, closed: true }],
    geometryKey: 'box',
    transform: { a: 1, b: 0, c: 0, d: 1, e: -W * 0.3, f: H * 0.02 },
    fill: null,
    stroke: stroke(spec.roles.ink, shown.strokeWidth, 1),
    opacity: 1,
    bleed: false,
    tappable: false,
  });

  figures.push({
    kind: 'shape',
    key: 'disc@6',
    id: 'disc',
    layer: 'fg',
    z: 1,
    outline: [{ points: ring(0, 0, H * 0.08, 48), closed: true }],
    geometryKey: 'disc',
    transform: { a: 1, b: 0, c: 0, d: 1, e: W * 0.04, f: -H * 0.02 },
    fill: { colour: spec.roles.accent, to: null, opacity: 0.85 },
    stroke: stroke(spec.roles.ink, shown.strokeWidth * 1.4, 1),
    opacity: 1,
    bleed: false,
    tappable: true,
  });

  const palette = spec.sprite;
  const pixel = (i: number): string | null => {
    const rows = ['..1..1..', '.111111.', '11211211', '11111111', '.133331.', '..3333..', '.4....4.', '4......4'];
    const ch = rows[Math.floor(i / 8)]?.charAt(i % 8) ?? '.';
    if (ch === '.') return null;
    return palette[Number(ch) + 1] ?? palette[1] ?? null;
  };
  const cells = Array.from({ length: 64 }, (_, i) => pixel(i));
  figures.push({
    kind: 'sprite',
    key: 'fox@7',
    id: 'fox',
    layer: 'mid',
    z: 4,
    cols: 8,
    rows: 8,
    cells,
    cellsKey: 'fox',
    cell: H / 48,
    transform: { a: 1, b: 0, c: 0, d: 1, e: -W * 0.08, f: H * 0.24 },
    landed: shown.landed,
    opacity: 1,
    tappable: true,
  });

  figures.push({
    kind: 'picture',
    key: 'painting@8',
    id: 'painting',
    layer: 'bg',
    z: 0,
    box: { x: W * 0.02, y: -H * 0.32, width: W * 0.3, height: H * 0.2 },
    transform: IDENTITY,
    src: shown.picture,
    develop: shown.develop,
    mask: shown.mask,
    opacity: 1,
    waiting: shown.picture === null,
    tappable: true,
  });
  return figures;
}

function planeBoundsOf(layer: Layer, viewport: Viewport): { x: number; y: number; width: number; height: number } {
  const scale = planeScale(layer, viewport);
  const width = viewport.width / scale;
  const height = viewport.height / scale;
  return { x: -width / 2, y: -height / 2, width, height };
}

/**
 * Every texture, every brush and every medium, each in its own cell: the renderer's paint, to be judged in each look.
 * Row one is the fill textures (and a soft edge), row two the stroke characters, row three the media over a small
 * sketch. `develop` is how far the paintings have grown over their sketches (the sketch fades as it rises, as the
 * painter does it).
 */
export function paintFigures(spec: LookSpec, viewport: Viewport, develop: number): FigureFrame[] {
  const W = viewport.width;
  const H = viewport.height;
  const out: FigureFrame[] = [];
  const columns = 7;
  const cw = W / columns;
  const pad = cw * 0.12;
  const rowH = H / 3.4;
  const left = -W / 2;
  const top = -H / 2 + H * 0.04;
  const roles = spec.roles;
  const rect = (x: number, y: number, w: number, h: number) => [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
  const blob = (cx: number, cy: number, rx: number, ry: number, n = 40) => Array.from({ length: n }, (_, i) => ({ x: cx + Math.cos((i / n) * Math.PI * 2) * rx * (1 + 0.04 * Math.sin(i * 3)), y: cy + Math.sin((i / n) * Math.PI * 2) * ry }));

  // Row one: textures.
  const textures = [...TEXTURES];
  textures.forEach((texture, i) => {
    const x = left + i * cw + pad;
    out.push({
      kind: 'shape', key: `tex:${texture}`, id: `tex-${texture}`, layer: 'mid', z: 1,
      outline: [{ points: i % 2 === 0 ? rect(x, top, cw - 2 * pad, rowH * 0.8) : blob(x + (cw - 2 * pad) / 2, top + rowH * 0.4, (cw - 2 * pad) / 2, rowH * 0.4), closed: true }],
      geometryKey: `tex:${texture}`, transform: IDENTITY, fill: { colour: roles.accent, to: null, opacity: 1, texture }, stroke: { colour: roles.ink, width: 1.2, progress: 1, character: 'clean' }, opacity: 1, bleed: false, tappable: false,
    });
  });
  out.push({
    kind: 'shape', key: 'soft', id: 'soft', layer: 'mid', z: 1,
    outline: [{ points: blob(left + 6 * cw + cw / 2, top + rowH * 0.4, cw * 0.3, rowH * 0.3), closed: true }],
    geometryKey: 'soft', transform: IDENTITY, fill: { colour: roles.accent, to: null, opacity: 1 }, stroke: null, opacity: 1, bleed: false, tappable: false, soft: cw * 0.12,
  });

  // Row two: brushes.
  STROKES.forEach((character, i) => {
    const x = left + i * cw + pad;
    const y = top + rowH;
    const w = cw - 2 * pad;
    const points = Array.from({ length: 32 }, (_, k) => ({ x: x + (k / 31) * w, y: y + rowH * 0.45 + Math.sin((k / 31) * Math.PI * 2.2) * rowH * 0.25 }));
    out.push({
      kind: 'shape', key: `brush:${character}`, id: `brush-${character}`, layer: 'mid', z: 1,
      outline: [{ points, closed: false }, { points: rect(x, y + rowH * 0.78, w, rowH * 0.1), closed: true }],
      geometryKey: `brush:${character}:${w}`, transform: IDENTITY, fill: null, stroke: { colour: roles.ink, width: Math.max(2.2, cw * 0.045), progress: 1, character }, opacity: 1, bleed: false, tappable: false,
    });
  });

  // Row three: media, each over its own small sketch of a hill, a house, a sun and a tree.
  PROCEDURAL_MEDIA.forEach((medium, i) => {
    const x = left + i * cw + pad;
    const y = top + 2 * rowH + rowH * 0.1;
    const w = cw - 2 * pad;
    const h = rowH * 0.85;
    const sketch: string[] = [];
    const part = (name: string, points: { x: number; y: number }[], fill: string | null, stroke: string | null) => {
      const key = `sk:${medium}:${name}`;
      sketch.push(key);
      out.push({
        kind: 'shape', key, id: key, layer: 'mid', z: 1 + sketch.length * 0.01,
        outline: [{ points, closed: true }], geometryKey: key, transform: IDENTITY,
        fill: fill === null ? null : { colour: fill, to: null, opacity: 1 }, stroke: stroke === null ? null : { colour: stroke, width: 1.6, progress: 1, character: 'clean' },
        opacity: Math.max(0, 1 - develop * 1.6), bleed: false, tappable: false,
      });
    };
    part('sky', rect(x, y, w, h), mixHex(roles.ground, roles.ink, 0.16), null);
    part('sun', blob(x + w * 0.78, y + h * 0.22, w * 0.11, w * 0.11), '#e8b43a', '#b87a10');
    part('hill', [{ x, y: y + h }, { x, y: y + h * 0.7 }, { x: x + w * 0.3, y: y + h * 0.6 }, { x: x + w * 0.7, y: y + h * 0.72 }, { x: x + w, y: y + h * 0.66 }, { x: x + w, y: y + h }], '#4a8a4c', '#2d5c30');
    part('house', rect(x + w * 0.18, y + h * 0.5, w * 0.3, h * 0.26), '#c8553d', '#6e2a1c');
    part('roof', [{ x: x + w * 0.14, y: y + h * 0.5 }, { x: x + w * 0.33, y: y + h * 0.32 }, { x: x + w * 0.52, y: y + h * 0.5 }], '#6e3b2a', '#3a1d12');
    part('trunk', rect(x + w * 0.66, y + h * 0.62, w * 0.04, h * 0.18), '#6b4a2b', null);
    part('crown', blob(x + w * 0.68, y + h * 0.5, w * 0.12, h * 0.14), '#2f7a3c', '#1b4a24');
    out.push({
      kind: 'picture', key: `paint:${medium}`, id: `paint-${medium}`, layer: 'mid', z: 2,
      box: { x, y, width: w, height: h }, transform: IDENTITY, src: null, develop, mask: 'none', opacity: 1, waiting: false, tappable: false, medium, sketch,
    });
  });
  return out;
}

function mixHex(a: string, b: string, t: number): string {
  const channel = (hex: string, i: number): number => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  const part = (i: number): string => Math.round(channel(a, i) * (1 - t) + channel(b, i) * t).toString(16).padStart(2, '0');
  return `#${part(0)}${part(1)}${part(2)}`;
}

/** What the clip bench puts across a frame. */
export type ClipKind = 'text' | 'marks' | 'fill' | 'stroke' | 'sprite' | 'picture' | 'medium' | 'chart';

export const CLIP_KINDS: readonly ClipKind[] = ['text', 'marks', 'fill', 'stroke', 'sprite', 'picture', 'medium', 'chart'];

/** The rectangle every clip fixture is kept inside, on the layer's own plane: the middle third of the screen, whatever the layer's depth. */
export function clipBoxFor(layer: Layer, viewport: Viewport): Box {
  const s = planeScale(layer, viewport);
  const w = (viewport.width * 0.36) / s;
  const h = (viewport.height * 0.28) / s;
  return { x: -w / 2, y: -h / 2, width: w, height: h };
}

/**
 * One thing, much larger than its frame, on one layer, kept inside `clipBoxFor(layer)`. Nothing else is on the stage, so
 * a pixel that differs from the empty stage outside the frame is the frame leaking.
 */
export function clipFixture(look: LookId, viewport: Viewport, camera: CameraPose, kind: ClipKind, layer: Layer, picture: string | null): { readonly frame: Frame; readonly clip: Box } {
  const spec = LOOKS[look];
  const base = fixtureFrame(look, viewport, camera, 3, { figures: NO_FIGURES });
  const s = planeScale(layer, viewport);
  const W = viewport.width / s;
  const H = viewport.height / s;
  const clip = clipBoxFor(layer, viewport);
  const frameOf = (parts: Partial<Frame>): Frame => ({ ...base, elements: [], figures: [], fields: [], cursor: null, ...parts });
  const rect = (w: number, h: number): { x: number; y: number }[] => [
    { x: -w / 2, y: -h / 2 },
    { x: w / 2, y: -h / 2 },
    { x: w / 2, y: h / 2 },
    { x: -w / 2, y: h / 2 },
  ];
  const shape = (key: string, parts: Partial<ShapeFrame>): ShapeFrame => ({
    kind: 'shape',
    key,
    id: key,
    layer,
    z: 1,
    outline: [{ points: rect(W * 1.3, H * 1.2), closed: true }],
    geometryKey: key,
    transform: IDENTITY,
    fill: null,
    stroke: null,
    opacity: 1,
    bleed: false,
    tappable: false,
    clip,
    ...parts,
  });

  if (kind === 'text' || kind === 'marks') {
    const body = benchBodySize(viewport, spec);
    const item: Spec =
      kind === 'text'
        ? { key: 'clip-text', text: 'CLIPPED ACROSS A FRAME', size: 'xl', role: 'ink', bold: true }
        : { key: 'clip-marks', text: ' MARKS AND A PLATE ACROSS A FRAME ', size: 'xl', role: 'ink', mark: 'invert', markRole: 'accent', strike: 0.7 };
    const made = build(spec, body * 1.5, item, 0, 0, s, 0);
    const element: ElementFrame = { ...made, layer, x: 0, y: 0, clip, plate: kind === 'marks' ? 0.8 : 0 };
    return { frame: frameOf({ elements: [element] }), clip };
  }
  if (kind === 'fill') {
    return { frame: frameOf({ figures: [shape('clip-fill', { fill: { colour: spec.roles.accent, to: spec.roles.alt, opacity: 1, texture: 'hatch' } })] }), clip };
  }
  if (kind === 'stroke') {
    const wave = Array.from({ length: 60 }, (_, i) => ({ x: -W * 0.6 + (i / 59) * W * 1.2, y: Math.sin((i / 59) * Math.PI * 4) * H * 0.2 }));
    return { frame: frameOf({ figures: [shape('clip-stroke', { outline: [{ points: wave, closed: false }], stroke: { colour: spec.roles.ink, width: Math.max(6, H * 0.04), progress: 1, character: 'clean' } })] }), clip };
  }
  if (kind === 'sprite') {
    const cols = 14;
    const rows = 14;
    const cells = Array.from({ length: cols * rows }, (_, i) => ((i % cols) + Math.floor(i / cols)) % 2 === 0 ? spec.roles.ink : spec.roles.accent);
    const sprite: SpriteFrame = { kind: 'sprite', key: 'clip-sprite', id: 'clip-sprite', layer, z: 1, cols, rows, cells, cellsKey: 'clip', cell: (W * 0.9) / cols, transform: IDENTITY, landed: rows, opacity: 1, tappable: false, clip };
    return { frame: frameOf({ figures: [sprite] }), clip };
  }
  if (kind === 'picture') {
    const art: PictureFrame = { kind: 'picture', key: 'clip-picture', id: 'clip-picture', layer, z: 1, box: { x: -W * 0.55, y: -H * 0.5, width: W * 1.1, height: H }, transform: IDENTITY, src: picture, develop: 1, mask: 'none', opacity: 1, waiting: false, tappable: false, clip };
    return { frame: frameOf({ figures: [art] }), clip };
  }
  if (kind === 'medium') {
    // The sketch the painting follows: not shown itself (the painter fades it as the painting develops), drawn by the picture.
    const sketch = shape('clip-sketch', { fill: { colour: spec.roles.accent, to: spec.roles.alt, opacity: 1 }, stroke: { colour: spec.roles.ink, width: 3, progress: 1, character: 'clean' }, opacity: 0, clip: undefined });
    const art: PictureFrame = { kind: 'picture', key: 'clip-medium', id: 'clip-medium', layer, z: 2, box: { x: -W * 0.55, y: -H * 0.5, width: W * 1.1, height: H }, transform: IDENTITY, src: null, develop: 1, mask: 'none', opacity: 1, waiting: false, tappable: false, clip, medium: 'watercolor', sketch: ['clip-sketch'] };
    return { frame: frameOf({ figures: [sketch, art] }), clip };
  }
  // A chart: the engine's still is drawn over the picture, so the frame is the picture-taker's to keep it inside.
  const model = chartModelOf('line', [
    { cells: ['a', '1'], at: 0 },
    { cells: ['b', '3'], at: 0 },
    { cells: ['c', '2'], at: 0 },
  ]);
  const theme: ChartTheme = { ground: spec.roles.ground, ink: spec.roles.ink, grid: spec.roles.dim, crosshair: spec.roles.ink, series: [spec.roles.accent], up: spec.roles.accent, down: spec.roles.alt, accent: spec.roles.accent, face: spec.type.face, fontFamily: 'monospace', fontPx: 12, hard: false };
  const state: ChartState = { kind: 'line', words: [], title: '', model, marks: [], theme, reveal: 1, landed: 3, interactive: false, waiting: false, failed: false, reducedMotion: true };
  // The room, as the screen sees it with the camera at rest: far larger than the frame.
  const rest: Box = { x: viewport.width * 0.05, y: viewport.height * 0.1, width: viewport.width * 0.9, height: viewport.height * 0.8 };
  const chart: ChartFrame = { key: 'clip-chart', id: 'clip-chart', layer, z: 1, box: rest, rest, opacity: 1, state, tappable: false, clip };
  return { frame: frameOf({ charts: [chart] }), clip };
}
