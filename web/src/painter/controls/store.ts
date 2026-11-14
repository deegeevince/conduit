// What every control on stage holds. The only state on the stage that the
// user, not the brain, writes.
//
// A value belongs to an element KEY (a control declared again is a new
// element). Carrying it across is `declare`'s job: when a control arrives
// whose id was held by an earlier one, and whose kind and range are the same,
// the user's value moves to the newcomer, so a brain can restyle a slider
// without snapping it back. If the kind, the range, the step or the number of
// options differ, the user's value would mean something else, and the
// newcomer starts from what the brain wrote.

import type { ControlKind, ControlSpec, ControlValue, ControlValues } from '@conduit/language';
import type { ControlStore } from '../../contracts/controls';

/** What must be the same for a value to mean the same thing. */
export function controlSignature(spec: ControlSpec): string {
  const range = spec.control === 'slider' ? `${spec.min}:${spec.max}:${spec.step ?? ''}` : '';
  const options = spec.control === 'pick' ? String(spec.options.length) : '';
  return `${spec.control satisfies ControlKind}|${range}|${options}`;
}

/** The store, plus the one thing the painter does when a control is declared. */
export interface ControlRegistry extends ControlStore {
  /**
   * A control element has come into being (its key is new). If the user held
   * a value on a control of the same id, kind and range, the new control
   * holds it now. The older key's value is left alone: that element may still
   * be leaving, and the painter drops it when it has gone.
   */
  declare(key: string, id: string, spec: ControlSpec): void;
  /** A new question begins: what the hand left on the controls of an earlier answer is not carried to a control of the same id that this one declares. */
  restart(): void;
}

export function createControlStore(): ControlRegistry {
  const held = new Map<string, ControlValue>();
  const lastOfId = new Map<string, { readonly key: string; readonly signature: string }>();
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
    restart() {
      lastOfId.clear();
    },
    declare(key, id, spec) {
      const signature = controlSignature(spec);
      const before = lastOfId.get(id);
      lastOfId.set(id, { key, signature });
      if (before === undefined || before.key === key || before.signature !== signature) return;
      const value = held.get(before.key);
      if (value === undefined || held.has(key)) return;
      // a pick's option number must still be one of its options
      if (spec.control === 'pick' && (typeof value !== 'number' || value < 1 || value > spec.options.length)) return;
      if (spec.control === 'slider' && typeof value === 'number' && (value < Math.min(spec.min, spec.max) || value > Math.max(spec.min, spec.max))) return;
      held.set(key, value);
      revision += 1;
    },
    get revision() {
      return revision;
    },
  };
}
