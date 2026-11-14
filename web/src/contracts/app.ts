// Live apps: the port between the painter and whatever runs them.
//
// A live app is real HTML, CSS and JS the brain wrote, run in a locked sandbox over the stage (web/src/app/live-app.ts). The painter
// decides WHERE it is (the room the stage plan gave it, through the camera), WHEN it is whole and may run (a later line has closed its
// block, or the turn has ended) and what the stage looks like meanwhile (a still placeholder drawn in the renderer); it runs nothing. The
// host runs it, and gives back a picture of how it stands, so that a snapshot, an export and the critic's look all show the app.
//
// With no host a stage has no live apps: the painter draws the placeholder and says so, and the brain is not taught the verb.

import type { AppShelf, Layer } from '@conduit/language';
import type { Colour } from './frame';
import type { Box } from './space';

/** The look, as an app wears it: CSS variables the host writes into the sandboxed document. Every colour has been through the look's gamut and the contrast rule. */
export interface AppTokens {
  readonly ground: Colour;
  /** passes 4.5:1 on `ground` */
  readonly ink: Colour;
  /** quiet text: passes 4.5:1 on `ground` */
  readonly dim: Colour;
  readonly accent: Colour;
  /** the text colour that reads on `accent` */
  readonly onAccent: Colour;
  readonly alt: Colour;
  /** a hairline */
  readonly line: Colour;
  /** a good result, and a bad one: told apart by more than hue where the look allows */
  readonly good: Colour;
  readonly bad: Colour;
  /** a CSS font stack made of system faces only: the sandbox loads nothing */
  readonly font: string;
  /** the look's own body size, CSS pixels */
  readonly fontPx: number;
  /** corner radius, CSS pixels: 0 in the looks whose machine had none */
  readonly radius: number;
  /** the look's rhythm, CSS pixels: one gap between things */
  readonly gap: number;
  readonly dark: boolean;
}

/** One live app on stage, as the host is told of it every frame. */
export interface AppCue {
  readonly key: string;
  readonly id: string;
  readonly title: string;
  /** the one HTML document the brain wrote, exactly (the rows joined); the host builds the sandboxed page from it */
  readonly source: string;
  /** the library shelf the app asked for (`uses=`): the host puts each one in the app's document; absent: none */
  readonly uses?: readonly AppShelf[];
  /** the block is whole (a later line closed it, or the turn ended) and every line has landed: it may run now */
  readonly ready: boolean;
  /** it came from an earlier turn: it was whole then */
  readonly carried: boolean;
  /** where it is on screen now, host CSS pixels, through the camera */
  readonly box: Box;
  /** the same room with the camera at rest: the size it runs at */
  readonly rest: Box;
  /** how far it is in, and out: 0 while it arrives or leaves */
  readonly opacity: number;
  readonly layer: Layer;
  readonly z: number;
  readonly tokens: AppTokens;
}

/** What an app on stage did, as the stage's back channel hears it. */
export interface AppAct {
  readonly key: string;
  readonly id: string;
  /** a short name the app gave the act */
  readonly name: string;
  /** a string, a number or a boolean; anything else was made a short string before it got here */
  readonly value: string | number | boolean;
  /** the user asked for a new answer now (`conduit.ask`) */
  readonly ask: boolean;
  /** the app's saved state, as the act left it; null when it keeps none */
  readonly state: string | null;
}

export interface AppHost {
  /** Told every frame which apps are on stage. Starts each ready one once, moves and fades them, removes the ones that have left. Cheap when nothing changed. */
  sync(cues: readonly AppCue[], dpr: number): void;
  /** The last picture of an app, drawn at its own size; null when it has none (not started, or it cannot draw itself). */
  still(key: string): CanvasImageSource | null;
  /** Asks every running app for a fresh picture of itself, and resolves when they have answered or `ms` has passed: what a snapshot waits for. */
  refresh(ms: number): Promise<void>;
  /** Removes every app and keeps them from starting again while they stay on stage (`/stop-all`). Returns how many it ended. */
  killAll(): number;
  /** What the host knows of each app: for the test hook and the battery. */
  probe(): readonly AppProbe[];
  dispose(): void;
}

export interface AppProbe {
  readonly key: string;
  readonly id: string;
  /** it has an iframe now */
  readonly running: boolean;
  /** its iframe has loaded the document */
  readonly loaded: boolean;
  readonly killed: boolean;
  /** the iframe is shown (it is whole, at rest and in its room) */
  readonly shown: boolean;
  readonly box: Box | null;
  /** 1, or the factor the app is scaled down by because its content is larger than its room */
  readonly fit?: number;
  /** the saved state, as the app last kept it */
  readonly state: string | null;
  /** the app has given a picture of itself, and how (`own`: it drew itself; `dom`: the document was captured); null: none */
  readonly still: { readonly how: 'own' | 'dom'; readonly width: number; readonly height: number } | null;
  /** messages the host refused: wrong source, wrong shape, too big, too fast */
  readonly refused: number;
  readonly acts: number;
}
