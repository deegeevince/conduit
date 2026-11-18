// What a scene squeezed to fit the screen, and why. Facts only: nothing here changes what is drawn. It is published as
// `PainterSnapshot.squeeze`, so a test can say which answers are cramped today, and the planned grow mode can later use the same facts to decide that a
// scene needs a page taller than the screen.

/** The ways a scene gives up room: words dropped, words set smaller, blocks short of their least size, controls set tighter, an app scaled down. */
export type SqueezeKind = 'retired' | 'shrunk' | 'crowded' | 'compacted' | 'app-scaled';

export interface SqueezeFact {
  readonly kind: SqueezeKind;
  /** the element, block or app it is about; null for a fact about the scene's controls as a whole */
  readonly key: string | null;
  /** one plain sentence: what was given up, and by how much */
  readonly why: string;
}

/** What the layout and the app host knew of one scene at one moment, before it is turned into facts. Plain data, so the function that reads it is pure. */
export interface SqueezeInput {
  /** lines the layout let go of because the column was full (their keys) */
  readonly retired: readonly string[];
  /** words set at less than `SQUEEZE.shrunkBelow` of the size their size word asks for, with the share they were set at */
  readonly shrunk: readonly { readonly key: string; readonly share: number }[];
  /** blocks (and structures' parts) that could not be given their least size */
  readonly crowded: readonly string[];
  /** how tightly the scene's controls were set: 0 at their natural size, up to 3, and whether they stand in an area that scrolls */
  readonly compact: { readonly level: 0 | 1 | 2 | 3; readonly scrolls: boolean };
  /** live apps shown at less than their natural size: the share of it they were given */
  readonly apps: readonly { readonly key: string; readonly scale: number }[];
}

export interface Squeeze {
  /** whether anything at all was given up */
  readonly squeezed: boolean;
  /** the distinct kinds, in a fixed order */
  readonly kinds: readonly SqueezeKind[];
  readonly facts: readonly SqueezeFact[];
}
