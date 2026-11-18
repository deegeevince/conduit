// The shell invariant: every text in the shell reads 4.5:1 on its own background, from computed styles; no shell box
// over a leaf (the second half waits for the shell's own box in `View`). Report-only. This is the one rule that reads the DOM, because the
// chrome is DOM: it is checked where the person stands, from what the browser computed, not from what the stylesheet says.

import type { CensusMoment, Violation } from '../../../language/src/loop';

type Rgba = readonly [number, number, number, number];

/** Any CSS colour the browser can compute, as 8-bit RGBA: a one-pixel canvas is the converter, so `rgb()`, `color()`, `oklch()` all read. */
function rgbaOf(css: string): Rgba | null {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (context === null) return null;
  context.clearRect(0, 0, 1, 1);
  context.fillStyle = '#010203';
  context.fillStyle = css;
  context.fillRect(0, 0, 1, 1);
  const data = context.getImageData(0, 0, 1, 1).data;
  return [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0, (data[3] ?? 0) / 255];
}

function luminance(colour: Rgba): number {
  const channel = (value: number): number => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(colour[0]) + 0.7152 * channel(colour[1]) + 0.0722 * channel(colour[2]);
}

export function contrastOf(a: Rgba, b: Rgba): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const over = (top: Rgba, under: Rgba): Rgba => {
  const alpha = top[3] + under[3] * (1 - top[3]);
  if (alpha === 0) return [0, 0, 0, 0];
  const mix = (a: number, b: number): number => (a * top[3] + b * under[3] * (1 - top[3])) / alpha;
  return [mix(top[0], under[0]), mix(top[1], under[1]), mix(top[2], under[2]), alpha];
};

/** What is behind an element: its own background and its ancestors', laid over the page's. */
function backgroundBehind(element: Element, page: Rgba): Rgba {
  const layers: Rgba[] = [];
  for (let at: Element | null = element; at !== null; at = at.parentElement) {
    const colour = rgbaOf(getComputedStyle(at).backgroundColor);
    if (colour !== null && colour[3] > 0) layers.push(colour);
    if (colour !== null && colour[3] >= 1) break;
  }
  return layers.reduceRight<Rgba>((under, top) => over(top, under), page);
}

/** The words an element shows on its own: its text nodes, and for a field its placeholder and its value. */
function ownWords(element: Element): { readonly text: string; readonly placeholder: boolean }[] {
  const found: { text: string; placeholder: boolean }[] = [];
  for (const node of element.childNodes) {
    const text = node.nodeType === Node.TEXT_NODE ? (node.textContent ?? '').trim() : '';
    if (text !== '') found.push({ text, placeholder: false });
  }
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    if (element.value.trim() !== '') found.push({ text: element.value.trim(), placeholder: false });
    if (element.value.trim() === '' && element.placeholder !== '') found.push({ text: element.placeholder, placeholder: true });
  }
  return found;
}

/**
 * Every text the shell shows under `root`, at 4.5:1 on what is behind it. `page` is the colour behind the shell itself (the document's).
 * Hidden elements (display none, visually-hidden clips, zero size) are not read.
 */
export function checkShell(root: Element, at: CensusMoment, look: string): Violation[] {
  const found: Violation[] = [];
  const page = rgbaOf(getComputedStyle(document.documentElement).backgroundColor) ?? [255, 255, 255, 1];
  const solidPage: Rgba = page[3] >= 1 ? page : over(page, [255, 255, 255, 1]);
  const seen = new Set<string>();
  for (const element of [root, ...root.querySelectorAll('*')]) {
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    for (const words of ownWords(element)) {
      const colour = rgbaOf(words.placeholder ? getComputedStyle(element, '::placeholder').color : style.color);
      if (colour === null) continue;
      const behind = backgroundBehind(element, solidPage);
      const ratio = contrastOf(over(colour, behind), behind);
      if (ratio >= 4.5) continue;
      const id = `${element.className}|${words.text}`;
      if (seen.has(id)) continue;
      seen.add(id);
      found.push({
        rule: 'shell',
        severity: 'fault',
        at,
        keys: [typeof element.className === 'string' && element.className !== '' ? element.className.split(' ')[0] ?? element.tagName : element.tagName],
        detail: `in the ${look} look the shell's "${words.text.slice(0, 30)}"${words.placeholder ? ' (placeholder)' : ''} reads at ${ratio.toFixed(2)}:1 (needs 4.5)`,
        box: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      });
    }
  }
  return found;
}
