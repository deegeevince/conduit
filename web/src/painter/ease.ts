import type { Ease } from '../contracts/look';

/** Maps progress 0..1 through a named curve. No curve overshoots: nothing in this product bounces. */
export function ease(curve: Ease, progress: number): number {
  const p = progress <= 0 ? 0 : progress >= 1 ? 1 : progress;
  switch (curve) {
    case 'linear':
      return p;
    case 'out':
      return 1 - (1 - p) ** 3;
    case 'out-hard':
      return 1 - (1 - p) ** 5;
    case 'in':
      return p * p;
    case 'in-out':
      return p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;
    case 'hold':
      return p >= 1 ? 1 : 0;
  }
}

/** Snaps a time to a look's frame rate, so motion steps the way the machine stepped. Null leaves it smooth. */
export function quantise(seconds: number, framesPerSecond: number | null): number {
  if (framesPerSecond === null) return seconds;
  // The epsilon keeps a time that is exactly on a frame (12.48 s at 12.5 fps) from falling back one frame to float error.
  return Math.floor(seconds * framesPerSecond + 1e-6) / framesPerSecond;
}
