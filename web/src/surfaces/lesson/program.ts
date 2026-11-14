// The lesson program: the one script that runs inside the sandboxed surface. It is bundled to a single IIFE (scripts/lesson-program.ts) and the
// host writes it into the frame's document, with its channel secret, the kit's CSS and the lesson's. It speaks only the surface protocol of
// PLAN-v3-core 2.6: `ready`, `pong`, `save`, `emit`, `size`, `fault`, `census` and `still` up; `init`, `data`, `theme`, `ping` and `shoot` down.
// It reads nothing but the page's messages, and it has no way out but `postMessage`.

import { takeCensus } from './census';
import { Player } from './player';
import { still } from './still';
import type { LessonDown, LessonEvent, LessonInput, LessonTokens, LessonUp } from './types';

declare global {
  interface Window {
    /** written by the host before this script runs */
    conduitBoot?: { readonly ch: string };
  }
}

const channel = window.conduitBoot?.ch ?? '';
const root = document.getElementById('root');

function post(message: LessonUp): void {
  try {
    parent.postMessage({ conduit: 1, ch: channel, ...message }, '*');
  } catch {
    // a frame with no parent has nobody to tell
  }
}

function wear(tokens: LessonTokens): void {
  const style = document.documentElement.style;
  style.setProperty('--ground', tokens.ground);
  style.setProperty('--card', tokens.card);
  style.setProperty('--ink', tokens.ink);
  style.setProperty('--dim', tokens.dim);
  style.setProperty('--accent', tokens.accent);
  style.setProperty('--on-accent', tokens.onAccent);
  style.setProperty('--soft', tokens.soft);
  style.setProperty('--line', tokens.line);
  style.setProperty('--good', tokens.good);
  style.setProperty('--good-soft', tokens.goodSoft);
  style.setProperty('--nudge', tokens.nudge);
  style.setProperty('--nudge-soft', tokens.nudgeSoft);
  style.setProperty('--font', tokens.font);
  if (tokens.dark) document.documentElement.setAttribute('data-dark', '');
  else document.documentElement.removeAttribute('data-dark');
}

function isDown(data: unknown): data is LessonDown & { readonly conduit: 1; readonly ch: string } {
  if (typeof data !== 'object' || data === null) return false;
  const record = data as Record<string, unknown>;
  if (record['conduit'] !== 1 || record['ch'] !== channel || typeof record['type'] !== 'string') return false;
  if (record['type'] === 'init' || record['type'] === 'data') {
    const input = record['input'];
    return typeof input === 'object' && input !== null && 'doc' in input && 'state' in input;
  }
  return true;
}

let player: Player | null = null;
let wait = 0;

function report(): void {
  window.clearTimeout(wait);
  wait = window.setTimeout(() => {
    if (player === null || root === null) return;
    post({ type: 'census', census: takeCensus(player, root) });
    post({ type: 'size', height: document.documentElement.scrollHeight });
  }, 90);
}

function start(input: LessonInput): void {
  if (root === null) return;
  player = new Player(root, input, {
    save: (state) => post({ type: 'save', state }),
    emit: (event: LessonEvent) => post({ type: 'emit', event }),
    changed: report,
  });
  player.render();
}

addEventListener('message', (event) => {
  if (event.source !== parent) return;
  const data: unknown = event.data;
  if (!isDown(data)) return;
  if (data.type === 'init') {
    wear(data.tokens);
    start(data.input);
  } else if (data.type === 'data') player?.update(data.input);
  else if (data.type === 'theme') {
    wear(data.tokens);
    player?.render();
  } else if (data.type === 'ping') post({ type: 'pong' });
  else if (data.type === 'shoot') {
    const id = data.id;
    const width = window.innerWidth;
    const height = Math.min(document.documentElement.scrollHeight, 2400);
    void still(width, height).then((picture) => post({ type: 'still', id, width, height, data: picture }));
  }
});
addEventListener('resize', report);
addEventListener('scroll', report, { passive: true });
addEventListener('error', (event) => post({ type: 'fault', message: String(event.message).slice(0, 200) }));
addEventListener('unhandledrejection', (event) => post({ type: 'fault', message: String(event.reason instanceof Error ? event.reason.message : event.reason).slice(0, 200) }));
post({ type: 'ready' });
