// Surfaces: the port between the stage and the sandboxed frames that run code over it (PLAN-v3-core 2.2 and 2.6). A live app is one; the
// lesson view will be another. The host (web/src/surfaces/host.ts) owns the frame, the policy, the protocol and the watchdog; what it runs is
// a document (HTML with inline style and script) and what it keeps is a saved state. Nothing here acts: the protocol carries data only.

import type { AppTokens } from './app';
import type { Box } from './space';

/** One surface that should be on stage, as the host is told of it every frame. */
export interface SurfaceSpec {
  readonly key: string;
  readonly id: string;
  readonly title: string;
  /** the document: the brain's (or the lesson view's) markup with its inline <style> and <script>; the host builds the page from it */
  readonly source: string;
  /** it may run now. False: nothing is made. */
  readonly ready: boolean;
  /** where it is on screen now, host CSS pixels, through the camera */
  readonly box: Box;
  /** the same room with the camera at rest: the size it runs at */
  readonly rest: Box;
  /** how far it is in, and out */
  readonly opacity: number;
  readonly z: number;
  readonly tokens: AppTokens;
}

/** What a surface said it did: `conduit.send` (quiet) or `conduit.ask` (asks for a new answer now). */
export interface SurfaceEmit {
  readonly key: string;
  readonly id: string;
  readonly name: string;
  readonly value: string | number | boolean;
  readonly ask: boolean;
}

/** Why a surface is not running when it was meant to be. */
export type SurfaceHold = 'killed' | 'navigated' | 'frozen' | 'marked';

export interface SurfaceProbe {
  readonly key: string;
  readonly id: string;
  readonly running: boolean;
  readonly loaded: boolean;
  readonly shown: boolean;
  /** not running though it was meant to be, and why: `killed` (`/stop-all`), `navigated` (its frame loaded a second time), `frozen` (it stopped answering), `marked` (it froze the page before, so it waits to be run by hand) */
  readonly held: SurfaceHold | null;
  readonly box: Box | null;
  readonly state: string | null;
  readonly height: number | null;
  readonly still: { readonly how: 'own' | 'dom'; readonly width: number; readonly height: number } | null;
  /** messages the host refused: wrong source, wrong origin, wrong shape, too big, too fast */
  readonly refused: number;
  readonly emits: number;
  readonly faults: number;
  /** the sandbox attribute the frame was made with, so a check can read it back */
  readonly sandbox: string | null;
}

export interface SurfaceHost {
  /** Told every frame which surfaces are on stage. Starts each ready one once, places and fades them, ends the ones that have left. Cheap when nothing changed. */
  sync(specs: readonly SurfaceSpec[]): void;
  /** The last picture of a surface, at its own size; null when it has none. */
  still(key: string): CanvasImageSource | null;
  /** Asks every running surface for a fresh picture, and resolves when they have answered or `ms` has passed. */
  refresh(ms: number): Promise<void>;
  /** Ends every surface and keeps them from starting again while they stay on stage. Returns how many were running. */
  killAll(): number;
  /** Lets a held surface run once more (click-to-run). */
  run(key: string): void;
  probe(): readonly SurfaceProbe[];
  dispose(): void;
}
