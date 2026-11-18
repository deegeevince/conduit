// The census: the data under a frame. What is on the stage at one moment, as boxes, words, sizes and ink, read from the painter's own
// views and plan and from the resting picture. Pure: no DOM, no clock. The invariants (invariants.ts) are rules over it.
// Report-only: it describes today's frames; it changes none.

import type { ElementKind } from '@conduit/language';
import type { StageElementView } from '../contracts/painter';
import type { Box } from '../contracts/space';
import type { StagePlanView } from '../contracts/stage-plan';
import type { CensusMoment } from '../../../language/src/loop';

/** A picture as pixels: RGBA, row by row, `scale` pixels per host CSS pixel. */
export interface Raster {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
  readonly scale: number;
}

/** What the script holds at a stop, as plain data: the settled stage's elements, with the little of a control the rules need. */
export interface Expected {
  readonly key: string;
  readonly id: string;
  readonly kind: ElementKind;
  /** a text's words, braces as written */
  readonly text: string;
  readonly struck: boolean;
  readonly control: null | { readonly kind: string; readonly min: number; readonly max: number; readonly step: number | null; readonly options: readonly string[] };
}

export interface Screen {
  readonly width: number;
  readonly height: number;
  readonly pointer: 'fine' | 'coarse';
  /** who it is for: raises the legibility floor and the target (`audienceBar`); absent is the adult's */
  readonly audience?: import('./contracts').Audience;
}

export interface CensusInput {
  readonly at: CensusMoment;
  readonly views: readonly StageElementView[];
  readonly plan: StagePlanView | null;
  readonly screen: Screen;
  /** what the script holds here; null at a tick of play, where nothing is promised yet */
  readonly expected: readonly Expected[] | null;
  readonly raster: Raster | null;
}

export interface Leaf {
  readonly key: string;
  readonly id: string;
  readonly kind: ElementKind;
  readonly text: string;
  readonly box: Box;
  readonly fontPx: number;
  readonly contrast: number;
  readonly opacity: number;
  readonly phase: StageElementView['phase'];
  readonly tappable: boolean;
  readonly layer: StageElementView['layer'];
  /** wholly inside the scene's picture: the brain placed it by coordinates, so an overlap there is its to answer for */
  readonly inCanvas: boolean;
  /** share of the box that is not the ground, 0..1; null with no picture */
  readonly ink: number | null;
}

export interface Census {
  readonly at: CensusMoment;
  readonly screen: Screen;
  readonly leaves: readonly Leaf[];
  readonly expected: readonly Expected[] | null;
  readonly plan: StagePlanView | null;
  readonly digest: string;
}

/** Elements that put ink on the stage: a leaf the script holds must show. A group, a connector and the weather draw nothing of their own to find. */
export const INKED_KINDS: readonly ElementKind[] = ['text', 'shape', 'sprite', 'picture', 'structure', 'node', 'control'];
/** The ones whose ink is read in the picture. A shape may be meant to be faint, so it is held to its box and opacity only. */
export const PICTURED_KINDS: readonly ElementKind[] = ['text', 'picture', 'structure', 'node', 'control'];

const area = (box: Box): number => Math.max(0, box.width) * Math.max(0, box.height);

export function intersection(a: Box, b: Box): Box | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

const contains = (outer: Box, inner: Box, slack: number): boolean => inner.x >= outer.x - slack && inner.y >= outer.y - slack && inner.x + inner.width <= outer.x + outer.width + slack && inner.y + inner.height <= outer.y + outer.height + slack;

/** The ground: the commonest colour of the picture, found on a coarse grid at 4 bits a channel. A plate or a fill is then ink, as it should be. */
export function groundOf(raster: Raster): readonly [number, number, number] {
  const counts = new Map<number, number>();
  const stepX = Math.max(1, Math.floor(raster.width / 96));
  const stepY = Math.max(1, Math.floor(raster.height / 96));
  for (let y = 0; y < raster.height; y += stepY) {
    for (let x = 0; x < raster.width; x += stepX) {
      const at = (y * raster.width + x) * 4;
      const key = ((raster.data[at] ?? 0) >> 4) * 256 + ((raster.data[at + 1] ?? 0) >> 4) * 16 + ((raster.data[at + 2] ?? 0) >> 4);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  let best = 0;
  let bestCount = -1;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return [((best >> 8) & 15) * 16 + 8, ((best >> 4) & 15) * 16 + 8, (best & 15) * 16 + 8];
}

/** Share of a box's pixels that differ from the ground by more than a visible step. */
export function inkIn(raster: Raster, ground: readonly [number, number, number], box: Box): number {
  const x0 = Math.max(0, Math.floor(box.x * raster.scale));
  const y0 = Math.max(0, Math.floor(box.y * raster.scale));
  const x1 = Math.min(raster.width, Math.ceil((box.x + box.width) * raster.scale));
  const y1 = Math.min(raster.height, Math.ceil((box.y + box.height) * raster.scale));
  if (x1 <= x0 || y1 <= y0) return 0;
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 4000)));
  let seen = 0;
  let inked = 0;
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const at = (y * raster.width + x) * 4;
      const distance = Math.abs((raster.data[at] ?? 0) - ground[0]) + Math.abs((raster.data[at + 1] ?? 0) - ground[1]) + Math.abs((raster.data[at + 2] ?? 0) - ground[2]);
      seen += 1;
      if (distance > 48) inked += 1;
    }
  }
  return seen === 0 ? 0 : inked / seen;
}

function digestOf(leaves: readonly Leaf[]): string {
  let hash = 2166136261;
  for (const leaf of leaves) {
    const text = `${leaf.key}|${leaf.kind}|${leaf.text}|${Math.round(leaf.box.x)},${Math.round(leaf.box.y)},${Math.round(leaf.box.width)},${Math.round(leaf.box.height)}|${leaf.opacity > 0.5 ? 1 : 0}\n`;
    for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** The census of one moment. Views that are all but transparent are not on the stage and are left out, as the HUD leaves them out. */
export function takeCensus(input: CensusInput): Census {
  const ground = input.raster === null ? null : groundOf(input.raster);
  const picture = input.plan?.picture ?? null;
  const leaves = input.views
    .filter((view) => view.opacity > 0.02)
    .map((view): Leaf => ({
      key: view.key,
      id: view.id,
      kind: view.kind,
      text: view.text,
      box: view.box,
      fontPx: view.fontPx,
      contrast: view.contrast,
      opacity: view.opacity,
      phase: view.phase,
      tappable: view.tappable,
      layer: view.layer,
      inCanvas: picture !== null && area(view.box) > 0 && contains(picture, view.box, 1),
      ink: input.raster === null || ground === null || !PICTURED_KINDS.includes(view.kind) || area(view.box) < 16 ? null : inkIn(input.raster, ground, view.box),
    }));
  return { at: input.at, screen: input.screen, leaves, expected: input.expected, plan: input.plan, digest: digestOf(leaves) };
}
