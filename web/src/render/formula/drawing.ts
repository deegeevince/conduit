// What KaTeX set, as a list of things to draw. KaTeX sets a formula as HTML in the browser's own layout; the page measures that and reads the
// boxes of its glyphs and the rules and paths between them off it (`typeset.ts`). This is the list, and the one way of putting it on a 2D canvas: the WebGL
// renderer shows that canvas as a texture, and the vector export embeds it as an image. Everything is in ems of the container the formula was set in, with the
// formula's own top left at the origin, so the same list is drawn at any size, in any colour.
//
// No KaTeX in here: this is in the main chunk, and what reaches KaTeX is `typeset.ts`, a lazy one.

/** A run of text in one font, its pen at `x` and its baseline at `y`. */
export interface GlyphItem {
  readonly t: 'g';
  readonly x: number;
  readonly y: number;
  readonly text: string;
  /** the parts of the css `font` but its size: `italic`, `700`, `KaTeX_Math` */
  readonly style: string;
  readonly weight: string;
  readonly family: string;
  /** em of the container */
  readonly size: number;
  /** the width the browser gave it, so that the canvas sets it as wide */
  readonly width: number;
}

/** A filled rectangle: a fraction bar, an overline, a rule. */
export interface RuleItem {
  readonly t: 'r';
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** An outline from an inline `<svg>` (a radical, a tall brace, an arrow): its path data, the matrix from its own units to ems, and the box it is cut to. */
export interface PathItem {
  readonly t: 'p';
  readonly d: string;
  readonly m: readonly [number, number, number, number, number, number];
  readonly clip: readonly [number, number, number, number];
}

export type FormulaItem = GlyphItem | RuleItem | PathItem;

export interface FormulaDrawing {
  readonly width: number;
  readonly height: number;
  /** how much of the height hangs under the baseline */
  readonly depth: number;
  readonly items: readonly FormulaItem[];
}

/** Room round the ink, in ems: an italic's overhang, a radical's tail and a tall delimiter reach past the box KaTeX gives. */
export const INK_PAD = 0.12;

const MAX_SIDE = 4096;

/** The size of the picture of a drawing at `emPx` pixels to the em: its box and the room round it. */
export function pictureSize(drawing: FormulaDrawing, emPx: number): { readonly width: number; readonly height: number; readonly px: number } {
  const wide = (drawing.width + 2 * INK_PAD) * emPx;
  const px = wide > MAX_SIDE ? (emPx * MAX_SIDE) / wide : emPx;
  return { width: Math.max(1, Math.ceil((drawing.width + 2 * INK_PAD) * px)), height: Math.max(1, Math.ceil((drawing.height + 2 * INK_PAD) * px)), px };
}

/** Draws the list into a new canvas, `emPx` pixels to the em, all in `colour`. The picture is the formula's box and `INK_PAD` ems of room on every side. */
export function drawFormula(drawing: FormulaDrawing, emPx: number, colour: string): HTMLCanvasElement {
  const { width, height, px } = pictureSize(drawing, emPx);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return canvas;
  ctx.fillStyle = colour;
  ctx.strokeStyle = colour;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  const pad = INK_PAD * px;
  for (const item of drawing.items) {
    if (item.t === 'g') {
      ctx.save();
      ctx.font = `${item.style} ${item.weight} ${item.size * px}px ${item.family}`;
      const natural = ctx.measureText(item.text).width;
      const x = pad + item.x * px;
      const y = pad + item.y * px;
      // the browser's own width for it is the one the layout used: a glyph the canvas sets a hair wider or narrower is squeezed to it
      if (natural > 0 && item.width > 0 && Math.abs(natural - item.width * px) > 0.5) {
        ctx.translate(x, y);
        ctx.scale((item.width * px) / natural, 1);
        ctx.fillText(item.text, 0, 0);
      } else ctx.fillText(item.text, x, y);
      ctx.restore();
    } else if (item.t === 'r') {
      // a rule is whole pixels or it is a blur: its thickness is kept at least one, and its edges are on the pixel grid
      const x0 = Math.round(pad + item.x * px);
      const y0 = Math.round(pad + item.y * px);
      const x1 = Math.round(pad + (item.x + item.w) * px);
      const y1 = Math.max(y0 + 1, Math.round(pad + (item.y + item.h) * px));
      ctx.fillRect(x0, y0, Math.max(1, x1 - x0), y1 - y0);
    } else {
      ctx.save();
      ctx.beginPath();
      ctx.rect(pad + item.clip[0] * px, pad + item.clip[1] * px, item.clip[2] * px, item.clip[3] * px);
      ctx.clip();
      ctx.translate(pad, pad);
      ctx.scale(px, px);
      const [a, b, c, d, e, f] = item.m;
      ctx.transform(a, b, c, d, e, f);
      ctx.fill(new Path2D(item.d));
      ctx.restore();
    }
  }
  return canvas;
}
