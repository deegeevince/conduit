// Sight: what the painter tells the brain about how its last answer actually
// landed. The brain writes blind; this is the one place it is told what the
// canvas did with its lines. It is small on purpose: a brain reads it at the
// start of every turn, so every field has to earn its tokens.

import type { CanvasBox } from './types';
import type { CanvasName, ElementKind } from './vocabulary';

/** Something about an element's landing the brain would want to know, because it would have written the line differently. */
export const SIGHT_NOTE = {
  clipped: 'part of it fell outside the screen',
  'off-canvas': 'none of it was on screen',
  covered: 'something drawn later hides most of it',
  overlaps: 'it sits on top of text',
  shrunk: 'it was made smaller to fit',
  wrapped: 'it broke over more lines than is comfortable',
  recoloured: 'its colour was changed to stay readable',
  collides: 'its words run into other words',
  crossed: 'a drawn line runs through its words',
  crowded: 'there were too many parts for the room, so they came out small: give the structure the whole scene, or split it in two',
  faint: 'it is hard to read against what is behind it',
  tiny: 'it came out too small to make out',
  partial: 'the answer stopped while it was still arriving',
  painted: 'the painting arrived and replaced the sketch',
  unpainted: 'no painting arrived; the sketch is what was seen',
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
  for (const item of noted.slice(0, SHOWN_NOTED)) out.push(`${item.id} (${item.kind}), ${boxText(item.box)}: ${item.notes.map((note) => SIGHT_NOTE[note]).join('; ')}`);
  if (noted.length > SHOWN_NOTED) out.push(`and ${noted.length - SHOWN_NOTED} more things with something to report`);
  const clean = sight.items.length - noted.length;
  if (sight.items.length > 0) out.push(noted.length === 0 ? `all ${sight.items.length} things landed as written` : `${clean} other things landed as written`);
  if (sight.coverage < 0.6) out.push(`the ${sight.canvas} canvas only covered ${Math.round(sight.coverage * 100)}% of this screen`);
  return out;
}
