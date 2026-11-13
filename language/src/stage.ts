import { boundsOf } from './geometry';
import { figureAt, isStruckAt, lookAt, sceneAt, styleAt, valueAt, wearingAt } from './schedule';
import type { CarriedElement, ElementSpan, Figure, Schedule, StageBase } from './schedule';
import type { CanvasBox } from './types';
import type { ElementKind } from './vocabulary';

/** One thing the user actually saw during a turn. */
export interface ShownItem {
  readonly id: string;
  readonly kind: ElementKind;
  /** the words, for text; for anything drawn, a few words saying what it is (`circle 18 wide`, `sprite 8x6`, `painting: a lighthouse at dusk`) */
  readonly text: string;
  /** it was visibly corrected afterwards; the replacement is a later item with the same id */
  readonly struck: boolean;
  /** its entrance had started but not finished when the turn stopped */
  readonly partial: boolean;
  /** it is a part of a group: the transcript names the group and leaves its parts out */
  readonly part?: boolean;
}

function hasEntered(element: ElementSpan, at: number): boolean {
  return element.carried || (element.enter !== null && element.enter.start < at);
}

function hasLeft(element: ElementSpan, at: number): boolean {
  if (element.exit === null) return false;
  // A line meant to leave once read (`stay=beat`, `stay=Ns`) was read by the time the next turn begins, even if the turn was cut short before its exit.
  return element.exit.start <= at || element.exit.cause === 'stay';
}

function round(value: number): number {
  return Math.round(value);
}

/** A drawn thing in a few words, for memory and the transcript: enough to know what was there, not enough to redraw it. `box` is where it really rests, when known. */
export function describeFigure(figure: Figure, box: CanvasBox | null = null): string {
  switch (figure.kind) {
    case 'shape': {
      const where = box ?? boundsOf(figure.geometry);
      return `${figure.geometry.shape} ${round(where.w)}x${round(where.h)} at ${round(where.x + where.w / 2)},${round(where.y + where.h / 2)}`;
    }
    case 'sprite': {
      const rows = figure.sprite.frames[0] ?? [];
      const width = rows.reduce((max, row) => Math.max(max, row.cells.length), 0);
      const frames = figure.sprite.frames.length;
      const size = `sprite ${width}x${rows.length}${frames > 1 ? `, ${frames} frames` : ''}`;
      return box === null ? size : `${size} at ${round(box.x + box.w / 2)},${round(box.y + box.h / 2)}`;
    }
    case 'group':
      return box === null ? 'group' : `group ${round(box.w)}x${round(box.h)} at ${round(box.x + box.w / 2)},${round(box.y + box.h / 2)}`;
    case 'copy':
      return `copy of ${figure.source.split('@')[0] ?? figure.source}`;
    case 'picture':
      return `painting: ${figure.prompt}`;
    case 'field':
      return `${figure.field}, ${figure.amount}`;
  }
}

function union(boxes: readonly CanvasBox[]): CanvasBox | null {
  if (boxes.length === 0) return null;
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.w));
  const bottom = Math.max(...boxes.map((box) => box.y + box.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/**
 * Where a carried thing rests, in canvas units of the scene's canvas, worked out
 * from its lines alone: its own bounds, turned to the place `at=` or `move` sent
 * it and the scale `set` gave it, and a part of a group measured from the
 * group's own place. The painter's own boxes are better and win when they exist
 * (`placed`); this is what the brief uses when the painter said nothing.
 */
export function restingBox(element: CarriedElement, all: readonly CarriedElement[], depth = 0): CanvasBox | null {
  if (element.placed !== undefined) return element.placed;
  const { figure, style } = element;
  if (figure === null || depth > 4) return null;
  const scale = style.scale ?? 1;
  const at = typeof style.at === 'object' && style.at !== null ? style.at : null;
  let natural: CanvasBox | null = null;
  let parts = false;
  if (figure.kind === 'shape') natural = boundsOf(figure.geometry);
  else if (figure.kind === 'copy' && at !== null) {
    const source = all.find((other) => other.key === figure.source);
    natural = source === undefined ? null : restingBox({ ...source, style: { ...source.style, at: null, scale: null }, parent: null }, all, depth + 1);
  } else if (figure.kind === 'group') {
    const children = all.filter((other) => other.parent === element.key && other.kind !== 'text').map((other) => restingBox({ ...other, parent: null }, all, depth + 1));
    natural = union(children.filter((box): box is CanvasBox => box !== null));
    parts = true;
  } else if (figure.kind === 'sprite' && style.scale !== null && at !== null) {
    const rows = figure.sprite.frames[0] ?? [];
    const width = rows.reduce((max, row) => Math.max(max, row.cells.length), 0);
    natural = { x: 0, y: 0, w: width * style.scale, h: rows.length * style.scale };
  } else return null;
  if (natural === null) return null;
  // A group's parts measure from the group's place, so the group's box is its parts' box moved by it.
  const origin = parts && at !== null ? at : { x: 0, y: 0 };
  const w = natural.w * (parts ? 1 : scale);
  const h = natural.h * (parts ? 1 : scale);
  const centre = parts ? { x: origin.x + natural.x + natural.w / 2, y: origin.y + natural.y + natural.h / 2 } : at ?? { x: natural.x + natural.w / 2, y: natural.y + natural.h / 2 };
  const world: CanvasBox = { x: centre.x - w / 2, y: centre.y - h / 2, w, h };
  if (element.parent === null) return world;
  const group = all.find((other) => other.key === element.parent);
  const groupAt = group !== undefined && typeof group.style.at === 'object' && group.style.at !== null ? group.style.at : { x: 0, y: 0 };
  return { x: world.x + groupAt.x, y: world.y + groupAt.y, w: world.w, h: world.h };
}

/** A carried thing as the brief names it: the words, or what is drawn and where it really rests. `known` is a box the painter reported for it, when the element carries none. */
export function describeCarried(element: CarriedElement, all: readonly CarriedElement[], known: CanvasBox | null = null): string {
  if (element.figure === null) return element.text;
  return describeFigure(element.figure, known ?? restingBox(element, all));
}

/**
 * What the turn showed up to `at`, in the order it appeared. An element whose
 * entrance has begun counts as shown: on interruption the painter completes
 * entrances already in flight rather than leaving half a word on screen.
 */
export function shownAt(schedule: Schedule, at: number): ShownItem[] {
  return schedule.elements
    .filter((element) => !element.carried && element.enter !== null && element.enter.start < at)
    .sort((a, b) => (a.enter?.start ?? 0) - (b.enter?.start ?? 0))
    .map((element) => {
      const figure = figureAt(element, at);
      const parts = element.kind === 'group' ? schedule.elements.filter((other) => other.parent === element.key && other.enter !== null && other.enter.start < at).length : 0;
      return {
        id: element.id,
        kind: element.kind,
        text: element.kind === 'group' ? `group of ${parts} part${parts === 1 ? '' : 's'}` : figure === null ? element.text : describeFigure(figure),
        struck: isStruckAt(element, at),
        partial: element.enter !== null && element.enter.end > at,
        ...(element.parent !== null && element.kind !== 'text' && { part: true }),
      };
    });
}

/** The stage as it rests at `at`: the base the next turn starts from. Exits in flight are treated as complete, and so are entrances. */
export function settle(schedule: Schedule, base: StageBase, at: number): StageBase {
  const scene = sceneAt(schedule, at);
  const elements: CarriedElement[] = schedule.elements
    .filter((element) => hasEntered(element, at) && !hasLeft(element, at))
    .map((element) => {
      // A sprite caught half-drawn rests whole: every row that was written is carried.
      const figure = element.figure?.kind === 'sprite' ? element.figure : figureAt(element, at);
      const carried: Figure | null =
        figure?.kind === 'sprite' ? { kind: 'sprite', sprite: { ...figure.sprite, frames: figure.sprite.frames.map((rows) => rows.map((row) => ({ cells: row.cells, at: 0 }))) } } : figure;
      return {
        key: element.key,
        id: element.id,
        kind: element.kind,
        order: element.order,
        scene: element.scene,
        text: element.text,
        emphasis: element.emphasis,
        style: styleAt(element, at),
        figure: carried,
        parent: element.parent,
        struck: isStruckAt(element, at),
        replaces: element.replaces,
      };
    });
  return {
    look: lookAt(schedule, base, at),
    lookName: wearingAt(schedule, base, at).name,
    scene: {
      id: scene.id,
      index: scene.index,
      layout: scene.layout,
      canvas: scene.canvas,
      align: scene.align,
      mood: valueAt(scene.mood, at, base.scene.mood),
      pace: valueAt(scene.pace, at, base.scene.pace),
      expected: valueAt(scene.expected, at, null),
    },
    styles: schedule.styles,
    colors: schedule.colors,
    looks: schedule.lookDefs,
    elements,
  };
}

/** Shown things as plain lines, for memory and for the transcript. Struck text is wrapped in ~~tildes~~; drawn things are in [brackets]. */
export function transcriptOf(shown: readonly ShownItem[]): string {
  return shown
    .filter((item) => item.part !== true)
    .map((item) => (item.kind === 'text' ? (item.struck ? `~~${item.text}~~` : item.text) : `[${item.id}: ${item.text}]`))
    .join('\n');
}
