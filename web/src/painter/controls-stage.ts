// Controls on the stage: where one is, what it looks like under the hand, and how a pointer finds its parts.
//
// The engine (painter/controls) lays a control out in its own coordinates, origin at its centre, and knows nothing of the stage. This file
// lays it where the flow (or its `at=`) put it, in the units of its layer's plane, and hands its parts to the same renderer a structure's go
// through. Layouts are remembered: the same control in the same mood and value is laid out once, however many frames show it.

import type { BlockPart } from '../contracts/blocks';
import type { ControlInput, ControlLayout, ControlMood } from '../contracts/controls';
import type { ElementSpan, ControlValue } from '@conduit/language';
import type { LookSpec } from '../contracts/look';
import type { Box, Viewport } from '../contracts/space';
import { planeScale } from '../contracts/space';
import type { CanvasFit } from './canvas';
import { controlEngine } from './controls';
import { lookOf, measurerFor } from './structures';
import { controlSpecOf } from './bound';
import { askSignature } from './controls/ask-state';
import { chevron, rectLine, segment, shapePart } from './controls/shapes';

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
  /** how closely the scene's controls are set (see `ControlInput.compact`) */
  readonly compact?: 0 | 1 | 2 | 3;
}

/** What the engine is handed for one control: also what it is asked to turn a pointer into a value with. */
export function controlInputOf(args: ControlLayoutArgs): ControlInput | null {
  const { span, value, mood, maxWidth, look, viewport, fit, compact = 0 } = args;
  const spec = controlSpecOf(span);
  if (spec === null) return null;
  const ps = planeScale(span.style.layer, viewport);
  return { control: span, spec, value, maxWidth, measure: measurerFor(look, viewport, span.style), look: lookOf(look, viewport, fit, ps), minTarget: targetPx() / ps, mood, compact };
}

export function controlLayoutOf(args: ControlLayoutArgs): ControlLayout | null {
  const { span, value, mood, maxWidth, look, viewport } = args;
  const key = [span.key, String(value), mood.hover ? 1 : 0, mood.pressed ?? '', mood.focus ? 1 : 0, mood.open ? 1 : 0, maxWidth.toFixed(1), targetPx(), look.id, look.name, viewport.width, viewport.height, span.text, span.style.size, span.style.face ?? '', args.compact ?? 0, askSignature(span)].join('|');
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
  /** a control in a controls area that scrolls: the box (its layer's plane units) it shows through, and how far the area can scroll */
  readonly window?: { readonly box: Box; readonly scene: string; readonly offset: number; readonly max: number; readonly step: number };
}

/** Where the cues of a scrolling controls area stand, in the area's plane units: a column of its own at the window's right, the way up at its top, the way down at its foot. */
export function scrollCueBoxes(window: Box, target: number): { readonly up: Box; readonly down: Box; readonly track: Box } {
  const x = window.x + window.width - target;
  return {
    up: { x, y: window.y, width: target, height: target },
    down: { x, y: window.y + window.height - target, width: target, height: target },
    track: { x: x + target / 2 - 1, y: window.y + target, width: 2, height: Math.max(0, window.height - 2 * target) },
  };
}

/** What draws the cues, in plane units, owned by one control of the area: a chevron at each end, and a track with a thumb between that says how far the area is scrolled. */
export function scrollCues(owner: string, window: Box, offset: number, max: number, target: number): BlockPart[] {
  const cue = scrollCueBoxes(window, target);
  const parts: BlockPart[] = [];
  const s = target / 5;
  const mid = (b: Box): { x: number; y: number } => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
  if (max > 0) {
    const up = mid(cue.up);
    const down = mid(cue.down);
    const role = (live: boolean): 'line' | 'grid' => (live ? 'line' : 'grid');
    parts.push(shapePart(owner, 'cue-up', role(offset > 0.5), [{ closed: false, points: [{ x: up.x - s, y: up.y + s / 2 }, { x: up.x, y: up.y - s / 2 }, { x: up.x + s, y: up.y + s / 2 }] }]));
    parts.push(shapePart(owner, 'cue-down', role(offset < max - 0.5), [chevron(down.x, down.y, 2 * s, 'down')]));
    if (cue.track.height > 0) {
      const share = Math.min(1, window.height / (window.height + max));
      const thumb = Math.max(cue.track.height * share, target / 2);
      const top = cue.track.y + (cue.track.height - thumb) * (offset / max);
      parts.push(shapePart(owner, 'cue-track', 'grid', [segment(cue.track.x + 1, cue.track.y, cue.track.x + 1, cue.track.y + cue.track.height)]));
      parts.push(shapePart(owner, 'cue-thumb', 'bar', [rectLine({ x: cue.track.x - 1, y: top, width: 4, height: thumb }, 2)]));
    }
  }
  return parts;
}
