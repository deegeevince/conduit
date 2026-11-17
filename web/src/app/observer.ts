// The page's eyes, reporting up (SA3): what only the page knows and no turn carries, sent as one `observe` back event at most once a second,
// 20 items and 8 kB at a time. A resize, a scroll that has settled, a font whose metrics are not the table's, a live app reporting in.

import { OBSERVE_LIMITS, quoted } from '@conduit/language';
import type { BackEvent, ObserveItem } from '@conduit/language';
import type { Face, Weight } from '@conduit/language';
import type { AppBroken } from '../contracts/app';
import { FONTS, GLYPHS } from '../fonts';
import { FACES } from '../fonts/faces';
import { measureEm } from '../fonts/measure';

/** A scroll is reported once it has stopped moving for this long. */
const SETTLE_MS = 250;
/** The most a face's measured width may differ from its table before the server is told the page's metrics are not its own. */
const FONT_TOLERANCE = 0.005;

export interface Observer {
  /** a live app threw, or showed nothing: a blocking item, so the brain's next brief says so (the app's own words quoted, never more than text) */
  broken(broken: AppBroken): void;
  /** a viewport change that has settled */
  viewport(width: number, height: number, dpr: number): void;
  /** a live app or another surface reported in */
  surface(id: string, note: string): void;
  /** what the renderer and the page are doing (the GPU context, the renderer in use, the page hidden or shown), under an id of its own so two in a second are both told */
  report(id: string, note: string, severity?: 'info' | 'note'): void;
  dispose(): void;
}

export function startObserver(send: (event: BackEvent) => void, root: Document, ready: Promise<void>): Observer {
  const queue: ObserveItem[] = [];
  let sentAt = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let open = false;
  let disposed = false;

  const flush = (): void => {
    timer = undefined;
    if (disposed || !open || queue.length === 0) return;
    const wait = sentAt + OBSERVE_LIMITS.everyMs - performance.now();
    if (wait > 0) {
      timer = setTimeout(flush, wait);
      return;
    }
    const items: ObserveItem[] = [];
    while (queue.length > 0 && items.length < OBSERVE_LIMITS.items) {
      const next = queue[0] as ObserveItem;
      if (JSON.stringify([...items, next]).length > OBSERVE_LIMITS.bytes - 64) break;
      items.push(next);
      queue.shift();
    }
    if (items.length === 0) queue.shift();
    else {
      sentAt = performance.now();
      send({ type: 'observe', items });
    }
    if (queue.length > 0) timer = setTimeout(flush, OBSERVE_LIMITS.everyMs);
  };

  const note = (item: ObserveItem): void => {
    // the latest of the same thing replaces an unsent earlier one (a blocking item is its own words: two different crashes of one app are two)
    const same = queue.findIndex((one) => one.kind === item.kind && one.on === item.on && (item.severity !== 'blocking' || one.note === item.note));
    if (same >= 0) queue.splice(same, 1);
    queue.push(item);
    if (queue.length > OBSERVE_LIMITS.items * 3) queue.shift();
    if (timer === undefined) timer = setTimeout(flush, 0);
  };

  void ready.then(() => {
    open = true;
    if (queue.length > 0 && timer === undefined) timer = setTimeout(flush, 0);
  }, () => undefined);

  // Scroll: every scroll host, settled. Scroll events do not bubble from elements, so the listener is a capturing one on the document.
  const settling = new Map<EventTarget, ReturnType<typeof setTimeout>>();
  const hostName = (target: EventTarget): string => {
    if (target === root || target === root.defaultView) return 'page';
    if (target instanceof Element) return (target.id !== '' ? target.id : (target.getAttribute('data-surface') ?? [...target.classList][0] ?? target.tagName.toLowerCase())).slice(0, 48);
    return 'page';
  };
  const onScroll = (event: Event): void => {
    const target = event.target ?? root;
    const earlier = settling.get(target);
    if (earlier !== undefined) clearTimeout(earlier);
    settling.set(
      target,
      setTimeout(() => {
        settling.delete(target);
        const element = target instanceof Element ? target : (root.scrollingElement ?? root.documentElement);
        const top = Math.round(element.scrollTop);
        const range = Math.max(0, Math.round(element.scrollHeight - element.clientHeight));
        note({ kind: 'scroll', on: hostName(target), note: `${hostName(target)} settled at ${top} of ${range}px`, severity: 'info' });
      }, SETTLE_MS),
    );
  };
  root.addEventListener('scroll', onScroll, { capture: true, passive: true });

  // Fonts: the loaded faces measured by the browser against the table the layout trusts. Told only when they differ.
  const probe = (): void => {
    const canvas = root.createElement('canvas');
    const context = canvas.getContext('2d');
    if (context === null) return;
    const wrong: string[] = [];
    const seen = new Set<string>();
    for (const [face, spec] of Object.entries(FACES) as [Face, (typeof FACES)[Face]][]) {
      for (const [font, weight] of [[spec.font, 'normal'], [spec.boldFont, 'bold']] as const) {
        if (font === null || seen.has(font) || spec.metrics === null) continue;
        seen.add(font);
        const entry = FONTS[font];
        if (entry === undefined) continue;
        // only a face the page has already loaded: the probe never asks the network for one
        const loaded = [...root.fonts].some((one) => one.family.replace(/["']/g, '') === entry.family && one.status === 'loaded');
        if (!loaded) continue;
        context.font = `100px "${entry.family}"`;
        context.fontKerning = 'none';
        const measured = context.measureText(GLYPHS).width / 100;
        const table = measureEm(GLYPHS, face, weight as Weight);
        if (table > 0 && Math.abs(measured - table) / table > FONT_TOLERANCE) wrong.push(`${font} ${(((measured - table) / table) * 100).toFixed(1)}%`);
      }
    }
    if (wrong.length > 0) note({ kind: 'fonts', on: null, note: `the page's font metrics differ from the table: ${wrong.join(', ')}`, severity: 'fault' });
  };
  let probeTimer: ReturnType<typeof setTimeout> | undefined;
  void root.fonts?.ready.then(() => {
    if (!disposed) probeTimer = setTimeout(probe, 1500);
  });

  return {
    viewport(width, height, dpr) {
      note({ kind: 'viewport', on: null, note: `viewport now ${Math.round(width)}x${Math.round(height)} at ${dpr}x`, severity: 'info' });
    },
    surface(id, text) {
      note({ kind: 'surface', on: id, note: text, severity: 'info' });
    },
    broken(one) {
      note({ kind: 'surface', on: one.id, note: one.kind === 'crash' ? `app ${one.id} threw: ${quoted(one.message, 90)}${one.line === null ? '' : ` (line ${one.line})`}` : `app ${one.id} drew nothing: nothing visible 3 s after it loaded`, severity: 'blocking' });
    },
    report(id, text, severity = 'info') {
      note({ kind: 'surface', on: id, note: text, severity });
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      clearTimeout(probeTimer);
      for (const pending of settling.values()) clearTimeout(pending);
      root.removeEventListener('scroll', onScroll, { capture: true });
    },
  };
}
