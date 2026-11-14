// A mock-up on the stage (PLAN-v2.2 E13, the first slice's painter hooks). The interface kit (`blocks/ui`) lays screens out and draws them as
// finished frames; this file is what the painter does with that: it registers the kit as the engine of the `screen` structure, so that the
// stage plan rooms a mock-up like any block, and it draws what the kit made a row at a time as the rows land.
//
//   rows of the structure  ->  parseInterface  ->  layoutScreen per screen  ->  arrangeBoard in the room  ->  uiFrame  ->  DrawnFrames
//
// The kit's shapes have fills, edges, shadows and photographs that a `BlockPart` has no words for, so the structure carries finished frames
// (`StructureLayout.drawn`) instead of parts: the one addition to the blocks contract. Everything here is pure except the two small
// registries a stage needs (what a finger has done to the live parts, and the photographs that have arrived), which are the interface's
// own state, the way a control's value is the control's.

import { INTERFACE_LOOKS, linesPerScreen, parseInterface } from '@conduit/language';
import type { ElementSpan, UiNode } from '@conduit/language';
import type { DrawnFrames, StructureLayout } from '../contracts/blocks';
import { EMPTY_STRUCTURE_LAYOUT } from '../contracts/blocks';
import type { ElementFrame, FigureFrame } from '../contracts/frame';
import type { LookSpec } from '../contracts/look';
import type { Box } from '../contracts/space';
import { STUDIO_TOKENS } from '../looks/studio';
import { WIREFRAME_TOKENS } from '../looks/wireframe';
import { arrangeBoard, locate } from './blocks/ui/board';
import type { Board } from './blocks/ui/board';
import { uiFrame } from './blocks/ui/frame';
import type { UiTokens } from './blocks/ui/lang';
import { isUiContainer } from './blocks/ui/lang';
import { paintersMeasure } from './blocks/ui/measure';
import { layoutScreen } from './blocks/ui/screen';
import { applyAction, hitAt } from './blocks/ui/state';
import { NO_STATE } from './blocks/ui/types';
import type { UiPictureState, UiScreenLayout, UiState } from './blocks/ui/types';

/** How long a part takes to come in once its row has landed. */
export const UI_ROW_FADE = 0.18;

const measure = paintersMeasure();

/** The tokens a look gives the kit. Every look but the two interface looks wears the studio's, on its own ground. */
export function tokensFor(spec: LookSpec): UiTokens {
  if (spec.id === 'wireframe') return WIREFRAME_TOKENS;
  if (spec.id === 'studio') return STUDIO_TOKENS;
  const known = (INTERFACE_LOOKS as readonly string[]).includes(spec.id);
  return known ? STUDIO_TOKENS : { ...STUDIO_TOKENS, colour: { ...STUDIO_TOKENS.colour, ground: spec.roles.ground } };
}

// ------------------------------------------------------------------ what a stage holds of a mock-up

/** Photographs that have arrived, by the id of the `image` part they stand in. Only ever set after the renderer has them loaded. */
const PICTURES = new Map<string, UiPictureState>();

export function setUiPicture(partId: string, picture: UiPictureState | null): void {
  if (picture === null) PICTURES.delete(partId);
  else PICTURES.set(partId, picture);
}

export function hasUiPicture(partId: string): boolean {
  return PICTURES.has(partId);
}

interface Runtime {
  state: UiState;
  /** the screen shown large when the room is too narrow for them all */
  focus: number;
  last: { readonly room: Box; readonly board: Board; readonly layouts: readonly UiScreenLayout[] } | null;
}

const RUNTIMES = new Map<string, Runtime>();

function runtimeOf(key: string): Runtime {
  let found = RUNTIMES.get(key);
  if (found === undefined) {
    found = { state: NO_STATE, focus: 0, last: null };
    RUNTIMES.set(key, found);
    if (RUNTIMES.size > 24) RUNTIMES.delete(RUNTIMES.keys().next().value as string);
  }
  return found;
}

/** What a layout of this block depends on besides its rows and room: the taps it has had and the photographs it holds. Part of the layout's cache key. */
export function uiKey(blockKey: string): string {
  const run = RUNTIMES.get(blockKey);
  return JSON.stringify([run === undefined ? null : [run.state, run.focus], [...PICTURES.keys()].sort()]);
}

/** Forgets what a finger did to a block that has left. */
export function forgetUi(blockKey: string): void {
  RUNTIMES.delete(blockKey);
}

/**
 * A tap at a point of the stage (stage units, camera at rest). True when it hit a live part of a mock-up or brought a screen forward, and the
 * layout must be made again.
 */
export function tapUi(blockKey: string, x: number, y: number): boolean {
  const run = RUNTIMES.get(blockKey);
  const last = run?.last;
  if (run === undefined || last === null || last === undefined) return false;
  const px = x - last.room.x;
  const py = y - last.room.y;
  const at = locate(last.board, px, py);
  if (at === null) return false;
  if (last.board.mode === 'focus' && at.index !== last.board.focus) {
    run.focus = at.index;
    return true;
  }
  const screen = last.layouts[at.index];
  if (screen === undefined) return false;
  const hit = hitAt(screen.hits, at.x, at.y);
  if (hit === undefined) return false;
  const next = applyAction(run.state, hit.action, hit, at.x);
  if (next === run.state) return false;
  run.state = next;
  return true;
}

/** Whether a point of the stage is over a mock-up's block that is on stage: the block's key. */
export function uiBlockAt(blockKeys: readonly string[], x: number, y: number): string | null {
  for (const key of blockKeys) {
    const last = RUNTIMES.get(key)?.last;
    if (last === null || last === undefined) continue;
    if (locate(last.board, x - last.room.x, y - last.room.y) !== null) return key;
  }
  return null;
}

// ------------------------------------------------------------------ the engine

const MARGIN = 20;
/** below this a journey is shown as one screen large and the rest small: six phones side by side cannot be read in 390 points */
const NARROW = 700;

function rowsOf(structure: ElementSpan): string[] {
  const figure = structure.figure;
  return figure?.kind === 'structure' ? figure.rows.map((row) => row.cells[0] ?? '') : [];
}

export function isScreenBlock(span: ElementSpan): boolean {
  return span.figure?.kind === 'structure' && span.figure.structure === 'screen';
}

/**
 * The engine of the `screen` structure: every row that has arrived, laid out, stood on a board in the room it was given, and drawn.
 * `room` is the stage plan's, stage units on the structure's own plane; `dpr` snaps every edge to a device pixel.
 */
export function layoutUi(args: { readonly structure: ElementSpan; readonly room: Box; readonly spec: LookSpec; readonly dpr: number }): StructureLayout {
  const { structure, room, spec, dpr } = args;
  const lines = rowsOf(structure);
  const doc = parseInterface(lines);
  if (doc.screens.length === 0 || room.width < 40 || room.height < 40) return { ...EMPTY_STRUCTURE_LAYOUT, boxes: new Map([[structure.key, room]]) };
  const run = runtimeOf(structure.key);
  const tokens = tokensFor(spec);
  const state: UiState = { ...run.state, picture: Object.fromEntries(PICTURES) };
  const counts = linesPerScreen(doc);
  const layouts = doc.screens.map((screen, i) => layoutScreen(screen, tokens, measure, state, counts[i] ?? 0));
  const focus = Math.max(0, Math.min(layouts.length - 1, run.focus));
  const board = arrangeBoard(layouts, tokens, measure, { w: room.width, h: room.height }, { mode: layouts.length > 1 && room.width < NARROW ? 'focus' : 'overview', focus, margin: MARGIN });
  run.last = { room, board, layouts };

  const frame = uiFrame(board.parts, { width: room.width, height: room.height, dpr, spec });
  // the frame's origin is its room's centre; on the stage it is the room's centre in stage units
  const sx = room.x + room.width / 2;
  const sy = room.y + room.height / 2;
  const ownerRow = new Map<string, number>();
  for (const screen of doc.screens) {
    ownerRow.set(screen.id, screen.line);
    const walk = (nodes: readonly UiNode[]): void => {
      for (const node of nodes) {
        ownerRow.set(node.id, node.line);
        if (isUiContainer(node)) walk(node.children);
      }
    };
    walk(screen.children);
  }
  const rowOf = new Map<string, number>();
  const base = structure.order + 0.001;
  const prefix = `${structure.key}/`;
  const shift = (b: Box | undefined): Box | undefined => (b === undefined ? undefined : { ...b, x: b.x + sx, y: b.y + sy });
  const figures: FigureFrame[] = frame.figures.map((figure) => {
    const key = prefix + figure.key;
    rowOf.set(key, ownerRow.get(figure.id) ?? 0);
    const clip = shift(figure.clip);
    return { ...figure, key, z: base + figure.z * 1e-5, transform: { ...figure.transform, e: figure.transform.e + sx, f: figure.transform.f + sy }, ...(clip === undefined ? {} : { clip }) } as FigureFrame;
  });
  let fontPx = Number.POSITIVE_INFINITY;
  const elements: ElementFrame[] = frame.elements.map((element) => {
    const key = prefix + element.key;
    rowOf.set(key, ownerRow.get(element.id) ?? 0);
    fontPx = Math.min(fontPx, element.fontSize);
    const clip = shift(element.clip);
    return { ...element, key, z: base + element.z * 1e-5, x: element.x + sx, y: element.y + sy, ...(clip === undefined ? {} : { clip }) };
  });
  // the block's own box on the stage: what the screens and their labels cover
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const p of board.placements) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x + p.width);
    y1 = Math.max(y1, p.y + p.height);
  }
  const bounds: Box = Number.isFinite(x0) ? { x: room.x + x0, y: room.y + y0, width: x1 - x0, height: y1 - y0 } : room;
  const drawn: DrawnFrames = { figures, elements, rowOf, fontPx: Number.isFinite(fontPx) ? fontPx : 0 };
  return { boxes: new Map([[structure.key, bounds]]), parts: [], routes: new Map(), notes: [], shrink: 1, drawn };
}

// ------------------------------------------------------------------ drawing it, a row at a time

export interface DrawnCall {
  readonly structure: ElementSpan;
  readonly drawn: DrawnFrames;
  /** the layout it is easing from, and how far across (1: not easing) */
  readonly before: DrawnFrames | null;
  readonly q: number;
  readonly tq: number;
  readonly out: { readonly figures: FigureFrame[]; readonly elements: ElementFrame[] };
}

/**
 * What a mock-up looks like at `tq`: each part is there from the moment its row landed and fades in over `UI_ROW_FADE`; the block leaves as
 * its structure does; a layout that has just changed is eased to from the one before it. When all has landed, nothing is copied.
 */
export function drawUi(call: DrawnCall): { readonly drawn: boolean; readonly phase: 'entering' | 'on' | 'leaving' } {
  const { structure, drawn, before, q, tq, out } = call;
  const figure = structure.figure;
  const rows = figure?.kind === 'structure' ? figure.rows : [];
  const base = structure.carried ? 0 : (structure.enter?.end ?? 0);
  const exit = structure.exit;
  let leave = 1;
  let phase: 'entering' | 'on' | 'leaving' = 'on';
  if (exit !== null) {
    if (tq >= exit.end) return { drawn: false, phase: 'leaving' };
    if (tq >= exit.start) {
      leave = 1 - Math.max(0, Math.min(1, (tq - exit.start) / Math.max(1e-6, exit.end - exit.start)));
      phase = 'leaving';
    }
  }
  const easing = before !== null && q < 1;
  const was = new Map<string, FigureFrame | ElementFrame>();
  if (easing) {
    for (const f of before.figures) was.set(f.key, f);
    for (const e of before.elements) was.set(e.key, e);
  }
  let any = false;
  const appear = (key: string): number => {
    const at = structure.carried ? 0 : (rows[drawn.rowOf.get(key) ?? 0]?.at ?? 0);
    const start = Math.max(at, base);
    if (tq < start) return 0;
    const p = Math.max(0, Math.min(1, (tq - start) / UI_ROW_FADE));
    if (p < 1 && phase === 'on') phase = 'entering';
    return p;
  };
  for (const f of drawn.figures) {
    const o = appear(f.key) * leave;
    if (o <= 0.001) continue;
    any = true;
    const old = easing ? was.get(f.key) : undefined;
    if (o >= 0.999 && old === undefined) {
      out.figures.push(f);
      continue;
    }
    let transform = f.transform;
    if (old !== undefined && 'transform' in old) transform = { ...f.transform, e: old.transform.e + (f.transform.e - old.transform.e) * q, f: old.transform.f + (f.transform.f - old.transform.f) * q };
    out.figures.push({ ...f, transform, opacity: f.opacity * o } as FigureFrame);
  }
  for (const e of drawn.elements) {
    const o = appear(e.key) * leave;
    if (o <= 0.001) continue;
    any = true;
    const old = easing ? was.get(e.key) : undefined;
    if (o >= 0.999 && old === undefined) {
      out.elements.push(e);
      continue;
    }
    const x = old !== undefined && 'runs' in old ? old.x + (e.x - old.x) * q : e.x;
    const y = old !== undefined && 'runs' in old ? old.y + (e.y - old.y) * q : e.y;
    out.elements.push({ ...e, x, y, opacity: e.opacity * o });
  }
  return { drawn: any, phase };
}
