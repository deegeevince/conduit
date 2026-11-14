// STUB (WS2, `W/surfaces/host.ts`): the sandboxed frame the lesson runs in, until the host lands with the protocol of PLAN-v3-core 2.6.
// It is the same controls, small: `sandbox="allow-scripts"` and nothing else (an opaque origin), the document loaded by `srcdoc`, the
// policy of 2.6 first in it, messages checked by source, channel secret, shape, size and rate, a ping a second with three missed replacing
// the leaf by its words. When host.ts lands, `mountLessonFrame` becomes a call on it and this file goes.

import program from 'virtual:lesson-program';
import kit from '../kit.css?raw';
import lessonCss from './lesson.css?raw';
import type { LessonDown, LessonUp } from './types';

/** The policy, as 2.6 states it. */
export const SURFACE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; worker-src 'none'";

const LIMIT: Readonly<Record<LessonUp['type'], number>> = { ready: 200, pong: 200, save: 64_000, emit: 2_000, size: 200, fault: 1_000, census: 300_000, still: 3_000_000 };
const TYPES = Object.keys(LIMIT);

export interface FrameProbe {
  readonly loaded: boolean;
  readonly refused: number;
  readonly stalled: boolean;
  readonly received: number;
}

export interface LessonFrame {
  readonly element: HTMLIFrameElement;
  send(message: LessonDown): void;
  onMessage(handler: (message: LessonUp) => void): void;
  onStall(handler: () => void): void;
  probe(): FrameProbe;
  dispose(): void;
}

function secret(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The page the frame runs: policy, styles, the channel, the program. Nothing the brain wrote is in it (the data comes by `init`). */
export function lessonDocument(channel: string): string {
  const safe = program.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${SURFACE_CSP}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    `<style>${kit}\n${lessonCss}</style></head><body><div id="root"></div>`,
    `<script>window.conduitBoot=${JSON.stringify({ ch: channel })};</script>`,
    `<script>${safe}</script></body></html>`,
  ].join('');
}

export function mountLessonFrame(parent: HTMLElement): LessonFrame {
  const channel = secret();
  const element = document.createElement('iframe');
  element.setAttribute('sandbox', 'allow-scripts');
  element.setAttribute('referrerpolicy', 'no-referrer');
  element.setAttribute('title', 'Your lesson');
  element.style.cssText = 'display:block;width:100%;height:100%;border:0;background:transparent';
  let handler: (message: LessonUp) => void = () => undefined;
  let stall: () => void = () => undefined;
  let refused = 0;
  let received = 0;
  let loaded = false;
  let missed = 0;
  let stalled = false;
  const stamps: number[] = [];

  const onMessage = (event: MessageEvent): void => {
    if (event.source !== element.contentWindow) return;
    const data: unknown = event.data;
    if (typeof data !== 'object' || data === null) return void refused++;
    const record = data as Record<string, unknown>;
    const type = record['type'];
    if (record['conduit'] !== 1 || record['ch'] !== channel || typeof type !== 'string' || !TYPES.includes(type)) return void refused++;
    const limit = LIMIT[type as LessonUp['type']];
    let size = 0;
    try {
      size = JSON.stringify(data).length;
    } catch {
      return void refused++;
    }
    if (size > limit) return void refused++;
    if (type === 'save' || type === 'emit') {
      const now = performance.now();
      while (stamps.length > 0 && now - (stamps[0] ?? 0) > 1000) stamps.shift();
      if (stamps.length >= 20) return void refused++;
      stamps.push(now);
    }
    received += 1;
    if (type === 'ready') loaded = true;
    if (type === 'pong') missed = 0;
    handler(data as LessonUp);
  };
  window.addEventListener('message', onMessage);

  const beat = window.setInterval(() => {
    if (!loaded || stalled) return;
    missed += 1;
    if (missed > 3) {
      stalled = true;
      stall();
      return;
    }
    element.contentWindow?.postMessage({ conduit: 1, ch: channel, type: 'ping' }, '*');
  }, 1000);

  element.srcdoc = lessonDocument(channel);
  parent.append(element);

  return {
    element,
    send: (message) => element.contentWindow?.postMessage({ conduit: 1, ch: channel, ...message }, '*'),
    onMessage: (next) => {
      handler = next;
    },
    onStall: (next) => {
      stall = next;
    },
    probe: () => ({ loaded, refused, stalled, received }),
    dispose: () => {
      window.removeEventListener('message', onMessage);
      window.clearInterval(beat);
      element.remove();
    },
  };
}
