// What the shelf tells the brain about a figure it could not draw (PLAN-art.md, section 5, "On a miss"): a sight note on the placeholder, read
// with the rest of how the turn landed. The notes are the server's own, kept by turn and put into the painter's report when the turn is remembered.

import type { Sight, SightItem, SightNote } from '@conduit/language';
import type { ArtNote } from './draw';

const NOTES = new WeakMap<object, Map<string, ArtNote>>();

/** The turn drew a placeholder for `id`, and why. */
export function noteArt(turn: object, id: string, note: ArtNote): void {
  const held = NOTES.get(turn) ?? new Map<string, ArtNote>();
  held.set(id, note);
  NOTES.set(turn, held);
}

const NOTE_OF: Readonly<Record<ArtNote['kind'], SightNote>> = { undrawn: 'undrawn', pending: 'pending', refused: 'refused', drawn: 'drawn' };

/** A report's sight with the turn's art notes on the placeholders they belong to. A turn with none gives its sight back as it was. */
export function withArtNotes(turn: object, sight: Sight | null): Sight | null {
  const held = NOTES.get(turn);
  if (held === undefined || sight === null) return sight;
  const items: SightItem[] = sight.items.map((item) => {
    const id = item.id.endsWith('-soft') ? item.id.slice(0, -5) : item.id;
    const note = held.get(id);
    return note === undefined || note.kind === 'drawn' || item.notes.includes(NOTE_OF[note.kind]) ? item : { ...item, notes: [...item.notes, NOTE_OF[note.kind]] };
  });
  // a drawing's parts are named on the group when it is an item, else on its first part that is: the brain labels them by these names
  for (const [id, note] of held) {
    if (note.kind !== 'drawn' || note.parts.length === 0) continue;
    const at = items.findIndex((item) => item.id === id);
    const first = at >= 0 ? at : items.findIndex((item) => note.parts.includes(item.id));
    const item = items[first];
    if (item === undefined || item.notes.includes('drawn')) continue;
    items[first] = { ...item, notes: [...item.notes, 'drawn'], parts: note.parts } as SightItem;
  }
  return { ...sight, items };
}
