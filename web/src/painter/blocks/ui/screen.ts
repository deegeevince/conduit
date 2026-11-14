// One screen, laid out (PLAN-v2.2 E13): the tree the kit builds, the boxes the solver gives it, and the shapes and
// words each box is drawn as. Pure and deterministic: the same screen, look, measurer and state always give the same parts.

import type { UiNode, UiScreen, UiTokens } from './lang';
import { UI_DEVICE_SIZE, isUiContainer, linesPerScreen, parseInterface } from './lang';
import { buildScreen, makeKit } from './kit';
import type { Item, Out } from './kit';
import { lintScreen } from './lint';
import type { UiMeasure } from './measure';
import { solve, walk } from './solve';
import type { Placed } from './solve';
import { themed } from './theme';
import { NO_STATE } from './types';
import type { UiClip, UiHit, UiPart, UiScreenLayout, UiSlot, UiState } from './types';

/**
 * A page shown as the phone it would be (a narrow stage): what sat side by side on a wide page goes one under the other, as a responsive page does.
 * A row of two or more that holds a column or a picture stacks; the rest of the rows (a title and a badge, two buttons) stay rows, and wrap only if they must.
 */
function responsive(nodes: readonly UiNode[], grid = true): UiNode[] {
  return nodes.map((node): UiNode => {
    if (!isUiContainer(node)) return node;
    // a row of buttons or badges that is too wide for the glass goes on to a second line, as it does on a phone
    if (node.kind === 'row' && !node.props.wrap && node.children.length >= 2 && node.children.every((child) => !isUiContainer(child) && (child.kind === 'button' || child.kind === 'badge'))) return { ...node, props: { ...node.props, wrap: true } };
    // a wrapping row of cards (three or more) is a grid on a page: two to a row on a phone, not one long stack of them (when two fit across)
    if (grid && node.kind === 'row' && node.props.wrap && node.children.length >= 3 && node.children.every(isUiContainer)) {
      const cards = responsive(node.children, grid);
      const rows: UiNode[] = [];
      for (let i = 0; i < cards.length; i += 2) {
        const pair = cards.slice(i, i + 2).map((card): UiNode => (isUiContainer(card) ? { ...card, props: { ...card.props, grow: true } } : card));
        rows.push({ kind: 'row', id: `${node.id}~${i / 2 + 1}`, line: node.line, props: { ...node.props, wrap: false, grow: false, spread: false, align: 'start' }, children: pair });
      }
      return { ...node, kind: 'col', props: { ...node.props, wrap: false, align: null }, children: rows };
    }
    const stack = node.kind === 'row' && !node.props.spread && node.children.length >= 2 && node.children.some((child) => isUiContainer(child) || child.kind === 'image');
    const children = responsive(node.children, grid).map((child): UiNode => (stack && !isUiContainer(child) ? { ...child, flags: child.flags.filter((flag) => flag !== 'grow') } : stack && isUiContainer(child) ? { ...child, props: { ...child.props, grow: false } } : child));
    return stack ? { ...node, kind: 'col', props: { ...node.props, align: null }, children } : { ...node, children };
  });
}

/**
 * A page shown as a phone is the glass it is: what the page has below the fold is not the screen's, and a card cut across the fold is a mistake the
 * eye sees at once. What does not fit whole is left off, from the first thing that crosses the fold to the end of the page (a column is read down; a row
 * of things side by side goes or stays as one). `boxes` are the parts' boxes in the glass.
 */
function aboveFold(nodes: readonly UiNode[], boxes: ReadonlyMap<string, { readonly y: number; readonly h: number }>, limit: number): UiNode[] {
  const out: UiNode[] = [];
  for (const node of nodes) {
    const b = boxes.get(node.id);
    if (b === undefined || b.y + b.h <= limit + 0.5) {
      out.push(node);
      continue;
    }
    // a column that crosses the fold keeps what fits of it; anything else that crosses it goes
    if (isUiContainer(node) && node.kind === 'col' && b.y < limit) {
      const inner = aboveFold(node.children, boxes, limit);
      if (inner.length > 0) out.push({ ...node, children: inner });
    }
    break;
  }
  return out;
}

function countNodes(nodes: readonly UiNode[]): number {
  return nodes.reduce((n, node) => n + 1 + (isUiContainer(node) ? countNodes(node.children) : 0), 0);
}

/** Where a row that moves is, and how far it can: its box in the screen's points, and the offset its finger has given it. */
interface Rail {
  readonly id: string;
  readonly clip: UiClip;
  readonly offset: number;
}

/**
 * The tree walked as the screen is drawn: every node with its absolute box, and the rail it is inside, if it is inside one. What a rail holds is moved by its offset
 * (its children's own boxes, and everything in them) and drawn only inside the rail's box. `visit` gets the node, its box as it is drawn, and the rail.
 */
function walkDrawn(root: Placed<Item>, state: UiState, visit: (p: Placed<Item>, x: number, y: number, depth: number, rail: Rail | null, max: number | null) => void): void {
  const go = (p: Placed<Item>, ox: number, oy: number, depth: number, rail: Rail | null, dx: number): void => {
    const x = ox + p.x - dx;
    const y = oy + p.y;
    const id = p.node.payload.scroll;
    if (id === undefined) {
      visit(p, x, y, depth, rail, null);
      for (const k of p.children) go(k, x, y, depth + 1, rail, 0);
      return;
    }
    // the content runs to the right edge of its last child and its own padding beyond it
    const pad = p.node.box?.pad[1] ?? 0;
    const right = p.children.reduce((m, k) => Math.max(m, k.x + k.w), 0) + pad;
    const max = Math.max(0, right - p.w);
    const offset = Math.max(0, Math.min(max, state.scroll?.[id] ?? 0));
    visit(p, x, y, depth, rail, max);
    const here: Rail = { id, clip: { x, y, w: p.w, h: p.h }, offset };
    for (const k of p.children) go(k, x, y, depth + 1, here, offset);
  };
  go(root, 0, 0, 0, null, 0);
}

/** Every node that is not inside a rail: what the page's own width is judged by. */
function outsideRails(root: Placed<Item>, visit: (p: Placed<Item>, x: number, depth: number) => void, ox = 0, depth = 0): void {
  const x = ox + root.x;
  visit(root, x, depth);
  if (root.node.payload.scroll !== undefined) return;
  for (const k of root.children) outsideRails(k, visit, x, depth + 1);
}

/**
 * One screen, laid out. What the screen's own words (`theme=`, `accent=`, ...) make of the look's tokens is read here. A phone or a tablet is the glass it is: when
 * what was written does not fit it and the screen did not say how closely to set it, it is set again at `density=compact`, and that one is kept if it fits better.
 */
export function layoutScreen(written: UiScreen, base: UiTokens, measure: UiMeasure, state: UiState = NO_STATE, lines = 0): UiScreenLayout {
  const tokens = themed(base, written.style);
  const first = layoutWith(written, tokens, measure, state, lines);
  const glass = first.device === 'phone' || first.device === 'tablet';
  const spilled = (layout: UiScreenLayout): number => layout.notes.filter((n) => n.kind === 'outside').length;
  if (!glass || tokens.pack !== undefined || spilled(first) === 0) return first;
  const tighter = layoutWith(written, { ...tokens, pack: 'compact' }, measure, state, lines);
  return spilled(tighter) < spilled(first) ? tighter : first;
}

function layoutWith(written: UiScreen, tokens: UiTokens, measure: UiMeasure, state: UiState, lines: number): UiScreenLayout {
  // `device` is a property that can be set: the same lines laid out on another device
  const switched: UiScreen = state.device[written.id] === undefined ? written : { ...written, device: state.device[written.id] ?? written.device };
  const adapted = switched.device === 'phone' && (written.device === 'browser' || written.device === 'desktop');
  let screen: UiScreen = adapted ? { ...switched, children: responsive(switched.children) } : switched;
  let size: { width: number; height: number } = UI_DEVICE_SIZE[screen.device];
  const kit = makeKit(tokens, screen.device, measure, state);
  let placed: Placed<Item> = solve(buildScreen(kit, screen, size.width, size.height), size.width, size.height);
  if (adapted) {
    // cards two to a row only when two fit across at this size of type: otherwise they stack, as a responsive page does
    const wide = (): boolean => {
      let over = false;
      outsideRails(placed, (p, x, depth) => {
        if (depth > 0 && p.w > 0 && x + p.w > size.width + 0.5) over = true;
      });
      return over;
    };
    if (wide()) {
      screen = { ...switched, children: responsive(switched.children, false) };
      placed = solve(buildScreen(kit, screen, size.width, size.height), size.width, size.height);
    }
    // the page, as a phone shows it: its first screenful, whole (two passes: a part left off can let the ones above it settle)
    for (let pass = 0; pass < 3; pass += 1) {
      const boxes = new Map<string, { y: number; h: number }>();
      walk(placed, (p, _x, y) => {
        if (!boxes.has(p.node.payload.id)) boxes.set(p.node.payload.id, { y, h: p.h });
      });
      const kept = aboveFold(screen.children, boxes, size.height);
      if (countNodes(kept) === countNodes(screen.children)) break;
      screen = { ...screen, children: kept };
      placed = solve(buildScreen(kit, screen, size.width, size.height), size.width, size.height);
    }
    lines = Math.min(lines, 1 + countNodes(screen.children));
  }
  // A page is as long as its content (up to half as long again as the fold): a home page cut at the fold in the middle of its cards is not a page.
  // A phone or a tablet is the glass it is, and a long screen scrolls.
  if (screen.device === 'browser' || screen.device === 'desktop') {
    let bottom = 0;
    walk(placed, (p, _x, y, depth) => {
      if (depth > 0) bottom = Math.max(bottom, y + p.h);
    });
    const longest = Math.round(size.height * 1.5);
    if (bottom > size.height + 1) {
      size = { width: size.width, height: Math.min(longest, Math.ceil(bottom / 8) * 8) };
      placed = solve(buildScreen(kit, screen, size.width, size.height), size.width, size.height);
    }
  }

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
  walkDrawn(placed, state, (p, x, y, _depth, rail, max) => {
    const it = p.node.payload;
    const b = { x, y, w: p.w, h: p.h };
    const before = parts.length;
    it.paint?.(b, out);
    // what is inside a row that moves is drawn only inside it
    if (rail !== null) for (let i = before; i < parts.length; i += 1) parts[i] = { ...(parts[i] as UiPart), clip: rail.clip };
    if (max !== null && it.scroll !== undefined) hits.push({ id: it.scroll, part: 'carousel', ...b, action: { kind: 'scroll', control: it.scroll, max } });
    if (it.action !== undefined && rail === null) {
      const control = it.action.kind === 'tab' ? it.action.bar : it.action.kind === 'pick' ? it.action.control : it.action.control;
      hits.push({ id: control, part: it.part, ...b, action: it.action });
    }
    // the chart's own room is the card less its title and a margin
    if (it.slot !== undefined) slots.push({ id: it.id, ref: it.slot, x: b.x + 8, y: b.y + 36, w: Math.max(0, b.w - 16), h: Math.max(0, b.h - 44) });
    if (it.quiet !== true && !boxes.has(it.id)) boxes.set(it.id, { ...b, kind: it.part });
  });
  return {
    tokens,
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
