// Sight: what the painter tells the brain about how its last answer actually
// landed. The brain writes blind; this is the one place it is told what the
// canvas did with its lines. It is small on purpose: a brain reads it at the
// start of every turn, so every field has to earn its tokens.

import type { CanvasBox } from './types';
import type { CanvasName, ElementKind } from './vocabulary';

/** Something about an element's landing the brain would want to know, because it would have written the line differently. */
export const SIGHT_NOTE = {
  clipped: 'part of it fell outside the screen',
  outside: 'part of it stands outside the canvas, the frame the picture is read in: put it back inside (the point in `at=` or `move` is where the middle of the words goes, or their right edge with `align=right`, not their corner)',
  'off-canvas': 'none of it was on screen',
  covered: 'something drawn later hides most of it',
  overlaps: 'it sits on top of text',
  shrunk: 'it was made smaller to fit',
  wrapped: 'it broke over more lines than is comfortable',
  recoloured: 'its colour was changed to stay readable',
  collides: 'its words run into other words',
  crossed: 'a drawn line runs through its words',
  spills: 'it spills out past the edge of a bigger filled shape that mostly holds it: pull it inside, or make it smaller',
  refit: 'it was written inside a shape but did not fit, so it was shrunk toward its centre until it did',
  'wrong-part': 'its leader line ends on, or nearer to, a different part than the one it names',
  tangled: 'its leader line crosses another label\'s leader line',
  crowded: 'there were too many parts for the room, so they came out small: give the structure the whole scene, or split it in two',
  faint: 'it is hard to read against what is behind it',
  tiny: 'it came out too small to make out',
  sparse: 'the drawing ended in a corner: most of the picture is empty. Centre it, make it larger, or end the move inside the frame',
  retired: 'the layout let it go to make room: it is not on the stage at rest',
  lost: 'the line the answer rests on is not on the stage at rest: say less above it, or say it last',
  partial: 'the answer stopped while it was still arriving',
  painted: 'the painting arrived and replaced the sketch',
  unpainted: 'no painting arrived; the sketch is what was seen',
  undrawn: 'the shelf has no drawing of this subject yet: a soft placeholder stands in its place, so draw it with shapes if the picture needs it',
  pending: 'a drawing of this subject is being made and will replace the soft placeholder in a minute or two: leave it, and do not draw it again with shapes. Labels written for its parts wait for the drawing and appear beside the parts: do not rewrite them',
  drawn: 'a drawing from the shelf, made of named parts (listed with it): label one with near=<figure>-<part>, and never redraw it with shapes',
  refused: 'this subject is not drawn here (a real person, a brand, a named character, or something not for a young child): a soft placeholder stands in its place',
} as const;
export type SightNote = keyof typeof SIGHT_NOTE;

export interface SightItem {
  readonly id: string;
  readonly kind: ElementKind;
  /** where it rested, in whole canvas units of the scene's canvas, as a top-left corner and a size (a brief prints the centre). For something that had left, where it last was. */
  readonly box: CanvasBox;
  /** still on stage when the turn came to rest */
  readonly resting: boolean;
  readonly notes: readonly SightNote[];
  /** with the `spills` note: the id of the shape it spills out of */
  readonly within?: string;
  /** with the `collides` note: the ids of the lines of words it runs into (at most three, in the order they came). Two lines that run into one another are each told of the other, so the brain can tell which of them to move */
  readonly against?: readonly string[];
  /** it is on the stage at rest but fully transparent: not a fault in a draft (a stepper's parts wait at `opacity=0`), but a fix that makes something so has hidden it, not mended it */
  readonly hidden?: true;
  /** with the `drawn` note: the names of the parts of the drawing, as `<figure>-<name>` */
  readonly parts?: readonly string[];
}

/** A note in the words the brain reads: `spills` names the shape it spills out of. */
export function noteText(item: Pick<SightItem, 'within' | 'parts' | 'against'>, note: SightNote): string {
  if (note === 'drawn' && item.parts !== undefined && item.parts.length > 0) return `${SIGHT_NOTE[note]}. Parts: ${item.parts.slice(0, 16).join(', ')}`;
  if (note === 'collides' && item.against !== undefined && item.against.length > 0) return `${SIGHT_NOTE[note]} (${item.against.join(', ')})`;
  return note === 'spills' && item.within !== undefined ? `spills out of ${item.within}: ${SIGHT_NOTE[note].replace(/^it spills out past the edge of a bigger filled shape that mostly holds it: /, '')}` : SIGHT_NOTE[note];
}

/**
 * Where a thing on the stage really rests, after every `move`, `set at=` and group offset: the painter's own resolved box, in whole canvas units
 * of the scene's canvas, in WORLD coordinates (a part of a group is where it is on the canvas, not where it is inside its group).
 */
export interface PlacedBox {
  readonly id: string;
  readonly kind: ElementKind;
  /** the id of the group it is a part of, or null */
  readonly parent: string | null;
  readonly box: CanvasBox;
  /** a connector's drawn route, in the same world units, when it is routed by a structure engine (its box is the route's bounds) */
  readonly route?: readonly { readonly x: number; readonly y: number }[];
}

/** How one turn landed. Part of the painter's report. */
export interface Sight {
  readonly canvas: CanvasName;
  /** the share of the screen's area the canvas covered, 0..1: how much room a picture really had */
  readonly coverage: number;
  /** everything the turn showed, in the order it appeared, at most 60; text items carry no words here (the report's `shown` has them) */
  readonly items: readonly SightItem[];
  /** true when a picture of the resting stage was captured and sent separately */
  readonly snapshot: boolean;
}

export const NO_SIGHT: Sight = { canvas: 'wide', coverage: 1, items: [], snapshot: false };

/** The most items a report lists; a busier turn lists the ones with notes first, then the newest. */
export const SIGHT_ITEMS = 60;

/** A box as the brief prints it, the way everything else is printed: size, then the centre. */
function boxText(box: CanvasBox): string {
  return `${Math.round(box.w)}x${Math.round(box.h)} at ${Math.round(box.x + box.w / 2)},${Math.round(box.y + box.h / 2)}`;
}

const SHOWN_NOTED = 12;

/**
 * Sight as the brain reads it: one line per thing that did not land as
 * written, and one line that says how much landed cleanly. A turn with
 * nothing to report is one short line, not a table.
 */
export function describeSight(sight: Sight): string[] {
  const out: string[] = [];
  const noted = sight.items.filter((item) => item.notes.length > 0);
  for (const item of noted.slice(0, SHOWN_NOTED)) out.push(`${item.id} (${item.kind}), ${boxText(item.box)}: ${item.notes.map((note) => noteText(item, note)).join('; ')}`);
  if (noted.length > SHOWN_NOTED) out.push(`and ${noted.length - SHOWN_NOTED} more things with something to report`);
  const clean = sight.items.length - noted.length;
  if (sight.items.length > 0) out.push(noted.length === 0 ? `all ${sight.items.length} things landed as written` : `${clean} other things landed as written`);
  if (sight.coverage < 0.6) out.push(`the ${sight.canvas} canvas only covered ${Math.round(sight.coverage * 100)}% of this screen`);
  return out;
}
