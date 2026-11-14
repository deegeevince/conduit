// One screen, laid out (PLAN-v2.2 E13): the tree the kit builds, the boxes the solver gives it, and the shapes and
// words each box is drawn as. Pure and deterministic: the same screen, look, measurer and state always give the same parts.

import type { UiScreen, UiTokens } from './lang';
import { UI_DEVICE_SIZE, linesPerScreen, parseInterface } from './lang';
import { buildScreen, makeKit } from './kit';
import type { Item, Out } from './kit';
import { lintScreen } from './lint';
import type { UiMeasure } from './measure';
import { solve, walk } from './solve';
import type { Placed } from './solve';
import { NO_STATE } from './types';
import type { UiHit, UiPart, UiScreenLayout, UiSlot, UiState } from './types';

export function layoutScreen(written: UiScreen, tokens: UiTokens, measure: UiMeasure, state: UiState = NO_STATE, lines = 0): UiScreenLayout {
  // `device` is a property that can be set: the same lines laid out on another device
  const screen: UiScreen = state.device[written.id] === undefined ? written : { ...written, device: state.device[written.id] ?? written.device };
  const size = UI_DEVICE_SIZE[screen.device];
  const kit = makeKit(tokens, screen.device, measure, state);
  const tree = buildScreen(kit, screen, size.width, size.height);
  const placed: Placed<Item> = solve(tree, size.width, size.height);

  const parts: UiPart[] = [];
  const counts = new Map<string, number>();
  const out: Out = {
    parts,
    key(owner, what) {
      const base = `${screen.id}/${owner}/${what}`;
      const n = (counts.get(base) ?? 0) + 1;
      counts.set(base, n);
      return n === 1 ? base : `${base}~${n}`;
    },
  };
  const hits: UiHit[] = [];
  const slots: UiSlot[] = [];
  const boxes = new Map<string, { x: number; y: number; w: number; h: number; kind: string }>();
  walk(placed, (p, x, y) => {
    const it = p.node.payload;
    const b = { x, y, w: p.w, h: p.h };
    it.paint?.(b, out);
    if (it.action !== undefined) {
      const control = it.action.kind === 'tab' ? it.action.bar : it.action.kind === 'pick' ? it.action.control : it.action.control;
      hits.push({ id: control, part: it.part, ...b, action: it.action });
    }
    // the chart's own room is the card less its title and a margin
    if (it.slot !== undefined) slots.push({ id: it.id, ref: it.slot, x: b.x + 8, y: b.y + 36, w: Math.max(0, b.w - 16), h: Math.max(0, b.h - 44) });
    if (it.quiet !== true && !boxes.has(it.id)) boxes.set(it.id, { ...b, kind: it.part });
  });
  return {
    id: screen.id,
    device: screen.device,
    name: screen.name,
    from: screen.from,
    fromLabel: screen.fromLabel,
    width: size.width,
    height: size.height,
    parts,
    hits,
    boxes,
    slots,
    notes: lintScreen(screen, placed, lines),
  };
}

/** Every screen of the brain's lines, laid out in the look. The lines are parsed here, as the bench does until the language reads them. */
export function layoutLines(lines: readonly string[], tokens: UiTokens, measure: UiMeasure, state: UiState = NO_STATE): { readonly screens: readonly UiScreenLayout[]; readonly doc: ReturnType<typeof parseInterface> } {
  const doc = parseInterface(lines);
  const counts = linesPerScreen(doc);
  return { doc, screens: doc.screens.map((s, i) => layoutScreen(s, tokens, measure, state, counts[i] ?? 0)) };
}
