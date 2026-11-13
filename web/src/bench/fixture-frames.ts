import type { AmbientKind, ClockState, InkRole, Layer, LookId, Mark, Mask, Size, StrokeCharacter } from '@conduit/language';
import type { ElementFrame, FigureFrame, FieldFrame, Frame, Quality, RunFrame } from '../contracts/frame';
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
  readonly content: 'text' | 'figures' | 'both';
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

  const showText = shown.content !== 'figures';
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
    figures: shown.content === 'text' ? [] : figuresFor(spec, viewport, shown),
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
