// How pnpm record sizes its page: the film is `size` pixels (1920x1080), the page is laid out in `css` CSS pixels and rendered at `scale` device pixels to the CSS pixel.
// 1280x720 at 1.5 makes 1920x1080 with every word 1.5 times as big as the same page at 1920x1080 CSS pixels: what a person watching on a phone can read. Pure, so the
// check can say what the defaults are without a browser.

export interface RecordView {
  /** the film, in pixels */
  readonly width: number;
  readonly height: number;
  /** the page's CSS viewport */
  readonly cssWidth: number;
  readonly cssHeight: number;
  /** device pixels to a CSS pixel: above `width / cssWidth` the render is handed down to the film's size (supersampled) */
  readonly scale: number;
  /** how many film pixels to a CSS pixel: what a word measured in the page is multiplied by to be measured in the film */
  readonly zoom: number;
}

const SIZE = /^(\d{3,5})x(\d{3,5})$/;

/**
 * `--size` (default 1920x1080), `--css` and `--scale`, and `--legacy` (the page laid out at the film's own size, rendered at 2: how it was recorded before).
 * Without `--css`, a 1920x1080 film is laid out in 1280x720 at 1.5 and any other size at its own size. Without `--scale` it is the film's width over the CSS width
 * (so the render is the film, exactly), and 2 when the page is laid out at the film's own size. Returns the view, or a sentence saying what is wrong.
 */
export function chooseView(flags: { readonly size?: string; readonly css?: string; readonly scale?: string; readonly legacy?: boolean }): RecordView | string {
  const size = SIZE.exec(flags.size ?? '1920x1080');
  if (size === null) return '--size is like 1920x1080';
  const width = Number(size[1]);
  const height = Number(size[2]);
  const named = flags.css !== undefined ? SIZE.exec(flags.css) : null;
  if (flags.css !== undefined && named === null) return '--css is like 1280x720';
  const cssWidth = named !== null ? Number(named[1]) : flags.legacy === true || width !== 1920 || height !== 1080 ? width : 1280;
  const cssHeight = named !== null ? Number(named[2]) : flags.legacy === true || width !== 1920 || height !== 1080 ? height : 720;
  const same = cssWidth === width && cssHeight === height;
  const scale = flags.scale !== undefined ? Number(flags.scale) : same ? 2 : width / cssWidth;
  if (!Number.isFinite(scale) || scale <= 0 || scale > 8) return '--scale is a number from 0 to 8';
  return { width, height, cssWidth, cssHeight, scale, zoom: width / cssWidth };
}
