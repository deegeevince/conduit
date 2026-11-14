import type { ScreenFacts, Size } from '@conduit/language';
import type { LookSpec } from '../../contracts/look';
import type { Box, Viewport } from '../../contracts/space';

export interface Cell {
  /** em height, stage units */
  readonly fontSize: number;
  /** width of one character, stage units */
  readonly width: number;
  /** height of one line, stage units */
  readonly height: number;
  /** horizontal glyph scale to hand to the renderer */
  readonly stretch: number;
}

/** The margin in CSS pixels: at least 16, however small the screen. */
export function marginOf(viewport: Viewport, look: LookSpec): number {
  return Math.max(16, look.margin * Math.min(viewport.width, viewport.height));
}

/** Safe-frame width: the margin on both sides of the viewport. */
function safeWidth(viewport: Viewport, look: LookSpec): number {
  return Math.max(1, viewport.width - 2 * marginOf(viewport, look));
}

/** Body font size for this viewport: aims for the look's target columns, clamped to its limits. */
export function bodySize(viewport: Viewport, look: LookSpec): number {
  const { advance, targetCols, minBody, maxBody } = look.type;
  const wanted = safeWidth(viewport, look) / (targetCols * advance);
  return Math.round(Math.min(maxBody, Math.max(minBody, wanted)));
}

/**
 * CSS pixels from the top edge of the viewport to the top of the safe frame:
 * the margin, plus the rows the look keeps for its own furniture.
 */
export function topInset(viewport: Viewport, look: LookSpec): number {
  const row = bodySize(viewport, look) * look.type.lineHeight * look.type.sizes.m.y;
  return marginOf(viewport, look) + look.furniture.top * row;
}

/**
 * What the foot of the stage keeps clear for the line that floats over its lower edge (the "Show all" pill, the activity rows): that line is the page's own, drawn
 * over the stage a few pixels above the composer, and no painted word, caption, mock-up or thumbnail may stand under it.
 */
export const FLOAT_CLEAR = 52;

/** The least the foot of the stage keeps clear, CSS pixels: the margin, or the room for the floating line when that is more. */
export function bottomInset(viewport: Viewport, look: LookSpec): number {
  return Math.max(marginOf(viewport, look), Math.min(FLOAT_CLEAR, viewport.height * 0.12));
}

/** The safe frame on the reading plane, stage units, origin at the viewport centre. */
export function safeFrame(viewport: Viewport, look: LookSpec): Box {
  const top = topInset(viewport, look);
  const width = safeWidth(viewport, look);
  const height = Math.max(1, viewport.height - top - bottomInset(viewport, look));
  return { x: -width / 2, y: -viewport.height / 2 + top, width, height };
}

/** The character cell of a size word at this viewport, before any shrink-to-fit. */
export function cellOf(size: Size, viewport: Viewport, look: LookSpec): Cell {
  const body = bodySize(viewport, look);
  const scale = look.type.sizes[size];
  const natural = body * scale.y;
  const fontSize = Math.max(look.type.minFont, natural);
  // A raised font keeps its cell proportions: the pitch must stay fontSize x advance x stretch.
  const k = fontSize / natural;
  return {
    fontSize,
    width: body * look.type.advance * scale.x * k,
    height: body * look.type.lineHeight * scale.y * k,
    stretch: scale.x / scale.y,
  };
}

/** What the brain is told about this screen. */
export function screenFacts(viewport: Viewport, look: LookSpec, reducedMotion: boolean, pointer: ScreenFacts['pointer']): ScreenFacts {
  const body = cellOf('m', viewport, look);
  const frame = safeFrame(viewport, look);
  return {
    width: viewport.width,
    height: viewport.height,
    dpr: viewport.dpr,
    cols: Math.max(1, Math.min(look.type.measure, Math.floor(frame.width / body.width))),
    canvas: viewport.width >= viewport.height * 1.2 ? 'wide' : viewport.height >= viewport.width * 1.2 ? 'tall' : 'square',
    rows: Math.max(1, Math.floor(frame.height / (body.height * 1.5))),
    reducedMotion,
    pointer,
  };
}
