// The ink layer's styles, as text injected once into the document (or shadow root) it is mounted in: a sandboxed surface has no network to load a
// stylesheet from. Colours are custom properties with fallbacks, so a host sets `--ink-ui-*` to wear its own look.

export const INK_CSS = `
.ink{position:relative;box-sizing:border-box;touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent;outline:none;overflow:hidden;cursor:crosshair}
.ink--fill{position:absolute;inset:0}
.ink--flow{width:100%}
.ink[data-tool="eraser"]{cursor:cell}
.ink:focus-visible{box-shadow:inset 0 0 0 2px var(--ink-ui-accent,#1565c0)}
.ink__bg{position:absolute;pointer-events:none;object-fit:fill;user-select:none;-webkit-user-drag:none}
.ink__guides{position:absolute;pointer-events:none}
.ink__box{position:absolute;box-sizing:border-box;border:2px dashed var(--ink-ui-guide,rgba(21,101,192,.55));border-radius:8px;background:var(--ink-ui-guide-fill,rgba(21,101,192,.05))}
.ink__box--scratch{border-color:var(--ink-ui-scratch,rgba(120,120,120,.5));background:transparent}
.ink__label{position:absolute;left:8px;top:-1.1em;padding:0 6px;font:600 12px/1.2 system-ui,sans-serif;color:var(--ink-ui-guide-text,#0d47a1);background:var(--ink-ui-ground,#fff);border-radius:4px}
.ink__base,.ink__live{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.ink-bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:6px;box-sizing:border-box;font:500 14px/1 system-ui,sans-serif;color:var(--ink-ui-text,#1f2933);background:var(--ink-ui-ground,#fff);border:1px solid var(--ink-ui-line,rgba(0,0,0,.15));border-radius:14px;box-shadow:0 2px 10px rgba(0,0,0,.12);touch-action:manipulation;user-select:none;-webkit-user-select:none}
.ink-bar__group{display:flex;gap:4px;align-items:center}
.ink-bar__group+.ink-bar__group{padding-left:6px;border-left:1px solid var(--ink-ui-line,rgba(0,0,0,.15))}
.ink-btn{min-width:44px;min-height:44px;padding:0 10px;display:inline-flex;align-items:center;justify-content:center;gap:6px;box-sizing:border-box;border:1px solid transparent;border-radius:10px;background:transparent;color:inherit;font:inherit;cursor:pointer;touch-action:manipulation}
.ink-btn:hover:not(:disabled){background:var(--ink-ui-hover,rgba(0,0,0,.06))}
.ink-btn:disabled{opacity:.35;cursor:default}
.ink-btn[aria-pressed="true"]{background:var(--ink-ui-on,rgba(21,101,192,.14));border-color:var(--ink-ui-accent,#1565c0)}
.ink-btn:focus-visible{outline:2px solid var(--ink-ui-accent,#1565c0);outline-offset:1px}
.ink-btn--send{background:var(--ink-ui-accent,#1565c0);color:var(--ink-ui-on-accent,#fff);font-weight:700;padding:0 16px}
.ink-btn--send:hover:not(:disabled){background:var(--ink-ui-accent,#1565c0);filter:brightness(1.1)}
.ink-swatch{width:44px;height:44px;padding:0;border-radius:50%;border:none;background:transparent;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
.ink-swatch__dot{width:26px;height:26px;border-radius:50%;box-sizing:border-box;border:2px solid var(--ink-ui-ground,#fff);box-shadow:0 0 0 1px rgba(0,0,0,.35)}
.ink-swatch[aria-pressed="true"] .ink-swatch__dot{box-shadow:0 0 0 3px var(--ink-ui-accent,#1565c0)}
.ink-swatch:focus-visible{outline:2px solid var(--ink-ui-accent,#1565c0)}
.ink-bar__words{flex:1 1 180px;min-width:140px;min-height:44px;box-sizing:border-box;padding:0 12px;border:1px solid var(--ink-ui-line,rgba(0,0,0,.25));border-radius:10px;font:inherit;font-size:16px;color:inherit;background:var(--ink-ui-field,#fff)}
.ink-bar__status{flex-basis:100%;margin:0;font-size:13px;color:var(--ink-ui-dim,#52606d)}
.ink-bar__status:empty{display:none}
.ink-stage{position:absolute;inset:0;z-index:30}
.ink-stage[hidden]{display:none}
.ink-stage--through,.ink-stage--through .ink{pointer-events:none}
.ink-stage--through .ink-stage__bar{pointer-events:auto}
.ink-bar[hidden]{display:none}
.ink-stage__bar{position:absolute;left:50%;transform:translateX(-50%);top:10px;max-width:calc(100% - 20px);z-index:2}
.ink-stage .ink{background:rgba(255,255,255,.02)}
@media (prefers-reduced-motion:no-preference){.ink-btn,.ink-swatch__dot{transition:background-color .12s,box-shadow .12s}}
`;

const injected = new WeakSet<object>();

/** Puts the styles in once per document or shadow root. */
export function injectInkStyles(into: Document | ShadowRoot): void {
  if (injected.has(into)) return;
  injected.add(into);
  const style = (into instanceof Document ? into : into.ownerDocument).createElement('style');
  style.setAttribute('data-ink', '');
  style.textContent = INK_CSS;
  (into instanceof Document ? into.head : into).append(style);
}
