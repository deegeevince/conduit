// What a film says about itself, beside what it draws: a caption for the turn that is on, standing at the stage's bottom left, and a tag standing at its top right in every
// frame. Both are quiet: the look's own ground and ink (the pane's palette, held to 4.5:1 whatever the look), small, and clear of the middle of the foot of the stage where the
// cut marker is. A pure function of the time, like everything else in a film: nothing here reads a clock.
//
// Sizes are given for a picture 1920 wide (the name 34 px, the words 22 px) and scale with its width; a tall picture (a phone) is scaled from 1080 wide, so that it stays readable.

import type { SurroundPen } from '../contracts/film';
import type { Box } from '../contracts/space';
import type { PanePalette } from './lang-style';

/** A caption begins to fade in `delay` seconds after its turn starts, is whole `fade` seconds later, and fades out over the `fade` seconds before the turn ends. */
export const CAPTION = { delay: 0.3, fade: 0.3, name: 34, words: 22 } as const;
/** The tag, and the room both keep from the stage's edge, at 1920 wide. */
const TAG = { size: 17, margin: 24 } as const;
const CAPTION_MARGIN = 36;
/** The face the pane's input box is set in, so the film's own words read as one voice. */
const FACE = 'system-ui, -apple-system, "Segoe UI", sans-serif';
/** A character is this wide, in ems, to the estimate that wraps the words and describes the box; the pen's own measure fits the box when it is drawn. */
const ADVANCE = 0.5;

/** The span of a turn on the film's clock: from where its lead begins (its prompt typed, its touch) to where the next turn's lead begins. */
export interface TurnSpan {
  readonly turn: string;
  readonly from: number;
  readonly to: number;
}

/** Where a caption stands on the stage: the bottom left unless the turn's picture needs that corner (the words of a page run along the foot, a list reaches down to it). */
export type CaptionSide = 'bottom-left' | 'bottom-right' | 'top-left';

export type Captions = Readonly<Record<string, { readonly name: string; readonly caption: string; readonly at?: CaptionSide }>>;

export interface Labels {
  readonly captions?: Captions;
  readonly tag?: string;
}

/** How far a caption is in at `t` for a turn that runs from `from` to `to`: 0 until `delay` after the start, up to 1 over `fade`, and down to 0 at the end. */
export function captionAlpha(from: number, to: number, t: number): number {
  const rising = (t - from - CAPTION.delay) / CAPTION.fade;
  const falling = (to - t) / CAPTION.fade;
  const p = Math.max(0, Math.min(1, Math.min(rising, falling)));
  return p * p * (3 - 2 * p);
}

/** The picture pixels one design pixel is: the width over 1920, or for a tall picture over 1080. */
export function labelScale(width: number, height: number): number {
  return height > width ? width / 1080 : width / 1920;
}

/** The words broken at spaces into rows of at most `cols` characters (a word longer than that stands alone on a row). */
export function wrapWords(text: string, cols: number): string[] {
  const rows: string[] = [];
  let row = '';
  for (const word of text.replace(/\s+/g, ' ').trim().split(' ')) {
    if (word === '') continue;
    if (row !== '' && [...row].length + 1 + [...word].length > cols) {
      rows.push(row);
      row = word;
    } else row = row === '' ? word : `${row} ${word}`;
  }
  if (row !== '') rows.push(row);
  return rows;
}

interface Rows {
  readonly name: readonly string[];
  readonly words: readonly string[];
  readonly nameSize: number;
  readonly wordsSize: number;
  readonly pad: number;
  readonly gap: number;
  /** where the words begin inside the panel: past the padding and the accent bar */
  readonly inset: number;
  readonly box: Box;
  /** the right edge a caption keeps to when it stands at the right (its width is only known when it is drawn in the face the pen has); null at the left */
  readonly right: number | null;
  readonly radius: number;
}

/** The caption's rows and where its panel stands, at the stage's bottom left. */
function setCaption(stage: Box, scale: number, vertical: boolean, name: string, caption: string, at: CaptionSide): Rows {
  const nameSize = Math.max(CAPTION.name * scale, 13);
  const wordsSize = Math.max(CAPTION.words * scale, 10);
  const pad = Math.max(20 * scale, 8);
  const gap = Math.max(7 * scale, 3);
  const margin = Math.max(CAPTION_MARGIN * scale, 10);
  // wide enough to read on one row, never into the middle of the foot of the stage where the cut marker stands
  const room = Math.max(wordsSize * 8, stage.width * (vertical ? 0.9 : 0.36) - pad * 2 - margin);
  const nameRows = wrapWords(name, Math.max(6, Math.floor(room / (nameSize * ADVANCE))));
  const wordsRows = wrapWords(caption, Math.max(8, Math.floor(room / (wordsSize * ADVANCE))));
  const wide = Math.max(...nameRows.map((row) => [...row].length * nameSize * ADVANCE), ...wordsRows.map((row) => [...row].length * wordsSize * ADVANCE), 0);
  const height = pad * 2 + nameRows.length * nameSize * 1.2 + (wordsRows.length > 0 ? gap + wordsRows.length * wordsSize * 1.35 : 0);
  const inset = pad * 1.34;
  const width = Math.min(stage.width - margin * 2, wide + inset + pad);
  const x = at === 'bottom-right' ? stage.x + stage.width - margin - width : stage.x + margin;
  const y = at === 'top-left' ? stage.y + margin : stage.y + stage.height - margin - height;
  return { name: nameRows, words: wordsRows, nameSize, wordsSize, pad, gap, inset, box: { x, y, width, height }, right: at === 'bottom-right' ? stage.x + stage.width - margin : null, radius: Math.max(10 * scale, 4) };
}

/** The tag's pill, at the stage's top right. */
function setTag(stage: Box, scale: number, text: string): { readonly box: Box; readonly size: number; readonly padX: number } {
  const size = Math.max(TAG.size * scale, 11);
  const padX = size * 0.8;
  const padY = size * 0.5;
  const margin = Math.max(TAG.margin * scale, 8);
  const width = [...text].length * size * 0.56 + padX * 2;
  const height = size * 1.25 + padY * 2;
  return { box: { x: stage.x + stage.width - margin - width, y: stage.y + margin, width, height }, size, padX };
}

/** What the labels are at one moment: as data (for a check) and as ink (for the film). */
export interface LabelsAt {
  readonly caption: { readonly name: string; readonly caption: string; readonly alpha: number; readonly box: Box; readonly sizes: { readonly name: number; readonly words: number }; readonly ink: string; readonly quiet: string; readonly ground: string } | null;
  readonly tag: { readonly text: string; readonly box: Box; readonly size: number; readonly ink: string; readonly ground: string } | null;
  paint(context: SurroundPen): void;
}

/**
 * The labels of a film: `spans` say where each turn is, `stage` where it is drawn in a picture `width` x `height`, and `palette` is the look's at the moment. A tag stands in every
 * frame; a caption stands while its turn is on, and only if `captions` has an entry for the turn.
 */
export function labelsOf(labels: Labels, spans: readonly TurnSpan[], stage: Box, picture: { readonly width: number; readonly height: number }): (t: number, palette: PanePalette) => LabelsAt {
  const scale = labelScale(picture.width, picture.height);
  const vertical = picture.height > picture.width;
  const tag = labels.tag === undefined || labels.tag === '' ? null : labels.tag;
  const tagSet = tag === null ? null : setTag(stage, scale, tag);
  const captions = labels.captions ?? {};
  // turns that run on with one caption (a page that takes a tap or two) keep it standing: it fades in at the first and out at the last, not between them
  const held: TurnSpan[] = [];
  for (const span of spans) {
    const before = held[held.length - 1];
    const a = before === undefined ? undefined : captions[before.turn];
    const b = captions[span.turn];
    if (before !== undefined && a !== undefined && b !== undefined && a.name === b.name && a.caption === b.caption && a.at === b.at && before.to === span.from) held[held.length - 1] = { turn: before.turn, from: before.from, to: span.to };
    else held.push(span);
  }
  // a caption's rows are set once
  const sets = new Map<string, Rows>();
  for (const span of held) {
    const entry = captions[span.turn];
    if (entry !== undefined && !sets.has(span.turn)) sets.set(span.turn, setCaption(stage, scale, vertical, entry.name, entry.caption, entry.at ?? 'bottom-left'));
  }
  return (t, palette) => {
    // the caption of the latest turn that has begun and is not over
    let on: { readonly span: TurnSpan; readonly alpha: number } | null = null;
    for (const span of held) {
      if (!sets.has(span.turn) || t < span.from || t >= span.to) continue;
      const alpha = captionAlpha(span.from, span.to, t);
      if (alpha > 0 && (on === null || span.from >= on.span.from)) on = { span, alpha };
    }
    const entry = on === null ? undefined : captions[on.span.turn];
    const set = on === null ? undefined : sets.get(on.span.turn);
    const caption = on === null || entry === undefined || set === undefined ? null : { name: entry.name, caption: entry.caption, alpha: on.alpha, box: set.box, sizes: { name: set.nameSize, words: set.wordsSize }, ink: palette.text.id, quiet: palette.text.key, ground: palette.ground };
    const tagged = tag === null || tagSet === null ? null : { text: tag, box: tagSet.box, size: tagSet.size, ink: palette.text.key, ground: palette.ground };
    const paint = (context: SurroundPen): void => {
      if (caption !== null && set !== undefined) paintCaption(context, set, caption, palette);
      if (tagged !== null && tagSet !== null) paintTag(context, tagSet, tagged, palette);
    };
    return { caption, tag: tagged, paint };
  };
}

function paintCaption(context: SurroundPen, set: Rows, caption: { readonly alpha: number }, palette: PanePalette): void {
  context.save();
  context.textAlign = 'left';
  context.textBaseline = 'alphabetic';
  // the panel is as wide as the widest row really is in the face the pen has
  context.font = `600 ${set.nameSize}px ${FACE}`;
  let wide = Math.max(0, ...set.name.map((row) => context.measureText(row).width));
  context.font = `400 ${set.wordsSize}px ${FACE}`;
  wide = Math.max(wide, ...set.words.map((row) => context.measureText(row).width));
  const width = wide + set.inset + set.pad;
  const box = { ...set.box, width, x: set.right === null ? set.box.x : set.right - width };
  context.globalAlpha = 0.88 * caption.alpha;
  context.fillStyle = palette.ground;
  context.beginPath();
  context.roundRect(box.x, box.y, box.width, box.height, set.radius);
  context.fill();
  context.globalAlpha = caption.alpha;
  context.strokeStyle = palette.edge;
  context.lineWidth = Math.max(1, set.pad * 0.05);
  context.beginPath();
  context.roundRect(box.x + 0.5, box.y + 0.5, box.width - 1, box.height - 1, set.radius);
  context.stroke();
  // a short bar of the look's accent, down the panel's left edge
  context.fillStyle = palette.text.verb;
  context.beginPath();
  context.roundRect(box.x + set.pad * 0.45, box.y + set.pad * 0.7, Math.max(2, set.pad * 0.14), box.height - set.pad * 1.4, 2);
  context.fill();
  let y = box.y + set.pad;
  const x = box.x + set.inset;
  context.font = `600 ${set.nameSize}px ${FACE}`;
  context.fillStyle = palette.text.id;
  for (const row of set.name) {
    context.fillText(row, x, y + set.nameSize * 0.96);
    y += set.nameSize * 1.2;
  }
  if (set.words.length > 0) {
    y += set.gap;
    context.font = `400 ${set.wordsSize}px ${FACE}`;
    context.fillStyle = palette.text.key;
    for (const row of set.words) {
      context.fillText(row, x, y + set.wordsSize * 1.02);
      y += set.wordsSize * 1.35;
    }
  }
  context.restore();
}

function paintTag(context: SurroundPen, set: { readonly box: Box; readonly size: number; readonly padX: number }, tag: { readonly text: string }, palette: PanePalette): void {
  context.save();
  context.textAlign = 'left';
  context.textBaseline = 'alphabetic';
  context.font = `500 ${set.size}px ${FACE}`;
  const width = context.measureText(tag.text).width + set.padX * 2;
  // it keeps to the stage's right edge whatever the face's width is
  const x = set.box.x + set.box.width - width;
  context.globalAlpha = 0.8;
  context.fillStyle = palette.ground;
  context.beginPath();
  context.roundRect(x, set.box.y, width, set.box.height, set.box.height / 2);
  context.fill();
  context.globalAlpha = 1;
  context.strokeStyle = palette.edge;
  context.lineWidth = 1;
  context.beginPath();
  context.roundRect(x + 0.5, set.box.y + 0.5, width - 1, set.box.height - 1, set.box.height / 2);
  context.stroke();
  context.fillStyle = palette.text.key;
  context.fillText(tag.text, x + set.padX, set.box.y + set.box.height / 2 + set.size * 0.36);
  context.restore();
}
