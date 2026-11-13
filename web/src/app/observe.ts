import type { Frame } from '../contracts/frame';
import type { Renderer } from '../contracts/renderer';

export interface ObservedRenderer {
  readonly renderer: Renderer;
  /** the last frame handed to `render`, for a picture of the stage as it is */
  lastFrame(): Frame | null;
}

/**
 * Wraps a renderer so the app can see what the painter draws: the chrome follows the frame's look,
 * and a capture of the stage needs the frame it shows. Everything else passes straight through.
 */
export function observeRenderer(inner: Renderer, onFrame: (frame: Frame) => void): ObservedRenderer {
  let last: Frame | null = null;
  const renderer: Renderer = {
    get id() {
      return inner.id;
    },
    get capabilities() {
      return inner.capabilities;
    },
    ...(inner.fontFile === undefined ? {} : { fontFile: inner.fontFile }),
    ...(inner.onContext === undefined ? {} : { onContext: inner.onContext.bind(inner) }),
    mount: (host, viewport, look, options) => inner.mount(host, viewport, look, options),
    resize: (viewport) => inner.resize(viewport),
    render(frame) {
      last = frame;
      inner.render(frame);
      onFrame(frame);
    },
    isDrawable: () => inner.isDrawable(),
    reset: () => inner.reset(),
    preload: (url) => inner.preload(url),
    rasterise: (frame, options) => inner.rasterise(frame, options),
    pick: (x, y) => inner.pick(x, y),
    setQuality: (quality) => inner.setQuality(quality),
    dispose: () => inner.dispose(),
  };
  return { renderer, lastFrame: () => last };
}
