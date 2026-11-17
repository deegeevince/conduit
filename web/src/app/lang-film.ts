// The language pane in a film. The pane is drawn into the same frames as the stage (the exporter lays the stage over the rest of the picture,
// `Film.surround`), set in the same fixed-pitch face and coloured by the same palette as the pane on the page, so a film is the live view
// as it ran: each line appears at the playhead it arrived at, the line being drawn is lit by the schedule's own times, and nothing here reads
// a clock. It is a pure function of the recording, the log and the time.
//
// Along the bottom is the input box as the page shows it: before each turn the prompt is typed into it a letter at a time and sent (or, for a
// turn a tap began, a soft ripple shows where). The pane keeps the line being drawn in view, scrolling smoothly to it and back up to it.

import { lineSpans } from '../painter/film';
import { TYPING } from '../painter/reel';
import type { Film, Recording, Surround, SurroundPen, SurroundScene } from '../contracts/film';
import type { Reel, ReelPart } from '../painter/reel';
import type { Box } from '../contracts/space';
import { planeQuad } from '../render/place';
import { shownNote } from './lang-log';
import type { LangEntry, LangLog } from './lang-log';
import { MONO, paletteOf, tokenize } from './lang-style';
import type { PanePalette, Token, TokenRole } from './lang-style';

export interface LangLayout {
  readonly width: number;
  readonly height: number;
  readonly vertical: boolean;
  readonly pane: Box;
  readonly stage: Box;
  /** the input box's strip along the bottom, under both */
  readonly bar: Box;
}

/** How a picture is divided: a wide one has the pane at its left, a tall one has it on top, and the input box lies along the bottom of both. The stage keeps the rest. */
export function langLayout(width: number, height: number): LangLayout {
  const bar = Math.round((Math.min(width, height) / 44) * 4.2);
  const rest = height - bar;
  const barBox = { x: 0, y: rest, width, height: bar };
  const vertical = height > width * 0.9;
  if (vertical) {
    const pane = Math.round(rest * 0.34);
    return { width, height, vertical, pane: { x: 0, y: 0, width, height: pane }, stage: { x: 0, y: pane, width, height: rest - pane }, bar: barBox };
  }
  const pane = Math.round(Math.max(Math.min(width * 0.33, 720), Math.min(width * 0.5, 360)));
  return { width, height, vertical, pane: { x: 0, y: 0, width: pane, height: rest }, stage: { x: pane, y: 0, width: width - pane, height: rest }, bar: barBox };
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

/** The lit line stays lit this long past the end of what it drew, and a line that takes no time is lit this long: enough to be seen. */
const HOLD = 0.4;
/** A new line takes this long to settle into the pane. */
const SETTLE = 0.22;
/** The pane follows the lit line with this time constant (seconds): quick enough to be there, slow enough to be seen moving. */
const FOLLOW = 0.16;
/** The follow is worked out this many times a second and drawn between. */
const FOLLOW_RATE = 30;
/** A tap's ripple spreads for this long. */
const RIPPLE = 0.7;

/** A lead as the surround reads it: the box typed into, and what was typed. */
export interface PaneLead {
  readonly from: number;
  readonly acting: number;
  readonly waiting: number;
  readonly typed: string | null;
  /** where a tap began the turn, as a fraction of the stage (0..1), or null when the film does not know */
  readonly touched: { readonly x: number; readonly y: number } | null;
}

interface Drawn {
  readonly scene: SurroundScene;
  readonly paint: (context: SurroundPen) => void;
}

/** A pane in film: the lines of the turns in `sources`, laid out once for `layout`, drawn at any moment, with the input box and the typing along the bottom. */
export function paneSurround(sources: readonly PaneSource[], leads: readonly PaneLead[], log: LangLog, layout: LangLayout, lookAt: (seconds: number) => PanePalette): Surround {
  const size = Math.round(Math.min(layout.width, layout.height) / 44);
  const lineHeight = Math.round(size * 1.5);
  const pad = Math.round(size * 1.1);
  const advance = size * 0.6;
  const cols = Math.max(12, Math.floor((layout.pane.width - pad * 2 - size * 0.4) / advance));
  const headerHeight = Math.round(lineHeight * 1.9);
  const items: Item[] = [];
  for (const source of sources) {
    const spans = lineSpans(source.recording);
    const floors = new Map(source.recording.lines.map((line) => [line.seq, line.floor ?? 0]));
    let latest = 0;
    for (const entry of log.entriesOf(source.recording.turn)) {
      // a line arrived at the playhead the recording kept for it; a dropped one came between the lines before and after it
      const arrived = entry.kind === 'line' ? (floors.get(entry.seq) ?? latest) : latest;
      latest = Math.max(latest, arrived);
      const dropped = entry.kind === 'dropped';
      const span = dropped ? undefined : spans.get(entry.seq);
      const noteText = shownNote(entry);
      items.push({
        at: source.from + arrived,
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
  /** the lit bar reaches this far past a line, so the first line sits this far down and the last this far up */
  const inset = 3;
  let cursor = inset;
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

  /** how far down the arrived lines reach at `t`: a line that has come is counted whole, so the pane can scroll to it as it settles */
  const reach = (t: number): number => {
    let bottom = 0;
    for (const item of items) {
      if (item.at > t) break;
      bottom = item.top + item.height;
    }
    return bottom;
  };

  // The follow: where the pane is scrolled to at each moment, worked out once from the start and drawn between the samples. The line being drawn
  // is kept comfortably in view (between a tenth and seven tenths of the way down, else brought to a third), by easing toward it, up as well as
  // down; and it is never allowed out of the window while it is lit, however far it has to go.
  const lastAt = Math.max(0, ...items.map((item) => Math.max(item.at, item.span?.end ?? 0))) + 2 * HOLD;
  const follow: number[] = [];
  {
    let scroll = 0;
    let target = 0;
    const ease = 1 - Math.exp(-1 / (FOLLOW_RATE * FOLLOW));
    for (let step = 0; step <= Math.ceil(lastAt * FOLLOW_RATE); step += 1) {
      const t = step / FOLLOW_RATE;
      const most = Math.max(0, reach(t) + inset - innerHeight);
      const now = lit(t);
      if (now !== null) {
        const top = now.top - scroll;
        const bottom = top + now.height - gap;
        if (top < innerHeight * 0.1 || bottom > innerHeight * 0.7) target = now.top - innerHeight / 3;
        else target = scroll;
      }
      target = Math.max(0, Math.min(most, target));
      scroll += (target - scroll) * ease;
      if (now !== null && now.height - gap + 4 <= innerHeight) {
        // inside the window while it is lit (its lit bar reaches two pixels past the line), with a little air around it
        const air = Math.min(lineHeight * 0.5, (innerHeight - (now.height - gap + 4)) / 2) + 2;
        scroll = Math.max(now.top + now.height - gap + air - innerHeight, Math.min(now.top - air, scroll));
      }
      scroll = Math.max(0, Math.min(most, scroll));
      follow.push(scroll);
    }
  }
  const scrollAt = (t: number): number => {
    const at = Math.max(0, t) * FOLLOW_RATE;
    const low = Math.min(follow.length - 1, Math.floor(at));
    const high = Math.min(follow.length - 1, low + 1);
    const mix = at - Math.floor(at);
    return (follow[low] ?? 0) * (1 - mix) + (follow[high] ?? 0) * mix;
  };

  // ---- the input box
  const bar = layout.bar;
  const pillHeight = Math.round(size * 3);
  const pill: Box = (() => {
    const width = Math.min(layout.width - size * 2, size * 48);
    return { x: Math.round((layout.width - width) / 2), y: Math.round(bar.y + (bar.height - pillHeight) / 2), width: Math.round(width), height: pillHeight };
  })();
  /** what is in the input box at `t`: the words typed so far, and whether they are being sent */
  const typing = (t: number): { readonly text: string; readonly sending: boolean; readonly caret: boolean } => {
    for (const lead of leads) {
      if (t < lead.from || t >= lead.from + lead.acting) continue;
      if (lead.typed === null) return { text: '', sending: false, caret: false };
      const letters = [...lead.typed];
      const into = t - lead.from - TYPING.before;
      const typedFor = letters.length / TYPING.cps;
      if (into < 0) return { text: '', sending: false, caret: true };
      if (into < typedFor) return { text: letters.slice(0, Math.floor(into * TYPING.cps) + 1).join(''), sending: false, caret: true };
      return { text: lead.typed, sending: true, caret: false };
    }
    return { text: '', sending: false, caret: false };
  };
  const rippleAt = (t: number): { readonly x: number; readonly y: number; readonly spread: number } | null => {
    for (const lead of leads) {
      if (lead.touched === null || lead.typed !== null) continue;
      const into = t - lead.from - 0.1;
      if (into >= 0 && into < RIPPLE) return { x: lead.touched.x, y: lead.touched.y, spread: into / RIPPLE };
    }
    return null;
  };

  const sceneAt = (t: number): Drawn => {
    const palette = lookAt(t);
    const { pane } = layout;
    const scroll = scrollAt(t);
    const now = lit(t);
    const originY = pane.y + headerHeight - scroll;
    const window: Box = { x: pane.x, y: pane.y + headerHeight, width: pane.width, height: pane.height - headerHeight };
    const rows: { text: string; top: number; bottom: number; lit: boolean }[] = [];
    const placed: { item: Item; y: number; rise: number; alpha: number }[] = [];
    for (const item of items) {
      if (item.at > t) break;
      const y = originY + item.top;
      if (y + item.height < window.y - lineHeight || y > pane.y + pane.height) continue;
      const alpha = came(item, t);
      // a line comes up into its place; the one being drawn is already in it, so the lit bar is never out of the window
      const rise = item === now ? 0 : (1 - alpha) * lineHeight * 0.35;
      placed.push({ item, y, rise, alpha });
      rows.push({ text: item.entry.text, top: y + rise - 2, bottom: y + rise + item.height - gap + 2, lit: item === now });
    }
    const litRow = rows.find((row) => row.lit) ?? null;
    const typed = typing(t);
    const scene: SurroundScene = {
      panel: window,
      rows,
      lit: litRow === null ? null : { top: litRow.top, bottom: litRow.bottom },
      input: { box: pill, text: typed.text, sending: typed.sending },
      ripple: rippleAt(t),
      marker: null,
    };
    const paint = (context: SurroundPen): void => {
      context.save();
      context.fillStyle = palette.ground;
      context.fillRect(pane.x, pane.y, pane.width, pane.height);
      context.fillStyle = palette.edge;
      if (layout.vertical) context.fillRect(pane.x, pane.y + pane.height - 2, pane.width, 2);
      else context.fillRect(pane.x + pane.width - 2, pane.y, 2, pane.height);
      context.textBaseline = 'alphabetic';
      context.textAlign = 'left';
      context.font = `400 ${Math.round(size * 0.78)}px "${MONO.regular}"`;
      context.fillStyle = palette.text.key;
      context.fillText('SERIES  as it arrives', pane.x + pad, pane.y + pad + size * 0.5);
      context.save();
      context.beginPath();
      context.rect(window.x, window.y, window.width, window.height);
      context.clip();
      for (const { item, y, rise, alpha } of placed) {
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

      // the input box, as the page has it: a pill with the plus at its left and the send button at its right, on the page's own ground
      context.globalAlpha = 1;
      context.fillStyle = palette.ground;
      context.fillRect(bar.x, bar.y, bar.width, bar.height);
      context.fillStyle = palette.edge;
      context.fillRect(bar.x, bar.y, bar.width, 1);
      const round = pill.height / 2;
      const button = pill.height - 6;
      context.beginPath();
      context.roundRect(pill.x + 0.5, pill.y + 0.5, pill.width - 1, pill.height - 1, round);
      context.strokeStyle = typed.caret || typed.sending ? palette.text.id : palette.edge;
      context.lineWidth = 1;
      context.stroke();
      // the plus
      const plusX = pill.x + 3 + button / 2;
      const plusY = pill.y + pill.height / 2;
      context.strokeStyle = palette.text.id;
      context.lineWidth = Math.max(1.5, size * 0.12);
      context.beginPath();
      context.moveTo(plusX - size * 0.5, plusY);
      context.lineTo(plusX + size * 0.5, plusY);
      context.moveTo(plusX, plusY - size * 0.5);
      context.lineTo(plusX, plusY + size * 0.5);
      context.stroke();
      // the words, or "Ask anything"
      const face = `${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      context.font = face;
      context.textAlign = 'left';
      const left = pill.x + 3 + button + size * 0.4;
      const room = pill.x + pill.width - 3 - button - size * 0.4 - left;
      const baseline = pill.y + pill.height / 2 + size * 0.36;
      if (typed.text === '') {
        context.fillStyle = palette.text.key;
        context.fillText('Ask anything', left, baseline);
        if (typed.caret && Math.floor(t * 2) % 2 === 0) {
          context.fillStyle = palette.text.id;
          context.fillRect(left, pill.y + pill.height / 2 - size * 0.6, 2, size * 1.2);
        }
      } else {
        // a line longer than the box shows its end, as a field does
        let shown = typed.text;
        while (shown.length > 1 && context.measureText(shown).width > room) shown = shown.slice(1);
        context.fillStyle = palette.text.id;
        context.fillText(shown, left, baseline);
        if (typed.caret) {
          context.fillRect(left + context.measureText(shown).width + 1, pill.y + pill.height / 2 - size * 0.6, 2, size * 1.2);
        }
      }
      // send: a filled circle with an arrow, pressed for a moment when the words go
      const sendX = pill.x + pill.width - 3 - button / 2;
      const swell = typed.sending ? 0.88 : 1;
      context.fillStyle = palette.text.id;
      context.beginPath();
      context.arc(sendX, plusY, (button / 2) * swell, 0, Math.PI * 2);
      context.fill();
      context.strokeStyle = palette.ground;
      context.lineWidth = Math.max(1.5, size * 0.14);
      context.beginPath();
      context.moveTo(sendX, plusY + size * 0.45);
      context.lineTo(sendX, plusY - size * 0.45);
      context.moveTo(sendX - size * 0.4, plusY - size * 0.05);
      context.lineTo(sendX, plusY - size * 0.45);
      context.lineTo(sendX + size * 0.4, plusY - size * 0.05);
      context.stroke();
      context.restore();
    };
    return { scene, paint };
  };

  const overlay = (context: SurroundPen, t: number): void => {
    const ripple = rippleAt(t);
    if (ripple === null) return;
    const palette = lookAt(t);
    const x = layout.stage.x + ripple.x * layout.stage.width;
    const y = layout.stage.y + ripple.y * layout.stage.height;
    context.save();
    context.strokeStyle = palette.text.verb;
    context.fillStyle = palette.text.verb;
    context.lineWidth = Math.max(2, size * 0.18);
    context.globalAlpha = 0.28 * (1 - ripple.spread);
    context.beginPath();
    context.arc(x, y, size * (0.8 + 3.2 * ripple.spread), 0, Math.PI * 2);
    context.fill();
    context.globalAlpha = 0.6 * (1 - ripple.spread);
    context.beginPath();
    context.arc(x, y, size * (0.8 + 3.2 * ripple.spread), 0, Math.PI * 2);
    context.stroke();
    context.restore();
  };

  return { width: layout.width, height: layout.height, stage: layout.stage, draw: (context, t) => sceneAt(t).paint(context), overlay, describe: (t) => sceneAt(t).scene };
}

/** The palette a film's pane wears at `t`: the look the stage is wearing then, as the frame says it. */
function paletteAt(film: Film, t: number): PanePalette {
  const roles = film.frameAt(t).spec.roles;
  return paletteOf({ ground: roles.ground, ink: roles.ink, dim: roles.dim, accent: roles.accent });
}

/** Where a touch that began a turn was on the stage, as a fraction of it: the element it names in the stage as the turn found it; null when it is not there to be found. */
function touchOf(film: Film, part: ReelPart): PaneLead['touched'] {
  const touched = part.lead?.touched;
  if (touched === undefined || touched === null) return null;
  const frame = film.frameAt(Math.max(0, part.lead?.from ?? part.from));
  const element = frame.elements.find((candidate) => candidate.id === touched.id && candidate.opacity > 0.2);
  if (element === undefined || frame.viewport.width <= 0 || frame.viewport.height <= 0) return null;
  const quad = planeQuad({ x: element.x - element.width / 2, y: element.y - element.height / 2, width: element.width, height: element.height }, element.layer, frame.camera, frame.viewport);
  const x = quad.reduce((sum, point) => sum + point.x, 0) / quad.length;
  const y = quad.reduce((sum, point) => sum + point.y, 0) / quad.length;
  return { x: Math.max(0, Math.min(1, x / frame.viewport.width)), y: Math.max(0, Math.min(1, y / frame.viewport.height)) };
}

/** `film` (made for `layout.stage`'s size) with the pane laid beside or above it and the input box along the bottom. `parts` are the turns the film holds, in order and where each begins; a film of one turn is `[{ turn, from: 0 }]`. */
export function withPane(film: Film | Reel, recordings: readonly Recording[], log: LangLog, layout: LangLayout): Film {
  const parts = 'parts' in film ? film.parts.filter((part) => !part.card) : null;
  const sources: PaneSource[] = [];
  const leads: PaneLead[] = [];
  if (parts === null) {
    const only = recordings[recordings.length - 1];
    if (only !== undefined) sources.push({ recording: only, from: 0 });
  } else {
    for (const part of parts) {
      const recording = recordings.find((candidate) => candidate.turn === part.turn);
      if (recording !== undefined) sources.push({ recording, from: part.from });
      if (part.lead !== undefined) leads.push({ from: part.lead.from, acting: part.lead.acting, waiting: part.lead.waiting, typed: part.lead.typed, touched: touchOf(film, part) });
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
  return { ...film, surround: paneSurround(sources, leads, log, layout, lookAt) };
}
