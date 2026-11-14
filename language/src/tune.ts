// A tune: the rows of a `tune` block are ABC notation, the plain-text music notation every model knows, and this file reads them. Pure: no DOM,
// no clock, no sound. It gives the painter what to draw (notes on a roll), the player what to play (notes in time) and the exporter what to
// write (a MIDI file), all from one reading, so that the picture, the sound and the file can never disagree.
//
// The subset of ABC it understands (anything else is skipped, with a warning, and never fails the tune):
//
//   fields       K: key (any tonic, # and b, major / minor and the church modes)   M: metre (4/4, 6/8, C, C|)   L: unit length (1/8)
//                Q: tempo (1/4=120, 120)   V: voice   T: title.  A field may stand in a line of music in brackets: [K:G] [V:2] [M:3/4]
//                X: C: N: Z: O: S: R: B: D: F: G: H: I: P: A: m: r: s: w: W: U: are about the page, not the sound, and are skipped quietly.
//   notes        C D E F G A B (the octave of middle C), c d e f g a b (the one above), , and ' to go down and up, ^ ^^ _ __ = accidentals
//                (they hold to the end of the bar, as printed music has it), lengths 2 /2 3/2 / //, rests z x, a whole bar's rest Z
//   rhythm       > and < (a dotted pair), ties with -, triplets and other tuplets ((3abc, (2 (4 (5 (6 (7 (8 (9)
//   chords       [CEG], with a length after the bracket or inside it, and ties
//   structure    bar lines | || |] [| |: :| :|: ::, first and second endings (|1 :|2 and [1 [2), repeats
//   voices       V:1 and V:2: a melody and a bass, each from the start; a third voice is skipped
//   skipped      grace notes {}, chord symbols "Am", decorations !trill! and . ~ H L M O P S T u v, slurs, lyrics, overlays &, %comments

import { LIMITS } from './vocabulary';

/** One sounding note: when it begins and how long it lasts, in quarter-note beats, and which of the (at most two) voices plays it. */
export interface TuneNote {
  readonly voice: number;
  /** quarter-note beats from the start of the tune */
  readonly start: number;
  /** quarter-note beats it sounds, ties joined */
  readonly dur: number;
  /** 0..127; 60 is middle C */
  readonly midi: number;
  /** 0..1: how hard it is struck; the first beat of a bar is a little firmer */
  readonly vel: number;
  /** the index of the row it was written in, so a picture of a tune still being written shows what has arrived */
  readonly row: number;
}

export interface TuneModel {
  readonly title: string | null;
  /** the key as written, `G`, `Am`, `Bb dor` */
  readonly key: string;
  /** the metre as written, `4/4` */
  readonly meter: string;
  /** quarter-note beats in a bar */
  readonly barBeats: number;
  /** quarter notes a minute */
  readonly tempo: number;
  /** 1 or 2 */
  readonly voices: number;
  /** sorted by `start` */
  readonly notes: readonly TuneNote[];
  /** where each bar of the longest voice begins, quarter-note beats: the picture's bar lines, in the order played (a repeat is two bars) */
  readonly bars: readonly number[];
  /** quarter-note beats in all */
  readonly beats: number;
  /** seconds, at the tempo */
  readonly seconds: number;
  /** the lowest and the highest note, MIDI; 60 and 72 when there are none */
  readonly low: number;
  readonly high: number;
  /** what was skipped or cut, one sentence each, at most a few */
  readonly warnings: readonly string[];
}

export interface TuneOptions {
  /** the tempo the `tune` line asked for; it wins over `Q:` */
  readonly tempo?: number | null;
  /** the title of the `tune` line; it wins over `T:` */
  readonly title?: string | null;
}

export const TUNE_DEFAULT_TEMPO = 108;
export const TUNE_TEMPO_RANGE = { min: 30, max: 240 } as const;

// ---------------------------------------------------------------------------------------------------------------------------------
// Keys

/** Where each letter stands on the circle of fifths as a major key (C is 0, G is 1, F is -1). */
const FIFTHS_OF_LETTER: Readonly<Record<string, number>> = { F: -1, C: 0, G: 1, D: 2, A: 3, E: 4, B: 5 };
const MODE_SHIFT: Readonly<Record<string, number>> = { maj: 0, ion: 0, mix: -1, dor: -2, min: -3, aeo: -3, phr: -4, loc: -5, lyd: 1, m: -3 };
const SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'] as const;
const FLAT_ORDER = ['B', 'E', 'A', 'D', 'G', 'C', 'F'] as const;
/** The semitone of each natural note above C. */
const SEMITONE: Readonly<Record<string, number>> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

interface Key {
  readonly label: string;
  /** the accidental each letter wears in this key: -1 flat, 0 natural, 1 sharp */
  readonly marks: Readonly<Record<string, number>>;
}

function keyOf(text: string): Key | null {
  const found = /^\s*([A-Ga-g])\s*([#b]?)\s*([A-Za-z]*)/.exec(text);
  if (found === null) return null;
  const letter = (found[1] ?? 'C').toUpperCase();
  const accidental = found[2] === '#' ? 1 : found[2] === 'b' ? -1 : 0;
  const word = (found[3] ?? '').toLowerCase();
  const mode = word === '' ? 'maj' : word === 'm' ? 'm' : word.slice(0, 3);
  const shift = MODE_SHIFT[mode];
  if (shift === undefined) return null;
  const fifths = (FIFTHS_OF_LETTER[letter] ?? 0) + 7 * accidental + shift;
  if (fifths < -7 || fifths > 7) return null;
  const marks: Record<string, number> = {};
  for (let i = 0; i < Math.abs(fifths); i += 1) marks[(fifths > 0 ? SHARP_ORDER : FLAT_ORDER)[i] as string] = fifths > 0 ? 1 : -1;
  const named = `${letter}${accidental === 1 ? '#' : accidental === -1 ? 'b' : ''}${mode === 'maj' ? '' : mode === 'm' || mode === 'min' ? 'm' : ` ${mode}`}`;
  return { label: named, marks };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Reading

interface Pitch {
  readonly midi: number;
  beats: number;
}

interface Event {
  /** quarter-note beats this event takes; a rest has no pitches */
  beats: number;
  readonly pitches: readonly Pitch[];
  tied: boolean;
  readonly row: number;
}

interface Bar {
  readonly events: Event[];
  startRepeat: boolean;
  endRepeat: boolean;
  ending: number | null;
}

const newBar = (): Bar => ({ events: [], startRepeat: false, endRepeat: false, ending: null });

interface Voice {
  readonly id: string;
  readonly bars: Bar[];
  cur: Bar;
  /** accidentals written in this bar, by letter and octave: they hold to the bar line */
  held: Map<string, number>;
}

const SILENT_FIELDS = new Set('XCNZOSRBDFGHIPAmrswWU'.split(''));
/** Marks of performance that this player does not make: skipped without a word. */
const DECORATIONS = new Set('.~HLMOPSTuv'.split(''));

/** `3/2`, `/2`, `2`, `/`, `//`, `` read as a number of unit lengths; null when the text is not a length. */
function lengthOf(text: string): number | null {
  if (text === '') return 1;
  const found = /^(\d*)((?:\/\d*)*)$/.exec(text);
  if (found === null) return null;
  let value = found[1] === '' ? 1 : Number(found[1]);
  for (const slash of (found[2] ?? '').split('/').slice(1)) value /= slash === '' ? 2 : Number(slash) || 1;
  return value;
}

/** `1/4=120`, `120`, `"Allegro" 1/8=180`, `C=96`: quarter notes a minute, or null. */
function tempoOf(text: string): number | null {
  const found = /(?:(\d+)\/(\d+)\s*=\s*)?(\d+(?:\.\d+)?)\s*$/.exec(text.replace(/"[^"]*"/g, '').trim());
  if (found === null) return null;
  const per = found[1] === undefined ? 0.25 : Number(found[1]) / Number(found[2]);
  const value = Number(found[3]) * (per === 0 ? 0.25 : per) * 4;
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** `4/4`, `6/8`, `C`, `C|`: the bar's length in whole notes, or null for free time. */
function meterOf(text: string): { readonly label: string; readonly whole: number; readonly compound: boolean } | null {
  const t = text.trim();
  if (t === 'C') return { label: '4/4', whole: 1, compound: false };
  if (t === 'C|') return { label: '2/2', whole: 1, compound: false };
  const found = /^(\d+)\s*\/\s*(\d+)/.exec(t);
  if (found === null) return null;
  const n = Number(found[1]);
  const d = Number(found[2]);
  return n > 0 && d > 0 ? { label: `${n}/${d}`, whole: n / d, compound: d === 8 && n % 3 === 0 && n > 3 } : null;
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

export function parseTune(rows: readonly string[], options: TuneOptions = {}): TuneModel {
  const warnings: string[] = [];
  const warn = (message: string): void => {
    if (warnings.length < 6 && !warnings.includes(message)) warnings.push(message);
  };

  let title: string | null = null;
  let key: Key = keyOf('C') as Key;
  let meter = { label: '4/4', whole: 1, compound: false };
  let unit: number | null = null;
  let tempoQ: number | null = null;
  const voices: Voice[] = [];
  const skippedVoices = new Set<string>();
  let voice: Voice | null = null;
  /** the voice being written is one past the second: its lines are skipped */
  let muted = false;
  let events = 0;

  const makeVoice = (id: string): Voice | null => {
    const known = voices.find((candidate) => candidate.id === id);
    if (known !== undefined) return known;
    if (voices.length >= 2) {
      if (!skippedVoices.has(id)) warn(`only two voices are played; voice ${id} was skipped`);
      skippedVoices.add(id);
      return null;
    }
    const made: Voice = { id, bars: [], cur: newBar(), held: new Map() };
    voices.push(made);
    return made;
  };
  const unitBeats = (): number => 4 * (unit ?? (meter.whole < 0.75 ? 1 / 16 : 1 / 8));

  const field = (raw: string, value: string): void => {
    const letter = raw.toUpperCase();
    switch (letter) {
      case 'K': {
        const read = keyOf(value);
        if (read === null) warn(`the key "${value.trim().slice(0, 12)}" was not understood; the key stays ${key.label}`);
        else key = read;
        break;
      }
      case 'M': {
        const read = meterOf(value);
        if (read === null) {
          if (value.trim().toLowerCase() !== 'none') warn(`the metre "${value.trim().slice(0, 12)}" was not understood; it stays ${meter.label}`);
        } else meter = read;
        break;
      }
      case 'L': {
        const found = /^\s*(\d+)\s*\/\s*(\d+)/.exec(value);
        if (found === null || Number(found[1]) <= 0 || Number(found[2]) <= 0) warn(`the unit length "${value.trim().slice(0, 12)}" was not understood`);
        else unit = Number(found[1]) / Number(found[2]);
        break;
      }
      case 'Q': {
        const read = tempoOf(value);
        if (read === null) warn(`the tempo "${value.trim().slice(0, 16)}" was not understood`);
        else tempoQ = read;
        break;
      }
      case 'T':
        if (title === null && value.trim() !== '') title = value.trim().slice(0, 80);
        break;
      case 'V': {
        const id = value.trim().split(/\s+/)[0] ?? '1';
        voice = makeVoice(id === '' ? '1' : id);
        muted = voice === null;
        break;
      }
      default:
        if (!SILENT_FIELDS.has(raw)) warn(`the ABC field ${letter}: is not played; skipped`);
    }
  };

  // One line of music, a character at a time.
  const body = (line: string, row: number): void => {
    let i = 0;
    let nextFactor = 1;
    let tuplet: { left: number; ratio: number } | null = null;
    let pendingEnding: number | null = null;
    let graceWarned = false;
    const current = (): Voice | null => (muted ? null : (voice ?? (voice = makeVoice('1'))));

    const push = (target: Voice, beats: number, pitches: readonly Pitch[], tied: boolean): void => {
      if (events >= LIMITS.tuneNotes) return;
      let factor = nextFactor;
      nextFactor = 1;
      if (tuplet !== null) {
        factor *= tuplet.ratio;
        tuplet.left -= 1;
        if (tuplet.left <= 0) tuplet = null;
      }
      for (const p of pitches) p.beats *= factor;
      events += pitches.length;
      target.cur.events.push({ beats: beats * factor, pitches, tied, row });
    };

    /** After a note, a chord or a rest: a `>` or `<` after it dots it and shortens the next by as much (`A>B`), or the other way about. */
    const dotted = (target: Voice): void => {
      let j = i;
      while (line[j] === ' ') j += 1;
      const found = /^(>+|<+)/.exec(line.slice(j));
      if (found === null) return;
      const n = found[0].length;
      const long = 2 - 2 ** -n;
      const short = 2 ** -n;
      const first = found[0].startsWith('>') ? long : short;
      const last = target.cur.events.at(-1);
      if (last !== undefined) {
        last.beats *= first;
        for (const p of last.pitches) p.beats *= first;
      }
      nextFactor = found[0].startsWith('>') ? short : long;
      i = j + n;
    };

    /** A note's pitch: its letter, the accidentals before it, the marks after it, this key and this bar. */
    const pitch = (target: Voice, accidental: string, letter: string, marks: string): number => {
      const upper = letter.toUpperCase();
      let octave = letter === upper ? 4 : 5;
      for (const mark of marks) octave += mark === "'" ? 1 : -1;
      const slot = `${upper}${octave}`;
      let shift: number;
      if (accidental === '') shift = target.held.get(slot) ?? key.marks[upper] ?? 0;
      else {
        shift = accidental === '=' ? 0 : accidental.includes('^') ? accidental.length : -accidental.length;
        target.held.set(slot, shift);
      }
      return clamp(12 * (octave + 1) + (SEMITONE[upper] ?? 0) + shift, 0, 127);
    };

    const barline = (target: Voice, run: string, ending: number | null): void => {
      if (target.cur.events.length > 0) {
        target.bars.push(target.cur);
        target.cur = newBar();
      }
      if (run.startsWith(':')) {
        const last = target.bars[target.bars.length - 1];
        if (last !== undefined) last.endRepeat = true;
      }
      if (run.endsWith(':')) target.cur.startRepeat = true;
      if (ending !== null) target.cur.ending = ending;
      target.held = new Map();
    };

    while (i < line.length) {
      const c = line[i] as string;
      const rest = line.slice(i);
      if (c === ' ' || c === '\t' || c === '\\') {
        i += 1;
        continue;
      }
      if (c === '"') {
        const end = line.indexOf('"', i + 1);
        i = end < 0 ? line.length : end + 1;
        continue;
      }
      if (c === '!' || c === '+') {
        const end = line.indexOf(c, i + 1);
        i = end < 0 ? i + 1 : end + 1;
        continue;
      }
      if (c === '{') {
        const end = line.indexOf('}', i + 1);
        if (!graceWarned) warn('grace notes are skipped');
        graceWarned = true;
        i = end < 0 ? line.length : end + 1;
        continue;
      }
      if (c === '(') {
        const found = /^\((\d)(?::(\d*))?(?::(\d*))?/.exec(rest);
        if (found !== null) {
          const p = Number(found[1]);
          const q = found[2] !== undefined && found[2] !== '' ? Number(found[2]) : ({ 2: 3, 3: 2, 4: 3, 6: 2, 8: 3 } as Record<number, number>)[p] ?? (meter.compound ? 3 : 2);
          const count = found[3] !== undefined && found[3] !== '' ? Number(found[3]) : p;
          if (p >= 2 && q > 0) tuplet = { left: count, ratio: q / p };
          else warn(`a tuplet "(${found[1] ?? ''}" was not understood`);
          i += found[0].length;
        } else i += 1;
        continue;
      }
      if (c === ')' || DECORATIONS.has(c)) {
        i += 1;
        continue;
      }
      if (c === '&') {
        warn('voice overlay (&) is skipped');
        i += 1;
        continue;
      }
      // an inline field: [K:G] [V:2]
      const inline = /^\[([A-Za-z]):([^\]]*)\]/.exec(rest);
      if (inline !== null) {
        field(inline[1] as string, inline[2] ?? '');
        i += inline[0].length;
        continue;
      }
      // a bar line, with its repeat signs and a first or second ending after it
      if (c === '|' || c === ':' || (c === '[' && (line[i + 1] === '|' || /\d/.test(line[i + 1] ?? '')))) {
        let run = '';
        let j = i;
        while (j < line.length) {
          const d = line[j] as string;
          if (d === '|' || d === ':') run += d;
          else if (d === '[' && line[j + 1] === '|') run += d;
          else if (d === ']' && run.endsWith('|')) run += d;
          else break;
          j += 1;
        }
        let ending: number | null = null;
        let k = j;
        if (line[k] === '[' && /\d/.test(line[k + 1] ?? '')) k += 1;
        const digits = /^\d/.exec(line.slice(k));
        if (digits !== null && (k > j || run !== '')) {
          ending = Number(digits[0]);
          j = k + 1;
          while (line[j] === ',' || /\d/.test(line[j] ?? '')) j += 1;
        }
        if (run === '' && ending === null) {
          i += 1;
          continue;
        }
        pendingEnding = ending ?? pendingEnding;
        const target = current();
        if (target !== null) {
          barline(target, run.replace(/[[\]]/g, ''), pendingEnding);
          pendingEnding = null;
        }
        i = j;
        continue;
      }
      // a chord
      if (c === '[') {
        const end = line.indexOf(']', i);
        if (end < 0) {
          warn('a chord with no closing bracket was skipped');
          break;
        }
        const target = current();
        const inner = line.slice(i + 1, end);
        i = end + 1;
        const outer = /^(\d*(?:\/\d*)*)(-?)/.exec(line.slice(i));
        const multiplier = lengthOf(outer?.[1] ?? '') ?? 1;
        i += outer?.[0].length ?? 0;
        if (target === null) continue;
        const pitches: Pitch[] = [];
        let first: number | null = null;
        let tiedChord = outer?.[2] === '-';
        for (const note of inner.matchAll(/(\^+|_+|=)?([A-Ga-g])([,']*)(\d*(?:\/\d*)*)(-?)/g)) {
          const own = lengthOf(note[4] ?? '') ?? 1;
          first ??= own;
          const midi = pitch(target, note[1] ?? '', note[2] as string, note[3] ?? '');
          pitches.push({ midi, beats: own * multiplier * unitBeats() });
          if (note[5] === '-') tiedChord = true;
        }
        if (pitches.length === 0) {
          warn('a chord with no notes in it was skipped');
          continue;
        }
        push(target, (first ?? 1) * multiplier * unitBeats(), pitches, tiedChord);
        dotted(target);
        continue;
      }
      // a rest
      if (c === 'z' || c === 'x' || c === 'Z' || c === 'X' || c === 'y') {
        const found = /^[zxZXy](\d*(?:\/\d*)*)/.exec(rest);
        i += found?.[0].length ?? 1;
        const target = current();
        if (target === null || c === 'y') continue;
        const length = lengthOf(found?.[1] ?? '') ?? 1;
        push(target, c === 'Z' || c === 'X' ? length * meter.whole * 4 : length * unitBeats(), [], false);
        dotted(target);
        continue;
      }
      // a note
      const note = /^(\^+|_+|=)?([A-Ga-g])([,']*)(\d*(?:\/\d*)*)(-?)/.exec(rest);
      if (note !== null) {
        i += note[0].length;
        const target = current();
        if (target === null) continue;
        const own = lengthOf(note[4] ?? '');
        const beats = (own ?? 1) * unitBeats();
        push(target, beats, [{ midi: pitch(target, note[1] ?? '', note[2] as string, note[3] ?? ''), beats }], note[5] === '-');
        dotted(target);
        continue;
      }
      if (c === '-') {
        // a tie written after a bar line or a space: it belongs to the note before
        const target = current();
        const last = target?.cur.events.at(-1) ?? target?.bars.at(-1)?.events.at(-1);
        if (last !== undefined) last.tied = true;
        i += 1;
        continue;
      }
      if (c === '*' || c === '$' || c === '/' || c === ']' || c === ',' || c === "'" || c === '.' || /\d/.test(c)) {
        i += 1;
        continue;
      }
      warn(`"${c}" is not ABC this player knows; skipped`);
      i += 1;
    }
  };

  rows.forEach((raw, row) => {
    const line = raw.replace(/\s+%.*$|^%.*$/, '').replace(/\r$/, '').trim();
    if (line === '') return;
    // `K:G`, `V:2`: a letter and a colon (not a note before a repeat, `A:|`) is a field
    const head = /^([A-Za-z]):(?![|:])\s?(.*)$/.exec(line);
    if (head !== null) field(head[1] as string, head[2] ?? '');
    else body(line, row);
  });

  // Close the bars still open.
  for (const each of voices) if (each.cur.events.length > 0) each.bars.push(each.cur);

  // The order the bars are played in, from the first voice; a voice with the same number of bars follows it, any other follows its own marks.
  const orderOf = (bars: readonly Bar[]): number[] => {
    const order: number[] = [];
    let at = 0;
    let start = 0;
    let pass = 1;
    const taken = new Set<number>();
    let guard = 0;
    while (at < bars.length && guard < bars.length * 4 + 64) {
      guard += 1;
      const bar = bars[at] as Bar;
      if (bar.ending === null && at > 0 && (bars[at - 1] as Bar).ending !== null) pass = 1;
      if (bar.startRepeat) start = at;
      if (bar.ending !== null && bar.ending !== pass) {
        at += 1;
        continue;
      }
      order.push(at);
      if (bar.endRepeat && !taken.has(at)) {
        taken.add(at);
        pass += 1;
        at = start;
        continue;
      }
      if (bar.endRepeat) {
        pass = 1;
        start = at + 1;
      }
      at += 1;
    }
    return order;
  };
  const lead = voices[0];
  const leadOrder = lead === undefined ? [] : orderOf(lead.bars);

  const notes: TuneNote[] = [];
  let beats = 0;
  let barStarts: number[] = [];
  const tempo = clamp(Math.round(options.tempo ?? tempoQ ?? TUNE_DEFAULT_TEMPO), TUNE_TEMPO_RANGE.min, TUNE_TEMPO_RANGE.max);
  const cap = (LIMITS.tuneSeconds * tempo) / 60;
  const barBeats = Math.max(0.5, meter.whole * 4);
  voices.forEach((each, index) => {
    const order = each.bars.length === lead?.bars.length ? leadOrder : orderOf(each.bars);
    let t = 0;
    const starts: number[] = [];
    // a tie runs on into the next note of the same pitch that begins where this one ends
    const open = new Map<number, { start: number; dur: number; vel: number; row: number }>();
    const flush = (midi: number): void => {
      const held = open.get(midi);
      if (held === undefined) return;
      open.delete(midi);
      notes.push({ voice: index, start: held.start, dur: held.dur, midi, vel: held.vel, row: held.row });
    };
    for (const at of order) {
      const bar = each.bars[at] as Bar;
      starts.push(t);
      const barStart = t;
      for (const event of bar.events) {
        if (t >= cap) break;
        const strong = Math.abs((t - barStart) % barBeats) < 1e-6 ? 0.1 : 0;
        const here = new Set(event.pitches.map((p) => p.midi));
        for (const p of event.pitches) {
          const joined = open.get(p.midi);
          if (joined !== undefined && Math.abs(joined.start + joined.dur - t) < 1e-6) joined.dur += p.beats;
          else {
            flush(p.midi);
            open.set(p.midi, { start: t, dur: p.beats, vel: clamp((index === 0 ? 0.74 : 0.62) + strong, 0.2, 1), row: event.row });
          }
        }
        // a pitch goes on into the next event only when this one is tied; anything else that was open is over
        for (const midi of [...open.keys()]) if (!here.has(midi) || !event.tied) flush(midi);
        t += event.beats;
      }
    }
    for (const midi of [...open.keys()]) flush(midi);
    beats = Math.max(beats, Math.min(t, cap));
    if (t > cap) warn(`the tune is cut at ${LIMITS.tuneSeconds} seconds`);
    if (starts.length > barStarts.length) barStarts = starts;
  });
  notes.sort((a, b) => a.start - b.start || a.midi - b.midi || a.voice - b.voice);
  if (notes.length > LIMITS.tuneNotes) {
    warn(`a tune has at most ${LIMITS.tuneNotes} notes; the rest were cut`);
    notes.length = LIMITS.tuneNotes;
  }
  const trimmed = notes.filter((n) => n.start < cap).map((n) => (n.start + n.dur > cap ? { ...n, dur: cap - n.start } : n));
  if (voices.length === 0 && rows.some((row) => row.trim() !== '')) warn('no notes were found');
  let low = 127;
  let high = 0;
  for (const n of trimmed) {
    low = Math.min(low, n.midi);
    high = Math.max(high, n.midi);
  }
  if (trimmed.length === 0) [low, high] = [60, 72];
  return {
    title: options.title ?? title,
    key: key.label,
    meter: meter.label,
    barBeats,
    tempo,
    voices: Math.max(1, voices.length),
    notes: trimmed,
    bars: barStarts.filter((start) => start < beats),
    beats,
    seconds: (beats * 60) / tempo,
    low,
    high,
    warnings,
  };
}

const KEPT = new Map<string, TuneModel>();

/**
 * `parseTune`, remembered: the painter reads the same score at every frame and the schedule at every line, and a tune of a hundred rows is
 * read in one go each time it grows, not again for each of the rows that came before.
 */
export function cachedTune(rows: readonly string[], options: TuneOptions = {}): TuneModel {
  const key = `${options.tempo ?? ''}|${options.title ?? ''}|${rows.join('\n')}`;
  const known = KEPT.get(key);
  if (known !== undefined) {
    KEPT.delete(key);
    KEPT.set(key, known);
    return known;
  }
  const made = parseTune(rows, options);
  KEPT.set(key, made);
  if (KEPT.size > 120) KEPT.delete(KEPT.keys().next().value as string);
  return made;
}

/** The rows of a tune as written, from a figure's rows. */
export function tuneRowsOf(rows: readonly { readonly cells: readonly string[] }[]): string[] {
  return rows.map((row) => row.cells[0] ?? '');
}

/** A tune in a few words: what it is, how long, how it begins. For the transcript and for what the brain is told is on stage. */
export function describeTune(model: TuneModel, rows: number): string {
  const minutes = Math.floor(model.seconds / 60);
  const seconds = Math.round(model.seconds % 60);
  const length = `${minutes}:${String(seconds).padStart(2, '0')}`;
  const bars = model.bars.length;
  return `tune${model.title === null ? '' : ` "${model.title}"`} in ${model.key}, ${model.meter}, ${model.tempo} bpm, ${model.voices} voice${model.voices === 1 ? '' : 's'}, ${bars} bar${bars === 1 ? '' : 's'}, ${length} (${rows} row${rows === 1 ? '' : 's'})`;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// A MIDI file

/** The General MIDI program each voice stands for: a piano, strings, a square lead, tubular bells. */
export const TUNE_PROGRAMS: Readonly<Record<string, number>> = { piano: 0, strings: 48, chip: 80, bell: 14 };

const PPQ = 480;

function variable(value: number): number[] {
  let v = Math.max(0, Math.round(value));
  const bytes = [v & 0x7f];
  while ((v >>= 7) > 0) bytes.unshift((v & 0x7f) | 0x80);
  return bytes;
}

function chunk(tag: string, body: readonly number[]): number[] {
  const length = body.length;
  return [...[...tag].map((c) => c.charCodeAt(0)), (length >>> 24) & 255, (length >>> 16) & 255, (length >>> 8) & 255, length & 255, ...body];
}

/**
 * A Standard MIDI File (format 1) of the tune: a tempo track, then one track a voice with the instrument that voice was played on. Notes at the
 * pitches and times the player uses; velocities from the same reading. No dependency, and no more than the format needs.
 */
export function tuneToMidi(model: TuneModel, voiceName: string = 'piano'): Uint8Array {
  const program = TUNE_PROGRAMS[voiceName] ?? 0;
  const text = (kind: number, value: string): number[] => {
    const bytes = [...value].map((c) => c.charCodeAt(0) & 0x7f).slice(0, 120);
    return [0, 0xff, kind, ...variable(bytes.length), ...bytes];
  };
  const micros = Math.round(60_000_000 / model.tempo);
  const [numerator = 4, denominator = 4] = model.meter.split('/').map(Number);
  const exponent = Math.max(0, Math.round(Math.log2(denominator || 4)));
  const tempoTrack = [
    ...(model.title === null ? [] : text(0x03, model.title)),
    0, 0xff, 0x51, 0x03, (micros >> 16) & 255, (micros >> 8) & 255, micros & 255,
    0, 0xff, 0x58, 0x04, numerator || 4, exponent, 24, 8,
    0, 0xff, 0x2f, 0x00,
  ];
  const tracks = [chunk('MTrk', tempoTrack)];
  for (let voice = 0; voice < model.voices; voice += 1) {
    const channel = voice;
    const edges: { tick: number; on: boolean; midi: number; vel: number }[] = [];
    for (const note of model.notes) {
      if (note.voice !== voice) continue;
      const start = Math.round(note.start * PPQ);
      const end = Math.max(start + 1, Math.round((note.start + note.dur) * PPQ));
      edges.push({ tick: start, on: true, midi: note.midi, vel: clamp(Math.round(note.vel * 127), 1, 127) }, { tick: end, on: false, midi: note.midi, vel: 0 });
    }
    // an end before a start at the same tick, so that a repeated note is struck again
    edges.sort((a, b) => a.tick - b.tick || Number(a.on) - Number(b.on));
    const body: number[] = [...text(0x03, voice === 0 ? 'melody' : 'bass'), 0, 0xc0 | channel, program];
    let last = 0;
    for (const edge of edges) {
      body.push(...variable(edge.tick - last), (edge.on ? 0x90 : 0x80) | channel, edge.midi, edge.vel);
      last = edge.tick;
    }
    body.push(0, 0xff, 0x2f, 0x00);
    tracks.push(chunk('MTrk', body));
  }
  const header = chunk('MThd', [0, 1, 0, tracks.length, (PPQ >> 8) & 255, PPQ & 255]);
  return Uint8Array.from([...header, ...tracks.flat()]);
}
