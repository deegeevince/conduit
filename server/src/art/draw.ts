// `draw` on the server: a line of intent becomes a group and its parts, or a quiet placeholder.
//
// `planDraw` is pure: it takes the line, what the stage already holds, the look and the shelf, and gives back the lines to put on stage (a `group`
// and the parts `in=` it, each `<id>-<part>`), plus what happened for the log and a note for the brain's next look. The conductor ingests the
// lines one after another, so they are scheduled, timed, logged and replayed like any lines the brain wrote itself.

import { CANVAS, parseLine, serializeLine } from '@conduit/language';
import type { DrawLine, Line, LookId, ResolvedLook } from '@conduit/language';
import { drawIdOf } from '@conduit/language';
import { isHueName, isRole, lookClassOf } from './palette';
import { refusalOf } from './safety';
import { expandSheet } from './sheet';
import type { Dress, Sheet } from './sheet';
import { normaliseSubject, singular, wantedIn } from './shelf';
import type { Shelf } from './shelf';

/** The share of the canvas height a drawing takes when `size=` is not said: about two fifths, as a sprite does. */
export const DEFAULT_SHARE = 0.4;
/** Seconds the parts of a figure take to draw in. */
export const DRAW_IN_SECONDS = 1;

/** Why a figure was not drawn: it is not on the shelf yet, or the subject is not drawn here. */
export type ArtNote = { readonly kind: 'undrawn'; readonly subject: string } | { readonly kind: 'pending'; readonly subject: string } | { readonly kind: 'refused'; readonly subject: string; readonly why: string }
  /** a figure the shelf drew: its parts' ids, so the brain can name them on its next turn */
  | { readonly kind: 'drawn'; readonly subject: string; readonly parts: readonly string[] };

export interface Planned {
  readonly id: string;
  readonly lines: readonly Line[];
  readonly note: ArtNote | null;
  /** a placeholder for a subject the shelf does not hold: what the studio is asked for, and what the swap needs to put the drawing in place */
  readonly wanted: Wanting | null;
  /** for the log: what was asked, what was chosen */
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
}

/** What a placeholder stands for: kept until the drawing is made, so that it can be put in the placeholder's place. */
export interface Wanting {
  readonly id: string;
  /** the shelf's name for the subject, and the words the brain said */
  readonly subject: string;
  readonly words: string;
  readonly detail: string;
  readonly pose: string | null;
  readonly view: string | null;
  readonly facing: 'left' | 'right' | null;
  /** the side of the 100 box, canvas units */
  readonly size: number;
  /** the word `fill=` gave the main colour, if one */
  readonly main: string | null;
  /** the canvas the figure was drawn on, for the swap to check it has not moved on */
  readonly canvas: keyof typeof CANVAS;
}

/** The conversation's casting: one character a subject, kept, and the next one when the brain says `new`. */
export class Cast {
  private readonly picked = new Map<string, number>();
  /** `first`: a demo's casting: the first of the variants, every time, so a demo is one picture whichever conversation plays it (and a check judges that one picture) */
  constructor(
    private readonly seed: string,
    private readonly first = false,
  ) {}

  /** The index among `count` variants: deterministic from the conversation's id, so the same conversation keeps the same fox. */
  pick(key: string, count: number, fresh: boolean): number {
    if (count <= 0) return 0;
    const held = this.picked.get(key);
    const next = held === undefined ? (this.first ? 0 : hash(`${this.seed}\n${key}`) % count) : fresh ? (held + 1) % count : held;
    this.picked.set(key, next);
    return next;
  }
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export interface DrawContext {
  readonly shelf: Shelf | null;
  readonly cast: Cast;
  /** ids on stage now (an id said again is the same figure) */
  readonly live: ReadonlySet<string>;
  readonly canvas: { readonly width: number; readonly height: number };
  readonly canvasName: keyof typeof CANVAS;
  readonly look: Pick<ResolvedLook, 'preset' | 'ground' | 'ink' | 'dim' | 'accent' | 'alt'>;
}

/** The id and subject of a line, settled: the first word is an id when it ends in a digit or is already on stage. */
export function settleId(line: DrawLine, live: ReadonlySet<string>): { id: string; subject: string } {
  if (line.id !== '-') return { id: line.id, subject: line.subject };
  const first = line.words[0] ?? '';
  if (line.words.length >= 2 && live.has(first)) return { id: first, subject: line.words.slice(1).join(' ') };
  const stem = drawIdOf({ id: '-', subject: singular(line.subject.split(/\s+/).pop() ?? '') }).replace(/\d+$/, '');
  let n = 1;
  while (live.has(`${stem}${n}`)) n += 1;
  return { id: `${stem}${n}`, subject: line.subject };
}

function fillWord(line: DrawLine): string | null {
  const fill = line.props.fill;
  if (fill === undefined || fill === 'none') return null;
  const word = typeof fill === 'string' ? fill : 'named' in fill ? fill.named : null;
  if (word === null) return null;
  return isHueName(word) || isRole(word) || /^#[0-9a-f]{6}$/.test(word) ? word : null;
}

/** A rough shape for what a placeholder stands for, so that it hints at the drawing to come: tall (a giraffe, a person), wide (a car, a cow) or round (a ball, a frog). The rest are the usual upright pill. */
const ASPECT: Readonly<Record<string, readonly [number, number]>> = (() => {
  const table: Record<string, readonly [number, number]> = {};
  const set = (shape: readonly [number, number], names: string): void => {
    for (const name of names.split(' ')) table[name] = shape;
  };
  set([0.4, 1], 'giraffe ostrich flamingo heron crane lighthouse tower rocket robot child teacher baby grandparent person man woman boy girl knight wizard fairy princess prince king queen tree oak-tree palm-tree cactus penguin');
  set([1, 0.58], 'car bus train boat ship aeroplane airplane plane helicopter bicycle truck tractor snake crocodile alligator whale dolphin shark caterpillar worm horse cow pig sheep goat dog lion tiger elephant hippo camel zebra donkey dinosaur dragon');
  set([0.82, 0.82], 'ball apple cake pumpkin orange moon sun planet frog snail turtle tortoise bee butterfly ladybird ladybug owl hen duck chick bird fish cat mouse rabbit hedgehog flower balloon pie cookie');
  return table;
})();

/** The side lengths of a placeholder of this subject, in the same units as `size`. */
export function softBox(subject: string, size: number): { readonly w: number; readonly h: number } {
  const [w, h] = ASPECT[subject] ?? [0.64, 1];
  return { w: size * w, h: size * h };
}

export function planDraw(line: DrawLine, context: DrawContext): Planned {
  const { id, subject } = settleId(line, context.live);
  const want = wantedIn(line.detail);
  const canvas = context.canvas;
  const size = line.size ?? Math.round(canvas.height * DEFAULT_SHARE * 10) / 10;
  const at = line.props.at !== undefined && typeof line.props.at !== 'string' ? line.props.at : { x: canvas.width / 2, y: canvas.height / 2 };
  // what the brain set on the figure itself (a loop, an entrance, a layer, a group to sit in) goes to the group, as for any group
  const { at: _a, fill: _f, ...passed } = line.props;
  const normalised = normaliseSubject(subject);
  const detail = { id, subject: normalised, pose: want.pose, view: want.view, facing: want.facing, size, fresh: line.fresh === true };

  const box = softBox(normalised, size);
  const placeholder = (note: ArtNote): Planned => {
    // a soft, rounded, dim shape of the drawing's own size: the place is kept and nothing is said on the stage
    const lines: Line[] = [
      { verb: 'group', id, styles: [], props: { ...passed, at } },
      {
        verb: 'rect',
        id: `${id}-soft`.slice(0, 24),
        styles: [],
        props: { in: id, fill: 'dim', stroke: 'none', opacity: 0.32, soft: Math.max(1, Math.round(size * 0.06 * 10) / 10), enter: 'fade', dur: DRAW_IN_SECONDS },
        geometry: { shape: 'rect', x: -box.w / 2, y: -box.h / 2, w: box.w, h: box.h, r: Math.min(box.w, box.h) * 0.47, full: false },
        when: { kind: 'with' },
      },
    ];
    const wanting: Wanting | null = note.kind === 'undrawn' ? { id, subject: normalised, words: subject, detail: line.detail, pose: want.pose, view: want.view, facing: want.facing, size, main: fillWord(line), canvas: context.canvasName } : null;
    return { id, lines, note, wanted: wanting, detail: { ...detail, outcome: note.kind } };
  };

  const refused = refusalOf(subject, line.detail);
  if (refused !== null) return placeholder({ kind: 'refused', subject: normalised || subject, why: refused });
  const found = context.shelf?.find(subject, want) ?? null;
  if (found === null || found.sheets.length === 0) return placeholder({ kind: 'undrawn', subject: normalised || subject });

  const cast = context.cast.pick(`${found.subject}/${line.as ?? ''}`, found.sheets.length, line.fresh === true);
  const sheet: Sheet = found.sheets[cast] ?? (found.sheets[0] as Sheet);
  const mirror = want.facing !== null && sheet.facing !== 'front' && sheet.facing !== want.facing;
  const look = context.look;
  const dress: Dress = {
    look: lookClassOf(look.preset as LookId, look.ground),
    roles: { ink: look.ink, dim: look.dim, accent: look.accent, alt: look.alt, ground: look.ground },
    main: fillWord(line),
  };
  const lines = expandSheet(sheet, { id, at, size, mirror, over: DRAW_IN_SECONDS }, dress, passed);
  const drawn: ArtNote = { kind: 'drawn', subject: found.subject, parts: lines.slice(1).map((made) => (made as { id: string }).id) };
  return { id, lines, note: drawn, wanted: null, detail: { ...detail, outcome: 'drawn', sheet: `${sheet.subject}/${sheet.pose}/${sheet.made.arm}`, variant: cast, of: found.sheets.length, mirrored: mirror, poseMatch: found.poseMatch, parts: sheet.parts.length } };
}

/**
 * The lines that put a made drawing where its placeholder stands: the placeholder leaves, and the parts come `in=` the group that is already there,
 * so the group's id, its place, its size and anything the brain did to it since (a `move`, a `loop=`) are kept. Pure.
 * `first` is false for a later stage of the same drawing: the parts that are in both change into the new ones, the new ones draw in, and the ones
 * the new stage no longer has leave (`had` says what the last stage put on stage).
 */
export function planSwap(wanting: Wanting, sheet: Sheet, look: DrawContext['look'], had: readonly string[] | null): { readonly lines: readonly Line[]; readonly parts: readonly string[] } {
  const want = { facing: wanting.facing };
  const mirror = want.facing !== null && sheet.facing !== 'front' && sheet.facing !== want.facing;
  const dress: Dress = {
    look: lookClassOf(look.preset as LookId, look.ground),
    roles: { ink: look.ink, dim: look.dim, accent: look.accent, alt: look.alt, ground: look.ground },
    main: wanting.main,
  };
  const made = expandSheet(sheet, { id: wanting.id, at: { x: 0, y: 0 }, size: wanting.size, mirror, over: DRAW_IN_SECONDS }, dress).slice(1);
  const parts = made.map((line) => (line as { id: string }).id);
  const leaving = had === null ? [`${wanting.id}-soft`.slice(0, 24), captionId(wanting.id)] : had.filter((id) => !parts.includes(id));
  const lines: Line[] = [];
  if (leaving.length > 0) lines.push({ verb: 'drop', target: { kind: 'id', id: leaving[0] as string }, ...(leaving.length > 1 ? { also: leaving.slice(1) } : {}), exit: 'fade' } as Line);
  lines.push(...made);
  return { lines, parts };
}

/** What a canvas of this name measures: `CANVAS[name]`. */
export const canvasOf = (name: keyof typeof CANVAS): { width: number; height: number } => CANVAS[name];

/** The lines as text, for a tool that wants to see them. */
export const textOf = (lines: readonly Line[]): string[] => lines.map((line) => serializeLine(line));

/** The id of the small caption that stands under a placeholder while its drawing is made. */
export const captionId = (id: string): string => `cap-${id}`.slice(0, 24);

/** The caption under a pending placeholder: "Drawing a giraffe…", in the subject's own words, small and dim. Server-made, like the swap. */
export function captionLines(wanting: Wanting): Line[] {
  const words = wanting.words.replace(/[^\p{L}\p{N} '-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (words === '') return [];
  const parsed = parseLine(`say ${captionId(wanting.id)} xs opacity=0.7 near=${`${wanting.id}-soft`.slice(0, 24)}:below | Drawing ${/^[aeiou]/i.test(words) ? 'an' : 'a'} ${words}…`);
  return parsed.kind === 'line' ? [parsed.line] : [];
}

/** The line that takes the caption away when the drawing will not come. */
export const dropCaption = (id: string): Line => ({ verb: 'drop', target: { kind: 'id', id: captionId(id) }, exit: 'fade' }) as Line;
