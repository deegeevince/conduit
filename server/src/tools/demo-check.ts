// What `pnpm check` asks of every scene of a demo beyond the painter's own account of it, named by the backlog row it guards (docs/feedback.md). In the page, at a scene's
// rest frame; the schedule-only checks of the same rows are `pnpm timeline` (language/scripts/reading-checks.ts) and `pnpm demo-checks` (web/src/painter/demo-checks.ts).
//
//   fb-004, 006, 031  chrome over the stage: in a tour demo the tour's bar is up (from the start of the demo, not only at its end) and no word, control, drawing or block of the stage,
//                     and none of the other chrome that stands over it (the Undo chip, the page chip, the "earlier" chip, the status pill), meets a button of the bar
//   fb-006            the status pill (the "earlier scenes are in the Transcript" line) stands over the middle of the stage's column, not the page's, and is one line
//   fb-023            declared and on screen: every element the scene's lines wrote is on the stage at its rest frame, seen (opacity), with a box
//   fb-030            a line let go: no visible "earlier" chip at a demo's rest frame (the layout let go of a line the scene wrote)
//   fb-005            the crosshair's words: the tag a chart's crosshair puts on its bottom axis is one of the chart's written labels, or a year inside its data, at three hover points
//   fb-037            a label off its part: `near=<id>:<side>` stands on that side of its part, and close
//
// Everything here reads the page through `window.__stage` and the DOM; nothing changes it.

import type { Declared } from '@conduit/language';
import { spawnTracked } from '../brains/claude-cli/process';
import { repoRoot } from './explore-browser';
import type { Tab } from './smoke';
import type { CheckResult } from './smoke';

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface Seen {
  readonly id: string;
  readonly kind: string;
  readonly text: string;
  readonly opacity: number;
  readonly phase: string;
  readonly layer: string;
  readonly box: Box;
}

const norm = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();
const meets = (a: Box, b: Box, slack = 0): boolean => a.x + a.width > b.x + slack && b.x + b.width > a.x + slack && a.y + a.height > b.y + slack && b.y + b.height > a.y + slack;

async function stage(tab: Tab): Promise<Seen[]> {
  return tab.eval<Seen[]>('window.__stage.elements().map((e) => ({ id: e.id, kind: e.kind, text: String(e.text || ""), opacity: e.opacity, phase: e.phase, layer: e.layer, box: e.box }))');
}

/** The rectangles (page pixels) of what is visible in the page that matches a selector. */
async function rects(tab: Tab, selector: string, outsideBar = false): Promise<Box[]> {
  return tab.eval<Box[]>(`[...document.querySelectorAll(${JSON.stringify(selector)})].filter((n) => ${outsideBar ? "!n.closest('[data-tour-bar]') && " : ''}!n.hidden && n.offsetParent !== null && getComputedStyle(n).visibility !== 'hidden' && getComputedStyle(n).opacity !== '0').map((n) => { const r = n.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; }).filter((r) => r.width > 0 && r.height > 0)`);
}

/** The stage's own host in page pixels: the elements' boxes are relative to it. */
async function hostBox(tab: Tab): Promise<Box> {
  return tab.eval<Box>(`(() => { const h = document.getElementById('stage'); const r = h ? h.getBoundingClientRect() : { left: 0, top: 0, width: innerWidth, height: innerHeight }; return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`);
}

/**
 * fb-004, 006, 031. In a tour demo the bar stands over the foot of the stage; nothing the stage shows may be under it, nor may the other chrome that stands over the stage.
 * `expected`: the page is a tour demo, so the bar must be up (a check that passes when the bar is not there has not looked at it).
 * Returns the problems, empty when all is well.
 */
export async function checkTourBar(tab: Tab, expected: boolean): Promise<string[]> {
  const buttons = await rects(tab, '[data-tour-bar] button');
  if (buttons.length === 0) return expected ? ['the tour bar is not on stage: a tour demo shows it from its start'] : [];
  const host = await hostBox(tab);
  const problems: string[] = [];
  const elements = (await stage(tab)).filter((element) => element.opacity > 0.05 && element.phase !== 'leaving');
  for (const element of elements) {
    const box = { x: element.box.x + host.x, y: element.box.y + host.y, width: element.box.width, height: element.box.height };
    if (box.width <= 0 || box.height <= 0) continue;
    // a full-bleed backdrop (a sky, a ground) is under the bar by design
    if (box.width >= host.width * 0.85 && box.height >= host.height * 0.5) continue;
    // a block's box is padded past its ink (a column of sums keeps room under its last row): it gets a few pixels more than words and controls
    const slack = element.kind === 'structure' ? 10 : 1;
    for (const button of buttons) {
      if (meets(box, button, slack)) {
        problems.push(`${element.kind} "${element.text.slice(0, 40) || element.id}" (${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)}) is under the tour bar's button at ${Math.round(button.x)},${Math.round(button.y)}`);
        break;
      }
    }
  }
  for (const selector of ['[data-undo-chip]', '[data-page-chip]', '[data-earlier]', '.prompt__top']) {
    // an Undo chip that stands in the bar's row is a part of the bar (fb-031), not over it
    for (const chrome of await rects(tab, selector, true)) {
      if (buttons.some((button) => meets(chrome, button, 1))) problems.push(`${selector} (${Math.round(chrome.x)},${Math.round(chrome.y)} ${Math.round(chrome.width)}x${Math.round(chrome.height)}) meets the tour bar`);
    }
  }
  // the bar's own buttons must not meet each other (the Undo chip stands in its row)
  for (let a = 0; a < buttons.length; a += 1) for (let b = a + 1; b < buttons.length; b += 1) if (meets(buttons[a] as Box, buttons[b] as Box, 1)) problems.push('two of the tour bar\'s buttons meet');
  return problems.slice(0, 4);
}

/** fb-023. Every element the scene wrote that should be there at its rest is on the stage, seen, with a box. */
export async function checkDeclared(tab: Tab, declared: readonly Declared[]): Promise<string[]> {
  const live = await stage(tab);
  const problems: string[] = [];
  // a block, shape or control the language gave its own id (`x12`) is found by its kind: as many of the kind must be seen as the scene wrote
  const unnamed = new Map<string, number>();
  for (const want of declared) if (want.id === null && want.kind !== 'text') unnamed.set(want.kind, (unnamed.get(want.kind) ?? 0) + 1);
  for (const [kind, count] of unnamed) {
    const least = Math.min(...declared.filter((want) => want.id === null && want.kind === kind).map((want) => want.opacity));
    const seen = live.filter((element) => element.kind === kind && element.opacity >= least && (element.box.width > 0 || element.box.height > 0)).length;
    if (seen < count) problems.push(`${count} ${kind}${count === 1 ? '' : 's'} written, ${seen} seen on the stage`);
  }
  for (const want of declared) {
    if (want.id === null && want.kind !== 'text') continue;
    const found = live.filter((element) => (want.id !== null ? element.id === want.id : element.kind === want.kind && norm(element.text) === norm(want.text)));
    // a line has no height: a box is empty only when it has neither width nor height
    const seen = found.find((element) => element.opacity >= want.opacity && (element.box.width > 0 || element.box.height > 0));
    if (seen === undefined) {
      const label = want.id ?? `"${want.text.slice(0, 40)}"`;
      const best = found[0];
      problems.push(best === undefined ? `${want.kind} ${label} is not on the stage` : `${want.kind} ${label} is on the stage but not seen (opacity ${best.opacity.toFixed(2)}, box ${Math.round(best.box.width)}x${Math.round(best.box.height)}, ${best.phase})`);
    }
  }
  return problems.slice(0, 4);
}

/** fb-030. The layout let go of a line of the scene: the "earlier" chip stands in its place. */
export async function checkNoEarlierChip(tab: Tab): Promise<string[]> {
  const chips = await rects(tab, '[data-earlier]');
  return chips.length === 0 ? [] : ['a line of this scene was let go: the "earlier" chip is on screen'];
}

/** What a label asks of the page: where its words stand against its part (fb-037). */
export interface LabelWant {
  readonly text: string;
  readonly target: string;
  readonly side: 'above' | 'below' | 'left' | 'right';
}

/** fb-037. A label written `near=<id>:<side>` stands on that side of its part, and no further from it than twice its own height. */
export async function checkLabels(tab: Tab, labels: readonly LabelWant[]): Promise<string[]> {
  if (labels.length === 0) return [];
  const live = await stage(tab);
  const problems: string[] = [];
  for (const want of labels) {
    const label = live.find((element) => element.kind === 'text' && norm(element.text) === norm(want.text) && element.opacity > 0.3);
    const target = live.find((element) => element.id === want.target && element.kind !== 'text');
    if (label === undefined || target === undefined) continue;
    const slack = 4;
    const l = label.box;
    const t = target.box;
    const ok =
      want.side === 'below' ? l.y >= t.y + t.height - slack : want.side === 'above' ? l.y + l.height <= t.y + slack : want.side === 'right' ? l.x >= t.x + t.width - slack : l.x + l.width <= t.x + slack;
    const gap = want.side === 'below' ? l.y - (t.y + t.height) : want.side === 'above' ? t.y - (l.y + l.height) : want.side === 'right' ? l.x - (t.x + t.width) : t.x - (l.x + l.width);
    if (!ok) problems.push(`label "${want.text.slice(0, 30)}" was written ${want.side} ${want.target} and stands elsewhere (label ${Math.round(l.x)},${Math.round(l.y)}; part ${Math.round(t.x)},${Math.round(t.y)} ${Math.round(t.width)}x${Math.round(t.height)})`);
    else if (gap > Math.max(2 * l.height, 24)) problems.push(`label "${want.text.slice(0, 30)}" is ${Math.round(gap)} px from ${want.target}, more than twice its own height`);
  }
  return problems.slice(0, 4);
}

/**
 * One of the repository's schedule-only checks run to its end (`pnpm timeline demos`, `pnpm demo-checks`): no browser. Its failing lines are the report; they name the backlog row.
 * `fixed`: what a pass says.
 */
export async function scriptGroup(check: string, args: readonly string[], fixed: string): Promise<CheckResult[]> {
  const child = spawnTracked('pnpm', ['-s', ...args], undefined, { cwd: repoRoot(), env: {} });
  let out = '';
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', (chunk: Buffer) => (out = (out + chunk.toString()).slice(-30_000)));
  const code = await new Promise<number | null>((done) => {
    child.once('close', (status) => done(status));
    child.once('error', () => done(-1));
  });
  const failed = out.split('\n').filter((line) => /FAILED/.test(line));
  const summary = out.split('\n').filter((line) => /^(reading rule|demo rules|demo checks|feedback checks)/.test(line));
  return [{ turn: 0, check, verdict: code === 0 ? 'PASS' : 'FAIL', detail: code === 0 ? `${fixed} (${summary.join('; ')})` : failed.length > 0 ? failed.slice(0, 6).map((line) => line.trim()).join(' | ') : `exit ${String(code)}: ${out.slice(-300)}` }];
}

/**
 * fb-005. Hover each chart on stage at a quarter, a half and three quarters of its way along: the tag the crosshair puts on the bottom axis (it once read "1970" over "2005")
 * is one of the written x labels, the label of the point the crosshair is on, or a year inside the data's range.
 */
export async function checkAxisTags(tab: Tab): Promise<string[]> {
  const charts = await tab.eval<{ id: string }[]>('window.__stage.charts().filter((c) => !c.waiting).map((c) => ({ id: c.id }))');
  const problems: string[] = [];
  type Probe = { from: number; to: number; crosshair: { label: string; axis: string | null } | null; ticks: { x: string[] } };
  for (const { id } of charts) {
    const base = await tab.eval<Probe>(`window.__stage.chart(${JSON.stringify(id)}, { reset: true })`);
    for (const along of [0.25, 0.5, 0.75]) {
      const probe = await tab.eval<Probe>(`window.__stage.chart(${JSON.stringify(id)}, { hover: ${base.from + along * (base.to - base.from)} })`);
      const crosshair = probe.crosshair;
      if (crosshair === null) {
        problems.push(`chart ${id}: hovering ${along * 100}% of the way along put no crosshair on it`);
        continue;
      }
      if (crosshair.axis === null) {
        problems.push(`chart ${id}: the crosshair's tag on the bottom axis was not read at ${along * 100}%`);
        continue;
      }
      const words = [...probe.ticks.x, ...base.ticks.x, crosshair.label];
      const years = words.flatMap((word) => word.match(/\b(?:1[89]\d\d|20\d\d)\b/g) ?? []).map(Number);
      const tagYear = /^\d{4}$/.test(crosshair.axis.trim()) ? Number(crosshair.axis) : null;
      const fine = words.some((word) => norm(word) === norm(crosshair.axis ?? '')) || (tagYear !== null && years.length > 0 && tagYear >= Math.min(...years) && tagYear <= Math.max(...years));
      if (!fine) problems.push(`chart ${id}: at ${along * 100}% the crosshair's tag on the bottom axis reads "${crosshair.axis}", not one of the written labels (${[...new Set(words)].slice(0, 8).join(', ')})`);
    }
  }
  return problems.slice(0, 4);
}

/** fb-006. The line over the stage's lower edge (the status pill) is centred on the stage's column, and is one line. Nothing to check while it is not shown. */
export async function checkPill(tab: Tab): Promise<string[]> {
  const stage = await hostBox(tab);
  const problems: string[] = [];
  for (const pill of await rects(tab, '.prompt__top')) {
    const centre = pill.x + pill.width / 2;
    const middle = stage.x + stage.width / 2;
    if (Math.abs(centre - middle) > 12) problems.push(`the status pill is centred at ${Math.round(centre)}, the stage's middle is ${Math.round(middle)}: it stands over the page's middle, not the stage's`);
    if (pill.x < stage.x - 1 || pill.x + pill.width > stage.x + stage.width + 1) problems.push(`the status pill (${Math.round(pill.x)}..${Math.round(pill.x + pill.width)}) runs outside the stage's column (${Math.round(stage.x)}..${Math.round(stage.x + stage.width)})`);
    if (pill.height > 44) problems.push(`the status pill is ${Math.round(pill.height)} px tall: more than one line, so it outgrows the room the stage keeps for it`);
  }
  return problems.slice(0, 3);
}

/**
 * fb-071. The columns of a chart as a person sees them, in pixels: a picture of the page, the chart's box cut out, and in it the runs of the bars' colour, left to right, each as its
 * height in CSS pixels (the middle of the bar, where a label or an edge does not reach). `colour` is the bars' own: with none given, it is the commonest saturated colour in the box
 * (read it when the bars are tall), and it is handed back to be given at the next reading, when a bar may be too low to be the commonest thing there. A string says why nothing could be read.
 */
export async function chartBars(tab: Tab, id: string, colour: readonly number[] | null): Promise<{ readonly heights: readonly number[]; readonly colour: readonly number[]; readonly box: Box } | string> {
  const chart = await tab.eval<{ box: Box } | null>(`(() => { const c = window.__stage.charts().find((n) => n.id === ${JSON.stringify(id)}); return c ? { box: c.box } : null; })()`);
  if (chart === null) return `no chart ${id} on stage`;
  const host = await hostBox(tab);
  const picture = await tab.shot();
  const read = await tab.eval<{ heights: number[]; colour: number[] } | string>(`(async () => {
    const img = new Image();
    img.src = ${JSON.stringify(picture)};
    await img.decode();
    const k = img.width / innerWidth;
    const region = { x: Math.max(0, Math.round((${host.x} + ${chart.box.x}) * k)), y: Math.max(0, Math.round((${host.y} + ${chart.box.y}) * k)) };
    region.w = Math.min(img.width - region.x, Math.round(${chart.box.width} * k));
    region.h = Math.min(img.height - region.y, Math.round(${chart.box.height} * k));
    const c = document.createElement('canvas');
    c.width = region.w;
    c.height = region.h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, region.x, region.y, region.w, region.h, 0, 0, region.w, region.h);
    const d = g.getImageData(0, 0, region.w, region.h).data;
    const w = region.w;
    const h = region.h;
    let best = ${colour === null ? 'null' : JSON.stringify([...colour])};
    if (best === null) {
      const tally = new Map();
      for (let i = 0; i < d.length; i += 4) {
        if (Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]) < 40) continue;
        const key = (d[i] >> 4) + ',' + (d[i + 1] >> 4) + ',' + (d[i + 2] >> 4);
        tally.set(key, (tally.get(key) || 0) + 1);
      }
      let most = 0;
      for (const [key, n] of tally) if (n > most) { most = n; best = key.split(',').map(Number); }
      if (best === null) return 'no pixel of any colour in the chart';
    }
    const near = (i) => Math.abs((d[i] >> 4) - best[0]) <= 1 && Math.abs((d[i + 1] >> 4) - best[1]) <= 1 && Math.abs((d[i + 2] >> 4) - best[2]) <= 1;
    const column = new Array(w).fill(0);
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) if (near((y * w + x) * 4)) column[x] += 1;
    const heights = [];
    let x = 0;
    while (x < w) {
      if (column[x] === 0) { x += 1; continue; }
      let end = x;
      while (end < w && column[end] > 0) end += 1;
      if (end - x >= 6 * k) {
        const quarter = Math.floor((end - x) / 4);
        const middle = column.slice(x + quarter, end - quarter).sort((a, b) => a - b);
        heights.push(Math.round((middle[middle.length >> 1] / k) * 10) / 10);
      }
      x = end;
    }
    return { heights, colour: best };
  })()`);
  return typeof read === 'string' ? read : { heights: read.heights, colour: read.colour, box: chart.box };
}
