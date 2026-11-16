// The page fits what is visible above the keyboard, and never scrolls.
//
// `--app-height` is the visual viewport's height, so the composer sits on the keyboard. `--app-top` is how far the browser has panned
// the visual viewport down inside the layout viewport. iPadOS (and iOS) pans it to bring a focused field into view, before the page has
// shrunk; that pan is not a scroll the page can undo, so the page follows it instead. Without this the shrink and the pan add up: the
// composer floats a pan's height above the keyboard bar and the top of the stage is cut off by the same amount. A pinch zoom also pans
// the visual viewport, so the page follows only at scale 1.
//
// `?vvdebug` in the address shows the numbers in a corner, for checking on a real device.

export function followVisualViewport(): void {
  const viewport = window.visualViewport;
  const root = document.documentElement.style;
  const debug = new URLSearchParams(window.location.search).has('vvdebug') ? readout() : null;
  const fit = (): void => {
    if (viewport === null) return;
    const top = viewport.scale > 1.01 ? 0 : Math.max(0, Math.round(viewport.offsetTop));
    root.setProperty('--app-height', `${Math.round(viewport.height)}px`);
    root.setProperty('--app-top', `${top}px`);
    if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
    if (debug !== null)
      debug.textContent = `inner ${window.innerHeight} · vv ${Math.round(viewport.height)} · top ${Math.round(viewport.offsetTop)} · scale ${viewport.scale.toFixed(2)} · scrollY ${Math.round(window.scrollY)} · app-top ${top}`;
  };
  viewport?.addEventListener('resize', fit);
  viewport?.addEventListener('scroll', fit);
  fit();
  // the page never scrolls: if anything moves it (a focus, a keyboard), it goes straight back
  window.addEventListener('scroll', () => {
    if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
    fit();
  });
}

function readout(): HTMLElement {
  const box = document.createElement('div');
  box.setAttribute('aria-hidden', 'true');
  box.style.cssText = 'position:fixed;left:4px;top:4px;z-index:99999;padding:4px 6px;font:12px/1.3 ui-monospace,monospace;background:#000c;color:#fff;border-radius:4px;pointer-events:none';
  document.body.append(box);
  return box;
}
