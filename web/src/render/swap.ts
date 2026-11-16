import type { Frame, Quality } from '../contracts/frame';
import type { ContextEvent, Renderer } from '../contracts/renderer';
import type { Viewport } from '../contracts/space';

export interface SwappableRenderer {
  /** what the painter holds: every call goes to whichever renderer is current */
  readonly renderer: Renderer;
  /** the renderer in use now */
  current(): Renderer;
  /** told when the quality really changes (the painter's governor drops a slow stage to lite) */
  onQuality: ((quality: Quality) => void) | null;
  /**
   * Puts `next` (already mounted) in the place of the current renderer, which is disposed. The last frame is drawn on it at once, so the stage
   * keeps what it was showing. Quality and size are carried over. The context listeners stay with the renderer that had them.
   */
  swapTo(next: Renderer, viewport: Viewport): void;
}

/** A renderer that can be replaced by another while the painter, the lens and the app keep the one they were given. */
export function createSwappable(first: Renderer): SwappableRenderer {
  let inner = first;
  let last: Frame | null = null;
  let quality: Quality = 'full';
  const contextListeners = new Set<(event: ContextEvent) => void>();
  let stopInner: (() => void) | null = null;

  const listen = (): void => {
    stopInner?.();
    stopInner = inner.onContext === undefined ? null : inner.onContext((event) => {
      for (const listener of [...contextListeners]) listener(event);
    });
  };
  listen();

  const renderer: Renderer = {
    get id() {
      return inner.id;
    },
    get capabilities() {
      return inner.capabilities;
    },
    get fontFile() {
      return inner.fontFile;
    },
    // always present: a plain renderer simply never says anything
    onContext(listener) {
      contextListeners.add(listener);
      return () => {
        contextListeners.delete(listener);
      };
    },
    recheck: () => inner.recheck?.(),
    mount: (host, viewport, look, options) => inner.mount(host, viewport, look, options),
    resize: (viewport) => inner.resize(viewport),
    render(frame) {
      last = frame;
      inner.render(frame);
    },
    isDrawable: () => inner.isDrawable(),
    reset: () => inner.reset(),
    preload: (url) => inner.preload(url),
    rasterise: (frame, options) => inner.rasterise(frame, options),
    pick: (x, y) => inner.pick(x, y),
    setQuality(next) {
      const changed = next !== quality;
      quality = next;
      if (changed) handle.onQuality?.(next);
      inner.setQuality(next);
    },
    dispose: () => inner.dispose(),
  };

  const handle: SwappableRenderer = {
    renderer,
    onQuality: null,
    current: () => inner,
    swapTo(next, viewport) {
      const old = inner;
      stopInner?.();
      stopInner = null;
      try {
        old.dispose();
      } catch {
        // already unusable
      }
      inner = next;
      listen();
      next.resize(viewport);
      next.setQuality(quality);
      if (last !== null) next.render({ ...last, viewport });
    },
  };
  return handle;
}
