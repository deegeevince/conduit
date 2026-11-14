// Controls on the stage: where one is, what it looks like under the hand, and how a pointer finds its parts.
//
// The engine (painter/controls) lays a control out in its own coordinates, origin at its centre, and knows nothing of the stage. This file
// lays it where the flow (or its `at=`) put it, in the units of its layer's plane, and hands its parts to the same renderer a structure's go
// through. Layouts are remembered: the same control in the same mood and value is laid out once, however many frames show it.

import type { BlockPart } from '../contracts/blocks';
import type { ControlInput, ControlLayout, ControlMood } from '../contracts/controls';
import type { ElementSpan, ControlValue } from '@conduit/language';
import type { LookSpec } from '../contracts/look';
import type { Viewport } from '../contracts/space';
import { planeScale } from '../contracts/space';
import type { CanvasFit } from './canvas';
import { controlEngine } from './controls';
import { lookOf, measurerFor } from './structures';
import { controlSpecOf } from './bound';

import { targetPx } from './target';

const LAYOUTS = new Map<string, ControlLayout>();
const KEPT_LAYOUTS = 400;

export interface ControlLayoutArgs {
  readonly span: ElementSpan;
  readonly value: ControlValue | null;
  readonly mood: ControlMood;
  /** the widest it may be, in its layer's plane units */
  readonly maxWidth: number;
  readonly look: LookSpec;
  readonly viewport: Viewport;
  readonly fit: CanvasFit;
}

/** What the engine is handed for one control: also what it is asked to turn a pointer into a value with. */
export function controlInputOf(args: ControlLayoutArgs): ControlInput | null {
  const { span, value, mood, maxWidth, look, viewport, fit } = args;
  const spec = controlSpecOf(span);
  if (spec === null) return null;
  const ps = planeScale(span.style.layer, viewport);
  return { control: span, spec, value, maxWidth, measure: measurerFor(look, viewport, span.style), look: lookOf(look, viewport, fit, ps), minTarget: targetPx() / ps, mood };
}

export function controlLayoutOf(args: ControlLayoutArgs): ControlLayout | null {
  const { span, value, mood, maxWidth, look, viewport } = args;
  const key = [span.key, String(value), mood.hover ? 1 : 0, mood.pressed ?? '', mood.focus ? 1 : 0, mood.open ? 1 : 0, maxWidth.toFixed(1), targetPx(), look.id, look.name, viewport.width, viewport.height, span.text, span.style.size, span.style.face ?? ''].join('|');
  const known = LAYOUTS.get(key);
  if (known !== undefined) return known;
  const input = controlInputOf(args);
  if (input === null) return null;
  const made = controlEngine.layout(input);
  LAYOUTS.set(key, made);
  if (LAYOUTS.size > KEPT_LAYOUTS) LAYOUTS.delete(LAYOUTS.keys().next().value as string);
  return made;
}

/** The parts moved by (dx, dy), where the control stands. */
export function placeParts(parts: readonly BlockPart[], dx: number, dy: number): BlockPart[] {
  return parts.map((part) =>
    part.kind === 'text'
      ? { ...part, box: { ...part.box, x: part.box.x + dx, y: part.box.y + dy } }
      : { ...part, outline: part.outline.map((line) => ({ closed: line.closed, points: line.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) })) },
  );
}

/** A control as the stage has it at one instant: what the pointer and the app work from. */
export interface ControlSite {
  readonly key: string;
  readonly id: string;
  readonly span: ElementSpan;
  readonly layout: ControlLayout;
  /** what the engine reads to turn a pointer or a key into a value */
  readonly input: ControlInput;
  readonly value: ControlValue | null;
  readonly layer: ElementSpan['style']['layer'];
  /** its centre, in its layer's plane units, camera at rest */
  readonly centre: { readonly x: number; readonly y: number };
  /** its centre on screen, host CSS pixels, and screen pixels per plane unit there */
  readonly screen: { readonly x: number; readonly y: number; readonly scale: number };
  /** worked only when it is whole: not entering, not leaving */
  readonly enabled: boolean;
}
