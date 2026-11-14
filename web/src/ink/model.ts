// The ink document: strokes with an undo and redo history, and its saved form.
//
// A document is vector JSON: points as [x, y, pressure, ms] in the units of the space it was drawn on (a page's pixels, a worksheet photo's pixels),
// so it can be replayed at any size. `serialize` rounds the numbers (a tenth of a unit, a hundredth of pressure) which is below what an eye or a
// pen can tell, and refuses ink larger than `INK_LIMITS`.

// the contract's own file, not the package's index: a surface's bundle takes only these checks and limits, not the whole language
import { INK_LIMITS, checkInkDocument } from '../../../language/src/ink';
import type { InkDocument, InkSpace, InkStroke } from '@conduit/language';

export class InkTooLarge extends Error {}

type Command =
  | { readonly kind: 'add'; readonly stroke: InkStroke }
  | { readonly kind: 'erase'; readonly before: readonly InkStroke[]; readonly removed: Set<string> }
  | { readonly kind: 'clear'; readonly removed: readonly InkStroke[] };

export class InkModel {
  private list: InkStroke[] = [];
  private undos: Command[] = [];
  private redos: Command[] = [];
  private open: Extract<Command, { kind: 'erase' }> | null = null;
  private next = 1;
  private listeners = new Set<() => void>();

  constructor(public space: InkSpace, strokes: readonly InkStroke[] = []) {
    this.list = [...strokes];
    for (const stroke of strokes) this.next = Math.max(this.next, Number(/^s(\d+)$/.exec(stroke.id)?.[1] ?? 0) + 1);
  }

  get strokes(): readonly InkStroke[] {
    return this.list;
  }
  get canUndo(): boolean {
    return this.undos.length > 0;
  }
  get canRedo(): boolean {
    return this.redos.length > 0;
  }
  get pointCount(): number {
    return this.list.reduce((n, stroke) => n + stroke.points.length, 0);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  newId(): string {
    const id = `s${this.next}`;
    this.next += 1;
    return id;
  }

  /** Whether another stroke of this many points fits the caps. */
  room(points: number): boolean {
    return this.list.length < INK_LIMITS.strokes && this.pointCount + points <= INK_LIMITS.points;
  }

  add(stroke: InkStroke): void {
    this.closeErase();
    this.list.push(stroke);
    this.undos.push({ kind: 'add', stroke });
    this.redos = [];
    this.changed();
  }

  /** Removes strokes. Calls within one gesture (between `beginErase` and `endErase`) are one step of history. */
  erase(ids: ReadonlySet<string>): boolean {
    const before = this.list;
    const hit = before.filter((stroke) => ids.has(stroke.id));
    if (hit.length === 0) return false;
    this.list = before.filter((stroke) => !ids.has(stroke.id));
    if (this.open !== null) {
      for (const stroke of hit) this.open.removed.add(stroke.id);
    } else {
      this.undos.push({ kind: 'erase', before, removed: new Set(hit.map((stroke) => stroke.id)) });
      this.redos = [];
    }
    this.changed();
    return true;
  }
  beginErase(): void {
    this.closeErase();
    this.open = { kind: 'erase', before: this.list, removed: new Set() };
  }
  endErase(): void {
    this.closeErase();
  }
  private closeErase(): void {
    if (this.open !== null && this.open.removed.size > 0) {
      this.undos.push(this.open);
      this.redos = [];
    }
    this.open = null;
  }

  clear(): void {
    this.closeErase();
    if (this.list.length === 0) return;
    this.undos.push({ kind: 'clear', removed: this.list });
    this.redos = [];
    this.list = [];
    this.changed();
  }

  /** Drops everything, history too (after a send). */
  reset(): void {
    this.list = [];
    this.undos = [];
    this.redos = [];
    this.open = null;
    this.changed();
  }

  undo(): boolean {
    this.closeErase();
    const command = this.undos.pop();
    if (command === undefined) return false;
    if (command.kind === 'add') this.list = this.list.filter((stroke) => stroke.id !== command.stroke.id);
    else if (command.kind === 'clear') this.list = [...command.removed];
    else this.list = [...command.before];
    this.redos.push(command);
    this.changed();
    return true;
  }

  redo(): boolean {
    const command = this.redos.pop();
    if (command === undefined) return false;
    if (command.kind === 'add') this.list = [...this.list, command.stroke];
    else if (command.kind === 'clear') this.list = [];
    else this.list = this.list.filter((stroke) => !command.removed.has(stroke.id));
    this.undos.push(command);
    this.changed();
    return true;
  }

  /** Replaces the strokes (a saved document opened again); history starts afresh. */
  load(doc: InkDocument): void {
    this.space = doc.space;
    this.list = [...doc.strokes];
    this.undos = [];
    this.redos = [];
    this.open = null;
    this.next = 1;
    for (const stroke of doc.strokes) this.next = Math.max(this.next, Number(/^s(\d+)$/.exec(stroke.id)?.[1] ?? 0) + 1);
    this.changed();
  }

  document(): InkDocument {
    return { v: 1, space: this.space, strokes: this.list };
  }
}

const r1 = (n: number): number => Math.round(n * 10) / 10;
const r2 = (n: number): number => Math.round(n * 100) / 100;

/** Rounds the numbers a saved or sent document carries. Never changes what it draws beyond a tenth of a unit. */
export function compact(doc: InkDocument): InkDocument {
  return {
    v: 1,
    space: { w: r1(doc.space.w), h: r1(doc.space.h) },
    strokes: doc.strokes.map((stroke) => ({ ...stroke, width: r2(stroke.width), points: stroke.points.map(([x, y, p, t]) => [r1(x), r1(y), r2(p), Math.round(t)] as const) })),
  };
}

/** The document as JSON text. Throws `InkTooLarge` when it is over the caps. */
export function serialize(doc: InkDocument): string {
  const small = compact(doc);
  const problem = checkInkDocument(small);
  if (problem !== null) throw new InkTooLarge(problem);
  const text = JSON.stringify(small);
  if (text.length > INK_LIMITS.bytes) throw new InkTooLarge(`ink is ${text.length} bytes; the most is ${INK_LIMITS.bytes}`);
  return text;
}

/** Reads what `serialize` wrote. Returns null for anything that is not ink, or is over the caps. */
export function parse(text: string): InkDocument | null {
  if (text.length > INK_LIMITS.bytes) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return checkInkDocument(value) === null ? (value as InkDocument) : null;
}
