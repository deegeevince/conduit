// The `app` block's side of the surface host: what a live app on the stage is, in the surface host's words. The sandbox, the policy, the
// protocol and the watchdog are `web/src/surfaces/host.ts`; this only turns the painter's `AppCue`s into surfaces and a surface's events into
// the acts the back channel carries. The lesson view uses the same host with its own adapter.

import type { AppAct, AppHost, AppProbe } from '../contracts/app';
import { createSurfaceHost } from '../surfaces/host';

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
    onEmit: (emit) => options.onAct({ key: emit.key, id: emit.id, name: emit.name, value: emit.value, ask: emit.ask, state: null }),
    // the app's saved state goes to the brain as one quiet act, a moment after it stops changing
    onSave: (save) => options.onAct({ key: save.key, id: save.id, name: 'state', value: save.json.slice(0, 300), ask: false, state: save.json }),
    ...(options.onNote === undefined ? {} : { onNote: options.onNote }),
  });
  return {
    sync: (cues) => surfaces.sync(cues),
    still: (key) => surfaces.still(key),
    refresh: (ms) => surfaces.refresh(ms),
    killAll: () => surfaces.killAll(),
    probe: (): readonly AppProbe[] =>
      surfaces.probe().map((probe) => ({ key: probe.key, id: probe.id, running: probe.running, loaded: probe.loaded, killed: probe.held === 'killed', shown: probe.shown, box: probe.box, fit: probe.fit, state: probe.state, still: probe.still, refused: probe.refused, acts: probe.emits })),
    dispose: () => surfaces.dispose(),
  };
}
