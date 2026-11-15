import { readFigure } from './figure';
import { holdControl } from './bind';
import { boundsOf } from './geometry';
import { figureAt, isStruckAt, lookAt, sceneAt, styleAt, valueAt, wearingAt } from './schedule';
import type { CarriedElement, ElementSpan, Figure, Schedule, StageBase } from './schedule';
import type { CanvasBox, ControlValues } from './types';
import type { ElementKind } from './vocabulary';
import { cachedTune, describeTune, tuneRowsOf } from './tune';

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
    case 'group': {
      const name = figure.card === undefined ? 'group' : figure.card.title === '' ? 'card' : `card "${figure.card.title}"`;
      return box === null ? name : `${name} ${round(box.w)}x${round(box.h)} at ${round(box.x + box.w / 2)},${round(box.y + box.h / 2)}`;
    }
    case 'structure': {
      if (figure.structure === 'code') return describeCode(figure);
      if (figure.structure === 'app') return describeApp(figure);
      if (figure.structure === 'screen') {
        // a mock-up is named by its screens and what each holds, not recited: the brain changes it by writing it again
        const screens = figure.rows.map((row) => /^screen\s+(\S+)\s+(\S+)[^|]*(?:\|\s*(.*))?$/.exec(row.cells[0] ?? '')).filter((m): m is RegExpExecArray => m !== null);
        const parts = figure.rows.filter((row) => !/^(screen|end)\b/.test(row.cells[0] ?? '')).length;
        return `mock-up of ${screens.length} screen${screens.length === 1 ? '' : 's'} (${screens.map((m) => `${m[1] ?? ''} ${m[2] ?? ''}${m[3] === undefined || m[3] === '' ? '' : ` "${m[3]}"`}`).join(', ')}), ${parts} parts`;
      }
      if (figure.structure === 'figure') {
        const read = readFigure('', '', figure.mode ?? 'plain', figure.rows.map((row) => row.cells[0] ?? ''));
        const named = read.input.parts.flatMap((part) => (part.label === undefined ? [] : [part.label]));
        return `figure of ${read.input.parts.length} parts${named.length === 0 ? '' : ` (labelled ${named.join(', ')})`}${read.input.steps.length === 0 ? '' : `, ${read.input.steps.length} steps`}`;
      }
      if (figure.structure === 'tune') return describeTune(cachedTune(tuneRowsOf(figure.rows), { tempo: figure.tempo ?? null }), figure.rows.length);
      const name = figure.chart === null ? figure.structure : [...figure.words, `${figure.chart} chart`].join(' ');
      if (figure.data !== null) return `${name} of DATA ${figure.data}`;
      if (figure.dataset !== undefined && figure.dataset !== null) {
        const { dataset } = figure;
        return `${name} of the stored dataset ${dataset.name}${dataset.instrument === undefined ? '' : `, ${dataset.instrument}`}${dataset.field === undefined ? '' : `, ${dataset.field}`}`;
      }
      if (figure.rows.length === 0) return name;
      // A chart of many points is named by its first and last, not recited.
      const rows = figure.rows.length > 8 ? [...figure.rows.slice(0, 2), { cells: [`… ${figure.rows.length - 3} more …`] }, ...figure.rows.slice(-1)] : figure.rows;
      return `${name}: ${rows.map((row) => row.cells.join(' | ')).join(' / ')}`;
    }
    case 'node':
      // A mark on a chart says where; a pin on a map, a date on a timeline, a span: their numbers.
      if (figure.x !== undefined || figure.y !== undefined) return figure.x !== undefined && figure.y !== undefined ? `mark at ${figure.x}, ${figure.y}` : figure.x !== undefined ? `mark at ${figure.x}` : `mark at level ${String(figure.y)}`;
      return figure.values.length === 0 ? `${figure.shape} node` : `node at ${figure.values.map(round).join(figure.values.length === 2 ? ',' : ' ')}`;
    case 'link':
      return `link ${figure.from.split('@')[0] ?? figure.from} to ${figure.to.split('@')[0] ?? figure.to}`;
    case 'control': {
      // HI1. An ask of the stage: what it is and what the person holds in it; never what it accepts (the page compares, the brain's own `is=` is in its lines)
      if (figure.ask !== undefined) {
        const kind = figure.ask.check === 'any' ? 'a choice with no single answer' : figure.ask.check === 'done' ? 'a tick' : figure.options.length > 0 ? `picks ${figure.options.join(' | ')}` : figure.ask.blank ? 'typed in a blank' : 'typed';
        return `ask ${figure.ask.n} (${kind}${figure.ask.hints.length > 0 ? `, ${figure.ask.hints.length} hint${figure.ask.hints.length === 1 ? '' : 's'}` : ''})${typeof figure.value === 'string' && figure.value !== '' ? `, holding "${figure.value}"` : ''}`;
      }
      if (figure.control === 'slider') return `slider ${figure.min} to ${figure.max}, at ${String(figure.value ?? figure.min)}${figure.unit ?? ''}`;
      if (figure.control === 'toggle') return `toggle, ${figure.value === true ? 'on' : 'off'}`;
      if (figure.control === 'pick') return `pick of ${figure.options.join(' | ')}, on ${figure.options[Number(figure.value ?? 1) - 1] ?? ''}`;
      if (figure.control === 'input') return `input${figure.value === '' || figure.value === null ? '' : `, holding "${String(figure.value)}"`}`;
      return 'button';
    }
    case 'copy':
      return `copy of ${figure.source.split('@')[0] ?? figure.source}`;
    case 'picture':
      return figure.from === undefined || figure.from === null ? `painting: ${figure.prompt}` : `the user's picture ${figure.from}`;
    case 'field':
      return `${figure.field}, ${figure.amount}`;
  }
}

/** A block of code in a few words: what it is, how long, and how it begins. The source itself is in the conversation, not in the stage's memory. */
function describeCode(figure: Extract<Figure, { kind: 'structure' }>): string {
  const lines = figure.rows.map((row) => row.cells[0] ?? '');
  const language = figure.lang === undefined || figure.lang === null ? '' : ` ${figure.lang}`;
  const file = figure.file === undefined || figure.file === null ? '' : ` "${figure.file}"`;
  const begins = lines.filter((line) => line.trim() !== '').slice(0, 3).map((line) => (line.trim().length > 60 ? `${line.trim().slice(0, 59)}…` : line.trim()));
  return `code${language}${file}, ${lines.length} line${lines.length === 1 ? '' : 's'}${begins.length === 0 ? '' : `: ${begins.join(' / ')}${lines.filter((line) => line.trim() !== '').length > begins.length ? ' …' : ''}`}`;
}

/**
 * A live app is named by what it says on its face (headings, buttons) and how long it is, never recited. The brain changes it by writing the
 * whole app again under the same id; what the user has done in it comes back by `THE USER DID IN THE APP`.
 */
function describeApp(figure: Extract<Figure, { kind: 'structure' }>): string {
  const source = figure.rows.map((row) => row.cells[0] ?? '').join('\n');
  const words = (pattern: RegExp): string[] => {
    const found: string[] = [];
    for (const match of source.matchAll(pattern)) {
      const text = (match[1] ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      if (text !== '' && text.length <= 40 && !found.includes(text)) found.push(text);
      if (found.length >= 6) break;
    }
    return found;
  };
  const headings = words(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi);
  const buttons = words(/<button[^>]*>([\s\S]*?)<\/button>/gi);
  const say = [headings.length === 0 ? '' : `headings ${headings.map((text) => `"${text}"`).join(', ')}`, buttons.length === 0 ? '' : `buttons ${buttons.map((text) => `"${text}"`).join(', ')}`].filter((part) => part !== '');
  return `live app (HTML, CSS and JS in a locked sandbox), ${figure.rows.length} line${figure.rows.length === 1 ? '' : 's'}${say.length === 0 ? '' : `: ${say.join('; ')}`}`;
}

/** A node's words, with its date or span in front when it sits on a timeline, so the transcript says what the picture says. */
function nodeWords(figure: Figure | null, text: string, on: Figure): string {
  if (on.kind !== 'structure' || on.structure !== 'timeline' || figure?.kind !== 'node' || figure.values.length === 0 || figure.values.length > 2 || figure.x !== undefined) return text;
  return `${figure.values.map((value) => String(Number(value.toFixed(2)))).join('-')} ${text}`;
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

/**
 * A carried thing as the brief names it: the words, or what is drawn and where it really rests. `known` is a box the painter reported for it, when the element carries none.
 * A structure is named with the words of its nodes (they are left out of the brief as parts); a node, a link and a control with their own.
 */
export function describeCarried(element: CarriedElement, all: readonly CarriedElement[], known: CanvasBox | null = null): string {
  const { figure } = element;
  if (figure === null) return element.text;
  const said = describeFigure(figure, known ?? restingBox(element, all));
  if (figure.kind === 'structure') {
    const nodes = all.filter((other) => other.parent === element.key && other.kind === 'node' && other.text !== '');
    const title = element.text === '' ? '' : ` "${element.text}"`;
    // The ids of the arrows between nodes, so the brain can add to the diagram and point at what is there.
    const keyId = (key: string): string => key.split('@')[0] ?? key;
    const arrows = all.flatMap((other) => (other.parent === element.key && other.figure?.kind === 'link' ? [`${keyId(other.figure.from)}>${keyId(other.figure.to)}${other.text === '' ? '' : ` ${other.text}`}`] : []));
    const joined = arrows.length > 12 ? `${arrows.slice(0, 12).join(', ')}, … ${arrows.length - 12} more` : arrows.join(', ');
    const parts = nodes.length === 0 ? '' : `: ${nodes.map((node) => `${node.id} ${nodeWords(node.figure, node.text, figure)}`).join(' / ')}`;
    return `${said}${title}${parts}${arrows.length === 0 ? '' : ` (links ${joined})`}`;
  }
  if (figure.kind === 'node' || figure.kind === 'link' || figure.kind === 'control') return element.text === '' ? said : `${said}: ${element.text}`;
  return said;
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
        text: element.kind === 'group' ? `group of ${parts} part${parts === 1 ? '' : 's'}` : figure === null ? element.text : wordsOf(element, figure, schedule, at),
        struck: isStruckAt(element, at),
        partial: element.enter !== null && element.enter.end > at,
        ...(element.parent !== null && element.kind !== 'text' && { part: true }),
      };
    });
}

/**
 * A drawn thing that carries words, as the transcript and the brain's memory
 * name it. A structure is named with the words of its nodes, because they are
 * its content and its nodes are left out of the transcript as parts; a node, a
 * link and a control are named with their own words.
 */
function wordsOf(element: ElementSpan, figure: Figure, schedule: Schedule, at: number): string {
  const said = describeFigure(figure);
  if (figure.kind === 'structure') {
    const nodes = schedule.elements.filter((other) => other.parent === element.key && other.kind === 'node' && other.enter !== null && other.enter.start < at && other.text !== '');
    const title = element.text === '' ? '' : ` "${element.text}"`;
    return nodes.length === 0 ? `${said}${title}` : `${said}${title}: ${nodes.map((node) => nodeWords(node.figure, node.text, figure)).join(' / ')}`;
  }
  if (figure.kind === 'node' || figure.kind === 'link' || figure.kind === 'control') return element.text === '' ? said : `${said}: ${element.text}`;
  return said;
}

/**
 * The stage as it rests at `at`: the base the next turn starts from. Exits in
 * flight are treated as complete, and so are entrances. `controls` is what the
 * user has set, by control id, as the painter reports it: a control rests at
 * that value (kept to what it can hold), not at the one it was written with.
 * Changes a control drives are carried while the control and the thing it
 * changes both stay.
 */
export function settle(schedule: Schedule, base: StageBase, at: number, controls: ControlValues = {}): StageBase {
  const scene = sceneAt(schedule, at);
  const staying = schedule.elements.filter((element) => hasEntered(element, at) && !hasLeft(element, at));
  const stayingKeys = new Set(staying.map((element) => element.key));
  const elements: CarriedElement[] = staying.map((element) => {
    // A sprite caught half-drawn rests whole: every row that was written is carried.
    const figure = element.figure?.kind === 'sprite' ? element.figure : figureAt(element, at);
    // A table or a chart caught half-written rests whole too.
    const whole = element.figure?.kind === 'structure' ? element.figure : figure;
    const held = whole?.kind === 'control' ? holdControl(whole, controls[element.id]) : null;
    const carried: Figure | null =
      whole?.kind === 'sprite'
        ? { kind: 'sprite', sprite: { ...whole.sprite, frames: whole.sprite.frames.map((rows) => rows.map((row) => ({ cells: row.cells, at: 0 }))) } }
        : whole?.kind === 'structure'
          ? { ...whole, rows: whole.rows.map((row) => ({ cells: row.cells, at: 0 })) }
          : whole?.kind === 'control' && held !== null
            ? { ...whole, value: held }
            : whole;
    const driven = element.driven.filter((change) => stayingKeys.has(change.control) && (change.until === undefined || change.until > at));
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
      ...(element.href !== undefined && { href: element.href }),
      ...(driven.length > 0 && { driven: driven.map(({ until: _until, ...change }) => ({ ...change, since: 0 })) }),
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
