// What a control does to the stage, with no round trip to the brain.
//
// `bind` gives an element `driven` changes (language/schedule.ts). Each says:
// while this control holds this, the element is this much of the way to that.
// The functions here work out, from the controls' values and the ambient
// clock, how far along each change is and what the element then looks like.
// They are pure: the painter hands in the numbers and gets the answer, a
// frame is still a function of (time, paintings, control values), and an
// exported film gets exactly what the screen showed.
//
//   1. `nextEases` and `drivenLayers`: how far along every change is. A slider
//      (`whole`, `range`) is exactly as far along as the slider is, with no
//      easing of its own, so the picture is under the finger. A change that
//      is on or off (`is`: a toggle, a pick's option) eases over
//      `BOUND_SECONDS` of ambient time. Reduced motion changes neither.
//   2. `applyDriven`: the layers composed, in the order written, each from
//      where the one before left off, on the element's style at that moment.

import { bindProgress, BOUND_SECONDS, patchStyle } from '@conduit/language';
import type { Anchor, ControlSpec, ControlValue, DrivenChange, ElementStyle, Paint, Point, Range, ResolvedProps, ShapeGeometry } from '@conduit/language';

/** What a bound change reads from its control. */
export interface ControlState {
  readonly spec: ControlSpec;
  readonly value: ControlValue | null;
}

/** A change on its way between 0 and 1 (and back): where it was, where it is going, and when it set off, on the ambient clock. */
export interface BoundEase {
  readonly from: number;
  readonly to: number;
  readonly since: number;
}

/** How far a change is along, as a share, with its ease in the frame at `now`: smooth at both ends. */
export function boundAmount(ease: BoundEase, now: number): number {
  const t = Math.min(1, Math.max(0, (now - ease.since) / BOUND_SECONDS));
  const eased = t * t * (3 - 2 * t);
  return ease.from + (ease.to - ease.from) * eased;
}

const SETTLED = -1e9;

function easeKey(change: DrivenChange): string {
  return `${change.seq}:${change.control}`;
}

/**
 * The eases after the controls changed (or a binding arrived). Call it when
 * the store's revision moves or when an element with `driven` appears; the
 * result is what `drivenLayers` reads until the next call. A change seen for
 * the first time starts settled, so a carried stage does not replay itself.
 * An ease that is interrupted turns round from where it had got to.
 */
export function nextEases(driven: readonly DrivenChange[], stateOf: (controlKey: string) => ControlState | null, previous: ReadonlyMap<string, BoundEase>, now: number): Map<string, BoundEase> {
  const next = new Map<string, BoundEase>();
  for (const change of driven) {
    if (change.on.kind !== 'is') continue;
    const state = stateOf(change.control);
    if (state === null) continue;
    const key = easeKey(change);
    const target = bindProgress(change.on, state.spec, state.value);
    const before = next.get(key) ?? previous.get(key);
    if (before === undefined) next.set(key, { from: target, to: target, since: SETTLED });
    else if (before.to === target) next.set(key, before);
    else next.set(key, { from: boundAmount(before, now), to: target, since: now });
  }
  return next;
}

export interface DrivenLayer {
  readonly change: DrivenChange;
  /** 0..1: how far along the change is in this frame */
  readonly amount: number;
}

/** Every change's progress this frame, in the order written. A change whose control has left the stage is not applied. */
export function drivenLayers(driven: readonly DrivenChange[], stateOf: (controlKey: string) => ControlState | null, eases: ReadonlyMap<string, BoundEase>, now: number): DrivenLayer[] {
  const layers: DrivenLayer[] = [];
  for (const change of driven) {
    const state = stateOf(change.control);
    if (state === null) continue;
    let amount: number;
    if (change.on.kind === 'is') {
      const ease = eases.get(easeKey(change));
      amount = ease === undefined ? bindProgress(change.on, state.spec, state.value) : boundAmount(ease, now);
    } else amount = bindProgress(change.on, state.spec, state.value);
    layers.push({ change, amount: Math.min(1, Math.max(0, amount)) });
  }
  return layers;
}

/** Whether any change is still moving: the painter keeps drawing frames while this is true even if nothing else is. */
export function easing(eases: ReadonlyMap<string, BoundEase>, now: number): boolean {
  for (const ease of eases.values()) if (ease.from !== ease.to && now - ease.since < BOUND_SECONDS) return true;
  return false;
}

/** A paint on its way to another: the painter mixes in the look's own colour space. */
export type Tint = Paint | { readonly from: Tint; readonly to: Tint; readonly t: number };

export interface DrivenMove {
  readonly to: Anchor | Point;
  /** key of the drawn shape it travels along; null: a straight line */
  readonly along: string | null;
  /** how far along, 0..1, from where the layer before left it */
  readonly t: number;
}

export interface DrivenMorph {
  readonly geometry: ShapeGeometry;
  readonly t: number;
}

export interface Driven {
  /** the element's style with every change applied: numbers blended, words swapped past halfway, paints resolved to the nearer */
  readonly style: ElementStyle;
  /** the paints that are mid-way, for a renderer that can mix them exactly; absent when the style's own paint is what is wanted */
  readonly tints: { readonly ink?: Tint; readonly stroke?: Tint; readonly fill?: Tint };
  readonly moves: readonly DrivenMove[];
  readonly morphs: readonly DrivenMorph[];
  /** the words the element has while a binding holds, or null for its own */
  readonly text: { readonly text: string; readonly emphasis: readonly Range[] } | null;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

type Blendable = 'opacity' | 'scale' | 'rot' | 'thick' | 'soft';

/** The numeric properties and what they are when nothing says otherwise; a `null` base (the look's own) cannot be blended from, so it steps. */
const NUMERIC: readonly { readonly key: Blendable; readonly rest: number | null }[] = [
  { key: 'opacity', rest: 1 },
  { key: 'scale', rest: 1 },
  { key: 'rot', rest: 0 },
  { key: 'thick', rest: null },
  { key: 'soft', rest: 0 },
];

function blendPaint(from: Tint, to: Paint, t: number): Tint {
  return t >= 1 ? to : t <= 0 ? from : { from, to, t };
}

function nearer(tint: Tint): Paint {
  return typeof tint === 'string' ? tint : tint.t >= 0.5 ? nearer(tint.to) : nearer(tint.from);
}

/** `set`'s properties applied `t` of the way to `style`. */
function applyProps(style: ElementStyle, tints: { ink?: Tint; stroke?: Tint; fill?: Tint }, props: ResolvedProps, t: number): ElementStyle {
  let out = style;
  const numeric: { -readonly [K in Blendable]?: number } = {};
  for (const { key, rest } of NUMERIC) {
    const target = props[key];
    if (typeof target !== 'number') continue;
    const base = out[key] ?? rest;
    if (base !== null) numeric[key] = lerp(base, target, t);
    else if (t >= 0.5) numeric[key] = target;
  }
  // paints: ink, stroke and (plain) fill blend; a gradient or `none` steps at the half
  for (const key of ['ink', 'stroke', 'fill'] as const) {
    const target = props[key];
    if (target === undefined) continue;
    const current = out[key];
    if (typeof target === 'string' && target !== 'none' && typeof current === 'string' && current !== 'none') {
      const mixed = blendPaint(tints[key] ?? current, target, t);
      tints[key] = mixed;
      out = { ...out, [key]: nearer(mixed) };
    } else if (t >= 0.5) {
      delete tints[key];
      out = { ...out, [key]: target };
    }
  }
  // what blends was handled above; patching the rest at the half sets the same values the blends have reached by then
  if (t >= 0.5) out = patchStyle(out, props);
  return { ...out, ...numeric };
}

/**
 * The element with its bound changes applied, in the order written, each from
 * where the one before left it. A layer at 0 does nothing at all, and a layer
 * at 1 is exactly what the same line would have left on the clock.
 */
export function applyDriven(base: ElementStyle, layers: readonly DrivenLayer[]): Driven {
  let style = base;
  const tints: { ink?: Tint; stroke?: Tint; fill?: Tint } = {};
  const moves: DrivenMove[] = [];
  const morphs: DrivenMorph[] = [];
  let text: Driven['text'] = null;
  for (const { change, amount } of layers) {
    if (amount <= 0) continue;
    const effect = change.effect;
    switch (effect.kind) {
      case 'set':
        style = applyProps(style, tints, effect.props, amount);
        break;
      case 'move':
        moves.push({ to: effect.to, along: effect.along, t: amount });
        break;
      case 'morph':
        morphs.push({ geometry: effect.geometry, t: amount });
        style = applyProps(style, tints, effect.props, amount);
        break;
      case 'text':
        if (amount >= 0.5) text = { text: effect.text, emphasis: effect.emphasis };
        break;
    }
  }
  return { style, tints, moves, morphs, text };
}
