// The lesson program: the one script that runs inside the sandboxed surface, on the host of `web/src/surfaces/host.ts`. It is bundled to a single
// minified script (scripts/lesson-program.ts) and written into the frame's document with the kit's CSS and the lesson's. It has no way out but
// the host's bridge: `conduit.send` for what a hand changed, `conduit.state` for a copy of her state, and the page's `data` messages in.
//
//   in   the page's payload rides the look's tokens (`tokens.lesson`): the document, her state, the palette; and a count that asks for the census
//   out  `cursor`, `try`, `held` (what advance committed, written small: a value is at most 300 characters), `open` (another document),
//        `openpart` (a painted scene or an app, to be opened where it is drawn), `hello`
//        (once, so the page sends the payload), `census` (the summary the page asked for)
//
// The page's copy of her state is made by the same `advance` from the same changes, so the two cannot disagree; the lesson keeps its own state
// and the page's payload only replaces it when it says so (a document opened again).

import { takeCensus, summarise } from './census';
import { encode } from './changes';
import { Player } from './player';
import type { DocState, LessonCensus, LessonInput, LessonPayload, LessonTokens, StateChange } from './types';

interface Bridge {
  send(name: string, value: string | number | boolean): void;
  state(next?: unknown): unknown;
}

declare global {
  interface Window {
    /** the host's bridge, written into the frame before this script runs */
    readonly conduit?: Bridge;
    /** what the bench's driver reads: the census whole, with every region and word (the host has no message for it yet; see the hand-back) */
    __lessonCensus?: () => LessonCensus | null;
  }
}

const bridge = window.conduit;
const root = document.getElementById('root');

function wear(tokens: LessonTokens): void {
  const style = document.documentElement.style;
  const set = (name: string, value: string): void => style.setProperty(name, value);
  set('--ground', tokens.ground);
  set('--card', tokens.card);
  set('--ink', tokens.ink);
  set('--dim', tokens.dim);
  set('--accent', tokens.accent);
  set('--on-accent', tokens.onAccent);
  set('--soft', tokens.soft);
  set('--line', tokens.line);
  set('--good', tokens.good);
  set('--good-soft', tokens.goodSoft);
  set('--nudge', tokens.nudge);
  set('--nudge-soft', tokens.nudgeSoft);
  set('--font', tokens.font);
  const radius = tokens.radius ?? 12;
  set('--r-s', `${Math.round(radius * 0.6)}px`);
  set('--r-m', `${Math.round(radius * 1.2)}px`);
  set('--r-l', `${Math.round(radius * 1.8)}px`);
  set('--ts', String(tokens.scale ?? 1));
  set('--tt', `${tokens.target ?? 48}px`);
  if (tokens.dark) document.documentElement.setAttribute('data-dark', '');
  else document.documentElement.removeAttribute('data-dark');
}

function isPayload(value: unknown): value is LessonPayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const input = v['input'];
  return typeof v['rev'] === 'number' && typeof v['tokens'] === 'object' && typeof input === 'object' && input !== null && 'doc' in input && 'state' in input;
}

let player: Player | null = null;
let rev = -1;
let asked = 0;
let flush = 0;
const waiting = new Map<string, StateChange>();

function tell(change: StateChange): void {
  const wire = encode(change);
  if (wire !== null) bridge?.send(wire.name, wire.value);
}

/** A control held is told once it has settled: the latest value of each, at most twice a second, so a child tapping fast stays inside the host's rate. */
function settle(): void {
  window.clearTimeout(flush);
  flush = window.setTimeout(() => {
    for (const change of waiting.values()) tell(change);
    waiting.clear();
  }, 500);
}

function commit(changes: readonly StateChange[], state: DocState): void {
  for (const change of changes) {
    if (change.kind === 'held') {
      waiting.set(`${change.node}\u0000${change.key}`, change);
      settle();
    } else {
      // an ordered change goes after the held values that came before it
      for (const held of waiting.values()) tell(held);
      waiting.clear();
      tell(change);
    }
  }
  // a copy of her state for the host to keep (it is told to the page a moment after it stops changing, and when the frame leaves)
  bridge?.state(state);
}

/**
 * Where the writing area is, for the ink module to be laid over it (it is mounted in the page over this frame with `overlayOn`, since the bridge
 * carries 300 characters and a hand's marks are more): `[node, ask, x, y, w, h]` in the frame's own pixels, or `[]` when there is none. Told when
 * it changes and once things have settled after a scroll, so a hand drawing does not spend the host's allowance of events.
 */
let slotTold = '';
let slotWait = 0;
function reportSlot(moving = false): void {
  // while the page scrolls the pen's box is wrong: put it away at once (it comes back where the paper has settled), so it never sits over a button
  if (moving && slotTold !== '[]' && slotTold !== '') {
    slotTold = '[]';
    bridge?.send('slot', '[]');
  }
  window.clearTimeout(slotWait);
  slotWait = window.setTimeout(() => {
    const el = root?.querySelector('[data-ink-slot]');
    const r = el?.getBoundingClientRect();
    // the pen is only laid over a paper that is wholly in the clear: under the pinned question or the dock it is put away, so it never sits over a card or a button
    const card = root?.querySelector('.ctx.pinned')?.getBoundingClientRect();
    const dock = root?.querySelector('.dock')?.getBoundingClientRect();
    // only where they truly overlap: in the two-column layout the card is in the left column and the paper in the right, so a card that ends below the paper's top is no reason to hide it
    const across = (o: DOMRect): boolean => r !== undefined && r.left < o.right - 2 && r.right > o.left + 2;
    const hidden = r !== undefined && ((card !== undefined && across(card) && r.top < card.bottom - 2) || (dock !== undefined && across(dock) && r.bottom > dock.top + 2));
    const told = el === null || el === undefined || r === undefined || hidden ? '[]' : JSON.stringify([el.getAttribute('data-ink-slot'), el.getAttribute('data-ask'), Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]);
    if (told === slotTold || told.length > 290) return;
    slotTold = told;
    bridge?.send('slot', told);
    watchSlot();
  }, 400);
}

/**
 * Ink stays locked to the paper. While the pen is laid over a paper, the paper is looked at every frame: when it has moved from where the pen was told
 * it is (a scroll in this page or in a box inside it, a card growing above it, a picture arriving, an entrance still easing), the pen is put away at once
 * and comes back where the paper has settled, so no stroke is ever drawn over a paper that is on its way somewhere else.
 */
let watching = false;
function watchSlot(): void {
  if (watching) return;
  watching = true;
  const look = (): void => {
    if (slotTold === '[]' || slotTold === '') {
      watching = false;
      return;
    }
    const told = JSON.parse(slotTold) as [string, string, number, number, number, number];
    const el = root?.querySelector('[data-ink-slot]');
    const r = el?.getBoundingClientRect();
    if (r === undefined || Math.abs(r.x - told[2]) > 1.5 || Math.abs(r.y - told[3]) > 1.5 || Math.abs(r.width - told[4]) > 1.5 || Math.abs(r.height - told[5]) > 1.5) reportSlot(true);
    requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
}

function start(input: LessonInput): void {
  if (root === null) return;
  player = new Player(root, input, { commit, open: (id) => bridge?.send('open', id), openPart: (id) => bridge?.send('openpart', id), picture: () => bridge?.send('picture', 1), inkCheck: (node, ask) => bridge?.send('inkcheck', JSON.stringify([node, ask])), inkClear: (node, ask) => bridge?.send('inkclear', JSON.stringify([node, ask])) });
  player.render();
  player.landOnPaper();
  reportSlot();
  new MutationObserver(() => reportSlot()).observe(root, { childList: true, subtree: true });
  addEventListener('scroll', () => reportSlot(true), { passive: true, capture: true });
  // a new width (a scrollbar appearing, the room turned) moves the paper too
  addEventListener('resize', () => reportSlot(true));
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => reportSlot()).observe(root);
  window.__lessonCensus = () => (player === null ? null : takeCensus(player, root));
}

addEventListener('message', (event) => {
  if (event.source !== parent) return;
  const data: unknown = event.data;
  if (typeof data !== 'object' || data === null) return;
  const tokens = (data as { readonly tokens?: unknown }).tokens;
  const payload = typeof tokens === 'object' && tokens !== null ? (tokens as { readonly lesson?: unknown }).lesson : undefined;
  if (!isPayload(payload) || payload.rev <= rev) return;
  rev = payload.rev;
  wear(payload.tokens);
  if (player === null) start(payload.input);
  else if (payload.replace) {
    player = null;
    start(payload.input);
  } else player.update(payload.input);
  if (payload.write !== undefined) player?.written(payload.write);
  if (payload.census > asked) {
    asked = payload.census;
    const census = window.__lessonCensus?.();
    if (census !== null && census !== undefined) bridge?.send('census', summarise(census));
  }
});
bridge?.send('hello', 1);
