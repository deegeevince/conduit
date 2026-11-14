// The census of the lesson (PLAN-v3-core 2.8): what is on screen as data, read from the DOM of the surface by the surface, and posted up.
// Words with their size and contrast, every region a hand can work with its size, the question card, the steps drawn against the steps
// shown, the pictures and their share of the view, and the no-spoiler test: any answer of an open ask found in a word on screen.

import { maskSealed } from '@conduit/language';
import type { Player } from './player';
import { isVisualKind } from './types';
import type { CensusTarget, CensusWord, LessonCensus, Rect } from './types';

type Rgba = readonly [number, number, number, number];

function parse(css: string): Rgba | null {
  const m = /^rgba?\(([^)]+)\)$/.exec(css.trim());
  if (m === null) return null;
  const parts = (m[1] ?? '').split(/[,\s/]+/).filter((x) => x !== '').map(Number);
  if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1];
}

function backdrop(el: Element): Rgba {
  let node: Element | null = el;
  while (node !== null) {
    const bg = parse(getComputedStyle(node).backgroundColor);
    if (bg !== null && bg[3] > 0.99) return bg;
    node = node.parentElement;
  }
  return [255, 255, 255, 1];
}

function luminance([r, g, b]: Rgba): number {
  const lin = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
export function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

function rect(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
}

function whereIs(el: Element): string {
  const hit = el.closest('[data-act],[data-ask],[data-step],.ctx,.finish,.topbar,.tabs,.dock,.run');
  if (hit === null) return 'page';
  return hit.getAttribute('data-act') ?? hit.getAttribute('data-ask') ?? (hit.hasAttribute('data-step') ? `step:${hit.getAttribute('data-step')}` : (hit.classList[0] ?? 'page'));
}

const SKIP = '.say-n, .ctx-num, .hint b, .count, script, style';

function textOf(root: HTMLElement, skip: (el: Element) => boolean): { readonly text: string; readonly el: Element }[] {
  const out: { text: string; el: Element }[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
    const el = node.parentElement ?? (node.parentNode instanceof Element ? node.parentNode : null);
    if (text === '' || el === null || skip(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (getComputedStyle(el).visibility === 'hidden') continue;
    out.push({ text, el });
  }
  return out;
}

export function takeCensus(player: Player, root: HTMLElement): LessonCensus {
  const view = player.shownScreen;
  const words: CensusWord[] = [];
  for (const { text, el } of textOf(root, () => false)) {
    const style = getComputedStyle(el);
    const colour = parse(el instanceof SVGElement ? style.fill : style.color) ?? [0, 0, 0, 1];
    const bg = backdrop(el);
    words.push({ text: text.slice(0, 80), px: Math.round(parseFloat(style.fontSize) * 10) / 10, contrast: Math.round(contrast(colour, bg) * 100) / 100, where: whereIs(el) });
  }
  const targets: CensusTarget[] = [];
  const seen = new Set<Element>();
  root.querySelectorAll('button, input, [data-act]').forEach((el) => {
    if (seen.has(el)) return;
    seen.add(el);
    const act = el.getAttribute('data-act');
    if (act === null) return;
    const isButton = el instanceof HTMLButtonElement;
    if (isButton && el.disabled) return;
    if (!isButton && !(el instanceof HTMLInputElement) && !(el instanceof SVGGElement) && act !== 'line') return;
    const r = rect(el);
    if (r.w === 0 || r.h === 0) return;
    const kind: CensusTarget['kind'] = el instanceof HTMLInputElement ? 'field' : el.classList.contains('choice') ? 'choice' : isButton && (el.classList.contains('btn') || el.classList.contains('nav') || el.classList.contains('tab') || el.classList.contains('segb') || el.classList.contains('way') || el.classList.contains('ctx-row') || el.classList.contains('resume')) ? 'button' : 'tap';
    targets.push({ ...r, act, label: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60), kind });
  });
  const card = root.querySelector('.ctx');
  const ctxText = card?.querySelector('.ctx-text');
  const question = card instanceof HTMLElement && ctxText instanceof HTMLElement ? { text: (ctxText.textContent ?? '').slice(0, 200), px: parseFloat(getComputedStyle(ctxText).fontSize), box: rect(card), onScreen: card.getBoundingClientRect().top >= -1 && card.getBoundingClientRect().bottom <= window.innerHeight + 1 } : null;
  const figures = [...root.querySelectorAll('.fig')].flatMap((fig) => {
    const kind = fig.getAttribute('data-kind');
    if (!isVisualKind(kind)) return [];
    const r = rect(fig);
    const counters = [...fig.querySelectorAll('.counter, .blk, .seg, .coin')];
    const least = counters.length === 0 ? null : Math.min(...counters.map((c) => Math.min(c.getBoundingClientRect().width, c.getBoundingClientRect().height)));
    return [{ kind, box: r, share: Math.round((r.w / window.innerWidth) * 100) / 100, least: least === null ? null : Math.round(least) }];
  });
  const { open } = player.sealedNow();
  const leaks: string[] = [];
  const work = root.querySelector('.work');
  if (work instanceof HTMLElement && open.length > 0) {
    for (const { text, el } of textOf(work, (e) => e.closest(`${SKIP}, .choice, .field`) !== null)) if (maskSealed(text, open) !== text) leaks.push(`${text.slice(0, 60)} (${whereIs(el)})`);
  }
  const wide: string[] = [];
  root.querySelectorAll('*').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.right > window.innerWidth + 1 && r.width > 0 && el.closest('.tabs') === null) wide.push(`${el.tagName.toLowerCase()}.${String(el.getAttribute('class') ?? '').split(' ')[0]} ${Math.round(r.left)}..${Math.round(r.right)}`);
  });
  const drawn = root.querySelectorAll('.say[data-step], .ask[data-ask]').length;
  const where = player.current.cursor.node;
  return {
    view,
    node: where,
    viewport: { w: window.innerWidth, h: window.innerHeight, scrollW: document.documentElement.scrollWidth },
    question,
    steps: { shown: player.shownSteps(), drawn },
    figures,
    words: words.slice(0, 400),
    targets,
    sealed: { open: open.flatMap((a) => a.accepted), leaks },
    tryMs: player.lastTryMs,
    wide: wide.slice(0, 12),
    here: player.describe(),
  };
}

/**
 * The census in the three hundred characters the bridge allows an event: the numbers the rules of the plan are held to (the whole census is
 * read in the page of the bench, and goes up whole when the host has a `census` message). `v` view, `q` [card on screen, its type px],
 * `s` [steps shown, drawn], `f` [smallest picture share, smallest piece px], `w` [smallest type px, lowest contrast], `t` [smallest target px,
 * smallest choice px], `l` answers found on screen, `x` pixels past the edge, `m` ms a try took.
 */
export function summarise(c: LessonCensus): string {
  const min = (values: readonly number[]): number => (values.length === 0 ? 0 : Math.min(...values));
  const targets = c.targets.filter((t) => t.kind !== 'field');
  const summary = {
    v: c.view,
    q: [c.question?.onScreen === true ? 1 : 0, c.question?.px ?? 0],
    s: [c.steps.shown, c.steps.drawn],
    f: [min(c.figures.map((f) => f.share)), min(c.figures.flatMap((f) => (f.least === null ? [] : [f.least])))],
    w: [min(c.words.map((w) => w.px)), min(c.words.map((w) => w.contrast))],
    t: [Math.round(min(targets.map((t) => Math.min(t.w, t.h)))), Math.round(min(c.targets.filter((t) => t.kind === 'choice').map((t) => t.h)))],
    l: c.sealed.leaks.length,
    x: Math.max(0, c.viewport.scrollW - c.viewport.w),
    m: c.tryMs ?? 0,
  };
  return JSON.stringify(summary).slice(0, 290);
}
