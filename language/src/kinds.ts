// The language's half of the kind contract (PLAN-v3-core 2.3, package PC1): what each kind is called, what it holds, how the brain is
// taught it and how it is told in a few words. It lives here so the server builds the prompt and the brief with no painter.
//
// A KIND is anything that takes a box on the stage: words, a choice, the free canvas, a structure, a control. The painter's half
// (`web/src/core/contracts.ts`) holds the same keys; both are `{ [K in KindId]: … }`, so a kind added to the vocabulary stops the build
// in exactly two places and names itself there:
//
//   web/src/core/registry.ts   Property 'newkind' is missing in type … but required in type 'Registry'      (TS2741)
//   language/src/kinds.ts      Property 'newkind' is missing in type … but required in type 'Lexicon'       (TS2741)
//
// Teaching is derived: `teachingFor(capabilities)` walks `LEXICON` over what a painter advertises. Nothing here is wired into
// `prompt.ts` yet (WS7 owns it); `taughtNotAdvertised` is the run-time half of the check (review I2) for the day it is.

import type { ControlKind, StructureKind } from './vocabulary';
import { CONTROL_KINDS, SHAPE_VERBS, STRUCTURE_KINDS, VERB } from './vocabulary';
import type { ElementSpan } from './schedule';
import { describeFigure } from './stage';
import { asksForLiveApp } from './app';
import { asksForFigure } from './figure';
import type { Capabilities } from './wire';

export type KindId = 'words' | 'choice' | 'canvas' | 'figure' | StructureKind | ControlKind;

/** The kinds that are structures or controls: the ones a capability list names. */
export const isStructureKind = (id: KindId): id is StructureKind => (STRUCTURE_KINDS as readonly string[]).includes(id);
export const isControlKind = (id: KindId): id is ControlKind => (CONTROL_KINDS as readonly string[]).includes(id);

/** What a mock-up screen holds of what a hand did (taps, picks, typing, a dragged slider). Plain data; the kit's own `UiState` is assignable to it. */
export interface ScreenHeld {
  readonly tab: Readonly<Record<string, number>>;
  readonly pick: Readonly<Record<string, number>>;
  readonly toggle: Readonly<Record<string, boolean>>;
  readonly text: Readonly<Record<string, string>>;
  readonly slider: Readonly<Record<string, number>>;
  readonly device: Readonly<Record<string, 'phone' | 'tablet' | 'desktop' | 'browser'>>;
  readonly focus: string | null;
  readonly pressed: string | null;
}

/** A chart's visible window, in the units of its x axis: what a pan or a zoom leaves behind. */
export interface ChartHeld {
  readonly from: number;
  readonly to: number;
}

/** What a hand has done to a figure: the step it is at. 0 is rest (every part lit, the title in the caption band); 1..n is that step. */
export interface FigureHeld {
  readonly step: number;
}

/**
 * What a hand has done to a leaf, by kind. A kind with no entry holds nothing (`null`). Typed per kind, so a toggle cannot be filed
 * under `slider` and a slider cannot hold a string. A pick holds its 1-based option, as `ControlSpec.value` does.
 */
export interface HeldBy {
  toggle: boolean;
  slider: number;
  pick: number;
  input: string;
  screen: ScreenHeld;
  chart: ChartHeld;
  figure: FigureHeld;
  /** whatever the app saved with `save(state)`: opaque here, checked by the host */
  app: unknown;
}
export type Held<K extends KindId> = K extends keyof HeldBy ? HeldBy[K] : null;

/** One thing the brain is taught, and how it is spoken of once it is on stage. */
export interface KindWords<K extends KindId> {
  readonly id: K;
  readonly teach: {
    /** `kernel`: in the fixed prompt. `chapter`: in the brief, on its cue (as `tune`, `screen` and `app` ride today) */
    readonly where: 'kernel' | 'chapter';
    /** the line's form, as the vocabulary writes it */
    readonly form: string;
    readonly gloss: string;
    /** a chapter's cue: whether the user's words call for it. Absent on a kernel entry */
    readonly cue?: (userText: string) => boolean;
  };
  /**
   * `words`: describe() names every word the leaf shows. `summary`: it says what the leaf is and how big, by design (a mock-up, a tune,
   * an app, a chart and code are changed by writing them again, not recited), so the conformance run does not hold it to every word.
   */
  readonly describes: 'words' | 'summary';
  /** the leaf in a few words, for the brief and the transcript, with what a hand holds in it */
  readonly describe: (element: ElementSpan, parts: readonly ElementSpan[], held: Held<K>) => string;
}
export type Lexicon = { readonly [K in KindId]: KindWords<K> };

// ---------------------------------------------------------------- the entries

/** L2: the shapes the fixed prompt teaches. The rest of `SHAPE_VERBS` and the other verbs of a drawing are chapters. */
const KERNEL_SHAPES = SHAPE_VERBS.filter((name) => name === 'circle' || name === 'rect' || name === 'line' || name === 'path');
const form = (verb: keyof typeof VERB): string => VERB[verb].form;
const gist = (verb: keyof typeof VERB): string => VERB[verb].gist;

/**
 * What a structure's own figure says, then the words of its nodes in the order written, with the date or place a node sits at, and the
 * labels on its links: what a diagram says is its parts.
 */
function describeStructure(element: ElementSpan, parts: readonly ElementSpan[]): string {
  const said = element.figure === null ? element.text : describeFigure(element.figure);
  const title = element.text.trim() === '' || element.figure?.kind !== 'structure' || element.figure.rows.length > 0 ? '' : ` "${element.text.trim()}"`;
  const nodes = parts
    .filter((part) => part.figure?.kind === 'node' && part.text.trim() !== '')
    .map((part) => {
      const at = part.figure?.kind === 'node' && part.figure.values.length > 0 ? `${part.figure.values.join(',')} ` : '';
      return `${at}${part.text.trim()}`;
    });
  const labels = parts.filter((part) => part.figure?.kind === 'link' && part.text.trim() !== '').map((part) => part.text.trim());
  return `${said}${title}${nodes.length === 0 ? '' : `: ${nodes.join(' / ')}`}${labels.length === 0 ? '' : ` (links: ${labels.join(', ')})`}`;
}

/** A control as the brief tells it: its own words, then what `describeFigure` says of it, with what a hand holds in place of what the brain wrote. */
function describeControl(element: ElementSpan, held: boolean | number | string | null): string {
  const figure = element.figure;
  if (figure === null || figure.kind !== 'control') return element.text;
  const said = describeFigure(held === null ? figure : { ...figure, value: held });
  const label = element.text.trim();
  return label === '' ? said : `${said} "${label}"`;
}

const MUSIC = /\b(play(?:s|ing|ed)?|songs?|melod(?:y|ies)|tunes?|sonatas?|sonatinas?|music(?:al)?|chords?|compos(?:e|es|ing|ition)|midi|beats?|lullab(?:y|ies)|waltz(?:es)?|jingles?|riffs?|minuets?|nocturnes?|etudes?|fugues?|symphon(?:y|ies)|harmon(?:y|ies)|piano|violin)\b/i;
const INTERFACE = /\b(mock[- ]?ups?|wire[- ]?frames?|screens?|pages?|apps?|sites?|web-?sites?|figma|landing|ui|ux|user journey|journey|interfaces?|prototypes?|storyboards?|dashboards?|scorecards?|kpis?|metrics|(?:report|summary|overview|breakdown) of)\b/i;

const structure = <K extends StructureKind>(id: K, where: 'kernel' | 'chapter', describes: 'words' | 'summary', cue?: (userText: string) => boolean): KindWords<K> => ({
  id,
  teach: { where, form: form(id), gloss: gist(id), ...(cue === undefined ? {} : { cue }) },
  describes,
  describe: (element, parts) => describeStructure(element, parts),
});

const control = <K extends ControlKind>(id: K): KindWords<K> => ({
  id,
  teach: { where: 'kernel', form: form(id), gloss: gist(id) },
  describes: 'words',
  describe: (element, _parts, held) => describeControl(element, held as boolean | number | string | null),
});

export const LEXICON: Lexicon = {
  words: {
    id: 'words',
    teach: { where: 'kernel', form: form('say'), gloss: gist('say') },
    describes: 'words',
    describe: (element) => element.text,
  },
  choice: {
    id: 'choice',
    teach: { where: 'kernel', form: 'say [id] tap=yes | <text>', gloss: 'words the user can tap: a choice. What is tapped comes back as their next message.' },
    describes: 'words',
    describe: (element) => `choice "${element.text.trim()}"`,
  },
  canvas: {
    id: 'canvas',
    // L2: the kernel holds the four plain shapes; ellipse, poly, group, use, atmosphere, depth, the camera and paint ride in the brief on a drawing's cue (`drawingKit`), pixels on theirs (`pixelChapter`).
    teach: { where: 'kernel', form: KERNEL_SHAPES.map(form).join('\n'), gloss: 'free drawing by coordinates on a canvas: shapes, pictures, callouts' },
    describes: 'words',
    describe: (element) => (element.figure === null ? element.text : describeFigure(element.figure)),
  },
  figure: {
    id: 'figure',
    // FG2: taught per turn only, by its cue (anatomy, a machine, "parts of", "how … works", labelled); the worked example is the heart (`FIGURE_CHAPTER`).
    teach: { where: 'chapter', form: 'figure <id> [cutaway|exploded] | title', gloss: 'a labelled drawing: parts that label themselves, routes along them, and steps that light them in turn', cue: asksForFigure },
    describes: 'summary',
    describe: (element) => `figure "${element.text.trim()}"`,
  },
  problem: {
    id: 'problem',
    // no longer taught: a `problem` line of an old log is turned into an `ask` before the stage sees it, and the painter does not advertise the word
    teach: { where: 'chapter', form: form('problem'), gloss: gist('problem'), cue: () => false },
    describes: 'summary',
    describe: (element) => `maths question "${element.figure?.kind === 'structure' && element.figure.problem?.question ? element.figure.problem.question : element.text.trim()}"`,
  },
  flow: structure('flow', 'kernel', 'words'),
  tree: structure('tree', 'kernel', 'words'),
  cycle: structure('cycle', 'kernel', 'words'),
  timeline: structure('timeline', 'kernel', 'words'),
  map: structure('map', 'kernel', 'words'),
  table: structure('table', 'kernel', 'words'),
  chart: structure('chart', 'kernel', 'summary'),
  code: structure('code', 'kernel', 'summary'),
  tune: structure('tune', 'chapter', 'summary', (text) => MUSIC.test(text)),
  app: structure('app', 'chapter', 'summary', asksForLiveApp),
  screen: structure('screen', 'chapter', 'summary', (text) => INTERFACE.test(text)),
  button: control('button'),
  toggle: control('toggle'),
  slider: control('slider'),
  pick: control('pick'),
  input: control('input'),
};

/** Every kind, in the order the lexicon lists them. Complete by the type of `LEXICON`. */
export const KIND_IDS = Object.keys(LEXICON) as readonly KindId[];

// ---------------------------------------------------------------- teaching, derived

/** What a painter advertises, as far as teaching is concerned. `Capabilities` has it all; a registry derives these three lists. */
export type Advertised = Pick<Capabilities, 'kinds' | 'structures' | 'controls' | 'charts'>;

/**
 * The kinds a painter can be taught, from what it advertises: words when it can write, the canvas when it can draw, every structure and
 * control it lists (a chart only when its engine draws one). Choices ride with words. This is `prompt.ts`'s `draws`, `structures` and
 * `controls` as one derivation.
 */
export function advertisedKinds(capabilities: Advertised): readonly KindId[] {
  const draws = capabilities.kinds.includes('shape');
  const kinds: KindId[] = [];
  if (capabilities.kinds.includes('text')) kinds.push('words', 'choice');
  if (draws) kinds.push('canvas');
  if (draws) kinds.push(...capabilities.structures.filter((name) => name !== 'chart' || capabilities.charts.length > 0));
  kinds.push(...capabilities.controls);
  return kinds;
}

/** The lexicon walked over a painter's capabilities: `kernel` entries for the fixed prompt, `chapter` entries for the brief on their cue. */
export function teachingFor(capabilities: Advertised): { readonly kernel: readonly KindWords<KindId>[]; readonly chapter: readonly KindWords<KindId>[] } {
  const entries = advertisedKinds(capabilities).map((id) => LEXICON[id] as KindWords<KindId>);
  return { kernel: entries.filter((entry) => entry.teach.where === 'kernel'), chapter: entries.filter((entry) => entry.teach.where === 'chapter') };
}

/** The chapters whose cue the user's words trip. */
export function chaptersFor(capabilities: Advertised, userText: string): readonly KindWords<KindId>[] {
  return teachingFor(capabilities).chapter.filter((entry) => entry.teach.cue?.(userText) === true);
}

/**
 * Review I2, the run-time half: the kinds a prompt is about to teach that the painter does not advertise. Empty when taught is a subset of
 * advertised. A miss is logged by name and the word is left out of the prompt.
 */
export function taughtNotAdvertised(taught: readonly KindId[], advertised: readonly KindId[]): readonly KindId[] {
  return taught.filter((id) => !advertised.includes(id));
}
