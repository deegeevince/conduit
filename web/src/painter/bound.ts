// What the user's hand does to the stage between two frames: the values controls hold, how far each bound change is along, and the schedule
// a frame is drawn from once those changes are in it.
//
// A frame stays a pure function of (time, paintings, control values): this file only reads the runtime it is handed, and an element with a
// bound change is drawn from a COPY of its span that carries the change as if it were a line on the clock, pinned at the share the control
// says. So every renderer and every exporter sees the same picture the screen showed, with no second code path for it.

import { styleAt } from '@conduit/language';
import type { ControlSpec, ControlValue, ElementChange, ElementSpan, Range, Schedule } from '@conduit/language';
import { applyDriven, drivenLayers } from './controls';
import type { BoundEase, ControlState } from './controls';
import type { ControlMood } from '../contracts/controls';
import { CALM } from '../contracts/controls';
import type { ControlRegistry } from './controls';

/** What the stage reads of the hand. Live: the painter keeps it current, a film is given it whole. */
export interface ControlRuntime {
  readonly store: ControlRegistry;
  /** how far each `is` binding has eased, from `nextEases` */
  eases: ReadonlyMap<string, BoundEase>;
  /** the pointer and the keyboard, by control key */
  readonly moods: Map<string, ControlMood>;
  /** a menu is open on this control */
  open: string | null;
}

export function createRuntime(store: ControlRegistry): ControlRuntime {
  return { store, eases: new Map(), moods: new Map(), open: null };
}

export function moodOf(runtime: ControlRuntime, key: string): ControlMood {
  const found = runtime.moods.get(key) ?? CALM;
  return runtime.open === key && !found.open ? { ...found, open: true } : found;
}

export function specOf(span: ElementSpan): ControlSpec | null {
  const figure = span.figure;
  return figure !== null && figure.kind === 'control' ? figure : null;
}

/** What a control holds now: the user's value, or what the brain wrote. */
export function heldBy(runtime: ControlRuntime, span: ElementSpan): ControlValue | null {
  const spec = specOf(span);
  if (spec === null) return null;
  return runtime.store.get(span.key) ?? spec.value;
}

export interface ControlIndex {
  readonly byKey: ReadonlyMap<string, ElementSpan>;
  /** every driven change on the stage, in the order written */
  readonly driven: readonly ElementSpan['driven'][number][];
  readonly ids: ReadonlySet<string>;
}

const indexes = new WeakMap<Schedule, ControlIndex>();

export function controlIndexOf(schedule: Schedule): ControlIndex {
  const known = indexes.get(schedule);
  if (known !== undefined) return known;
  const byKey = new Map<string, ElementSpan>();
  const ids = new Set<string>();
  const driven: ElementSpan['driven'][number][] = [];
  for (const element of schedule.elements) {
    if (element.kind === 'control') {
      byKey.set(element.key, element);
      ids.add(element.id);
    }
    driven.push(...element.driven);
  }
  const made: ControlIndex = { byKey, driven, ids };
  indexes.set(schedule, made);
  return made;
}

/** A control is there to be read while it is on stage; before it enters or after it has gone nothing follows it. */
export function controlLive(span: ElementSpan, time: number): boolean {
  if (!span.carried && (span.enter === null || span.enter.start > time)) return false;
  return span.exit === null || time < span.exit.start;
}

export function stateReader(index: ControlIndex, runtime: ControlRuntime, time: number): (key: string) => ControlState | null {
  return (key) => {
    const span = index.byKey.get(key);
    if (span === undefined || !controlLive(span, time)) return null;
    const spec = specOf(span);
    return spec === null ? null : { spec, value: heldBy(runtime, span) };
  };
}

export interface BoundWords {
  readonly text: string;
  readonly emphasis: readonly Range[];
}

export interface BoundElement {
  readonly element: ElementSpan;
  /** the words a bound `text` change gives it; null for its own */
  readonly words: BoundWords | null;
}

const PIN = 1;

/**
 * The element as the hand has left it at `time`: its bound changes (those whose control is still there, and whose binding has begun and has not
 * ended) applied in the order written. `now` is ambient seconds, which is what `is` bindings ease on.
 */
export function boundElement(element: ElementSpan, time: number, now: number, index: ControlIndex, runtime: ControlRuntime): BoundElement {
  if (element.driven.length === 0) return { element, words: null };
  const live = element.driven.filter((change) => change.since <= time + 1e-9 && (change.until === undefined || time < change.until));
  if (live.length === 0) return { element, words: null };
  const layers = drivenLayers(live, stateReader(index, runtime, time), runtime.eases, now);
  if (layers.every((layer) => layer.amount <= 0)) return { element, words: null };
  const result = applyDriven(styleAt(element, time), layers);
  const extra: ElementChange[] = [{ kind: 'set', seq: -1, start: time - 2 * PIN, end: time - PIN, props: {}, style: result.style }];
  for (const move of result.moves) {
    const start = time - move.t * PIN;
    extra.push({ kind: 'move', seq: -1, start, end: start + PIN, to: move.to, along: move.along, style: result.style });
  }
  for (const morph of result.morphs) {
    const start = time - morph.t * PIN;
    extra.push({ kind: 'morph', seq: -1, start, end: start + PIN, geometry: morph.geometry, style: result.style });
  }
  const changes = [...element.changes, ...extra].sort((a, b) => a.start - b.start);
  return { element: { ...element, changes }, words: result.text };
}

/** The schedule with every bound element replaced by what the hand made of it, for the drawn figures; the same object when nothing is bound. */
export function boundSchedule(schedule: Schedule, time: number, now: number, runtime: ControlRuntime | undefined): Schedule {
  if (runtime === undefined) return schedule;
  const index = controlIndexOf(schedule);
  if (index.driven.length === 0) return schedule;
  let changed = false;
  const elements = schedule.elements.map((element) => {
    if (element.driven.length === 0 || element.kind === 'text') return element;
    const bound = boundElement(element, time, now, index, runtime);
    if (bound.element !== element) changed = true;
    return bound.element;
  });
  return changed ? { ...schedule, elements } : schedule;
}
