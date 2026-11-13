import type {
  Align,
  AmbientKind,
  Amount,
  Anchor,
  Bleed,
  By,
  CameraMove,
  CameraSpeed,
  CanvasName,
  Clear,
  Direction,
  EnterEffect,
  ExitEffect,
  Face,
  FxName,
  HexString,
  HitGesture,
  InkRole,
  Layer,
  Layout,
  LetterCase,
  Loop,
  Mark,
  Mask,
  Medium,
  Mood,
  Pace,
  ShapeVerb,
  Side,
  Size,
  StayWord,
  StrokeCharacter,
  Weight,
} from './vocabulary';

export type HexColor = HexString;

/**
 * A point. In a line of Series it is in canvas units of the scene's canvas
 * (0,0 is the canvas's top-left; x runs right, y runs down). Points outside
 * the canvas are allowed: a thing may start off stage.
 */
export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Seconds {
  readonly seconds: number;
}

/** A colour the brain named with `color`. It is looked up when the line is scheduled. */
export interface NamedColour {
  readonly named: string;
}

/** A colour as written: a role of the look, an exact colour, or a name the brain defined. */
export type ColourRef = InkRole | HexColor | NamedColour;

/** A colour once names are resolved: what the painter is handed. */
export type Paint = InkRole | HexColor;

export interface Gradient<C> {
  /** the colour at the top of the shape */
  readonly from: C;
  /** the colour at its bottom */
  readonly to: C;
}

export type FillRef = ColourRef | 'none' | Gradient<ColourRef>;
export type Fill = Paint | 'none' | Gradient<Paint>;

export interface Near {
  readonly id: string;
  readonly side: Side;
}

/** The properties a style can set. Every one is optional; absent means "inherit". */
export interface StyleProps {
  readonly size?: Size;
  readonly ink?: ColourRef;
  readonly weight?: Weight;
  readonly face?: Face;
  readonly enter?: EnterEffect;
  readonly by?: By;
  readonly exit?: ExitEffect;
  readonly loop?: Loop;
  readonly mark?: Mark;
  readonly case?: LetterCase;
  readonly stay?: StayWord | Seconds;
  readonly layer?: Layer;
  readonly at?: Anchor | Point;
  readonly near?: Near;
  /** the id of the group this element is a part of */
  readonly in?: string;
  readonly fill?: FillRef;
  readonly stroke?: ColourRef | 'none';
  /** whether a filled shape touching the canvas edge runs on to the screen edge; absent means `auto` */
  readonly bleed?: Bleed;
  /** outline thickness, canvas units */
  readonly thick?: number;
  readonly scale?: number;
  /** degrees, clockwise */
  readonly rot?: number;
  readonly opacity?: number;
  readonly tap?: boolean;
  readonly dur?: number;
}

/** When a line starts, if the brain overrides "at the pen". */
export type When =
  | { readonly kind: 'with' }
  | { readonly kind: 'after'; readonly seconds: number }
  | { readonly kind: 'before'; readonly seconds: number }
  | { readonly kind: 'at'; readonly seconds: number };

export type Target =
  | { readonly kind: 'id'; readonly id: string }
  | { readonly kind: 'scene' }
  | { readonly kind: 'all' };

/** One step of a path, absolute. Every SVG path command is reduced to these four when a `path` line is parsed. */
export type PathCommand =
  | { readonly op: 'M'; readonly x: number; readonly y: number }
  | { readonly op: 'L'; readonly x: number; readonly y: number }
  | { readonly op: 'C'; readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number; readonly x: number; readonly y: number }
  | { readonly op: 'Z' };

export type ShapeGeometry =
  | { readonly shape: 'circle'; readonly cx: number; readonly cy: number; readonly r: number }
  | { readonly shape: 'ellipse'; readonly cx: number; readonly cy: number; readonly rx: number; readonly ry: number }
  /** `full` covers the whole screen on its layer whatever the canvas; the numbers are then the canvas itself */
  | { readonly shape: 'rect'; readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly r: number; readonly full: boolean }
  | { readonly shape: 'line'; readonly points: readonly Point[] }
  | { readonly shape: 'poly'; readonly points: readonly Point[] }
  /** `d` is kept exactly as written so the line reads back the same; `commands` is what it means */
  | { readonly shape: 'path'; readonly d: string; readonly commands: readonly PathCommand[] };

/** A rectangle in canvas units. */
export interface CanvasBox {
  /** top-left corner */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** What one sprite cell character means: a colour, or nothing. */
export type SpriteKey = Readonly<Record<string, ColourRef | 'none'>>;

/** The parts of a look a brain can set. Absent means "as the look it is like". */
export interface LookProps {
  readonly ground?: HexColor;
  readonly ink?: HexColor;
  readonly dim?: HexColor;
  readonly accent?: HexColor;
  readonly alt?: HexColor;
  readonly face?: Face;
  readonly fx?: readonly FxName[];
  readonly stroke?: StrokeCharacter;
  readonly enter?: EnterEffect;
  readonly by?: By;
  readonly exit?: ExitEffect;
}

export interface SceneLine {
  readonly verb: 'scene';
  readonly id?: string;
  readonly layout?: Layout;
  readonly canvas?: CanvasName;
  readonly lines?: number;
  readonly mood?: Mood;
  readonly pace?: Pace;
  readonly align?: Align;
  readonly clear?: Clear;
  readonly when?: When;
}

export interface PlanLine {
  readonly verb: 'plan';
  readonly lines?: number;
  readonly mood?: Mood;
  readonly pace?: Pace;
}

export interface StyleLine {
  readonly verb: 'style';
  readonly name: string;
  readonly like?: string;
  readonly props: StyleProps;
}

export interface ColorLine {
  readonly verb: 'color';
  readonly colors: Readonly<Record<string, HexColor>>;
}

export interface LookLine {
  readonly verb: 'look';
  /** a preset, or a name of the brain's own */
  readonly look: string;
  readonly like?: string;
  /** empty when the line only chooses a look */
  readonly props: LookProps;
  readonly when?: When;
}

export interface SayLine {
  readonly verb: 'say';
  /** `-` until the normaliser assigns one */
  readonly id: string;
  readonly styles: readonly string[];
  readonly props: StyleProps;
  /** may contain *emphasis* markers */
  readonly text: string;
  readonly when?: When;
}

export interface ShapeLine {
  readonly verb: ShapeVerb;
  /** `-` until the normaliser assigns one */
  readonly id: string;
  readonly styles: readonly string[];
  readonly props: StyleProps;
  readonly geometry: ShapeGeometry;
  readonly when?: When;
}

export interface PixLine {
  readonly verb: 'pix';
  readonly id: string;
  readonly styles: readonly string[];
  readonly props: StyleProps;
  /** frames per second, for a sprite with more than one frame */
  readonly fps?: number;
  /** cell characters this sprite defines beyond the built-in ones */
  readonly key: SpriteKey;
  readonly when?: When;
}

export interface RowLine {
  readonly verb: 'row';
  /** the sprite it belongs to; `-` until the normaliser attaches it to the sprite above */
  readonly id: string;
  readonly cells: string;
}

export interface FrameLine {
  readonly verb: 'frame';
  /** `-` until the normaliser attaches it to the sprite above */
  readonly id: string;
}

export interface GroupLine {
  readonly verb: 'group';
  readonly id: string;
  readonly styles: readonly string[];
  readonly props: StyleProps;
  readonly when?: When;
}

export interface UseLine {
  readonly verb: 'use';
  readonly id: string;
  /** the id of the element copied */
  readonly source: string;
  readonly styles: readonly string[];
  readonly props: StyleProps;
  readonly when?: When;
}

export interface PaintLine {
  readonly verb: 'paint';
  readonly id: string;
  readonly styles: readonly string[];
  readonly props: StyleProps;
  /** where the picture goes, canvas units; absent means the whole canvas, or the box of `over` */
  readonly box?: CanvasBox;
  /** the group whose parts are the sketch; absent means everything drawn in the scene so far on the picture's layer */
  readonly over?: string;
  readonly medium?: Medium;
  /** what happens to the sketch once the painting has arrived; default `fade` */
  readonly sketch?: 'fade' | 'keep';
  readonly mask?: Mask;
  /** what to paint, in plain words */
  readonly prompt: string;
  readonly when?: When;
}

export interface AmbientLine {
  readonly verb: 'ambient';
  readonly id: string;
  /** `none` clears every field of the scene */
  readonly kind: AmbientKind | 'none';
  readonly amount?: Amount;
  readonly styles: readonly string[];
  readonly props: StyleProps;
  readonly when?: When;
}

export interface SetLine {
  readonly verb: 'set';
  readonly target: Target;
  readonly styles: readonly string[];
  readonly props: StyleProps;
  readonly speed?: CameraSpeed;
  /** hand level: exact length in seconds */
  readonly over?: number;
  readonly when?: When;
}

export interface MoveLine {
  readonly verb: 'move';
  readonly id: string;
  /** absent when it travels `along` a path and stops where the path ends */
  readonly to?: Anchor | Point;
  readonly speed?: CameraSpeed;
  /** hand level: exact length in seconds */
  readonly over?: number;
  /** the id of a drawn path to travel along */
  readonly along?: string;
  readonly when?: When;
}

export interface DropLine {
  readonly verb: 'drop';
  readonly target: Target;
  /** further ids dropped by the same line (`drop a1 a2 a3`) */
  readonly also?: readonly string[];
  readonly exit?: ExitEffect;
  readonly when?: When;
}

export interface HitLine {
  readonly verb: 'hit';
  readonly id: string;
  readonly gesture: HitGesture;
  readonly when?: When;
}

export interface CamLine {
  readonly verb: 'cam';
  readonly move: CameraMove;
  /** element id; required by `focus`, ignored by the others */
  readonly target?: string;
  /** required by `pan`, ignored by the others */
  readonly direction?: Direction;
  readonly speed?: CameraSpeed;
  /** hand level: exact length in seconds */
  readonly over?: number;
  /** hand level: 0..1 of the move's full travel */
  readonly amount?: number;
  readonly when?: When;
}

export interface WaitLine {
  readonly verb: 'wait';
  /** exactly one of beats / seconds is set */
  readonly beats?: number;
  readonly seconds?: number;
}

export interface CorrectLine {
  readonly verb: 'correct';
  readonly id: string;
  readonly text: string;
  readonly when?: When;
}

export interface ReviseLine {
  readonly verb: 'revise';
  readonly id: string;
  readonly styles: readonly string[];
  readonly props: StyleProps;
  readonly text?: string;
}

export interface CancelLine {
  readonly verb: 'cancel';
  readonly id?: string;
}

export type Line =
  | SceneLine
  | PlanLine
  | StyleLine
  | ColorLine
  | LookLine
  | SayLine
  | ShapeLine
  | PixLine
  | RowLine
  | FrameLine
  | GroupLine
  | UseLine
  | PaintLine
  | AmbientLine
  | SetLine
  | MoveLine
  | DropLine
  | HitLine
  | CamLine
  | WaitLine
  | CorrectLine
  | ReviseLine
  | CancelLine;

/** The lines that put a new element on stage. */
export type CreatingLine = SayLine | ShapeLine | PixLine | GroupLine | UseLine | PaintLine | AmbientLine;

export type IssueSeverity =
  /** the line was dropped */
  | 'error'
  /** the line was kept; one part of it was ignored or repaired */
  | 'warn';

export type IssueCode =
  | 'not-a-line'
  | 'too-long'
  | 'unknown-verb'
  | 'missing-id'
  | 'bad-id'
  | 'missing-text'
  | 'text-too-long'
  | 'unexpected-text'
  | 'unknown-word'
  | 'unknown-key'
  | 'bad-value'
  | 'bad-time'
  | 'bad-geometry'
  | 'bad-path'
  | 'missing-argument'
  | 'nothing-to-do'
  | 'unknown-style'
  | 'unknown-colour'
  | 'unknown-id'
  | 'unknown-look'
  | 'no-sprite'
  | 'sprite-limit'
  | 'too-late'
  | 'reserved-name'
  | 'element-limit'
  | 'ragged-sprite';

export interface Issue {
  readonly code: IssueCode;
  readonly severity: IssueSeverity;
  readonly message: string;
  /** the offending token, when there is one */
  readonly token?: string;
}

export type ParseResult =
  | { readonly kind: 'line'; readonly line: Line; readonly issues: readonly Issue[] }
  | { readonly kind: 'blank' }
  | { readonly kind: 'comment'; readonly text: string }
  | { readonly kind: 'reject'; readonly issues: readonly Issue[] };

/** A half-open range of character offsets into an element's plain text. */
export interface Range {
  readonly start: number;
  readonly end: number;
}
