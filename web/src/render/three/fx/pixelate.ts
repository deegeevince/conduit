import type { Effect } from '.';
import type { FxShared } from './shared';

/** The stage is rasterised one-twentieth of the body size per pixel and scaled up with hard edges; the pipeline does the drawing at that size. */
export function createPixelate(shared: FxShared): Effect {
  return {
    name: 'pixelate',
    apply() {},
    rasterScale(frame, amount) {
      const wanted = Math.max(1, Math.round(1 + (frame.bodySize / 20) * shared.pixelRatio * amount - amount));
      return 1 / wanted;
    },
    dispose() {},
  };
}
