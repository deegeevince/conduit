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

import { INTERFACE_LOOKS, linesPerScreen, parseInterface, unstar } from '@conduit/language';
import type { ControlValue, ElementSpan, UiDocument, UiNode, UiPartNode } from '@conduit/language';
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
import { applyAction, hitAt, sliderAt, typeInto } from './blocks/ui/state';
import { SWITCH } from './blocks/ui/kit';
import { lengthOf, playerPosition } from './blocks/ui/rich';
import { NO_STATE } from './blocks/ui/types';
import type { UiHit, UiPictureState, UiScreenLayout, UiState } from './blocks/ui/types';

/** How long a part takes to come in once its row has landed. */
/** The clock read of a pointer-down, only: nothing on the measuring path reads it. */
const wallNow = (): number => (globalThis as { performance?: { now(): number } }).performance?.now() ?? 0;

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

/** What a finger holds on a mock-up: a switch or slider being dragged, or a button that has been pressed and not yet let go. */
interface Grab {
  readonly pointer: number;
  readonly kind: 'toggle' | 'slider' | 'press' | 'scroll';
  readonly index: number;
  readonly hit: UiHit;
  /** the point (screen points) where the finger came down, and where the knob was then */
  readonly x0: number;
  readonly from: number;
  moved: boolean;
  /** a row being dragged: where the finger was last and when, and how fast it is going (points a millisecond, signed as the finger goes) */
  lastX: number;
  lastAt: number;
  speed: number;
}

/** A knob easing to where it will rest (after a finger lets go, or a tap), by the clock of the frame it is asked in. */
interface Ease {
  readonly kind: 'toggle' | 'slider' | 'scroll';
  readonly from: number;
  readonly to: number;
  /** how long it takes, ms; absent: a knob's own */
  readonly ms?: number;
  /** performance.now() of the first frame that saw it: a tap's ease begins when it is first drawn */
  at: number | null;
}

interface Runtime {
  state: UiState;
  /** the screen shown large when the room is too narrow for them all, or when a press has gone to it (`button … to=<screen>`) */
  focus: number;
  /** a press went to a screen: one screen large and the rest as thumbnails, in any room */
  solo: boolean;
  last: Last | null;
  grab: Grab | null;
  eases: Map<string, Ease>;
  /** performance.now() when a playing bar last moved on: what advances its progress while it plays */
  tickAt: number | null;
}

interface Last {
  readonly room: Box;
  readonly board: Board;
  readonly layouts: readonly UiScreenLayout[];
  readonly doc: UiDocument;
  readonly state: UiState;
  /** the player bars of the screens, with how long each track runs: what plays on while a finger has set one going */
  readonly players: readonly { readonly id: string; readonly seconds: number; readonly start: number }[];
}

/** The layout each drawn frame set was made from: the one on screen is the one a finger is aimed at, not the last one made. */
const LASTS = new WeakMap<DrawnFrames, Last>();

/** How long a knob takes to go home, seconds. */
export const KNOB_EASE = 0.16;

const RUNTIMES = new Map<string, Runtime>();

function runtimeOf(key: string): Runtime {
  let found = RUNTIMES.get(key);
  if (found === undefined) {
    found = { state: NO_STATE, focus: 0, solo: false, last: null, grab: null, eases: new Map(), tickAt: null };
    RUNTIMES.set(key, found);
    if (RUNTIMES.size > 24) RUNTIMES.delete(RUNTIMES.keys().next().value as string);
  }
  return found;
}

/** What a layout of this block depends on besides its rows and room: the taps it has had and the photographs it holds. Part of the layout's cache key. */
export function uiKey(blockKey: string): string {
  const run = RUNTIMES.get(blockKey);
  return JSON.stringify([run === undefined ? null : [run.state, run.focus, run.solo], [...PICTURES.keys()].sort()]);
}

/** Forgets what a finger did to a block that has left. */
export function forgetUi(blockKey: string): void {
  RUNTIMES.delete(blockKey);
}

/** What a press of a button says to the brain: the screen and the button, and what every live part of the screen holds (a password only as filled). */
export interface UiSend {
  readonly screen: string;
  readonly id: string;
  readonly text: string;
  readonly values: Readonly<Record<string, ControlValue>>;
}

/** What a finger did to a mock-up: whether the layout must be made again, and whether the press it let go on is for the brain. */
export interface UiTouch {
  readonly changed: boolean;
  readonly send?: UiSend;
}

const MOST_VALUES = 24;
const MOST_TEXT = 80;

/** What every live part of a screen holds, by what it says (its label), for the turn a press opens. A password is never given: only that it is filled. */
function valuesOf(doc: UiDocument, screenIndex: number, state: UiState): Record<string, ControlValue> {
  const out: Record<string, ControlValue> = {};
  const screen = doc.screens[screenIndex];
  if (screen === undefined) return out;
  const put = (node: UiPartNode, label: string, value: ControlValue): void => {
    if (Object.keys(out).length >= MOST_VALUES) return;
    const name = label.trim() === '' || label.trim() in out ? node.id : label.trim().slice(0, 40);
    out[name] = value;
  };
  const walk = (nodes: readonly UiNode[]): void => {
    for (const node of nodes) {
      if (isUiContainer(node)) {
        walk(node.children);
        continue;
      }
      const label = node.fields[0] ?? '';
      switch (node.kind) {
        case 'field':
        case 'input': {
          const typed = state.text[node.id] ?? '';
          put(node, node.kind === 'field' ? label : '', node.flags.includes('password') ? (typed === '' ? 'empty' : 'filled') : typed.slice(0, MOST_TEXT));
          break;
        }
        case 'toggle':
          put(node, label, state.toggle[node.id] ?? node.flags.includes('on'));
          break;
        case 'item':
          if (node.flags.includes('toggle')) put(node, unstar(label).text, state.toggle[node.id] ?? node.flags.includes('on'));
          break;
        case 'pick': {
          const options = node.fields.slice(1).map(unstar);
          const starred = options.findIndex((option) => option.starred);
          const chosen = state.pick[node.id] ?? (starred >= 0 ? starred : Math.floor((options.length - 1) / 2));
          put(node, label, (options[chosen]?.text ?? '').slice(0, MOST_TEXT));
          break;
        }
        case 'segment': {
          const options = node.fields.map(unstar);
          const starred = options.findIndex((option) => option.starred);
          put(node, '', (options[state.pick[node.id] ?? (starred >= 0 ? starred : 0)]?.text ?? '').slice(0, MOST_TEXT));
          break;
        }
        case 'player':
          put(node, (node.fields[0] ?? '').split(/\s+\/\s+/)[0] ?? '', state.toggle[node.id] ?? node.flags.includes('playing'));
          break;
        case 'slider': {
          const given = node.fields[1];
          const raw = state.slider[node.id] ?? (given !== undefined && given !== '' && Number(given) >= 0 ? Number(given) / (Number(given) > 1 ? 100 : 1) : 0.5);
          put(node, label, Math.round(Math.max(0, Math.min(1, raw)) * 100));
          break;
        }
        default:
          break;
      }
    }
  };
  walk(screen.children);
  return out;
}

/** Where a switch's knob is now (0 off, 1 on), by the state: what a drag starts from. */
function thumbOf(state: UiState, control: string, on: boolean): number {
  return state.thumb?.[control] ?? (on ? 1 : 0);
}

const MOVED = 3;

/**
 * A finger comes down at a point of the stage (stage units, camera at rest). `taken` when it landed on a live part of a mock-up or on a thumbnail
 * that comes forward: the rest of its gesture is the mock-up's. A tab, a pick and a field answer at once; a switch and a slider are held and follow the
 * finger; a button looks pressed and acts when the finger lets go on it.
 */
export function downUi(blockKey: string, x: number, y: number, pointer: number): { readonly taken: boolean; readonly changed: boolean } {
  const run = RUNTIMES.get(blockKey);
  const last = run?.last;
  if (run === undefined || last === null || last === undefined) return { taken: false, changed: false };
  const at = locate(last.board, x - last.room.x, y - last.room.y);
  if (at === null) return { taken: false, changed: false };
  if (last.board.mode === 'focus' && at.index !== last.board.focus) {
    run.focus = at.index;
    return { taken: true, changed: true };
  }
  const screen = last.layouts[at.index];
  if (screen === undefined) return { taken: false, changed: false };
  const hit = hitAt(screen.hits, at.x, at.y);
  if (hit === undefined) return { taken: false, changed: false };
  const action = hit.action;
  if (action.kind === 'toggle') {
    // a switch is held: its knob follows the finger from where it was; a tap that does not move flips it
    const eased = run.eases.get(action.control);
    const from = eased === undefined ? thumbOf(run.state, action.control, action.on) : easedValue(eased, wallNow());
    run.eases.delete(action.control);
    run.grab = { pointer, kind: 'toggle', index: at.index, hit, x0: at.x, from, moved: false, lastX: at.x, lastAt: 0, speed: 0 };
    run.state = { ...run.state, thumb: { ...run.state.thumb, [action.control]: from }, focus: null };
    return { taken: true, changed: true };
  }
  if (action.kind === 'slider') {
    run.eases.delete(action.control);
    const value = sliderAt(hit, at.x);
    run.grab = { pointer, kind: 'slider', index: at.index, hit, x0: at.x, from: run.state.slider[action.control] ?? value, moved: false, lastX: at.x, lastAt: 0, speed: 0 };
    run.state = { ...run.state, slider: { ...run.state.slider, [action.control]: value }, focus: null };
    return { taken: true, changed: true };
  }
  if (action.kind === 'scroll') {
    // a row is taken where it is, even if it was still coasting
    const coasting = run.eases.get(action.control);
    const from = coasting === undefined ? (run.state.scroll?.[action.control] ?? 0) : easedValue(coasting, performance.now());
    run.eases.delete(action.control);
    run.state = { ...run.state, scroll: { ...run.state.scroll, [action.control]: from }, focus: null };
    run.grab = { pointer, kind: 'scroll', index: at.index, hit, x0: at.x, from, moved: false, lastX: at.x, lastAt: performance.now(), speed: 0 };
    return { taken: true, changed: false };
  }
  if (action.kind === 'press') {
    run.grab = { pointer, kind: 'press', index: at.index, hit, x0: at.x, from: 0, moved: false, lastX: at.x, lastAt: 0, speed: 0 };
    run.state = { ...run.state, pressed: action.control, focus: null };
    return { taken: true, changed: true };
  }
  const next = applyAction(run.state, action, hit, at.x);
  if (next === run.state) return { taken: true, changed: false };
  run.state = next;
  return { taken: true, changed: true };
}

/** The finger that came down on a mock-up has moved. True when something it holds followed it. */
export function moveUi(blockKey: string, x: number, y: number, pointer: number): boolean {
  const run = RUNTIMES.get(blockKey);
  const last = run?.last;
  const grab = run?.grab;
  if (run === undefined || last === null || last === undefined || grab === null || grab === undefined || grab.pointer !== pointer) return false;
  const p = last.board.placements.find((candidate) => candidate.index === grab.index);
  if (p === undefined) return false;
  // the finger in the screen's own points, even when it has left the screen
  const sx = (x - last.room.x - p.contentX) / p.scale;
  const sy = (y - last.room.y - p.contentY) / p.scale;
  const action = grab.hit.action;
  if (Math.abs(sx - grab.x0) > MOVED) grab.moved = true;
  if (action.kind === 'toggle') {
    const travel = SWITCH.on - SWITCH.off;
    const t = Math.max(0, Math.min(1, grab.from + (sx - grab.x0) / travel));
    run.state = { ...run.state, thumb: { ...run.state.thumb, [action.control]: t } };
    return true;
  }
  if (action.kind === 'slider') {
    run.state = { ...run.state, slider: { ...run.state.slider, [action.control]: sliderAt(grab.hit, sx) } };
    return true;
  }
  if (action.kind === 'scroll') {
    // the row goes with the finger, held to its own length; how fast the finger is going is kept, for when it lets go
    const now = performance.now();
    const dt = Math.max(1, now - grab.lastAt);
    grab.speed = grab.speed * 0.6 + (-(sx - grab.lastX) / dt) * 0.4;
    grab.lastX = sx;
    grab.lastAt = now;
    run.state = { ...run.state, scroll: { ...run.state.scroll, [action.control]: Math.max(0, Math.min(action.max, grab.from - (sx - grab.x0))) } };
    return true;
  }
  if (action.kind === 'press') {
    // a finger that has slid off the button no longer presses it
    const inside = sx >= grab.hit.x - 8 && sx <= grab.hit.x + grab.hit.w + 8 && sy >= grab.hit.y - 8 && sy <= grab.hit.y + grab.hit.h + 8;
    const want = inside ? action.control : null;
    if (run.state.pressed === want) return false;
    run.state = { ...run.state, pressed: want };
    return true;
  }
  return false;
}

/** The finger lets go (or the gesture is taken away: `cancel`). A knob goes home by an ease; a button that is still under the finger acts. */
export function upUi(blockKey: string, pointer: number, cancel: boolean, x: number, y: number): UiTouch {
  const run = RUNTIMES.get(blockKey);
  const last = run?.last;
  const grab = run?.grab;
  if (run === undefined || last === null || last === undefined || grab === null || grab === undefined || grab.pointer !== pointer) return { changed: false };
  run.grab = null;
  const action = grab.hit.action;
  if (action.kind === 'toggle') {
    const now = run.state.thumb?.[action.control] ?? grab.from;
    // a tap flips it; a drag leaves it on the side its knob is on; a gesture taken away puts it back
    const target = cancel ? Math.round(grab.from) : grab.moved ? (now >= 0.5 ? 1 : 0) : 1 - Math.round(grab.from);
    run.eases.set(action.control, { kind: 'toggle', from: now, to: target, at: null });
    return { changed: true };
  }
  if (action.kind === 'slider') {
    const now = run.state.slider[action.control] ?? grab.from;
    // let go, the knob settles on a whole percent: what its readout says
    const target = cancel ? grab.from : Math.round(now * 100) / 100;
    if (Math.abs(target - now) > 1e-6) run.eases.set(action.control, { kind: 'slider', from: now, to: target, at: null });
    else run.state = { ...run.state, slider: { ...run.state.slider, [action.control]: target } };
    return { changed: true };
  }
  if (action.kind === 'scroll') {
    // let go while moving, the row coasts on a little way and stops; let go still, it stays
    const now = run.state.scroll?.[action.control] ?? grab.from;
    const idle = performance.now() - grab.lastAt > 90;
    const coast = cancel || idle ? 0 : grab.speed * 260;
    const target = Math.max(0, Math.min(action.max, now + coast));
    if (Math.abs(target - now) > 1) run.eases.set(action.control, { kind: 'scroll', from: now, to: target, ms: 420, at: null });
    return { changed: true };
  }
  if (action.kind === 'press') {
    const held = run.state.pressed === action.control;
    run.state = { ...run.state, pressed: null };
    if (cancel || !held) return { changed: true };
    // a press that goes somewhere (`to=<screen>`) brings that screen forward: a prototype moves from one screen to the next
    if (action.to !== undefined) {
      const to = action.to;
      const index = last.layouts.findIndex((layout) => layout.id === to);
      if (index >= 0) {
        run.focus = index;
        run.solo = true;
      }
    }
    if (action.send === true) {
      const screen = last.layouts[grab.index];
      return { changed: true, send: { screen: screen?.id ?? '', id: action.control, text: action.label ?? 'Button', values: valuesOf(last.doc, grab.index, run.state) } };
    }
    return { changed: true };
  }
  return { changed: false };
}

function easedValue(ease: Ease, now: number): number {
  const q = ease.at === null ? 0 : Math.max(0, Math.min(1, (now - ease.at) / (ease.ms ?? KNOB_EASE * 1000)));
  const e = 1 - (1 - q) ** 3;
  return ease.from + (ease.to - ease.from) * e;
}

/** The player bars of a document, with how long each runs and where it starts. */
function playersOf(doc: UiDocument): { readonly id: string; readonly seconds: number; readonly start: number }[] {
  const out: { id: string; seconds: number; start: number }[] = [];
  const walk = (nodes: readonly UiNode[]): void => {
    for (const node of nodes) {
      if (isUiContainer(node)) walk(node.children);
      else if (node.kind === 'player') out.push({ id: node.id, seconds: lengthOf(node.attrs['len']), start: playerPosition({ state: NO_STATE }, node) });
    }
  };
  for (const screen of doc.screens) walk(screen.children);
  return out;
}

/** Whether a mock-up has a knob easing home, so that the stage must be made again every frame. */
export function easingUi(): boolean {
  for (const run of RUNTIMES.values()) if (run.eases.size > 0 || playingIn(run).length > 0) return true;
  return false;
}

/** The players a finger has set going: a bar that says it is playing in its own lines does not move on by itself (a stage at rest is still). */
function playingIn(run: Runtime): readonly { readonly id: string; readonly seconds: number; readonly start: number }[] {
  return run.last === null ? [] : run.last.players.filter((player) => run.state.toggle[player.id] === true);
}

/** How often a playing bar's progress moves on, ms. */
const TICK = 200;

/** Moves every knob that is easing home on to where it is at `now` (ms of the page clock). True when one moved, and the layout must be made again. */
export function easeUi(now: number, reduced: boolean): boolean {
  let moved = false;
  for (const run of RUNTIMES.values()) {
    const playing = reduced ? [] : playingIn(run);
    if (playing.length === 0) run.tickAt = null;
    else {
      // what plays advances along its bar, a track's length being what it is, and starts over at the end
      run.tickAt ??= now;
      const dt = now - run.tickAt;
      if (dt >= TICK) {
        run.tickAt = now;
        const slider = { ...run.state.slider };
        for (const player of playing) {
          const control = `${player.id}:seek`;
          if (run.grab?.hit.action.kind === 'slider' && run.grab.hit.action.control === control) continue;
          const at = slider[control] ?? player.start;
          const next = at + dt / 1000 / player.seconds;
          slider[control] = next >= 1 ? 0 : next;
        }
        run.state = { ...run.state, slider };
        moved = true;
      }
    }
    if (run.eases.size === 0) continue;
    for (const [control, ease] of [...run.eases]) {
      ease.at ??= now;
      const done = reduced || now - ease.at >= (ease.ms ?? KNOB_EASE * 1000);
      const value = done ? ease.to : easedValue(ease, now);
      if (ease.kind === 'scroll') run.state = { ...run.state, scroll: { ...run.state.scroll, [control]: value } };
      else if (ease.kind === 'toggle') {
        if (done) {
          const { [control]: _gone, ...rest } = run.state.thumb ?? {};
          run.state = { ...run.state, toggle: { ...run.state.toggle, [control]: ease.to >= 0.5 }, thumb: rest };
        } else run.state = { ...run.state, thumb: { ...run.state.thumb, [control]: value } };
      } else run.state = { ...run.state, slider: { ...run.state.slider, [control]: value } };
      if (done) run.eases.delete(control);
      moved = true;
    }
  }
  return moved;
}

/** Whether a field of this mock-up has the keyboard. */
export function typingUi(blockKey: string): boolean {
  return RUNTIMES.get(blockKey)?.state.focus != null;
}

/** A key typed (or a character, or Backspace, Enter, Escape) into the field that has the keyboard. True when it was taken. */
export function typeUi(blockKey: string, key: string): boolean {
  const run = RUNTIMES.get(blockKey);
  if (run === undefined || run.state.focus === null) return false;
  const next = typeInto(run.state, key);
  if (next === run.state) return key.length === 1 || key === 'Backspace';
  run.state = next;
  return true;
}

/** A mock-up as a tester finds it, in stage units (the stage's own origin in the middle): what a finger can work, where its words are, and what the kit's own lint says. */
export interface UiMockupView {
  readonly block: string;
  readonly screen: string;
  readonly hits: readonly { readonly id: string; readonly part: string; readonly action: 'tab' | 'pick' | 'toggle' | 'field' | 'slider' | 'press' | 'scroll'; readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly send?: boolean; readonly to?: string }[];
  /** one box per line of words, where its ink is */
  readonly words: readonly { readonly owner: string; readonly text: string; readonly x: number; readonly y: number; readonly width: number; readonly height: number }[];
  readonly notes: readonly { readonly kind: string; readonly id: string; readonly message: string }[];
}

/**
 * The mock-ups on stage as they rest, for the test hook: the live parts a finger can work now (a screen shown small beside the large one cannot be
 * worked: a tap brings it forward), the words as they are drawn, and the kit's lint notes.
 */
export function uiMockupViews(blockKeys: readonly string[]): readonly UiMockupView[] {
  const out: UiMockupView[] = [];
  for (const block of blockKeys) {
    const last = RUNTIMES.get(block)?.last;
    if (last === null || last === undefined) continue;
    for (const p of last.board.placements) {
      const screen = last.layouts[p.index];
      if (screen === undefined) continue;
      const working = last.board.mode !== 'focus' || p.index === last.board.focus;
      const hits = working
        ? screen.hits.map((hit) => ({ id: hit.id, part: hit.part, action: hit.action.kind === 'flip' ? ('toggle' as const) : hit.action.kind, x: last.room.x + p.contentX + hit.x * p.scale, y: last.room.y + p.contentY + hit.y * p.scale, width: hit.w * p.scale, height: hit.h * p.scale, ...(hit.action.kind === 'press' && hit.action.send === true ? { send: true } : {}), ...(hit.action.kind === 'press' && hit.action.to !== undefined ? { to: hit.action.to } : {}) }))
        : [];
      const words: { owner: string; text: string; x: number; y: number; width: number; height: number }[] = [];
      for (const part of last.board.parts) {
        if (part.kind !== 'text' || !part.owner.startsWith(`${screen.id}`) && part.owner !== screen.id) continue;
        const clip = part.clip;
        part.lines.forEach((line, index) => {
          const width = Math.min(line.width, part.w);
          const x = part.align === 'center' ? part.x + (part.w - width) / 2 : part.align === 'right' ? part.x + part.w - width : part.x;
          const y = part.y + index * part.line + (part.line - part.size) / 2;
          let x0 = x;
          let y0 = y;
          let x1 = x + width;
          let y1 = y + part.size;
          if (clip !== undefined) {
            x0 = Math.max(x0, clip.x);
            y0 = Math.max(y0, clip.y);
            x1 = Math.min(x1, clip.x + clip.w);
            y1 = Math.min(y1, clip.y + clip.h);
          }
          if (x1 > x0 && y1 > y0) words.push({ owner: part.owner, text: line.text, x: last.room.x + x0, y: last.room.y + y0, width: x1 - x0, height: y1 - y0 });
        });
      }
      out.push({ block, screen: screen.id, hits, words, notes: screen.notes.map((note) => ({ kind: note.kind, id: note.id, message: note.message })) });
    }
  }
  return out;
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
/** The smallest type, in pixels as drawn, of a screen that is being worked (a thumbnail in a strip is not read, it is pointed at). Wide stages: the desk floor of the census; narrow: the phone's. */
const MIN_TEXT_PX = { wide: 12, narrow: 11 } as const;
/** The largest the smallest type may be set, in points, before one screen is shown large instead of all of them small. */
const MOST_TYPE = 19;

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
  const looks = tokensFor(spec);
  // A page cannot be read at 1280 points in 390: on a narrow stage a browser or a desk window is shown as the phone it would be (the same parts, laid out for it)
  const narrow = room.width < NARROW;
  const device: Record<string, 'phone'> = {};
  if (narrow) for (const screen of doc.screens) if ((screen.device === 'browser' || screen.device === 'desktop') && run.state.device[screen.id] === undefined) device[screen.id] = 'phone';
  const state: UiState = { ...run.state, device: { ...run.state.device, ...device }, picture: Object.fromEntries(PICTURES) };
  const counts = linesPerScreen(doc);
  const focus = Math.max(0, Math.min(doc.screens.length - 1, run.focus));
  const make = (tokens: UiTokens, mode: 'overview' | 'focus'): { readonly layouts: readonly UiScreenLayout[]; readonly board: Board } => {
    const layouts = doc.screens.map((screen, i) => layoutScreen(screen, tokens, measure, state, counts[i] ?? 0));
    return { layouts, board: arrangeBoard(layouts, tokens, measure, { w: room.width, h: room.height }, { mode, focus, margin: MARGIN }) };
  };
  // The smallest type on screen must read: what the board is scaled by, and the type's own size, are two halves of one number. Where the room is not tall
  // enough for the screens at a scale that lets the smallest type be MIN_TEXT_PX, the type is set larger in points (the screens' proportions are the same
  // and their parts keep their order); and where that would be more than a screen can hold, one screen is shown large and the rest as a strip.
  const floor = narrow ? MIN_TEXT_PX.narrow : MIN_TEXT_PX.wide;
  let mode: 'overview' | 'focus' = doc.screens.length > 1 && (narrow || run.solo) ? 'focus' : 'overview';
  let tokens = looks;
  let made = make(tokens, mode);
  for (let pass = 0; pass < 4; pass += 1) {
    const want = floor / Math.max(0.1, made.board.scale);
    if (want <= looks.type.caption.size + 0.01) break;
    if (want > MOST_TYPE && mode === 'overview' && doc.screens.length > 1) {
      mode = 'focus';
      made = make(tokens, mode);
      continue;
    }
    const next = { ...looks, minText: Math.min(MOST_TYPE, Math.ceil(want * 4) / 4) };
    if (tokens.minText !== undefined && next.minText <= tokens.minText + 0.01) break;
    tokens = next;
    made = make(tokens, mode);
  }
  const { layouts, board } = made;
  const last: Last = { room, board, layouts, doc, state, players: playersOf(doc) };
  run.last = last;
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
  // the renderer draws by whole z levels, so every figure and every line of words has a level of its own, in the kit's own order of drawing
  const base = structure.order + 1;
  const prefix = `${structure.key}/`;
  const shift = (b: Box | undefined): Box | undefined => (b === undefined ? undefined : { ...b, x: b.x + sx, y: b.y + sy });
  const figures: FigureFrame[] = frame.figures.map((figure) => {
    const key = prefix + figure.key;
    rowOf.set(key, ownerRow.get(figure.id) ?? 0);
    const clip = shift(figure.clip);
    return { ...figure, key, z: Math.min(8999, base + figure.z), transform: { ...figure.transform, e: figure.transform.e + sx, f: figure.transform.f + sy }, ...(clip === undefined ? {} : { clip }) } as FigureFrame;
  });
  let fontPx = Number.POSITIVE_INFINITY;
  // the type of a thumbnail in a strip is not read, it is pointed at: the smallest type is the smallest of the screens that are worked
  const thumbnail = new Set(board.mode === 'focus' ? layouts.filter((_, i) => i !== board.focus).map((layout) => layout.id) : []);
  const elements: ElementFrame[] = frame.elements.map((element) => {
    const key = prefix + element.key;
    rowOf.set(key, ownerRow.get(element.id) ?? 0);
    if (!thumbnail.has(element.id.split(':')[0]?.split('.')[0] ?? '')) fontPx = Math.min(fontPx, element.fontSize);
    const clip = shift(element.clip);
    return { ...element, key, z: Math.min(8999, base + element.z), x: element.x + sx, y: element.y + sy, ...(clip === undefined ? {} : { clip }) };
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
  LASTS.set(drawn, last);
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
  // a finger is aimed at the layout that is on screen: while rows land the board is made again and again, and the last one made is not the one being shown
  const shown = LASTS.get(drawn);
  const held = RUNTIMES.get(structure.key);
  if (shown !== undefined && held !== undefined) held.last = shown;
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
    // a mock-up carried in from an earlier turn, or a resting stage's own (its clock is at 0), is whole: there is no row still to land
    if (structure.carried) return 1;
    const at = rows[drawn.rowOf.get(key) ?? 0]?.at ?? 0;
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
