// Several turns laid end to end as one film: an answer that went on through a few taps, or a whole conversation. Each turn is its own
// `createFilm` (the live painter's own score and timeline, from the stage the turn began on, its lines at the playhead each arrived at), so
// every frame is the frame that turn showed; a reel only decides which turn a moment belongs to. A conversation's turns may be set off by a
// title card, made by the same engine as any other frame: one `say` on an empty stage in the look of the turn that follows.

import { parseScript } from '@conduit/language';
import type { Frame } from '../contracts/frame';
import type { Film, FilmOptions, FilmTune, Recording } from '../contracts/film';
import { createFilm } from './film';

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
}

export interface ReelOptions {
  /** a title card before each turn */
  readonly cards: boolean;
  /** the reel is at most this long, seconds: the earliest turns that do not fit are left out whole, and a last turn longer than that is cut */
  readonly maxSeconds: number;
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
  // What the viewer's hand holds now is what the last turn ended with; an earlier turn is shown as it was written.
  const { controls: _held, ...unheld } = options;
  const made = recordings.map((recording, index) => {
    const turnOptions = index === recordings.length - 1 ? options : unheld;
    const film = createFilm(recording, turnOptions);
    const title = recording.asked ?? '';
    const card = reel.cards ? createFilm(cardOf(title, recording), unheld) : null;
    return { recording, film, title, card, cardSeconds: card === null ? 0 : Math.min(CARD_MOST, Math.max(CARD_LEAST, card.duration + CARD_BREATH)) };
  });
  // Newest first: what the viewer has just seen is what they most want kept.
  let total = 0;
  let first = made.length;
  for (let i = made.length - 1; i >= 0; i -= 1) {
    const entry = made[i];
    if (entry === undefined) break;
    const length = entry.cardSeconds + entry.film.duration;
    if (total + length > reel.maxSeconds && first < made.length) break;
    total += length;
    first = i;
  }
  const kept = made.slice(first);
  const parts: ReelPart[] = [];
  const sources: { readonly from: number; readonly film: Film; readonly offset: number }[] = [];
  const tunes: FilmTune[] = [];
  const landmarks: number[] = [0];
  let at = 0;
  for (const entry of kept) {
    if (entry.card !== null) {
      parts.push({ turn: entry.recording.turn, title: entry.title, card: true, from: at, to: at + entry.cardSeconds });
      sources.push({ from: at, film: entry.card, offset: at });
      landmarks.push(at, at + entry.cardSeconds - 0.01);
      at += entry.cardSeconds;
    }
    parts.push({ turn: entry.recording.turn, title: entry.title, card: false, from: at, to: at + entry.film.duration });
    sources.push({ from: at, film: entry.film, offset: at });
    landmarks.push(at, at + entry.film.duration);
    for (const tune of entry.film.tunes ?? []) tunes.push({ ...tune, key: `${entry.recording.turn}:${tune.key}`, at: tune.at + at, until: tune.until + at });
    at += entry.film.duration;
  }
  const cut = at > reel.maxSeconds;
  const duration = Math.min(at, reel.maxSeconds);
  const script = kept.map((entry) => entry.film.script()).join('\n');
  const viewport = options.viewport;
  return {
    duration,
    viewport,
    landmarks,
    ...(tunes.length === 0 ? {} : { tunes: tunes.filter((tune) => tune.at < duration).map((tune) => ({ ...tune, until: Math.min(tune.until, duration) })) }),
    parts,
    turns: kept.length,
    leftOut: first,
    cut,
    frameAt(seconds): Frame {
      const time = Math.max(0, seconds);
      let source = sources[0];
      for (const candidate of sources) {
        if (candidate.from > time) break;
        source = candidate;
      }
      if (source === undefined) throw new Error('A reel of nothing has no frames.');
      return source.film.frameAt(time - source.offset);
    },
    script: () => script,
  };
}
