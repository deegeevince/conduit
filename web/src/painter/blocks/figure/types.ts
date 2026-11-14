// The `figure` kind's input (PLAN-visuals 2(a), package FG2): the typed structure the language round will produce from
//
//   figure heart cutaway | How the heart pumps blood
//   poly ra smooth 24,30 38,26 42,40 30,46 in=body fill=blue label="right atrium"
//   route tired ink=blue via=vena,ra,rv,pulm
//   step show=vena,ra | Used blood from the body fills the right atrium.
//   end
//
// Nothing here is a coordinate for a label, a route or a step: a part carries only its own shape (in canvas units of the figure's own
// choosing: the engine fits whatever they are), and what it is called. Everything else the engine decides.
//
// Pure data: no DOM, no clock.

export interface Pt {
  readonly x: number;
  readonly y: number;
}

/** A part's own drawing. A `path` is SVG path data; a `poly` is a closed shape through points; a `line` is an open one. */
export type FigureShape =
  | { readonly kind: 'path'; readonly d: string }
  | { readonly kind: 'poly'; readonly points: readonly Pt[] }
  | { readonly kind: 'line'; readonly points: readonly Pt[] }
  | { readonly kind: 'ellipse'; readonly cx: number; readonly cy: number; readonly rx: number; readonly ry: number }
  | { readonly kind: 'rect'; readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly r?: number };

export interface FigurePart {
  readonly id: string;
  readonly shape: FigureShape;
  /** a curve through the points (Catmull-Rom), not a polygon: the brain writes points, not Bezier arithmetic */
  readonly smooth?: boolean;
  /** the closed part this one sits inside; `refit` shrinks it toward its centre until it does */
  readonly in?: string;
  /** a hue by name (`blue`, `muscle`, `steel`, `#c0392b`): the engine derives the outline, the light and the shadow from it. Absent on a closed part: a neutral. */
  readonly fill?: string;
  /** an open part's own hue; a closed part's outline is derived from its fill */
  readonly stroke?: string;
  /** an open part's thickness, in canvas units */
  readonly thick?: number;
  /** boundary label: placed outside the subject, on the side nearest this part, never on the figure */
  readonly label?: string;
  /** dropped first when there are more than seven labels, or they will not fit */
  readonly optional?: boolean;
  /** in a cutaway, this closed part is a cut face and is hatched; absent: a closed part that holds others is */
  readonly cut?: boolean;
}

/** `route <id> in=<figure> via=<part>,<part>… [ink=…]`: along an open part's own line, through a closed part's centre. */
export interface FigureRoute {
  readonly id: string;
  readonly via: readonly string[];
  readonly ink?: string;
}

/** `step show=<part>,<part> | words`: the named parts stay lit, the rest dim, only the stretch of route between them runs. */
export interface FigureStep {
  readonly show: readonly string[];
  readonly words: string;
}

export type FigureMode = 'plain' | 'cutaway' | 'exploded';

export interface FigureInput {
  readonly id: string;
  readonly title: string;
  readonly mode: FigureMode;
  /** exploded: the one axis the parts are offset along. Absent: the subject's longer side. */
  readonly axis?: 'x' | 'y';
  /** back to front */
  readonly parts: readonly FigurePart[];
  readonly routes: readonly FigureRoute[];
  readonly steps: readonly FigureStep[];
}

/** What a hand has done to a figure: 0 is rest (every part lit, the title in the band); 1..n is that step. */
export interface FigureHeldState {
  readonly step: number;
}

export type FigureNoteKind = 'refit' | 'label-dropped' | 'label-crowded' | 'unknown-part' | 'open-container' | 'extra-lines';

/** What the engine did that the brain could not see; reported as sight notes by the language round. */
export interface FigureNote {
  readonly kind: FigureNoteKind;
  readonly part: string;
  readonly detail: string;
}
