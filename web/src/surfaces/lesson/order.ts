// Putting things in order: tiles she drags (or taps, one then another, to swap) into the order she thinks is right, then Check. The tiles are the
// question's own items (an ordering ask's `is=` lists them in the right order, so the page shuffles them: never already in order). What the page
// keeps of her hand is the arrangement, as a held value, so going back and coming again, or a reload, finds the tiles as she left them. The lesson
// compares the sequence exactly (`accepts` with `check=order`); nothing here knows the answer is anything but a list.

import { h } from './dom';

export interface OrderOptions {
  /** the items in the right order (never shown in this order: see `scramble`) */
  readonly items: readonly string[];
  /** the arrangement she left, if any */
  readonly arranged: readonly string[] | null;
  readonly unit: string | null;
  /** the ask's id, to make the scramble the same every time */
  readonly seed: string;
  /** she moved a tile: the arrangement now */
  readonly onMove: (arranged: readonly string[]) => void;
  readonly onCheck: (arranged: readonly string[], stamp: number) => void;
  readonly reading?: boolean;
}

function hash(text: string): number {
  let n = 2166136261;
  for (const ch of text) n = Math.imul(n ^ ch.charCodeAt(0), 16777619);
  return n >>> 0;
}

/** The same shuffle for the same items, and never the right order (nor its reverse, which a child would call a first guess for free). */
export function scramble(items: readonly string[], seed: string): string[] {
  const out = [...items];
  let state = hash(`${seed}|${items.join(',')}`) || 1;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j] as string, out[i] as string];
  }
  const same = (a: readonly string[], b: readonly string[]): boolean => a.every((x, i) => x === b[i]);
  const reversed = [...items].reverse();
  if (items.length > 2 && (same(out, items) || same(out, reversed))) out.push(out.shift() as string, out.shift() as string);
  if (same(out, items) && items.length > 1) out.reverse();
  return out;
}

export function orderWriting(options: OrderOptions): HTMLElement {
  const start = options.arranged !== null && options.arranged.length === options.items.length && [...options.arranged].sort().join('\u0000') === [...options.items].sort().join('\u0000') ? [...options.arranged] : scramble(options.items, options.seed);
  const row = h('div', { class: 'tiles', role: 'list', 'aria-label': 'Put them in order: drag a tile, or tap two to swap them' });
  const tiles: HTMLElement[] = start.map((item) => h('button', { type: 'button', class: 'tile', role: 'listitem', 'data-tile': item }, item, options.unit === null ? null : h('span', { class: 'unit' }, ` ${options.unit}`)));
  row.append(...tiles);
  const current = (): string[] => [...row.children].map((el) => (el as HTMLElement).dataset['tile'] ?? '');
  let picked: HTMLElement | null = null;
  const settle = (): void => options.onMove(current());

  let drag: { readonly el: HTMLElement; readonly id: number; readonly x: number; readonly y: number; moved: boolean } | null = null;
  row.addEventListener('pointerdown', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.tile');
    if (el === null || options.reading === true) return;
    drag = { el, id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
    el.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  row.addEventListener('pointermove', (e) => {
    if (drag === null || e.pointerId !== drag.id) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 8) return;
    if (!drag.moved) {
      drag.moved = true;
      drag.el.classList.add('lifted');
      picked?.classList.remove('picked');
      picked = null;
    }
    // the tile under the hand (the dragged one is skipped): the dragged tile takes its place, before it when moving left or up, after it otherwise
    const over = [...row.children].find((el) => {
      if (el === drag?.el) return false;
      const r = el.getBoundingClientRect();
      return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    }) as HTMLElement | undefined;
    if (over === undefined) return;
    const before = [...row.children].indexOf(drag.el) > [...row.children].indexOf(over);
    row.insertBefore(drag.el, before ? over : over.nextSibling);
  });
  const release = (e: PointerEvent): void => {
    if (drag === null || e.pointerId !== drag.id) return;
    const { el, moved } = drag;
    drag = null;
    el.classList.remove('lifted');
    if (moved) return settle();
    // a tap: pick this tile, or swap it with the one picked
    if (picked === null) {
      picked = el;
      el.classList.add('picked');
      return;
    }
    if (picked !== el) {
      const a = picked;
      const marker = h('span');
      row.insertBefore(marker, a);
      row.insertBefore(a, el);
      row.insertBefore(el, marker);
      marker.remove();
      settle();
    }
    picked.classList.remove('picked');
    picked = null;
  };
  row.addEventListener('pointerup', release);
  row.addEventListener('pointercancel', release);
  const check = options.reading === true ? h('button', { type: 'button', class: 'btn main check', 'data-act': 'check', disabled: true }, 'Checking…') : h('button', { type: 'button', class: 'btn main check', 'data-act': 'check', onclick: (e: Event) => options.onCheck(current(), e.timeStamp) }, 'Check');
  return h('div', { class: 'writing order' }, row, h('div', { class: 'answer-row' }, check));
}
