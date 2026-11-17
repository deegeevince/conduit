// Several turns laid end to end as one film: an answer that went on through a few taps, or a whole conversation. Each turn is its own
// `createFilm` (the live painter's own score and timeline, from the stage the turn began on, its lines at the playhead each arrived at), so
// every frame is the frame that turn showed; a reel only decides which turn a moment belongs to. A conversation's turns may be set off by a
// title card, made by the same engine as any other frame: one `say` on an empty stage in the look of the turn that follows.

import { parseScript } from '@conduit/language';
import type { Frame } from '../contracts/frame';
import type { Box } from '../contracts/space';
import type { Film, FilmOptions, FilmTune, Recording } from '../contracts/film';
import { createFilm, lineSpans } from './film';
import { framingOf } from './framing';
import type { Shot } from './framing';

/** How a prompt is typed into the input box in a film: characters a second, a beat of the empty box before, and a beat the full words stay before they are sent. */
export const TYPING = { cps: 14, before: 0.5, sent: 0.45, touch: 0.9 } as const;
/** A line being drawn stays lit this long past its end (the language pane's own hold). */
const LIT_HOLD = 0.4;
/** A film as the session ran ends with this long at rest. */
const REST_TAIL = 1.2;
/** Lines that are not a drawing of something on stage: a film has nothing to look at while they are performed. */
const NOT_SHOWN = new Set(['scene', 'style', 'look', 'bind', 'cancel', 'drop', 'camera', 'tempo', 'sound', 'fill', 'type', 'press']);

/** How long a turn's lead takes before the wait: typing and sending its prompt, or the touch that began it. */
export function leadOf(recording: Pick<Recording, 'typed' | 'touched'>): number {
  if (recording.typed !== undefined && recording.typed !== '') return TYPING.before + [...recording.typed].length / TYPING.cps + TYPING.sent;
  if (recording.touched !== undefined) return TYPING.touch;
  return 0;
}

/** How a card is held: the time its words take to be set, and a breath after. Never shorter than the least, never longer than the most. */
const CARD_BREATH = 1.1;
const CARD_LEAST = 2;
const CARD_MOST = 4.5;
/** A prompt this long is cut, with an ellipsis: a card is a title, not the page. */
const CARD_WORDS = 160;

export interface ReelPart {
  readonly turn: string;
  /** the viewer's words, for a card; the title of the part */
  readonly title: string;
  readonly card: boolean;
  /** seconds into the reel */
  readonly from: number;
  readonly to: number;
  /**
   * A film made as the session ran (`ReelOptions.session`): before the turn comes a lead, the prompt typed into the input box and sent (or the
   * touch that began it) and then the real wait for the first line. It runs from `lead.from` for `acting + waiting` seconds, ending where an
   * opening card or the turn begins. Absent: no lead.
   */
  readonly lead?: {
    readonly from: number;
    readonly acting: number;
    readonly waiting: number;
    readonly typed: string | null;
    readonly touched: { readonly id: string; readonly text: string } | null;
  };
}

export interface ReelOptions {
  /** a title card before each turn */
  readonly cards: boolean;
  /** the reel is at most this long, seconds: the earliest turns that do not fit are left out whole, and a last turn longer than that is cut */
  readonly maxSeconds: number;
  /**
   * The film as the session ran: each turn is led into by its prompt typed and sent (or the touch that began it) and the real wait for its first
   * line, the controls show what the session recorded (a control the viewer left moved is back at its written value), and the film says where it is
   * quiet (`activity`) so a long wait can be cut. Absent: a film of the turns alone, with the controls as `options` hold them.
   */
  readonly session?: boolean;
}

export interface Reel extends Film {
  readonly parts: readonly ReelPart[];
  /** turns in the reel */
  readonly turns: number;
  /** turns left out of the front for the length limit */
  readonly leftOut: number;
  /** the last turn was longer than the limit, and is cut */
  readonly cut: boolean;
}

/** The turns of the most recent answer: from the last turn the viewer began afresh (a prompt, a demo, a pasted script) through the taps and controls that followed. */
export function lastAnswer(recordings: readonly Recording[]): readonly Recording[] {
  for (let i = recordings.length - 1; i >= 0; i -= 1) {
    const opened = recordings[i]?.opened;
    if (opened === 'prompt' || opened === 'demo' || opened === 'script') return recordings.slice(i);
  }
  return recordings;
}

function cardLines(text: string): string {
  const words = text.replace(/\s+/g, ' ').replace(/\|/g, '/').trim();
  const shown = words.length > CARD_WORDS ? `${words.slice(0, CARD_WORDS - 1).trimEnd()}…` : words;
  const size = shown.length > 70 ? 'l' : 'xl';
  return `style card size=${size} weight=bold enter=fade\nscene layout=solo\nsay c1 card | ${shown === '' ? '(nothing said)' : shown}`;
}

/** A title card as a recording: an empty stage that wears the look of the turn it introduces. */
function cardOf(title: string, before: Recording): Recording {
  const { lines } = parseScript(cardLines(title));
  return {
    turn: `${before.turn}-card`,
    base: { ...before.base, elements: [], scene: { ...before.base.scene, layout: 'solo', expected: null } },
    lines: lines.map((line, index) => ({ seq: index + 1, line, floor: 0 })),
    paintings: {},
    opened: 'none',
  };
}

/**
 * The recordings, in order, as one film. With `cards`, a title card (what the viewer asked) comes before each turn. If the whole is longer
 * than `maxSeconds`, the earliest turns that do not fit are left out; `leftOut` says how many.
 */
export function createReel(recordings: readonly Recording[], options: FilmOptions, reel: ReelOptions): Reel {
  // What the viewer's hand holds now is what the last turn ended with; an earlier turn is shown as it was written. A film made as the session ran
  // starts every control at its written value instead, and shows a change the session recorded (an `act`) from the turn that carries it.
  const { controls: _held, ...unheld } = options;
  const session = reel.session === true;
  const made = recordings.map((recording, index) => {
    const turnOptions = session ? (recording.controls === undefined ? unheld : { ...unheld, controls: recording.controls }) : index === recordings.length - 1 ? options : unheld;
    const film = createFilm(recording, turnOptions);
    const title = recording.asked ?? '';
    const card = reel.cards ? createFilm(cardOf(title, recording), unheld) : null;
    const acting = session ? leadOf(recording) : 0;
    const waiting = session ? Math.max(0, recording.waited ?? 0) : 0;
    return { recording, film, title, card, cardSeconds: card === null ? 0 : Math.min(CARD_MOST, Math.max(CARD_LEAST, card.duration + CARD_BREATH)), acting, waiting, lead: acting + waiting };
  });
  // Newest first: what the viewer has just seen is what they most want kept.
  let total = 0;
  let first = made.length;
  for (let i = made.length - 1; i >= 0; i -= 1) {
    const entry = made[i];
    if (entry === undefined) break;
    const length = entry.lead + entry.cardSeconds + entry.film.duration;
    if (total + length > reel.maxSeconds && first < made.length) break;
    total += length;
    first = i;
  }
  const kept = made.slice(first);
  const parts: ReelPart[] = [];
  /** `frameAt` of a source is asked for the time inside it; `controlsAt` likewise */
  interface Source {
    readonly from: number;
    readonly film: Pick<Film, 'frameAt' | 'controlsAt' | 'boxOf'>;
    readonly offset: number;
  }
  const sources: Source[] = [];
  const tunes: FilmTune[] = [];
  const landmarks: number[] = [0];
  const activity: (readonly [number, number])[] = [];
  const shots: Shot[] = [];
  let at = 0;
  let previous: { readonly film: Film; readonly end: number } | null = null;
  for (const entry of kept) {
    const leadFrom = at;
    if (entry.lead > 0) {
      // The wait: the stage as the last turn left it, going on breathing, or (the first turn) as it is before anything has come.
      const held = previous;
      const next = entry.card ?? entry.film;
      const hold: Source['film'] = {
        frameAt: (seconds) => (held === null ? next.frameAt(0) : held.film.frameAt(held.end + seconds)),
        controlsAt: (seconds) => (held === null ? (next.controlsAt?.(0) ?? []) : (held.film.controlsAt?.(held.end + seconds) ?? [])),
      };
      sources.push({ from: at, film: hold, offset: at });
      landmarks.push(at);
      if (entry.acting > 0) activity.push([at, at + entry.acting]);
      at += entry.lead;
    }
    if (entry.card !== null) {
      parts.push({ turn: entry.recording.turn, title: entry.title, card: true, from: at, to: at + entry.cardSeconds });
      sources.push({ from: at, film: entry.card, offset: at });
      landmarks.push(at, at + entry.cardSeconds - 0.01);
      activity.push([at, at + entry.cardSeconds]);
      at += entry.cardSeconds;
    }
    const lead = entry.lead > 0 ? { from: leadFrom, acting: entry.acting, waiting: entry.waiting, typed: entry.recording.typed ?? null, touched: entry.recording.touched ?? null } : undefined;
    parts.push({ turn: entry.recording.turn, title: entry.title, card: false, from: at, to: at + entry.film.duration, ...(lead === undefined ? {} : { lead }) });
    sources.push({ from: at, film: entry.film, offset: at });
    landmarks.push(at, at + entry.film.duration);
    if (session) {
      const spans = lineSpans(entry.recording);
      for (const { seq, line } of entry.recording.lines) {
        const span = spans.get(seq);
        if (span === undefined || NOT_SHOWN.has(line.verb) || !('id' in line) || typeof line.id !== 'string') continue;
        shots.push({ id: line.id, start: at + span.start, end: at + (Number.isFinite(span.end) ? Math.min(span.end, entry.film.duration) : span.start) });
      }
      for (const span of spans.values()) {
        const end = Number.isFinite(span.end) ? Math.min(span.end, entry.film.duration) : span.start;
        activity.push([at + span.start, at + Math.max(span.start, end) + LIT_HOLD]);
      }
    }
    for (const tune of entry.film.tunes ?? []) {
      tunes.push({ ...tune, key: `${entry.recording.turn}:${tune.key}`, at: tune.at + at, until: tune.until + at });
      activity.push([tune.at + at, Math.min(tune.at + at + tune.model.seconds, tune.until + at)]);
    }
    previous = { film: entry.film, end: entry.film.duration };
    at += entry.film.duration;
  }
  // A film made as the session ran rests a moment at its end, the framing back out on the whole stage.
  const cut = at > reel.maxSeconds;
  const duration = Math.min(at + (session ? REST_TAIL : 0), reel.maxSeconds);
  const script = kept.map((entry) => entry.film.script()).join('\n');
  const viewport = options.viewport;
  const sourceAt = (time: number): Source => {
    let source = sources[0];
    for (const candidate of sources) {
      if (candidate.from > time) break;
      source = candidate;
    }
    if (source === undefined) throw new Error('A reel of nothing has no frames.');
    return source;
  };
  const boxAt = (id: string, seconds: number): Box | null => {
    const time = Math.max(0, seconds);
    const source = sourceAt(time);
    return source.film.boxOf?.(id, time - source.offset) ?? null;
  };
  return {
    duration,
    viewport,
    landmarks,
    ...(session ? { activity: mergeSpans(activity, duration), framing: framingOf(shots, boxAt, viewport) } : {}),
    boxOf: boxAt,
    ...(tunes.length === 0 ? {} : { tunes: tunes.filter((tune) => tune.at < duration).map((tune) => ({ ...tune, until: Math.min(tune.until, duration) })) }),
    parts,
    turns: kept.length,
    leftOut: first,
    cut,
    controlsAt(seconds) {
      const time = Math.max(0, seconds);
      const source = sourceAt(time);
      return source.film.controlsAt?.(time - source.offset) ?? [];
    },
    frameAt(seconds): Frame {
      const time = Math.max(0, seconds);
      const source = sourceAt(time);
      return source.film.frameAt(time - source.offset);
    },
    script: () => script,
  };
}

/** The spans sorted and joined where they touch, clipped to [0, duration]. */
function mergeSpans(spans: readonly (readonly [number, number])[], duration: number): (readonly [number, number])[] {
  const sorted = spans.map(([from, to]) => [Math.max(0, from), Math.min(duration, Math.max(from, to))] as const).filter(([from, to]) => to >= from).sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [from, to] of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && from <= last[1]) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged;
}
