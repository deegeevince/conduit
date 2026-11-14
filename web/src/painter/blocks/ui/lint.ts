// Sight for screens (PLAN-v2.2 E13, "judged by code"): a short lint over a laid-out screen. It reads the boxes and says
// what a designer's eye would: a target under 44 points, words that do not fit their part, a part outside its screen or
// its container, siblings on top of each other, an edge off the four-point grid, two primary buttons on one screen, a
// screen that took too many lines. Pure: it reads the tree the solver placed and the lines the brain wrote.

import type { UiNode, UiScreen } from './lang';
import { isUiContainer, linesPerScreen } from './lang';
import type { UiDocument } from './lang';
import type { Item } from './kit';
import type { Placed } from './solve';
import type { UiLintNote } from './types';

const EPS = 0.5;
/** "at most 15 lines a screen" (row 44) for a phone or a tablet; a page on a desk holds more. */
export const MAX_LINES = 15;
export const MAX_LINES_DESK = 25;
export const MIN_TARGET = 44;

function off(v: number): boolean {
  const r = Math.abs(v) % 4;
  return r > 0.01 && 4 - r > 0.01;
}

/** The lines of a screen that tried to place a part by coordinate: `at=`, `x=`, `y=`, `w=`, `h=`, `z=`. Nothing places by number in a screen, so they are named and ignored. */
function coordinates(nodes: readonly UiNode[], screen: string, out: UiLintNote[]): void {
  for (const node of nodes) {
    if (isUiContainer(node)) {
      coordinates(node.children, screen, out);
      continue;
    }
    for (const key of ['at', 'x', 'y', 'w', 'h', 'z', 'pos']) {
      if (node.attrs[key] !== undefined) out.push({ kind: 'coordinates', screen, id: node.id, message: `${node.kind} was placed by ${key}=: the painter places every part` });
    }
  }
}

function primaries(nodes: readonly UiNode[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (isUiContainer(node)) out.push(...primaries(node.children));
    else if (node.kind === 'button' && node.flags.includes('primary')) out.push(node.id);
  }
  return out;
}

export function lintScreen(screen: UiScreen, placed: Placed<Item>, lines: number): UiLintNote[] {
  const most = screen.device === 'desktop' || screen.device === 'browser' ? MAX_LINES_DESK : MAX_LINES;
  const notes: UiLintNote[] = [];
  const sid = screen.id;
  const note = (kind: UiLintNote['kind'], id: string, message: string): void => {
    notes.push({ kind, screen: sid, id, message });
  };
  coordinates(screen.children, sid, notes);
  if (lines > most) note('dense', sid, `${lines} lines: a ${screen.device} screen holds at most ${most}`);
  const primary = primaries(screen.children);
  if (primary.length > 1) note('two-primary', primary[1] ?? sid, `${primary.length} primary buttons on one screen: ${primary.join(', ')}`);

  // part boxes by id, absolute, so words can be checked against their own part
  const boxes = new Map<string, { x: number; y: number; w: number; h: number }>();
  const visitBoxes = (p: Placed<Item>, ox: number, oy: number): void => {
    const x = ox + p.x;
    const y = oy + p.y;
    const it = p.node.payload;
    if (!boxes.has(it.id)) boxes.set(it.id, { x, y, w: p.w, h: p.h });
    for (const k of p.children) visitBoxes(k, x, y);
  };
  visitBoxes(placed, 0, 0);

  const visit = (p: Placed<Item>, ox: number, oy: number, parent: Placed<Item> | null, px: number, py: number): void => {
    const x = ox + p.x;
    const y = oy + p.y;
    const it = p.node.payload;
    // outside its screen, or outside what holds it
    if (parent !== null && !it.quiet) {
      if (x < -EPS || y < -EPS || x + p.w > placed.w + EPS || y + p.h > placed.h + EPS) note('outside', it.id, `${it.part} lies outside its screen`);
      else if (p.w > 0 && p.h > 0 && (x < px - EPS || y < py - EPS || x + p.w > px + parent.w + EPS || y + p.h > py + parent.h + EPS)) note('outside', it.id, `${it.part} lies outside its container`);
    }
    if (it.words === true && p.node.leaf !== null) {
      const needW = it.need ?? p.node.leaf.minW;
      const needH = p.node.leaf.fit(p.w).h;
      const own = it.owner === undefined ? undefined : boxes.get(it.owner);
      if (needW > p.w + EPS || needH > p.h + EPS) note('lost-words', it.owner ?? it.id, `words need ${Math.ceil(needW)} by ${Math.ceil(needH)} and have ${Math.floor(p.w)} by ${Math.floor(p.h)}`);
      else if (own !== undefined && (x < own.x - EPS || y < own.y - EPS || x + p.w > own.x + own.w + EPS || y + p.h > own.y + own.h + EPS)) note('lost-words', it.owner ?? it.id, 'words lie outside their own part');
    }
    if (it.target === true && (p.w < MIN_TARGET - 0.01 || p.h < MIN_TARGET - 0.01)) note('small-target', it.owner ?? it.id, `${it.part} is ${Math.round(p.w)} by ${Math.round(p.h)} points: a finger needs ${MIN_TARGET}`);
    if (parent !== null && it.quiet !== true) {
      if (off(p.y) || off(p.h)) note('off-grid', it.id, `${it.part} edge at y=${p.y.toFixed(1)} (in its container) h=${p.h.toFixed(1)} is off the four-point grid`);
      const pb = parent.node.box;
      const self = p.node.style.self;
      const startAligned = pb !== null && pb.dir === 'col' && (self === undefined || self === 'auto' || self === 'start' || self === 'stretch') && (pb.align === 'stretch' || pb.align === 'start') && p.node.style.maxW === undefined;
      if (startAligned && off(p.x)) note('off-grid', it.id, `${it.part} edge at x=${p.x.toFixed(1)} (in its container) is off the four-point grid`);
    }
    // children on top of one another
    const kids = p.children;
    for (let i = 0; i < kids.length; i++) {
      const a = kids[i];
      if (a === undefined) continue;
      for (let j = i + 1; j < kids.length; j++) {
        const b = kids[j];
        if (b === undefined) continue;
        const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (w > 1 && h > 1 && a.w > 0 && a.h > 0 && b.w > 0 && b.h > 0 && a.node.payload.part !== 'space' && b.node.payload.part !== 'space') {
          note('overlap', b.node.payload.id, `${a.node.payload.id} and ${b.node.payload.id} overlap by ${Math.round(w)} by ${Math.round(h)}`);
        }
      }
    }
    for (const k of kids) visit(k, x, y, p, x, y);
  };
  visit(placed, 0, 0, null, 0, 0);
  void lines;
  return notes;
}

/** Every screen's note, for a document: what `pnpm` and the bench count. */
export function linesOf(doc: UiDocument): readonly number[] {
  return linesPerScreen(doc);
}
