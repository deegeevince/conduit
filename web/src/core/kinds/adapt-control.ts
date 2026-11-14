// An adapter: the control engine of today (`painter/controls/engine.ts`) as the five control kinds of the new contract, its code where it is.
//
// The engine draws a control about its own centre; a leaf is drawn relative to its box's corner, so the adapter lays the control out at its
// natural size and stands it at the middle of the box it is given. `valueAt` and `valueAfter` are the whole of `input`: the held value in,
// the held value out, and a line for the mind on a commit (a press, a drag's end, a typed line's return).
//
// What a hand has done is `held`; the control's `mood` (hover, press, focus) is the pointer's and is not held, so a leaf here is always
// calm. The pointer reaches `Env` by PC8.

import { controlText } from '@conduit/language';
import type { ControlKind, ControlSpec, ControlValue, ElementSpan } from '@conduit/language';
import type { BlockPart } from '../../contracts/blocks';
import { CALM } from '../../contracts/controls';
import type { ControlInput, ControlKey, ControlLayout, ControlZone } from '../../contracts/controls';
import { controlSpecOf } from '../../painter/bound';
import { controlEngine } from '../../painter/controls/engine';
import type { Held } from '../../../../language/src/kinds';
import type { CensusWord, Drawn, Emit, Env, InputResult, Kind, LeafCensus, LeafEvent, Region, Size2 } from '../contracts';

export interface ControlModel {
  readonly element: ElementSpan;
  readonly spec: ControlSpec;
  /** what it holds: the hand's value, or what the brain wrote */
  readonly value: ControlValue | null;
}

export interface ControlLeaf {
  readonly model: ControlModel;
  readonly size: Size2;
  /** the engine's layout, about its own centre */
  readonly natural: ControlLayout;
  /** where the control's centre is in the box */
  readonly at: { readonly x: number; readonly y: number };
  readonly parts: readonly BlockPart[];
  readonly zones: readonly ControlZone[];
  readonly words: readonly CensusWord[];
  /** what it was laid out in: `valueAt` needs the measure and the look again, and a kind keeps no state of its own */
  readonly env: Env;
}

const WIDEST = 1e6;

function inputFor(model: ControlModel, maxWidth: number, env: Env): ControlInput {
  return { control: model.element, spec: model.spec, value: model.value, maxWidth, measure: env.measure, look: env.tokens, minTarget: env.tokens.minTarget, mood: CALM };
}

function shiftPart(part: BlockPart, dx: number, dy: number): BlockPart {
  if (part.kind === 'text') return { ...part, box: { ...part.box, x: part.box.x + dx, y: part.box.y + dy } };
  return { ...part, outline: part.outline.map((line) => ({ ...line, points: line.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) })) };
}

const shiftZone = (zone: ControlZone, dx: number, dy: number): ControlZone => ({ ...zone, box: { ...zone.box, x: zone.box.x + dx, y: zone.box.y + dy } });

function regionRole(zone: ControlZone): Region['role'] {
  if (zone.part === 'switch') return 'switch';
  if (zone.drag) return 'drag';
  if (zone.part === 'field') return 'type';
  if (zone.part.startsWith('option') || zone.part === 'list') return 'choose';
  return 'press';
}

/** A hand's event as the engine hears it: a value from a point, or from a key. `null`: it means nothing here. */
function valueFor(leaf: ControlLeaf, held: ControlValue | null, event: LeafEvent, env: Env): ControlValue | null {
  const input = inputFor({ ...leaf.model, value: held }, leaf.size.width, env);
  if (event.type === 'key') return controlEngine.valueAfter(input, event.key);
  if (event.type === 'text') return leaf.model.spec.control === 'input' ? event.value : null;
  const zone = leaf.zones.find((candidate) => candidate.part === event.part);
  if (zone === undefined) return null;
  const natural = leaf.natural.zones.find((candidate) => candidate.part === event.part);
  if (natural === undefined) return null;
  return controlEngine.valueAt(input, leaf.natural, natural, { x: event.x - leaf.at.x, y: event.y - leaf.at.y });
}

export interface ControlKindOptions<K extends ControlKind> {
  readonly id: K;
  readonly fixtures: readonly (readonly string[])[];
}

export function controlKind<K extends ControlKind>(options: ControlKindOptions<K>): Kind<K, ControlModel, ControlLeaf> {
  const { id } = options;
  // `Held<K>` is boolean, number, string or null by the kind; a ControlValue is the union of the first three. One cast, at the edge.
  const toValue = (held: Held<K>): ControlValue | null => held as unknown as ControlValue | null;
  const fromValue = (value: ControlValue | null): Held<K> => value as unknown as Held<K>;
  return {
    id,
    status: { state: 'ready' },
    model(element, _parts, held) {
      // total: an element that is not a control is held as a bare one of this kind, never thrown at
      const spec = controlSpecOf(element) ?? { control: id, form: null, options: [], min: 0, max: 1, step: null, unit: null, value: null, send: false };
      const heldValue = toValue(held);
      return { element, spec, value: heldValue ?? spec.value };
    },
    measure(model, constraint, env) {
      const natural = controlEngine.layout(inputFor(model, constraint.maxWidth, env));
      const narrowest = controlEngine.layout(inputFor(model, 1, env));
      return {
        width: Math.min(constraint.maxWidth, natural.width),
        height: Math.min(constraint.maxHeight, natural.height),
        least: { width: Math.min(narrowest.width, natural.width), height: natural.height },
        fit: 'reflow',
      };
    },
    layout(model, size, env) {
      const natural = controlEngine.layout(inputFor(model, Math.min(size.width, WIDEST), env));
      const at = { x: size.width / 2, y: size.height / 2 };
      const parts = natural.parts.map((part) => shiftPart(part, at.x, at.y));
      const zones = natural.zones.map((zone) => shiftZone(zone, at.x, at.y));
      const words: CensusWord[] = [];
      for (const part of parts) {
        if (part.kind !== 'text' || part.text.trim() === '') continue;
        words.push({ part: part.part, text: part.text, box: part.box, px: env.px(part.spec), colour: env.ink(part.role === 'value' ? 'dim' : 'ink'), on: env.ground });
      }
      return { model, size, natural, at, parts, zones, words, env };
    },
    draw(leaf, phase): Drawn {
      return { parts: leaf.parts.map((part) => ({ part, opacity: phase.presence })), frames: null, surface: null };
    },
    census(leaf): LeafCensus {
      const label = leaf.model.element.text.trim();
      return { words: leaf.words, regions: leaf.zones.map((zone) => ({ part: zone.part, box: zone.box, role: regionRole(zone), label })) };
    },
    input(leaf, held, event): InputResult<K> | null {
      const env = leaf.env;
      const spec = leaf.model.spec;
      const label = leaf.model.element.text.trim();
      const before = toValue(held) ?? spec.value;
      // a button holds nothing: a press is an event
      if (spec.control === 'button') {
        const pressed = event.type === 'press' || (event.type === 'key' && event.key === 'act');
        return pressed ? { held: fromValue(null), emit: { send: true, text: label } } : null;
      }
      const next = valueFor(leaf, before, event, env);
      if (next === null) return null;
      const commit = event.type === 'press' || event.type === 'key' || (event.type === 'drag' && event.end) || (event.type === 'text' && event.commit);
      const emit: Emit | null = commit ? { send: spec.send, text: `${label === '' ? spec.control : label}: ${controlText(spec, next)}` } : null;
      return { held: fromValue(next), emit };
    },
    fixtures: options.fixtures,
  };
}

export type { ControlKey };
