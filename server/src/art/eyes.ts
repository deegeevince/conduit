// The staged illustrator's eyes: a drawing's lines rendered by the page's own painter, in a headless Chrome, to a PNG. It is the bake-off's way of
// looking (`tools/art-bakeoff.ts`), kept apart from the server's startup: nothing here runs until the first look, and a server that cannot start a
// browser or the web dev server says so, and the staged maker draws like arm B instead.
//
// A dev web server is started once (port `ART_EYES_PORT`), and every picture gets a page of its own on it: the harness page keeps what it painted by
// element id, so a second house would be drawn over the first.

import { EMPTY_STAGE } from '@conduit/language';
import type { Line } from '@conduit/language';
import type { Eyes } from '../tools/explore-browser';
import type { Looker } from './staged';

const VIEW = 800;
const SIDE = 640;

export interface Headless extends Looker {
  close(): Promise<void>;
}

export function createHeadlessLook(port: number): Headless {
  let host: Promise<Eyes> | null = null;
  const web = `http://127.0.0.1:${port}`;
  return {
    async look(lines: readonly Line[]): Promise<string> {
      const { openEyes, repoRoot } = await import('../tools/explore-browser');
      host ??= openEyes({ web: null, port, repo: repoRoot() });
      await host.catch((error: unknown) => {
        host = null;
        throw error;
      });
      const eyes = await openEyes({ web, port, repo: repoRoot() });
      try {
        const reply = await eyes.look({ turn: 'art', base: EMPTY_STAGE, lines: lines.map((line, at) => ({ seq: at + 1, line })), viewport: { width: VIEW, height: VIEW, dpr: 1 }, playhead: null, earlier: [], judgeSide: SIDE, look: 'paper' });
        const png = reply.judge[reply.judge.length - 1];
        if (png === undefined) throw new Error('the page took no picture');
        return png;
      } finally {
        await eyes.close().catch(() => undefined);
      }
    },
    async close() {
      const open = host;
      host = null;
      if (open !== null) await (await open.catch(() => null))?.close().catch(() => undefined);
    },
  };
}
