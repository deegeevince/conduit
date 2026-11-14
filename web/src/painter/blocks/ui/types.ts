// What the kit produces. A screen is laid out to boxes, and the boxes are drawn as three kinds of thing the painter
// already draws: a rounded rectangle (a fill, an edge, a shadow), a path (an icon, a rule, a glyph) and a line of text.
// Everything here is in points, in the screen's own coordinates, origin at its top-left. Nothing here is a Frame: the
// frame adapter (frame.ts) turns it into one for any look and any scale.

import type { Polyline } from '@conduit/language';

export interface UiShadow {
  readonly colour: string;
  readonly dy: number;
  readonly blur: number;
  readonly alpha: number;
}

/** A box a part is kept inside, in the pixels of the room it is drawn in: a screen's own glass. Nothing of the part is drawn outside it. */
export interface UiClip {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface UiRect {
  readonly kind: 'rect';
  readonly clip?: UiClip;
  readonly key: string;
  /** the id of the part (or container, or screen) it belongs to: what a tap, a `set` and a lint note name */
  readonly owner: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly radius: number;
  readonly fill: string | { readonly from: string; readonly to: string } | null;
  readonly fillAlpha?: number;
  readonly edge: { readonly colour: string; readonly width: number; readonly dash?: readonly [number, number] } | null;
  readonly shadow?: UiShadow;
  /** drawn only on one side: an edge that is a rule under a row, not a box */
  readonly rule?: 'top' | 'bottom';
}

export interface UiPath {
  readonly kind: 'path';
  readonly clip?: UiClip;
  readonly key: string;
  readonly owner: string;
  readonly outline: readonly Polyline[];
  readonly fill: string | null;
  readonly stroke: { readonly colour: string; readonly width: number } | null;
  readonly alpha?: number;
}

export interface UiText {
  readonly kind: 'text';
  readonly clip?: UiClip;
  readonly key: string;
  readonly owner: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly lines: readonly { readonly text: string; readonly width: number }[];
  readonly size: number;
  /** the height of a line, points */
  readonly line: number;
  readonly weight: 'normal' | 'bold';
  readonly colour: string;
  readonly align: 'left' | 'center' | 'right';
}

/** A photograph from the server, drawn where an `image` placeholder was: the picture itself, cover-fitted into its box. Its corners and its credit are rects and text beside it. */
export interface UiPicture {
  readonly kind: 'picture';
  readonly clip?: UiClip;
  readonly key: string;
  readonly owner: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly url: string;
  readonly circle?: boolean;
}

export type UiPart = UiRect | UiPath | UiText | UiPicture;

/** A photograph that has arrived for an `image` part, by the part's id: where it is, and the credit that is drawn at its foot. */
export interface UiPictureState {
  readonly url: string;
  /** the credit line, drawn at the picture's foot */
  readonly credit: string;
  readonly landing: string;
}

/** A thing a finger can use: what the bench turns a tap into. */
export type UiAction =
  | { readonly kind: 'tab'; readonly bar: string; readonly index: number }
  | { readonly kind: 'pick'; readonly control: string; readonly index: number }
  | { readonly kind: 'toggle'; readonly control: string; readonly on: boolean }
  | { readonly kind: 'field'; readonly control: string; readonly value: string }
  | { readonly kind: 'slider'; readonly control: string; readonly from: number; readonly to: number }
  | { readonly kind: 'press'; readonly control: string };

export interface UiHit {
  readonly id: string;
  readonly part: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly action: UiAction;
}

/** The state of the live parts: a function of it and the tree gives the screen. The brain never writes it; a tap does. */
export interface UiState {
  readonly tab: Readonly<Record<string, number>>;
  readonly pick: Readonly<Record<string, number>>;
  readonly toggle: Readonly<Record<string, boolean>>;
  readonly text: Readonly<Record<string, string>>;
  readonly slider: Readonly<Record<string, number>>;
  /** `set <screen> device=desktop`: a screen's device, switched. The same lines reflow. */
  readonly device: Readonly<Record<string, 'phone' | 'tablet' | 'desktop' | 'browser'>>;
  readonly focus: string | null;
  readonly pressed: string | null;
  /** v2.2 integration: photographs that have arrived for `image` parts, by part id */
  readonly picture?: Readonly<Record<string, UiPictureState>>;
}

export const NO_STATE: UiState = { tab: {}, pick: {}, toggle: {}, text: {}, slider: {}, device: {}, focus: null, pressed: null };

export type UiNoteKind =
  | 'coordinates'
  | 'lost-words'
  | 'outside'
  | 'overlap'
  | 'off-grid'
  | 'small-target'
  | 'dense'
  | 'two-primary'
  | 'unknown-part';

/** A lint note (PLAN-v2.2 E13, "judged by code"): what is wrong, where, and by how much. */
export interface UiLintNote {
  readonly kind: UiNoteKind;
  readonly screen: string;
  readonly id: string;
  readonly message: string;
}

/** The place the real chart goes: a `chart` part's box, for the bench to hand to the charting engine. */
export interface UiSlot {
  readonly id: string;
  readonly ref: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** One screen, laid out. */
export interface UiScreenLayout {
  readonly id: string;
  readonly device: string;
  readonly name: string;
  /** the screen this one is reached from, and the words on the arrow */
  readonly from: string | null;
  readonly fromLabel: string | null;
  readonly width: number;
  readonly height: number;
  readonly parts: readonly UiPart[];
  readonly hits: readonly UiHit[];
  /** every part's box by id, in screen points: what pointing, sight and lint read */
  readonly boxes: ReadonlyMap<string, { readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly kind: string }>;
  readonly slots: readonly UiSlot[];
  readonly notes: readonly UiLintNote[];
}
