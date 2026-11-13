import type { Quality } from '../contracts/frame';

/** If the renderer could not draw more than this many frames per second, sustained, the look drops its expensive passes. */
export const LITE_BELOW_FPS = 50;

/** The longest a frame may spend inside `render` before the renderer counts as unable to keep LITE_BELOW_FPS. */
export const RENDER_BUDGET_MS = 1000 / LITE_BELOW_FPS;

const SUSTAINED_MS = 2000;
const WINDOW_MS = 1000;

/**
 * Watches frame times and decides the quality level. It steps down after two
 * seconds in which drawing a frame costs more than RENDER_BUDGET_MS, and never
 * steps back up within a session: flapping between levels is worse than either.
 *
 * It judges by the time spent inside `render`, not by the gap between frames:
 * a display capped at 30 Hz (low-power mode, energy saver) has a long gap and a
 * renderer that is idling comfortably. The gap is still measured, for `fps`.
 */
export class QualityGovernor {
  private readonly window: number[] = [];
  private readonly costs: number[] = [];
  private windowMs = 0;
  private costMs = 0;
  private belowMs = 0;
  private level: Quality = 'full';

  /**
   * Takes one frame's duration (the gap since the last frame) and the time its
   * `render` call took; returns the new quality when it changes, else null.
   */
  sample(frameMs: number, renderMs: number): Quality | null {
    if (!(frameMs > 0) || !Number.isFinite(frameMs) || !Number.isFinite(renderMs)) return null;
    const cost = Math.max(0, renderMs);
    this.window.push(frameMs);
    this.costs.push(cost);
    this.windowMs += frameMs;
    this.costMs += cost;
    while (this.windowMs - (this.window[0] ?? 0) >= WINDOW_MS) {
      this.windowMs -= this.window.shift() ?? 0;
      this.costMs -= this.costs.shift() ?? 0;
    }
    if (this.level === 'lite') return null;
    // A single slow frame must not read as a slow second: judge the average over the last second.
    if (this.renderMs > RENDER_BUDGET_MS) this.belowMs += frameMs;
    else this.belowMs = 0;
    if (this.belowMs >= SUSTAINED_MS) {
      this.level = 'lite';
      return 'lite';
    }
    return null;
  }

  get fps(): number {
    return this.windowMs === 0 ? 0 : (this.window.length * 1000) / this.windowMs;
  }

  /** mean time inside `render` over the last second */
  get renderMs(): number {
    return this.costs.length === 0 ? 0 : this.costMs / this.costs.length;
  }

  get quality(): Quality {
    return this.level;
  }
}
