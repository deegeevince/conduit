// The control engine and the store of what controls hold (PLAN-v2.md, package C).
//
//   engine.ts    layout, valueAt and valueAfter for each kind, in the look's own idiom
//   card.ts      the frame of a `card`
//   store.ts     the ControlStore, and `declare`: a value survives a redeclaration of the same id, kind and range
//   driven.ts    applying an element's `driven` changes: progress from `bindProgress` (language),
//                eased for on/off bindings over BOUND_SECONDS on the ambient clock, composed in the order written
//   template.ts  `{…}` in text: `parseTemplate` (language) once per element, values every frame
//   bench.ts     run under tsx: `pnpm --filter @conduit/language exec tsx ../web/src/painter/controls/bench.ts`
//
// Each kind is added to CONTROLS_READY only when it can be drawn, worked by
// pointer and keyboard, and bound: the painter advertises exactly this list.

import type { ControlKind } from '@conduit/language';

export { layoutCard } from './card';
export type { CardInput, CardLayout } from './card';
export { applyDriven, boundAmount, drivenLayers, easing, nextEases } from './driven';
export type { BoundEase, ControlState, Driven, DrivenLayer, DrivenMorph, DrivenMove, Tint } from './driven';
export { controlEngine, snapSlider } from './engine';
export { controlSignature, createControlStore } from './store';
export type { ControlRegistry } from './store';
export { compileTemplate, renderTemplate, scopeOf } from './template';
export type { ControlLookup, RenderedTemplate, Template } from './template';

/** The controls this painter can draw and work today. */
export const CONTROLS_READY: readonly ControlKind[] = ['button', 'toggle', 'slider', 'pick', 'input'];
