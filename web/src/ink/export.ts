// Ink out: a PNG cropped to the inked part (plus a margin, and any answer box that has ink), and an SVG. Both draw with the same code the screen does.

import type { InkBox, InkDocument, InkRegionDef, InkStroke } from '@conduit/language';
import { clampBox, inflate, strokeBounds, unionBox } from './geometry';
import { drawStrokes, strokeSvg } from './render';

/** What the ink was drawn over, for the picture that goes to the brain: the image drawn over the whole space, or a card that draws itself. */
export type InkBackdrop =
  | { readonly kind: 'image'; readonly image: CanvasImageSource }
  | { readonly kind: 'draw'; readonly draw: (ctx: CanvasRenderingContext2D, space: { readonly w: number; readonly h: number }) => void };

export interface ExportOptions {
  /** extra space around the inked part, in space units (default 5% of the longer side, at least 24) */
  readonly margin?: number;
  /** boxes whose strokes should be wholly in the picture (the answer box she wrote in, so the brain sees the box) */
  readonly regions?: readonly InkRegionDef[];
  readonly backdrop?: InkBackdrop | null;
  /** the longest side of the picture in pixels (default 1600) */
  readonly maxSide?: number;
  /** fill behind everything (default white; a PNG that goes to a brain is opaque) */
  readonly fill?: string | null;
  /** boxes that are always in the picture with the ink (the question the working is under), so the brain reads the working against it */
  readonly include?: readonly InkBox[];
  /** crop to this box instead of the ink's own (clamped to the space) */
  readonly crop?: InkBox;
  /** a smaller scale for tests */
  readonly scale?: number;
}

/** The part of the space a picture of this ink shows; null when there is no ink. */
export function cropFor(doc: InkDocument, options: Pick<ExportOptions, 'margin' | 'regions' | 'crop' | 'include'> = {}): InkBox | null {
  if (options.crop !== undefined) return clampBox(options.crop, doc.space.w, doc.space.h);
  if (doc.strokes.length === 0) return null;
  let box: InkBox | null = null;
  for (const stroke of doc.strokes) box = unionBox(box, strokeBounds(stroke));
  for (const region of options.regions ?? []) {
    // an answer box that has ink is shown whole, so the brain sees where she wrote
    const holds = doc.strokes.some((stroke) => stroke.points.some(([x, y]) => x >= region.box.x && y >= region.box.y && x <= region.box.x + region.box.w && y <= region.box.y + region.box.h));
    if (holds && region.kind === 'answer') box = unionBox(box, region.box);
  }
  for (const wanted of options.include ?? []) box = unionBox(box, wanted);
  const longer = Math.max(box!.w, box!.h);
  const margin = options.margin ?? Math.max(24, longer * 0.05);
  const padded = inflate(box!, margin);
  // a tiny mark (a tick, a "60") would be a postage stamp: give the picture a floor of a readable size
  const floor = Math.max(120, Math.min(doc.space.w, doc.space.h) * 0.12);
  const w = Math.max(padded.w, floor);
  const h = Math.max(padded.h, floor);
  return clampBox({ x: padded.x - (w - padded.w) / 2, y: padded.y - (h - padded.h) / 2, w, h }, doc.space.w, doc.space.h);
}

function surface(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('A canvas could not be made to draw the ink.');
  return { canvas, ctx };
}

/** Draws strokes (and the backdrop) into a fresh canvas showing `crop` of the space. */
export function drawCrop(doc: InkDocument, crop: InkBox, options: ExportOptions = {}): HTMLCanvasElement {
  const maxSide = options.maxSide ?? 1600;
  const wanted = options.scale ?? Math.min(3, Math.max(1, 900 / Math.max(crop.w, crop.h)));
  const scale = Math.min(wanted, maxSide / Math.max(crop.w, crop.h));
  const { canvas, ctx } = surface(Math.max(1, Math.round(crop.w * scale)), Math.max(1, Math.round(crop.h * scale)));
  const fill = options.fill === undefined ? '#ffffff' : options.fill;
  if (fill !== null) {
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.setTransform(scale, 0, 0, scale, -crop.x * scale, -crop.y * scale);
  const backdrop = options.backdrop ?? null;
  if (backdrop !== null) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, doc.space.w, doc.space.h);
    ctx.clip();
    if (backdrop.kind === 'image') ctx.drawImage(backdrop.image, 0, 0, doc.space.w, doc.space.h);
    else backdrop.draw(ctx, doc.space);
    ctx.restore();
  }
  let layer: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null;
  drawStrokes(ctx, doc.strokes, () => {
    layer ??= surface(canvas.width, canvas.height);
    return layer;
  });
  return canvas;
}

/** The ink as a PNG, cropped to the inked part plus a margin. Null when there is nothing to show. */
export async function exportPng(doc: InkDocument, options: ExportOptions = {}): Promise<{ readonly blob: Blob; readonly crop: InkBox; readonly width: number; readonly height: number } | null> {
  const crop = cropFor(doc, options);
  if (crop === null) return null;
  const canvas = drawCrop(doc, crop, options);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (blob === null) throw new Error('The ink could not be made into a picture.');
  return { blob, crop, width: canvas.width, height: canvas.height };
}

/** The ink as an SVG document in the space's units, over `crop` (default: the inked part). `background` is an image address drawn under the ink. */
export function exportSvg(doc: InkDocument, options: ExportOptions & { readonly background?: string } = {}): string | null {
  const crop = cropFor(doc, options) ?? (doc.strokes.length === 0 && options.background !== undefined ? { x: 0, y: 0, w: doc.space.w, h: doc.space.h } : null);
  if (crop === null) return null;
  const f = (n: number): string => (Math.round(n * 10) / 10).toString();
  const fill = options.fill === undefined ? '#ffffff' : options.fill;
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const strokes = (list: readonly InkStroke[]): string => list.map(strokeSvg).join('');
  const highlights = doc.strokes.filter((stroke) => stroke.tool === 'highlighter');
  const pens = doc.strokes.filter((stroke) => stroke.tool === 'pen');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f(crop.x)} ${f(crop.y)} ${f(crop.w)} ${f(crop.h)}" width="${f(crop.w)}" height="${f(crop.h)}">${
    fill === null ? '' : `<rect x="${f(crop.x)}" y="${f(crop.y)}" width="${f(crop.w)}" height="${f(crop.h)}" fill="${fill}"/>`
  }${options.background === undefined ? '' : `<image href="${esc(options.background)}" x="0" y="0" width="${f(doc.space.w)}" height="${f(doc.space.h)}" preserveAspectRatio="none"/>`}${strokes(highlights)}${strokes(pens)}</svg>`;
}
