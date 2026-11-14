// The `app` block's side of the surface host: what a live app on the stage is, in the surface host's words. The sandbox, the policy, the
// protocol and the watchdog are `web/src/surfaces/host.ts`; this only turns the painter's `AppCue`s into surfaces and a surface's events into
// the acts the back channel carries. The lesson view uses the same host with its own adapter.

import type { AppAct, AppHost, AppProbe } from '../contracts/app';
import { API } from '@conduit/language';
import { createSurfaceHost } from '../surfaces/host';

/** About 300 kB of picture: the most a picture handed to an app may be. */
const PICTURE_BYTES = 300_000;

/** A blob as a `data:` address, shrunk (longest side, then quality) until it fits `PICTURE_BYTES`. Null when it cannot be read or made small enough. */
async function dataUrlOf(blob: Blob, width: number): Promise<string | null> {
  const bitmap = await createImageBitmap(blob).catch(() => null);
  if (bitmap === null) return null;
  let side = Math.min(1600, Math.max(320, width > 0 ? width * 2 : 1200));
  for (let tries = 0; tries < 5; tries += 1) {
    const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL('image/jpeg', tries < 2 ? 0.82 : 0.7);
    if (url.length * 0.75 <= PICTURE_BYTES) {
      bitmap.close();
      return url;
    }
    side *= 0.75;
  }
  bitmap.close();
  return null;
}

/** What an app asks for with `conduit.picture(words)`: the server's picture service finds one (the same one an `image` part uses), and it comes back as a `data:` address with its credit. Null for any failure. */
async function pictureFor(ask: { readonly query: string; readonly aspect: number }): Promise<{ readonly url: string; readonly credit: string } | null> {
  try {
    const found = (await (await fetch(`${API.pictureSearch}?q=${encodeURIComponent(ask.query)}&aspect=${ask.aspect.toFixed(2)}`)).json()) as { found?: boolean; url?: string; credit?: string };
    if (found.found !== true || typeof found.url !== 'string' || !found.url.startsWith('/api/pictures/')) return null;
    const bytes = await fetch(found.url);
    if (!bytes.ok) return null;
    const url = await dataUrlOf(await bytes.blob(), 0);
    return url === null ? null : { url, credit: typeof found.credit === 'string' ? found.credit : '' };
  } catch {
    return null;
  }
}

export interface LiveAppsOptions {
  /** the element the stage fills: the apps' layer goes in it */
  readonly stage: HTMLElement;
  /** what the user did in an app, to go up the back channel */
  readonly onAct: (act: AppAct) => void;
  /** something to say in the status line (an app that stopped, one that could not run) */
  readonly onNote?: (text: string) => void;
}

export function createLiveApps(options: LiveAppsOptions): AppHost {
  const surfaces = createSurfaceHost({
    stage: options.stage,
    onPicture: pictureFor,
    onEmit: (emit) => options.onAct({ key: emit.key, id: emit.id, name: emit.name, value: emit.value, ask: emit.ask, state: null }),
    // the app's saved state goes to the brain as one quiet act, a moment after it stops changing
    onSave: (save) => options.onAct({ key: save.key, id: save.id, name: 'state', value: save.json.slice(0, 300), ask: false, state: save.json }),
    ...(options.onNote === undefined ? {} : { onNote: options.onNote }),
  });
  return {
    exportPage: () => surfaces.exportPage(),
    sync: (cues) => surfaces.sync(cues),
    still: (key) => surfaces.still(key),
    refresh: (ms) => surfaces.refresh(ms),
    killAll: () => surfaces.killAll(),
    probe: (): readonly AppProbe[] =>
      surfaces.probe().map((probe) => ({ key: probe.key, id: probe.id, running: probe.running, loaded: probe.loaded, killed: probe.held === 'killed', shown: probe.shown, box: probe.box, fit: probe.fit, state: probe.state, still: probe.still, refused: probe.refused, acts: probe.emits })),
    dispose: () => surfaces.dispose(),
  };
}
