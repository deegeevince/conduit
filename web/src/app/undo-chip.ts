// The Undo chip: after a turn that changed a drawing, one small button at the foot of the stage puts the drawing back as it was
// (the server steps back one version from its own memory; no model is asked). It goes when the next turn begins.

export interface UndoChip {
  show(): void;
  hide(): void;
  dispose(): void;
}

export function createUndoChip(host: HTMLElement, undo: () => void): UndoChip {
  const button = document.createElement('button');
  button.type = 'button';
  button.hidden = true;
  button.textContent = 'Undo';
  button.title = 'Put the drawing back as it was before this change (/undo)';
  button.setAttribute('data-undo-chip', '');
  button.style.cssText =
    'position:absolute;z-index:6;right:16px;bottom:64px;min-height:36px;padding:0 14px;border-radius:18px;border:1px solid var(--stage-dim,#888);background:var(--look-ground,var(--stage-ground,#fff));color:var(--stage-ink,#111);font:600 14px system-ui;cursor:pointer;pointer-events:auto;white-space:nowrap';
  button.addEventListener('click', () => {
    button.hidden = true;
    undo();
  });
  host.append(button);
  return {
    show: () => {
      button.hidden = false;
    },
    hide: () => {
      button.hidden = true;
    },
    dispose: () => button.remove(),
  };
}
