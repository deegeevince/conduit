// Entry for bench-figure.html (PLAN-visuals, package FG2): the `figure` kind with no painter around it. The kind from the registry is asked for its
// model, layout, drawing, census and input, exactly as the core will, and its frames are put on the real WebGL renderer. A press on the stepper (a
// real pointer event) goes through the kind's own `input`; dots are redrawn every animation frame from the ambient clock.
//
//   ?fixture=heart|flower|bicycle|syringe|pen   ?look=paper|night|…   ?step=0   ?reduced=1   ?panel=0   ?pad=8
//
// `window.__figure` is what a driver reads: the layout as numbers, the dots, how lit each part is, and where the stepper is.

import type { ElementSpan } from '@conduit/language';
import type { Held } from '../core/contracts';
import { KINDS } from '../core/registry';
import { fixtureElement } from '../core/kinds/figure';
import type { Env, LeafEvent } from '../core/contracts';
import type { Frame } from '../contracts/frame';
import type { Viewport } from '../contracts/space';
import { REST_POSE } from '../contracts/space';
import { FONTS } from '../fonts';
import { LOOKS } from '../looks';
import { FIGURE_NAMES, EASE_SECONDS, paintFigure } from '../painter/blocks/figure';
import type { FigureLayout, Painted } from '../painter/blocks/figure';
import { createProbedRenderer } from '../render/three';
import type { LookId } from '@conduit/language';

const params = new URLSearchParams(location.search);
const kind = KINDS.figure;

interface BenchWindow extends Window {
  __figure?: unknown;
  __ready?: boolean;
  __error?: string;
}
const win: BenchWindow = window;

document.body.style.cssText = 'margin:0;background:#14161d;color:#cfd4df;font:12px/1.4 ui-monospace,Menlo,monospace;overflow:hidden';
const app = document.getElementById('app') as HTMLElement;
const host = document.createElement('div');
host.style.cssText = 'position:fixed;inset:0;overflow:hidden;touch-action:manipulation;-webkit-user-select:none;user-select:none';
app.append(host);

const renderer = createProbedRenderer();
let viewport: Viewport = { width: innerWidth, height: innerHeight, dpr: devicePixelRatio };
const pad = Number(params.get('pad') ?? 8);

interface State {
  fixture: string;
  look: LookId;
  step: number;
  reduced: boolean;
  /** the step before the last change, and the ambient second it changed at */
  easeFrom: number;
  changedAt: number;
}
const state: State = {
  fixture: params.get('fixture') ?? 'heart',
  look: (params.get('look') as LookId | null) ?? 'paper',
  step: Number(params.get('step') ?? 0),
  reduced: params.get('reduced') === '1' || matchMedia('(prefers-reduced-motion: reduce)').matches,
  easeFrom: 0,
  changedAt: -10,
};

function envFor(box: { width: number; height: number }): Env {
  const look = LOOKS[state.look];
  const phone = box.width <= 600;
  return {
    dpr: viewport.dpr,
    pointer: phone ? 'coarse' : 'fine',
    tokens: { body: 16, minShrink: 0.7, stroke: 2, radius: 4, grid: null, minTarget: 44, floor: phone ? 11 : 12 },
    measure: () => ({ width: 0, height: 0, lineHeight: 0, lines: [] }),
    px: () => 14,
    ink: (role) => look.roles[role],
    ground: look.roles.ground,
    canvasUnit: 1,
    legacy: { look },
  };
}

interface Leaf {
  readonly layout: ReturnType<typeof kind.layout>;
  readonly figure: FigureLayout;
  readonly box: { width: number; height: number };
}
let leaf: Leaf | null = null;
let painted: Painted | null = null;
let lastFrame: Frame | null = null;
let mounted = false;
const t0 = performance.now();
const clock = (): number => (performance.now() - t0) / 1000;

function layoutAgain(): void {
  const found = fixtureElement([`figure:${state.fixture}`]);
  if (found === null) throw new Error(`no figure fixture "${state.fixture}"`);
  const box = { width: viewport.width - 2 * pad, height: viewport.height - 2 * pad };
  const env = envFor(box);
  const held = { step: state.step } as Held<'figure'>;
  const model = kind.model(found.element as ElementSpan, found.parts, held, env);
  const measured = kind.measure(model, { maxWidth: box.width, maxHeight: box.height }, env);
  const size = { width: Math.min(box.width, Math.max(measured.width, measured.least.width)), height: Math.min(box.height, Math.max(measured.height, measured.least.height)) };
  const layout = kind.layout(model, size, env);
  leaf = { layout, figure: (layout as unknown as { layout: FigureLayout }).layout, box: size };
}

function frameOf(p: Painted, look: LookId): Frame {
  const spec = LOOKS[look];
  const { width, height, dpr } = viewport;
  const cx = width / 2;
  const cy = height / 2;
  const dx = pad - cx;
  const dy = pad - cy;
  const time = clock();
  return {
    time,
    ambient: time,
    wallTime: 0,
    clock: 'idle',
    viewport: { width, height, dpr },
    look,
    spec,
    lookChange: null,
    bodySize: 16,
    margin: 16,
    canvas: { box: { x: -cx, y: -cy, width, height }, unit: 1 },
    gridTop: -cy,
    ground: spec.roles.ground,
    camera: REST_POSE,
    agitation: 0,
    dim: 0,
    reducedMotion: state.reduced,
    elements: p.elements.map((e) => ({ ...e, x: e.x + dx, y: e.y + dy })),
    figures: p.figures.map((f) => (f.kind === 'shape' ? { ...f, transform: { ...f.transform, e: f.transform.e + dx, f: f.transform.f + dy } } : f)),
    fields: [],
    cursor: null,
  };
}

function redraw(): void {
  if (leaf === null) return;
  const ambient = state.reduced ? 0 : clock();
  const easing = !state.reduced && clock() - state.changedAt < EASE_SECONDS;
  painted = paintFigure(leaf.figure, { ambient, motion: !state.reduced, ...(easing ? { ease: { from: state.easeFrom, t: (clock() - state.changedAt) / EASE_SECONDS } } : {}) });
  lastFrame = frameOf(painted, state.look);
  if (mounted) renderer.render(lastFrame);
}

function relayout(): void {
  layoutAgain();
  redraw();
}

function press(x: number, y: number): void {
  if (leaf === null) return;
  const lx = x - pad;
  const ly = y - pad;
  const regions = kind.census(leaf.layout).regions;
  const hit = regions.find((r) => lx >= r.box.x && lx <= r.box.x + r.box.width && ly >= r.box.y && ly <= r.box.y + r.box.height);
  if (hit === undefined) return;
  const event: LeafEvent = { type: 'press', part: hit.part, x: lx, y: ly };
  const out = kind.input?.(leaf.layout, { step: state.step } as Held<'figure'>, event);
  if (out === null || out === undefined) return;
  setStep((out.held as { step: number }).step);
}

function setStep(step: number): void {
  if (step === state.step) return;
  state.easeFrom = state.step;
  state.step = step;
  state.changedAt = clock();
  relayout();
}

host.addEventListener('pointerdown', (e) => press(e.clientX, e.clientY));
addEventListener('keydown', (e) => {
  if (leaf === null) return;
  const key = e.key === 'ArrowRight' ? 'more' : e.key === 'ArrowLeft' ? 'less' : e.key === 'Home' ? 'first' : e.key === 'End' ? 'last' : null;
  if (key === null) return;
  const out = kind.input?.(leaf.layout, { step: state.step } as Held<'figure'>, { type: 'key', part: '', key });
  if (out !== null && out !== undefined) setStep((out.held as { step: number }).step);
});
addEventListener('resize', () => {
  viewport = { width: innerWidth, height: innerHeight, dpr: devicePixelRatio };
  if (mounted) renderer.resize(viewport);
  relayout();
});

// ------------------------------------------------------------------ the panel (a desk only; `?panel=0` for a picture)
if (params.get('panel') !== '0' && innerWidth >= 700) {
  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;left:8px;top:8px;z-index:5;background:#000c;padding:6px 8px;border-radius:6px;display:flex;gap:8px;align-items:center';
  const select = (label: string, options: readonly string[], value: string, apply: (v: string) => void): HTMLElement => {
    const l = document.createElement('label');
    l.append(`${label} `);
    const s = document.createElement('select');
    for (const o of options) s.add(new Option(o, o, false, o === value));
    s.addEventListener('change', () => apply(s.value));
    l.append(s);
    return l;
  };
  panel.append(
    select('fixture', FIGURE_NAMES, state.fixture, (v) => ((state.fixture = v), (state.step = 0), relayout())),
    select('look', Object.keys(LOOKS), state.look, (v) => ((state.look = v as LookId), relayout())),
  );
  app.append(panel);
}

// ------------------------------------------------------------------ what a driver reads
const round = (n: number): number => Math.round(n * 100) / 100;
const rectOf = (r: { x: number; y: number; width: number; height: number }): { x: number; y: number; w: number; h: number } => ({ x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height) });

win.__figure = {
  state: (): unknown => ({ ...state, viewport: { width: viewport.width, height: viewport.height }, pad }),
  setStep,
  set: (patch: Partial<State>): void => {
    Object.assign(state, patch);
    relayout();
  },
  /** every number a check needs, in the leaf's own pixels (add `pad` for the page's) */
  info: (): unknown => {
    if (leaf === null) return null;
    const f = leaf.figure;
    return {
      fixture: state.fixture,
      look: state.look,
      step: state.step,
      steps: f.input.steps.length,
      box: leaf.box,
      pad,
      share: f.share,
      scale: f.scale,
      subject: rectOf(f.subject),
      stage: rectOf(f.stage),
      labelPx: f.labelPx,
      dropped: f.dropped,
      notes: f.notes,
      parts: f.parts.map((p) => {
        const xs = p.poly.pts.map((q) => q.x);
        const ys = p.poly.pts.map((q) => q.y);
        return { id: p.id, closed: p.poly.closed, parent: p.parent, x0: round(Math.min(...xs)), y0: round(Math.min(...ys)), x1: round(Math.max(...xs)), y1: round(Math.max(...ys)), pts: p.poly.pts.map((q) => [round(q.x), round(q.y)]) };
      }),
      labels: f.labels.map((l) => ({ part: l.part, side: l.side, lines: l.lines, box: rectOf(l.box), anchor: l.anchor, leader: l.leader })),
      routes: f.routes.map((r) => ({ id: r.id, length: round(r.length), pts: r.poly.pts.map((q) => [round(q.x), round(q.y)]), items: r.items })),
      band: rectOf(f.chrome.band),
      caption: { lines: f.chrome.caption.lines, box: rectOf(f.chrome.caption.box) },
      stepper: f.chrome.stepper === null ? null : { prev: rectOf(f.chrome.stepper.prev), next: rectOf(f.chrome.stepper.next), counter: f.chrome.stepper.counter.text },
      lit: f.lit === null ? null : [...f.lit],
    };
  },
  dots: (): unknown => (painted === null ? [] : painted.figures.filter((s) => s.kind === 'shape' && /:dot:\d+$/.test(s.key)).map((s) => ({ key: s.key, x: round(s.transform.e), y: round(s.transform.f) }))),
  /** how solid each part is drawn now, by id */
  opacity: (): unknown => {
    const out: Record<string, number> = {};
    for (const s of painted?.figures ?? []) if (s.kind === 'shape' && s.key.startsWith(`${state.fixture}/`)) {
      const id = s.key.slice(state.fixture.length + 1);
      if (!id.includes('~') && !id.includes(':')) out[id] = round(s.opacity);
    }
    return out;
  },
  chevrons: (): unknown => (painted === null ? 0 : painted.figures.filter((s) => s.kind === 'shape' && /:chevron:\d+$/.test(s.key)).length),
  words: (): unknown => painted?.words.map((w) => ({ part: w.part, text: w.text, box: rectOf(w.box), px: w.px })) ?? [],
  frame: (): Frame | null => lastFrame,
};

// ------------------------------------------------------------------ go
async function start(): Promise<void> {
  relayout();
  try {
    await Promise.all(Object.values(FONTS).map((face) => new FontFace(face.family, `url(${face.url}) format("${face.format}")`).load().then((f) => document.fonts.add(f)).catch(() => undefined)));
    await renderer.mount(host, viewport, state.look, { looks: [state.look] });
    mounted = true;
  } catch (error) {
    win.__error = String(error);
  }
  redraw();
  for (let i = 0; i < 120 && mounted && !renderer.isDrawable(); i++) {
    await new Promise((r) => setTimeout(r, 50));
    redraw();
  }
  const tick = (): void => {
    redraw();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  win.__ready = true;
}

void start();
