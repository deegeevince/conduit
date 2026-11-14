import type { StageHook } from '../contracts/hook';
import type { StageApp } from './stage-app';

/** Builds the StageHook for an app. `mountStage` calls this; pages decide where on `window` it goes. */
export function createHook(app: Omit<StageApp, 'hook'>, ready: Promise<void>): StageHook {
  const { painter } = app;
  return {
    ready,
    state: () => painter.snapshot(),
    elements: () => painter.snapshot().elements,
    lines: () => painter.snapshot().lines,
    events: () => app.sentEvents(),
    pause: () => painter.pause(),
    play: () => painter.play(),
    seek(seconds) {
      painter.seek(seconds);
      return painter.snapshot();
    },
    step(seconds) {
      painter.step(seconds);
      return painter.snapshot();
    },
    prompt: (text) => app.prompt(text),
    demo: (name) => app.demo(name),
    tap(id) {
      const element = painter.snapshot().elements.find((candidate) => candidate.id === id);
      if (element === undefined) throw new Error(`Nothing with the id "${id}" is on stage.`);
      painter.tapElement(element.key);
    },
    charts: () => painter.snapshot().charts,
    // STUB (PLAN-v2.md, package K): the app owns the chart surfaces and asks their handles.
    chart: (id) => Promise.reject(new Error(`No chart with the id "${id}" can be worked yet.`)),
    controls: () => painter.snapshot().controls,
    control(id, value) {
      if (!painter.snapshot().controls.some((candidate) => candidate.id === id)) throw new Error(`No control with the id "${id}" is on stage.`);
      painter.setControl(id, value ?? null, true);
    },
    interrupt: () => app.interrupt(),
    showAll: () => app.showAll(),
    script: () => app.script(),
    playScript: (script) => app.playScript(script),
    sight: () => app.sight(),
    capture: (maxSide) => app.capture(maxSide),
    export: (request) => app.export(request),
  };
}
