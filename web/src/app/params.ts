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
  return {
    debug: debug === '1' || debug === 'true',
    renderer: renderer === 'plain' || renderer === 'three' ? renderer : 'auto',
    look: LOOK_IDS.find((id) => id === look) ?? null,
    demo: demo !== null && /^[\w-]{1,40}$/.test(demo) ? demo : null,
    motion: motion === 'reduced' || motion === 'full' ? motion : 'auto',
  };
}
