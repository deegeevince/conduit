// Plays one answer of a run, as the exploration page plays it: the lines it wrote, on the reference screen, at once.
// The stage is the reference size (the one the judge saw) and is scaled to fit the width of the phone.

import { EMPTY_STAGE, parseLine } from '@conduit/language';
import type { ExploreResult, Line } from '@conduit/language';
import type { Recording } from '../contracts/film';
import type { Renderer } from '../contracts/renderer';
import { createFilm } from '../painter/film';
import { createPlainRenderer } from '../render/plain';
import { canUseThree, createThreeRenderer } from '../render/three';

export const REFERENCE = { width: 640, height: 360 } as const;

function recordingOf(result: ExploreResult): Recording {
  const lines: { seq: number; line: Line }[] = [];
  for (const entry of result.lines) {
    const parsed = parseLine(entry.text);
    if (parsed.kind === 'line') lines.push({ seq: entry.seq, line: parsed.line });
  }
  return { turn: result.prompt.id, base: result.base ?? EMPTY_STAGE, lines, paintings: {} };
}

export interface Playing {
  /** from the start again */
  replay(): void;
  dispose(): void;
}

/** Plays `result` in `host`, which must be `REFERENCE` in CSS pixels. Throws when no renderer can run here. */
export async function play(host: HTMLElement, result: ExploreResult): Promise<Playing> {
  const film = createFilm(recordingOf(result), { viewport: { ...REFERENCE, dpr: 1 }, reducedMotion: false, arrival: 'at-once' });
  const renderer: Renderer = canUseThree() ? createThreeRenderer() : createPlainRenderer();
  try {
    await renderer.mount(host, film.viewport, film.frameAt(0).look);
  } catch (error) {
    renderer.dispose();
    throw error;
  }
  let time = 0;
  let last = performance.now();
  let handle = 0;
  let live = true;
  const loop = (now: number): void => {
    if (!live) return;
    time = Math.min(film.duration, time + (now - last) / 1000);
    last = now;
    renderer.render(film.frameAt(time));
    handle = requestAnimationFrame(loop);
  };
  handle = requestAnimationFrame(loop);
  return {
    replay() {
      renderer.reset();
      time = 0;
    },
    dispose() {
      live = false;
      cancelAnimationFrame(handle);
      renderer.dispose();
      host.replaceChildren();
    },
  };
}
