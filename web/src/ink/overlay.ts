// An ink layer over anything on the canvas: the stage, a mock-up's box, a chart, a live app's still, a photo, a card of a document node.
//
// The layer is a child of the target (a box, any element that can have children) or a sibling laid exactly over it (a picture, a canvas, a video, a frame),
// and follows its size. What it draws over is named with `on` (a node id, an element id, an ask id: the view's own words), which goes up with the strokes.

import type { InkOn } from '@conduit/language';
import { createInk } from './layer';
import type { Ink, InkOptions } from './layer';
import { injectInkStyles } from './styles';

export interface Overlay {
  readonly ink: Ink;
  /** the element the layer is in */
  readonly container: HTMLElement;
  /** shows or hides the layer; hidden ink is kept */
  setActive(active: boolean): void;
  dispose(): void;
}

const REPLACED = new Set(['IMG', 'CANVAS', 'VIDEO', 'IFRAME', 'SVG', 'OBJECT']);

export function overlayOn(target: HTMLElement, options: InkOptions & { readonly on?: InkOn } = {}): Overlay {
  const doc = target.ownerDocument;
  injectInkStyles(target.getRootNode() instanceof ShadowRoot ? (target.getRootNode() as ShadowRoot) : doc);
  const replaced = REPLACED.has(target.tagName.toUpperCase());
  const parent = replaced ? target.parentElement : target;
  if (parent === null) throw new Error('The ink layer has nowhere to go: that element has no parent.');
  let restore: (() => void) | null = null;
  if (getComputedStyle(parent).position === 'static') {
    parent.style.position = 'relative';
    restore = () => {
      parent.style.position = '';
    };
  }
  const container = doc.createElement('div');
  container.className = 'ink-over';
  container.style.cssText = 'position:absolute;z-index:20;';
  parent.append(container);

  const follow = (): void => {
    if (!replaced) {
      Object.assign(container.style, { left: '0', top: '0', width: '100%', height: '100%' });
      return;
    }
    Object.assign(container.style, { left: `${target.offsetLeft}px`, top: `${target.offsetTop}px`, width: `${target.offsetWidth}px`, height: `${target.offsetHeight}px` });
  };
  follow();
  const watch = new ResizeObserver(follow);
  watch.observe(target);

  let space = options.space;
  let backdrop = options.backdrop;
  if (target instanceof HTMLImageElement && target.naturalWidth > 0) {
    space ??= { w: target.naturalWidth, h: target.naturalHeight };
    backdrop ??= async () => ({ kind: 'image' as const, image: target });
  } else if (target instanceof HTMLCanvasElement) {
    space ??= { w: target.width, h: target.height };
    backdrop ??= async () => ({ kind: 'image' as const, image: target });
  }
  const ink = createInk(container, { ...options, ...(space === undefined ? {} : { space }), ...(backdrop === undefined ? {} : { backdrop }) });
  return {
    ink,
    container,
    setActive(active) {
      container.hidden = !active;
      container.style.pointerEvents = active ? '' : 'none';
      if (active) ink.refresh();
    },
    dispose() {
      watch.disconnect();
      ink.dispose();
      container.remove();
      restore?.();
    },
  };
}
