// The richer parts (PLAN-v2.2 F1, "mock-up fidelity"): what makes a mock-up read as the kind of app it is. A media grid of cover tiles, a carousel that moves under a
// finger, a player bar, chat bubbles, a map card, a stat card, a list with avatars, a segmented header. Each is one line of the brain's text and owns its words (a
// tile's title and subtitle, a bubble's sentence, a person's name), is laid out by the same flex solver as every other part, and takes its colours, radii and type from
// the tokens, so a dark theme or a serif is all of them at once. The ones that are live say how: a player's play button flips, its bar is scrubbed; a carousel is
// dragged; a segment is picked; a people list or a media grid goes to a screen when a row is tapped.
//
// Pure: no DOM, no clock.

import { unstar } from './lang';
import type { UiPartNode } from './lang';
import { avatar, coverArt, initialsOf, mapArt, roundedPoly, sparkline } from './art';
import type { Pt } from './art';
import { flex, gutterOf, icon, mk, packOf, px4, rectOf, shadowOf, text } from './kit-base';
import type { Ctx, Kit, N, Out, Rect } from './kit-base';
import type { Style } from './solve';
import { isDark } from './theme';
import { UI_DEVICE_SIZE } from './lang';
import type { UiAction, UiPath } from './types';

// ------------------------------------------------------------------ reading the words

/** `Title / Subtitle / more`: the words of one tile, one person, one track. */
export function pieces(field: string | undefined): string[] {
  return (field ?? '').split(/\s+\/\s+/).map((piece) => piece.trim());
}

const desk = (k: Kit): boolean => k.device === 'desktop' || k.device === 'browser';

/** A press that goes to a screen when it is let go of (and is not for the brain unless the part says so). */
function goes(control: string, to: string | undefined): UiAction {
  return { kind: 'press', control, ...(to === undefined || to === '' ? {} : { to }) };
}

function pressed(k: Kit, control: string): boolean {
  return k.state.pressed === control;
}

/** The art a picture stands on: cover art in a finished design, a crossed box in a wireframe. */
function placeholder(k: Kit, out: Out, owner: string, seed: string, b: Rect, radius: number | readonly [number, number, number, number], what = 'art'): void {
  const radii: readonly [number, number, number, number] = typeof radius === 'number' ? [radius, radius, radius, radius] : radius;
  if (k.t.wire) {
    const c = k.t.colour;
    rectOf(out, owner, `${what}:box`, b, { radius: Math.max(...radii), fill: c.sunken, edge: { colour: c.edge, width: 1 } });
    const inset = Math.min(8, Math.min(b.w, b.h) / 4);
    out.parts.push({ kind: 'path', key: out.key(owner, `${what}:cross`), owner, outline: [{ closed: false, points: [{ x: b.x + inset, y: b.y + inset }, { x: b.x + b.w - inset, y: b.y + b.h - inset }] }, { closed: false, points: [{ x: b.x + b.w - inset, y: b.y + inset }, { x: b.x + inset, y: b.y + b.h - inset }] }], fill: null, stroke: { colour: c.line, width: 1 } });
    return;
  }
  coverArt(out, owner, seed, b, radii, what);
}

/** A square (or other) leaf that paints a picture and takes its height from its width. */
function pictureLeaf(id: string, part: string, ratio: number, cap: number, paint: (b: Rect, out: Out) => void): N {
  return mk({ width: 'fill', height: 'hug' }, null, { fit: (w) => ({ w: Number.isFinite(w) ? w : 160, h: Math.min(cap, px4((Number.isFinite(w) ? w : 160) / ratio)) }), minW: 0 }, [], { id, part, quiet: true, paint });
}

/** An icon button: a box 44 or more across that a finger can use, with its glyph set in the middle. */
function iconButton(k: Kit, id: string, name: string, size: number, colour: string, action: UiAction, o: { readonly box?: number; readonly fill?: string; readonly filled?: boolean; readonly radius?: number; readonly part?: string } = {}): N {
  const box = o.box ?? 48;
  const paint = (b: Rect, out: Out): void => {
    if (o.fill !== undefined) rectOf(out, id, 'disc', { x: b.x + (b.w - box) / 2, y: b.y + (b.h - box) / 2, w: box, h: box }, { radius: o.radius ?? box / 2, fill: o.fill, ...(pressed(k, id) ? { fillAlpha: 0.82 } : {}) });
    else if (pressed(k, id)) rectOf(out, id, 'pressed', b, { radius: b.w / 2, fill: k.t.colour.ink, fillAlpha: 0.1 });
  };
  const glyph = icon(id, name, size, colour, 2, o.filled === true);
  return mk({ width: Math.max(box, 44), height: Math.max(box, 44), shrink: 0 }, flex('row', { align: 'center', justify: 'center' }), null, [glyph], { id, part: o.part ?? 'icon-button', target: true, paint, action, quiet: true, owner: id });
}

// ------------------------------------------------------------------ a section title

function sectionRow(k: Kit, p: UiPartNode, sidePad: number): N | null {
  const title = p.attrs['title'];
  if (title === undefined || title === '') return null;
  const more = p.attrs['more'];
  const kids: N[] = [text(k, title, k.type.title, { id: p.id, colour: k.t.colour.ink, what: 'section', grow: 1, maxLines: 1 })];
  if (more !== undefined && more !== '') kids.push(text(k, more, { ...k.type.note, weight: 'bold' }, { id: p.id, nowrap: true, colour: k.t.colour.accentInk, what: 'more' }));
  return mk({ width: 'fill', height: 'hug' }, flex('row', { align: 'center', gap: 12, pad: [0, sidePad, 0, sidePad] }), null, kids, { id: `${p.id}:section`, part: 'section', quiet: true, owner: p.id });
}

// ------------------------------------------------------------------ media: a grid of covers

interface TileOptions {
  readonly round: boolean;
  readonly ratio: number;
  readonly width: Style['width'];
  readonly to?: string;
}

/** One cover with its title and subtitle under it. */
function tileOf(k: Kit, p: UiPartNode, i: number, title: string, sub: string, o: TileOptions): N {
  const c = k.t.colour;
  const id = `${p.id}:t${i}`;
  const cap = px4(UI_DEVICE_SIZE[k.device].height * 0.45);
  const cover = pictureLeaf(id, 'cover', o.ratio, cap, (b, out) => {
    const r = o.round ? Math.min(b.w, b.h) / 2 : k.t.radius.m;
    placeholder(k, out, p.id, title, b, r, `cover${i}`);
    if (pressed(k, id)) rectOf(out, p.id, `cover${i}:pressed`, b, { radius: r, fill: c.ink, fillAlpha: 0.12 });
  });
  const words: N[] = [text(k, title, k.type.label, { id: p.id, colour: c.ink, what: `title:${i}`, maxLines: 1, align: o.round ? 'center' : 'left', width: 'fill' })];
  if (sub !== '') words.push(text(k, sub, k.type.note, { id: p.id, colour: c.dim, what: `subtitle:${i}`, maxLines: 1, align: o.round ? 'center' : 'left', width: 'fill' }));
  const wordBox = mk({ width: 'fill', height: 'hug' }, flex('col', { gap: 0, align: 'stretch' }), null, words, { id: `${id}:words`, part: 'tile-words', quiet: true, owner: p.id });
  const action = o.to === undefined ? undefined : goes(id, o.to);
  return mk({ width: o.width, height: 'hug', minW: 0, ...(o.width === 'fill' ? {} : { shrink: 0 }) }, flex('col', { gap: 8, align: 'stretch' }), null, [cover, wordBox], { id, part: 'tile', quiet: true, owner: p.id, ...(action === undefined ? {} : { target: true, action }) });
}

export function mediaOf(k: Kit, p: UiPartNode): N {
  const wide = p.flags.includes('wide');
  const round = p.flags.includes('round');
  const asked = Number(p.attrs['cols']);
  const cols = Math.max(1, Math.min(6, Number.isFinite(asked) && asked >= 1 ? Math.floor(asked) : desk(k) ? 4 : 2));
  const all = p.fields.map(pieces);
  const items = k.t.squeeze === true ? all.slice(0, cols) : all;
  const rows: N[] = [];
  for (let at = 0; at < items.length; at += cols) {
    const line: N[] = items.slice(at, at + cols).map((it, j) => tileOf(k, p, at + j, it[0] ?? '', it[1] ?? '', { round, ratio: wide ? 16 / 10 : 1, width: 'fill', ...(p.attrs['to'] === undefined ? {} : { to: p.attrs['to'] }) }));
    // a last row that is short keeps its columns: the empty places are as wide as the tiles
    while (line.length < cols) line.push(mk({ width: 'fill', height: 0, minW: 0 }, null, { fit: () => ({ w: 0, h: 0 }), minW: 0 }, [], { id: `${p.id}:gap${at}${line.length}`, part: 'space', quiet: true }));
    rows.push(mk({ width: 'fill', height: 'hug' }, flex('row', { align: 'start', gap: 12 }), null, line, { id: `${p.id}:row${at / cols}`, part: 'media-row', quiet: true, owner: p.id }));
  }
  const head = sectionRow(k, p, 0);
  const grid = mk({ width: 'fill', height: 'hug' }, flex('col', { gap: 16 + packOf(k) * 4 }), null, rows, { id: `${p.id}:grid`, part: 'media-grid', quiet: true, owner: p.id });
  return mk({ width: 'fill', height: 'hug' }, flex('col', { gap: 12 }), null, head === null ? [grid] : [head, grid], { id: p.id, part: 'media' });
}

// ------------------------------------------------------------------ carousel: a row that is dragged

export function carouselOf(k: Kit, p: UiPartNode): N {
  const items = p.fields.map(pieces);
  const round = p.flags.includes('round');
  const wide = p.flags.includes('wide');
  const side = gutterOf(k);
  const deviceW = UI_DEVICE_SIZE[k.device].width;
  // two tiles and a part of the third are in view: the next one peeks, so that it can be seen that the row moves
  const tileW = desk(k) ? 200 : px4(Math.min(200, (deviceW - side) / 2.4));
  const tiles = items.map((it, i) => tileOf(k, p, i, it[0] ?? '', it[1] ?? '', { round, ratio: wide ? 16 / 10 : 1, width: tileW }));
  const rail = mk({ width: 'fill', height: 'hug' }, flex('row', { align: 'start', gap: 12, pad: [0, side, 0, side] }), null, tiles, { id: `${p.id}:rail`, part: 'carousel-rail', quiet: true, owner: p.id, scroll: p.id });
  const head = sectionRow(k, p, side);
  return mk({ width: 'fill', height: 'hug' }, flex('col', { gap: 12 }), null, head === null ? [rail] : [head, rail], { id: p.id, part: 'carousel' });
}

// ------------------------------------------------------------------ segment: a header of choices

export function segmentOf(k: Kit, p: UiPartNode): N {
  const c = k.t.colour;
  const wire = k.t.wire;
  const options = p.fields.map(unstar);
  const starred = options.findIndex((o) => o.starred);
  const chosen = k.state.pick[p.id] ?? (starred >= 0 ? starred : 0);
  const tabs = p.flags.includes('tabs');
  const kids: N[] = options.map((o, i) => {
    const on = i === chosen;
    const id = `${p.id}:s${i}`;
    const action: UiAction = { kind: 'pick', control: p.id, index: i };
    if (tabs) {
      const ink = on ? (wire ? c.ink : c.accentInk) : c.dim;
      const label = text(k, o.text, { ...k.type.label, weight: on ? 'bold' : 'normal' }, { id: p.id, nowrap: true, squeeze: true, colour: ink, align: 'center', what: `option:${i}`, width: 'fill' });
      const paint = (b: Rect, out: Out): void => {
        if (on) rectOf(out, p.id, `under:${i}`, { x: b.x + 8, y: b.y + b.h - 3, w: Math.max(0, b.w - 16), h: 3 }, { radius: 2, fill: wire ? c.ink : c.accent });
      };
      return mk({ width: 'fill', height: 48, minW: 44 }, flex('row', { align: 'center', justify: 'center', pad: [0, 4, 0, 4] }), null, [label], { id, part: 'segment-tab', target: true, paint, action, owner: p.id });
    }
    const ink = on ? (wire ? c.onAccent : c.onAccent) : c.ink;
    const label = text(k, o.text, k.type.label, { id: p.id, nowrap: true, squeeze: true, colour: ink, align: 'center', what: `option:${i}` });
    const paint = (b: Rect, out: Out): void => {
      const h = 36;
      const pill = { x: b.x, y: b.y + (b.h - h) / 2, w: b.w, h };
      rectOf(out, p.id, `chip:${i}`, pill, { radius: Math.min(h / 2, Math.max(k.t.radius.m, 8)), fill: on ? (wire ? c.ink : c.accent) : wire ? c.surface : c.sunken, edge: on ? null : { colour: wire ? c.edge : c.line, width: 1 }, ...(pressed(k, id) ? { fillAlpha: 0.85 } : {}) });
    };
    return mk({ width: 'hug', height: 44, shrink: 0 }, flex('row', { align: 'center', justify: 'center', pad: [0, 16, 0, 16] }), null, [label], { id, part: 'segment-chip', target: true, paint, action, owner: p.id, hug: true });
  });
  if (tabs) {
    return mk({ width: 'fill', height: 48 }, flex('row', { align: 'stretch' }), null, kids, { id: p.id, part: 'segment', paint: (b, out) => rectOf(out, p.id, 'rule', b, { rule: 'bottom', edge: { colour: c.line, width: 1 } }) });
  }
  return mk({ width: 'fill', height: 'hug' }, flex('row', { align: 'center', gap: 8, wrap: true }), null, kids, { id: p.id, part: 'segment' });
}

// ------------------------------------------------------------------ stat: a number with its change

function numbersOf(words: string | undefined): number[] {
  return (words ?? '').split(/[,\s]+/).map(Number).filter((n) => Number.isFinite(n));
}

export function statOf(k: Kit, p: UiPartNode): N {
  const c = k.t.colour;
  const label = p.fields[0] ?? '';
  const value = p.fields[1] ?? '';
  const delta = p.fields[2] ?? '';
  const series = numbersOf(p.attrs['spark']);
  const down = p.flags.includes('down') || (!p.flags.includes('up') && /^[-−–]/.test(delta.trim()));
  const tone = k.t.wire ? c.ink : down ? c.danger : c.success;
  const kids: N[] = [];
  if (label !== '') kids.push(text(k, label, k.type.note, { id: p.id, colour: c.dim, what: 'label', maxLines: 1 }));
  if (value !== '') kids.push(text(k, value, { ...k.type.heading, size: Math.max(k.type.heading.size, 24), line: Math.max(k.type.heading.line, 32) }, { id: p.id, colour: c.ink, what: 'value' }));
  if (delta !== '') {
    kids.push(
      mk({ width: 'fill', height: 'hug' }, flex('row', { align: 'center', gap: 4 }), null, [icon(p.id, down ? 'trend-down' : 'trend-up', 16, tone, 2.25), text(k, delta, { ...k.type.note, weight: 'bold' }, { id: p.id, colour: tone, what: 'delta', grow: 1, maxLines: 2 })], { id: `${p.id}:delta`, part: 'stat-delta', quiet: true, owner: p.id }),
    );
  }
  if (series.length > 1) {
    kids.push(mk({ width: 'fill', height: 40 }, null, { fit: () => ({ w: 0, h: 40 }), minW: 0 }, [], { id: `${p.id}:spark`, part: 'spark', quiet: true, owner: p.id, paint: (b, out) => sparkline(out, p.id, series, { x: b.x, y: b.y + 4, w: b.w, h: b.h - 8 }, tone) }));
  }
  const paint = (b: Rect, out: Out): void => {
    const shadow = k.t.wire ? undefined : shadowOf(k, 'low');
    rectOf(out, p.id, 'card', b, { radius: k.t.radius.l, fill: c.surface, edge: { colour: k.t.wire ? c.edge : c.line, width: 1 }, ...(shadow === undefined ? {} : { shadow }) });
  };
  return mk({ width: 'fill', height: 'hug', minW: 0 }, flex('col', { gap: 4, pad: 16, align: 'stretch' }), null, kids, { id: p.id, part: 'stat', paint });
}

// ------------------------------------------------------------------ people: a list with avatars

export function peopleOf(k: Kit, p: UiPartNode): N {
  const c = k.t.colour;
  const rows = p.fields.map((field) => {
    const { text: body, starred } = unstar(field);
    const [name, sub, aside] = pieces(body);
    return { name: name ?? '', sub: sub ?? '', aside: aside ?? '', unread: starred };
  });
  const pad = 10 + packOf(k) * 2;
  const kids: N[] = rows.map((r, i) => {
    const id = `${p.id}:r${i}`;
    const face = mk({ width: 48, height: 48, shrink: 0 }, null, { fit: () => ({ w: 48, h: 48 }), minW: 48 }, [], {
      id: `${id}:face`,
      part: 'avatar',
      quiet: true,
      owner: p.id,
      paint: (b, out) => {
        if (k.t.wire) {
          rectOf(out, p.id, `avatar${i}`, b, { radius: 24, fill: c.sunken, edge: { colour: c.edge, width: 1 } });
          const letters = initialsOf(r.name);
          out.parts.push({ kind: 'text', key: out.key(p.id, `avatar${i}:initials`), owner: p.id, x: b.x, y: b.y + 12, w: b.w, h: 24, lines: [{ text: letters, width: k.measure.width(letters, 15, 'bold') }], size: 15, line: 24, weight: 'bold', colour: c.ink, align: 'center' });
        } else avatar(out, p.id, r.name, b, k.measure, `avatar${i}`);
      },
    });
    const words: N[] = [text(k, r.name, { ...k.type.label, weight: r.unread ? 'bold' : 'normal' }, { id: p.id, colour: c.ink, what: `name:${i}`, maxLines: 1, width: 'fill' })];
    if (r.sub !== '') words.push(text(k, r.sub, k.type.note, { id: p.id, colour: r.unread ? c.ink : c.dim, what: `sub:${i}`, maxLines: 1, width: 'fill' }));
    const middle = mk({ width: 'hug', height: 'hug', grow: 1, minW: 0 }, flex('col', { gap: 0, align: 'stretch' }), null, words, { id: `${id}:words`, part: 'people-words', quiet: true, owner: p.id });
    const row: N[] = [face, middle];
    if (r.aside !== '') row.push(text(k, r.aside, k.type.note, { id: p.id, nowrap: true, colour: r.unread ? c.accentInk : c.dim, what: `aside:${i}` }));
    if (r.unread) row.push(mk({ width: 10, height: 10, shrink: 0 }, null, { fit: () => ({ w: 10, h: 10 }), minW: 10 }, [], { id: `${id}:dot`, part: 'dot', quiet: true, owner: p.id, paint: (b, out) => rectOf(out, p.id, `dot${i}`, b, { radius: 5, fill: c.accent }) }));
    if (p.flags.includes('chevron')) row.push(icon(p.id, 'chevron-right', 20, c.faint));
    const last = i === rows.length - 1;
    const paint = (b: Rect, out: Out): void => {
      if (pressed(k, id)) rectOf(out, id, 'pressed', b, { fill: c.ink, fillAlpha: 0.07 });
      if (!last) rectOf(out, id, 'rule', { x: b.x + 60, y: b.y, w: b.w - 60, h: b.h }, { edge: { colour: c.line, width: 1 }, rule: 'bottom' });
    };
    const to = p.attrs['to'];
    return mk({ width: 'fill', height: 'hug', minH: 68 }, flex('row', { align: 'center', gap: 12, pad: [pad, 0, pad, 0] }), null, row, { id, part: 'person', paint, target: true, owner: p.id, action: goes(id, to) });
  });
  return mk({ width: 'fill', height: 'hug' }, flex('col', { gap: 0 }), null, kids, { id: p.id, part: 'people' });
}

// ------------------------------------------------------------------ chat: bubbles

type Message = { readonly kind: 'time'; readonly text: string } | { readonly kind: 'say'; readonly mine: boolean; readonly who: string; readonly text: string };

/** `Name: words` is received from Name; `me: words`, `you: words` or `> words` is sent; `~Today 9:41` is a time. */
export function messagesOf(fields: readonly string[]): Message[] {
  return fields
    .map((field): Message | null => {
      const t = field.trim();
      if (t === '') return null;
      if (t.startsWith('~')) return { kind: 'time', text: t.slice(1).trim() };
      const mine = /^(?:me|you|>)\s*:?\s*(.+)$/i.exec(t);
      if (mine?.[1] !== undefined && (t.startsWith('>') || /^(?:me|you)\s*:/i.test(t))) return { kind: 'say', mine: true, who: '', text: mine[1] };
      const theirs = /^([^:]{1,24}):\s+(.+)$/.exec(t);
      if (theirs?.[1] !== undefined && theirs[2] !== undefined) return { kind: 'say', mine: false, who: theirs[1].trim(), text: theirs[2] };
      return { kind: 'say', mine: false, who: '', text: t };
    })
    .filter((m): m is Message => m !== null);
}

export function chatOf(k: Kit, p: UiPartNode): N {
  const c = k.t.colour;
  const wire = k.t.wire;
  const all = messagesOf(p.fields);
  const people = new Set(all.flatMap((m) => (m.kind === 'say' && !m.mine && m.who !== '' ? [m.who] : [])));
  const group = people.size > 1;
  const room = UI_DEVICE_SIZE[k.device].width - gutterOf(k) * 2;
  const most = Math.min(desk(k) ? 520 : 400, Math.floor(room * 0.8));
  const R = Math.max(8, k.t.radius.l + 2);
  const rows: N[] = [];
  all.forEach((m, i) => {
    if (m.kind === 'time') {
      rows.push(text(k, m.text, k.type.note, { id: p.id, colour: c.dim, align: 'center', what: `time:${i}`, width: 'fill' }));
      return;
    }
    const next = all[i + 1];
    const prev = all[i - 1];
    const sameNext = next?.kind === 'say' && next.mine === m.mine && next.who === m.who;
    const samePrev = prev?.kind === 'say' && prev.mine === m.mine && prev.who === m.who;
    const id = `${p.id}:m${i}`;
    const dots = m.text === '...' || m.text === '…';
    const ink = m.mine ? c.onAccent : c.ink;
    const fill = m.mine ? (wire ? c.ink : c.accent) : wire ? c.surface : c.sunken;
    // the corner the bubble's tail would be on is squared: the last of a run has a tail, the ones before it join
    const small = Math.min(6, R);
    const paint = (b: Rect, out: Out): void => {
      const last = !sameNext;
      const corners: [number, number, number, number] = m.mine ? [R, samePrev ? small : R, last ? 3 : small, R] : [samePrev ? small : R, R, R, last ? 3 : small];
      const outline = roundedPoly(b, corners);
      const path: UiPath = { kind: 'path', key: out.key(p.id, `bubble:${i}`), owner: p.id, outline: [{ closed: true, points: outline }], fill, stroke: wire ? { colour: c.edge, width: 1 } : null };
      out.parts.push(path);
      if (dots) {
        for (let d = 0; d < 3; d += 1) rectOf(out, p.id, `dot:${i}:${d}`, { x: b.x + b.w / 2 - 14 + d * 12, y: b.y + b.h / 2 - 3, w: 6, h: 6 }, { radius: 3, fill: c.dim, fillAlpha: 0.5 + d * 0.2 });
      }
    };
    const body = dots
      ? mk({ width: 16, height: 20, shrink: 0 }, null, { fit: () => ({ w: 16, h: 20 }), minW: 16 }, [], { id: `${id}:wait`, part: 'dots', quiet: true, owner: p.id })
      : text(k, m.text, k.type.body, { id: p.id, colour: ink, what: `msg:${i}` });
    const bubble = mk({ width: 'hug', height: 'hug', maxW: most }, flex('row', { align: 'center', pad: [8, 14, 8, 14] }), null, [body], { id, part: 'bubble', quiet: true, owner: p.id, paint });
    const stack: N[] = [];
    if (group && !m.mine && !samePrev && m.who !== '') stack.push(text(k, m.who, { ...k.type.note, weight: 'bold' }, { id: p.id, colour: c.dim, what: `who:${i}`, nowrap: true }));
    stack.push(bubble);
    const column = mk({ width: 'hug', height: 'hug', shrink: 1 }, flex('col', { gap: 2, align: m.mine ? 'end' : 'start' }), null, stack, { id: `${id}:col`, part: 'bubble-col', quiet: true, owner: p.id });
    const line: N[] = [];
    if (group && !m.mine) {
      line.push(
        mk({ width: 32, height: 32, shrink: 0 }, null, { fit: () => ({ w: 32, h: 32 }), minW: 32 }, [], {
          id: `${id}:face`,
          part: 'avatar',
          quiet: true,
          owner: p.id,
          paint: sameNext ? undefined : (b, out) => avatar(out, p.id, m.who, b, k.measure, `face${i}`),
        }),
      );
    }
    line.push(column);
    rows.push(mk({ width: 'fill', height: 'hug', ...(sameNext ? {} : { minH: 0 }) }, flex('row', { align: group && !m.mine ? 'end' : 'start', justify: m.mine ? 'end' : 'start', gap: 8 }), null, line, { id: `${id}:line`, part: 'chat-line', quiet: true, owner: p.id }));
    // a run of one voice is close; a change of voice has room
    if (!sameNext && next !== undefined) rows.push(mk({ width: 0, height: 8, shrink: 0 }, null, { fit: () => ({ w: 0, h: 8 }), minW: 0 }, [], { id: `${id}:break`, part: 'space', quiet: true }));
  });
  return mk({ width: 'fill', height: 'hug' }, flex('col', { gap: 2 }), null, rows, { id: p.id, part: 'chat' });
}

// ------------------------------------------------------------------ map: a placeholder that is drawn like a map

export function mapOf(k: Kit, p: UiPartNode): N {
  const c = k.t.colour;
  const title = p.fields[0] ?? '';
  const sub = p.fields[1] ?? '';
  const tall = p.flags.includes('tall');
  const pins = Math.max(1, Math.min(6, Number(p.attrs['pins']) || 3));
  const cap = px4(UI_DEVICE_SIZE[k.device].height * (tall ? 0.6 : 0.4));
  const dark = isDark(c.screen);
  const fit = (w: number): { w: number; h: number } => {
    const width = Number.isFinite(w) ? w : 280;
    return { w: width, h: Math.min(cap, px4(width * (tall ? 1.05 : 0.62))) };
  };
  const paint = (b: Rect, out: Out): void => {
    const r = k.t.radius.l;
    mapArt(out, p.id, `${title}|${sub}`, b, [r, r, r, r], { dark, accent: k.t.wire ? c.ink : c.accent, pins, route: p.flags.includes('route'), pinEye: k.t.wire ? c.surface : c.onAccent });
    rectOf(out, p.id, 'edge', b, { radius: r, fill: null, edge: { colour: k.t.wire ? c.edge : c.line, width: 1 } });
    if (title === '') return;
    // the card at the foot: where, and how far
    const inset = 10;
    const hasSub = sub !== '';
    const cardH = hasSub ? k.type.label.line + k.type.note.line + 16 : k.type.label.line + 16;
    const card = { x: b.x + inset, y: b.y + b.h - inset - cardH, w: b.w - inset * 2, h: cardH };
    const shadow = k.t.wire ? undefined : shadowOf(k, 'high');
    rectOf(out, p.id, 'card', card, { radius: Math.max(6, r - 4), fill: c.surface, edge: { colour: k.t.wire ? c.edge : c.line, width: 1 }, ...(shadow === undefined ? {} : { shadow }) });
    const room = Math.max(8, card.w - 24 - 28);
    const words = (what: string, value: string, token: typeof k.type.label, colour: string, y: number): void => {
      const lines = k.measure.wrap(value, token.size, token.weight, room, token.face ?? 'sans').lines.slice(0, 1);
      out.parts.push({ kind: 'text', key: out.key(p.id, what), owner: p.id, x: card.x + 12, y, w: room, h: token.line, lines, size: token.size, line: token.line, weight: token.weight, colour, align: 'left', ...(token.face === undefined || token.face === 'sans' ? {} : { face: token.face }) });
    };
    words('title', title, k.type.label, c.ink, card.y + 8);
    if (hasSub) words('sub', sub, k.type.note, c.dim, card.y + 8 + k.type.label.line);
    out.parts.push({ kind: 'path', key: out.key(p.id, 'go'), owner: p.id, outline: placeChevron(card.x + card.w - 30, card.y + card.h / 2 - 9, 18), fill: null, stroke: { colour: c.accentInk, width: 2 } });
  };
  return mk({ width: 'fill', height: 'hug', minH: 160 }, null, { fit, minW: 0 }, [], { id: p.id, part: 'map', paint });
}

function placeChevron(x: number, y: number, size: number): { closed: boolean; points: Pt[] }[] {
  return [{ closed: false, points: [{ x: x + size * 0.3, y: y + size * 0.15 }, { x: x + size * 0.7, y: y + size * 0.5 }, { x: x + size * 0.3, y: y + size * 0.85 }] }];
}

// ------------------------------------------------------------------ player: art, title, play, progress

function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** `3:48` or `228` as seconds. */
export function lengthOf(words: string | undefined): number {
  const w = (words ?? '').trim();
  const m = /^(\d+):(\d{1,2})$/.exec(w);
  if (m !== null) return Number(m[1]) * 60 + Number(m[2]);
  const n = Number(w);
  return Number.isFinite(n) && n > 0 ? n : 200;
}

/** Where a player is, 0 to 1: what the finger left, or what it was given (`progress=0.4` or `40`). */
export function playerPosition(k: { readonly state: Kit['state'] }, p: UiPartNode): number {
  const held = k.state.slider[`${p.id}:seek`];
  if (held !== undefined) return Math.max(0, Math.min(1, held));
  const given = Number(p.attrs['progress']);
  return Number.isFinite(given) ? Math.max(0, Math.min(1, given > 1 ? given / 100 : given)) : 0.32;
}

function scrubOf(k: Kit, p: UiPartNode, v: number, o: { readonly knob: boolean; readonly height: number }): N {
  const c = k.t.colour;
  const id = `${p.id}:seek`;
  const paint = (b: Rect, out: Out): void => {
    const x0 = b.x + 12;
    const x1 = b.x + b.w - 12;
    const y = b.y + b.h / 2 - 2;
    rectOf(out, p.id, 'rail', { x: x0, y, w: Math.max(0, x1 - x0), h: 4 }, { radius: 2, fill: c.line });
    const at = x0 + (x1 - x0) * v;
    rectOf(out, p.id, 'fill', { x: x0, y, w: Math.max(0, at - x0), h: 4 }, { radius: 2, fill: k.t.wire ? c.ink : c.accent });
    if (o.knob) rectOf(out, p.id, 'knob', { x: at - 8, y: b.y + b.h / 2 - 8, w: 16, h: 16 }, { radius: 8, fill: k.t.wire ? c.surface : '#ffffff', edge: k.t.wire ? { colour: c.edge, width: 2 } : null, ...(k.t.wire ? {} : { shadow: { colour: c.shadow, dy: 1, blur: 3, alpha: 0.3 } }) });
  };
  return mk({ width: 'fill', height: o.height }, null, { fit: () => ({ w: 0, h: o.height }), minW: 0 }, [], { id, part: 'scrub', quiet: true, owner: p.id, paint, action: { kind: 'slider', control: id, from: 0, to: 1 } });
}

export function playerOf(k: Kit, p: UiPartNode): N {
  const c = k.t.colour;
  const [title = 'Untitled', artist = ''] = pieces(p.fields[0]);
  const artistWords = p.fields[1] ?? artist;
  const playing = k.state.toggle[p.id] ?? p.flags.includes('playing');
  const v = playerPosition(k, p);
  const len = lengthOf(p.attrs['len']);
  const playId = `${p.id}:play`;
  const playAction: UiAction = { kind: 'flip', control: p.id, on: playing };
  const ink = c.ink;
  if (p.flags.includes('large')) {
    const cap = px4(UI_DEVICE_SIZE[k.device].height * 0.42);
    const art = pictureLeaf(`${p.id}:art`, 'cover', 1, cap, (b, out) => placeholder(k, out, p.id, title, b, k.t.radius.l, 'art'));
    const heart = k.state.toggle[`${p.id}:heart`] ?? false;
    const head = mk(
      { width: 'fill', height: 'hug' },
      flex('row', { align: 'center', gap: 8 }),
      null,
      [
        mk({ width: 'hug', height: 'hug', grow: 1, minW: 0 }, flex('col', { gap: 0 }), null, [text(k, title, k.type.heading, { id: p.id, colour: ink, what: 'title', maxLines: 2 }), ...(artistWords === '' ? [] : [text(k, artistWords, k.type.body, { id: p.id, colour: c.dim, what: 'artist', maxLines: 1 })])], { id: `${p.id}:words`, part: 'player-words', quiet: true, owner: p.id }),
        iconButton(k, `${p.id}:heart`, 'heart', 24, heart ? (k.t.wire ? c.ink : c.accentInk) : c.dim, { kind: 'flip', control: `${p.id}:heart`, on: heart }, { filled: heart, part: 'heart' }),
      ],
      { id: `${p.id}:head`, part: 'player-head', quiet: true, owner: p.id },
    );
    const times = mk({ width: 'fill', height: 'hug' }, flex('row', { justify: 'between', align: 'center', pad: [0, 4, 0, 4] }), null, [text(k, clock(v * len), k.type.caption, { id: p.id, nowrap: true, colour: c.dim, what: 'elapsed' }), text(k, `-${clock((1 - v) * len)}`, k.type.caption, { id: p.id, nowrap: true, colour: c.dim, what: 'left' })], { id: `${p.id}:times`, part: 'player-times', quiet: true, owner: p.id });
    const scrub = mk({ width: 'fill', height: 'hug' }, flex('col', { gap: 0 }), null, [scrubOf(k, p, v, { knob: true, height: 28 }), times], { id: `${p.id}:scrub`, part: 'player-scrub', quiet: true, owner: p.id });
    const toggle = (name: string, icon_: string, on: boolean): N => iconButton(k, `${p.id}:${name}`, icon_, 24, on ? (k.t.wire ? c.ink : c.accentInk) : c.dim, { kind: 'flip', control: `${p.id}:${name}`, on }, { part: name });
    const big = iconButton(k, playId, playing ? 'pause' : 'play', 28, k.t.wire ? c.onAccent : c.onAccent, playAction, { box: 64, fill: k.t.wire ? c.ink : c.accent, filled: true, part: 'play' });
    const transport = mk(
      { width: 'fill', height: 'hug' },
      flex('row', { align: 'center', justify: 'between', pad: [0, 4, 0, 4] }),
      null,
      [
        toggle('shuffle', 'shuffle', k.state.toggle[`${p.id}:shuffle`] ?? false),
        iconButton(k, `${p.id}:prev`, 'skip-back', 28, ink, goes(`${p.id}:prev`, undefined), { filled: true, part: 'prev' }),
        big,
        iconButton(k, `${p.id}:next`, 'skip-forward', 28, ink, goes(`${p.id}:next`, undefined), { filled: true, part: 'next' }),
        toggle('repeat', 'repeat', k.state.toggle[`${p.id}:repeat`] ?? false),
      ],
      { id: `${p.id}:transport`, part: 'player-transport', quiet: true, owner: p.id },
    );
    return mk({ width: 'fill', height: 'hug' }, flex('col', { gap: 12 + packOf(k) * 4, align: 'stretch' }), null, [art, head, scrub, transport], { id: p.id, part: 'player' });
  }
  // the bar: art, title and artist, a play button, and the line under them
  const art = mk({ width: 48, height: 48, shrink: 0 }, null, { fit: () => ({ w: 48, h: 48 }), minW: 48 }, [], { id: `${p.id}:art`, part: 'cover', quiet: true, owner: p.id, paint: (b, out) => placeholder(k, out, p.id, title, b, k.t.radius.s + 2, 'art') });
  const words = mk({ width: 'hug', height: 'hug', grow: 1, minW: 0 }, flex('col', { gap: 0 }), null, [text(k, title, k.type.label, { id: p.id, colour: ink, what: 'title', maxLines: 1 }), ...(artistWords === '' ? [] : [text(k, artistWords, k.type.note, { id: p.id, colour: c.dim, what: 'artist', maxLines: 1 })])], { id: `${p.id}:words`, part: 'player-words', quiet: true, owner: p.id });
  const to = p.attrs['to'];
  const body = mk({ width: 'hug', height: 'hug', grow: 1, minW: 0 }, flex('row', { align: 'center', gap: 12 }), null, [art, words], { id: `${p.id}:body`, part: 'player-body', quiet: true, owner: p.id, ...(to === undefined ? {} : { target: true, action: goes(`${p.id}:body`, to) }) });
  const play = iconButton(k, playId, playing ? 'pause' : 'play', 24, ink, playAction, { filled: true, part: 'play' });
  const top = mk({ width: 'fill', height: 'hug' }, flex('row', { align: 'center', gap: 4 }), null, [body, play], { id: `${p.id}:top`, part: 'player-top', quiet: true, owner: p.id });
  const paint = (b: Rect, out: Out): void => {
    const shadow = k.t.wire ? undefined : shadowOf(k, 'high');
    rectOf(out, p.id, 'bar', b, { radius: k.t.radius.l, fill: k.t.wire ? c.surface : c.sunken, edge: { colour: k.t.wire ? c.edge : c.line, width: 1 }, ...(shadow === undefined ? {} : { shadow }) });
  };
  return mk({ width: 'fill', height: 'hug' }, flex('col', { gap: 0, pad: [8, 8, 0, 12], align: 'stretch' }), null, [top, scrubOf(k, p, v, { knob: false, height: 16 })], { id: p.id, part: 'player', paint });
}

// ------------------------------------------------------------------ the table

/** The part of `p` the kit knows, or null when it is one of the plain parts. */
export function richOf(k: Kit, p: UiPartNode, _ctx: Ctx): N | null {
  switch (p.kind) {
    case 'media':
      return mediaOf(k, p);
    case 'carousel':
      return carouselOf(k, p);
    case 'player':
      return playerOf(k, p);
    case 'chat':
      return chatOf(k, p);
    case 'map':
      return mapOf(k, p);
    case 'stat':
      return statOf(k, p);
    case 'people':
      return peopleOf(k, p);
    case 'segment':
      return segmentOf(k, p);
    default:
      return null;
  }
}
