// The language pane in a film. The pane is drawn into the same frames as the stage (the exporter lays the stage over the rest of the picture,
// `Film.surround`), set in the same fixed-pitch face and coloured by the same palette as the pane on the page, so a film is the live view
// as it ran: each line appears at the playhead it arrived at, the line being drawn is lit by the schedule's own times, and nothing here reads
// a clock. It is a pure function of the recording, the log and the time.

import { TurnScore } from '@conduit/language';
import type { Film, Recording, Surround, SurroundPen } from '../contracts/film';
import type { Reel } from '../painter/reel';
import type { Box } from '../contracts/space';
import { entryNote } from './lang-log';
import type { LangEntry, LangLog } from './lang-log';
import { MONO, paletteOf, tokenize } from './lang-style';
import type { PanePalette, Token, TokenRole } from './lang-style';

export interface LangLayout {
  readonly width: number;
  readonly height: number;
  readonly vertical: boolean;
  readonly pane: Box;
  readonly stage: Box;
}

/** How a picture is divided: a wide one has the pane at its left, a tall one has it on top. The stage keeps the rest. */
export function langLayout(width: number, height: number): LangLayout {
  const vertical = height > width * 0.9;
  if (vertical) {
    const pane = Math.round(height * 0.34);
    return { width, height, vertical, pane: { x: 0, y: 0, width, height: pane }, stage: { x: 0, y: pane, width, height: height - pane } };
  }
  const pane = Math.round(Math.max(Math.min(width * 0.33, 720), Math.min(width * 0.5, 360)));
  return { width, height, vertical, pane: { x: 0, y: 0, width: pane, height }, stage: { x: pane, y: 0, width: width - pane, height } };
}

interface Piece {
  readonly role: TokenRole;
  readonly text: string;
  readonly face: 'regular' | 'bold';
}
type Row = readonly Piece[];

interface Item {
  readonly at: number;
  readonly entry: LangEntry;
  readonly rows: readonly Row[];
  readonly note: readonly Row[];
  readonly dim: boolean;
  /** where the line is being drawn, on the film's clock; null for a line that is not (a dropped one) */
  readonly span: { readonly start: number; readonly end: number } | null;
  top: number;
  height: number;
}

/** A line's characters set in rows `cols` wide, broken at spaces, the continuation rows indented. */
function wrap(tokens: readonly Token[], cols: number, indent: number): Row[] {
  const chars: { readonly role: TokenRole; readonly ch: string }[] = [];
  for (const token of tokens) for (const ch of token.text) chars.push({ role: token.role, ch });
  const rows: Row[] = [];
  let start = 0;
  let first = true;
  while (start < chars.length || first) {
    const room = Math.max(8, cols - (first ? 0 : indent));
    let end = Math.min(chars.length, start + room);
    if (end < chars.length) {
      let cut = end;
      while (cut > start + 1 && chars[cut - 1]?.ch !== ' ') cut -= 1;
      if (cut > start + 1) end = cut;
    }
    const pieces: { role: TokenRole; text: string; face: 'regular' | 'bold' }[] = [];
    for (const { role, ch } of chars.slice(start, end)) {
      const last = pieces[pieces.length - 1];
      if (last !== undefined && last.role === role) last.text += ch;
      else pieces.push({ role, text: ch, face: role === 'id' || role === 'verb' ? 'bold' : 'regular' });
    }
    const trimmed = first ? pieces : [{ role: 'plain' as TokenRole, text: ' '.repeat(indent), face: 'regular' as const }, ...pieces];
    rows.push(trimmed);
    start = end;
    first = false;
    if (end >= chars.length) break;
  }
  return rows;
}

const plainTokens = (text: string, role: TokenRole): Token[] => [{ role, text }];

export interface PaneSource {
  readonly recording: Recording;
  /** seconds into the film at which this recording's own clock begins */
  readonly from: number;
}

/** What each line of a turn took on the turn's clock, as the painter's own score gives it. */
function spansOf(recording: Recording): Map<number, { start: number; end: number }> {
  const score = new TurnScore(recording.base, recording.opened ?? 'none');
  for (const { seq, line, floor } of recording.lines) score.push(line, seq, floor ?? 0);
  const spans = new Map<number, { start: number; end: number }>();
  for (const time of score.schedule.lines) spans.set(time.seq, { start: time.start, end: time.end });
  return spans;
}

/** The lit line stays lit this long past the end of what it drew, and a line that takes no time is lit this long: enough to be seen. */
const HOLD = 0.4;
/** A new line takes this long to settle into the pane. */
const SETTLE = 0.22;

/** A pane in film: the lines of the turns in `sources`, laid out once for `layout`, drawn at any moment. */
export function paneSurround(sources: readonly PaneSource[], log: LangLog, layout: LangLayout, lookAt: (seconds: number) => PanePalette): Surround {
  const size = Math.round(Math.min(layout.width, layout.height) / 44);
  const lineHeight = Math.round(size * 1.5);
  const pad = Math.round(size * 1.1);
  const advance = size * 0.6;
  const cols = Math.max(12, Math.floor((layout.pane.width - pad * 2 - size * 0.4) / advance));
  const headerHeight = Math.round(lineHeight * 1.9);
  const items: Item[] = [];
  for (const source of sources) {
    const spans = spansOf(source.recording);
    for (const entry of log.entriesOf(source.recording.turn)) {
      const dropped = entry.kind === 'dropped';
      const span = dropped ? undefined : spans.get(entry.seq);
      const noteText = entryNote(entry);
      items.push({
        at: source.from + entry.playhead,
        entry,
        rows: wrap(dropped ? plainTokens(entry.text, 'plain') : tokenize(entry.text), cols, 2),
        note: noteText === null ? [] : wrap(plainTokens(noteText, 'plain'), cols, 2),
        dim: dropped,
        span: span === undefined ? null : { start: source.from + span.start, end: source.from + span.end },
        top: 0,
        height: 0,
      });
    }
  }
  items.sort((a, b) => a.at - b.at);
  let cursor = 0;
  const gap = Math.round(lineHeight * 0.18);
  for (const item of items) {
    item.top = cursor;
    item.height = (item.rows.length + item.note.length) * lineHeight + gap;
    cursor += item.height;
  }
  const innerHeight = layout.pane.height - headerHeight - pad;

  /** how far each line has come in at `t`: 0 not yet, 1 settled */
  const came = (item: Item, t: number): number => {
    const p = Math.max(0, Math.min(1, (t - item.at) / SETTLE));
    return 1 - (1 - p) * (1 - p);
  };

  const lit = (t: number): Item | null => {
    let best: Item | null = null;
    for (const item of items) {
      if (item.span === null || item.at > t) continue;
      if (t >= item.span.start && t <= Math.max(item.span.end, item.span.start + HOLD) + (item.span.end > item.span.start ? HOLD : 0)) {
        if (best === null || (best.span?.start ?? 0) <= item.span.start) best = item;
      }
    }
    return best;
  };

  const draw = (context: SurroundPen, t: number): void => {
    const palette = lookAt(t);
    const { pane } = layout;
    context.save();
    context.fillStyle = palette.ground;
    context.fillRect(pane.x, pane.y, pane.width, pane.height);
    context.fillStyle = palette.edge;
    if (layout.vertical) context.fillRect(pane.x, pane.y + pane.height - 2, pane.width, 2);
    else context.fillRect(pane.x + pane.width - 2, pane.y, 2, pane.height);
    context.textBaseline = 'alphabetic';
    context.font = `400 ${Math.round(size * 0.78)}px "${MONO.regular}"`;
    context.fillStyle = palette.text.key;
    context.fillText('SERIES  as it arrives', pane.x + pad, pane.y + pad + size * 0.5);

    // what has come, and how far down it reaches: the pane follows the newest line the way the page does
    let bottom = 0;
    for (const item of items) {
      if (item.at > t) break;
      bottom = item.top + item.height * came(item, t);
    }
    const scroll = Math.max(0, bottom - innerHeight);
    context.beginPath();
    context.rect(pane.x, pane.y + headerHeight, pane.width, layout.pane.height - headerHeight);
    context.clip();
    const now = lit(t);
    const originY = pane.y + headerHeight - scroll;
    for (const item of items) {
      if (item.at > t) break;
      const y = originY + item.top;
      if (y + item.height < pane.y + headerHeight - lineHeight || y > pane.y + pane.height) continue;
      const alpha = came(item, t);
      const rise = (1 - alpha) * lineHeight * 0.35;
      context.globalAlpha = alpha;
      if (item === now) {
        context.fillStyle = palette.now;
        context.fillRect(pane.x, y - 2 + rise, pane.width - 2, item.height - gap + 4);
        context.fillStyle = palette.text.verb;
        context.fillRect(pane.x, y - 2 + rise, Math.max(3, Math.round(size * 0.18)), item.height - gap + 4);
      }
      let rowY = y + rise + lineHeight * 0.76;
      const setRow = (row: Row, quiet: boolean): void => {
        let x = pane.x + pad;
        for (const piece of row) {
          context.font = `${piece.face === 'bold' ? 700 : 400} ${size}px "${piece.face === 'bold' ? MONO.bold : MONO.regular}"`;
          context.fillStyle = quiet ? palette.note : palette.text[piece.role];
          context.fillText(piece.text, x, rowY);
          x += piece.text.length * advance;
        }
        rowY += lineHeight;
      };
      for (const row of item.rows) setRow(row, item.dim);
      for (const row of item.note) setRow(row, true);
    }
    context.restore();
  };

  return { width: layout.width, height: layout.height, stage: layout.stage, draw };
}

/** The palette a film's pane wears at `t`: the look the stage is wearing then, as the frame says it. */
function paletteAt(film: Film, t: number): PanePalette {
  const roles = film.frameAt(t).spec.roles;
  return paletteOf({ ground: roles.ground, ink: roles.ink, dim: roles.dim, accent: roles.accent });
}

/** `film` (made for `layout.stage`'s size) with the pane laid beside or above it. `parts` are the turns the film holds, in order and where each begins; a film of one turn is `[{ turn, from: 0 }]`. */
export function withPane(film: Film | Reel, recordings: readonly Recording[], log: LangLog, layout: LangLayout): Film {
  const parts = 'parts' in film ? film.parts.filter((part) => !part.card) : null;
  const sources: PaneSource[] = [];
  if (parts === null) {
    const only = recordings[recordings.length - 1];
    if (only !== undefined) sources.push({ recording: only, from: 0 });
  } else {
    for (const part of parts) {
      const recording = recordings.find((candidate) => candidate.turn === part.turn);
      if (recording !== undefined) sources.push({ recording, from: part.from });
    }
  }
  // The pane's colours are the look's, sampled a few times a second: cheap, and the same for every run of the film.
  const cache = new Map<number, PanePalette>();
  const lookAt = (seconds: number): PanePalette => {
    const key = Math.round(seconds * 4);
    let palette = cache.get(key);
    if (palette === undefined) {
      palette = paletteAt(film, key / 4);
      cache.set(key, palette);
      if (cache.size > 400) cache.delete(cache.keys().next().value ?? 0);
    }
    return palette;
  };
  return { ...film, surround: paneSurround(sources, log, layout, lookAt) };
}
