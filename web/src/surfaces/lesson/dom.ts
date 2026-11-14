// Small DOM helpers for the lesson: elements from a tag and its attributes, SVG the same way, and a way to draw at the width a thing has.

import { typesetUnits } from '@conduit/language';

type Child = Node | string | null | false | undefined;
export type Attrs = Readonly<Record<string, string | number | boolean | null | undefined | ((event: Event) => void)>>;

function apply(el: Element, attrs: Attrs): void {
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (typeof value === 'function') el.addEventListener(name.replace(/^on/, ''), value);
    else if (value === true) el.setAttribute(name, '');
    else el.setAttribute(name, String(value));
  }
}
function fill(el: Element, children: readonly Child[]): void {
  for (const child of children) {
    if (child === null || child === false || child === undefined) continue;
    el.append(typeof child === 'string' ? document.createTextNode(typesetUnits(child)) : child);
  }
}

/** An HTML element. `class`, `data-act`, `aria-*`, and `onclick`-style handlers are plain attributes. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  apply(el, attrs);
  fill(el, children);
  return el;
}

const SVG = 'http://www.w3.org/2000/svg';
/** An SVG element. */
export function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  apply(el, attrs);
  fill(el, children);
  return el;
}

/**
 * Draws `paint` into `host` at the width `host` has, and again when that changes. Labels are real pixels, so nothing in a picture is smaller
 * on a phone than on a desk; this is how a picture knows its width. `min` is the width it assumes before it has one.
 */
export function atWidth(host: HTMLElement, paint: (width: number) => void, min = 280): void {
  let last = -1;
  const run = (): void => {
    const width = Math.max(120, Math.round(host.clientWidth > 0 ? host.clientWidth : min));
    if (width === last) return;
    last = width;
    paint(width);
  };
  run();
  if (typeof ResizeObserver === 'undefined') return;
  let frame = 0;
  // painted on the next frame, not inside the observer's own callback (that is a resize loop the browser warns of)
  const observer = new ResizeObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(run);
  });
  observer.observe(host);
}
