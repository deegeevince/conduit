// The control engine and the store of what controls hold. STUB: nothing is
// drawn or worked yet (PLAN-v2.md, package C).
//
// What goes here:
//   engine.ts    layout, valueAt and valueAfter for each kind, in the look's own idiom
//   store.ts     the ControlStore
//   driven.ts    applying an element's `driven` changes: progress from `bindProgress` (language),
//                eased for on/off bindings over BOUND_SECONDS on the ambient clock, composed in the order written
//   template.ts  `{…}` in text: `parseTemplate` (language) once per element, values every frame
//
// Each kind is added to CONTROLS_READY only when it can be drawn, worked by
// pointer and keyboard, and bound: the painter advertises exactly this list.

import type { ControlKind, ControlValue, ControlValues } from '@conduit/language';
import type { ControlEngine, ControlStore } from '../../contracts/controls';

/** The controls this painter can draw and work today. */
export const CONTROLS_READY: readonly ControlKind[] = [];

export const controlEngine: ControlEngine = {
  layout: () => ({ width: 0, height: 0, parts: [], zones: [] }),
  valueAt: () => null,
  valueAfter: () => null,
};

export function createControlStore(): ControlStore {
  const held = new Map<string, ControlValue>();
  let revision = 0;
  return {
    get: (key) => held.get(key),
    set(key, value) {
      if (held.get(key) === value) return;
      held.set(key, value);
      revision += 1;
    },
    drop(key) {
      if (held.delete(key)) revision += 1;
    },
    values(byId) {
      const out: Record<string, ControlValue> = {};
      for (const [id, key] of byId) {
        const value = held.get(key);
        if (value !== undefined) out[id] = value;
      }
      return out satisfies ControlValues;
    },
    get revision() {
      return revision;
    },
  };
}
