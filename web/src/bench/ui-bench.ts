// Entry for bench-ui.html (PLAN-v2.2, package F0): the interface kit with no painter around it. A fixture's lines are
// parsed, laid out by the solver, drawn as the shapes and words the painter already draws, and put on the real WebGL
// renderer in either look. Tabs switch, picks and toggles flip, fields take text; a dashboard's chart is the real charting
// engine. `window.__ui` is what a driver reads: the numbers of rows 44 and 46, and the pictures' own facts.
//
//   ?fixture=journey|home|settings|dashboard  ?look=wireframe|studio  ?mode=overview|focus  ?focus=0  ?panel=0
//   ?oracle=2000          the solver against the browser's flexbox on generated trees (row 46)
//   ?lines=<text>         the brain's own lines, URL-encoded, one per `~`

import { chartModelOf } from '@conduit/language';
import type { ChartState, ChartTheme } from '../contracts/chart';
import type { Frame } from '../contracts/frame';
import type { LookSpec } from '../contracts/look';
import type { Viewport } from '../contracts/space';
import { FONTS } from '../fonts';
import { STUDIO, STUDIO_TOKENS } from '../looks/studio';
import { WIREFRAME, WIREFRAME_TOKENS } from '../looks/wireframe';
import { arrangeBoard, locate } from '../painter/blocks/ui/board';
import type { Board } from '../painter/blocks/ui/board';
import { DASHBOARD_CHART, FIXTURES } from '../painter/blocks/ui/fixtures';
import { uiFrame } from '../painter/blocks/ui/frame';
import type { UiTokens } from '../painter/blocks/ui/lang';
import { linesPerScreen, parseInterface } from '../painter/blocks/ui/lang';
import { paintersMeasure } from '../painter/blocks/ui/measure';
import { runOracle } from '../painter/blocks/ui/oracle';
import { layoutScreen } from '../painter/blocks/ui/screen';
import { NO_STATE } from '../painter/blocks/ui/types';
import type { UiScreenLayout, UiState } from '../painter/blocks/ui/types';
import { createProbedRenderer } from '../render/three';
import { createChartEngine } from '../render/chart';
import type { ChartHandle } from '../contracts/chart';

type LookName = 'wireframe' | 'studio';

const params = new URLSearchParams(location.search);
const win = window as unknown as Record<string, unknown>;
const measure = paintersMeasure();

const LOOKS: Readonly<Record<LookName, { readonly tokens: UiTokens; readonly spec: LookSpec }>> = {
  wireframe: { tokens: WIREFRAME_TOKENS, spec: WIREFRAME },
  studio: { tokens: STUDIO_TOKENS, spec: STUDIO },
};

interface State {
  fixture: string;
  look: LookName;
  mode: 'overview' | 'focus';
  focus: number;
  ui: UiState;
  lines: readonly string[];
}

const fixtureName = params.get('fixture') ?? 'journey';
const state: State = {
  fixture: fixtureName,
  look: (params.get('look') as LookName | null) === 'wireframe' ? 'wireframe' : 'studio',
  mode: params.get('mode') === 'focus' || (params.get('mode') === null && innerWidth < 700) ? 'focus' : 'overview',
  focus: Number(params.get('focus') ?? 0),
  ui: NO_STATE,
  lines: params.get('lines') !== null ? (params.get('lines') ?? '').split('~') : (FIXTURES[fixtureName]?.lines ?? FIXTURES['journey']?.lines ?? []),
};

document.body.style.cssText = 'margin:0;background:#14161d;color:#cfd4df;font:12px/1.4 ui-monospace,Menlo,monospace;overflow:hidden';
const app = document.getElementById('app');
if (app === null) throw new Error('missing #app');
const host = document.createElement('div');
host.style.cssText = 'position:fixed;inset:0;overflow:hidden';
const overlay = document.createElement('div');
overlay.style.cssText = 'position:fixed;inset:0;pointer-events:none;overflow:hidden';
const panel = document.createElement('div');
panel.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:5;background:#000c;padding:6px 8px;border-radius:6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;max-width:calc(100vw - 16px)';
app.append(host, overlay);
if (params.get('panel') !== '0') app.append(panel);

const renderer = createProbedRenderer();
const engine = createChartEngine();
const charts = new Map<string, { handle: ChartHandle; box: HTMLElement }>();

let viewport: Viewport = { width: innerWidth, height: innerHeight, dpr: devicePixelRatio };
let layouts: readonly UiScreenLayout[] = [];
let board: Board | null = null;
let lastFrame: Frame | null = null;
let timing = { layoutMs: 0, boardMs: 0, frameMs: 0 };
let notes = 0;

function relayout(): void {
  const look = LOOKS[state.look];
  const t0 = performance.now();
  const doc = parseInterface(state.lines);
  const counts = linesPerScreen(doc);
  layouts = doc.screens.map((s, i) => layoutScreen(s, look.tokens, measure, state.ui, counts[i] ?? 0));
  const t1 = performance.now();
  board = arrangeBoard(layouts, look.tokens, measure, { w: viewport.width, h: viewport.height }, { mode: state.mode, focus: state.focus, margin: viewport.width < 700 ? 16 : 40 });
  const t2 = performance.now();
  lastFrame = uiFrame(board.parts, { width: viewport.width, height: viewport.height, dpr: viewport.dpr, spec: look.spec });
  const t3 = performance.now();
  timing = { layoutMs: t1 - t0, boardMs: t2 - t1, frameMs: t3 - t2 };
  notes = layouts.reduce((n, l) => n + l.notes.length, 0);
}

function chartTheme(t: UiTokens): ChartTheme {
  return {
    ground: t.colour.surface,
    ink: t.colour.dim,
    grid: t.colour.line,
    crosshair: t.colour.dim,
    series: [t.colour.accent, t.colour.success, t.colour.faint],
    up: t.colour.success,
    down: t.colour.danger,
    accent: t.colour.accent,
    face: 'sans',
    fontFamily: FONTS['inter-400']?.family ?? 'sans-serif',
    fontPx: 11,
    hard: false,
  };
}

/** The real charting engine, in the room a `chart` part holds. */
function placeCharts(): void {
  const wanted = new Set<string>();
  if (engine !== null && board !== null) {
    const look = LOOKS[state.look];
    for (const layout of layouts) {
      const place = board.placements.find((p) => p.id === layout.id);
      if (place === undefined) continue;
      for (const slot of layout.slots) {
        const key = `${layout.id}/${slot.id}`;
        wanted.add(key);
        let entry = charts.get(key);
        if (entry === undefined) {
          const box = document.createElement('div');
          box.style.cssText = 'position:absolute;pointer-events:auto;overflow:hidden';
          overlay.append(box);
          entry = { handle: engine.mount(box), box };
          charts.set(key, entry);
        }
        const w = Math.max(40, slot.w * place.scale);
        const h = Math.max(40, slot.h * place.scale);
        entry.box.style.left = `${place.contentX + slot.x * place.scale}px`;
        entry.box.style.top = `${place.contentY + slot.y * place.scale}px`;
        entry.box.style.width = `${w}px`;
        entry.box.style.height = `${h}px`;
        const model = chartModelOf(DASHBOARD_CHART.kind, DASHBOARD_CHART.rows.map((cells) => ({ cells, at: 0 })));
        const chart: ChartState = { kind: DASHBOARD_CHART.kind, words: [], title: '', model, marks: [], theme: chartTheme(look.tokens), reveal: 1, landed: model.points.length, interactive: true, waiting: false, failed: false, reducedMotion: true };
        entry.handle.apply(chart, { width: w, height: h, dpr: viewport.dpr });
      }
    }
  }
  for (const [key, entry] of charts) {
    if (wanted.has(key)) continue;
    entry.box.remove();
    charts.delete(key);
  }
}

let mounted = false;

function draw(): void {
  relayout();
  if (lastFrame === null) return;
  if (mounted) renderer.render(lastFrame);
  placeCharts();
  rebuildPanel();
}

function resize(): void {
  viewport = { width: innerWidth, height: innerHeight, dpr: devicePixelRatio };
  if (mounted) renderer.resize(viewport);
  draw();
}

function setState(next: Partial<State>): void {
  Object.assign(state, next);
  draw();
}

function ui(patch: Partial<UiState>): void {
  state.ui = { ...state.ui, ...patch };
  draw();
}

// ------------------------------------------------------------------ touch

function activate(px: number, py: number): void {
  if (board === null) return;
  const at = locate(board, px, py);
  if (at === null) return;
  if (board.mode === 'focus' && at.index !== board.focus) {
    setState({ focus: at.index });
    return;
  }
  const layout = layouts[at.index];
  if (layout === undefined) return;
  const hit = [...layout.hits].reverse().find((h) => at.x >= h.x && at.x <= h.x + h.w && at.y >= h.y && at.y <= h.y + h.h);
  if (hit === undefined) {
    ui({ focus: null });
    return;
  }
  const a = hit.action;
  switch (a.kind) {
    case 'tab':
      ui({ tab: { ...state.ui.tab, [a.bar]: a.index }, focus: null });
      break;
    case 'pick':
      ui({ pick: { ...state.ui.pick, [a.control]: a.index }, focus: null });
      break;
    case 'toggle':
      ui({ toggle: { ...state.ui.toggle, [a.control]: !a.on }, focus: null });
      break;
    case 'field':
      ui({ focus: a.control, text: { ...state.ui.text, [a.control]: state.ui.text[a.control] ?? a.value } });
      break;
    case 'slider':
      ui({ slider: { ...state.ui.slider, [a.control]: Math.max(0, Math.min(1, (at.x - hit.x) / Math.max(1, hit.w))) }, focus: null });
      break;
    case 'press':
      ui({ pressed: a.control, focus: null });
      setTimeout(() => ui({ pressed: null }), 160);
      break;
  }
}

host.addEventListener('pointerdown', (e) => activate(e.clientX, e.clientY));
addEventListener('keydown', (e) => {
  const f = state.ui.focus;
  if (f !== null) {
    const current = state.ui.text[f] ?? '';
    if (e.key === 'Backspace') ui({ text: { ...state.ui.text, [f]: current.slice(0, -1) } });
    else if (e.key === 'Enter' || e.key === 'Escape') ui({ focus: null });
    else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) ui({ text: { ...state.ui.text, [f]: current + e.key } });
    e.preventDefault();
    return;
  }
  if (e.key === 'l') setState({ look: state.look === 'studio' ? 'wireframe' : 'studio' });
  else if (e.key === 'm') setState({ mode: state.mode === 'overview' ? 'focus' : 'overview' });
  else if (e.key === 'ArrowRight') setState({ focus: Math.min(layouts.length - 1, state.focus + 1), mode: 'focus' });
  else if (e.key === 'ArrowLeft') setState({ focus: Math.max(0, state.focus - 1), mode: 'focus' });
});
addEventListener('resize', resize);

// ------------------------------------------------------------------ the panel

function el<K extends keyof HTMLElementTagNameMap>(tag: K, set: (e: HTMLElementTagNameMap[K]) => void): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  set(e);
  return e;
}

function select(label: string, options: readonly string[], value: string, apply: (v: string) => void): HTMLElement {
  return el('label', (l) => {
    l.append(`${label} `);
    l.append(
      el('select', (s) => {
        for (const o of options) s.append(el('option', (x) => ((x.value = o), (x.textContent = o), (x.selected = o === value))));
        s.addEventListener('change', () => apply(s.value));
      }),
    );
  });
}

function rebuildPanel(): void {
  panel.replaceChildren(
    select('fixture', Object.keys(FIXTURES), state.fixture, (v) => setState({ fixture: v, lines: FIXTURES[v]?.lines ?? [], focus: 0, ui: NO_STATE })),
    select('look', ['wireframe', 'studio'], state.look, (v) => setState({ look: v as LookName })),
    select('view', ['overview', 'focus'], state.mode, (v) => setState({ mode: v as State['mode'] })),
    el('span', (s) => (s.textContent = `${layouts.length} screens  layout ${timing.layoutMs.toFixed(1)} ms  lint ${notes}`)),
  );
}

// ------------------------------------------------------------------ what a driver reads

/** Every fixture in both looks: the numbers of PLAN-v2.2 row 44, and the time the layout took. */
function report(oracle: number): unknown {
  const rows: unknown[] = [];
  const totals = { coordinates: 0, lostWords: 0, outside: 0, overlap: 0, offGrid: 0, smallTarget: 0, dense: 0, twoPrimary: 0, screens: 0, parts: 0 };
  let worstLines = 0;
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    for (const look of ['wireframe', 'studio'] as const) {
      const tokens = LOOKS[look].tokens;
      const doc = parseInterface(fixture.lines);
      const counts = linesPerScreen(doc);
      const t0 = performance.now();
      const screens = doc.screens.map((s, i) => layoutScreen(s, tokens, measure, NO_STATE, counts[i] ?? 0));
      const ms = performance.now() - t0;
      const all = screens.flatMap((s) => s.notes);
      const count = (kind: string): number => all.filter((n) => n.kind === kind).length;
      totals.coordinates += count('coordinates');
      totals.lostWords += count('lost-words');
      totals.outside += count('outside');
      totals.overlap += count('overlap');
      totals.offGrid += count('off-grid');
      totals.smallTarget += count('small-target');
      totals.dense += count('dense');
      totals.twoPrimary += count('two-primary');
      totals.screens += screens.length;
      totals.parts += screens.reduce((n, s) => n + s.boxes.size, 0);
      worstLines = Math.max(worstLines, ...counts);
      rows.push({ fixture: name, look, screens: screens.length, lines: counts, ms: Number(ms.toFixed(2)), shapes: screens.reduce((n, s) => n + s.parts.length, 0), parseNotes: doc.notes.length, notes: all.map((n) => `${n.kind} ${n.screen}/${n.id}: ${n.message}`) });
    }
  }
  return { rows, totals, worstLines, oracle: oracle > 0 ? runOracle(oracle) : null };
}

win['__ui'] = {
  report,
  state: (): unknown => ({ ...state, board: board === null ? null : { mode: board.mode, scale: board.scale, placements: board.placements } }),
  layouts: (): readonly UiScreenLayout[] => layouts,
  timing: (): unknown => timing,
  set: (patch: Partial<State>): void => setState(patch),
  tap: (px: number, py: number): void => activate(px, py),
  frame: (): Frame | null => lastFrame,
};

// ------------------------------------------------------------------ go

async function start(): Promise<void> {
  if (params.get('oracle') !== null) {
    const t0 = performance.now();
    const result = runOracle(Number(params.get('oracle')));
    win['__oracle'] = { ...result, ms: performance.now() - t0 };
  }
  relayout();
  try {
    await Promise.all(Object.values(FONTS).map((face) => new FontFace(face.family, `url(${face.url}) format("${face.format}")`).load().then((f) => document.fonts.add(f)).catch(() => undefined)));
    await renderer.mount(host, viewport, 'paper', { looks: ['paper'] });
    mounted = true;
  } catch (error) {
    win['__error'] = String(error);
  }
  draw();
  for (let i = 0; i < 120 && mounted && !renderer.isDrawable(); i++) {
    await new Promise((r) => setTimeout(r, 50));
    if (lastFrame !== null) renderer.render(lastFrame);
  }
  await new Promise((r) => setTimeout(r, 250));
  if (lastFrame !== null && mounted) renderer.render(lastFrame);
  win['__ready'] = true;
}

void start();
