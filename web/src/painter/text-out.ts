// Text out (PLAN-v2.1 A2/T2): the words on the stage, as the chrome's text layer needs them. The renderer draws them in WebGL, where they cannot be
// selected, copied or read; this says where each wrapped line is on the screen, what it says and what it is, so that a layer of real text can
// lie over the picture. Pure: a frame and its schedule in, spans out. It reads the same `ElementFrame`s the renderer draws (structure parts and
// mock-up text included, they are frames too) and projects them through the frame's own camera, as the vector exporter does.

import type { ElementSpan, Schedule } from '@conduit/language';
import type { ElementFrame, Frame } from '../contracts/frame';
import type { Box, Viewport } from '../contracts/space';
import { layerZ, projectToScreen } from '../contracts/space';
import { ownerKeyOf } from '../contracts/text-layer';
import type { TextAsk, TextLine, TextRole, TextSpanView } from '../contracts/text-layer';
import { FACES } from '../fonts/faces';

/** a run closer to the one before than this share of the font size is the same word (emphasis splits a word, it never leaves a gap) */
const WORD_GAP = 0.12;
/** below this, an element is not on the stage to be read */
const FADED = 0.08;

const byKey = new WeakMap<Schedule, ReadonlyMap<string, ElementSpan>>();

function spansOf(schedule: Schedule): ReadonlyMap<string, ElementSpan> {
  let found = byKey.get(schedule);
  if (found === undefined) {
    found = new Map(schedule.elements.map((span) => [span.key, span]));
    byKey.set(schedule, found);
  }
  return found;
}

const family = (element: ElementFrame): string => {
  const spec = FACES[element.face];
  if (spec.pitch === 'fixed') return 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
  return element.face === 'serif' ? 'Georgia, "Times New Roman", serif' : 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
};

interface Placed {
  readonly line: TextLine;
  readonly centre: { readonly x: number; readonly y: number };
  readonly angle: number;
  /** screen pixels to one unit of the element's own text */
  readonly unit: number;
}

/** Where one wrapped line is on the screen: the drawn glyphs' stretch from the first run to the last, through the frame's camera. */
function placeLine(element: ElementFrame, frame: Frame, box: Box, runs: readonly { readonly text: string; readonly x: number; readonly width: number }[], text: string): Placed | null {
  const first = runs[0];
  const last = runs[runs.length - 1];
  if (first === undefined || last === undefined) return null;
  const z = layerZ(element.layer, frame.viewport);
  const cos = Math.cos(element.rotation) * element.scale;
  const sin = Math.sin(element.rotation) * element.scale;
  const at = (lx: number, ly: number): { x: number; y: number; scale: number } => projectToScreen({ x: element.x + lx * cos - ly * sin, y: element.y + lx * sin + ly * cos, z }, frame.camera, frame.viewport);
  const ly = box.y + box.height / 2;
  const a = at(first.x, ly);
  const b = at(last.x + last.width, ly);
  const width = Math.hypot(b.x - a.x, b.y - a.y);
  const unit = element.scale * ((a.scale + b.scale) / 2);
  const height = box.height * unit;
  const centre = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  return { line: { text, box: { x: centre.x - width / 2, y: centre.y - height / 2, width, height } }, centre, angle: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI, unit };
}

/** The wrapped lines of an element with the words on each, in reading order. */
function linesOf(element: ElementFrame): { readonly box: Box; readonly runs: readonly { readonly text: string; readonly x: number; readonly width: number }[]; readonly text: string }[] {
  const boxes = element.lines;
  if (boxes.length === 0) return [];
  const rows = boxes.map(() => [] as { text: string; x: number; width: number }[]);
  for (const run of element.runs) {
    if (run.text === '' || run.opacity * element.opacity < FADED * 0.5 || run.reveal <= 0.001) continue;
    let best = 0;
    let bestGap = Number.POSITIVE_INFINITY;
    boxes.forEach((box, index) => {
      const mid = run.y + box.height / 2;
      const gap = mid >= box.y && mid <= box.y + box.height ? 0 : Math.min(Math.abs(mid - box.y), Math.abs(mid - (box.y + box.height)));
      if (gap < bestGap - 1e-6) {
        best = index;
        bestGap = gap;
      }
    });
    const shown = run.reveal >= 0.999 ? run.text : run.text.slice(0, Math.max(1, Math.ceil(run.text.length * run.reveal)));
    rows[best]?.push({ text: shown, x: run.x, width: run.width * Math.min(1, run.reveal) });
  }
  const out: { box: Box; runs: { text: string; x: number; width: number }[]; text: string }[] = [];
  boxes.forEach((box, index) => {
    const runs = (rows[index] ?? []).sort((p, q) => p.x - q.x);
    if (runs.length === 0) return;
    let text = '';
    let end = Number.NEGATIVE_INFINITY;
    for (const run of runs) {
      if (text !== '' && run.x - end > element.fontSize * WORD_GAP) text += ' ';
      text += run.text;
      end = run.x + run.width;
    }
    out.push({ box, runs, text });
  });
  return out;
}

const HEADING_LEVEL: Readonly<Record<string, number>> = { xxl: 1, xl: 2 };

const partOf = (key: string): string => (key.includes('/') ? key.slice(key.indexOf('/') + 1) : '');

/** A figure sets each line of a part's label as an element of its own: `<figure>/label:<part>:<line>` */
const FIGURE_LABEL = /(?:^|\/)label:(.+):(\d+)$/;

/**
 * fb-055. Whether a tap on these words asks about what they label, and what they label. Only the words the brain set against something drawn count: text with
 * `near=` (a `say label near=x`, a `say callout near=x`), a callout with a leader (`say callout at=x,y`), a figure part's `label=`. Never a choice (that is
 * its own tap), a line of the flow, or a cell, a node or a mock-up's text: the drawn part itself is never the target, only its words (a tap anywhere on a big
 * drawn area would be a question nobody asked).
 */
function askOf(element: ElementFrame, owner: ElementSpan | undefined, structure: string | null, part: string, ownerKey: string): { readonly ask: Omit<TextAsk, 'label'>; readonly label: string | null; readonly index: number } | null {
  if (element.tappable || owner === undefined) return null;
  if (structure === 'figure') {
    const found = FIGURE_LABEL.exec(part);
    if (found === null || owner.figure?.kind !== 'structure') return null;
    return { ask: { id: found[1] as string, on: owner.id, group: `${ownerKey}/label:${found[1]}` }, label: null, index: Number(found[2]) };
  }
  if (part !== '' || owner.kind !== 'text' || owner.text.trim() === '' || owner.href !== undefined) return null;
  const near = owner.style.near;
  if ((near === null || near.part !== undefined) && owner.style.leader !== true) return null;
  return { ask: { id: owner.id, on: near === null ? null : near.id, group: ownerKey }, label: owner.text.replace(/\s+/g, ' ').trim(), index: 0 };
}

function roleOf(element: ElementFrame, owner: ElementSpan | undefined, parent: ElementSpan | undefined): { role: TextRole; level: number; within: TextSpanView['within']; structure: string | null; lang: string | null } {
  const part = partOf(element.key);
  const structureOf = (span: ElementSpan | undefined): ElementSpan | undefined => (span?.figure?.kind === 'structure' ? span : undefined);
  const home = structureOf(owner) ?? structureOf(parent);
  const structure = home?.figure?.kind === 'structure' ? home.figure.structure : null;
  const lang = home?.figure?.kind === 'structure' && home.figure.structure === 'code' ? (home.figure.lang ?? null) : null;
  if (element.tappable) return { role: 'choice', level: 0, within: null, structure, lang };
  const cell = /^(cell|head):(\d+):(\d+)$/.exec(part);
  if (cell !== null && home !== undefined) {
    const within = { key: home.key, row: Number(cell[2]), column: Number(cell[3]) };
    return { role: cell[1] === 'head' ? 'label' : 'cell', level: 0, within, structure, lang };
  }
  if (part === 'title') return { role: 'heading', level: 3, within: null, structure, lang };
  if (structure === 'code') return { role: 'code', level: 0, within: null, structure, lang };
  if (structure === 'screen') return { role: 'label', level: 0, within: null, structure, lang };
  if (owner?.kind === 'node') return { role: 'node', level: 0, within: parent === undefined ? null : { key: parent.key, row: 0, column: 0 }, structure, lang };
  if (part !== '' || owner?.kind === 'link') return { role: 'label', level: 0, within: home === undefined ? null : { key: home.key, row: -1, column: -1 }, structure, lang };
  if (owner !== undefined && owner.kind === 'text') {
    const size = owner.style.size;
    const level = HEADING_LEVEL[size] ?? 0;
    if (level > 0) return { role: 'heading', level, within: null, structure: null, lang: null };
    if (size === 's' || size === 'xs' || owner.style.ink === 'dim') return { role: 'aside', level: 0, within: null, structure: null, lang: null };
  }
  return { role: 'body', level: 0, within: null, structure, lang };
}

interface Draft {
  readonly span: Omit<TextSpanView, 'order'>;
  /** fb-055: set for the words of a label; `label` is null for a figure's, whose words are all the lines of its group */
  readonly asks?: { readonly ask: Omit<TextAsk, 'label'>; readonly label: string | null; readonly index: number };
  readonly ownerOrder: number;
  readonly ownerKey: string;
  readonly y: number;
  readonly x: number;
}

const inside = (viewport: Viewport, box: Box): boolean => box.x + box.width > -2 && box.y + box.height > -2 && box.x < viewport.width + 2 && box.y < viewport.height + 2;

/**
 * Every word on the stage at this frame, placed on the screen, in reading order. Words that are struck out, ghosts of what a correction
 * replaced, lines faded away, lines off the picture and anything a control owns (the access layer has those) are left out.
 */
export function textSpansOf(frame: Frame, schedule: Schedule): readonly TextSpanView[] {
  const owners = spansOf(schedule);
  const drafts: Draft[] = [];
  const drawnOwners = new Set<string>();
  for (const element of frame.elements) {
    if (element.ghost || element.opacity < FADED) continue;
    if (element.mark === 'strike' || element.strike >= 0.99) continue;
    const ownerKey = ownerKeyOf(element.key);
    const owner = owners.get(ownerKey);
    if (owner?.kind === 'control' || (owner?.parent != null && owners.get(owner.parent)?.kind === 'control')) continue;
    const parent = owner?.parent == null ? undefined : owners.get(owner.parent);
    const found = roleOf(element, owner, parent);
    const placed: Placed[] = [];
    for (const row of linesOf(element)) {
      const at = placeLine(element, frame, row.box, row.runs, row.text);
      if (at === null || !inside(frame.viewport, at.line.box)) continue;
      if (element.clip !== undefined) {
        const cx = element.x + (row.box.x + row.box.width / 2);
        const cy = element.y + (row.box.y + row.box.height / 2);
        if (cx < element.clip.x || cy < element.clip.y || cx > element.clip.x + element.clip.width || cy > element.clip.y + element.clip.height) continue;
      }
      placed.push(at);
    }
    if (placed.length === 0) continue;
    drawnOwners.add(ownerKey);
    const first = placed[0] as Placed;
    const text = placed.map((p) => p.line.text).join(found.role === 'code' ? '\n' : ' ');
    const asks = askOf(element, owner, found.structure, partOf(element.key), ownerKey);
    drafts.push({
      ...(asks === null ? {} : { asks }),
      ownerKey,
      ownerOrder: owner?.order ?? element.z,
      y: first.centre.y,
      x: first.line.box.x,
      span: {
        key: element.key,
        id: element.id,
        role: found.role,
        text,
        lines: placed.map((p) => p.line),
        fontPx: element.fontSize * first.unit,
        family: family(element),
        bold: element.weight === 'bold',
        rotation: first.angle,
        within: found.within,
        level: found.level,
        structure: found.structure,
        lang: found.lang,
        placed: true,
      },
    });
  }
  // Charts draw their own words in a canvas: their title and rows are the stage's words all the same, read and copied but not laid over the picture.
  for (const chart of frame.charts ?? []) {
    const owner = owners.get(chart.key);
    if (owner === undefined || chart.opacity < FADED || owner.figure?.kind !== 'structure' || drawnOwners.has(owner.key)) continue;
    const base = { id: owner.id, family: 'system-ui, sans-serif', bold: false, rotation: 0, fontPx: 0, lines: [] as TextLine[], structure: 'chart', lang: null, placed: false, level: 0 };
    if (owner.text !== '') drafts.push({ ownerKey: owner.key, ownerOrder: owner.order, y: -1, x: 0, span: { ...base, key: `${owner.key}/title`, role: 'heading', text: owner.text, within: null, level: 3 } });
    owner.figure.rows.forEach((row, r) =>
      row.cells.forEach((cell, c) => {
        if (cell !== '') drafts.push({ ownerKey: owner.key, ownerOrder: owner.order, y: r, x: c, span: { ...base, key: `${owner.key}/cell:${r}:${c}`, role: 'cell', text: cell, within: { key: owner.key, row: r, column: c } } });
      }),
    );
  }
  drafts.sort((a, b) => {
    if (a.ownerOrder !== b.ownerOrder) return a.ownerOrder - b.ownerOrder;
    if (a.ownerKey !== b.ownerKey) return a.ownerKey < b.ownerKey ? -1 : 1;
    const wa = a.span.within;
    const wb = b.span.within;
    if (wa !== null && wb !== null && a.span.role === b.span.role && (wa.row !== wb.row || wa.column !== wb.column)) return wa.row - wb.row || wa.column - wb.column;
    if (a.span.level > 0 && b.span.level === 0 && a.span.key.endsWith('/title')) return -1;
    if (b.span.level > 0 && a.span.level === 0 && b.span.key.endsWith('/title')) return 1;
    const band = Math.max(a.span.fontPx, b.span.fontPx, 1) * 0.6;
    if (Math.abs(a.y - b.y) > band) return a.y - b.y;
    return a.x - b.x;
  });
  // a figure's label is the lines of its words, together
  const lines = new Map<string, { index: number; text: string }[]>();
  for (const draft of drafts) if (draft.asks !== undefined && draft.asks.label === null) lines.set(draft.asks.ask.group, [...(lines.get(draft.asks.ask.group) ?? []), { index: draft.asks.index, text: draft.span.text }]);
  const wordsOf = (group: string): string =>
    (lines.get(group) ?? [])
      .sort((a, b) => a.index - b.index)
      .map((line) => line.text)
      .join(' ');
  return drafts.map((draft, order) => ({ ...draft.span, order, ...(draft.asks === undefined ? {} : { ask: { ...draft.asks.ask, label: draft.asks.label ?? wordsOf(draft.asks.ask.group) } }) }));
}

/** A signature of what the layer shows, to send it only when it changes. */
export function textSignature(spans: readonly TextSpanView[]): string {
  let out = '';
  for (const span of spans) {
    out += `${span.key}|${span.role}|${span.text}|`;
    for (const line of span.lines) out += `${Math.round(line.box.x)},${Math.round(line.box.y)},${Math.round(line.box.width)},${Math.round(line.box.height)};`;
    out += `|${Math.round(span.rotation)}${span.ask === undefined ? '' : `|${span.ask.group}`}\n`;
  }
  return out;
}
