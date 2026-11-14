// The frame of a `card`: a framed group for controls and what they change.
// The painter hands in the box of the card's parts; the frame is laid round
// it with room for the title, which sits on the top edge on a plate.

import type { BlockLook, BlockPart, TextMeasure, TextSpec } from '../../contracts/blocks';
import type { Box } from '../../contracts/space';
import { rectLine, shapePart, textPart } from './shapes';

const TITLE: TextSpec = { size: 's', weight: 'bold', face: null, letterCase: 'asis', shrink: 1 };

export interface CardInput {
  /** the card's key */
  readonly owner: string;
  readonly title: string;
  /** the box of its parts, stage units */
  readonly inner: Box;
  readonly measure: TextMeasure;
  readonly look: BlockLook;
  /** true when pointer or focus is in the card: the frame goes from `dim` to `ink` */
  readonly lit?: boolean;
}

export interface CardLayout {
  /** the frame, round the parts and their padding */
  readonly outer: Box;
  /** a frame (`grid`, or `frame` when lit) and its title; the plate under the title is in `plate` */
  readonly parts: readonly BlockPart[];
}

export function layoutCard(input: CardInput): CardLayout {
  const { look, inner } = input;
  const pad = look.grid !== null ? look.grid.cell.width * 2 : Math.round(look.body * 0.8);
  const rowH = look.grid !== null ? look.grid.cell.height : Math.round(look.body * 1.3);
  const title = input.title === '' ? null : input.measure(input.title, TITLE, Math.max(rowH, inner.width + 2 * pad - 2 * pad));
  const head = title === null ? 0 : Math.ceil(title.height / 2);
  const outer: Box = { x: inner.x - pad, y: inner.y - pad - head, width: inner.width + 2 * pad, height: inner.height + 2 * pad + head };
  const parts: BlockPart[] = [shapePart(input.owner, 'frame', input.lit === true ? 'frame' : 'grid', [rectLine(outer, look.radius)])];
  if (title !== null) {
    const width = Math.min(outer.width - 2 * pad, title.width);
    const box: Box = { x: outer.x + pad, y: outer.y - title.height / 2, width, height: title.height };
    parts.push(textPart(input.owner, 'title', 'title', input.title, box, TITLE, 'left', true));
  }
  return { outer, parts };
}
