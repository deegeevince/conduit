import { LOOK_IDS } from '@conduit/language';
import type { LookId } from '@conduit/language';

export interface AppParams {
  /** ?debug=1 shows the HUD */
  readonly debug: boolean;
  /** ?renderer=plain|three forces a renderer; default picks three when WebGL2 works */
  readonly renderer: 'auto' | 'three' | 'plain';
  /** ?look=<name> locks the stage to one look */
  readonly look: LookId | null;
  /** ?demo=<name> chooses the first-load script; ?demo=none plays nothing */
  readonly demo: string | null;
  /** ?motion=reduced|full overrides prefers-reduced-motion, so it can be tested without changing the OS */
  readonly motion: 'auto' | 'reduced' | 'full';
  /** ?wall=1 turns the endless canvas on at `/`: every answer that draws is a frame on one wall, and the camera travels it (PLAN-wall WL3) */
  readonly wall: boolean;
  /** ?lens=1 (PLAN-canvas step 1): pinch and pan into any answer, the Pencil draws on the stage without Draw, and a tap lands where it is made. Off, nothing changes. */
  readonly lens: boolean;
}

/** Reads the page's query string. Unknown values fall back to the default; nothing here throws. */
export function readParams(search: string): AppParams {
  let query: URLSearchParams;
  try {
    query = new URLSearchParams(search);
  } catch {
    query = new URLSearchParams();
  }
  const debug = query.get('debug');
  const renderer = query.get('renderer');
  const look = query.get('look');
  const demo = query.get('demo');
  const motion = query.get('motion');
  const wall = query.get('wall');
  const lens = query.get('lens');
  return {
    debug: debug === '1' || debug === 'true',
    renderer: renderer === 'plain' || renderer === 'three' ? renderer : 'auto',
    look: LOOK_IDS.find((id) => id === look) ?? null,
    demo: demo !== null && /^[\w-]{1,40}$/.test(demo) ? demo : null,
    motion: motion === 'reduced' || motion === 'full' ? motion : 'auto',
    wall: wall === '1' || wall === 'true',
    lens: lens === '1' || lens === 'true',
  };
}
