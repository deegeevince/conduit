// The meaning of Series in time.
//
// `buildSchedule` is a pure function from the lines of a turn (the score) to
// absolute times on the turn clock. It decides WHEN. It never decides where
// or how anything is drawn; that is the painter's half.
//
// Recomputing from the whole score on every line is deliberate. It is what
// makes `revise` and `cancel` trivial (edit the score, rebuild), and what
// keeps a schedule reproducible: the same score always gives the same times.

import { chartModelOf } from './chart';
import { namesIn, numberOf, parseExpr } from './expr';
import { lengthOf, outlineOf, pointAlong } from './geometry';
import { isLessonVerb } from './lesson';
import { completeStyle, mergeStyles, patchStyle, resolveColours, resolveLook, resolveStyle } from './style';
import type { ColorSheet, ElementStyle, LookDef, LookSheet, ResolvedLook, ResolvedProps, StyleContext, StyleDef, StyleSheet } from './style';
import { isRuleRow, splitCells, splitEmphasis } from './text';
import {
  AMBIENT_SECONDS,
  beatSeconds,
  cameraSeconds,
  DRAW_HOLD,
  drawSeconds,
  enterSeconds,
  exitSeconds,
  figureEnterSeconds,
  HIT_SECONDS,
  LINK_SECONDS,
  LOOK_CHANGE_SECONDS,
  MORPH_SECONDS,
  MOVE_SECONDS,
  moveSeconds,
  PACE_TIMING,
  pageTailSeconds,
  readSeconds,
  ROW_SECONDS,
  SCENE_OVERLAP,
  SET_SECONDS,
  SOLO_OVERLAP,
  spriteSeconds,
  CHART_ROW_SECONDS,
  CODE_ROW_SECONDS,
  APP_ROW_SECONDS,
  UI_ROW_SECONDS,
  STRIKE_SECONDS,
  TABLE_ROW_SECONDS,
  tailSeconds,
  dwellSeconds,
  waitSeconds,
} from './timing';
import type { Anchor, LessonVerb, TuneVoice } from './vocabulary';
import type { BindOn, CanvasBox, ControlLine, SceneLine, ControlValue, CreatingLine, DatasetRef, Issue, IssueCode, Line, Paint, Point, Range, ShapeGeometry, StructureLine, StyleProps, Target, When } from './types';
import { cachedTune, tuneRowsOf } from './tune';
import { BACKDROP_LAYERS, CANVAS, CONTROL, DEFAULT_CANVAS, DEFAULT_CHART, DEFAULT_LOOK, DEFAULT_TUNE_VOICE, LESSON_VERBS, LIMITS, STRUCTURE } from './vocabulary';
import type {
  Align,
  AmbientKind,
  Amount,
  By,
  CameraMove,
  CameraSpeed,
  CanvasName,
  ChartKind,
  ChartWord,
  Clear,
  ControlKind,
  Direction,
  ElementKind,
  EnterEffect,
  ExitEffect,
  Growth,
  HitGesture,
  Layout,
  LinkEnd,
  LookId,
  Mask,
  Medium,
  Mood,
  NodeShape,
  Pace,
  PickForm,
  StructureKind,
  Verb,
} from './vocabulary';

export interface Span {
  readonly start: number;
  readonly end: number;
}

export interface Timed<T> {
  readonly at: number;
  readonly value: T;
}

/** The plan of the scene that is open when a turn begins. */
export interface SceneState {
  readonly id: string;
  /** counts scenes over the whole conversation; auto ids are `s<index>` */
  readonly index: number;
  readonly layout: Layout;
  readonly canvas: CanvasName;
  readonly align: Align;
  readonly mood: Mood;
  readonly pace: Pace;
  readonly expected: number | null;
}

export interface SpriteRow {
  readonly cells: string;
  /** when the row lands, on the clock of the turn that wrote it; 0 for a sprite carried in from an earlier turn */
  readonly at: number;
}

export interface SpriteData {
  /** frame 0 is what draws itself in; the rest are only shown once it cycles */
  readonly frames: readonly (readonly SpriteRow[])[];
  /** what each cell character means, beyond the built-in ones (`.` empty, `#` ink, 0-9 a-f the sprite palette) */
  readonly key: Readonly<Record<string, Paint | 'none'>>;
  /** null: the painter's own rate */
  readonly fps: number | null;
}

/** One row of a table or a chart: its cells as written, and when it lands. */
export interface StructureRow {
  readonly cells: readonly string[];
  /** on the clock of the turn that wrote it; 0 for a row carried in from an earlier turn */
  readonly at: number;
}

/** What a control is and holds. The painter draws it in the look and owns its value while the user works it. */
export interface ControlSpec {
  readonly control: ControlKind;
  /** how a pick shows its options; null for every other control */
  readonly form: PickForm | null;
  /** a pick's options */
  readonly options: readonly string[];
  /** a slider's ends; 0 and 1 for every other control */
  readonly min: number;
  readonly max: number;
  /** a slider's step; null: continuous */
  readonly step: number | null;
  /** written after a slider's value */
  readonly unit: string | null;
  /**
   * What it holds: a slider's number, a toggle's state, the 1-based index of a
   * pick's option, an input's text; null for a button. As written when the line
   * is scheduled; in a carried element, as the user left it.
   */
  readonly value: ControlValue | null;
  /** a change the user commits becomes their next message; a button always sends */
  readonly send: boolean;
}

/** What an element is, when it is not words. A node, a link and a control carry words as well: they are in the element's `text`. */
export type Figure =
  | { readonly kind: 'shape'; readonly geometry: ShapeGeometry }
  | { readonly kind: 'sprite'; readonly sprite: SpriteData }
  /** `card`: the group is framed, with a title; `box` is the frame as given, or null to frame its parts */
  | { readonly kind: 'group'; readonly card?: { readonly title: string; readonly box: CanvasBox | null } }
  /**
   * A diagram the painter lays out. Its nodes and links are elements of their
   * own whose `parent` is this one; the rows of a table or a chart are here.
   * Where anything in it goes is the painter's decision and is in no schedule.
   */
  | {
      readonly kind: 'structure';
      readonly structure: StructureKind;
      readonly grow: Growth | null;
      readonly chart: ChartKind | null;
      /** a chart's words (`indexed`, `log`, `spark`, `live`, `approx`); empty for anything else */
      readonly words: readonly ChartWord[];
      /** a chart: the id of the DATA it draws, when its points come by reference; null when they are its rows */
      readonly data: string | null;
      /** v2.1. A chart: one of the owner's stored datasets it draws by reference; absent or null: none */
      readonly dataset?: DatasetRef | null;
      /** a table: its numbers are drawn as bars too */
      readonly bars: boolean;
      /** v2.1. A code block: its language as the brain wrote it, and the file it is from; absent or null: none */
      readonly lang?: string | null;
      readonly file?: string | null;
      /** v2.1. A tune: how fast the brain asked for it to be played (quarter notes a minute; null: the score's own) and on what */
      readonly tempo?: number | null;
      readonly voice?: TuneVoice | null;
      /** v2.1. A tune or an app: the moment, on this turn's clock, that a later line closed the block, so the music is whole and can begin (an app's document is whole and can run); null while the brain may still write */
      readonly sealed?: number | null;
      /** An app: the height it asked for, canvas units; null: the default */
      readonly height?: number | null;
      /** the room it is laid out in, canvas units; null: the whole canvas */
      readonly box: CanvasBox | null;
      /** a map joins its pins in the order written */
      readonly route: boolean;
      readonly rows: readonly StructureRow[];
    }
  /** `values`: one number on a timeline (two: a span), a point on a map, nothing elsewhere. `x`, `y`: where a mark on a chart goes. */
  | { readonly kind: 'node'; readonly shape: NodeShape; readonly values: readonly number[]; readonly x?: string; readonly y?: number }
  /** `from` and `to` are the keys of the two nodes */
  | { readonly kind: 'link'; readonly from: string; readonly to: string; readonly ends: LinkEnd; readonly dashed: boolean }
  | ({ readonly kind: 'control' } & ControlSpec)
  /** `source` is the key of the element it is another copy of */
  | { readonly kind: 'copy'; readonly source: string }
  | {
      readonly kind: 'picture';
      readonly prompt: string;
      /** canvas units; null: the whole canvas, or the box of `over` */
      readonly box: CanvasBox | null;
      /** key of the group whose parts are the sketch; null: everything drawn in the scene on the picture's layer before it */
      readonly over: string | null;
      readonly medium: Medium | null;
      readonly sketch: 'fade' | 'keep';
      readonly mask: Mask;
      /** v2.1. The id of a picture the user gave (`pic … from=u1`); this is then that picture, not a painting. Absent or null: a painting. */
      readonly from?: string | null;
    }
  | { readonly kind: 'field'; readonly field: AmbientKind; readonly amount: Amount };

/** An element that is on stage when a turn begins. */
export interface CarriedElement {
  readonly key: string;
  readonly id: string;
  readonly kind: ElementKind;
  readonly order: number;
  readonly scene: string;
  /** '' unless `kind` is `text` */
  readonly text: string;
  readonly emphasis: readonly Range[];
  readonly style: ElementStyle;
  /** null when `kind` is `text` */
  readonly figure: Figure | null;
  /** key of the group it is a part of */
  readonly parent: string | null;
  /**
   * Where the painter really rested it, in canvas units of the scene's canvas:
   * after `move` and `set at=`, in world coordinates even for a part of a group.
   * Only the painter knows it, so `settle` leaves it out and the painter's report
   * fills it in; the brain's brief describes the stage from it, and falls back
   * to working it out from the lines when it is absent.
   */
  readonly placed?: CanvasBox;
  /** true when it was corrected: it lingers struck through beside its replacement */
  readonly struck: boolean;
  /** key of the struck element this one replaced, if any */
  readonly replaces: string | null;
  /** changes a control drives on it; they persist with the stage. Absent means none. */
  readonly driven?: readonly DrivenChange[];
  /** v2.1. The address its words link to (`say … href=`); absent: not a link */
  readonly href?: string;
}

/** What a control-driven change does to its element: what the same line would do on the clock. */
export type DrivenEffect =
  | { readonly kind: 'set'; readonly props: ResolvedProps }
  | { readonly kind: 'move'; readonly to: Anchor | Point; readonly along: string | null }
  | { readonly kind: 'morph'; readonly geometry: ShapeGeometry; readonly props: ResolvedProps }
  /** the words are these while the binding holds: a swap, never a strike-through */
  | { readonly kind: 'text'; readonly text: string; readonly emphasis: readonly Range[] };

/**
 * A change whose progress is a control's value instead of the turn clock
 * (`bind`). It is not on the clock: it takes no time, holds nothing, and the
 * schedule is the same whatever the user does with the control. The painter
 * evaluates it every frame from the control's value: several on one element
 * apply in the order written, each from where the one before leaves it.
 */
export interface DrivenChange {
  readonly seq: number;
  /** key of the control element */
  readonly control: string;
  readonly on: BindOn;
  readonly effect: DrivenEffect;
  /** when the binding came into being, on the clock of the turn that wrote it; 0 when carried */
  readonly since: number;
  /** when the control left, and the binding with it, on the clock of the turn; absent while the control stays */
  readonly until?: number;
}

/** Everything that persists from one turn to the next. */
export interface StageBase {
  /** the preset the look being worn stands on. Derived from `lookName` and `looks`; kept so a reader need not resolve them. */
  readonly look: LookId;
  /** the look being worn: a preset, or a name the brain defined */
  readonly lookName: string;
  readonly scene: SceneState;
  readonly styles: StyleSheet;
  readonly colors: ColorSheet;
  readonly looks: LookSheet;
  readonly elements: readonly CarriedElement[];
}

export const EMPTY_STAGE: StageBase = {
  look: DEFAULT_LOOK,
  lookName: DEFAULT_LOOK,
  scene: { id: 's0', index: 0, layout: 'stack', canvas: DEFAULT_CANVAS, align: 'auto', mood: 'neutral', pace: 'steady', expected: null },
  styles: {},
  colors: {},
  looks: {},
  elements: [],
};

/** One accepted line of a turn, in arrival order. */
export interface ScoreEntry {
  /** unique and increasing over the whole conversation, not just the turn: element keys are built from it */
  readonly seq: number;
  readonly line: Line;
  /** the playhead when the line arrived; nothing may be scheduled before it */
  readonly floor: number;
  /** cancelled, or a `revise` that was folded into the line it edited */
  readonly void: boolean;
}

/** `limit`: the stage held more than its limit, so the oldest was retired. `answered` (v2.1): a choice offered by an earlier turn leaves as this turn's answer begins. `parent`: its group, or the thing it copies, left. */
export type ExitCause = 'scene' | 'drop' | 'stay' | 'solo' | 'resay' | 'limit' | 'parent' | 'answered';

export type ElementChange =
  | {
      readonly kind: 'set';
      readonly seq: number;
      readonly start: number;
      readonly end: number;
      /** only what the line named, colour names resolved */
      readonly props: ResolvedProps;
      /** the element's whole style once the change has landed */
      readonly style: ElementStyle;
    }
  | {
      readonly kind: 'move';
      readonly seq: number;
      readonly start: number;
      readonly end: number;
      readonly to: Anchor | Point;
      /** key of the drawn shape it travels along; null: a straight line */
      readonly along: string | null;
      readonly style: ElementStyle;
    }
  | {
      /** a shape declared again under the same id: it changes into the new one */
      readonly kind: 'morph';
      readonly seq: number;
      readonly start: number;
      readonly end: number;
      readonly geometry: ShapeGeometry;
      readonly style: ElementStyle;
    }
  | { readonly kind: 'hit'; readonly seq: number; readonly start: number; readonly end: number; readonly gesture: HitGesture }
  | { readonly kind: 'strike'; readonly seq: number; readonly start: number; readonly end: number };

export interface ElementSpan {
  /** unique for the conversation: `<id>@<seq of the line that created it>` */
  readonly key: string;
  readonly id: string;
  readonly kind: ElementKind;
  /** the score entry that created it; 0 for carried elements */
  readonly seq: number;
  /** creation order on the stage, which is also drawing order within a layer. A replacement inherits the order of what it replaces, so it keeps the slot. */
  readonly order: number;
  readonly scene: string;
  /** plain text, emphasis markers removed: the words of a text, a node, a link's label, a control's label, a structure's title; '' for anything else */
  readonly text: string;
  readonly emphasis: readonly Range[];
  /** the style it enters with; later changes are in `changes` */
  readonly style: ElementStyle;
  /** what it is as it enters, when it is not text; a morph is in `changes`. A sprite's rows carry their own times. */
  readonly figure: Figure | null;
  /** key of the group it is a part of */
  readonly parent: string | null;
  readonly carried: boolean;
  readonly replaces: string | null;
  /** null for carried elements: they are already there at time zero */
  readonly enter: (Span & { readonly effect: EnterEffect; readonly by: By }) | null;
  /** null while nothing has asked it to leave */
  readonly exit: (Span & { readonly effect: ExitEffect; readonly cause: ExitCause }) | null;
  readonly changes: readonly ElementChange[];
  /** changes a control drives on it (`bind`), in the order written; not on the clock */
  readonly driven: readonly DrivenChange[];
  /** carried in already struck through */
  readonly struck: boolean;
  /** v2.1. The address its words link to; absent: not a link */
  readonly href?: string;
}

/** v2.1. One slide of a deck: the scene that is it, and when it begins and when its own content is done (the clock stops there until the viewer steps on). */
export interface SlideSpan {
  /** 0-based */
  readonly index: number;
  readonly scene: string;
  /** the score entry that opened it */
  readonly seq: number;
  readonly start: number;
  readonly end: number;
}

/** v2.1. `deck | title`: the turn is a deck and each scene after it is a slide. */
export interface DeckSpan {
  readonly title: string;
  readonly seq: number;
  readonly start: number;
  readonly slides: readonly SlideSpan[];
}

export interface SceneSpan {
  readonly id: string;
  /** the score entry that opened it; 0 for the scene carried into the turn */
  readonly seq: number;
  readonly index: number;
  readonly start: number;
  readonly layout: Layout;
  readonly canvas: CanvasName;
  readonly align: Align;
  readonly clear: Clear;
  readonly mood: readonly Timed<Mood>[];
  readonly pace: readonly Timed<Pace>[];
  /** how many in-flow lines the brain said to expect; a `plan lines=` appends a value */
  readonly expected: readonly Timed<number | null>[];
}

export interface CameraSpan extends Span {
  readonly seq: number;
  readonly move: CameraMove;
  /** element key, for `focus` */
  readonly target: string | null;
  /** for `pan` */
  readonly direction: Direction | null;
  readonly speed: CameraSpeed;
  readonly amount: number;
}

export interface LookSpan extends Span {
  readonly seq: number;
  /** the presets the two looks stand on */
  readonly from: LookId;
  readonly look: LookId;
  readonly wearingBefore: ResolvedLook;
  readonly wearing: ResolvedLook;
}

export interface LineTime extends Span {
  readonly seq: number;
  readonly verb: Verb | LessonVerb;
}

export interface ScheduleIssue {
  readonly seq: number;
  readonly issue: Issue;
}

export interface Schedule {
  /** where the next line would start */
  readonly pen: number;
  /** when everything scheduled so far has finished */
  readonly end: number;
  /** the preset the look worn at the end stands on */
  readonly look: LookId;
  /** the look worn at the end of everything scheduled */
  readonly wearing: ResolvedLook;
  readonly styles: StyleSheet;
  readonly colors: ColorSheet;
  readonly lookDefs: LookSheet;
  readonly scenes: readonly SceneSpan[];
  readonly elements: readonly ElementSpan[];
  readonly camera: readonly CameraSpan[];
  readonly looks: readonly LookSpan[];
  readonly lines: readonly LineTime[];
  readonly issues: readonly ScheduleIssue[];
  /** v2.1. Set when the turn is a deck; null otherwise */
  readonly deck: DeckSpan | null;
}

/** v2.1. What the turn's opening asks of the schedule. */
export interface ScheduleOptions {
  /** the turn was opened for a prompt, a tap or a control: choices an earlier turn offered leave as the answer's first line begins (D2c) */
  readonly retireChoices?: boolean;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface MutableElement extends Omit<Mutable<ElementSpan>, 'changes' | 'driven'> {
  changes: ElementChange[];
  driven: DrivenChange[];
}

interface MutableScene extends Omit<Mutable<SceneSpan>, 'mood' | 'pace' | 'expected'> {
  mood: Timed<Mood>[];
  pace: Timed<Pace>[];
  expected: Timed<number | null>[];
}

interface Live {
  readonly span: MutableElement;
  /** the style after every change so far */
  style: ElementStyle;
  /** struck through by a `correct`; no longer addressable by id */
  ghost: boolean;
  /** the struck predecessor that must leave when this one leaves */
  predecessor: Live | null;
  /** a sprite's frames while they are still being written */
  frames: { cells: string; at: number }[][] | null;
  /** a table's or a chart's rows while they are still being written */
  rows: StructureRow[] | null;
}

function isStructureLine(line: CreatingLine): line is StructureLine {
  return Object.hasOwn(STRUCTURE, line.verb);
}

function isControlLine(line: CreatingLine): line is ControlLine {
  return Object.hasOwn(CONTROL, line.verb);
}

/** The least the pen moves for anything drawn, so two shapes written together still arrive one after the other. */
const MIN_STAGGER = 0.06;

function isActive(live: Live, at: number): boolean {
  return live.span.exit === null || live.span.exit.start > at;
}

/**
 * Why a control cannot drive a change on a thing, in words that name the control, the thing and what to do instead. A chart or a diagram is
 * shown, hidden, moved and recoloured like anything else (`set`, `move`); what is in it follows a control through `{…}` in a cell, a title or a mark.
 */
function unbindable(control: string, id: string, kind: ElementKind, figure: Figure | null, effect: DrivenEffect['kind']): string {
  const what = figure?.kind === 'structure' ? (figure.chart === null ? figure.structure : `${figure.chart} chart`) : kind;
  const head = `"${control}" cannot ${effect === 'text' ? 'swap the words of' : effect === 'morph' ? 'reshape' : 'move'} "${id}", a ${what}`;
  if (figure?.kind === 'structure') {
    return `${head}: bind a set (opacity=0 hides it, opacity=1 shows it, ink= recolours it) or a move; for its numbers write {${control}} in a cell, a title or a mark`;
  }
  if (effect === 'text') return `${head}: only text has words to swap; bind a set instead`;
  if (effect === 'morph') return `${head}: only a drawn shape can change into another; bind a set or a move instead`;
  return `${head}: it cannot travel; bind a set instead`;
}

/** Whether two values are the same all the way down: what "declares again exactly what is there" is measured with. */
function alike(a: unknown, b: unknown): boolean {
  if (a === b || (a == null && b == null)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => alike(item, b[index]));
  // A property that is absent and one that is null or undefined say the same thing: there is nothing there.
  const present = (value: unknown): boolean => value !== undefined && value !== null;
  const left = Object.entries(a).filter(([, value]) => present(value));
  const right = Object.entries(b).filter(([, value]) => present(value));
  return left.length === right.length && left.every(([key, value]) => alike(value, Object.getOwnPropertyDescriptor(b, key)?.value));
}

/** Two resolved styles that mean the same: every property alike. */
function sameStyle(a: ElementStyle, b: ElementStyle): boolean {
  return alike(a, b);
}

/** Lines that only define, edit or hand something to the server: the first line that is none of these is the one that begins the answer. */
const QUIET_VERBS: ReadonlySet<string> = new Set(['style', 'color', 'look', 'plan', 'wait', 'revise', 'cancel', 'bind', 'row', 'frame', 'standing', 'refine', ...LESSON_VERBS]);

/** Whether the scene's layout, not the element itself, decides where it goes. Text flows, and so does a control: it takes a line of the flow like a choice does. */
export function isInFlow(style: ElementStyle, layout: Layout, kind: ElementKind = 'text'): boolean {
  if ((kind !== 'text' && kind !== 'control') || style.layer !== 'mid' || style.near !== null || style.group !== null) return false;
  if (style.at === null) return true;
  return layout === 'split' && (style.at === 'left' || style.at === 'right');
}

/** The line a scene's answer rests on: a bold line at the size of `strong` or above. */
function isKeyLine(style: ElementStyle): boolean {
  return style.weight === 'bold' && (style.size === 'l' || style.size === 'xl' || style.size === 'xxl');
}

/** Layouts that show one in-flow line at a time. */
function isOneAtATime(layout: Layout): boolean {
  return layout === 'solo' || layout === 'caption';
}

export function lookOfStage(base: StageBase): ResolvedLook {
  const found = resolveLook(base.lookName, base.looks) ?? resolveLook(base.look, base.looks) ?? resolveLook(DEFAULT_LOOK, {});
  if (found === null) throw new Error('the default look always resolves');
  return found;
}

export function buildSchedule(entries: readonly ScoreEntry[], base: StageBase, options: ScheduleOptions = {}): Schedule {
  const issues: ScheduleIssue[] = [];
  const sheet: Record<string, StyleDef> = { ...base.styles };
  const colors: Record<string, `#${string}`> = { ...base.colors };
  const lookDefs: Record<string, LookDef> = { ...base.looks };
  const elements: MutableElement[] = [];
  const live: Live[] = [];
  const camera: CameraSpan[] = [];
  const looks: LookSpan[] = [];
  const lines: LineTime[] = [];

  let wearing = lookOfStage(base);
  let pace = base.scene.pace;
  let mood = base.scene.mood;
  let pen = 0;
  let previousStart = 0;
  let nextOrder = base.elements.reduce((max, element) => Math.max(max, element.order), -1) + 1;

  let figureCanvasFrom: CanvasName | null = null;
  let scene: MutableScene = {
    id: base.scene.id,
    seq: 0,
    index: base.scene.index,
    start: 0,
    layout: base.scene.layout,
    canvas: base.scene.canvas,
    align: base.scene.align,
    clear: 'none',
    mood: [{ at: 0, value: mood }],
    pace: [{ at: 0, value: pace }],
    expected: [{ at: 0, value: base.scene.expected }],
  };
  const scenes: MutableScene[] = [scene];

  /** v2.1. The deck the turn is, once `deck` has been said; a slide is a scene, and a fresh slide has had nothing written on it yet */
  let deckOpen: { title: string; seq: number; start: number; slides: { scene: string; seq: number; start: number }[]; fresh: boolean } | null = null;
  /** v2.1. Whether the answer's first line has come (carried choices leave with it) */
  let answered = false;
  /**
   * v2.1. A table, a chart or a block of code said again exactly as it stands is not drawn again; the rows that follow are read against the ones
   * it has, and only a row that differs or goes beyond them does anything. The number is how many of its rows have been matched so far.
   */
  const echoing = new Map<Live, number>();
  /**
   * A mock-up written again: a `screen` block whose first screen has the id of a screen already on stage is not a second block. Its lines are put into
   * the block that holds that screen, in the screen's place (`merging`, by the id of the new block). `old` are the rows the screen had, which a row that says
   * the same keeps (and its time), `cursor` where the next row goes.
   */
  const merging = new Map<string, { target: Live; cursor: number; old: StructureRow[]; used: number }>();

  const byKey = new Map<string, Live>();
  /** the line that wrote each row of a table or chart in this turn */
  const rowSeq = new WeakMap<StructureRow, number>();
  for (const element of base.elements) {
    const span: MutableElement = {
      key: element.key,
      id: element.id,
      kind: element.kind,
      seq: 0,
      order: element.order,
      scene: element.scene,
      text: element.text,
      emphasis: element.emphasis,
      style: element.style,
      figure: element.figure,
      parent: element.parent,
      carried: true,
      replaces: element.replaces,
      enter: null,
      exit: null,
      changes: [],
      driven: [...(element.driven ?? [])],
      struck: element.struck,
      ...(element.href !== undefined && { href: element.href }),
    };
    const entry: Live = {
      span,
      style: element.style,
      ghost: element.struck,
      predecessor: null,
      frames: element.figure?.kind === 'sprite' ? element.figure.sprite.frames.map((frame) => frame.map((row) => ({ ...row }))) : null,
      rows: element.figure?.kind === 'structure' ? [...element.figure.rows] : null,
    };
    elements.push(span);
    live.push(entry);
    byKey.set(element.key, entry);
  }
  for (const entry of live) {
    if (entry.span.replaces !== null) entry.predecessor = byKey.get(entry.span.replaces) ?? null;
  }

  const report = (seq: number, code: IssueCode, message: string, token?: string): void => {
    issues.push({ seq, issue: token === undefined ? { code, severity: 'warn', message } : { code, severity: 'warn', message, token } });
  };

  const startOf = (entry: ScoreEntry, when: When | undefined): number => {
    let start = pen;
    if (when !== undefined) {
      if (when.kind === 'with') start = previousStart;
      else if (when.kind === 'after') start = pen + when.seconds;
      else if (when.kind === 'before') start = Math.max(previousStart, pen - when.seconds);
      else if (when.seconds > pen + LIMITS.wait) {
        // An absolute time far past the pen is almost always a relative one misread; it may not stall the stage.
        start = pen + LIMITS.wait;
        report(entry.seq, 'bad-time', `@${when.seconds} is more than ${LIMITS.wait}s past the pen; started ${LIMITS.wait}s after it instead. Use @+N for a delay`);
      } else start = when.seconds;
    }
    return Math.max(start, entry.floor, 0);
  };

  const leave = (target: Live, start: number, effect: ExitEffect, cause: ExitCause): number => {
    const duration = exitSeconds(effect, pace);
    if (target.span.exit === null || target.span.exit.start > start) {
      target.span.exit = { start, end: start + duration, effect, cause };
    }
    if (target.predecessor !== null) leave(target.predecessor, start, effect, cause);
    // A control takes the changes it drives with it: they stop applying when it goes.
    if (target.span.kind === 'control' && target.span.exit?.start === start) {
      for (const other of live) {
        if (other.span.driven.some((change) => change.control === target.span.key && (change.until === undefined || change.until > start))) {
          other.span.driven = other.span.driven.map((change) => (change.control === target.span.key && (change.until === undefined || change.until > start) ? { ...change, until: start } : change));
        }
      }
    }
    // A group takes its parts with it, a structure its nodes and links, a node the links that touch it, and a thing its copies.
    const { kind } = target.span;
    if (kind === 'group' || kind === 'shape' || kind === 'sprite' || kind === 'structure' || kind === 'node') {
      for (const other of live) {
        if (other === target || !isActive(other, start)) continue;
        const figure = other.span.figure;
        const dependent =
          (kind !== 'node' && other.span.parent === target.span.key) ||
          (figure?.kind === 'copy' && figure.source === target.span.key) ||
          (kind === 'node' && figure?.kind === 'link' && (figure.from === target.span.key || figure.to === target.span.key));
        if (dependent) leave(other, start, effect, 'parent');
      }
    }
    return duration;
  };

  /** The id of the screen a row of a mock-up opens (`screen m1 phone | Home`), or null for any other row. */
  const screenOfRow = (cells: string): string | null => /^screen\s+(\S+)/.exec(cells.trim())?.[1] ?? null;

  /** The live mock-up that already holds a screen with this id, and where its rows are: from its `screen` row up to the next one. */
  const findScreen = (id: string, at: number): { readonly block: Live; readonly start: number; readonly end: number } | null => {
    for (let i = live.length - 1; i >= 0; i -= 1) {
      const block = live[i];
      if (block === undefined || block.ghost || block.rows === null || block.span.figure?.kind !== 'structure' || block.span.figure.structure !== 'screen' || !isActive(block, at)) continue;
      const start = block.rows.findIndex((row) => screenOfRow(row.cells[0] ?? '') === id);
      if (start < 0) continue;
      let end = start + 1;
      while (end < block.rows.length && screenOfRow(block.rows[end]?.cells[0] ?? '') === null) end += 1;
      return { block, start, end };
    }
    return null;
  };

  const findLive = (id: string, at: number): Live | null => {
    for (let i = live.length - 1; i >= 0; i -= 1) {
      const candidate = live[i];
      if (candidate !== undefined && candidate.span.id === id && !candidate.ghost && isActive(candidate, at)) return candidate;
    }
    return null;
  };

  /**
   * One line of a mock-up that is written again. A `screen` line takes the rows its screen had out of the block (keeping them to compare); every line, the
   * screen's own included, goes in at the cursor. A row that says what the old one said is the old one, so that nothing moves for nothing; a row that
   * differs is put right where it stands, with the time of the row it replaced (a screen being changed does not come in again from the top).
   */
  const mergeScreenLine = (blockId: string, cells: string, seq: number, at: number): void => {
    const merge = merging.get(blockId);
    if (merge === undefined) return;
    const { target } = merge;
    const rows = target.rows;
    if (rows === null || target.span.figure?.kind !== 'structure') return;
    const id = screenOfRow(cells);
    if (id !== null) {
      // a screen of the block: the rows it had are lifted out, and this one's go in their place. A screen the block does not have goes after the others.
      const found = findScreen(id, at);
      const mine = found !== null && found.block === target ? found : null;
      if (mine !== null) {
        merge.old = rows.splice(mine.start, mine.end - mine.start);
        merge.cursor = mine.start;
      } else {
        merge.old = [];
        merge.cursor = rows.length;
      }
      merge.used = 0;
    }
    if (rows.length >= LIMITS.rows + 1 && merge.used >= merge.old.length) {
      report(seq, 'structure-limit', `a screen block has at most ${LIMITS.rows} rows; this one was ignored`);
      return;
    }
    const kept = merge.old[merge.used];
    merge.used += 1;
    const wanted = [cells.slice(0, LIMITS.line)];
    const before = rows[merge.cursor - 1]?.at ?? 0;
    const tail = merge.old[merge.old.length - 1];
    const landed: StructureRow = kept !== undefined && alike(kept.cells, wanted) ? kept : { cells: wanted, at: Math.max(before, kept?.at ?? tail?.at ?? at) };
    rowSeq.set(landed, seq);
    rows.splice(merge.cursor, 0, landed);
    merge.cursor += 1;
    target.span.figure = { ...target.span.figure, rows: [...rows] };
  };

  const resolveTargets = (target: Target, at: number, seq: number): Live[] => {
    if (target.kind === 'id') {
      const found = findLive(target.id, at);
      if (found === null) {
        report(seq, 'unknown-id', `nothing called "${target.id}" is on stage at that moment`, target.id);
        return [];
      }
      return [found];
    }
    return live.filter((candidate) => isActive(candidate, at) && !candidate.ghost && (target.kind === 'all' || candidate.span.scene === scene.id));
  };

  const applyStay = (target: Live, enterEnd: number): void => {
    const stay = target.style.stay;
    if (stay === 'beat') leave(target, enterEnd + readSeconds(target.span.text, pace), target.style.exit, 'stay');
    else if (typeof stay === 'object') leave(target, enterEnd + stay.seconds, target.style.exit, 'stay');
  };

  /** Keeps the stage within its limits, text and drawn things counted apart: the oldest unpinned element leaves first, then the oldest pinned one. */
  const retireOverflow = (seq: number, keep: Live, at: number): void => {
    const text = keep.span.kind === 'text';
    const limit = text ? LIMITS.elements : LIMITS.figures;
    const alive = (): Live[] => live.filter((candidate) => isActive(candidate, at) && !candidate.ghost && candidate !== keep && (candidate.span.kind === 'text') === text);
    let retired = 0;
    for (let candidates = alive(); candidates.length + 1 > limit; candidates = alive()) {
      const oldest = (pool: Live[]): Live | undefined => pool.reduce<Live | undefined>((best, item) => (best === undefined || item.span.order < best.span.order ? item : best), undefined);
      const unpinned = candidates.filter((candidate) => candidate.style.stay !== 'pin');
      const victim = oldest(unpinned.length > 0 ? unpinned : candidates);
      if (victim === undefined) break;
      leave(victim, at, victim.style.exit, 'limit');
      retired += 1;
    }
    if (retired > 0) report(seq, 'element-limit', `more than ${limit} ${text ? 'lines of text' : 'drawn things'} on stage; the ${retired} oldest left`);
  };

  const contextFor = (kind: ElementKind): StyleContext => ({ kind, look: wearing, layout: scene.layout });

  const styleFor = (seq: number, kind: ElementKind, names: readonly string[], props: StyleProps): ElementStyle => {
    const resolved = resolveStyle(sheet, colors, names, props, contextFor(kind));
    for (const name of resolved.unknownStyles) report(seq, 'unknown-style', `no style called "${name}"; ignored`, name);
    for (const name of resolved.unknownColours) report(seq, 'unknown-colour', `no colour called "${name}"; used ink. Define it first: color ${name}=#rrggbb`, name);
    return resolved.style;
  };

  const coloured = (seq: number, props: StyleProps): ResolvedProps => {
    const resolved = resolveColours(props, colors);
    for (const name of resolved.unknown) report(seq, 'unknown-colour', `no colour called "${name}"; used ink. Define it first: color ${name}=#rrggbb`, name);
    return resolved.props;
  };

  /** A part belongs to its group: it is found now, and it lives on the group's layer. */
  const joinGroup = (seq: number, style: ElementStyle, at: number): { style: ElementStyle; parent: string | null } => {
    if (style.group === null) return { style, parent: null };
    const group = findLive(style.group, at);
    if (group === null || group.span.kind !== 'group') {
      report(seq, 'unknown-id', `no group called "${style.group}" is on stage; drawn on its own`, style.group);
      return { style: { ...style, group: null }, parent: null };
    }
    return { style: { ...style, layer: group.style.layer }, parent: group.span.key };
  };

  const create = (
    entry: ScoreEntry,
    kind: ElementKind,
    id: string,
    style: ElementStyle,
    start: number,
    duration: number,
    order: number,
    extra: { text?: string; emphasis?: readonly Range[]; figure?: Figure; parent?: string | null; predecessor?: Live | null; href?: string },
  ): Live => {
    const span: MutableElement = {
      key: `${id}@${entry.seq}`,
      id,
      kind,
      seq: entry.seq,
      order,
      scene: scene.id,
      text: extra.text ?? '',
      emphasis: extra.emphasis ?? [],
      style,
      figure: extra.figure ?? null,
      parent: extra.parent ?? null,
      carried: false,
      replaces: extra.predecessor?.span.key ?? null,
      enter: { start, end: start + duration, effect: style.enter, by: style.by },
      exit: null,
      changes: [],
      driven: [],
      struck: false,
      ...(extra.href !== undefined && { href: extra.href }),
    };
    const created: Live = { span, style, ghost: false, predecessor: extra.predecessor ?? null, frames: null, rows: null };
    elements.push(span);
    live.push(created);
    byKey.set(span.key, created);
    applyStay(created, start + duration);
    retireOverflow(entry.seq, created, start);
    return created;
  };

  /** Creates a text element and returns the time its entrance and reading are over. */
  const enterText = (
    entry: ScoreEntry,
    id: string,
    rawText: string,
    style: ElementStyle,
    start: number,
    order: number,
    predecessor: Live | null,
    parent: string | null = null,
    href?: string,
  ): number => {
    const { plain, emphasis } = splitEmphasis(rawText);
    // Prose on a page is for reading: it comes in quickly.
    const duration = enterSeconds(style.enter, style.by, plain, pace, style.dur, scene.layout === 'page');
    create(entry, 'text', id, style, start, duration, order, { text: plain, emphasis, predecessor, parent, ...(href !== undefined && { href }) });
    let tail = scene.layout === 'page' && isInFlow(style, scene.layout) ? pageTailSeconds(plain, pace) : tailSeconds(duration, style.by, plain, pace);
    // A label is read with the thing it is on, not after it.
    if (style.near !== null || style.leader) tail = Math.min(tail, beatSeconds(pace) * 0.5);
    // A line the next one replaces (a caption, a solo line) is on stage for its reading time at least; choices stay and need none.
    else if (isOneAtATime(scene.layout) && isInFlow(style, scene.layout) && !style.tap) tail = Math.max(tail, dwellSeconds(plain, pace) - duration);
    return start + duration + tail;
  };

  /** Anything drawn holds the pen for part of its own entrance, unless it is backdrop. */
  const advanceForDrawn = (style: ElementStyle, start: number, duration: number): void => {
    if (BACKDROP_LAYERS.includes(style.layer)) return;
    pen = Math.max(pen, start + Math.max(MIN_STAGGER, duration * DRAW_HOLD));
  };

  /** Where a new element with this id goes in the drawing order, making what it replaces leave. */
  const takeSlot = (id: string, start: number): { order: number; delay: number } => {
    const same = findLive(id, start);
    if (same === null) {
      nextOrder += 1;
      return { order: nextOrder - 1, delay: 0 };
    }
    return { order: same.span.order, delay: leave(same, start, same.style.exit, 'resay') * SOLO_OVERLAP };
  };

  const scheduleCreating = (entry: ScoreEntry, line: CreatingLine): void => {
    const { seq } = entry;
    const start = startOf(entry, line.when);
    const priorStart = previousStart;
    previousStart = start;
    if (deckOpen !== null) deckOpen.fresh = false;

    if (line.verb === 'say') {
      // Text may be a part of a group (`say in=boat | …`): it lives on the group's layer and leaves with it.
      const joined = joinGroup(seq, styleFor(seq, 'text', line.styles, line.props), start);
      const style = joined.style;
      let enterStart = start;
      let order = nextOrder;
      const same = findLive(line.id, start);
      // D2(b): the same words, in the same style, under the id they already have, are not said again.
      if (same !== null && same.span.kind === 'text' && same.span.parent === joined.parent) {
        const words = splitEmphasis(line.text);
        if (same.span.text === words.plain && same.span.emphasis.length === words.emphasis.length && same.span.emphasis.every((range, index) => range.start === words.emphasis[index]?.start && range.end === words.emphasis[index]?.end) && (same.span.href ?? null) === (line.href ?? null) && sameStyle(same.style, style)) {
          previousStart = priorStart;
          lines.push({ seq, verb: line.verb, start, end: start });
          return;
        }
      }
      if (same !== null) {
        order = same.span.order;
        enterStart = start + leave(same, start, same.style.exit, 'resay') * SOLO_OVERLAP;
      } else {
        nextOrder += 1;
        // Choices (tap=yes) gather under the content: they neither replace one another nor are replaced by the next line of content.
        if (isOneAtATime(scene.layout) && isInFlow(style, scene.layout) && !style.tap) {
          for (const candidate of live) {
            // A control, like a choice, stays where it can be worked while the lines above it change.
            if (!isActive(candidate, start) || candidate.span.scene !== scene.id || candidate.style.tap || candidate.span.kind === 'control') continue;
            if (candidate.style.stay === 'pin' || !isInFlow(candidate.style, scene.layout, candidate.span.kind)) continue;
            // The answer's key line (`strong`) is never the one that leaves: a later aside is set under it, and a later key line is the one that replaces it.
            if (isKeyLine(candidate.style) && !isKeyLine(style)) continue;
            enterStart = Math.max(enterStart, start + leave(candidate, start, candidate.style.exit, 'solo') * SOLO_OVERLAP);
          }
        }
      }
      const done = enterText(entry, line.id, line.text, style, enterStart, order, null, joined.parent, line.href);
      if (!BACKDROP_LAYERS.includes(style.layer)) pen = Math.max(pen, done);
      lines.push({ seq, verb: line.verb, start, end: done });
      return;
    }

    if (line.verb === 'group' || line.verb === 'card') {
      const same = findLive(line.id, start);
      if (same !== null && same.span.kind === 'group') {
        // A group written again is the same group, restyled or moved: its parts stay.
        const merged = mergeStyles(sheet, line.styles, line.props);
        for (const name of merged.unknown) report(seq, 'unknown-style', `no style called "${name}"; ignored`, name);
        const change = coloured(seq, merged.props);
        const patched = patchStyle(same.style, change);
        const card = line.verb === 'card' ? { title: splitEmphasis(line.title ?? '').plain, box: line.box ?? null } : null;
        const framed = card !== null && !alike(same.span.figure, { kind: 'group', card });
        // D2(b): said again exactly as it is, it is nothing.
        if (sameStyle(patched, same.style) && !framed) {
          previousStart = priorStart;
          lines.push({ seq, verb: line.verb, start, end: start });
          return;
        }
        const end = start + SET_SECONDS * PACE_TIMING[pace].ease;
        same.style = patched;
        if (framed) same.span.figure = { kind: 'group', card };
        same.span.changes.push({ kind: 'set', seq, start, end, props: change, style: same.style });
        lines.push({ seq, verb: line.verb, start, end });
        return;
      }
      const style = styleFor(seq, 'group', line.styles, line.props);
      const slot = takeSlot(line.id, start);
      const card = line.verb === 'card' ? splitEmphasis(line.title ?? '') : null;
      create(entry, 'group', line.id, style, start, 0, slot.order, {
        figure: card === null || line.verb !== 'card' ? { kind: 'group' } : { kind: 'group', card: { title: card.plain, box: line.box ?? null } },
      });
      lines.push({ seq, verb: line.verb, start, end: start });
      return;
    }

    if (isStructureLine(line)) {
      // A diagram of nodes written again under its own id, as the same kind, is the same diagram retitled, restyled or given another room: its parts stay.
      const open = findLive(line.id, start);
      const openFigure = open?.span.figure;
      if (open !== null && openFigure?.kind === 'structure' && openFigure.structure === line.verb && STRUCTURE[line.verb].parts === 'nodes') {
        const merged = mergeStyles(sheet, line.styles, line.props);
        for (const name of merged.unknown) report(seq, 'unknown-style', `no style called "${name}"; ignored`, name);
        const change = coloured(seq, merged.props);
        const patched = patchStyle(open.style, change);
        const title = line.title === undefined ? null : splitEmphasis(line.title);
        const figure = { ...openFigure, grow: line.grow ?? openFigure.grow, box: line.box ?? openFigure.box, route: line.route ?? openFigure.route };
        // D2(b): the diagram said again exactly as it stands is nothing, not even a pass of its layout.
        if (sameStyle(patched, open.style) && alike(figure, openFigure) && (title === null || (title.plain === open.span.text && alike(title.emphasis, open.span.emphasis)))) {
          previousStart = priorStart;
          lines.push({ seq, verb: line.verb, start, end: start });
          return;
        }
        const end = start + SET_SECONDS * PACE_TIMING[pace].ease;
        open.style = patched;
        open.span.changes.push({ kind: 'set', seq, start, end, props: change, style: open.style });
        if (title !== null) {
          open.span.text = title.plain;
          open.span.emphasis = title.emphasis;
        }
        open.span.figure = figure;
        lines.push({ seq, verb: line.verb, start, end });
        return;
      }
      // A mock-up written again: the screen it opens is on stage already, so it is put there, in its place, and no second block is made.
      if (line.verb === 'screen') {
        const screenId = screenOfRow(line.title ?? '');
        const found = screenId === null ? null : findScreen(screenId, start);
        if (found !== null && found.block.span.id !== line.id) {
          merging.set(line.id, { target: found.block, cursor: found.block.rows === null ? 0 : found.end, old: [], used: 0 });
          mergeScreenLine(line.id, line.title ?? '', seq, start);
          previousStart = priorStart;
          lines.push({ seq, verb: line.verb, start, end: start });
          return;
        }
      }
      const joined = joinGroup(seq, styleFor(seq, 'structure', line.styles, line.props), start);
      // A mock-up's title is its first line, taken as written: it is the first row of the block, and the block has no heading of its own.
      const ui = line.verb === 'screen';
      const { plain, emphasis } = ui ? { plain: '', emphasis: [] } : splitEmphasis(line.title ?? '');
      const wanted: Figure = {
        kind: 'structure',
        structure: line.verb,
        grow: line.grow ?? null,
        chart: line.verb === 'chart' ? (line.chart ?? DEFAULT_CHART) : null,
        words: line.verb === 'chart' ? (line.words ?? []) : [],
        data: line.verb === 'chart' ? (line.data ?? null) : null,
        ...(line.verb === 'chart' && { dataset: line.dataset ?? null }),
        bars: line.verb === 'table' && line.bars === true,
        ...(line.verb === 'code' && { lang: line.lang ?? null, file: line.file ?? null }),
        ...(line.verb === 'tune' && { tempo: line.tempo ?? null, voice: line.voice ?? DEFAULT_TUNE_VOICE, sealed: null }),
        ...(line.verb === 'app' && { height: line.height ?? null, sealed: null }),
        box: line.box ?? null,
        route: line.route ?? false,
        rows: openFigure?.kind === 'structure' ? openFigure.rows : [],
      };
      // D2(b): a table, chart or block of code said again exactly as it stands is not drawn again. Its rows are read against the ones it has.
      if (open !== null && openFigure?.kind === 'structure' && STRUCTURE[line.verb].parts === 'rows' && alike(wanted, openFigure) && sameStyle(open.style, joined.style) && open.span.parent === joined.parent && open.span.text === plain && alike(open.span.emphasis, emphasis) && (!ui || alike(openFigure.rows[0]?.cells, [line.title ?? '']))) {
        echoing.set(open, ui ? 1 : 0);
        previousStart = priorStart;
        lines.push({ seq, verb: line.verb, start, end: start });
        return;
      }
      // The title, when there is one, fades in; the parts that follow carry the rest of the entrance. A frame is plain content: it comes in quickly.
      const duration = plain === '' ? 0 : figureEnterSeconds(joined.style.enter, pace, joined.style.dur, STRUCTURE[line.verb].parts === 'rows');
      const slot = takeSlot(line.id, start);
      const created = create(entry, 'structure', line.id, joined.style, start + slot.delay, duration, slot.order, {
        text: plain,
        emphasis,
        figure: { ...wanted, rows: [] },
        parent: joined.parent,
      });
      if (STRUCTURE[line.verb].parts === 'rows') created.rows = [];
      if (ui) {
        const first: StructureRow = { cells: [line.title ?? ''], at: start + slot.delay };
        created.rows = [first];
        created.span.figure = { ...wanted, rows: [first] };
      }
      lines.push({ seq, verb: line.verb, start, end: start + slot.delay + duration });
      return;
    }

    if (line.verb === 'node') {
      const owner = line.props.in === undefined ? null : findLive(line.props.in, start);
      // A chart takes nodes too: they are its marks.
      if (owner === null || owner.span.figure?.kind !== 'structure' || (STRUCTURE[owner.span.figure.structure].parts !== 'nodes' && owner.span.figure.structure !== 'chart')) {
        report(seq, 'no-structure', `no flow, tree, cycle, timeline, map or chart called "${line.props.in ?? ''}" is on stage for this node; write the structure first`, line.props.in);
        lines.push({ seq, verb: line.verb, start, end: start });
        return;
      }
      const siblings = live.filter((candidate) => candidate.span.kind === 'node' && candidate.span.parent === owner.span.key && isActive(candidate, start));
      const nodeLimit = owner.span.figure.structure === 'chart' ? LIMITS.marks : LIMITS.nodes;
      if (siblings.length >= nodeLimit && findLive(line.id, start) === null) {
        report(seq, 'structure-limit', owner.span.figure.structure === 'chart' ? `a chart has at most ${nodeLimit} marks; this one was ignored` : `a structure has at most ${nodeLimit} nodes; this one was ignored. Split it into two`);
        lines.push({ seq, verb: line.verb, start, end: start });
        return;
      }
      // A node lives on its structure's layer; `in=` is how it was attached and is not a group to join.
      const style: ElementStyle = { ...styleFor(seq, 'node', line.styles, line.props), group: null, layer: owner.style.layer };
      const { plain, emphasis } = splitEmphasis(line.text);
      const duration = figureEnterSeconds(style.enter, pace, style.dur);
      // D2(b): a node said again exactly as it stands, with the arrow into it that it already has, is nothing.
      const there = findLive(line.id, start);
      const wanted: Figure = { kind: 'node', shape: line.shape ?? 'step', values: line.values, ...(line.x !== undefined && { x: line.x }), ...(line.y !== undefined && { y: line.y }) };
      if (there !== null && there.span.kind === 'node' && there.span.parent === owner.span.key && there.span.text === plain && alike(there.span.emphasis, emphasis) && alike(there.span.figure, wanted) && sameStyle(there.style, style)) {
        const source = line.from === undefined || line.from.id === line.id ? null : findLive(line.from.id, start);
        const arrow = findLive(`${line.id}-in`, start);
        const arrowFigure = arrow?.span.figure;
        const arrives = line.from === undefined || (source !== null && arrowFigure?.kind === 'link' && arrowFigure.from === source.span.key && arrowFigure.to === there.span.key && arrow?.span.text === (line.from.label ?? ''));
        if (arrives) {
          previousStart = priorStart;
          lines.push({ seq, verb: line.verb, start, end: start });
          return;
        }
      }
      // A node said again keeps its place in the diagram: the arrows that touch it are re-pointed at the new one instead of leaving with the old.
      const previous = findLive(line.id, start);
      const touching = previous === null || previous.span.kind !== 'node' || previous.span.parent !== owner.span.key ? [] : live.filter((other) => isActive(other, start) && other.span.figure?.kind === 'link' && (other.span.figure.from === previous.span.key || other.span.figure.to === previous.span.key));
      const slot = takeSlot(line.id, start);
      const created = create(entry, 'node', line.id, style, start + slot.delay, duration, slot.order, {
        text: plain,
        emphasis,
        figure: { kind: 'node', shape: line.shape ?? 'step', values: line.values, ...(line.x !== undefined && { x: line.x }), ...(line.y !== undefined && { y: line.y }) },
        parent: owner.span.key,
      });
      if (previous !== null) {
        for (const arrow of touching) {
          const figure = arrow.span.figure;
          if (figure?.kind !== 'link') continue;
          arrow.span.figure = { ...figure, from: figure.from === previous.span.key ? created.span.key : figure.from, to: figure.to === previous.span.key ? created.span.key : figure.to };
          if (arrow.span.exit?.cause === 'parent' && arrow.span.exit.start === start) arrow.span.exit = null;
        }
      }
      if (line.from !== undefined) {
        const source = line.from.id === line.id ? null : findLive(line.from.id, start);
        if (source === null || source.span.kind !== 'node' || source.span.parent !== owner.span.key) {
          report(seq, 'unknown-id', `no node called "${line.from.id}" is in this structure to link from; the node stands unlinked`, line.from.id);
        } else {
          nextOrder += 1;
          const linkStyle: ElementStyle = { ...styleFor(seq, 'link', [], {}), layer: owner.style.layer };
          // The link arrives with its node: it is drawn toward it while the node fades in.
          create(entry, 'link', `${line.id}-in`, linkStyle, start + slot.delay, LINK_SECONDS * PACE_TIMING[pace].ease, nextOrder - 1, {
            text: line.from.label ?? '',
            figure: { kind: 'link', from: source.span.key, to: created.span.key, ends: 'arrow', dashed: false },
            parent: owner.span.key,
          });
        }
      }
      advanceForDrawn(style, start + slot.delay, duration);
      lines.push({ seq, verb: line.verb, start, end: start + slot.delay + duration });
      return;
    }

    if (line.verb === 'link') {
      const ends = line.nodes.map((id) => findLive(id, start));
      const missing = line.nodes.filter((_, index) => ends[index]?.span.kind !== 'node');
      for (const id of missing) report(seq, 'unknown-id', `no node called "${id}" is on stage to link`, id);
      const style = styleFor(seq, 'link', [], line.props);
      const duration = style.dur ?? LINK_SECONDS * PACE_TIMING[pace].ease;
      const label = splitEmphasis(line.text ?? '');
      // D2(b): every connector of the line is already there, joining the same nodes the same way: nothing to draw.
      if (missing.length === 0 && line.nodes.length >= 2 && ends.every((end, index) => end !== null && (index === 0 || end.span.parent === ends[0]?.span.parent))) {
        // It is the same connector when it joins the same two nodes, the same way, with the same words: whatever id it was given.
        const already = line.nodes.slice(0, -1).every((_, index) => {
          const [from, to] = [ends[index], ends[index + 1]];
          if (from === null || from === undefined || to === null || to === undefined) return false;
          return live.some((found) => {
            const figure = found.span.figure;
            return (
              isActive(found, start) &&
              !found.ghost &&
              figure?.kind === 'link' &&
              figure.from === from.span.key &&
              figure.to === to.span.key &&
              figure.ends === (line.ends ?? 'arrow') &&
              figure.dashed === (line.dashed ?? false) &&
              found.span.text === (index === 0 ? label.plain : '') &&
              sameStyle({ ...found.style, layer: style.layer }, style)
            );
          });
        });
        if (already) {
          previousStart = priorStart;
          lines.push({ seq, verb: line.verb, start, end: start });
          return;
        }
      }
      let at = start;
      let made = 0;
      for (let index = 0; index + 1 < ends.length; index += 1) {
        const from = ends[index];
        const to = ends[index + 1];
        if (from === null || to === null || from === undefined || to === undefined || from.span.kind !== 'node' || to.span.kind !== 'node') continue;
        if (from === to) {
          report(seq, 'bad-value', `a link needs two different nodes; "${from.span.id}" cannot lead to itself`, from.span.id);
          continue;
        }
        if (from.span.parent !== to.span.parent) {
          report(seq, 'no-structure', `"${from.span.id}" and "${to.span.id}" are in different structures; a link joins nodes of one`, to.span.id);
          continue;
        }
        const owner = from.span.parent === null ? null : (byKey.get(from.span.parent) ?? null);
        const links = live.filter((candidate) => candidate.span.kind === 'link' && candidate.span.parent === from.span.parent && isActive(candidate, start));
        if (links.length >= LIMITS.links) {
          report(seq, 'structure-limit', `a structure has at most ${LIMITS.links} links; the rest of this line was ignored`);
          break;
        }
        const id = made === 0 ? line.id : `${line.id}-${made + 1}`;
        const slot = takeSlot(id, at);
        create(entry, 'link', id, { ...style, layer: owner?.style.layer ?? style.layer }, at + slot.delay, duration, slot.order, {
          text: made === 0 ? label.plain : '',
          emphasis: made === 0 ? label.emphasis : [],
          figure: { kind: 'link', from: from.span.key, to: to.span.key, ends: line.ends ?? 'arrow', dashed: line.dashed ?? false },
          parent: from.span.parent,
        });
        advanceForDrawn(style, at + slot.delay, duration);
        // A chain is drawn link after link, each beginning when the last is half done.
        at = Math.max(at, at + slot.delay + Math.max(MIN_STAGGER, duration * DRAW_HOLD));
        made += 1;
      }
      lines.push({ seq, verb: line.verb, start, end: made === 0 ? start : at - duration * DRAW_HOLD + duration });
      return;
    }

    if (isControlLine(line)) {
      const alive = live.filter((candidate) => candidate.span.kind === 'control' && isActive(candidate, start) && candidate.span.id !== line.id);
      if (alive.length >= LIMITS.controls) {
        report(seq, 'structure-limit', `at most ${LIMITS.controls} controls can be on stage at once; this one was ignored`);
        lines.push({ seq, verb: line.verb, start, end: start });
        return;
      }
      const joined = joinGroup(seq, styleFor(seq, 'control', line.styles, line.props), start);
      const options = line.options ?? [];
      const min = line.range?.min ?? 0;
      const max = line.range?.max ?? 1;
      let value: ControlValue | null = null;
      if (line.verb === 'slider') value = typeof line.initial === 'number' ? line.initial : min;
      else if (line.verb === 'toggle') value = line.initial === true;
      else if (line.verb === 'pick') value = typeof line.initial === 'number' ? line.initial : 1;
      else if (line.verb === 'input') value = '';
      // A control said again with the same kind and the same range is the same control: it keeps what the user set and what it drives.
      const before = findLive(line.id, start);
      const was = before?.span.figure?.kind === 'control' ? before.span.figure : null;
      const same = was !== null && was.control === line.verb && was.min === min && was.max === max && was.options.length === options.length;
      if (same && line.initial === undefined && was.value !== null && line.verb !== 'input') value = was.value;
      else if (same && line.verb === 'input' && was.value !== null && was.value !== '') value = was.value;
      const { plain, emphasis } = splitEmphasis(line.text ?? '');
      // D2(b): a control said again exactly as it stands is nothing: it keeps what the user set and what it drives.
      if (before !== null && was !== null && same && was.form === (line.verb === 'pick' ? (line.form ?? 'row') : null) && was.step === (line.range?.step ?? null) && was.unit === (line.unit ?? null) && was.send === (line.verb === 'button' ? true : (line.send ?? false)) && alike(was.options, options) && before.span.text === plain && alike(before.span.emphasis, emphasis) && sameStyle(before.style, joined.style) && before.span.parent === joined.parent && (line.initial === undefined || line.initial === was.value)) {
        previousStart = priorStart;
        lines.push({ seq, verb: line.verb, start, end: start });
        return;
      }
      const duration = figureEnterSeconds(joined.style.enter, pace, joined.style.dur);
      const slot = takeSlot(line.id, start);
      const made = create(entry, 'control', line.id, joined.style, start + slot.delay, duration, slot.order, {
        text: plain,
        emphasis,
        figure: { kind: 'control', control: line.verb, form: line.verb === 'pick' ? (line.form ?? 'row') : null, options, min, max, step: line.range?.step ?? null, unit: line.unit ?? null, value, send: line.verb === 'button' ? true : (line.send ?? false) },
        parent: joined.parent,
      });
      if (same && before !== null) {
        for (const other of live) {
          if (other.span.driven.some((change) => change.control === before.span.key)) {
            other.span.driven = other.span.driven.map((change) => {
              if (change.control !== before.span.key) return change;
              const { until: _until, ...kept } = change;
              return { ...kept, control: made.span.key };
            });
          }
        }
      }
      advanceForDrawn(joined.style, start + slot.delay, duration);
      lines.push({ seq, verb: line.verb, start, end: start + slot.delay + duration });
      return;
    }

    if (line.verb === 'pix') {
      const joined = joinGroup(seq, styleFor(seq, 'sprite', line.styles, line.props), start);
      const key: Record<string, Paint | 'none'> = {};
      for (const [char, value] of Object.entries(line.key)) key[char] = value === 'none' ? 'none' : (coloured(seq, { ink: value }).ink ?? 'ink');
      const slot = takeSlot(line.id, start);
      const created = create(entry, 'sprite', line.id, joined.style, start + slot.delay, 0, slot.order, {
        figure: { kind: 'sprite', sprite: { frames: [[]], key, fps: line.fps ?? null } },
        parent: joined.parent,
      });
      created.frames = [[]];
      lines.push({ seq, verb: line.verb, start, end: start });
      return;
    }

    if (line.verb === 'use') {
      const source = findLive(line.source, start);
      if (source === null || source.span.kind === 'text' || source.span.kind === 'field' || source.span.kind === 'picture') {
        report(seq, 'unknown-id', `nothing drawn called "${line.source}" is on stage to copy`, line.source);
        lines.push({ seq, verb: line.verb, start, end: start });
        return;
      }
      const joined = joinGroup(seq, styleFor(seq, 'copy', line.styles, { layer: source.style.layer, ...line.props }), start);
      const duration = figureEnterSeconds(joined.style.enter, pace, joined.style.dur);
      const slot = takeSlot(line.id, start);
      create(entry, 'copy', line.id, joined.style, start + slot.delay, duration, slot.order, { figure: { kind: 'copy', source: source.span.key }, parent: joined.parent });
      advanceForDrawn(joined.style, start + slot.delay, duration);
      lines.push({ seq, verb: line.verb, start, end: start + slot.delay + duration });
      return;
    }

    if (line.verb === 'paint') {
      const style = styleFor(seq, 'picture', line.styles, line.props);
      let over: string | null = null;
      if (line.over !== undefined) {
        const group = findLive(line.over, start);
        if (group === null) report(seq, 'unknown-id', `nothing called "${line.over}" is on stage to paint over; the picture takes the whole canvas`, line.over);
        else over = group.span.key;
      }
      const slot = takeSlot(line.id, start);
      create(entry, 'picture', line.id, style, start, 0, slot.order, {
        figure: { kind: 'picture', prompt: line.prompt, box: line.box ?? null, over, medium: line.medium ?? null, sketch: line.sketch ?? 'fade', mask: line.mask ?? 'none' },
      });
      lines.push({ seq, verb: line.verb, start, end: start });
      return;
    }

    if (line.verb === 'ambient') {
      if (line.kind === 'none') {
        let longest = 0;
        for (const candidate of live) {
          if (candidate.span.kind === 'field' && candidate.span.scene === scene.id && isActive(candidate, start)) longest = Math.max(longest, leave(candidate, start, 'fade', 'drop'));
        }
        lines.push({ seq, verb: line.verb, start, end: start + longest });
        return;
      }
      // Weather belongs behind the subject unless the brain puts it in front; a sky of stars belongs furthest back.
      const layer = line.props.layer ?? (line.kind === 'stars' || line.kind === 'rays' ? 'far' : 'bg');
      const style = styleFor(seq, 'field', line.styles, { ...line.props, layer });
      const there = findLive(line.id, start);
      const figure = there?.span.figure;
      if (there !== null && figure?.kind === 'field' && figure.field === line.kind && figure.amount === (line.amount ?? 'some') && sameStyle(there.style, { ...style, enter: 'fade' })) {
        previousStart = priorStart;
        lines.push({ seq, verb: line.verb, start, end: start });
        return;
      }
      const slot = takeSlot(line.id, start);
      create(entry, 'field', line.id, { ...style, enter: 'fade' }, start, AMBIENT_SECONDS, slot.order, { figure: { kind: 'field', field: line.kind, amount: line.amount ?? 'some' } });
      lines.push({ seq, verb: line.verb, start, end: start + AMBIENT_SECONDS });
      return;
    }

    if (line.verb === 'pic') {
      const style = styleFor(seq, 'picture', line.styles, line.props);
      const there = findLive(line.id, start);
      const figure = there?.span.figure;
      if (there !== null && figure?.kind === 'picture' && figure.from === line.from && alike(figure.box, line.box ?? null) && sameStyle(there.style, style)) {
        previousStart = priorStart;
        lines.push({ seq, verb: line.verb, start, end: start });
        return;
      }
      const joined = joinGroup(seq, style, start);
      const duration = figureEnterSeconds(joined.style.enter, pace, joined.style.dur);
      const slot = takeSlot(line.id, start);
      create(entry, 'picture', line.id, joined.style, start + slot.delay, duration, slot.order, {
        figure: { kind: 'picture', prompt: '', box: line.box ?? null, over: null, medium: null, sketch: 'keep', mask: 'none', from: line.from },
        parent: joined.parent,
      });
      advanceForDrawn(joined.style, start + slot.delay, duration);
      lines.push({ seq, verb: line.verb, start, end: start + slot.delay + duration });
      return;
    }

    // A shape.
    let geometry = line.geometry;
    if (geometry.shape === 'rect' && geometry.full) geometry = { ...geometry, w: CANVAS[scene.canvas].width, h: CANVAS[scene.canvas].height };
    const same = findLive(line.id, start);
    if (same !== null && same.span.kind === 'shape') {
      // Said again, a shape changes into what it now is: only what the line names is restyled.
      const merged = mergeStyles(sheet, line.styles, line.props);
      for (const name of merged.unknown) report(seq, 'unknown-style', `no style called "${name}"; ignored`, name);
      const patched = patchStyle(same.style, coloured(seq, merged.props));
      const now = figureAt(same.span, Number.POSITIVE_INFINITY);
      // D2(b): the same shape, in the same place, in the same dress, is nothing: no morph, no entrance.
      if (now?.kind === 'shape' && alike(now.geometry, geometry) && sameStyle(patched, same.style)) {
        previousStart = priorStart;
        lines.push({ seq, verb: line.verb, start, end: start });
        return;
      }
      same.style = patched;
      const duration = same.style.dur ?? MORPH_SECONDS * PACE_TIMING[pace].ease;
      same.span.changes.push({ kind: 'morph', seq, start, end: start + duration, geometry, style: same.style });
      advanceForDrawn(same.style, start, duration);
      lines.push({ seq, verb: line.verb, start, end: start + duration });
      return;
    }
    const joined = joinGroup(seq, styleFor(seq, 'shape', line.styles, line.props), start);
    const style = joined.style;
    const duration = style.enter === 'draw' ? drawSeconds(lengthOf(geometry), pace, style.dur) : figureEnterSeconds(style.enter, pace, style.dur);
    const slot = takeSlot(line.id, start);
    create(entry, 'shape', line.id, style, start + slot.delay, duration, slot.order, { figure: { kind: 'shape', geometry }, parent: joined.parent });
    advanceForDrawn(style, start + slot.delay, duration);
    lines.push({ seq, verb: line.verb, start, end: start + slot.delay + duration });
  };

  /** Opens a scene: what was on stage leaves, and the new one is planned. A `deck` opens its first slide the same way. */
  const openScene = (entry: ScoreEntry, header: SceneLine, verb: Verb): void => {
    const { seq } = entry;
    const start = startOf(entry, header.when);
    const clear = header.clear ?? 'scene';
    let longest = 0;
    if (clear !== 'none') {
      for (const candidate of live) {
        if (!isActive(candidate, start)) continue;
        if (clear === 'scene' && candidate.style.stay === 'pin' && !candidate.ghost) continue;
        longest = Math.max(longest, leave(candidate, start, candidate.style.exit, 'scene'));
      }
    }
    pace = header.pace ?? pace;
    mood = header.mood ?? mood;
    const index = scene.index + 1;
    // A picture-first scene that names no canvas gets the square one (about 41% of a landscape screen instead of 23%); the next scene goes back.
    const inherited: CanvasName = figureCanvasFrom ?? scene.canvas;
    const defaulted: boolean = header.canvas === undefined && header.layout === 'figure' && inherited === 'wide';
    const canvas: CanvasName = header.canvas ?? (defaulted ? 'square' : inherited);
    figureCanvasFrom = defaulted ? inherited : null;
    scene = {
      id: header.id ?? `s${index}`,
      seq,
      index,
      start,
      layout: header.layout ?? 'stack',
      canvas,
      align: header.align ?? 'auto',
      clear,
      mood: [{ at: start, value: mood }],
      pace: [{ at: start, value: pace }],
      expected: [{ at: start, value: header.lines ?? null }],
    };
    scenes.push(scene);
    pen = Math.max(pen, start + longest * SCENE_OVERLAP);
    previousStart = start;
    lines.push({ seq, verb, start, end: start + longest });
  };

  for (const entry of entries) {
    if (entry.void) continue;
    const { line, seq } = entry;
    // D2(c): the answer's first line is when the choices an earlier turn offered are taken away, the tapped one too.
    if (options.retireChoices === true && !answered && !QUIET_VERBS.has(line.verb)) {
      answered = true;
      const at = Math.max(pen, entry.floor);
      for (const candidate of live) {
        if (candidate.span.carried && candidate.style.tap && !candidate.ghost && isActive(candidate, at)) leave(candidate, at, candidate.style.exit, 'answered');
      }
    }
    // A tune is whole when the brain says anything else: then its music can begin, and the picture knows when.
    if (line.verb !== 'row' && line.verb !== 'revise' && line.verb !== 'cancel' && line.verb !== 'standing' && line.verb !== 'refine' && !isLessonVerb(line.verb)) {
      for (const candidate of live) {
        const figure = candidate.span.figure;
        if (figure?.kind === 'structure' && (figure.structure === 'tune' || figure.structure === 'app') && !candidate.span.carried && (figure.sealed ?? null) === null && candidate.span.seq < seq) {
          candidate.span.figure = { ...figure, sealed: Math.max(pen, entry.floor) };
          // what of the music could not be played is said once, here, when the score is whole
          if (figure.structure === 'tune') for (const warning of cachedTune(tuneRowsOf(figure.rows), { tempo: figure.tempo ?? null, title: candidate.span.text === '' ? null : candidate.span.text }).warnings) report(seq, 'bad-value', `the tune: ${warning}`);
        }
      }
    }
    switch (line.verb) {
      case 'style': {
        sheet[line.name] = line.like === undefined ? { props: line.props } : { like: line.like, props: line.props };
        lines.push({ seq, verb: line.verb, start: pen, end: pen });
        break;
      }

      case 'color': {
        for (const [name, hex] of Object.entries(line.colors)) colors[name] = hex;
        lines.push({ seq, verb: line.verb, start: pen, end: pen });
        break;
      }

      case 'plan': {
        if (line.pace !== undefined) {
          pace = line.pace;
          scene.pace.push({ at: pen, value: pace });
        }
        if (line.mood !== undefined) {
          mood = line.mood;
          scene.mood.push({ at: pen, value: mood });
        }
        // A changed line count is about layout, so it applies to the whole scene as early as it can be seen.
        if (line.lines !== undefined) scene.expected.push({ at: Math.max(scene.start, entry.floor), value: line.lines });
        lines.push({ seq, verb: line.verb, start: pen, end: pen });
        break;
      }

      case 'scene': {
        openScene(entry, line, 'scene');
        if (deckOpen !== null) {
          const slide = { scene: scene.id, seq, start: scene.start };
          // A scene written straight after `deck`, before anything was put on the first slide, is that slide's own header.
          if (deckOpen.fresh && deckOpen.slides.length === 1) deckOpen.slides[0] = slide;
          else deckOpen.slides.push(slide);
          deckOpen.fresh = false;
        }
        break;
      }

      case 'deck': {
        openScene(entry, { verb: 'scene', ...(line.when !== undefined && { when: line.when }) }, 'deck');
        deckOpen = { title: line.title, seq, start: scene.start, slides: [{ scene: scene.id, seq, start: scene.start }], fresh: true };
        break;
      }

      case 'standing':
      case 'refine':
        // For the server alone: it keeps what the user asked to hold, and starts the passes. Nothing here is on the clock.
        break;

      case 'part':
      case 'step':
      case 'ask':
      case 'hint':
      case 'reply':
      case 'end':
        // The words of the document and its lessons (v3, lesson.ts). They put nothing on a painted stage and take no time: the document keeps them.
        lines.push({ seq, verb: line.verb, start: pen, end: pen });
        break;

      case 'say':
      case 'circle':
      case 'ellipse':
      case 'rect':
      case 'line':
      case 'poly':
      case 'path':
      case 'pix':
      case 'group':
      case 'use':
      case 'paint':
      case 'ambient':
      case 'flow':
      case 'tree':
      case 'cycle':
      case 'timeline':
      case 'map':
      case 'table':
      case 'chart':
      case 'code':
      case 'tune':
      case 'app':
      case 'screen':
      case 'pic':
      case 'node':
      case 'link':
      case 'button':
      case 'toggle':
      case 'slider':
      case 'pick':
      case 'input':
      case 'card':
        scheduleCreating(entry, line);
        break;

      case 'bind': {
        // Not on the clock: a binding takes no time and holds nothing. It lasts as long as the element it changes.
        const at = Math.max(pen, entry.floor);
        lines.push({ seq, verb: line.verb, start: at, end: at });
        const control = findLive(line.control, at);
        if (control === null || control.span.figure?.kind !== 'control') {
          const other = control === null ? null : control.span.kind;
          report(seq, 'bad-bind', other === null ? `no control called "${line.control}" is on stage to bind; write the slider, toggle or pick first` : `"${line.control}" is a ${other}, not a control; only a button, toggle, slider, pick or input can drive a change`, line.control);
          break;
        }
        const { change } = line;
        const targets: Live[] = change.verb === 'set' ? resolveTargets(change.target, at, seq) : [findLive(change.id, at)].filter((found): found is Live => found !== null);
        if (targets.length === 0) {
          if (change.verb !== 'set') report(seq, 'bad-bind', `"${line.control}" is bound to "${change.id}", and nothing called that is on stage; draw it first (a chart, a flow, a code block and any of their parts can be changed too)`, change.id);
          break;
        }
        let effect: DrivenEffect;
        if (change.verb === 'set') {
          const merged = mergeStyles(sheet, change.styles, change.props);
          for (const name of merged.unknown) report(seq, 'unknown-style', `no style called "${name}"; ignored`, name);
          effect = { kind: 'set', props: coloured(seq, merged.props) };
        } else if (change.verb === 'move') {
          let along: string | null = null;
          let to = change.to;
          if (change.along !== undefined) {
            const track = findLive(change.along, at);
            const figure = track?.span.figure;
            const outline = figure?.kind === 'shape' ? outlineOf(figure.geometry)[0] : undefined;
            // A link may be travelled too; where it runs is the painter's to say, so the end is left to it.
            if (track !== null && figure?.kind === 'link') along = track.span.key;
            else if (track === null || outline === undefined) report(seq, 'unknown-id', `no drawn shape called "${change.along}" is on stage to travel along; moved straight`, change.along);
            else {
              along = track.span.key;
              to ??= pointAlong(outline, 1);
            }
          }
          if (to === undefined && along === null) break;
          effect = { kind: 'move', to: to ?? 'center', along };
        } else if (change.verb === 'correct') {
          const { plain, emphasis } = splitEmphasis(change.text);
          effect = { kind: 'text', text: plain, emphasis };
        } else {
          const merged = mergeStyles(sheet, change.styles, change.props);
          effect = { kind: 'morph', geometry: change.geometry, props: coloured(seq, merged.props) };
        }
        const bound = live.reduce((count, candidate) => (isActive(candidate, at) ? count + candidate.span.driven.length : count), 0);
        if (bound + targets.length > LIMITS.binds) {
          report(seq, 'structure-limit', `at most ${LIMITS.binds} bound changes can be on stage at once; this one was ignored`);
          break;
        }
        for (const target of targets) {
          const fits =
            effect.kind === 'set' || (effect.kind === 'move' && target.span.kind !== 'field' && target.span.kind !== 'node' && target.span.kind !== 'link') || (effect.kind === 'morph' && target.span.kind === 'shape') || (effect.kind === 'text' && target.span.kind === 'text');
          if (!fits) {
            report(seq, 'bad-bind', unbindable(line.control, target.span.id, target.span.kind, target.span.figure, effect.kind), target.span.id);
            continue;
          }
          target.span.driven.push({ seq, control: control.span.key, on: line.on, effect, since: at });
        }
        break;
      }

      case 'row': {
        if (merging.has(line.id)) {
          mergeScreenLine(line.id, line.cells, entry.seq, Math.max(pen, entry.floor));
          lines.push({ seq: entry.seq, verb: line.verb, start: pen, end: pen });
          break;
        }
        const table = findLive(line.id, Math.max(pen, entry.floor));
        if (table !== null && table.span.figure?.kind === 'structure' && table.rows !== null) {
          // A row of a table or a chart: cells between bars. It lands a step after the row before it.
          const enter = table.span.enter;
          const charted = table.span.figure.structure === 'chart';
          const app = table.span.figure.structure === 'app';
          const coded = table.span.figure.structure === 'code' || table.span.figure.structure === 'tune' || table.span.figure.structure === 'screen' || app;
          const interfaced = table.span.figure.structure === 'screen';
          // A line of code is one cell, exactly as written: a bar in it is a bar, a space is a space, and an empty line is a row.
          const cells = coded ? [line.cells] : splitCells(line.cells);
          const step = (app ? APP_ROW_SECONDS : interfaced ? UI_ROW_SECONDS : coded ? CODE_ROW_SECONDS : charted ? CHART_ROW_SECONDS : TABLE_ROW_SECONDS)[pace];
          const most = app ? LIMITS.appRows : table.span.figure.structure === 'tune' ? LIMITS.tuneRows : coded ? LIMITS.codeRows : charted ? LIMITS.chartPoints : LIMITS.rows;
          if (!coded && (isRuleRow(cells) || cells.every((cell) => cell === ''))) {
            lines.push({ seq, verb: line.verb, start: pen, end: pen });
            break;
          }
          // D2(b): the block said again is read row by row against what it has. A row that is the same is nothing; one that differs is put right where it
          // stands, with no new entrance; one past the end is the block growing, and lands as any row does.
          const matched = echoing.get(table);
          if (matched !== undefined) {
            const have = table.rows[matched];
            if (have !== undefined) {
              const wanted = cells.slice(0, LIMITS.cells);
              if (!alike(have.cells, wanted)) {
                const fixed: StructureRow = { cells: wanted, at: have.at };
                table.rows[matched] = fixed;
                table.span.figure = { ...table.span.figure, rows: [...table.rows] };
              }
              echoing.set(table, matched + 1);
              lines.push({ seq, verb: line.verb, start: pen, end: pen });
              break;
            }
            echoing.delete(table);
          }
          if (app && table.rows.reduce((sum, row) => sum + (row.cells[0]?.length ?? 0) + 1, 0) + (line.cells.length + 1) > LIMITS.appChars) {
            report(seq, 'structure-limit', `an app is at most ${LIMITS.appChars} characters; this line and the rest were ignored: write less`);
            lines.push({ seq, verb: line.verb, start: pen, end: pen });
            break;
          }
          if (table.rows.length >= most) {
            report(seq, 'structure-limit', `a ${table.span.figure.structure} has at most ${most} rows; this one was ignored`);
            lines.push({ seq, verb: line.verb, start: pen, end: pen });
            break;
          }
          if (cells.length > LIMITS.cells) report(seq, 'structure-limit', `a row has at most ${LIMITS.cells} cells; the rest were cut`);
          const at = Math.max(enter === null ? 0 : enter.end + table.rows.length * step, pen, entry.floor);
          const landed: StructureRow = { cells: cells.slice(0, LIMITS.cells), at };
          rowSeq.set(landed, seq);
          table.rows.push(landed);
          table.span.figure = { ...table.span.figure, rows: [...table.rows] };
          if (!BACKDROP_LAYERS.includes(table.style.layer)) pen = Math.max(pen, at + step);
          lines.push({ seq, verb: line.verb, start: at, end: at + step });
          break;
        }
        const sprite = table;
        if (sprite === null || sprite.span.kind !== 'sprite' || sprite.span.figure?.kind !== 'sprite' || sprite.frames === null) {
          report(seq, 'no-sprite', `no sprite, table or chart called "${line.id}" is being written; write a pix, table or chart line first`, line.id);
          lines.push({ seq, verb: line.verb, start: pen, end: pen });
          break;
        }
        const frame = sprite.frames[sprite.frames.length - 1];
        if (frame === undefined || frame.length >= LIMITS.sprite) {
          report(seq, 'sprite-limit', `a sprite has at most ${LIMITS.sprite} rows; this one was ignored`);
          lines.push({ seq, verb: line.verb, start: pen, end: pen });
          break;
        }
        // A space is an empty cell, like `.`. A row narrower than the sprite's first is padded with empty cells; the brain is told.
        let cells = line.cells.replace(/\s/g, '.');
        if (cells.length > LIMITS.sprite) {
          cells = cells.slice(0, LIMITS.sprite);
          report(seq, 'sprite-limit', `a sprite is at most ${LIMITS.sprite} cells wide; the rest of this row was cut`);
        }
        const width = sprite.frames[0]?.[0]?.cells.length ?? cells.length;
        if (cells.length < width) {
          report(seq, 'ragged-sprite', `row has ${cells.length} cells but the sprite is ${width} wide; padded with empty cells. Count: every row exactly as wide as the first`);
          cells = cells.padEnd(width, '.');
        } else if (cells.length > width) {
          report(seq, 'ragged-sprite', `row has ${cells.length} cells but the sprite is ${width} wide; kept. Every row should be exactly as wide as the first`);
        }
        const enter = sprite.span.enter;
        const first = sprite.frames.length === 1;
        const step = sprite.style.enter === 'draw' && first && enter !== null ? ROW_SECONDS[pace] : 0;
        const at = Math.max(enter === null ? 0 : enter.start + frame.length * step, entry.floor);
        frame.push({ cells, at });
        sprite.span.figure = { kind: 'sprite', sprite: { ...sprite.span.figure.sprite, frames: sprite.frames.map((rows) => [...rows]) } };
        if (enter !== null && first) {
          const duration = sprite.style.enter === 'draw' ? Math.max(spriteSeconds(frame.length, pace, null), at + step - enter.start) : figureEnterSeconds(sprite.style.enter, pace, sprite.style.dur);
          sprite.span.enter = { ...enter, end: enter.start + duration };
          if (sprite.span.exit?.cause === 'stay') {
            sprite.span.exit = null;
            applyStay(sprite, enter.start + duration);
          }
          if (!BACKDROP_LAYERS.includes(sprite.style.layer)) pen = Math.max(pen, enter.start + duration);
        }
        lines.push({ seq, verb: line.verb, start: at, end: at + step });
        break;
      }

      case 'frame': {
        const sprite = findLive(line.id, Math.max(pen, entry.floor));
        if (sprite === null || sprite.frames === null || sprite.span.figure?.kind !== 'sprite') {
          report(seq, 'no-sprite', `no sprite called "${line.id}" is being drawn; write a pix line first`, line.id);
        } else if (sprite.frames.length >= LIMITS.frames) {
          report(seq, 'sprite-limit', `a sprite has at most ${LIMITS.frames} frames; this one was ignored`);
        } else if ((sprite.frames[sprite.frames.length - 1] ?? []).length > 0) {
          sprite.frames.push([]);
        }
        lines.push({ seq, verb: line.verb, start: pen, end: pen });
        break;
      }

      case 'correct': {
        const start = startOf(entry, line.when);
        const old = findLive(line.id, start);
        let done: number;
        if (old === null || old.span.kind !== 'text') {
          report(seq, 'unknown-id', `no text called "${line.id}" is on stage to correct; said as a new line`, line.id);
          done = enterText(entry, line.id, line.text, completeStyle({}, contextFor('text')), start, nextOrder, null);
          nextOrder += 1;
        } else {
          const strikeEnd = start + STRIKE_SECONDS;
          old.span.changes.push({ kind: 'strike', seq, start, end: strikeEnd });
          const inherited = old.style;
          if (old.span.exit !== null && old.span.exit.start > start) old.span.exit = null;
          old.ghost = true;
          old.style = { ...old.style, stay: 'scene' };
          done = enterText(entry, line.id, line.text, { ...inherited, dur: null }, strikeEnd + beatSeconds(pace) * 0.5, old.span.order, old);
          // the struck words are seen struck, and go as soon as the replacement has landed: nobody wants to read a strike-through at rest
          leave(old, done, old.style.exit, 'resay');
        }
        pen = Math.max(pen, done);
        previousStart = start;
        lines.push({ seq, verb: line.verb, start, end: done });
        break;
      }

      case 'set': {
        const start = startOf(entry, line.when);
        const merged = mergeStyles(sheet, line.styles, line.props);
        for (const name of merged.unknown) report(seq, 'unknown-style', `no style called "${name}"; ignored`, name);
        const props = coloured(seq, merged.props);
        const end = start + moveSeconds(line.speed, line.over, SET_SECONDS * PACE_TIMING[pace].ease);
        // Colour set on a group or a structure is colour set on its parts; place, turn, size and opacity belong to the group itself.
        const { ink, fill, stroke, thick } = props;
        const inherited: ResolvedProps = {
          ...(ink !== undefined && { ink }),
          ...(fill !== undefined && { fill }),
          ...(stroke !== undefined && { stroke }),
          ...(thick !== undefined && { thick }),
        };
        const apply = (target: Live, change: ResolvedProps): void => {
          target.style = patchStyle(target.style, change);
          target.span.changes.push({ kind: 'set', seq, start, end, props: change, style: target.style });
          if (change.stay === 'beat') leave(target, end + beatSeconds(pace), target.style.exit, 'stay');
          else if (typeof change.stay === 'object') leave(target, end + change.stay.seconds, target.style.exit, 'stay');
          else if (change.stay !== undefined && target.span.exit?.cause === 'stay' && target.span.exit.start > start) {
            target.span.exit = null;
          }
        };
        const targets = resolveTargets(line.target, start, seq);
        for (const target of targets) {
          apply(target, props);
          if ((target.span.kind !== 'group' && target.span.kind !== 'structure') || Object.keys(inherited).length === 0) continue;
          for (const part of live) {
            if (part.span.parent === target.span.key && isActive(part, start) && !targets.includes(part)) apply(part, inherited);
          }
        }
        previousStart = start;
        lines.push({ seq, verb: line.verb, start, end });
        break;
      }

      case 'move': {
        const start = startOf(entry, line.when);
        const end = start + moveSeconds(line.speed, line.over, MOVE_SECONDS.steady);
        previousStart = start;
        const target = findLive(line.id, start);
        if (target === null) {
          report(seq, 'unknown-id', `nothing called "${line.id}" is on stage to move`, line.id);
          lines.push({ seq, verb: line.verb, start, end: start });
          break;
        }
        let along: string | null = null;
        let to = line.to;
        if (line.along !== undefined) {
          const track = findLive(line.along, start);
          const figure = track?.span.figure;
          const outline = figure?.kind === 'shape' ? outlineOf(figure.geometry)[0] : undefined;
          if (track === null || outline === undefined) report(seq, 'unknown-id', `no drawn shape called "${line.along}" is on stage to travel along; moved straight`, line.along);
          else {
            along = track.span.key;
            to ??= pointAlong(outline, 1);
          }
        }
        if (to === undefined) {
          lines.push({ seq, verb: line.verb, start, end: start });
          break;
        }
        target.style = patchStyle(target.style, { at: to });
        target.span.changes.push({ kind: 'move', seq, start, end, to, along, style: target.style });
        lines.push({ seq, verb: line.verb, start, end });
        break;
      }

      case 'drop': {
        const start = startOf(entry, line.when);
        let longest = 0;
        const targets = resolveTargets(line.target, start, seq);
        for (const id of line.also ?? []) targets.push(...resolveTargets({ kind: 'id', id }, start, seq));
        for (const target of targets) {
          longest = Math.max(longest, leave(target, start, line.exit ?? target.style.exit, 'drop'));
        }
        previousStart = start;
        lines.push({ seq, verb: line.verb, start, end: start + longest });
        break;
      }

      case 'hit': {
        const start = startOf(entry, line.when);
        const end = start + HIT_SECONDS[line.gesture] * PACE_TIMING[pace].ease;
        const target = findLive(line.id, start);
        if (target === null) {
          report(seq, 'unknown-id', `nothing called "${line.id}" is on stage to point at`, line.id);
        } else {
          target.span.changes.push({ kind: 'hit', seq, start, end, gesture: line.gesture });
          pen = Math.max(pen, end);
        }
        previousStart = start;
        lines.push({ seq, verb: line.verb, start, end });
        break;
      }

      case 'cam': {
        const start = startOf(entry, line.when);
        const speed = line.speed ?? 'steady';
        const end = start + cameraSeconds(line.move, speed, line.over);
        let target: string | null = null;
        if (line.move === 'focus' && line.target !== undefined) {
          const found = findLive(line.target, start);
          if (found === null) {
            report(seq, 'unknown-id', `nothing called "${line.target}" is on stage to focus on`, line.target);
            lines.push({ seq, verb: line.verb, start, end: start });
            break;
          }
          target = found.span.key;
        }
        camera.push({ seq, start, end, move: line.move, target, direction: line.move === 'pan' ? (line.direction ?? 'right') : null, speed, amount: line.amount ?? 1 });
        previousStart = start;
        lines.push({ seq, verb: line.verb, start, end });
        break;
      }

      case 'wait': {
        const start = Math.max(pen, entry.floor);
        pen = start + waitSeconds(line.beats, line.seconds, pace);
        previousStart = start;
        lines.push({ seq, verb: line.verb, start, end: pen });
        break;
      }

      case 'look': {
        const start = startOf(entry, line.when);
        const defines = line.like !== undefined || Object.keys(line.props).length > 0;
        if (defines) lookDefs[line.look] = line.like === undefined ? { props: line.props } : { like: line.like, props: line.props };
        const next = resolveLook(line.look, lookDefs);
        if (next === null) {
          report(seq, 'unknown-look', `no look called "${line.look}"; give it properties to define it, or use a preset`, line.look);
          lines.push({ seq, verb: line.verb, start, end: start });
          break;
        }
        if (!defines && next.name === wearing.name) {
          lines.push({ seq, verb: line.verb, start, end: start });
          break;
        }
        const end = start + LOOK_CHANGE_SECONDS;
        looks.push({ seq, start, end, from: wearing.preset, look: next.preset, wearingBefore: wearing, wearing: next });
        wearing = next;
        pen = Math.max(pen, end);
        previousStart = start;
        lines.push({ seq, verb: line.verb, start, end });
        break;
      }

      case 'cancel': {
        // Only the whole-future form reaches here; it leaves a marker that pulls the pen back to "now".
        let entering = entry.floor;
        for (const element of elements) {
          if (element.enter !== null && element.enter.start < entry.floor) entering = Math.max(entering, element.enter.end);
        }
        pen = entering;
        previousStart = entry.floor;
        lines.push({ seq, verb: line.verb, start: entry.floor, end: entry.floor });
        break;
      }

      case 'revise':
        break;
    }
  }

  // What is wrong with the rows of a chart is told when the row that made it wrong arrived, so the brain hears it once.
  const scope: Record<string, number> = {};
  for (const candidate of live) {
    const figure = candidate.span.figure;
    if (figure?.kind === 'control' && isActive(candidate, pen)) scope[candidate.span.id] = numberOf(figure.value);
  }
  for (const candidate of live) {
    const figure = candidate.span.figure;
    if (candidate.rows === null || figure?.kind !== 'structure' || figure.chart === null || candidate.rows.length === 0 || candidate.rows.every((row) => rowSeq.get(row) === undefined)) continue;
    const { rows } = candidate;
    const kind = figure.chart;
    // A cell may name a control that is written after it (P2-2): until it is, it stands for a number, and nothing is said about it. A name that
    // never turns up is a control the brain forgot, and the dash on the chart says so.
    const pending: Record<string, number> = { ...scope };
    for (const row of rows) {
      for (const cell of row.cells) {
        const braces = /^\{(.+)\}$/.exec(cell.trim());
        const expr = braces === null ? null : parseExpr(braces[1] ?? '');
        if (expr !== null) for (const name of namesIn(expr)) if (!Object.hasOwn(pending, name)) pending[name] = 1;
      }
    }
    const model = chartModelOf(kind, rows, pending);
    // A chart with only its header so far is not wrong yet.
    if (model.points.length === 0) continue;
    for (const problem of model.problems) {
      // The first row that brings the problem in: the problem stays once it is there.
      let low = 0;
      let high = rows.length - 1;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (chartModelOf(kind, rows.slice(0, middle + 1), pending).problems.includes(problem)) high = middle;
        else low = middle + 1;
      }
      const arrived = rows[low];
      const at = arrived === undefined ? undefined : rowSeq.get(arrived);
      if (at !== undefined) report(at, 'bad-value', `${kind} chart "${candidate.span.id}": ${problem}`);
    }
  }

  let end = pen;
  for (const element of elements) {
    if (element.enter !== null) end = Math.max(end, element.enter.end);
    if (element.exit !== null) end = Math.max(end, element.exit.end);
    for (const change of element.changes) end = Math.max(end, change.end);
  }
  for (const move of camera) end = Math.max(end, move.end);
  for (const change of looks) end = Math.max(end, change.end);

  // A deck says where each slide begins and where its own content is done: the stage stops there until the viewer steps on.
  const deck: DeckSpan | null =
    deckOpen === null
      ? null
      : {
          title: deckOpen.title,
          seq: deckOpen.seq,
          start: deckOpen.start,
          slides: deckOpen.slides.map((slide, index) => {
            const next = deckOpen?.slides[index + 1];
            const own = lines.filter((time) => time.seq > slide.seq && (next === undefined || time.seq < next.seq));
            return { index, scene: slide.scene, seq: slide.seq, start: slide.start, end: own.reduce((latest, time) => Math.max(latest, time.end), slide.start) };
          }),
        };

  return { pen, end, look: wearing.preset, wearing, styles: sheet, colors, lookDefs, scenes, elements, camera, looks, lines, issues, deck };
}

/** The last value of a timed list that has taken effect by `at`. */
export function valueAt<T>(timed: readonly Timed<T>[], at: number, fallback: T): T {
  let value = fallback;
  for (const item of timed) {
    if (item.at <= at) value = item.value;
  }
  return value;
}

export function sceneAt(schedule: Schedule, at: number): SceneSpan {
  let found = schedule.scenes[0];
  for (const scene of schedule.scenes) {
    if (scene.start <= at) found = scene;
  }
  if (found === undefined) throw new Error('a schedule always has at least the carried scene');
  return found;
}

/** The preset the look worn at `at` stands on. */
export function lookAt(schedule: Schedule, base: StageBase, at: number): LookId {
  let look = base.look;
  for (const change of schedule.looks) {
    if (change.start <= at) look = change.look;
  }
  return look;
}

/** The look worn at `at`, fully resolved. */
export function wearingAt(schedule: Schedule, base: StageBase, at: number): ResolvedLook {
  let wearing = lookOfStage(base);
  for (const change of schedule.looks) {
    if (change.start <= at) wearing = change.wearing;
  }
  return wearing;
}

/** The style an element has at `at`, after every `set`, `move` and morph that has started by then. */
export function styleAt(element: ElementSpan, at: number): ElementStyle {
  let style = element.style;
  for (const change of element.changes) {
    if ((change.kind === 'set' || change.kind === 'move' || change.kind === 'morph') && change.start <= at) style = change.style;
  }
  return style;
}

/** What a drawn element is at `at`: a shape after its morphs, a sprite with the rows that have landed. Null for text. */
export function figureAt(element: ElementSpan, at: number): Figure | null {
  const { figure } = element;
  if (figure === null) return null;
  if (figure.kind === 'shape') {
    let geometry = figure.geometry;
    for (const change of element.changes) {
      if (change.kind === 'morph' && change.start <= at) geometry = change.geometry;
    }
    return geometry === figure.geometry ? figure : { kind: 'shape', geometry };
  }
  if (figure.kind === 'sprite') {
    return { kind: 'sprite', sprite: { ...figure.sprite, frames: figure.sprite.frames.map((rows, index) => (index === 0 ? rows.filter((row) => row.at <= at) : rows)) } };
  }
  if (figure.kind === 'structure' && figure.rows.length > 0) return { ...figure, rows: figure.rows.filter((row) => row.at <= at) };
  return figure;
}

export function isStruckAt(element: ElementSpan, at: number): boolean {
  return element.struck || element.changes.some((change) => change.kind === 'strike' && change.start <= at);
}
