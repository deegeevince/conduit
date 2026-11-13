// What the effects of one pipeline agree on while they draw a frame. Surface
// effects only say how much of themselves to lay on the sheet; the pipeline
// then does the work once, in a few passes, instead of one pass per effect.

import type { Frame, Quality } from '../../../contracts/frame';
import type { SurfaceStyle } from '../style';

export interface FxShared {
  style: SurfaceStyle;
  frame: Frame;
  quality: Quality;
  pixelRatio: number;
  /** device pixels per pixel of a coarse raster; 0 when the stage is drawn at full resolution */
  cell: number;
  /** the paper, the fanfold and the drafting grid are one sheet in the scene */
  sheet: { bars: number; paper: number; grid: number };
  dust: number;
  shadow: number;
  /** the treatments of the picture as light, done in one pass over it */
  screen: { scanlines: number; signal: number; grain: number; vignette: number; curve: number };
  /** glow is in the list, so the screen pass need not compensate for the halo it does not get */
  halo: boolean;
}

export function createShared(style: SurfaceStyle, frame: Frame): FxShared {
  return {
    style,
    frame,
    quality: 'full',
    pixelRatio: 1,
    cell: 0,
    sheet: { bars: 0, paper: 0, grid: 0 },
    dust: 0,
    shadow: 0,
    screen: { scanlines: 0, signal: 0, grain: 0, vignette: 0, curve: 0 },
    halo: false,
  };
}

export function clearShared(shared: FxShared, style: SurfaceStyle, frame: Frame, quality: Quality, pixelRatio: number): void {
  shared.style = style;
  shared.frame = frame;
  shared.quality = quality;
  shared.pixelRatio = pixelRatio;
  shared.cell = 0;
  shared.sheet.bars = 0;
  shared.sheet.paper = 0;
  shared.sheet.grid = 0;
  shared.dust = 0;
  shared.shadow = 0;
  shared.screen.scanlines = 0;
  shared.screen.signal = 0;
  shared.screen.grain = 0;
  shared.screen.vignette = 0;
  shared.screen.curve = 0;
  shared.halo = false;
}
