// Every strip of stills on the page is made by one renderer, one picture at a
// time, so twenty cards cost one WebGL context.

import type { Film } from '../contracts/film';
import type { Renderer } from '../contracts/renderer';

export const STILLS = 8;

export interface StillMaker {
  /** Object URLs, one per still, or null when this browser's renderer cannot capture. */
  make(film: Film): Promise<string[] | null>;
  /** Frees every picture made so far. */
  forget(): void;
  dispose(): void;
}

export function createStillMaker(createRenderer: () => Renderer): StillMaker {
  let chain: Promise<unknown> = Promise.resolve();
  let renderer: Renderer | null = null;
  let host: HTMLElement | null = null;
  let mounted: Promise<void> | null = null;
  let urls: string[] = [];
  let disposed = false;

  const ready = (film: Film): Promise<Renderer> => {
    if (renderer === null) {
      renderer = createRenderer();
      host = document.createElement('div');
      host.setAttribute('aria-hidden', 'true');
      host.style.cssText = `position:fixed;left:-20000px;top:0;width:${film.viewport.width}px;height:${film.viewport.height}px;overflow:hidden;pointer-events:none;`;
      document.body.append(host);
      mounted = renderer.mount(host, film.viewport, film.frameAt(0).look);
    }
    const current = renderer;
    return (mounted ?? Promise.resolve()).then(() => current);
  };

  return {
    make(film) {
      const job = chain.then(async (): Promise<string[] | null> => {
        if (disposed) return null;
        const r = await ready(film);
        if (!r.capabilities.capture) return null;
        r.reset();
        const made: string[] = [];
        for (let i = 0; i < STILLS; i += 1) {
          const blob = await r.rasterise(film.frameAt((film.duration * (i + 1)) / STILLS), { maxSide: 480, mime: 'image/png' });
          if (blob === null) return null;
          const url = URL.createObjectURL(blob);
          urls.push(url);
          made.push(url);
        }
        return made;
      });
      chain = job.catch(() => undefined);
      return job;
    },
    forget() {
      for (const url of urls) URL.revokeObjectURL(url);
      urls = [];
    },
    dispose() {
      disposed = true;
      for (const url of urls) URL.revokeObjectURL(url);
      urls = [];
      renderer?.dispose();
      host?.remove();
      renderer = null;
    },
  };
}
