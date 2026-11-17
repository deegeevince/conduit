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
    apps: () => app.apps.probe(),
    charts: () => painter.snapshot().charts,
    chart(id, action) {
      const view = painter.snapshot().charts.find((candidate) => candidate.id === id);
      if (view === undefined || app.charts === null) return Promise.reject(new Error(`No chart with the id "${id}" is on stage.`));
      return app.charts.act(view.key, action);
    },
    mockups: () => painter.mockups(),
    leaders: () => painter.leaders(),
    bindings: () => painter.bindings(),
    lens: () => (app.lens === null ? null : { view: app.lens.view(), touched: app.lens.touched }),
    async reach(x, y) {
      const lens = app.lens;
      if (lens === null) return null;
      const host = document.getElementById('stage');
      const origin = host === null ? { left: 0, top: 0 } : host.getBoundingClientRect();
      const inside = (): { x: number; y: number } | null => {
        const at = lens.toScreen(x, y);
        const width = host === null ? innerWidth : host.clientWidth;
        const height = host === null ? innerHeight : host.clientHeight;
        return at.x >= 0 && at.y >= 0 && at.x <= width && at.y <= height ? at : null;
      };
      if (inside() === null) {
        lens.reveal({ x: x - 1, y: y - 1, width: 2, height: 2 });
        const until = performance.now() + 3000;
        const moving = (): boolean => (window as unknown as { __lensMoving?: () => boolean }).__lensMoving?.() === true;
        await new Promise<void>((done) => {
          const poll = (): void => (moving() && performance.now() < until ? void setTimeout(poll, 30) : done());
          setTimeout(poll, 30);
        });
      }
      const at = lens.toScreen(x, y);
      return { x: origin.left + at.x, y: origin.top + at.y };
    },
    controls: () => painter.snapshot().controls,
    maths: () => painter.mathViews(),
    control(id, value) {
      if (!painter.snapshot().controls.some((candidate) => candidate.id === id)) throw new Error(`No control with the id "${id}" is on stage.`);
      painter.setControl(id, value ?? null, true);
    },
    interrupt: () => app.interrupt(),
    music: () => ({ muted: app.sound.muted, playing: app.sound.playing(), notes: app.sound.log() }),
    showAll: () => app.showAll(),
    script: () => app.script(),
    playScript: (script) => app.playScript(script),
    sight: () => app.sight(),
    capture: (maxSide) => app.capture(maxSide),
    gpu: () => app.gpu(),
    export: (request) => app.export(request),
  };
}
