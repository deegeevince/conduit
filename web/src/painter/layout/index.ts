import { isInFlow } from '@conduit/language';
import type { Align, Anchor, ElementStyle, Face, Layer, Layout, Point, Range, Size, Weight } from '@conduit/language';
import type { LookSpec } from '../../contracts/look';
import { foldText } from '../../fonts/fold';
import { FACES } from '../../fonts/faces';
import { measureEm, prefixEm } from '../../fonts/measure';
import { planeBounds, planeScale } from '../../contracts/space';
import type { Box, Viewport } from '../../contracts/space';
import { cellOf, marginOf, safeFrame, topInset } from './metrics';
import type { Cell } from './metrics';
import { wrapMeasured, wrapSpans } from './wrap';
import type { Span } from './wrap';

export interface LayoutItem {
  readonly key: string;
  /** creation order; a replacement has the order of what it replaces */
  readonly order: number;
  /** plain text, before the look's case rules */
  readonly text: string;
  readonly emphasis: readonly Range[];
  /** the element's style at this moment */
  readonly style: ElementStyle;
  /** struck through by a correction; it is drawn as a ghost beside the item whose `replaces` is its key */
  readonly struck: boolean;
  readonly replaces: string | null;
  /**
   * A thing that is not words but takes a line's place in the flow (a control): a block `width` wide and as many of the item's own lines
   * as `height` needs, in layer units, with no text. Its placement says where it goes; nothing is drawn for it here.
   */
  readonly reserve?: { readonly width: number; readonly height: number };
  /**
   * Every words this line can be given (a bound `correct` changes them as a control moves): the room is made for the tallest and the widest of
   * them at the size chosen, once, so that nothing around the line moves or is covered whichever one is showing. Absent: its own words only.
   */
  readonly variants?: readonly { readonly text: string; readonly emphasis: readonly Range[] }[];
}

export interface LayoutInput {
  readonly viewport: Viewport;
  readonly look: LookSpec;
  readonly layout: Layout;
  readonly align: Align;
  /** in-flow lines the brain said to expect; room is reserved for them before they arrive */
  readonly expected: number | null;
  /** everything that is on stage in this layout epoch */
  readonly items: readonly LayoutItem[];
  /**
   * The room flowing text has, on the reading plane in stage units: the
   * `flow` of `fitCanvas(...)`. Omitted, it is the look's safe frame.
   */
  readonly flow?: Box;
  /**
   * v2.1: the foot of the stage plan. When it is given, the choices (in-flow words a tap answers) leave the flow and stand in it, in rows
   * that wrap, centred; when the foot cannot hold them the oldest let go. Omitted, they stay in the flow as any words do.
   */
  readonly foot?: Box;
  /**
   * Where text given a point of the canvas wants its centre, on its own layer's
   * plane (stage units), by key. Such text is set there when that is clear of
   * other text, otherwise it slides to the nearest clear place and, failing
   * that, shrinks within the look's minimum.
   */
  /** v2.1: drawn things on the reading plane (stage units) that words given a point must stand clear of: an outline, a drawing, a structure the brain boxed */
  /** `ground`: a filled card, which words may stand wholly inside (a label on a card) but not across the edge of */
  readonly obstacles?: readonly (Box & { readonly ground?: boolean })[];
  readonly pins?: ReadonlyMap<string, { readonly x: number; readonly y: number; /** how much of its size the word keeps because the picture it stands on was made smaller (the stage plan gave the picture less room than the whole stage): 0..1, absent is 1 */ readonly k?: number }>;
  /**
   * The column each line without `at=left|right` belongs to in a `split` scene, decided once over every line of the scene, so a line keeps its
   * column when the oldest lines of the other one retire.
   */
  readonly sides?: ReadonlyMap<string, 'left' | 'right'>;
}

export interface PlacedRun {
  readonly text: string;
  /** index of the run's first character in the element's plain text */
  readonly offset: number;
  /** top-left of the run's cell box relative to the block's centre */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly emphasised: boolean;
}

export interface Placement {
  readonly key: string;
  readonly layer: Layer;
  /** centre of the block on its layer's plane, stage units */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly fontSize: number;
  readonly stretch: number;
  /** the text as drawn, after the look's case rules, one string per wrapped line */
  readonly text: readonly string[];
  readonly runs: readonly PlacedRun[];
  /** one box per wrapped line, relative to the block's centre */
  readonly lines: readonly Box[];
  /** the list marker, when the layout adds one; drawn as an extra run before the first line */
  readonly bullet: PlacedRun | null;
}

export interface Arrangement {
  readonly placements: ReadonlyMap<string, Placement>;
  /** where the next in-flow line would begin: the cursor's place while the stage waits */
  readonly next: { readonly layer: Layer; readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  /** keys the painter had to retire early because the scene could not hold them */
  readonly overflow: readonly string[];
}


const EPS = 1e-6;
const HEADING_SIZES: ReadonlySet<Size> = new Set<Size>(['l', 'xl', 'xxl']);
const MIN_SHRINK = 0.04;
/** how far words may shrink, beside a card or a control, before the oldest line is let go */
const WITH_CONTROLS_SHRINK = 0.72;
/** the space between paragraphs of a `page`, in lines of body text */
const PARAGRAPH_GAP = 0.6;
/** lines a stack reserves room for when the brain did not say how many to expect */
const FALLBACK_LINES = 3;
const FREE_CANDIDATES: readonly Anchor[] = ['center', 'top', 'bottom', 'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right'];
const FG_CANDIDATES: readonly Anchor[] = ['top-right', 'bottom-right', 'top-left', 'bottom-left'];

interface Prep {
  readonly item: LayoutItem;
  /** the face this item is set in: its own, or the look's */
  readonly face: Face;
  readonly weight: Weight;
  readonly text: string;
  /** index in the original plain text of each drawn character */
  readonly orig: readonly number[];
  readonly emph: readonly boolean[];
}

interface Block {
  readonly prep: Prep;
  readonly layer: Layer;
  readonly cell: Cell;
  readonly spans: readonly Span[];
  readonly broken: boolean;
  /** width of each line, layer units */
  readonly lineWidths: readonly number[];
  /** running width in em of the first k characters of a proportional block's text; null for fixed pitch, where a character is one `unit` */
  readonly prefix: Float64Array | null;
  /** layer units per character (fixed pitch) or per em of text (proportional) */
  readonly unit: number;
  readonly indent: number;
  readonly bullet: string | null;
  /** width of the bullet, layer units */
  readonly bulletWidth: number;
  /** widest line plus indent */
  readonly width: number;
  readonly height: number;
}

interface Unit {
  readonly main: Prep;
  readonly ghosts: readonly Prep[];
}

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface Context {
  readonly input: LayoutInput;
  readonly look: LookSpec;
  readonly viewport: Viewport;
  readonly snap: boolean;
  /** body cell on screen at rest */
  readonly bodyW: number;
  readonly bodyH: number;
  safe: Box;
}

function caseOf(char: string, mode: 'upper' | 'lower' | 'asis'): string {
  return mode === 'upper' ? char.toUpperCase() : mode === 'lower' ? char.toLowerCase() : char;
}

function prepare(item: LayoutItem, look: LookSpec): Prep {
  if (item.reserve !== undefined) return { item, face: item.style.face ?? look.type.face, weight: item.style.weight, text: '', orig: [], emph: [] };
  const mode = look.type.upperOnly ? 'upper' : item.style.case;
  const text: string[] = [];
  const orig: number[] = [];
  const emph: boolean[] = [];
  let index = 0;
  for (const char of item.text) {
    const piece = foldText(caseOf(/\s/.test(char) ? ' ' : char, mode));
    const emphasised = item.emphasis.some((range) => index >= range.start && index < range.end);
    for (const out of piece) {
      if (out === ' ' && (text.length === 0 || text[text.length - 1] === ' ')) continue;
      text.push(out);
      orig.push(index);
      emph.push(emphasised);
    }
    index += char.length;
  }
  while (text[text.length - 1] === ' ') {
    text.pop();
    orig.pop();
    emph.pop();
  }
  return { item, face: item.style.face ?? look.type.face, weight: item.style.weight, text: text.join(''), orig, emph };
}

function layerScale(layer: Layer, ctx: Context): number {
  return planeScale(layer, ctx.viewport);
}

function frameOf(layer: Layer, ctx: Context): Box {
  const bounds = planeBounds(layer, ctx.viewport);
  const scale = layerScale(layer, ctx);
  const margin = marginOf(ctx.viewport, ctx.look) / scale;
  // the look's furniture rows are kept clear on every layer, not only the reading plane
  const top = topInset(ctx.viewport, ctx.look) / scale;
  return { x: bounds.x + margin, y: bounds.y + top, width: Math.max(1, bounds.width - 2 * margin), height: Math.max(1, bounds.height - top - margin) };
}

/** A cell as it will look on screen after scaling by `k`, expressed in the layer's own units. */
function cellFor(size: Size, k: number, layer: Layer, ctx: Context): Cell {
  const base = cellOf(size, ctx.viewport, ctx.look);
  const fontSize = Math.max(ctx.look.type.minFont, base.fontSize * k);
  const scale = fontSize / base.fontSize / layerScale(layer, ctx);
  return { fontSize: fontSize / layerScale(layer, ctx), width: base.width * scale, height: base.height * scale, stretch: base.stretch };
}

function makeBlock(prep: Prep, k: number, availWidth: number, indent: number, bullet: string | null, ctx: Context): Block {
  const variants = prep.item.variants;
  if (variants === undefined || variants.length < 2) return makeOneBlock(prep, k, availWidth, indent, bullet, ctx);
  // the room is the tallest of the words it can be given, then the widest: set once, for all of them
  let best: Block | null = null;
  for (const variant of variants) {
    const made = makeOneBlock(prepare({ ...prep.item, text: variant.text, emphasis: variant.emphasis, variants: undefined }, ctx.look), k, availWidth, indent, bullet, ctx);
    if (best === null || made.height > best.height + EPS || (Math.abs(made.height - best.height) <= EPS && made.width > best.width)) best = made;
  }
  return best ?? makeOneBlock(prep, k, availWidth, indent, bullet, ctx);
}

function makeOneBlock(prep: Prep, k: number, availWidth: number, indent: number, bullet: string | null, ctx: Context): Block {
  const own = prep.face === ctx.look.type.face;
  const pitch = own ? ctx.look.type.pitch : FACES[prep.face].pitch;
  let block = buildBlock(prep, k, availWidth, indent, bullet, ctx, own, pitch);
  // A proportional word wider than the room is made smaller rather than cut in two; a fixed-pitch machine breaks it, as its screen did.
  for (let step = 0; step < 80 && pitch === 'proportional' && block.broken && block.cell.fontSize > ctx.look.type.minFont / layerScale(block.layer, ctx) + EPS; step += 1) {
    k *= 0.96;
    block = buildBlock(prep, k, availWidth, indent, bullet, ctx, own, pitch);
  }
  return block;
}

function buildBlock(prep: Prep, k: number, availWidth: number, indent: number, bullet: string | null, ctx: Context, own: boolean, pitch: 'fixed' | 'proportional'): Block {
  const layer = prep.item.style.layer;
  const spec = FACES[prep.face];
  const natural = cellFor(prep.item.style.size, k, layer, ctx);
  const reserve = prep.item.reserve;
  if (reserve !== undefined) {
    const rows = Math.max(1, Math.ceil(reserve.height / natural.height - 1e-6));
    return {
      prep,
      layer,
      cell: natural,
      spans: Array.from({ length: rows }, () => ({ start: 0, end: 0 })),
      broken: false,
      lineWidths: Array.from({ length: rows }, () => reserve.width),
      prefix: null,
      unit: natural.width,
      indent,
      bullet: null,
      bulletWidth: 0,
      width: reserve.width + indent,
      height: rows * natural.height,
    };
  }
  // another face than the look's keeps the look's size ladder but brings its own advance and leading
  const cell: Cell = own ? natural : { ...natural, width: natural.fontSize * natural.stretch * spec.advance, height: natural.fontSize * spec.lineHeight };
  const { measure } = ctx.look.type;
  let spans: readonly Span[];
  let broken: boolean;
  let prefix: Float64Array | null = null;
  let unit = cell.width;
  const lineWidths: number[] = [];
  if (pitch === 'fixed') {
    const cols = Math.min(measure, Math.max(1, Math.floor((availWidth - indent) / cell.width + EPS)));
    const wrapped = wrapSpans(prep.text, cols);
    spans = wrapped.spans;
    broken = wrapped.broken;
    for (const span of spans) lineWidths.push((span.end - span.start) * cell.width);
  } else {
    prefix = prefixEm(prep.text, prep.face, prep.weight);
    unit = cell.fontSize * cell.stretch;
    // the look's measure is that many characters of running text, never more characters than that, never more than the room
    const widest = Math.min((availWidth - indent) / unit + EPS, (measure * cell.width) / unit);
    const wrapped = wrapMeasured(prep.text, prefix, widest, measure);
    spans = wrapped.spans;
    broken = wrapped.broken;
    for (const span of spans) lineWidths.push(((prefix[span.end] ?? 0) - (prefix[span.start] ?? 0)) * unit);
  }
  const bulletWidth = bullet === null ? 0 : pitch === 'fixed' ? bullet.length * cell.width : measureEm(bullet, prep.face, 'normal') * unit;
  return {
    prep,
    layer,
    cell,
    spans,
    broken,
    lineWidths,
    prefix,
    unit,
    indent,
    bullet,
    bulletWidth,
    width: Math.max(0, ...lineWidths) + indent,
    height: spans.length * cell.height,
  };
}

function snapUp(value: number, ctx: Context): number {
  return ctx.snap ? Math.ceil(value / ctx.bodyH - EPS) * ctx.bodyH : value;
}

function emit(block: Block, left: number, top: number, blockWidth: number, align: 'left' | 'center' | 'right', ctx: Context): Placement {
  const { cell, prep, prefix, unit } = block;
  const height = block.height;
  const lines: Box[] = [];
  const runs: PlacedRun[] = [];
  const text: string[] = [];
  const at = (index: number): number => (prefix === null ? index : (prefix[index] ?? 0));
  block.spans.forEach((span, row) => {
    const lineWidth = block.lineWidths[row] ?? 0;
    const free = blockWidth - block.indent - lineWidth;
    const x = -blockWidth / 2 + block.indent + (align === 'left' ? 0 : align === 'center' ? free / 2 : free);
    const y = -height / 2 + row * cell.height;
    lines.push({ x, y, width: lineWidth, height: cell.height });
    text.push(prep.text.slice(span.start, span.end));
    let from = span.start;
    while (from < span.end) {
      if (prep.text[from] === ' ') {
        from += 1;
        continue;
      }
      const emphasised = prep.emph[from] === true;
      let end = from;
      while (end < span.end && prep.text[end] !== ' ' && (prep.emph[end] === true) === emphasised) end += 1;
      runs.push({
        text: prep.text.slice(from, end),
        offset: prep.orig[from] ?? 0,
        x: x + (at(from) - at(span.start)) * unit,
        y,
        width: (at(end) - at(from)) * unit,
        emphasised,
      });
      from = end;
    }
  });
  const bullet: PlacedRun | null =
    block.bullet === null ? null : { text: block.bullet, offset: 0, x: -blockWidth / 2, y: -height / 2, width: block.bulletWidth, emphasised: false };
  return {
    key: prep.item.key,
    layer: block.layer,
    x: left + blockWidth / 2,
    y: top + height / 2,
    width: blockWidth,
    height,
    fontSize: cell.fontSize,
    stretch: cell.stretch,
    text,
    runs,
    lines,
    bullet,
  };
}

function firstLineLeft(block: Block, left: number, blockWidth: number, align: 'left' | 'center' | 'right'): number {
  const lineWidth = block.lineWidths[0] ?? 0;
  const free = blockWidth - block.indent - lineWidth;
  return left + block.indent + (align === 'left' ? 0 : align === 'center' ? free / 2 : free);
}

function occupy(placement: Placement, into: Rect[]): void {
  for (const line of placement.lines) {
    into.push({ x: placement.x + line.x, y: placement.y + line.y, width: line.width, height: line.height });
  }
}

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > EPS && h > EPS ? w * h : 0;
}

function overlapWith(box: Rect, others: readonly Rect[], pad: number): number {
  const padded = { x: box.x - pad, y: box.y - pad, width: box.width + 2 * pad, height: box.height + 2 * pad };
  let total = 0;
  for (const other of others) total += overlapArea(padded, other);
  return total;
}

// ---------------------------------------------------------------- units

function buildUnits(input: LayoutInput, look: LookSpec): { flow: Unit[]; loose: Unit[]; all: Map<string, Unit> } {
  // a label that names a thing (`near=`) is placed by the painter, beside the thing, not here
  const preps = input.items.filter((item) => item.style.near === null).map((item) => prepare(item, look));
  const byKey = new Map<string, Prep>();
  for (const prep of preps) byKey.set(prep.item.key, prep);
  const replacerOf = new Map<string, Prep>();
  for (const prep of preps) if (prep.item.replaces !== null && !replacerOf.has(prep.item.replaces)) replacerOf.set(prep.item.replaces, prep);

  const target = (prep: Prep): Prep | null => {
    let current = prep;
    for (let hops = 0; hops < 16; hops += 1) {
      const next = replacerOf.get(current.item.key);
      if (next === undefined || next === prep) return null;
      if (!next.item.struck) return next;
      current = next;
    }
    return null;
  };

  const ghostsOf = new Map<string, Prep[]>();
  const mains: Prep[] = [];
  for (const prep of preps) {
    const owner = prep.item.struck ? target(prep) : null;
    if (owner === null) {
      mains.push(prep);
      continue;
    }
    const list = ghostsOf.get(owner.item.key) ?? [];
    list.push(prep);
    ghostsOf.set(owner.item.key, list);
  }
  const byOrder = (a: Prep, b: Prep): number => a.item.order - b.item.order;
  mains.sort(byOrder);
  const flow: Unit[] = [];
  const loose: Unit[] = [];
  const all = new Map<string, Unit>();
  for (const main of mains) {
    const unit: Unit = { main, ghosts: (ghostsOf.get(main.item.key) ?? []).sort(byOrder) };
    all.set(main.item.key, unit);
    // the choices belong to the foot wherever the brain said to put them: the foot is reserved for them, and nothing else is
    const choice = input.foot !== undefined && main.item.style.tap && main.item.reserve === undefined;
    (choice || isFlow(main.item.style, input.layout) ? flow : loose).push(unit);
  }
  return { flow, loose, all };
}

function isFlow(style: ElementStyle, layout: Layout): boolean {
  return layout !== 'free' && isInFlow(style, layout);
}

// ---------------------------------------------------------------- flow

interface Column {
  readonly units: Unit[];
  readonly left: number;
  readonly width: number;
  readonly align: 'left' | 'center' | 'right';
  readonly list: boolean;
  /** paragraphs of a reading column: set apart by 0.6 of a line */
  readonly page: boolean;
  readonly expected: number;
}

interface SlotLayout {
  readonly unit: Unit;
  readonly ghosts: Block[];
  readonly main: Block;
  readonly top: number;
  readonly mainTop: number;
}

interface ColumnLayout {
  readonly slots: SlotLayout[];
  /** bottom of the last item, relative to the column's top */
  readonly end: number;
  readonly gap: number;
  readonly bodyHeight: number;
}

function resolveAlign(ctx: Context): 'left' | 'center' | 'right' {
  const { align, layout } = ctx.input;
  if (layout === 'list') return 'left';
  if (align === 'left' || align === 'center' || align === 'right') return align;
  if (layout === 'solo' || layout === 'caption') return 'center';
  return layout === 'figure' || layout === 'page' ? 'left' : ctx.look.type.align;
}

/** One line at a time, in the middle of its room. */
function isSingle(layout: Layout): boolean {
  return layout === 'solo' || layout === 'caption';
}

function snapColumnLeft(x: number, ctx: Context): number {
  return ctx.snap ? ctx.safe.x + Math.floor((x - ctx.safe.x) / ctx.bodyW + EPS) * ctx.bodyW : x;
}

function makePlan(units: readonly Unit[], ctx: Context): Column[] {
  const { layout, expected } = ctx.input;
  const align = resolveAlign(ctx);
  const cols = Math.max(1, Math.min(ctx.look.type.measure, Math.floor(ctx.safe.width / ctx.bodyW + EPS)));
  const colW = cols * ctx.bodyW;
  const centre = ctx.safe.x + ctx.safe.width / 2;
  const single = (list: Unit[]): Column => ({
    units: list,
    left: snapColumnLeft(centre - colW / 2, ctx),
    width: colW,
    align,
    list: layout === 'list',
    page: layout === 'page',
    expected: isSingle(layout) ? 0 : (expected ?? 0),
  });
  if (layout !== 'split') return [single([...units])];

  const gutter = 2 * ctx.bodyW;
  const available = Math.floor((ctx.safe.width - gutter) / 2 / ctx.bodyW + EPS) * ctx.bodyW;
  const each = Math.min(ctx.look.type.measure * ctx.bodyW, available);
  const left: Unit[] = [];
  const right: Unit[] = [];
  const undecided: Unit[] = [];
  for (const unit of units) {
    const placed = unit.main.item.style.at === 'left' || unit.main.item.style.at === 'right' ? unit.main.item.style.at : ctx.input.sides?.get(unit.main.item.key);
    if (placed === 'left') left.push(unit);
    else if (placed === 'right') right.push(unit);
    else undecided.push(unit);
  }
  for (const unit of undecided) (left.length <= right.length ? left : right).push(unit);
  if (each < 14 * ctx.bodyW) {
    const rows = single([...left, ...right]);
    return [rows];
  }
  const total = 2 * each + gutter;
  const origin = snapColumnLeft(centre - total / 2, ctx);
  const half = Math.ceil((expected ?? 0) / 2);
  const base = { width: each, align, list: false, page: false, expected: half };
  return [
    { ...base, units: left, left: origin },
    { ...base, units: right, left: origin + each + gutter },
  ];
}

function unitIndent(prep: Prep, list: boolean, ctx: Context): { indent: number; bullet: string | null } {
  if (!list || prep.item.style.size === undefined || HEADING_SIZES.has(prep.item.style.size)) return { indent: 0, bullet: null };
  return { indent: 2 * ctx.bodyW, bullet: foldText(ctx.look.type.bullet) };
}

function layoutColumn(column: Column, f: number, ctx: Context): ColumnLayout {
  const body = cellFor('m', f, 'mid', ctx);
  const gap = ctx.snap ? (column.list ? 0 : ctx.bodyH) : body.height * (column.list ? 0.25 : column.page ? PARAGRAPH_GAP : 0.5);
  // A boxed item's frame runs to the edge of its own row, so on a look that packs list rows edge to edge two boxed neighbours would touch:
  // between them (and between a boxed item and any other) the list keeps one blank row. Looks that space list rows already clear the boxes.
  const boxed = (unit: Unit | undefined): boolean => column.list && unit !== undefined && unit.main.item.style.mark === 'box';
  const slots: SlotLayout[] = [];
  let cursor = 0;
  let end = 0;
  column.units.forEach((unit, index) => {
    if (index > 0) cursor = snapUp(cursor + (ctx.snap && (boxed(unit) || boxed(column.units[index - 1])) ? ctx.bodyH : gap), ctx);
    const top = cursor;
    const ghosts = unit.ghosts.map((ghost) => makeBlock(ghost, 0.8 * f, column.width, 0, null, ctx));
    for (const ghost of ghosts) cursor = snapUp(cursor + ghost.height, ctx);
    const { indent, bullet } = unitIndent(unit.main, column.list, ctx);
    const main = makeBlock(unit.main, f, column.width, indent, bullet, ctx);
    const mainTop = cursor;
    cursor += main.height;
    end = cursor;
    slots.push({ unit, ghosts, main, top, mainTop });
  });
  return { slots, end, gap, bodyHeight: body.height };
}

function columnHeight(layout: ColumnLayout, missing: number): number {
  if (layout.slots.length > 0) return layout.end + missing * (layout.gap + layout.bodyHeight);
  return missing > 0 ? missing * layout.bodyHeight + (missing - 1) * layout.gap : 0;
}

function presentHeight(plan: readonly Column[], f: number, ctx: Context): number {
  let tallest = 0;
  for (const column of plan) tallest = Math.max(tallest, layoutColumn(column, f, ctx).end);
  return tallest;
}

/** The largest common shrink factor at which what is present fits; null when even the smallest does not. */
function fitFactor(plan: readonly Column[], ctx: Context): number | null {
  const room = ctx.safe.height + EPS;
  if (presentHeight(plan, 1, ctx) <= room) return 1;
  if (presentHeight(plan, MIN_SHRINK, ctx) > room) return null;
  let low = MIN_SHRINK;
  let high = 1;
  for (let i = 0; i < 24; i += 1) {
    const mid = (low + high) / 2;
    if (presentHeight(plan, mid, ctx) <= room) low = mid;
    else high = mid;
  }
  return low;
}

interface FlowResult {
  readonly placements: Placement[];
  readonly next: Arrangement['next'];
  readonly overflow: string[];
  /**
   * What the far and near planes keep clear of so that they need not move as
   * lines land, strictest first: everything from the stack's top to the
   * bottom of the safe frame (the stack grows downward), then the block as
   * reserved. Empty when nothing flows.
   */
  readonly regions: Rect[];
  /** the height the words need in their box when what is expected has come, before any shrink: what the stage plan offers them */
  readonly need: number;
}

/** A scene's title: the large lines. It outlives the body lines under it. */
function isHeading(unit: Unit): boolean {
  const size = unit.main.item.style.size;
  return size !== undefined && HEADING_SIZES.has(size);
}

/** The oldest line of a column that may leave to make room: never the newest, never a pinned one, and a heading only when no body line is left to go. */
function retirable(column: Column): number {
  const last = column.units.length - 1;
  // a control (it has a reserve) is something the user is using and the drawing is bound to: it never leaves to make room for words
  const free = (unit: Unit, index: number): boolean => index < last && unit.main.item.style.stay !== 'pin' && unit.main.item.reserve === undefined;
  // the key lines (bold, `strong` and above) are the last of the body to go: the answer stays while the lines that explain it give way
  const key = (unit: Unit): boolean => unit.main.item.style.weight === 'bold';
  // A control in the column keeps its place: when the words give way, the ones after it go first (oldest of them), because whatever is above it
  // leaving would slide the control up the stage under the hand.
  const control = column.units.findIndex((unit) => unit.main.item.reserve !== undefined && !unit.main.item.style.tap);
  if (control >= 0) {
    const after = (wanted: (unit: Unit) => boolean): number => column.units.findIndex((unit, index) => index > control && free(unit, index) && wanted(unit));
    const below = after((unit) => !isHeading(unit) && !key(unit));
    if (below >= 0) return below;
    const bodyBelow = after((unit) => !isHeading(unit));
    if (bodyBelow >= 0) return bodyBelow;
  }
  const aside = column.units.findIndex((unit, index) => free(unit, index) && !isHeading(unit) && !key(unit));
  if (aside >= 0) return aside;
  const body = column.units.findIndex((unit, index) => free(unit, index) && !isHeading(unit));
  return body >= 0 ? body : column.units.findIndex(free);
}

function arrangeFlow(units: readonly Unit[], ctx: Context): FlowResult {
  const overflow: string[] = [];
  const page = ctx.input.layout === 'page';
  const plan = makePlan([...units], ctx);
  // A column never shrinks once it is placed. When what is present would pass the bottom of its box, the oldest lines leave at the top (they are
  // retired and the rest move up, eased like a `page`); lines that stay `pin` and the newest line are kept. Each column scrolls on its own.
  for (let guard = 0; guard < 4096; guard += 1) {
    // A column with a card or a control in it sets its words a little smaller before it lets any of them go: the hand's controls and the line
    // that explains them are meant to be on the stage together.
    const full = plan.find((column) => layoutColumn(column, column.units.some((unit) => unit.main.item.reserve !== undefined) ? WITH_CONTROLS_SHRINK : 1, ctx).end > ctx.safe.height + EPS && retirable(column) >= 0);
    if (full === undefined) break;
    const gone = retirable(full);
    const [dropped] = full.units.splice(gone, 1);
    if (dropped !== undefined) {
      overflow.push(dropped.main.item.key);
      for (const ghost of dropped.ghosts) overflow.push(ghost.item.key);
    }
  }
  // Only a single line (or pinned ones) taller than the room is ever made smaller, and never below the smallest the look allows.
  const f = fitFactor(plan, ctx) ?? MIN_SHRINK;

  const layouts = plan.map((column) => layoutColumn(column, f, ctx));
  const room = ctx.safe.height + EPS;
  // Where the block sits is decided by line one and the lines expected, never
  // by how tall the later lines turn out to be: line one is placed where it
  // will still be when the last line of the scene lands. The block then grows
  // downward and only moves up once it would leave the safe frame.
  const reserved = plan.map((column, index) => {
    const layout = layouts[index];
    const first = layout?.slots[0];
    if (layout === undefined) return 0;
    if (first === undefined) {
      let missing = column.expected;
      while (missing > 0 && columnHeight(layout, missing) > room) missing -= 1;
      return columnHeight(layout, missing);
    }
    const lines = column.expected > 0 ? column.expected : isSingle(ctx.input.layout) ? 1 : plan.length > 1 ? FALLBACK_LINES - 1 : FALLBACK_LINES;
    let extra = Math.max(0, lines - 1);
    const firstEnd = first.mainTop + first.main.height;
    while (extra > 0 && firstEnd + extra * (layout.gap + layout.bodyHeight) > room) extra -= 1;
    return firstEnd + extra * (layout.gap + layout.bodyHeight);
  });
  const present = Math.max(0, ...layouts.map((layout) => layout.end));
  const block = Math.max(present, ...reserved);
  const centreShift = ctx.input.layout === 'solo' ? -0.04 * ctx.safe.height : 0;
  const bottom = ctx.safe.y + ctx.safe.height;
  // beside a column of controls the block stands where the controls' own column puts it: the words' column changes with every line, the controls do not move
  const anchored = ctx.input.sides !== undefined && plan.length === 2 ? (reserved[0] ?? 0) : Math.max(0, ...reserved);
  let top = ctx.safe.y + (ctx.safe.height - anchored) / 2 + centreShift;
  top = Math.max(ctx.safe.y, Math.min(top, bottom - (anchored > 0 && ctx.input.sides !== undefined && plan.length === 2 ? Math.max(anchored, reserved[0] ?? 0) : block)));
  // a reading column begins at the top of its box and never moves until it scrolls
  if (page) top = ctx.safe.y;
  if (ctx.snap) {
    top = ctx.safe.y + Math.floor((top - ctx.safe.y) / ctx.bodyH + EPS) * ctx.bodyH;
    if (top + block > bottom + EPS) top -= ctx.bodyH;
    top = Math.max(ctx.safe.y, top);
  }

  const placements: Placement[] = [];
  plan.forEach((column, index) => {
    const layout = layouts[index];
    if (layout === undefined) return;
    for (const slot of layout.slots) {
      const mainTop = top + slot.mainTop;
      const lineLeft = firstLineLeft(slot.main, column.left, column.width, column.align);
      let ghostTop = top + slot.top;
      for (const ghost of slot.ghosts) {
        const left = Math.max(column.left, Math.min(lineLeft, column.left + column.width - ghost.width));
        placements.push(emit(ghost, left, ghostTop, ghost.width, 'left', ctx));
        ghostTop = snapUp(ghostTop - top + ghost.height, ctx) + top;
      }
      placements.push(emit(slot.main, column.left, mainTop, column.width, column.align, ctx));
    }
  });

  // The cursor waits in the emptier column.
  let which = 0;
  plan.forEach((column, index) => {
    const current = plan[which];
    if (current !== undefined && column.units.length < current.units.length) which = index;
  });
  const column = plan[which];
  const layout = layouts[which];
  const body = cellFor('m', f, 'mid', ctx);
  let next: Arrangement['next'] = { layer: 'mid', x: -body.width / 2, y: -body.height / 2, width: body.width, height: body.height };
  if (column !== undefined && layout !== undefined) {
    const y0 = layout.slots.length > 0 ? snapUp(layout.end + layout.gap, ctx) : 0;
    const y = Math.min(top + y0, ctx.safe.y + ctx.safe.height - body.height);
    const indent = column.list ? 2 * ctx.bodyW : 0;
    const x =
      column.align === 'left'
        ? column.left + indent
        : column.align === 'center'
          ? column.left + (column.width - body.width) / 2
          : column.left + column.width - body.width;
    next = { layer: 'mid', x, y, width: body.width, height: body.height };
  }
  const regions: Rect[] = [];
  if (block > 0) {
    const left = Math.min(...plan.map((column) => column.left));
    const right = Math.max(...plan.map((column) => column.left + column.width));
    if (!isSingle(ctx.input.layout)) regions.push({ x: left, y: top, width: right - left, height: bottom - top });
    regions.push({ x: left, y: top, width: right - left, height: block });
  }
  return { placements, next, overflow, regions, need: block };
}

// ---------------------------------------------------------------- loose

interface Loose {
  readonly ghosts: Block[];
  readonly main: Block;
  readonly width: number;
  readonly height: number;
  readonly align: 'left' | 'center' | 'right';
}

function anchorAlign(anchor: Anchor | Point | null, fallback: 'left' | 'center' | 'right'): 'left' | 'center' | 'right' {
  if (anchor === null || typeof anchor !== 'string') return fallback;
  if (anchor === 'left' || anchor === 'top-left' || anchor === 'bottom-left') return 'left';
  if (anchor === 'right' || anchor === 'top-right' || anchor === 'bottom-right') return 'right';
  return fallback;
}

function buildLoose(unit: Unit, anchor: Anchor | Point | null, frame: Box, ctx: Context, shrink = 1): Loose {
  const fallback = ctx.input.align === 'left' || ctx.input.align === 'right' || ctx.input.align === 'center' ? ctx.input.align : 'center';
  const align = anchorAlign(anchor, fallback);
  const attempt = (k: number): Loose => {
    const ghosts = unit.ghosts.map((ghost) => makeBlock(ghost, 0.8 * k, frame.width, 0, null, ctx));
    const main = makeBlock(unit.main, k, frame.width, 0, null, ctx);
    const width = Math.max(main.width, ...ghosts.map((g) => g.width));
    const height = main.height + ghosts.reduce((sum, g) => sum + g.height, 0);
    return { ghosts, main, width, height, align };
  };
  let k = shrink;
  let result = attempt(k);
  for (let i = 0; i < 80; i += 1) {
    const fits = result.width <= frame.width + EPS && result.height <= frame.height + EPS && !result.main.broken;
    if (fits) break;
    const next = attempt(k * 0.95);
    const shrunk = next.main.cell.fontSize < result.main.cell.fontSize - EPS;
    k *= 0.95;
    if (!shrunk) break;
    result = next;
  }
  return result;
}

function anchorBox(anchor: Anchor | Point, size: { width: number; height: number }, frame: Box): { x: number; y: number } {
  if (typeof anchor !== 'string') {
    const x = frame.x + (anchor.x / 100) * frame.width - size.width / 2;
    const y = frame.y + (anchor.y / 100) * frame.height - size.height / 2;
    return {
      x: Math.max(frame.x, Math.min(x, frame.x + frame.width - size.width)),
      y: Math.max(frame.y, Math.min(y, frame.y + frame.height - size.height)),
    };
  }
  const left = anchor === 'left' || anchor === 'top-left' || anchor === 'bottom-left';
  const right = anchor === 'right' || anchor === 'top-right' || anchor === 'bottom-right';
  const top = anchor === 'top' || anchor === 'top-left' || anchor === 'top-right';
  const bottom = anchor === 'bottom' || anchor === 'bottom-left' || anchor === 'bottom-right';
  return {
    x: left ? frame.x : right ? frame.x + frame.width - size.width : frame.x + (frame.width - size.width) / 2,
    y: top ? frame.y : bottom ? frame.y + frame.height - size.height : frame.y + (frame.height - size.height) / 2,
  };
}

function snapInside(position: { x: number; y: number }, size: { width: number; height: number }, frame: Box, ctx: Context): { x: number; y: number } {
  if (!ctx.snap) return position;
  const stepX = ctx.bodyW / layerScale('mid', ctx);
  const stepY = ctx.bodyH / layerScale('mid', ctx);
  let x = frame.x + Math.floor((position.x - frame.x) / stepX + EPS) * stepX;
  let y = frame.y + Math.floor((position.y - frame.y) / stepY + EPS) * stepY;
  if (x + size.width > frame.x + frame.width + EPS) x -= stepX;
  if (y + size.height > frame.y + frame.height + EPS) y -= stepY;
  return { x: Math.max(frame.x, x), y: Math.max(frame.y, y) };
}

function pushClear(
  anchor: Anchor,
  start: { x: number; y: number },
  size: { width: number; height: number },
  frame: Box,
  occupied: readonly Rect[],
  pad: number,
  step: { x: number; y: number },
): { x: number; y: number } {
  const free = (p: { x: number; y: number }): boolean => overlapWith({ x: p.x, y: p.y, width: size.width, height: size.height }, occupied, pad) === 0;
  if (free(start)) return start;
  const alongX = anchor === 'top' || anchor === 'bottom' || anchor.includes('-') || anchor === 'center';
  const alongY = anchor === 'left' || anchor === 'right' || anchor.includes('-') || anchor === 'center';
  const maxSteps = 400;
  for (let n = 1; n <= maxSteps; n += 1) {
    const tries: { x: number; y: number }[] = [];
    // the axis that runs along the edge the anchor sits on, away from the flow first
    const order: ('y' | 'x')[] = anchor === 'top' || anchor === 'bottom' ? ['x', 'y'] : anchor === 'left' || anchor === 'right' || anchor === 'center' ? ['y', 'x'] : ['x', 'y'];
    for (const axis of order) {
      if (axis === 'x' && alongX) {
        tries.push({ x: start.x + n * step.x, y: start.y }, { x: start.x - n * step.x, y: start.y });
      }
      if (axis === 'y' && alongY) {
        tries.push({ x: start.x, y: start.y + n * step.y }, { x: start.x, y: start.y - n * step.y });
      }
    }
    for (const p of tries) {
      const inside = p.x >= frame.x - EPS && p.y >= frame.y - EPS && p.x + size.width <= frame.x + frame.width + EPS && p.y + size.height <= frame.y + frame.height + EPS;
      if (inside && free(p)) return p;
    }
  }
  return start;
}

const offsetCache = new Map<string, readonly { dx: number; dy: number }[]>();

/** The lattice offsets of a grid, nearest first. The same grid is asked for many times in one layout: sorted once. */
function offsetsOf(maxX: number, maxY: number, step: { x: number; y: number }): readonly { dx: number; dy: number }[] {
  const key = `${maxX}|${maxY}|${step.x}|${step.y}`;
  const known = offsetCache.get(key);
  if (known !== undefined) return known;
  const offsets: { dx: number; dy: number; d: number }[] = [];
  for (let i = -maxX; i <= maxX; i += 1) {
    for (let j = -maxY; j <= maxY; j += 1) {
      if (i === 0 && j === 0) continue;
      const dx = i * step.x;
      const dy = j * step.y;
      offsets.push({ dx, dy, d: Math.hypot(dx, dy) });
    }
  }
  offsets.sort((a, b) => a.d - b.d || Math.abs(a.dx) - Math.abs(b.dx));
  if (offsetCache.size >= 64) offsetCache.clear();
  offsetCache.set(key, offsets);
  return offsets;
}

/**
 * The place nearest to `start` where a box of `size` inside `frame` lies clear
 * of every rectangle in `occupied` (with `pad` between), or null when there is
 * none. Candidates are lattice offsets tried in order of distance.
 */
function nearestClear(
  start: { x: number; y: number },
  size: { width: number; height: number },
  frame: Box,
  occupied: readonly Rect[],
  pad: number,
  step: { x: number; y: number },
): { x: number; y: number } | null {
  const free = (p: { x: number; y: number }): boolean => overlapWith({ x: p.x, y: p.y, width: size.width, height: size.height }, occupied, pad) === 0;
  if (free(start)) return start;
  const maxX = Math.ceil(frame.width / step.x);
  const maxY = Math.ceil(frame.height / step.y);
  const offsets = offsetsOf(maxX, maxY, step);
  for (const { dx, dy } of offsets) {
    const p = { x: start.x + dx, y: start.y + dy };
    if (p.x < frame.x - EPS || p.y < frame.y - EPS || p.x + size.width > frame.x + frame.width + EPS || p.y + size.height > frame.y + frame.height + EPS) continue;
    if (free(p)) return p;
  }
  return null;
}

/** A rectangle on the reading plane, seen from another layer's plane with the camera at rest. */
function projectRect(rect: Rect, to: Layer, ctx: Context): Rect {
  const k = layerScale(to, ctx);
  return { x: rect.x / k, y: rect.y / k, width: rect.width / k, height: rect.height / k };
}

/** Where a background or foreground word may start looking: corners and edges away from the reading column first. */
const BG_CANDIDATES: readonly Anchor[] = ['bottom-right', 'top-right', 'bottom-left', 'top-left', 'right', 'left', 'bottom', 'top', 'center'];
/** Shrink factors tried, in order, when a word cannot be placed clear of the text at full size. */
const CLEAR_SHRINK: readonly number[] = [1, 0.8, 0.64, 0.5, 0.4];

function arrangeLoose(
  units: readonly Unit[],
  ctx: Context,
  flowOccupied: readonly Rect[],
  occupied: Record<Layer, Rect[]>,
  regions: readonly Rect[],
): Placement[] {
  const placed = new Map<string, Placement[]>();
  // The reading plane first, so the far and near planes can keep clear of everything on it.
  // Then the far and near words that were told where to go (near before far, so the far one steps aside), then those that choose: they keep clear of everything already placed.
  const rank = (unit: Unit): number => {
    const { layer, at } = unit.main.item.style;
    return layer === 'mid' ? 0 : at !== null ? (layer === 'fg' ? 1 : 2) : 3;
  };
  const order = [...units].sort((a, b) => rank(a) - rank(b));
  for (const unit of order) {
    const style = unit.main.item.style;
    const layer = style.layer;
    const ps = layerScale(layer, ctx);
    const frame = frameOf(layer, ctx);
    const pad = ctx.bodyW / ps;
    const step = { x: ctx.bodyW / ps, y: ctx.bodyH / ps };
    const explicit = style.at;
    // what this word must not sit on: the text of the reading plane (as seen from its own plane) and its own plane's words
    const text = layer === 'mid' ? [] : occupied.mid.map((rect) => projectRect(rect, layer, ctx));
    const taken = occupied[layer];
    // words on the other far/near plane, as they sit on this one with the camera at rest: no box of one may lie on a box of the other
    const across: Rect[] = [];
    if (layer !== 'mid') {
      const other: Layer = layer === 'bg' ? 'fg' : 'bg';
      const k = layerScale(other, ctx) / ps;
      for (const rect of occupied[other]) across.push({ x: rect.x * k, y: rect.y * k, width: rect.width * k, height: rect.height * k });
    }
    const pin = ctx.input.pins?.get(unit.main.item.key) ?? null;
    const candidates: readonly (Anchor | Point)[] =
      explicit !== null ? [explicit] : layer === 'bg' ? BG_CANDIDATES : layer === 'fg' ? FG_CANDIDATES : FREE_CANDIDATES;
    // strictest first: keep clear of where the stack will grow, then of the block, then of the lines on stage
    const tiers: Rect[][] = layer === 'mid' ? [[]] : [...regions.map((rect) => [projectRect(rect, layer, ctx)]), []];

    let chosen: { loose: Loose; position: { x: number; y: number } } | null = null;
    let bestOverlap = Infinity;
    if (pin !== null) {
      // Told a point: the word is set centred there. If that lands on other text it moves the least it must to a clear place; if that is far, it shrinks first.
      const solids = layer === 'mid' ? (ctx.input.obstacles ?? []) : [];
      const reach = 4 * step.y;
      let best: { loose: Loose; position: { x: number; y: number }; moved: number } | null = null;
      const kept = pin.k ?? 1;
      for (const shrink of CLEAR_SHRINK) {
        const loose = buildLoose(unit, 'center', frame, ctx, shrink * kept);
        const size = { width: loose.width, height: loose.height };
        const wanted = {
          x: Math.max(frame.x, Math.min(pin.x - size.width / 2, frame.x + frame.width - size.width)),
          y: Math.max(frame.y, Math.min(pin.y - size.height / 2, frame.y + frame.height - size.height)),
        };
        // a card the word lies wholly inside is its ground, not in its way
        const inside = (o: Box & { readonly ground?: boolean }): boolean => o.ground === true && wanted.x >= o.x && wanted.y >= o.y && wanted.x + size.width <= o.x + o.width && wanted.y + size.height <= o.y + o.height;
        const avoid = [...text, ...taken, ...across, ...solids.filter((o) => !inside(o))];
        const found = nearestClear(wanted, size, frame, avoid, pad, { x: step.x, y: step.y / 2 });
        if (found === null) continue;
        const position = snapInside(found, size, frame, ctx);
        const moved = Math.hypot(position.x - wanted.x, position.y - wanted.y);
        if (best === null || moved < best.moved - EPS) best = { loose, position, moved };
        if (moved <= reach) break;
      }
      if (best === null) {
        // nowhere is clear: as small as it may be, at the point it was told, rather than full size on top of something
        const loose = buildLoose(unit, 'center', frame, ctx, (CLEAR_SHRINK[CLEAR_SHRINK.length - 1] ?? 1) * kept);
        const size = { width: loose.width, height: loose.height };
        const wanted = {
          x: Math.max(frame.x, Math.min(pin.x - size.width / 2, frame.x + frame.width - size.width)),
          y: Math.max(frame.y, Math.min(pin.y - size.height / 2, frame.y + frame.height - size.height)),
        };
        best = { loose, position: snapInside(wanted, size, frame, ctx), moved: 0 };
      }
      chosen = { loose: best.loose, position: best.position };
    }
    for (const tier of pin !== null ? [] : tiers) {
      const avoid = [...text, ...tier, ...taken, ...across];
      bestOverlap = Infinity;
      chosen = null;
      for (const shrink of layer === 'mid' || (explicit !== null && layer === 'fg') ? [1] : CLEAR_SHRINK) {
        for (const candidate of candidates) {
          const loose = buildLoose(unit, candidate, frame, ctx, shrink);
          const size = { width: loose.width, height: loose.height };
          let position = anchorBox(candidate, size, frame);
          position = snapInside(position, size, frame, ctx);
          if (explicit !== null) {
            if (typeof candidate === 'string') {
              const others = layer === 'mid' ? flowOccupied : avoid;
              position = snapInside(pushClear(candidate, position, size, frame, others, pad, step), size, frame, ctx);
            }
            // Told where to go, the word keeps its anchor and slides along it. If nothing along it is clear at full size a far word
            // shrinks, then gives up the stricter tiers; only when nothing is clear anywhere does it stay at full size where it was told.
            const clear = layer === 'mid' || typeof candidate !== 'string' || overlapWith({ ...position, ...size }, avoid, pad) === 0;
            if (clear) {
              chosen = { loose, position };
              bestOverlap = 0;
            } else if (shrink === 1 && tier === tiers[tiers.length - 1]) {
              chosen = { loose, position };
              bestOverlap = Infinity;
            } else if (chosen === null) {
              bestOverlap = Infinity;
            }
            break;
          }
          const overlap = overlapWith({ ...position, ...size }, layer === 'mid' ? taken : avoid, pad);
          if (overlap < bestOverlap - EPS) {
            bestOverlap = overlap;
            chosen = { loose, position };
          }
          if (overlap === 0) break;
        }
        if (bestOverlap === 0) break;
      }
      if (bestOverlap === 0) break;
    }
    if (chosen === null) continue;
    const { loose, position } = chosen;
    const mainLeft = loose.align === 'left' ? 0 : loose.align === 'right' ? loose.width - loose.main.width : (loose.width - loose.main.width) / 2;
    const lineLeft = firstLineLeft(loose.main, mainLeft, loose.main.width, loose.align);
    let top = position.y;
    const made: Placement[] = [];
    for (const ghost of loose.ghosts) {
      const left = Math.max(0, Math.min(lineLeft, loose.width - ghost.width));
      const placement = emit(ghost, position.x + left, top, ghost.width, 'left', ctx);
      made.push(placement);
      occupy(placement, taken);
      top += ghost.height;
    }
    const placement = emit(loose.main, position.x + mainLeft, top, loose.main.width, loose.align, ctx);
    made.push(placement);
    occupy(placement, taken);
    placed.set(unit.main.item.key, made);
  }
  // back in creation order
  return units.flatMap((unit) => placed.get(unit.main.item.key) ?? []);
}

/**
 * Decides where everything on stage sits for one layout epoch. Pure and
 * deterministic: the same input always gives the same arrangement, and it
 * knows nothing about time. The engine calls it whenever the set of things on
 * stage, the plan, or the viewport changes, and tweens between the answers.
 */
/** A choice: words a tap answers, in the flow, that are not a control standing in a line's place. */
function isChoice(unit: Unit): boolean {
  return unit.main.item.style.tap && unit.main.item.reserve === undefined;
}

interface FootRow {
  readonly blocks: Block[];
  readonly width: number;
  readonly height: number;
}

/** The choices set in rows across `width`: each row as many as fit, the rest wrap. */
function footRows(units: readonly Unit[], width: number, ctx: Context): { rows: FootRow[]; height: number; vgap: number; hgap: number } {
  // the choices are set a little smaller before they wrap onto a second row: the foot is room taken from everything else
  let laid = footRowsAt(units, width, ctx, 1);
  for (const k of [0.85, 0.72]) {
    if (laid.rows.length <= 1) break;
    const tighter = footRowsAt(units, width, ctx, k);
    if (tighter.rows.length < laid.rows.length) laid = tighter;
  }
  return laid;
}

function footRowsAt(units: readonly Unit[], width: number, ctx: Context, k: number): { rows: FootRow[]; height: number; vgap: number; hgap: number } {
  const hgap = 2 * ctx.bodyW;
  const vgap = ctx.bodyH * 0.75;
  const rows: { blocks: Block[]; width: number; height: number }[] = [];
  for (const unit of units) {
    const block = makeBlock(unit.main, k, width, 0, null, ctx);
    const last = rows[rows.length - 1];
    if (last !== undefined && last.width + hgap + block.width <= width + EPS) {
      last.blocks.push(block);
      last.width += hgap + block.width;
      last.height = Math.max(last.height, block.height);
    } else rows.push({ blocks: [block], width: block.width, height: block.height });
  }
  const height = rows.reduce((sum, row) => sum + row.height, 0) + Math.max(0, rows.length - 1) * vgap;
  return { rows, height, vgap, hgap };
}

function contextOf(input: LayoutInput, safe: Box): Context {
  const { look, viewport } = input;
  const body = cellOf('m', viewport, look);
  return { input, look, viewport, snap: look.type.snapToCells, bodyW: body.width, bodyH: body.height, safe };
}

/**
 * Decides where everything on stage sits for one layout epoch. Pure and
 * deterministic: the same input always gives the same arrangement, and it
 * knows nothing about time. The engine calls it whenever the set of things on
 * stage, the plan, or the viewport changes, and tweens between the answers.
 */
export function arrange(input: LayoutInput): Arrangement {
  const { look, viewport } = input;
  const ctx = contextOf(input, input.flow ?? safeFrame(viewport, look));
  const built = buildUnits(input, look);
  const { loose } = built;
  const overflow: string[] = [];
  const footed: Unit[] = [];
  let flow = built.flow;
  if (input.foot !== undefined) {
    footed.push(...flow.filter(isChoice));
    flow = flow.filter((unit) => !isChoice(unit));
  }
  const result = arrangeFlow(flow, ctx);
  overflow.push(...result.overflow);
  const occupied: Record<Layer, Rect[]> = { far: [], bg: [], mid: [], fg: [] };
  for (const placement of result.placements) occupy(placement, occupied.mid);
  const foot = input.foot;
  const footPlacements: Placement[] = [];
  if (foot !== undefined) {
    // the oldest choices let go when the foot cannot hold all of them
    let shown = footed;
    let laid = footRows(shown, foot.width, ctx);
    while (laid.height > foot.height + EPS && shown.length > 1) {
      const [gone, ...kept] = shown;
      if (gone !== undefined) overflow.push(gone.main.item.key);
      shown = kept;
      laid = footRows(shown, foot.width, ctx);
    }
    let top = foot.y;
    for (const row of laid.rows) {
      let left = foot.x + (foot.width - row.width) / 2;
      for (const block of row.blocks) {
        const placement = emit(block, left, top + (row.height - block.height) / 2, block.width, 'center', ctx);
        footPlacements.push(placement);
        occupy(placement, occupied.mid);
        left += block.width + laid.hgap;
      }
      top += row.height + laid.vgap;
    }
  }
  const flowOccupied = [...occupied.mid];
  const free = arrangeLoose(loose, ctx, flowOccupied, occupied, result.regions);
  const placements = new Map<string, Placement>();
  for (const placement of [...result.placements, ...footPlacements, ...free]) placements.set(placement.key, placement);
  return { placements, next: result.next, overflow };
}

/**
 * What the stage plan needs to know of the words before it divides the stage (PLAN-v2.1, D1): how tall the flow is across a column `width`
 * wide with all that is expected come, and how tall the choices are across the same width. Set with the very code `arrange` uses.
 */
export function needsOf(input: LayoutInput, width: number): { readonly flow: number; readonly foot: number; readonly order: number | null; readonly least: number } {
  const { look } = input;
  const ctx = contextOf(input, { x: -width / 2, y: -1e6, width, height: 2e6 });
  const built = buildUnits(input, look);
  const choices = input.foot === undefined ? [] : built.flow.filter(isChoice);
  const flow = input.foot === undefined ? built.flow : built.flow.filter((unit) => !isChoice(unit));
  const flowNeed = flow.length === 0 && (input.expected ?? 0) <= 0 ? 0 : arrangeFlow(flow, ctx).need;
  const order = flow.length === 0 ? null : Math.min(...flow.map((unit) => unit.main.item.order));
  // the least the words can be given and still show what matters: the headings and the tallest single line under them, which is what a full column keeps
  let least = 0;
  if (flowNeed > 0) {
    const headings = flow.filter(isHeading);
    const bodies = flow.filter((unit) => !isHeading(unit));
    least = headings.length === 0 ? 0 : arrangeFlow(headings, ctx).need;
    for (const unit of bodies) least = Math.max(least, arrangeFlow([...headings, unit], ctx).need);
    least = Math.min(least, flowNeed);
  }
  return { flow: flowNeed, foot: choices.length === 0 ? 0 : footRows(choices, width, ctx).height, order, least };
}

// ---------------------------------------------------------------- one block of words

/** What the structure engines are handed to size text, and what the painter sets a structure's words with: the very same code the flow uses. */
export interface SetText {
  /** the placement of the block with its centre at the origin, `width` wide when `width` was given and as wide as its longest line when not */
  readonly placement: Placement;
  /** the widest line, layer units */
  readonly widest: number;
  readonly lines: readonly { readonly text: string; readonly width: number }[];
  readonly lineHeight: number;
  readonly fontSize: number;
}

interface SetTextInput {
  readonly look: LookSpec;
  readonly viewport: Viewport;
  readonly text: string;
  readonly emphasis: readonly Range[];
  /** the style it is set in; only size, weight, face and case are read, and `layer` says which plane's units the answer is in */
  readonly style: ElementStyle;
  /** the share of the look's size it is shrunk to (1: as the look has it) */
  readonly shrink: number;
  /** the room across, in layer units */
  readonly maxWidth: number;
  /** the width of the block when it is to be set inside a wider box; absent: its own widest line */
  readonly width?: number;
  readonly align: 'left' | 'center' | 'right';
}

const NO_INPUT: LayoutInput = { viewport: { width: 1, height: 1, dpr: 1 }, look: undefined as unknown as LookSpec, layout: 'free', align: 'auto', expected: null, items: [] };

/** Sets words exactly as the flow would, away from the flow: the measure behind `TextMeasure` and the runs behind a node's words. */
export function setText(input: SetTextInput): SetText {
  const { look, viewport } = input;
  const body = cellOf('m', viewport, look);
  const ctx: Context = { input: { ...NO_INPUT, viewport, look }, look, viewport, snap: false, bodyW: body.width, bodyH: body.height, safe: safeFrame(viewport, look) };
  const item: LayoutItem = { key: '', order: 0, text: input.text, emphasis: input.emphasis, style: input.style, struck: false, replaces: null };
  const prep = prepare(item, look);
  const block = makeBlock(prep, Math.max(0.05, input.shrink), Math.max(1, input.maxWidth), 0, null, ctx);
  const width = input.width ?? block.width;
  const placement = emit(block, -width / 2, -block.height / 2, width, input.align, ctx);
  return {
    placement: { ...placement, x: 0, y: 0 },
    widest: block.width,
    lines: block.spans.map((span, row) => ({ text: prep.text.slice(span.start, span.end), width: block.lineWidths[row] ?? 0 })),
    lineHeight: block.cell.height,
    fontSize: block.cell.fontSize,
  };
}
