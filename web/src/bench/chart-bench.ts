// Entry for bench-chart.html: the chart engine with no painter. Every kind in every look, the cases that are
// hard (several series, a volume pane, names and numbers along the bottom, marks, spark, live, the waiting and
// failed states), and the two measures of PLAN-v2 rows 8 and 9: the axes as written, and ten thousand points
// panned and zoomed. `window.__chartBench` is what a driver (and the battery) reads.

import { LOOK_IDS, chartModelOf } from '@conduit/language';
import type { ChartKind, ChartWord, LookId } from '@conduit/language';
import type { ChartHandle, ChartMark, ChartProbe, ChartState } from '../contracts/chart';
import { FONTS } from '../fonts';
import { LOOKS } from '../looks';
import { chartThemeOf, createChartEngine } from '../render/chart';

const rowsOf = (lines: readonly (readonly string[])[]): { cells: readonly string[]; at: number }[] => lines.map((cells) => ({ cells, at: 0 }));

interface Case {
  readonly name: string;
  readonly kind: ChartKind;
  readonly title: string;
  readonly rows: readonly (readonly string[])[];
  readonly words?: readonly ChartWord[];
  readonly marks?: readonly Omit<ChartMark, 'arrived'>[];
  readonly waiting?: boolean;
  readonly failed?: boolean;
  readonly w?: number;
  readonly h?: number;
}

function walk(count: number, start: number, seed: number, step: (i: number) => string, drift = 0.3): number[] {
  let x = start;
  let s = seed;
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    s = (s * 1664525 + 1013904223) % 4294967296;
    x += (s / 4294967296 - 0.5 + drift / 10) * start * 0.04;
    out.push(x);
    void step;
  }
  return out;
}

const day = (i: number): string => {
  const d = new Date(Date.UTC(2025, 0, 1) + i * 86400000);
  return d.toISOString().slice(0, 10);
};

function candles(count: number): string[][] {
  const closes = walk(count, 100, 7, day);
  return closes.map((c, i) => {
    const o = i === 0 ? 100 : (closes[i - 1] ?? 100);
    const h = Math.max(o, c) * 1.012;
    const l = Math.min(o, c) * 0.988;
    return [day(i), `${o.toFixed(2)} ${h.toFixed(2)} ${l.toFixed(2)} ${c.toFixed(2)} ${(1.2 + Math.abs(c - o) * 0.4).toFixed(1)}M`];
  });
}

const CASES: readonly Case[] = [
  { name: 'line, years', kind: 'line', title: 'World population, billions', rows: [['1800', '1.0'], ['1900', '1.6'], ['1950', '2.5'], ['2000', '6.1'], ['*2024*', '8.1']], marks: [{ key: 'm1', x: Date.UTC(1950, 0, 1) / 1000, y: null, label: 'Baby boom' }] },
  { name: 'area, months', kind: 'area', title: 'Revenue, $M', rows: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug'].map((m, i) => [`${m} 2026`, `$${(3.1 + i * 0.4 + (i % 3) * 0.3).toFixed(1)}M`]) },
  { name: 'columns, names', kind: 'columns', title: 'Users by plan', rows: [['Free', '12,400'], ['Plus', '3,100'], ['*Pro*', '1,240'], ['Team', '860']] },
  { name: 'columns, two series', kind: 'columns', title: 'Sales by quarter, $k', rows: [['', 'Europe', 'Asia'], ['Q1 2025', '$120k', '$90k'], ['Q2 2025', '$150k', '$110k'], ['Q3 2025', '$170k', '$160k'], ['Q4 2025', '$210k', '$200k']] },
  { name: 'line, three series', kind: 'line', title: 'Growth, indexed', words: ['indexed'], rows: [['', 'North', 'South', 'West'], ...Array.from({ length: 12 }, (_, i) => [`${2015 + i}`, `${(10 + i * 2).toFixed(1)}`, `${(20 + i * 1.2).toFixed(1)}`, `${(8 + i * 3.1).toFixed(1)}`])] },
  { name: 'candles + volume', kind: 'candles', title: 'ACME, daily', rows: [['', 'open', 'high', 'low', 'close', 'volume'], ...candles(60)] },
  { name: 'ohlc', kind: 'ohlc', title: 'ACME, bars', rows: candles(40) },
  { name: 'number axis', kind: 'line', title: 'Stopping distance, m', rows: [['10', '5'], ['20', '14'], ['30', '27'], ['60', '95'], ['100', '230']] },
  { name: 'marks', kind: 'line', title: 'Price with marks', rows: Array.from({ length: 30 }, (_, i) => [day(i * 3), `${(40 + Math.sin(i / 3) * 6 + i * 0.5).toFixed(2)}`]), marks: [{ key: 'e', x: Date.UTC(2025, 1, 10) / 1000, y: null, label: 'Launch' }, { key: 'l', x: null, y: 50, label: 'Target 50' }, { key: 'p', x: Date.UTC(2025, 2, 15) / 1000, y: 52, label: 'Peak' }] },
  { name: 'spark', kind: 'area', title: '', words: ['spark', 'live'], rows: Array.from({ length: 30 }, (_, i) => [`${i}`, `${(10 + Math.sin(i / 4) * 3 + i * 0.2).toFixed(2)}`]), w: 260, h: 90 },
  { name: 'approx log', kind: 'line', title: 'GDP, trillions', words: ['approx', 'log'], rows: [['1990', '$6T'], ['2000', '$10T'], ['2010', '$15T'], ['2020', '$21T']] },
  { name: 'waiting', kind: 'line', title: 'Loading series', rows: [], waiting: true },
  { name: 'failed', kind: 'line', title: 'Broken feed', rows: [], failed: true },
];

type Params = { look: LookId; kind: ChartKind; rows: readonly (readonly string[])[]; title: string; words?: readonly ChartWord[]; marks?: readonly Omit<ChartMark, 'arrived'>[]; waiting?: boolean; failed?: boolean; reveal?: number; interactive?: boolean };

function stateOf(p: Params): ChartState {
  const model = chartModelOf(p.kind, rowsOf(p.rows));
  return {
    kind: p.kind,
    words: p.words ?? [],
    title: p.title,
    model,
    marks: (p.marks ?? []).map((m) => ({ ...m, arrived: 1 })),
    theme: chartThemeOf(LOOKS[p.look]),
    reveal: p.reveal ?? 1,
    landed: model.points.length,
    interactive: p.interactive ?? true,
    waiting: p.waiting ?? false,
    failed: p.failed ?? false,
    reducedMotion: false,
  };
}

const engine = createChartEngine();
const app = document.getElementById('app') as HTMLElement;
app.style.cssText = 'font:12px ui-monospace,monospace;background:#111;color:#ccc;padding:12px;';
const handles = new Map<string, { handle: ChartHandle; state: ChartState; size: { width: number; height: number } }>();

async function loadFonts(): Promise<void> {
  await Promise.all(Object.values(FONTS).map((face) => new FontFace(face.family, `url(${face.url}) format("${face.format}")`).load().then((f) => document.fonts.add(f)).catch(() => undefined)));
}

function cell(parent: HTMLElement, key: string, look: LookId, c: Case, extra: Partial<Params> = {}): void {
  if (engine === null) return;
  const state = stateOf({ look, kind: c.kind, rows: c.rows, title: c.title, words: c.words, marks: c.marks, waiting: c.waiting, failed: c.failed, ...extra });
  const w = c.w ?? 420;
  const h = c.h ?? 260;
  const box = document.createElement('div');
  box.style.cssText = `position:relative;width:${w}px;height:${h}px;flex:none;background:${state.theme.ground};`;
  box.title = key;
  parent.appendChild(box);
  const handle = engine.mount(box);
  handle.apply(state, { width: w, height: h, dpr: devicePixelRatio });
  handles.set(key, { handle, state, size: { width: w, height: h } });
}

function section(title: string): HTMLElement {
  const h = document.createElement('h3');
  h.textContent = title;
  h.style.cssText = 'margin:18px 0 6px;color:#fff;';
  app.appendChild(h);
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;';
  app.appendChild(row);
  return row;
}

function perfRows(n: number): string[][] {
  const closes = walk(n, 100, 11, day);
  return closes.map((c, i) => [`${new Date(Date.UTC(2000, 0, 1) + i * 3600000).toISOString().slice(0, 16)}`, c.toFixed(2)]);
}

/** Row 9: ten thousand points, pan and zoom by the engine's own entry points and by wheel and drag events; frame time as the page sees it. */
async function perf(look: LookId = 'night'): Promise<{ points: number; medianMs: number; worstMs: number; engineFrame: { median: number; worst: number } }> {
  if (engine === null) throw new Error('no engine');
  const box = document.createElement('div');
  box.style.cssText = 'position:relative;width:900px;height:420px;';
  app.appendChild(box);
  const handle = engine.mount(box);
  const state = stateOf({ look, kind: 'line', rows: perfRows(10000), title: '10,000 points' });
  handle.apply(state, { width: 900, height: 420, dpr: devicePixelRatio });
  await new Promise((r) => setTimeout(r, 400));
  const gaps: number[] = [];
  let last = performance.now();
  let frame = 0;
  await new Promise<void>((done) => {
    const step = (now: number): void => {
      gaps.push(now - last);
      last = now;
      frame += 1;
      const phase = frame / 360;
      void handle.act({ zoom: frame % 120 < 60 ? 1.02 : 1 / 1.02 });
      void handle.act({ pan: Math.sin(phase * 40) * 0.01 });
      void handle.act({ hover: 946684800 + ((frame * 97) % 10000) * 3600 });
      if (frame < 360) requestAnimationFrame(step);
      else done();
    };
    requestAnimationFrame(step);
  });
  const sorted = gaps.slice(5).sort((a, b) => a - b);
  const result = { points: 10000, medianMs: sorted[Math.floor(sorted.length / 2)] ?? 0, worstMs: sorted[sorted.length - 1] ?? 0, engineFrame: handle.probe().frameMs };
  handle.dispose();
  box.remove();
  return result;
}

async function main(): Promise<void> {
  await loadFonts();
  const look = (new URLSearchParams(location.search).get('look') ?? '') as LookId;
  const looks = LOOK_IDS.includes(look) ? [look] : LOOK_IDS;
  for (const l of looks) {
    for (const c of CASES.filter((x) => ['line, years', 'area, months', 'columns, names', 'columns, two series', 'candles + volume', 'ohlc'].includes(x.name))) {
      // grouped below, per look
      void c;
    }
    const row = section(`${l}`);
    for (const c of CASES.filter((x) => x.w === undefined || LOOK_IDS.indexOf(l) === 0)) cell(row, `${l}/${c.name}`, l, c);
  }
  (window as unknown as { __chartBench: unknown }).__chartBench = {
    keys: () => [...handles.keys()],
    probe: (key: string): ChartProbe | null => handles.get(key)?.handle.probe() ?? null,
    act: async (key: string, a: Parameters<ChartHandle['act']>[0]): Promise<ChartProbe | null> => (await handles.get(key)?.handle.act(a)) ?? null,
    still: (key: string): string | null => handles.get(key)?.handle.still(false)?.toDataURL('image/png') ?? null,
    stillHash: (key: string): string => {
      const c = handles.get(key)?.handle.still(false);
      if (c === null || c === undefined) return '';
      const d = c.getContext('2d')?.getImageData(0, 0, c.width, c.height).data;
      let h = 2166136261;
      if (d !== undefined) for (let i = 0; i < d.length; i += 7) h = Math.imul(h ^ (d[i] ?? 0), 16777619);
      return `${c.width}x${c.height}:${h >>> 0}`;
    },
    reveal: (key: string, reveal: number): void => {
      const e = handles.get(key);
      if (e === undefined) return;
      e.state = { ...e.state, reveal, interactive: reveal >= 1 };
      e.handle.apply(e.state, { ...e.size, dpr: devicePixelRatio });
    },
    perf,
  };
  document.title = 'Conduit: chart bench (ready)';
}

void main();
