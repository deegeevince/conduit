// `draw` on the server (PLAN-art.md, section 5): a line of intent becomes a group and its parts, or a quiet placeholder.
//
// `planDraw` is pure: it takes the line, what the stage already holds, the look and the shelf, and gives back the lines to put on stage (a `group`
// and the parts `in=` it, each `<id>-<part>`), plus what happened for the log and a note for the brain's next look. The conductor ingests the
// lines one after another, so they are scheduled, timed, logged and replayed like any lines the brain wrote itself.

import { CANVAS, serializeLine } from '@conduit/language';
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
export type ArtNote = { readonly kind: 'undrawn'; readonly subject: string } | { readonly kind: 'refused'; readonly subject: string; readonly why: string };

export interface Planned {
  readonly id: string;
  readonly lines: readonly Line[];
  readonly note: ArtNote | null;
  /** for the log: what was asked, what was chosen */
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
}

/** The conversation's casting: one character a subject, kept, and the next one when the brain says `new`. */
export class Cast {
  private readonly picked = new Map<string, number>();
  constructor(private readonly seed: string) {}

  /** The index among `count` variants: deterministic from the conversation's id, so the same conversation keeps the same fox. */
  pick(key: string, count: number, fresh: boolean): number {
    if (count <= 0) return 0;
    const held = this.picked.get(key);
    const next = held === undefined ? hash(`${this.seed}\n${key}`) % count : fresh ? (held + 1) % count : held;
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

  const placeholder = (note: ArtNote): Planned => {
    // a soft, rounded, dim shape of the drawing's own size: the place is kept and nothing is said on the stage
    const lines: Line[] = [
      { verb: 'group', id, styles: [], props: { ...passed, at } },
      {
        verb: 'rect',
        id: `${id}-soft`.slice(0, 24),
        styles: [],
        props: { in: id, fill: 'dim', stroke: 'none', opacity: 0.32, soft: Math.max(1, Math.round(size * 0.06 * 10) / 10), enter: 'fade', dur: DRAW_IN_SECONDS },
        geometry: { shape: 'rect', x: -size * 0.32, y: -size / 2, w: size * 0.64, h: size, r: size * 0.3, full: false },
        when: { kind: 'with' },
      },
    ];
    return { id, lines, note, detail: { ...detail, outcome: note.kind } };
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
  return { id, lines, note: null, detail: { ...detail, outcome: 'drawn', sheet: `${sheet.subject}/${sheet.pose}/${sheet.made.arm}`, variant: cast, of: found.sheets.length, mirrored: mirror, poseMatch: found.poseMatch, parts: sheet.parts.length } };
}

/** What a canvas of this name measures: `CANVAS[name]`. */
export const canvasOf = (name: keyof typeof CANVAS): { width: number; height: number } => CANVAS[name];

/** The lines as text, for a tool that wants to see them. */
export const textOf = (lines: readonly Line[]): string[] => lines.map((line) => serializeLine(line));
