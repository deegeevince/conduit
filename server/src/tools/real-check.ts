// What is really on screen, judged from pixels: the checks `pnpm check` adds to the painter's own account of the stage.
//
//   footprints   for each line of words (and each node of a diagram) on a scene at rest: hide it through the painter's `hide` hook, take a picture, and the pixels
//                that changed are its real footprint. Fails when a footprint is empty (covered or invisible), lies well outside its model box, meets another's, or
//                holds other ink (a stroke, another word) in the same place
//   takeover     `document.elementsFromPoint` at the stage's centre and corners: what is there must be in the stage, not an overlay that took the screen
//   glyphs       the character cells of a CJK line, compared with each other: all alike means "?" or missing-glyph boxes
//   listings     each `code` block of a scene at rest: on stage in a box of a real size inside the screen, and every row of it read back from the text layer as written
//                (indentation and all) and really drawn (its words hidden in turn through `hide`: the pixels that change are the row)
//   slides       the words a scene says and the tables it makes, found on stage (what a deck's slides and a code demo's captions are judged by)
//   streaming    a turn replayed at about 80 characters a second has its first element on stage before the last line is sent; a recorded stream-json turn
//                fed through the brain's own reader comes out line by line, not in one burst
//   flows, photo the two free checks that were never part of `pnpm check` (`pnpm flows`, `pnpm photo-check`), run as groups
//
// Nothing here is part of the server.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { spawnTracked } from '../brains/claude-cli/process';
import { LineReader } from '@conduit/language';
import { brainEventsFromText } from '../domain/lines';
import { parseStreamLine, textDeltaOf } from '../brains/claude-cli/stream-json';
import { repoRoot, sleep } from './explore-browser';
import { claimPort, releasePort } from './check-ports';
import type { Tab } from './smoke';
import type { CheckResult, Verdict } from './smoke';

type Add = (check: string, verdict: Verdict, detail: string) => void;

const area = (b: { width: number; height: number }): number => Math.max(0, b.width) * Math.max(0, b.height);
const VERBOSE = process.env['CHECK_PIX_VERBOSE'] !== undefined;

// ---------------------------------------------------------------------------------------------------------------------------------
// In the page

/** `window.__pix`: pictures held by name, the footprint of one element between two of them, and what the footprints say together */
export const PIX_LIB = String.raw`(() => {
  if (window.__pix) return;
  const store = new Map();
  const feet = new Map();
  const decode = async (url) => {
    const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error('picture did not load')); i.src = url; });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    return { d: g.getImageData(0, 0, img.width, img.height).data, w: img.width, h: img.height };
  };
  const gap = (a, b, i) => Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  const modalOf = (d, w, x0, y0, x1, y1) => {
    const votes = new Map();
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = (y * w + x) * 4;
      const k = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
      votes.set(k, (votes.get(k) || 0) + 1);
    }
    let best = 0, key = 0;
    for (const [k, n] of votes) if (n > best) { best = n; key = k; }
    return [((key >> 8) & 15) * 16 + 8, ((key >> 4) & 15) * 16 + 8, (key & 15) * 16 + 8];
  };
  window.__pix = {
    async put(name, url) { const p = await decode(url); store.set(name, p); return [p.w, p.h]; },
    clear() { store.clear(); feet.clear(); },
    // the footprint of one element: where picture "a" (with it) differs from picture "h" (without it), leaving out what moves by itself (a against b).
    // box and margin are CSS pixels. Other ink: under and just round the element's own pixels (2 px), the pixels of "h" unlike that place's own ground:
    // a stroke or other words running through it. spot: a point (CSS pixels) whose distance from the footprint is wanted (the end of a leader).
    foot(id, box, scale, margin, spot) {
      const a = store.get('a'), b = store.get('b'), h = store.get('h');
      // only the stage is looked at: the page's own chrome (a caret that blinks, a status that changes) is not what an element paints
      const host = document.getElementById('stage');
      const room = host ? host.getBoundingClientRect() : { left: 0, top: 0, right: a.w / scale, bottom: a.h / scale };
      const x0 = Math.max(0, Math.floor(Math.max(room.left, box.x - margin) * scale)), y0 = Math.max(0, Math.floor(Math.max(room.top, box.y - margin) * scale));
      const x1 = Math.min(a.w - 1, Math.ceil(Math.min(room.right, box.x + box.w + margin) * scale)), y1 = Math.min(a.h - 1, Math.ceil(Math.min(room.bottom, box.y + box.h + margin) * scale));
      if (x1 < x0 || y1 < y0) { feet.set(id, null); return { count: 0 }; }
      const rw = x1 - x0 + 1, rh = y1 - y0 + 1;
      const mask = new Uint8Array(rw * rh);
      let count = 0, minx = 1e9, miny = 1e9, maxx = -1, maxy = -1;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const i = (y * a.w + x) * 4;
        if (gap(a.d, h.d, i) > 40 && gap(a.d, b.d, i) <= 24) {
          mask[(y - y0) * rw + (x - x0)] = 1; count++;
          if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
        }
      }
      const out = { count };
      if (count === 0) { feet.set(id, null); return out; }
      feet.set(id, { x0, y0, rw, rh, mask, minx, miny, maxx, maxy });
      out.x = minx / scale; out.y = miny / scale; out.w = (maxx - minx + 1) / scale; out.h = (maxy - miny + 1) / scale;
      if (spot) {
        let best = 1e9;
        const sx = spot.x * scale, sy = spot.y * scale;
        for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) if (mask[y * rw + x]) { const d = Math.hypot(x0 + x - sx, y0 + y - sy); if (d < best) best = d; }
        out.spotGap = best / scale;
      }
      // the place of its own pixels, 2 px round: dilated along x then along y
      const r = Math.max(1, Math.round(2 * Math.min(scale, 2)));
      const wide = new Uint8Array(rw * rh), near = new Uint8Array(rw * rh);
      for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) if (mask[y * rw + x]) for (let k = Math.max(0, x - r); k <= Math.min(rw - 1, x + r); k++) wide[y * rw + k] = 1;
      for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) if (wide[y * rw + x]) for (let k = Math.max(0, y - r); k <= Math.min(rh - 1, y + r); k++) near[k * rw + x] = 1;
      const votes = new Map();
      let area = 0;
      for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) if (near[y * rw + x]) {
        const i = ((y0 + y) * h.w + x0 + x) * 4;
        const key = ((h.d[i] >> 4) << 8) | ((h.d[i + 1] >> 4) << 4) | (h.d[i + 2] >> 4);
        votes.set(key, (votes.get(key) || 0) + 1); area++;
      }
      let top = 0, tk = 0;
      for (const [k, n] of votes) if (n > top) { top = n; tk = k; }
      const g = [((tk >> 8) & 15) * 16 + 8, ((tk >> 4) & 15) * 16 + 8, (tk & 15) * 16 + 8];
      out.ink = 0; out.inkArea = area;
      for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) if (near[y * rw + x]) {
        const i = ((y0 + y) * h.w + x0 + x) * 4;
        if (Math.abs(h.d[i] - g[0]) + Math.abs(h.d[i + 1] - g[1]) + Math.abs(h.d[i + 2] - g[2]) > 90 && gap(a.d, b.d, i) <= 24) out.ink++;
      }
      return out;
    },
    // which footprints meet: their boxes share at least 3 CSS pixels each way, and both have ink in the shared part
    meets(ids, scale) {
      const out = [];
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
        const p = feet.get(ids[i]), q = feet.get(ids[j]);
        if (!p || !q) continue;
        const x0 = Math.max(p.minx, q.minx), x1 = Math.min(p.maxx, q.maxx), y0 = Math.max(p.miny, q.miny), y1 = Math.min(p.maxy, q.maxy);
        if ((x1 - x0 + 1) / scale < 3 || (y1 - y0 + 1) / scale < 3) continue;
        const inside = (f) => { let n = 0; for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (f.mask[(y - f.y0) * f.rw + (x - f.x0)]) n++; return n; };
        const np = inside(p), nq = inside(q);
        if (np >= 4 && nq >= 4) out.push({ a: ids[i], b: ids[j], w: (x1 - x0 + 1) / scale, h: (y1 - y0 + 1) / scale, na: np, nb: nq });
      }
      return out;
    },
    // the character cells of a line: its ink (in "a", inside the CSS box), cut into words where there is a gap and each word into equal cells, one per character;
    // each cell as a 10x10 grid of how much of it is ink. words: the characters in each word.
    cells(box, words, scale) {
      const a = store.get('a');
      const x0 = Math.max(0, Math.floor(box.x * scale)), y0 = Math.max(0, Math.floor(box.y * scale));
      const x1 = Math.min(a.w - 1, Math.ceil((box.x + box.w) * scale)), y1 = Math.min(a.h - 1, Math.ceil((box.y + box.h) * scale));
      const g = modalOf(a.d, a.w, x0, y0, x1, y1);
      const ink = (x, y) => { const i = (y * a.w + x) * 4; return Math.max(Math.abs(a.d[i] - g[0]), Math.abs(a.d[i + 1] - g[1]), Math.abs(a.d[i + 2] - g[2])) > 56; };
      const cols = [];
      for (let x = x0; x <= x1; x++) { let hit = false; for (let y = y0; y <= y1 && !hit; y++) if (ink(x, y)) hit = true; cols.push(hit); }
      const height = (y1 - y0 + 1);
      const runs = [];
      let start = -1, blank = 0;
      for (let k = 0; k < cols.length; k++) {
        if (cols[k]) { if (start < 0) start = k; blank = 0; }
        else if (start >= 0) { blank++; if (blank >= Math.max(3, 0.2 * height)) { runs.push([start, k - blank]); start = -1; blank = 0; } }
      }
      if (start >= 0) runs.push([start, cols.length - 1 - blank]);
      const parts = runs.length === words.length ? runs.map((r, i) => [r, words[i]]) : (runs.length > 0 ? [[[runs[0][0], runs[runs.length - 1][1]], words.reduce((s, n) => s + n, 0)]] : []);
      const cells = [];
      for (const [r, n] of parts) {
        const cw = (r[1] - r[0] + 1) / n;
        for (let c = 0; c < n; c++) {
          const cx0 = Math.floor(x0 + r[0] + c * cw), cx1 = Math.max(cx0 + 1, Math.floor(x0 + r[0] + (c + 1) * cw));
          // each character is looked at in its own ink box, so a half pixel of side bearing is not a difference
          let bx0 = 1e9, bx1 = -1, by0 = 1e9, by1 = -1;
          for (let y = y0; y <= y1; y++) for (let x = cx0; x < cx1 && x <= x1; x++) if (ink(x, y)) { if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; }
          const sig = [];
          if (bx1 < 0) { cells.push(new Array(100).fill(0)); continue; }
          const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
          for (let gy = 0; gy < 10; gy++) for (let gx = 0; gx < 10; gx++) {
            let s = 0, m = 0;
            const sx0 = Math.floor(bx0 + gx * bw / 10), sx1 = Math.max(sx0 + 1, Math.floor(bx0 + (gx + 1) * bw / 10));
            const sy0 = Math.floor(by0 + gy * bh / 10), sy1 = Math.max(sy0 + 1, Math.floor(by0 + (gy + 1) * bh / 10));
            for (let y = sy0; y < sy1 && y <= y1; y++) for (let x = sx0; x < sx1 && x <= x1; x++) { if (ink(x, y)) s++; m++; }
            sig.push(m === 0 ? 0 : s / m);
          }
          cells.push(sig);
        }
      }
      return cells;
    },
    // what is at the stage's centre and corners: the topmost element that can be touched, and whether it is in the stage
    takeover() {
      const host = document.getElementById('stage');
      if (!host) return { host: false, bad: [] };
      const r = host.getBoundingClientRect();
      const left = Math.max(0, r.left), top = Math.max(0, r.top), right = Math.min(innerWidth, r.right), bottom = Math.min(innerHeight, r.bottom);
      const points = [[(left + right) / 2, (top + bottom) / 2], [left + 3, top + 3], [right - 3, top + 3], [left + 3, bottom - 3], [right - 3, bottom - 3]];
      const bad = [];
      const name = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className ? '.' + e.className.split(' ')[0] : '');
      for (const [x, y] of points) {
        const there = document.elementsFromPoint(x, y)[0];
        if (!there) bad.push(Math.round(x) + ',' + Math.round(y) + ' nothing');
        else if (!host.contains(there)) bad.push(Math.round(x) + ',' + Math.round(y) + ' ' + name(there));
      }
      return { host: true, bad };
    },
  };
})();`;

export async function installPix(tab: Tab): Promise<void> {
  await tab.eval(PIX_LIB);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// ink in the box

/** at least this share of an element's box must be pixels unlike the stage's ground: the drawing is there, not just the painter's say-so */
export const MIN_INK_SHARE = 0.02;
/** a short line of words (right to left, in a wide box) is mostly empty box (or partly under the language pane): its share is held to a fifth */
/** or this many device pixels of ink at 1x (a drawing of thin lines) */
export const MIN_LINE_INK_PX = 400;
export const MIN_TEXT_INK_SHARE = 0.004;

interface Live {
  readonly id: string;
  readonly kind: string;
  readonly text?: string;
  readonly phase: string;
  readonly opacity: number;
  readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

/** every line of words, diagram, picture and sprite that is on stage at rest and in the first view has ink in its box in the screenshot: a share of its pixels, not a handful */
export async function checkInk(tab: Tab, add: Add, picture: string, live: readonly Live[], scale: number): Promise<void> {
  const view = await tab.eval<{ w: number; h: number }>('({ w: innerWidth, h: innerHeight })');
  const clamp = (b: Live['box']): { x: number; y: number; w: number; h: number } => {
    const x = Math.max(0, b.x);
    const y = Math.max(0, b.y);
    return { x, y, w: Math.max(0, Math.min(b.x + b.width, view.w) - x), h: Math.max(0, Math.min(b.y + b.height, view.h) - y) };
  };
  const inked = live.filter((e) => ['text', 'structure', 'picture', 'sprite'].includes(e.kind) && e.phase === 'on' && e.opacity > 0.3 && area(e.box) > 400 && clamp(e.box).w * clamp(e.box).h >= 0.5 * area(e.box));
  if (inked.length === 0) return add('ink-in-box', 'PASS', 'nothing to look for');
  const marks = await tab.call<{ px: number; share: number }[]>('inkIn', picture, inked.map((e) => clamp(e.box)), scale);
  // thin line art (a number line) in a tall reserved box is a small share of it: a drawing also passes with a few hundred inked pixels, an empty box does not
  const thin = inked.filter((e, index) => (marks[index]?.share ?? 0) < (e.kind === 'text' ? MIN_TEXT_INK_SHARE : MIN_INK_SHARE) && (e.kind === 'text' || (marks[index]?.px ?? 0) < MIN_LINE_INK_PX * scale * scale));
  if (VERBOSE) process.stdout.write(`  [ink] ${inked.map((e, index) => `${e.kind}:${(e.text ?? e.id).slice(0, 14)} ${(100 * (marks[index]?.share ?? 0)).toFixed(1)}%`).join(', ')}\n`);
  add('ink-in-box', thin.length === 0 ? 'PASS' : 'FAIL', thin.length === 0 ? `${inked.length} elements on stage, each with at least ${MIN_INK_SHARE * 100}% of its box inked in the screenshot` : `listed on stage but (almost) nothing is drawn where it is in the screenshot: ${thin.slice(0, 4).map((e) => `${e.id} (${e.kind}) ${(100 * (marks[inked.indexOf(e)]?.share ?? 0)).toFixed(1)}%`).join(', ')}`);
}

/** A PNG of a grid with a line at each tenth, so a leader that ends off its spot is seen to (the same pattern `pnpm photo-check` uses). */
export function testPattern(width: number, height: number): Buffer {
  const crc32 = (bytes: Buffer): number => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      const grid = x % (width / 10) < 1 || y % (height / 10) < 1;
      row[1 + x * 3] = grid ? 60 : 200 + ((x * 3) % 40);
      row[2 + x * 3] = grid ? 60 : 210;
      row[3 + x * 3] = grid ? 120 : 200 + ((y * 3) % 40);
    }
    rows.push(row);
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// takeover

/** the stage must be what is at its centre and corners: not a panel, a veil or a page laid over it */
export async function checkTakeover(tab: Tab, add: Add): Promise<void> {
  await installPix(tab);
  const seen = await tab.eval<{ host: boolean; bad: string[] }>('window.__pix.takeover()');
  if (!seen.host) return add('stage-not-covered', 'FAIL', 'there is no #stage element to look at');
  add('stage-not-covered', seen.bad.length === 0 ? 'PASS' : 'FAIL', seen.bad.length === 0 ? 'the stage is what is at its centre and corners (nothing laid over it)' : `something other than the stage is at ${seen.bad.slice(0, 3).join('; ')}`);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// footprints

interface Piece {
  readonly key: string;
  readonly id: string;
  readonly kind: string;
  readonly text: string;
  readonly phase: string;
  readonly opacity: number;
  readonly fontPx: number;
  readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

export interface Footprint {
  readonly id: string;
  readonly kind: string;
  readonly text: string;
  readonly box: Piece['box'];
  /** where it is really drawn, CSS pixels; null when hiding it changed nothing */
  readonly drawn: { readonly x: number; readonly y: number; readonly w: number; readonly h: number } | null;
  /** when a spot was asked for: how far the footprint comes from it, CSS pixels */
  readonly spotGap: number | null;
}

/** how many elements of one scene are looked at (the biggest first): each costs a picture */
export const FOOTPRINT_CAP = 30;


/**
 * Hides each line of words and each node in turn and finds what the screen loses. `scale` is the page's device pixel ratio. Returns what it found for each
 * element, so a scene can ask more of its own (where a column of digits ends, the cells of a line).
 */
export async function footprintJudge(tab: Tab, add: Add, options: { readonly scale: number; readonly cap?: number; readonly spots?: ReadonlyMap<string, { readonly x: number; readonly y: number }> } = { scale: 1 }): Promise<Map<string, Footprint>> {
  const found = new Map<string, Footprint>();
  await installPix(tab);
  const view = await tab.eval<{ w: number; h: number }>('({ w: innerWidth, h: innerHeight })');
  const pieces = await tab.eval<Piece[]>('window.__stage.elements().map((e) => ({ key: e.key, id: e.id, kind: e.kind, text: String(e.text || ""), phase: e.phase, opacity: e.opacity, fontPx: e.fontPx, box: e.box }))');
  const onScreen = (p: Piece): boolean => {
    const w = Math.max(0, Math.min(p.box.x + p.box.width, view.w) - Math.max(p.box.x, 0));
    const h = Math.max(0, Math.min(p.box.y + p.box.height, view.h) - Math.max(p.box.y, 0));
    return w * h >= 0.5 * area(p.box);
  };
  const candidates = pieces.filter((p) => (p.kind === 'text' || p.kind === 'node') && p.phase === 'on' && p.opacity > 0.3 && area(p.box) > 0 && onScreen(p));
  const chosen = [...candidates].sort((a, b) => area(b.box) - area(a.box)).slice(0, options.cap ?? FOOTPRINT_CAP);
  // words set on a painting or a photo are meant to stand on ink: their ground is not blank
  const grounds = pieces.filter((p) => ['picture', 'sprite'].includes(p.kind) && p.phase === 'on' && area(p.box) > 0);
  const onGround = (p: Piece): boolean => grounds.some((g) => p.box.x < g.box.x + g.box.width && p.box.x + p.box.width > g.box.x && p.box.y < g.box.y + g.box.height && p.box.y + p.box.height > g.box.y);
  if (chosen.length === 0) return found;
  const problems: string[] = [];
  const names = new Map(chosen.map((p) => [p.id, `"${(p.kind === 'text' ? p.text : p.id).slice(0, 24)}"`]));
  try {
    await tab.eval('window.__stage.hide([])');
    await tab.eval('window.__pix.clear()');
    await tab.eval(`window.__pix.put('a', ${JSON.stringify(await tab.shot())})`);
    await sleep(120);
    await tab.eval(`window.__pix.put('b', ${JSON.stringify(await tab.shot())})`);
    const leaderIds: string[] = [];
    for (const piece of chosen) {
      const spot = options.spots?.get(piece.id) ?? null;
      const here = { x: piece.box.x, y: piece.box.y, w: piece.box.width, h: piece.box.height };
      // a callout's leader is its own figure: when the frame holds one, it is hidden alone first, so the line is looked at apart from the words
      if (piece.kind === 'text' && (await tab.eval<string[]>(`window.__stage.hide(${JSON.stringify([`${piece.key}/leader`])})`)).length > 0) {
        await tab.eval(`window.__pix.put('h', ${JSON.stringify(await tab.shot())})`);
        const line = await tab.eval<{ count: number; x?: number; y?: number; w?: number; h?: number; spotGap?: number }>(`window.__pix.foot(${JSON.stringify(`${piece.id}/leader`)}, ${JSON.stringify(here)}, ${options.scale}, 4000, ${JSON.stringify(spot)})`);
        found.set(`${piece.id}/leader`, { id: `${piece.id}/leader`, kind: 'leader', text: '', box: piece.box, drawn: line.count >= 4 && line.x !== undefined ? { x: line.x, y: line.y as number, w: line.w as number, h: line.h as number } : null, spotGap: line.spotGap ?? null });
        if (line.count >= 4) leaderIds.push(`${piece.id}/leader`);
        names.set(`${piece.id}/leader`, `the leader of "${piece.text.slice(0, 20)}"`);
      }
      await tab.eval(`window.__stage.hide(${JSON.stringify([piece.key])})`);
      await tab.eval(`window.__pix.put('h', ${JSON.stringify(await tab.shot())})`);
      const margin = Math.max(40, piece.box.height * 1.5);
      const grow = Math.max(8, 0.35 * piece.fontPx);
      const mine = await tab.eval<{ count: number; x?: number; y?: number; w?: number; h?: number; ink?: number; inkArea?: number; spotGap?: number }>(`window.__pix.foot(${JSON.stringify(piece.id)}, ${JSON.stringify(here)}, ${options.scale}, ${margin}, null)`);
      const drawn = mine.count >= 4 && mine.x !== undefined ? { x: mine.x, y: mine.y as number, w: mine.w as number, h: mine.h as number } : null;
      found.set(piece.id, { id: piece.id, kind: piece.kind, text: piece.text, box: piece.box, drawn, spotGap: mine.spotGap ?? null });
      const label = names.get(piece.id) as string;
      if (VERBOSE) process.stdout.write(`  [pix] ${label} ${piece.kind} box ${Math.round(piece.box.x)},${Math.round(piece.box.y)} ${Math.round(piece.box.width)}x${Math.round(piece.box.height)} foot ${drawn === null ? 'none' : `${drawn.x.toFixed(0)},${drawn.y.toFixed(0)} ${drawn.w.toFixed(0)}x${drawn.h.toFixed(0)}`} px ${mine.count} ink ${mine.ink ?? 0}/${mine.inkArea ?? 0}\n`);
      if (drawn === null) {
        problems.push(`${label} is on stage but hiding it changes nothing on screen (covered, or not drawn)`);
        continue;
      }
      if (piece.kind === 'text') {
        const out = [drawn.x < piece.box.x - grow ? 'left' : '', drawn.y < piece.box.y - grow ? 'top' : '', drawn.x + drawn.w > piece.box.x + piece.box.width + grow ? 'right' : '', drawn.y + drawn.h > piece.box.y + piece.box.height + grow ? 'bottom' : ''].filter((side) => side !== '');
        if (out.length > 0) problems.push(`${label} is drawn well outside its box (${out.join('/')}): footprint ${Math.round(drawn.x)},${Math.round(drawn.y)} ${Math.round(drawn.w)}x${Math.round(drawn.h)}, box ${Math.round(piece.box.x)},${Math.round(piece.box.y)} ${Math.round(piece.box.width)}x${Math.round(piece.box.height)}`);
      }
      const ink = mine.ink ?? 0;
      const inkArea = Math.max(1, mine.inkArea ?? 1);
      if (piece.kind === 'text' && !onGround(piece) && ink >= Math.max(24 * options.scale * options.scale, 0.03 * inkArea)) problems.push(`${label} has other ink in its place (${ink} px, ${Math.round((100 * ink) / inkArea)}% of its box: a stroke or other words run through it)`);
    }
    const meets = await tab.eval<{ a: string; b: string; w: number; h: number; na: number; nb: number }[]>(`window.__pix.meets(${JSON.stringify([...chosen.map((p) => p.id), ...leaderIds])}, ${options.scale})`);
    for (const meet of meets) if (meet.a !== `${meet.b}/leader` && meet.b !== `${meet.a}/leader`) problems.push(`${names.get(meet.a)} and ${names.get(meet.b)} are drawn on one another (${meet.w.toFixed(0)}x${meet.h.toFixed(0)} px shared)`);
  } finally {
    await tab.eval('window.__stage.hide([])').catch(() => undefined);
  }
  add('footprints', problems.length === 0 ? 'PASS' : 'FAIL', problems.length === 0 ? `${chosen.length}${candidates.length > chosen.length ? ` of ${candidates.length}` : ''} lines and nodes hidden in turn: each is really drawn, inside its box, on none of the others and over no stroke` : problems.slice(0, 4).join('; ') + (problems.length > 4 ? ` and ${problems.length - 4} more` : ''));
  return found;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// glyphs

/** the least difference between any two cells of a line, 0 (the same picture) to 1 */
function leastDifference(cells: readonly number[][]): number {
  let least = 1;
  for (let a = 0; a < cells.length; a += 1) {
    for (let b = a + 1; b < cells.length; b += 1) {
      const x = cells[a] as number[];
      const y = cells[b] as number[];
      let diff = 0;
      for (let i = 0; i < x.length; i += 1) diff += Math.abs((x[i] as number) - (y[i] as number));
      least = Math.min(least, diff / x.length);
    }
  }
  return least;
}

const CJK_CHAR = /[぀-ヿ㐀-鿿가-힯]/;

/** the characters of CJK lines are different pictures, not one "?" or one missing-glyph box repeated: their cells are compared with each other */
export async function checkGlyphs(tab: Tab, add: Add, feet: ReadonlyMap<string, Footprint>, lines: readonly string[], scale: number): Promise<void> {
  const problems: string[] = [];
  const notes: string[] = [];
  let judged = 0;
  for (const line of lines) {
    const foot = [...feet.values()].find((candidate) => candidate.kind === 'text' && candidate.text.replace(/\s+/g, ' ').trim() === line);
    if (foot === undefined || foot.drawn === null) {
      problems.push(`the line "${line}" has no footprint to read its characters from`);
      continue;
    }
    // punctuation is a nearly empty cell and alike to other punctuation: only the characters themselves are compared
    const words = line.split(/\s+/).map((word) => [...word].length);
    const cells = await tab.eval<number[][]>(`window.__pix.cells(${JSON.stringify({ x: foot.drawn.x - 1, y: foot.drawn.y - 1, w: foot.drawn.w + 2, h: foot.drawn.h + 2 })}, ${JSON.stringify(words)}, ${scale})`);
    const chars = line.replace(/\s+/g, '');
    const solid = cells.filter((_, index) => CJK_CHAR.test([...chars][index] ?? ''));
    if (solid.length < 3) {
      problems.push(`"${line}": too few characters to compare (${solid.length})`);
      continue;
    }
    judged += 1;
    const least = leastDifference(solid);
    notes.push(least.toFixed(2));
    if (least < 0.02) problems.push(`two characters of "${line}" are the same picture (least difference ${least.toFixed(3)}): "?" or missing-glyph boxes`);
  }
  add('glyphs', problems.length === 0 ? 'PASS' : 'FAIL', problems.length === 0 ? `${judged} lines of CJK: every character is its own picture (least difference ${notes.join(', ')})` : problems.join('; '));
}

// ---------------------------------------------------------------------------------------------------------------------------------
// two of the free checks that were never part of `pnpm check`

/** one of the repository's own scripts run to its end: its output and whether it passed */
async function run(args: readonly string[], env: Readonly<Record<string, string>>): Promise<{ readonly ok: boolean; readonly out: string }> {
  const child = spawnTracked('pnpm', ['-s', ...args], undefined, { cwd: repoRoot(), env });
  let out = '';
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', (chunk: Buffer) => (out = (out + chunk.toString()).slice(-20_000)));
  const code = await new Promise<number | null>((done) => {
    child.once('close', (status) => done(status));
    child.once('error', () => done(-1));
  });
  return { ok: code === 0, out };
}

/** `pnpm flows`: the car flowchart laid out at the sizes people use, held to its lanes, labels, ports and detours */
export async function flowsGroup(): Promise<CheckResult[]> {
  const result = await run(['flows'], {});
  const bad = result.out.split('\n').filter((line) => /^FAIL|^\s+\S.*:/.test(line) && !/^ok/.test(line)).slice(0, 4);
  const sizes = result.out.split('\n').filter((line) => line.startsWith('ok')).length;
  return [{ turn: 0, check: 'flows', verdict: result.ok ? 'PASS' : 'FAIL', detail: result.ok ? `the flowchart's connectors and labels hold at ${sizes} sizes` : `pnpm flows failed: ${bad.join(' | ') || result.out.slice(-300)}` }];
}

/** `pnpm photo-check`: a generated test pattern labelled at spots; every leader must end within 1% of the photo's width of its spot. Its own web and Chrome ports come from CHECK_PORTS. */
export async function photoGroup(): Promise<CheckResult[]> {
  const web = await claimPort('the capture page');
  const chrome = await claimPort('the capture Chrome');
  try {
    let result = await run(['photo-check'], { CAPTURE_WEB_PORT: String(web), CAPTURE_CHROME_PORT: String(chrome) });
    // a dev server that was slow to start under the load of the other groups is given one more try
    if (!result.ok && /timed out waiting/.test(result.out)) result = await run(['photo-check'], { CAPTURE_WEB_PORT: String(web), CAPTURE_CHROME_PORT: String(chrome) });
    const spots = result.out.split('\n').filter((line) => line.includes('spot ')).length;
    return [{ turn: 0, check: 'photo', verdict: result.ok ? 'PASS' : 'FAIL', detail: result.ok ? `${spots} callouts at spots on two photo shapes: every leader ends within 1% of its spot` : `pnpm photo-check failed: ${result.out.split('\n').filter((line) => line.includes('spot ') || line.includes('capture:')).slice(-4).join(' | ') || result.out.slice(-300)}` }];
  } finally {
    releasePort(web);
    releasePort(chrome);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// streaming

/** a turn recorded as `claude -p --output-format stream-json` prints it (made up for this check, not recorded from anyone's session) */
const STREAM_FIXTURE = join(import.meta.dirname, 'check-fixtures', 'stream-turn.jsonl');

/**
 * The brain's own reading of a recorded stream, in Node: each text delta is handed to `brainEventsFromText` as it is printed (the way claude-cli-brain does it), and the
 * lines it makes must come out while the stream is still being fed, not all together at its end.
 */
export async function streamFixtureCheck(): Promise<CheckResult[]> {
  const lines = readFileSync(STREAM_FIXTURE, 'utf8').split('\n').filter((line) => line.trim() !== '');
  const deltas = lines.flatMap((line) => {
    const event = parseStreamLine(line);
    const text = event === null ? null : textDeltaOf(event);
    return text === null ? [] : [text];
  });
  let fed = 0;
  async function* chunks(): AsyncGenerator<string> {
    for (const delta of deltas) {
      fed += 1;
      yield delta;
      await sleep(5);
    }
  }
  const seenAt: number[] = [];
  for await (const event of brainEventsFromText(chunks(), [], true)) if (event.type === 'line') seenAt.push(fed);
  const total = deltas.length;
  const early = seenAt.filter((at) => at < total).length;
  const problems: string[] = [];
  if (deltas.length < 8) problems.push(`the fixture holds only ${deltas.length} text deltas`);
  if (seenAt.length < 5) problems.push(`only ${seenAt.length} lines came out of the stream`);
  if (seenAt.length > 0 && (seenAt[0] as number) > Math.ceil(total / 3)) problems.push(`the first line came out only after ${seenAt[0]} of ${total} deltas`);
  if (early < seenAt.length - 1) problems.push(`${seenAt.length - early} lines came out together at the end of the stream (a burst)`);
  if (new Set(seenAt).size < Math.min(seenAt.length, 5)) problems.push(`the lines came out in clumps (after deltas ${[...new Set(seenAt)].join(', ')})`);
  return [{ turn: 0, check: 'stream-fixture', verdict: problems.length === 0 ? 'PASS' : 'FAIL', detail: problems.length === 0 ? `${seenAt.length} lines came out one by one while ${total} deltas were fed (first after delta ${seenAt[0]})` : problems.join('; ') }];
}


// ---------------------------------------------------------------------------------------------------------------------------------
// listings and slides

/** What a demo script holds in one scene: the code blocks (their rows as written), the lines said, how many tables. */
export interface SceneFacts {
  /** `id` is null when the script gave the block none (the page names it) */
  readonly listings: { readonly id: string | null; readonly rows: string[] }[];
  readonly says: string[];
  tables: number;
}

/** The scenes of a script, read the way the page reads it (`LineReader`): `code` blocks with their rows, `say` lines, `table` blocks. A `deck` line opens the first slide, which a `scene` straight after it only names. */
export function sceneFactsOf(source: string): SceneFacts[] {
  const reader = new LineReader();
  const scenes: SceneFacts[] = [];
  let fresh = false;
  /** the code block whose rows are being written: any other line closes it */
  let open: SceneFacts['listings'][number] | null = null;
  const here = (): SceneFacts => {
    if (scenes.length === 0) scenes.push({ listings: [], says: [], tables: 0 });
    return scenes[scenes.length - 1] as SceneFacts;
  };
  for (const raw of source.split('\n')) {
    const result = reader.read(raw);
    if (result.kind !== 'line') continue;
    const line = result.line;
    if (line.verb === 'row') {
      open?.rows.push(line.cells);
      continue;
    }
    open = null;
    switch (line.verb) {
      case 'deck':
        scenes.push({ listings: [], says: [], tables: 0 });
        fresh = true;
        break;
      case 'scene':
        if (!fresh) scenes.push({ listings: [], says: [], tables: 0 });
        fresh = false;
        break;
      case 'code':
        fresh = false;
        open = { id: line.id === undefined || line.id === '-' ? null : line.id, rows: [] };
        here().listings.push(open);
        break;
      case 'table':
        fresh = false;
        here().tables += 1;
        break;
      case 'say':
        fresh = false;
        here().says.push(line.text);
        break;
      default:
    }
  }
  return scenes;
}

interface Stretch {
  readonly key: string;
  readonly row: number;
  readonly column: number;
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** the stretches of text of every listing the text layer holds, as the page has them (the text layer is the painter's own account of where each drawn word is) */
const STRETCHES = `[...document.querySelectorAll('.stage__text-block--code')].flatMap((block) => {
  const line = block.querySelector('.stage__text-line');
  if (!line) return [];
  const r = line.getBoundingClientRect();
  return [{ key: block.dataset.key || '', row: Number(block.dataset.row), column: Number(block.dataset.column), text: line.textContent || '', x: r.left, y: r.top, w: r.width, h: r.height }];
})`;

interface OnStage {
  readonly id: string;
  readonly key: string;
  readonly kind: string;
  readonly text: string;
  readonly phase: string;
  readonly opacity: number;
  readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

const ON_STAGE = 'window.__stage.elements().map((e) => ({ id: e.id, key: e.key, kind: e.kind, text: String(e.text || ""), phase: e.phase, opacity: e.opacity, box: e.box }))';

/**
 * Each `code` block of a scene at rest, on real pixels. It is on stage (an element of the structure kind, phase `on`) in a box of a real size inside the screen: a block
 * the painter lists but gives no box (the engine that is missing says nothing and draws nothing) fails here, where the ink check lets a box under 400 square pixels go
 * unjudged. Every row of the script is read back from the text layer, stretch by stretch at its column, and must be the row as written, indentation and all, and no row more.
 * Then each row's words are hidden in turn: the pixels that change are the row's footprint, and it must have ink, inside the block's box.
 */
export async function checkListings(tab: Tab, add: Add, listings: SceneFacts['listings'], scale: number): Promise<void> {
  if (listings.length === 0) return;
  await installPix(tab);
  const view = await tab.eval<{ w: number; h: number }>('({ w: innerWidth, h: innerHeight })');
  const live = await tab.eval<OnStage[]>(ON_STAGE);
  const blocks = live.filter((e) => e.kind === 'structure' && e.phase === 'on' && e.opacity > 0.3 && /^code\b/.test(e.text));
  const onStage: string[] = [];
  const placed: string[] = [];
  const rowProblems: string[] = [];
  const drawnRows: string[] = [];
  let rowsJudged = 0;
  for (const [index, listing] of listings.entries()) {
    const name = listing.id ?? `#${index + 1}`;
    const block = listing.id === null ? blocks[index] : blocks.find((e) => e.id === listing.id);
    if (block === undefined) {
      onStage.push(`the code block ${name} is not on stage (${blocks.length === 0 ? 'no code block is' : `only ${blocks.map((e) => e.id).join(', ')} ${blocks.length === 1 ? 'is' : 'are'}`})`);
      if (listing.rows.some((row) => row.trim() !== '')) rowProblems.push(`${name}: the script wrote ${listing.rows.filter((row) => row.trim() !== '').length} rows and none of them is on stage`);
      continue;
    }
    const box = block.box;
    if (box.width < 80 || box.height < 30) onStage.push(`the code block ${name} is on stage but has no box to speak of (${Math.round(box.width)}x${Math.round(box.height)}): nothing of it is drawn`);
    else if (box.x < -2 || box.y < -2 || box.x + box.width > view.w + 2 || box.y + box.height > view.h + 2) placed.push(`the code block ${name} stands outside the screen (${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)} on ${view.w}x${view.h})`);
    if (box.width < 80 || box.height < 30) {
      // a block with no box has drawn no row: the rows the script wrote are not on stage, and none is passed for want of something to look at
      if (listing.rows.some((row) => row.trim() !== '')) rowProblems.push(`${name}: the script wrote ${listing.rows.filter((row) => row.trim() !== '').length} rows and none of them is drawn`);
      continue;
    }
    // the text layer is built when the stage comes to rest: given a moment after a seek
    let stretches: Stretch[] = [];
    for (let waited = 0; waited < 3000; waited += 150) {
      stretches = (await tab.eval<Stretch[]>(STRETCHES)).filter((stretch) => stretch.key.startsWith(`${block.key}/`));
      if (stretches.length > 0) break;
      await sleep(150);
    }
    const read = new Map<number, Stretch[]>();
    for (const stretch of stretches) read.set(stretch.row, [...(read.get(stretch.row) ?? []), stretch]);
    const lineOf = (row: number): string => (read.get(row) ?? []).sort((a, b) => a.column - b.column).reduce((line, stretch) => `${line.padEnd(stretch.column, ' ')}${stretch.text}`, '');
    const wrong: string[] = [];
    listing.rows.forEach((row, at) => {
      const got = lineOf(at);
      if (got !== row.replace(/\s+$/, '')) wrong.push(`row ${at + 1} reads "${got.slice(0, 40)}" where the script has "${row.slice(0, 40)}"`);
    });
    for (const row of read.keys()) if (row >= listing.rows.length) wrong.push(`row ${row + 1} is on stage but the script has only ${listing.rows.length}`);
    if (wrong.length > 0) rowProblems.push(`${name}: ${wrong.slice(0, 3).join('; ')}${wrong.length > 3 ? ` and ${wrong.length - 3} more` : ''}`);
    if (stretches.length === 0 && listing.rows.some((row) => row.trim() !== '')) continue;
    // each row's footprint
    try {
      await tab.eval('window.__stage.hide([])');
      await tab.eval('window.__pix.clear()');
      await tab.eval(`window.__pix.put('a', ${JSON.stringify(await tab.shot())})`);
      await sleep(120);
      await tab.eval(`window.__pix.put('b', ${JSON.stringify(await tab.shot())})`);
      for (const [at, row] of listing.rows.entries()) {
        const mine = read.get(at) ?? [];
        if (row.trim() === '' || mine.length === 0) continue;
        rowsJudged += 1;
        await tab.eval(`window.__stage.hide(${JSON.stringify(mine.map((stretch) => stretch.key))})`);
        await tab.eval(`window.__pix.put('h', ${JSON.stringify(await tab.shot())})`);
        const x0 = Math.min(...mine.map((stretch) => stretch.x));
        const y0 = Math.min(...mine.map((stretch) => stretch.y));
        const here = { x: x0, y: y0, w: Math.max(...mine.map((stretch) => stretch.x + stretch.w)) - x0, h: Math.max(...mine.map((stretch) => stretch.y + stretch.h)) - y0 };
        const foot = await tab.eval<{ count: number; x?: number; y?: number; w?: number; h?: number }>(`window.__pix.foot(${JSON.stringify(`${block.id}/row${at}`)}, ${JSON.stringify(here)}, ${scale}, 4, null)`);
        const chars = row.replace(/\s+/g, '').length;
        const least = Math.max(10, 8 * chars) * scale * scale;
        if (VERBOSE) process.stdout.write(`  [code] ${name} row ${at + 1} "${row.trim().slice(0, 24)}" ink ${foot.count} px (least ${least})\n`);
        if (foot.count < least || foot.x === undefined) drawnRows.push(`${name} row ${at + 1} "${row.trim().slice(0, 24)}" is on the text layer but hiding it changes ${foot.count} px on screen (least ${Math.round(least)}): it is not drawn`);
        else {
          const grow = 4;
          if ((foot.x as number) < box.x - grow || (foot.x as number) + (foot.w as number) > box.x + box.width + grow || (foot.y as number) < box.y - grow || (foot.y as number) + (foot.h as number) > box.y + box.height + grow) {
            drawnRows.push(`${name} row ${at + 1} "${row.trim().slice(0, 24)}" is drawn outside its block (${Math.round(foot.x as number)},${Math.round(foot.y as number)} ${Math.round(foot.w as number)}x${Math.round(foot.h as number)} against ${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)})`);
          }
        }
      }
    } finally {
      await tab.eval('window.__stage.hide([])').catch(() => undefined);
    }
  }
  add('code-block', onStage.length === 0 && placed.length === 0 ? 'PASS' : 'FAIL', onStage.length === 0 && placed.length === 0 ? `${listings.length} code block${listings.length === 1 ? ' is' : 's are'} on stage, in a box of a real size inside the screen` : [...onStage, ...placed].slice(0, 3).join('; '));
  const bad = [...rowProblems, ...drawnRows];
  add('code-rows', bad.length === 0 ? 'PASS' : 'FAIL', bad.length === 0 ? `every row is on the text layer as written, indentation and all, and ${rowsJudged} rows hidden in turn each take real ink off the screen, inside their block` : `${bad.slice(0, 3).join('; ')}${bad.length > 3 ? ` and ${bad.length - 3} more` : ''}`);
}

/** The lines a scene says are on stage, and the tables it makes (a table is a structure with a box of a real size): a deck's slides, and a code demo's captions. */
export async function checkSlideWords(tab: Tab, add: Add, facts: SceneFacts): Promise<void> {
  const live = await tab.eval<OnStage[]>(ON_STAGE);
  const norm = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();
  const texts = live.filter((e) => e.kind === 'text' && e.phase === 'on' && e.opacity > 0.3);
  const problems: string[] = [];
  for (const words of facts.says) if (!texts.some((e) => norm(e.text) === norm(words))) problems.push(`"${words.slice(0, 40)}" is not on stage`);
  const tables = live.filter((e) => e.kind === 'structure' && e.phase === 'on' && e.opacity > 0.3 && /^table\b/.test(e.text) && e.box.width >= 80 && e.box.height >= 30);
  if (tables.length < facts.tables) problems.push(`${facts.tables} table${facts.tables === 1 ? ' is' : 's are'} written but ${tables.length} stand${tables.length === 1 ? 's' : ''} on stage in a box of a real size`);
  add('slide-words', problems.length === 0 ? 'PASS' : 'FAIL', problems.length === 0 ? `the ${facts.says.length} line${facts.says.length === 1 ? '' : 's'} said${facts.tables > 0 ? ` and ${facts.tables} table${facts.tables === 1 ? '' : 's'}` : ''} of the scene are on stage` : problems.slice(0, 3).join('; '));
}
