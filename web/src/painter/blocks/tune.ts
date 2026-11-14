// Tune: a piano roll. The score is read once (language/src/tune.ts, the same reading the player and the MIDI file use); this engine lays
// it out, and `playingParts` is what is added at every frame while it sounds: a playhead that keeps time with the music, and each note
// lighting as it is struck.
//
// Time runs left to right, pitch bottom to top. A voice is a colour (the look's accent, then its alt); a bar line is a hairline; an
// octave's C is a hairline too, named at the left. The roll's room and its range are in the layout, so the dynamic parts can find them.

import { cachedTune, tuneRowsOf } from '@conduit/language';
import type { TuneModel } from '@conduit/language';
import type { BlockPart, StructureInput, StructureLayout } from '../../contracts/blocks';
import type { Box } from '../../contracts/space';
import { box, closedLine, open, rectOutline } from './geom';
import { Env } from './kit';

/** The key under which a tune's layout keeps its roll's box: the playhead and the lit notes are drawn against it. */
export const rollKey = (owner: string): string => `${owner}#roll`;

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/** The score of a tune structure as the painter reads it: the rows that have arrived, the tempo it was asked for, its title. */
export function modelOf(structure: StructureInput['structure'], rows?: number): TuneModel {
  const figure = structure.figure;
  if (figure?.kind !== 'structure') return cachedTune([]);
  const all = tuneRowsOf(rows === undefined ? figure.rows : figure.rows.slice(0, rows));
  return cachedTune(all, { tempo: figure.tempo ?? null, title: structure.text === '' ? null : structure.text });
}

/** The pitches the roll shows: every note with a semitone to spare, and never less than a fifth and a half octaves. */
export function rollRange(model: TuneModel): { readonly lo: number; readonly hi: number } {
  let lo = model.low - 1;
  let hi = model.high + 2;
  if (hi - lo < 14) {
    const middle = (hi + lo) / 2;
    lo = middle - 7;
    hi = middle + 7;
  }
  return { lo: Math.floor(lo), hi: Math.ceil(hi) };
}

export function layoutTune(input: StructureInput): StructureLayout {
  const structure = input.structure;
  const figure = structure.figure;
  const key = structure.key;
  const model = modelOf(structure);
  const env = new Env(input, 1, 1, input.look.stroke);
  const room = input.room;
  const body = env.body;
  const small = env.small();
  const parts: BlockPart[] = [];

  const label = input.measure('C#4', small, 1e9);
  const gutter = env.up(label.width + body * 0.5, 'x');
  const head = env.up(label.height + body * 0.3, 'y');

  // what it is: key, metre, tempo, the instrument, how long. It shares the title's row when it fits there, and goes under the roll when it does not.
  const minutes = Math.floor(model.seconds / 60);
  const seconds = Math.round(model.seconds % 60);
  const meta = `${model.key}, ${model.meter}, ${model.tempo} bpm, ${figure?.kind === 'structure' ? (figure.voice ?? 'piano') : 'piano'}, ${minutes}:${String(seconds).padStart(2, '0')}`;
  const metaM = input.measure(meta, small, room.width);
  const text = structure.text.trim();
  const titleSpec = { ...env.spec, size: 'm' as const };
  const titleM = text === '' ? null : input.measure(text, titleSpec, room.width);
  const together = titleM === null || titleM.width + metaM.width + body * 1.5 <= room.width;
  const titleH = titleM === null ? (together ? metaM.height + body * 0.4 : 0) : env.up(Math.max(titleM.height, together ? metaM.height : 0) + body * 0.4, 'y');
  if (titleM !== null) parts.push({ kind: 'text', owner: key, part: 'title', text, emphasis: [], box: box(room.x, room.y, titleM.width, titleM.height), spec: titleSpec, align: 'left', role: 'title', plate: false });
  const foot = together ? 0 : env.up(metaM.height + body * 0.5, 'y');
  if (together) parts.push({ kind: 'text', owner: key, part: 'meta', text: meta, emphasis: [], box: box(room.x + room.width - metaM.width, room.y + (titleM === null ? 0 : Math.max(0, titleM.height - metaM.height)), metaM.width, metaM.height), spec: small, align: 'right', role: 'value', plate: false });
  else parts.push({ kind: 'text', owner: key, part: 'meta', text: meta, emphasis: [], box: box(room.x + gutter, room.y + room.height - metaM.height - body * 0.1, Math.min(metaM.width, room.width - gutter), metaM.height), spec: small, align: 'left', role: 'value', plate: false });

  const left = room.x + gutter;
  const top = room.y + titleH + head;
  const width = Math.max(0, room.width - gutter);
  const height = Math.max(0, room.height - titleH - head - foot);
  const roll: Box = box(left, top, width, height);

  if (width > 0 && height > 0) {
    const { lo, hi } = rollRange(model);
    const rowH = height / (hi - lo);
    const perBeat = width / Math.max(1, model.beats);
    const xOf = (beat: number): number => env.snap(left + beat * perBeat, 'x');
    const yOf = (pitch: number): number => top + height - (pitch - lo) * rowH;

    // the octaves' C lines, named; and the bar lines, numbered
    // an octave is named when there is room to say so; where there is not, every second octave, and middle C always
    const spare = rowH * 12 >= label.height * 1.25 ? 1 : 2;
    for (let p = Math.ceil(lo / 12) * 12; p < hi; p += 12) {
      const y = yOf(p);
      parts.push({ kind: 'shape', owner: key, part: `c:${p}`, outline: [open([{ x: left, y }, { x: left + width, y }])], role: 'grid' });
      if ((p / 12) % spare !== 0 && p !== 60) continue;
      const name = `${NOTE_NAMES[p % 12] as string}${Math.floor(p / 12) - 1}`;
      const m = input.measure(name, small, 1e9);
      parts.push({ kind: 'text', owner: key, part: `cn:${p}`, text: name, emphasis: [], box: box(room.x + gutter - m.width - body * 0.25, y - m.height / 2, m.width, m.height), spec: small, align: 'right', role: 'tick', plate: false });
    }
    // every bar's line when there is room for it, else every second, fourth, eighth
    const barW = model.bars.length > 1 ? perBeat * (model.bars[1] as number) : width;
    let every = 1;
    while (barW * every < body * 2.4 && every < 16) every *= 2;
    const numberW = input.measure(String(Math.max(1, model.bars.length)), small, 1e9).width;
    while (barW * every < numberW * 1.8 && every < 64) every *= 2;
    model.bars.forEach((start, index) => {
      if (index % every !== 0) return;
      const x = xOf(start);
      if (index > 0) parts.push({ kind: 'shape', owner: key, part: `bar:${index}`, outline: [open([{ x, y: top }, { x, y: top + height }])], role: 'grid' });
      const text = String(index + 1);
      const m = input.measure(text, small, 1e9);
      parts.push({ kind: 'text', owner: key, part: `bn:${index}`, text, emphasis: [], box: box(x + body * 0.2, room.y + titleH, m.width, m.height), spec: small, align: 'left', role: 'tick', plate: false });
    });

    // the notes: a part for each voice's notes of each row, so that they come in as their row does
    const byPart = new Map<string, { row: number; voice: number; lines: ReturnType<typeof rectOutline>[] }>();
    for (const note of model.notes) {
      const x0 = xOf(note.start);
      const x1 = Math.max(x0 + 1.5, xOf(note.start + note.dur) - Math.max(0.6, perBeat * 0.04));
      const gap = Math.min(1, rowH * 0.12);
      const rect = rectOutline(box(x0, yOf(note.midi + 1) + gap, x1 - x0, Math.max(1.2, rowH - 2 * gap)));
      const id = `n:${note.voice}:${note.row}`;
      const entry = byPart.get(id) ?? { row: note.row, voice: note.voice, lines: [] };
      entry.lines.push(rect);
      byPart.set(id, entry);
    }
    for (const [id, entry] of byPart) parts.push({ kind: 'shape', owner: key, part: id, outline: entry.lines, role: entry.voice === 0 ? 'note' : 'note2', row: entry.row });

    parts.push({ kind: 'shape', owner: key, part: 'frame', outline: [closedLine(rectOutline(roll).points)], role: 'frame' });
  }

  const tooSmall = width < body * 6 || height < body * 3;
  return {
    boxes: new Map([
      [key, room],
      [rollKey(key), roll],
    ]),
    parts,
    routes: new Map(),
    notes: tooSmall ? [{ key, note: 'crowded' }] : [],
    shrink: 1,
  };
}

/**
 * What is added to the roll while the tune sounds, at `position` seconds into it: the playhead, and a lit note for each one that is sounding.
 * The picture follows the sound: `position` is the player's own, or the painter's clock when nothing is playing it. Under reduced motion the
 * playhead does not glide; it steps from bar to bar.
 */
export function playingParts(owner: string, model: TuneModel, roll: Box, position: number, reducedMotion: boolean): BlockPart[] {
  if (roll.width <= 0 || roll.height <= 0 || model.beats <= 0 || position < 0 || position > model.seconds + 0.25) return [];
  const { lo, hi } = rollRange(model);
  const rowH = roll.height / (hi - lo);
  const perBeat = roll.width / Math.max(1, model.beats);
  const beat = Math.min(model.beats, (position * model.tempo) / 60);
  let shown = beat;
  if (reducedMotion) for (const start of model.bars) if (start <= beat) shown = start;
  const x = roll.x + shown * perBeat;
  const parts: BlockPart[] = [{ kind: 'shape', owner, part: 'playhead', outline: [open([{ x, y: roll.y }, { x, y: roll.y + roll.height }])], role: 'line' }];
  let lit = 0;
  for (const note of model.notes) {
    if (note.start > beat) break;
    if (note.start + note.dur <= beat || lit >= 10) continue;
    const grow = Math.min(2.5, rowH * 0.2);
    const rect = rectOutline(box(roll.x + note.start * perBeat - grow, roll.y + roll.height - (note.midi + 1 - lo) * rowH - grow, Math.max(1.5, note.dur * perBeat) + 2 * grow, Math.max(1.2, rowH) + 2 * grow));
    parts.push({ kind: 'shape', owner, part: `lit:${lit}`, outline: [closedLine(rect.points)], role: 'lit' });
    lit += 1;
  }
  return parts;
}
