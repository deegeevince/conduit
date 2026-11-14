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
  ChartKind,
  ChartWord,
  Clear,
  ControlVerb,
  Direction,
  EnterEffect,
  ExitEffect,
  Face,
  FxName,
  Growth,
  HexString,
  HitGesture,
  InkRole,
  Layer,
  Layout,
  LetterCase,
  LinkEnd,
  Loop,
  Mark,
  Mask,
  Medium,
  Mood,
  NodeShape,
  Pace,
  PickForm,
  ShapeVerb,
  Side,
  Size,
  StayWord,
  StrokeCharacter,
  StructureVerb,
  Texture,
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
  /** the character of this one line; absent means the look's own */
  readonly brush?: StrokeCharacter;
  /** what the fill is made of; absent means `flat` */
  readonly tex?: Texture;
  /** how far the edge fades out, canvas units; absent means a hard edge */
  readonly soft?: number;
  /** a label with a line to what it names: with `near=` the line ends on that element, with `at=x,y` at that point, and the painter finds the label clear room */
  readonly leader?: boolean;
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
  /** v2.1. Makes the words a link that opens in a new tab: an `http:` or `https:` address, as written. Absent: not a link. */
  readonly href?: string;
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
  /** what it is, in plain words: the transcript's name for it, and the request when an image model is configured. '' when the brain gave none. */
  readonly prompt: string;
  readonly when?: When;
}

/** Opens a structure: a diagram whose parts the brain names and the painter lays out. The verb is its kind. */
export interface StructureLine {
  readonly verb: StructureVerb;
  /** `-` until the normaliser assigns one */
  readonly id: string;
  readonly styles: readonly string[];
  readonly props: StyleProps;
  /** which way a flow or a tree grows; absent means the painter chooses from the room it has */
  readonly grow?: Growth;
  /** what a chart draws; absent means a line */
  readonly chart?: ChartKind;
  /** the words on a chart line that change how it reads (`indexed`, `log`, `spark`, `live`, `approx`), in the vocabulary's order */
  readonly words?: readonly ChartWord[];
  /** a chart: the id of DATA the brief named, drawn instead of rows the brain would have to retype */
  readonly data?: string;
  /** v2.1. A chart: one of the owner's stored datasets, drawn by reference (`data=dataset:<name> instrument=ZEC field=close`) */
  readonly dataset?: DatasetRef;
  /** v2.1. A code block: the language, as the brain wrote it (`python`, `c++`) */
  readonly lang?: string;
  /** v2.1. A code block: the file it is from, shown as its header */
  readonly file?: string;
  /** a table: its numbers are drawn as bars beside the figures */
  readonly bars?: boolean;
  /** the room it is laid out in, canvas units; absent means the whole canvas */
  readonly box?: CanvasBox;
  /** a map joins its pins in the order they were written */
  readonly route?: boolean;
  /** a title the painter sets with the structure */
  readonly title?: string;
  readonly when?: When;
}

/** v2.1. A stored dataset a chart draws by reference: which table, which series in it, and which of its fields. The names are the server's and keep their case. */
export interface DatasetRef {
  readonly name: string;
  readonly instrument?: string;
  readonly field?: string;
}

/** Where a node's incoming link comes from, written `from=<id>` or `from=<id>:<label>`. */
export interface NodeFrom {
  readonly id: string;
  /** one word on the link, e.g. `yes` */
  readonly label?: string;
}

/** One part of a flow, tree, cycle, timeline or map. `props.in` names its structure once the normaliser has run. */
export interface NodeLine {
  readonly verb: 'node';
  /** `-` until the normaliser assigns one */
  readonly id: string;
  readonly styles: readonly string[];
  readonly props: StyleProps;
  readonly shape?: NodeShape;
  /**
   * Its numbers, as written: on a timeline one number is when (two are a span);
   * on a map two numbers are where, in canvas units. Empty elsewhere.
   */
  readonly values: readonly number[];
  readonly from?: NodeFrom;
  /**
   * On a chart, where the mark goes: `x` alone is an event (a labelled line at that time), `y` alone is a level (a labelled
   * line at that value), both are a point. `x` is as written: a date, a year, a number or a category's name.
   */
  readonly x?: string;
  readonly y?: number;
  /** may contain *emphasis* markers and `{…}` expressions */
  readonly text: string;
  readonly when?: When;
}

/** Joins nodes with routed connectors: two ids make one link, more make a chain. */
export interface LinkLine {
  readonly verb: 'link';
  /** `-` until the normaliser assigns one; the second link of a chain is `<id>-2`, and so on */
  readonly id: string;
  /** the ids of the nodes joined, in order; at least two */
  readonly nodes: readonly string[];
  readonly ends?: LinkEnd;
  readonly dashed?: boolean;
  /** every word on a link line is a node, so a link takes properties but no style names */
  readonly props: StyleProps;
  /** a label on the link (on the first link of a chain) */
  readonly text?: string;
  readonly when?: When;
}

/** The value a control holds: a slider's number, a toggle's state, the 1-based index of a pick's option, an input's text. A button holds none. */
export type ControlValue = number | boolean | string;

/** Every live control's value by element id: the stage's data model, sent with a button press and told to the brain each turn. */
export type ControlValues = Readonly<Record<string, ControlValue>>;

/** Puts a control on stage. The verb is its kind. */
export interface ControlLine {
  readonly verb: ControlVerb;
  /** `-` until the normaliser assigns one */
  readonly id: string;
  readonly styles: readonly string[];
  readonly props: StyleProps;
  /** how a pick shows its options; absent means side by side */
  readonly form?: PickForm;
  /** a pick's options, in order */
  readonly options?: readonly string[];
  /** a slider's ends, and its step when it has one */
  readonly range?: { readonly min: number; readonly max: number; readonly step?: number };
  /** what it holds to begin with: a slider's number, a toggle's state, the 1-based index of a pick's option */
  readonly initial?: ControlValue;
  /** written after a slider's value */
  readonly unit?: string;
  /** a change the user commits is sent to the brain as their next message; a button always sends */
  readonly send?: boolean;
  /** the label of a button, toggle or slider; the placeholder of an input. Absent on a pick, whose words are its options. */
  readonly text?: string;
  readonly when?: When;
}

/** A framed group for controls and what they change. Its parts say `in=<id>`, exactly as for a group. */
export interface CardLine {
  readonly verb: 'card';
  readonly id: string;
  readonly styles: readonly string[];
  readonly props: StyleProps;
  /** canvas units; absent means the frame is drawn round its parts */
  readonly box?: CanvasBox;
  readonly title?: string;
  readonly when?: When;
}

/**
 * When a bound change applies.
 * `whole`: it is as far along as the control is across its whole range (a toggle: off is 0, on is 1; a pick: first option 0, last 1).
 * `range`: it runs from 0 to 1 as the control's value goes from `from` to `to`, in the control's own units (a pick: option numbers); `from` may be the larger.
 * `is`: it has landed while the control holds this value (an option's number or its words, `on`, `off`), and is undone otherwise.
 */
export type BindOn =
  | { readonly kind: 'whole' }
  | { readonly kind: 'range'; readonly from: number; readonly to: number }
  | { readonly kind: 'is'; readonly value: string };

/** The changes a control can drive: anything `set`, `move`, `correct` or a shape declared again can do on the clock. */
export type BoundChange = SetLine | MoveLine | ShapeLine | CorrectLine;

/** Lets a control drive a change on stage in the painter, with no round trip to the brain. */
export interface BindLine {
  readonly verb: 'bind';
  /** the id of the control */
  readonly control: string;
  readonly on: BindOn;
  readonly change: BoundChange;
}

/**
 * v2.1. Puts a picture the user gave on stage. `from` is the id the server gave the upload (`u1`); `box` is where it goes, in canvas units
 * (absent: fitted whole into the canvas). It is an element like any other: it can be pointed at, labelled, drawn over and traced.
 */
export interface PicLine {
  readonly verb: 'pic';
  readonly id: string;
  readonly styles: readonly string[];
  readonly props: StyleProps;
  readonly from: string;
  readonly box?: CanvasBox;
  readonly when?: When;
}

/** v2.1. Makes the turn a deck: every scene after this line is a slide. */
export interface DeckLine {
  readonly verb: 'deck';
  readonly title: string;
  readonly when?: When;
}

/**
 * v2.1. What the user asked to hold from now on, or the end of one such ask. Consumed by the server; it is never scheduled and never
 * reaches the painter. `drop` is the 1-based place of the ask in the list the brief gave, or `all`.
 */
export type StandingLine = { readonly verb: 'standing'; readonly text: string } | { readonly verb: 'standing'; readonly drop: number | 'all' };

/** v2.1. Keep making the picture better, `passes` times at most. Consumed by the server; never scheduled. */
export interface RefineLine {
  readonly verb: 'refine';
  readonly passes?: number;
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
  | PicLine
  | DeckLine
  | StandingLine
  | RefineLine
  | StructureLine
  | NodeLine
  | LinkLine
  | ControlLine
  | CardLine
  | BindLine
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
export type CreatingLine = SayLine | ShapeLine | PixLine | GroupLine | UseLine | PaintLine | PicLine | AmbientLine | StructureLine | NodeLine | LinkLine | ControlLine | CardLine;

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
  | 'ragged-sprite'
  /** a node, a link or a table row with no structure to belong to */
  | 'no-structure'
  /** more nodes, links, rows, cells or options than a structure or a control holds */
  | 'structure-limit'
  /** a `bind` that names something that is not a control, or a change a control cannot drive */
  | 'bad-bind'
  /** a `{…}` in text that does not read as an expression of the controls on stage */
  | 'bad-expression';

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
