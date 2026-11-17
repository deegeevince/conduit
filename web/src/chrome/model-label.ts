// The journey's model label: what really ran, as the brain's own process reported it (the model id in the claude CLI's `system`/`init` event)
// and the effort the turn used, e.g. "Opus 5.5 · medium". Never from configuration: with no report from a brain (the replay brain) it says nothing.

import { modelLabel } from '../app/journey-script';
import type { StageApp } from '../app/stage-app';

export function mountModelLabel(root: HTMLElement, app: StageApp): () => void {
  const label = document.createElement('div');
  label.className = 'model-label';
  label.setAttribute('role', 'status');
  label.setAttribute('aria-label', 'The model that answered');
  label.hidden = true;
  root.append(label);
  const show = (): void => {
    const fact = app.facts.model();
    label.hidden = fact === null;
    if (fact !== null) label.textContent = modelLabel(fact.model, fact.effort);
  };
  const off = app.facts.onModel(show);
  show();
  return () => {
    off();
    label.remove();
  };
}
