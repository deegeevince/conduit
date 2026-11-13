// The one live stage on the page. Playing another card disposes this one.

import type { Film } from '../contracts/film';
import type { Renderer } from '../contracts/renderer';

export interface LiveStage {
  toggle(): void;
  seek(seconds: number): void;
  restart(): void;
  dispose(): void;
}

export interface LiveHandlers {
  onTick(seconds: number, playing: boolean): void;
}

/** Plays `film` in `host` (which is the film's viewport in CSS pixels) from the start. Rejects when the renderer cannot run here. */
export async function mountLive(host: HTMLElement, film: Film, renderer: Renderer, handlers: LiveHandlers): Promise<LiveStage> {
  try {
    await renderer.mount(host, film.viewport, film.frameAt(0).look);
  } catch (error) {
    renderer.dispose();
    throw error;
  }
  let time = 0;
  let playing = true;
  let last = performance.now();
  let handle = 0;
  let disposed = false;

  const loop = (now: number): void => {
    if (disposed) return;
    if (playing) {
      time = Math.min(film.duration, time + (now - last) / 1000);
      if (time >= film.duration) playing = false;
    }
    last = now;
    renderer.render(film.frameAt(time));
    handlers.onTick(time, playing);
    handle = requestAnimationFrame(loop);
  };
  handle = requestAnimationFrame(loop);

  return {
    toggle() {
      if (!playing && time >= film.duration) time = 0;
      playing = !playing;
    },
    seek(seconds) {
      renderer.reset();
      time = Math.max(0, Math.min(film.duration, seconds));
      playing = false;
    },
    restart() {
      renderer.reset();
      time = 0;
      playing = true;
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(handle);
      renderer.dispose();
      host.replaceChildren();
    },
  };
}
