// The Undo chip: after a turn that changed a drawing, one small button at the foot of the stage puts the drawing back as it was
// (the server steps back one version from its own memory; no model is asked). It goes when the next turn begins.

export interface UndoChip {
  /** `dock`: an element to stand in as its last item (the tour's bar, when that is up: both stand at the foot of the stage and met there, fb-031); null or none: the stage's own corner */
  show(dock?: HTMLElement | null): void;
  hide(): void;
  dispose(): void;
}

const CORNER = 'position:absolute;z-index:6;right:16px;bottom:64px;min-height:36px;padding:0 14px;border-radius:18px;border:1px solid var(--stage-dim,#888);background:var(--look-ground,var(--stage-ground,#fff));color:var(--stage-ink,#111);font:600 14px system-ui;cursor:pointer;pointer-events:auto;white-space:nowrap';
const DOCKED = 'min-height:40px;padding:0 16px;border-radius:20px;border:1px solid var(--stage-dim,#888);background:var(--look-ground,var(--stage-ground,#fff));color:var(--stage-ink,#111);font:600 14px system-ui;cursor:pointer;pointer-events:auto;white-space:nowrap';

export function createUndoChip(host: HTMLElement, undo: () => void): UndoChip {
  const button = document.createElement('button');
  button.type = 'button';
  button.hidden = true;
  button.textContent = 'Undo';
  button.title = 'Put the drawing back as it was before this change (/undo)';
  button.setAttribute('data-undo-chip', '');
  button.style.cssText = CORNER;
  button.addEventListener('click', () => {
    button.hidden = true;
    undo();
  });
  host.append(button);
  return {
    show: (dock = null) => {
      if (dock === null) {
        if (button.parentElement !== host) host.append(button);
        button.style.cssText = CORNER;
      } else {
        dock.append(button);
        button.style.cssText = DOCKED;
      }
      button.hidden = false;
    },
    hide: () => {
      button.hidden = true;
    },
    dispose: () => button.remove(),
  };
}
