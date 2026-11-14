// The kit (PLAN-v2.2 E13): each part of a screen as a small tree of boxes for the solver, and the shapes and words it is
// drawn as. A part is one line of the brain's text; here it becomes a component that OWNS ITS WORDS: a button is a box
// with its label set inside it by construction, so none of the rules for loose text (keep words apart, keep them readable
// against what is behind them) apply to it, and a label can never leave its button.
//
// Pure: no DOM, no clock. Text is sized through the measurer it is handed; colours, radii, type and shadows come from the
// look's tokens; the live parts read a `UiState`. The same lines serve both looks. The helpers every part is made of are in
// kit-base.ts; the richer parts (a media grid, a carousel, a player bar, chat, a map, a stat, a list with avatars, a segmented
// header) are in rich.ts.

import type { UiContainer, UiPartNode, UiScreen } from './lang';
import { UI_DEVICE_SIZE, UI_SPACE, isUiContainer, unstar } from './lang';
import { flex, gapOf, gutterOf, icon, mk, packOf, px4, rectOf, shadowOf, text } from './kit-base';
import type { Ctx, Item, Kit, N, Out, Rect } from './kit-base';
import { clipPoly, coverArt, roundedPoly } from './art';
import { richOf } from './rich';
import type { Style } from './solve';
import type { Align } from './solve';
import type { UiPress, UiRect, UiShadow } from './types';

export { makeKit } from './kit-base';
export type { Item, Kit, N, Out, Rect } from './kit-base';

function colourOf(k: Kit, role: 'ink' | 'dim' | 'faint' | 'accent'): string {
  return k.t.colour[role];
}

function headingOf(k: Kit, p: UiPartNode, c: Ctx): N {
  const large = p.flags.includes('large') || p.flags.includes('display');
  const small = p.flags.includes('small');
  const desk = k.device === 'desktop' || k.device === 'browser';
  const role = p.flags.includes('display') ? (desk ? 'hero' : 'display') : large ? 'display' : small ? 'title' : desk ? 'display' : 'heading';
  const align = p.flags.includes('center') || c.align === 'center' ? 'center' : 'left';
  const n = text(k, p.fields[0] ?? '', k.type[role], { id: p.id, colour: colourOf(k, 'ink'), align, what: 'heading' });
  return { ...n, payload: { ...n.payload, part: 'heading', quiet: false } };
}

function textOf(k: Kit, p: UiPartNode, c: Ctx): N {
  const token = p.flags.includes('small') ? k.type.note : p.flags.includes('large') ? { ...k.type.title, weight: 'normal' as const } : p.flags.includes('bold') ? { ...k.type.body, weight: 'bold' as const } : k.type.body;
  const align = p.flags.includes('center') || c.align === 'center' ? 'center' : 'left';
  const n = text(k, p.fields[0] ?? '', token, { id: p.id, colour: colourOf(k, p.flags.includes('dim') ? 'dim' : 'ink'), align, what: 'text' });
  return { ...n, payload: { ...n.payload, part: 'text', quiet: false } };
}

function noteOf(k: Kit, p: UiPartNode, c: Ctx): N {
  const align = p.flags.includes('center') || c.align === 'center' ? 'center' : 'left';
  const n = text(k, p.fields[0] ?? '', k.type.note, { id: p.id, colour: colourOf(k, 'dim'), align, what: 'note' });
  return { ...n, payload: { ...n.payload, part: 'note', quiet: false } };
}

function buttonOf(k: Kit, p: UiPartNode): N {
  const wide = p.flags.includes('wide');
  const variant = p.flags.includes('primary') ? 'primary' : p.flags.includes('danger') ? 'danger' : p.flags.includes('ghost') ? 'ghost' : 'plain';
  const disabled = p.flags.includes('disabled');
  const c = k.t.colour;
  const wire = k.t.wire;
  const pressed = k.state.pressed === p.id;
  const label = p.fields[0] ?? 'Button';
  let ink = c.ink;
  if (variant === 'primary') ink = c.onAccent;
  else if (variant === 'danger') ink = wire ? c.ink : c.onAccent;
  else if (variant === 'ghost') ink = wire ? c.ink : c.accentInk;
  if (disabled) ink = c.faint;
  const height = p.flags.includes('small') ? 44 : 48 + packOf(k) * 4;
  const radius = k.t.radius.m;
  const paint = (b: Rect, out: Out): void => {
    let fill: UiRect['fill'] = null;
    let edge: UiRect['edge'] = null;
    let shadow: UiShadow | undefined;
    if (disabled) {
      fill = c.sunken;
    } else if (variant === 'primary') {
      fill = c.accent;
      if (!wire) shadow = shadowOf(k, 'low');
    } else if (variant === 'danger') {
      fill = wire ? c.sunken : c.danger;
      if (wire) edge = { colour: c.edge, width: 1 };
    } else if (variant === 'ghost') {
      if (wire) edge = { colour: c.edge, width: 1, dash: [4, 3] };
      else fill = c.accentWash;
    } else {
      fill = c.surface;
      edge = { colour: c.edge, width: 1 };
    }
    rectOf(out, p.id, 'button', b, { radius, fill, ...(pressed ? { fillAlpha: 0.82 } : {}), edge, ...(shadow === undefined ? {} : { shadow }) });
  };
  const labelNode = text(k, label, k.type.label, { id: p.id, nowrap: true, colour: ink, align: 'center', what: 'label', ...(k.t.rowFit === 3 ? { ellipsis: true } : {}) });
  const style: Style = wide ? { width: 'fill', height } : { width: 'hug', height };
  return mk(style, flex('row', { align: 'center', justify: 'center', pad: [0, 20, 0, 20] }), null, [labelNode], { id: p.id, part: 'button', hug: !wide, target: true, paint, action: pressOf(p) });
}

/**
 * A press: where it goes (`to=<screen>`), when it goes anywhere, and whether the brain hears it. A `button` with nowhere to go is sent (there is nothing
 * else for it to do); one that goes to a screen is a prototype's own step and stays here unless it says `send`. `label` is what it says, for the turn.
 */
function pressOf(p: UiPartNode): UiPress {
  const to = p.attrs['to'];
  const goes = to !== undefined && to !== '';
  const label = (p.fields[0] ?? '').trim();
  const send = p.kind === 'button' && !p.flags.includes('disabled') && (p.flags.includes('send') || !goes);
  return { kind: 'press', control: p.id, ...(goes ? { to } : {}), ...(send ? { send: true, label: label === '' ? 'Button' : label } : {}) };
}

function fieldOf(k: Kit, p: UiPartNode, labelled: boolean): N {
  const c = k.t.colour;
  const label = labelled ? (p.fields[0] ?? '') : '';
  const given = labelled ? (p.fields[1] ?? '') : (p.fields[0] ?? '');
  const message = labelled ? p.fields[2] : p.fields[1];
  const error = p.flags.includes('error');
  const typed = k.state.text[p.id];
  const focused = k.state.focus === p.id;
  // a password field shows dots for what is typed; what it is given as a hint is shown as written
  const password = p.flags.includes('password');
  const shown = typed === undefined ? given : password ? '\u2022'.repeat(typed.length) : typed;
  const isPlaceholder = typed === undefined && /^(e\.g\.|eg |name@|you@|search|enter |type )/i.test(given);
  const valueInk = typed !== undefined ? c.ink : isPlaceholder ? c.faint : c.dim;
  const box = k.t.radius.m;
  const paint = (b: Rect, out: Out): void => {
    rectOf(out, p.id, 'field', b, { radius: box, fill: c.surface, edge: { colour: error ? (k.t.wire ? c.ink : c.danger) : focused ? c.accent : c.edge, width: focused || error ? 2 : 1 } });
    if (focused) {
      const w = typed === undefined ? 0 : k.measure.width(shown, k.type.body.size, 'normal');
      out.parts.push({ kind: 'rect', key: out.key(p.id, 'caret'), owner: p.id, x: b.x + 12 + w + 1, y: b.y + (b.h - 20) / 2, w: 1.5, h: 20, radius: 0, fill: c.accent, edge: null });
    }
  };
  const value = text(k, shown === '' ? ' ' : shown, k.type.body, { id: p.id, nowrap: true, ellipsis: true, colour: valueInk, what: 'value', grow: 1 });
  const input = mk({ width: 'fill', height: 48 }, flex('row', { align: 'center', pad: [0, 12, 0, 12] }), null, [value], { id: `${p.id}:input`, part: 'field-input', target: true, paint, action: { kind: 'field', control: p.id, value: shown }, owner: p.id });
  const kids: N[] = [];
  if (label !== '') kids.push(text(k, label, { ...k.type.note, weight: 'bold' }, { id: p.id, nowrap: true, squeeze: true, colour: c.ink, what: 'label' }));
  kids.push(input);
  if (message !== undefined && message !== '') kids.push(text(k, message, k.type.note, { id: p.id, colour: k.t.wire ? c.ink : c.danger, what: 'message' }));
  return mk({ width: 'fill', height: 'hug' }, flex('col', { gap: 4 }), null, kids, { id: p.id, part: labelled ? 'field' : 'input' });
}

function itemOf(k: Kit, p: UiPartNode): N {
  const c = k.t.colour;
  const wire = k.t.wire;
  const [title0, sub] = [p.fields[0] ?? '', p.fields[1]];
  const { text: title, starred } = unstar(title0);
  const selected = starred || p.flags.includes('selected');
  const iconName = p.attrs['icon'];
  const value = p.attrs['value'];
  const toggled = p.flags.includes('toggle') ? (k.state.toggle[p.id] ?? p.flags.includes('on')) : null;
  const kids: N[] = [];
  if (iconName !== undefined) kids.push(icon(p.id, iconName, 24, selected || !wire ? c.accentInk : c.ink));
  const words: N[] = [text(k, title, k.type.label, { id: p.id, colour: c.ink, what: 'title' })];
  if (sub !== undefined && sub !== '') words.push(text(k, sub, k.type.note, { id: p.id, colour: c.dim, what: 'subtitle' }));
  kids.push(mk({ width: 'hug', height: 'hug', grow: 1, minW: 0 }, flex('col', { gap: 0 }), null, words, { id: `${p.id}:words`, part: 'item-words', quiet: true, owner: p.id }));
  if (value !== undefined) kids.push(text(k, value, k.type.body, { id: p.id, nowrap: true, colour: c.dim, what: 'value' }));
  if (p.flags.includes('chevron')) kids.push(icon(p.id, 'chevron-right', 20, c.faint));
  if (toggled !== null) kids.push(switchOf(k, p.id, toggled));
  const radius = wire ? k.t.radius.s : k.t.radius.m;
  const pressed = k.state.pressed === p.id;
  const paint = (b: Rect, out: Out): void => {
    if (wire) {
      rectOf(out, p.id, 'item', b, { radius: selected ? radius : 0, fill: null, edge: selected ? { colour: c.edge, width: 2 } : null });
      if (!selected) rectOf(out, p.id, 'rule', b, { edge: { colour: c.line, width: 1 }, rule: 'bottom' });
    } else {
      const shadow = shadowOf(k, 'low');
      rectOf(out, p.id, 'item', b, { radius, fill: c.surface, edge: { colour: selected ? c.accent : c.line, width: selected ? 2 : 1 }, ...(shadow === undefined ? {} : { shadow }) });
    }
    if (pressed) rectOf(out, p.id, 'pressed', b, { radius: wire ? 0 : radius, fill: c.ink, fillAlpha: 0.07 });
  };
  const vert = 12 + packOf(k) * 4;
  const pad: [number, number, number, number] = wire ? [vert, selected ? 12 : 0, vert, selected ? 12 : 0] : [vert, 16, vert, 16];
  return mk({ width: 'fill', height: 'hug', minH: 64 + packOf(k) * 8 }, flex('row', { align: 'center', gap: 12, pad }), null, kids, { id: p.id, part: 'item', target: true, paint, action: toggled === null ? pressOf(p) : { kind: 'toggle', control: p.id, on: toggled } });
}

/** The two ends of a switch's knob: its centre when off and when on, in points from the switch's left edge. Pointing reads the same numbers. */
export const SWITCH = { w: 52, h: 32, off: 16, on: 36 } as const;

function mixHex(a: string, b: string, t: number): string {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const pa = /^#([0-9a-f]{6})$/i.exec(a);
  const pb = /^#([0-9a-f]{6})$/i.exec(b);
  if (pa === null || pb === null) return t < 0.5 ? a : b;
  const n = (hex: string, shift: number): number => (parseInt(hex, 16) >> shift) & 255;
  const ch = (shift: number): string => Math.round(n(pa[1] as string, shift) + (n(pb[1] as string, shift) - n(pa[1] as string, shift)) * t).toString(16).padStart(2, '0');
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}

function switchOf(k: Kit, id: string, on: boolean): N {
  const c = k.t.colour;
  const wire = k.t.wire;
  // a finger (or an ease after it) holds the knob between the ends; otherwise it is at the end `on` says
  const held = k.state.thumb?.[id];
  const t = held === undefined ? (on ? 1 : 0) : Math.max(0, Math.min(1, held));
  const paint = (b: Rect, out: Out): void => {
    const track: Rect = { x: b.x, y: b.y + (b.h - SWITCH.h) / 2, w: SWITCH.w, h: SWITCH.h };
    const offFill = wire ? c.surface : c.sunken;
    const onFill = wire ? c.ink : c.success;
    rectOf(out, id, 'switch', track, { radius: 16, fill: mixHex(offFill, onFill, t), edge: wire ? { colour: c.edge, width: 1 } : null });
    const r = 12;
    const cx = track.x + SWITCH.off + (SWITCH.on - SWITCH.off) * t;
    const cy = track.y + 16;
    const knob: Rect = { x: cx - r, y: cy - r, w: r * 2, h: r * 2 };
    rectOf(out, id, 'knob', knob, { radius: r, fill: wire ? mixHex(c.ink, '#ffffff', t) : '#ffffff', ...(wire ? {} : { shadow: { colour: c.shadow, dy: 1, blur: 3, alpha: 0.25 } }) });
  };
  return mk({ width: 52, height: 44, shrink: 0 }, null, { fit: () => ({ w: 52, h: 44 }), minW: 52 }, [], { id, part: 'switch', quiet: true, paint, owner: id, action: { kind: 'toggle', control: id, on } });
}

function toggleOf(k: Kit, p: UiPartNode): N {
  const on = k.state.toggle[p.id] ?? p.flags.includes('on');
  const label = text(k, p.fields[0] ?? '', k.type.body, { id: p.id, colour: k.t.colour.ink, what: 'label', grow: 1 });
  return mk({ width: 'fill', height: 'hug', minH: 48 }, flex('row', { align: 'center', gap: 12 }), null, [{ ...label, style: { ...label.style, minW: 0 } }, switchOf(k, p.id, on)], { id: p.id, part: 'toggle', target: true, action: { kind: 'toggle', control: p.id, on } });
}

function pickOf(k: Kit, p: UiPartNode): N {
  const c = k.t.colour;
  const wire = k.t.wire;
  const label = p.fields[0] ?? '';
  const options = p.fields.slice(1).map(unstar);
  const starred = options.findIndex((o) => o.starred);
  const chosen = k.state.pick[p.id] ?? (starred >= 0 ? starred : Math.floor((options.length - 1) / 2));
  const segs: N[] = options.map((o, i) => {
    const on = i === chosen;
    const paint = (b: Rect, out: Out): void => {
      if (on) rectOf(out, p.id, `seg:${i}`, b, { radius: k.t.radius.s, fill: wire ? c.ink : c.surface, ...(wire ? {} : { shadow: shadowOf(k, 'low') }) });
    };
    // an option that does not fit on one line takes a second (and a third): the track grows, no word is cut or crosses its neighbour
    const word = text(k, o.text, k.type.label, { id: p.id, colour: on && wire ? c.onAccent : on ? c.ink : c.dim, align: 'center', what: `option:${i}`, width: 'fill' });
    return mk({ width: 'fill', height: 'hug', minH: 44 }, flex('row', { align: 'center', justify: 'center', pad: [10, 6, 10, 6] }), null, [word], { id: `${p.id}:seg${i}`, part: 'pick-option', target: true, paint, action: { kind: 'pick', control: p.id, index: i }, owner: p.id });
  });
  const track = mk({ width: 'fill', height: 'hug', minH: 52 }, flex('row', { align: 'stretch', gap: 0, pad: 4 }), null, segs, {
    id: `${p.id}:track`,
    part: 'pick-track',
    quiet: true,
    owner: p.id,
    paint: (b, out) => rectOf(out, p.id, 'track', b, { radius: k.t.radius.m, fill: wire ? c.surface : c.sunken, edge: wire ? { colour: c.edge, width: 1 } : null }),
  });
  const kids: N[] = [];
  if (label !== '') kids.push(text(k, label, { ...k.type.note, weight: 'bold' }, { id: p.id, nowrap: true, squeeze: true, colour: c.ink, what: 'label' }));
  kids.push(track);
  return mk({ width: 'fill', height: 'hug' }, flex('col', { gap: 4 }), null, kids, { id: p.id, part: 'pick' });
}

function sliderOf(k: Kit, p: UiPartNode): N {
  const c = k.t.colour;
  const label = p.fields[0] ?? '';
  const raw = k.state.slider[p.id] ?? (Number(p.fields[1]) >= 0 && p.fields[1] !== undefined && p.fields[1] !== '' ? Number(p.fields[1]) / (Number(p.fields[1]) > 1 ? 100 : 1) : 0.5);
  const v = Math.max(0, Math.min(1, raw));
  const track = mk({ width: 'fill', height: 32 }, null, { fit: () => ({ w: 120, h: 32 }), minW: 0 }, [], {
    id: `${p.id}:track`,
    part: 'slider-track',
    target: true,
    quiet: true,
    owner: p.id,
    paint: (b, out) => {
      const y = b.y + 14;
      rectOf(out, p.id, 'rail', { x: b.x, y, w: b.w, h: 4 }, { radius: 2, fill: c.line });
      rectOf(out, p.id, 'fill', { x: b.x, y, w: b.w * v, h: 4 }, { radius: 2, fill: c.accent });
      const cx = b.x + 12 + (b.w - 24) * v;
      rectOf(out, p.id, 'knob', { x: cx - 12, y: b.y + 4, w: 24, h: 24 }, { radius: 12, fill: k.t.wire ? c.surface : '#ffffff', edge: { colour: k.t.wire ? c.edge : c.line, width: k.t.wire ? 2 : 1 }, ...(k.t.wire ? {} : { shadow: { colour: c.shadow, dy: 1, blur: 3, alpha: 0.25 } }) });
    },
    action: { kind: 'slider', control: p.id, from: 0, to: 1 },
  });
  const head = mk({ width: 'fill', height: 'hug' }, flex('row', { justify: 'between', align: 'center' }), null, [text(k, label, { ...k.type.note, weight: 'bold' }, { id: p.id, nowrap: true, colour: c.ink, what: 'label' }), text(k, `${Math.round(v * 100)}%`, k.type.note, { id: p.id, nowrap: true, colour: c.dim, what: 'value' })], { id: `${p.id}:head`, part: 'slider-head', quiet: true, owner: p.id });
  return mk({ width: 'fill', height: 'hug' }, flex('col', { gap: 4 }), null, [head, track], { id: p.id, part: 'slider' });
}

function badgeOf(k: Kit, p: UiPartNode): N {
  const c = k.t.colour;
  const tone = p.flags.includes('success') ? c.success : p.flags.includes('danger') ? c.danger : c.accentInk;
  const wire = k.t.wire;
  const paint = (b: Rect, out: Out): void => rectOf(out, p.id, 'badge', b, { radius: 12, fill: wire ? null : c.accentWash, edge: wire ? { colour: c.edge, width: 1 } : null });
  const word = text(k, p.fields[0] ?? '', { ...k.type.caption, weight: 'bold' }, { id: p.id, nowrap: true, colour: wire ? c.ink : tone, what: 'label' });
  return mk({ width: 'hug', height: 'hug', minH: 24 }, flex('row', { align: 'center', pad: [2, 10, 2, 10] }), null, [word], { id: p.id, part: 'badge', hug: true, paint });
}

function priceOf(k: Kit, p: UiPartNode): N {
  const c = k.t.colour;
  const big = text(k, p.fields[0] ?? '', k.type.price, { id: p.id, nowrap: true, colour: c.ink, what: 'amount' });
  const kids: N[] = [big];
  if (p.fields[1] !== undefined && p.fields[1] !== '') {
    const unit = text(k, p.fields[1], k.type.title, { id: p.id, nowrap: true, colour: c.dim, what: 'unit' });
    kids.push(mk({ width: 'hug', height: 'hug' }, flex('col', { pad: [0, 0, 8, 0] }), null, [unit], { id: `${p.id}:unit`, part: 'price-unit', quiet: true, owner: p.id }));
  }
  return mk({ width: 'hug', height: 'hug' }, flex('row', { align: 'end', gap: 4 }), null, kids, { id: p.id, part: 'price', hug: true });
}

function progressOf(k: Kit, p: UiPartNode): N {
  const c = k.t.colour;
  const nums = p.flags.filter((f) => /^\d+$/.test(f)).map(Number);
  const value = nums[0] ?? 1;
  const total = Math.max(1, nums[1] ?? Math.max(value, 4));
  const segs: N[] = Array.from({ length: total }, (_, i) =>
    mk({ width: 'fill', height: 4 }, null, { fit: () => ({ w: 0, h: 4 }), minW: 0 }, [], {
      id: `${p.id}:seg${i}`,
      part: 'progress-step',
      quiet: true,
      owner: p.id,
      paint: (b, out) => rectOf(out, p.id, `step:${i}`, b, { radius: 2, fill: i < value ? c.accent : c.line }),
    }),
  );
  return mk({ width: 'fill', height: 'hug' }, flex('row', { gap: 4, pad: [8, 16, 8, 16] }), null, segs, { id: p.id, part: 'progress' });
}

function imageOf(k: Kit, p: UiPartNode): N {
  const c = k.t.colour;
  const wire = k.t.wire;
  const round = p.flags.includes('round');
  const ratio = p.flags.includes('square') || round ? 1 : p.flags.includes('tall') ? 3 / 4 : 16 / 9;
  const label = p.fields[0] ?? '';
  const photo = k.state.picture?.[p.id];
  const paint = (b: Rect, out: Out): void => {
    const r = round ? Math.min(b.w, b.h) / 2 : k.t.radius.m;
    if (photo !== undefined) {
      // a photograph the server found: the picture, its corners given back to the screen, and its credit at its foot, always
      out.parts.push({ kind: 'picture', key: out.key(p.id, 'photo'), owner: p.id, x: b.x, y: b.y, w: b.w, h: b.h, url: photo.url, ...(round ? { circle: true } : {}) });
      if (!round) {
        const credit = `Photo: ${photo.credit}`;
        const room = Math.max(8, b.w - 20);
        const creditSize = Math.max(11, k.t.minText ?? 0);
        let text = credit;
        // `keep` counts the credit's own characters kept, and falls by at least one each pass, so this always ends. (It once sliced the text it had already
        // shortened and put three dots back: a credit only a little too long grew by two characters a pass for ever, and a phone's mock-up hung the page.)
        let keep = credit.length;
        while (keep > 4 && k.measure.width(text, creditSize, 'normal') > room) {
          keep = Math.min(keep - 1, Math.max(4, Math.floor(keep * Math.min(0.95, room / k.measure.width(text, creditSize, 'normal')))));
          text = `${credit.slice(0, keep).trimEnd()}...`;
        }
        const strip = { x: b.x, y: b.y + b.h - (creditSize + 11), w: b.w, h: creditSize + 11 };
        rectOf(out, p.id, 'credit-scrim', strip, { fill: '#000000', fillAlpha: 0.5 });
        out.parts.push({ kind: 'text', key: out.key(p.id, 'credit'), owner: p.id, x: b.x + 10, y: strip.y + 3, w: room, h: creditSize + 5, lines: [{ text, width: k.measure.width(text, creditSize, 'normal') }], size: creditSize, line: creditSize + 5, weight: 'normal', colour: '#f4f6fa', align: 'left' });
        // the four corners, in the ground the picture stands on
        const rr = Math.min(r, b.h / 2, b.w / 2);
        const corner = (cx: number, cy: number, sx: number, sy: number): void => {
          const arc = Array.from({ length: 9 }, (_, i) => {
            const t = (i / 8) * (Math.PI / 2);
            return { x: cx + sx * rr * Math.sin(t), y: cy + sy * rr * Math.cos(t) };
          });
          // from the square corner along the edge to where the curve begins, round the curve, and back to the corner
          const o = { x: cx + sx * rr, y: cy + sy * rr };
          out.parts.push({ kind: 'path', key: out.key(p.id, `corner:${sx}:${sy}`), owner: p.id, outline: [{ closed: true, points: [o, ...arc] }], fill: c.screen, stroke: null });
        };
        corner(b.x + rr, b.y + rr, -1, -1);
        corner(b.x + b.w - rr, b.y + rr, 1, -1);
        corner(b.x + rr, b.y + b.h - rr, -1, 1);
        corner(b.x + b.w - rr, b.y + b.h - rr, 1, 1);
      }
      return;
    }
    if (wire) {
      rectOf(out, p.id, 'image', b, { radius: r, fill: c.sunken, edge: { colour: c.edge, width: 1 } });
      // the diagonals stop short of the corners, so a rounded corner is never poked through
      const x0 = b.x + 6;
      const y0 = b.y + 6;
      const x1 = b.x + b.w - 6;
      const y1 = b.y + b.h - 6;
      out.parts.push({ kind: 'path', key: out.key(p.id, 'cross'), owner: p.id, outline: [{ closed: false, points: [{ x: x0, y: y0 }, { x: x1, y: y1 }] }, { closed: false, points: [{ x: x1, y: y0 }, { x: x0, y: y1 }] }], fill: null, stroke: { colour: c.line, width: 1 } });
    } else {
      // a finished design's picture is cover art made from what it shows, not a grey box: the same words, the same picture
      coverArt(out, p.id, label === '' ? p.id : label, b, [r, r, r, r], 'image');
    }
    if (label !== '' && !round) {
      const room = Math.max(8, b.w - 24);
      const lines = k.measure.wrap(label, k.type.note.size, 'normal', room).lines;
      const height = lines.length * k.type.note.line;
      if (wire) {
        // in a wireframe the words sit on a small plate, so the crossed lines never run through them
        const wide = Math.max(...lines.map((l) => l.width)) + 16;
        rectOf(out, p.id, 'plate', { x: b.x + (b.w - wide) / 2, y: b.y + (b.h - height) / 2 - 4, w: wide, h: height + 8 }, { radius: k.t.radius.s, fill: c.sunken });
        out.parts.push({ kind: 'text', key: out.key(p.id, 'caption'), owner: p.id, x: b.x + 12, y: b.y + (b.h - height) / 2, w: room, h: height, lines, size: k.type.note.size, line: k.type.note.line, weight: 'normal', colour: c.dim, align: 'center' });
      } else {
        // on cover art the words stand on a dark strip at the foot, in white, as a photograph's credit does
        const strip = Math.min(b.h, height + 16);
        const foot = clipPoly([{ x: b.x, y: b.y + b.h - strip }, { x: b.x + b.w, y: b.y + b.h - strip }, { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h }], roundedPoly(b, [r, r, r, r]));
        out.parts.push({ kind: 'path', key: out.key(p.id, 'caption-scrim'), owner: p.id, outline: [{ closed: true, points: foot }], fill: '#000000', stroke: null, alpha: 0.6 });
        out.parts.push({ kind: 'text', key: out.key(p.id, 'caption'), owner: p.id, x: b.x + 12, y: b.y + b.h - strip + 8, w: room, h: height, lines, size: k.type.note.size, line: k.type.note.line, weight: 'normal', colour: '#ffffff', align: 'left' });
      }
    }
  };
  // a picture takes its proportions from its width, and never more than 45% of the screen's height: on a wide screen it is a banner and not a wall
  const cap = px4(UI_DEVICE_SIZE[k.device].height * 0.45);
  const fit = (w: number): { w: number; h: number } => {
    const width = Number.isFinite(w) ? w : 240;
    return { w: width, h: round ? 64 : Math.min(cap, px4(width / ratio)) };
  };
  return mk({ width: round ? 64 : 'fill', height: 'hug' }, null, { fit, minW: 0 }, [], { id: p.id, part: 'image', hug: round, paint });
}

function dividerOf(k: Kit, p: UiPartNode): N {
  return mk({ width: 'fill', height: 4 }, null, { fit: () => ({ w: 0, h: 4 }), minW: 0 }, [], {
    id: p.id,
    part: 'divider',
    quiet: true,
    paint: (b, out) => rectOf(out, p.id, 'rule', { x: b.x, y: b.y + 2, w: b.w, h: 1 }, { fill: k.t.colour.line }),
  });
}

function spaceOf(p: UiPartNode, ctx: Ctx): N {
  const word = p.flags.find((f) => f in UI_SPACE || f === 'grow');
  const size = word === undefined ? 16 : word === 'grow' ? 0 : (UI_SPACE as Record<string, number>)[word] ?? 16;
  const grow = word === 'grow' ? 1 : 0;
  const row = ctx.dir === 'row';
  return mk({ width: row ? size : 0, height: row ? 0 : size, grow, shrink: 0 }, null, { fit: () => ({ w: row ? size : 0, h: row ? 0 : size }), minW: row ? size : 0 }, [], { id: p.id, part: 'space', quiet: true });
}

function iconOf(k: Kit, p: UiPartNode): N {
  const name = p.flags.find((f) => !['small', 'large', 'xl', 'dim', 'accent', 'success'].includes(f)) ?? p.attrs['name'] ?? 'info';
  const size = p.flags.includes('xl') ? 64 : p.flags.includes('large') ? 40 : p.flags.includes('small') ? 20 : 32;
  const c = k.t.colour;
  const done = name === 'check' || name === 'check-circle';
  const colour = p.flags.includes('success') || done ? (k.t.wire ? c.ink : c.success) : p.flags.includes('accent') ? c.accentInk : p.flags.includes('dim') ? c.dim : c.ink;
  const n = icon(p.id, name, size, colour, size > 32 ? 1.75 : 2);
  return { ...n, payload: { ...n.payload, part: 'icon', hug: true, quiet: false } };
}

function chartOf(k: Kit, p: UiPartNode): N {
  const c = k.t.colour;
  const ratio = p.flags.includes('square') ? 1 : 16 / 10;
  const title = p.fields[0] ?? '';
  const cap = px4(UI_DEVICE_SIZE[k.device].height * 0.45);
  const leaf = { fit: (w: number): { w: number; h: number } => ({ w: Number.isFinite(w) ? w : 280, h: Math.min(cap, px4((Number.isFinite(w) ? w : 280) / ratio)) }), minW: 0 };
  const paint = (b: Rect, out: Out): void => {
    rectOf(out, p.id, 'chart', b, { radius: k.t.radius.m, fill: c.surface, edge: { colour: k.t.wire ? c.edge : c.line, width: 1 } });
    if (title !== '') out.parts.push({ kind: 'text', key: out.key(p.id, 'title'), owner: p.id, x: b.x + 12, y: b.y + 8, w: b.w - 24, h: 20, lines: [{ text: title, width: k.measure.width(title, k.type.note.size, 'bold') }], size: k.type.note.size, line: 20, weight: 'bold', colour: c.ink, align: 'left' });
  };
  return mk({ width: 'fill', height: 'hug', minH: 160 }, null, leaf, [], { id: p.id, part: 'chart', paint, slot: p.attrs['ref'] ?? p.id });
}

function tabbarOf(k: Kit, p: UiPartNode): N {
  const c = k.t.colour;
  const icons = (p.attrs['icons'] ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
  const fallback = ['home', 'search', 'user', 'bell', 'settings'];
  const tabs = p.fields.map(unstar);
  const starred = tabs.findIndex((t) => t.starred);
  const chosen = k.state.tab[p.id] ?? (starred >= 0 ? starred : 0);
  const kids: N[] = tabs.map((t, i) => {
    const on = i === chosen;
    const ink = on ? (k.t.wire ? c.ink : c.accentInk) : c.dim;
    const glyph = icon(p.id, icons[i] ?? fallback[i] ?? 'circle', 24, ink, on ? 2.25 : 2);
    const word = text(k, t.text, { ...k.type.caption, weight: on ? 'bold' : 'normal' }, { id: p.id, nowrap: true, squeeze: true, colour: ink, align: 'center', what: `tab:${i}`, width: 'fill' });
    return mk({ width: 'fill', height: 'fill', minW: 44 }, flex('col', { align: 'center', justify: 'center', gap: 2 }), null, [glyph, word], { id: `${p.id}:tab${i}`, part: 'tab', target: true, action: { kind: 'tab', bar: p.id, index: i }, owner: p.id });
  });
  const paint = (b: Rect, out: Out): void => rectOf(out, p.id, 'bar', b, { rule: 'top', edge: { colour: c.line, width: 1 }, fill: k.t.wire ? null : c.surface });
  return mk({ width: 'fill', height: 68 }, flex('row', { align: 'stretch', pad: [0, 8, 12, 8] }), null, kids, { id: p.id, part: 'tabbar', paint });
}

function navOf(k: Kit, p: UiPartNode): N {
  const c = k.t.colour;
  const desk = k.device === 'desktop' || k.device === 'browser';
  const title = p.fields[0] ?? '';
  const bar = (b: Rect, out: Out): void => rectOf(out, p.id, 'bar', b, { rule: 'bottom', edge: { colour: c.line, width: 1 } });
  if (desk) {
    const links = (p.attrs['links'] ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
    const action = p.attrs['action'];
    const kids: N[] = [text(k, title, { ...k.type.title, size: 22, line: 28 }, { id: p.id, nowrap: true, colour: c.ink, what: 'brand' })];
    kids.push(mk({ width: 'hug', height: 'hug', grow: 1 }, flex('row', { gap: 32, justify: 'center' }), null, links.map((l, i) => text(k, l, k.type.body, { id: p.id, nowrap: true, colour: c.dim, what: `link:${i}` })), { id: `${p.id}:links`, part: 'nav-links', quiet: true, owner: p.id }));
    if (action !== undefined && action !== '') {
      const b = buttonOf(k, { kind: 'button', id: `${p.id}:action`, line: p.line, flags: ['primary', 'small'], attrs: {}, fields: [action] });
      kids.push(b);
    }
    return mk({ width: 'fill', height: 76 }, flex('row', { align: 'center', pad: [0, 40, 0, 40] }), null, kids, { id: p.id, part: 'nav', paint: bar });
  }
  const left = p.flags.includes('close') ? 'close' : p.flags.includes('back') ? 'back' : p.flags.includes('menu') ? 'menu' : null;
  const right = p.attrs['action'];
  const slot = (id: string, name: string | null | undefined, what: string): N =>
    name === null || name === undefined
      ? mk({ width: 48, height: 48, shrink: 0 }, null, { fit: () => ({ w: 48, h: 48 }), minW: 48 }, [], { id: `${p.id}:${what}`, part: 'nav-gap', quiet: true, owner: p.id })
      : mk({ width: 48, height: 48, shrink: 0 }, flex('row', { align: 'center', justify: 'center' }), null, [icon(p.id, name, 24, c.ink)], {
          id: `${p.id}:${what}`,
          part: 'nav-action',
          target: true,
          action: { kind: 'press', control: `${p.id}:${what}` },
          owner: p.id,
          paint: (b, out) => {
            if (k.state.pressed === `${p.id}:${what}`) rectOf(out, p.id, 'pressed', b, { radius: 24, fill: c.ink, fillAlpha: 0.08 });
          },
        });
  const middle = text(k, title, k.type.title, { id: p.id, nowrap: true, squeeze: true, colour: c.ink, align: 'center', what: 'title', width: 'fill' });
  return mk({ width: 'fill', height: 56 }, flex('row', { align: 'center', pad: [0, 8, 0, 8] }), null, [slot('l', left, 'left'), middle, slot('r', right, 'right')], { id: p.id, part: 'nav', paint: bar });
}

// ------------------------------------------------------------------ containers, and the tree

function boxOf(k: Kit, c: UiContainer, kids: N[], ctx: Ctx): N {
  const p = c.props;
  const t = k.t;
  const dir = c.kind;
  const card = p.card;
  const pad = p.pad ?? (card ? 16 : 0);
  const held = dir === 'row' && c.children.some((n) => !isUiContainer(n) && n.kind === 'button');
  const fit = held ? (k.t.rowFit ?? 0) : 0;
  const gap = fit >= 1 ? Math.min(gapOf(p.gap, 8 + packOf(k) * 4), 4) : gapOf(p.gap, 8 + packOf(k) * 4);
  // a row of cards stands them at one height; any other row centres what is in it
  const cards = dir === 'row' && c.children.filter((n) => isUiContainer(n) && n.props.card).length > 1;
  const align: Align = p.align ?? (dir === 'row' ? (cards ? 'stretch' : 'center') : 'stretch');
  const wide = p.spread || p.center || p.max !== null;
  // `grow` takes the room that is left along the line the container stands in, shared equally as `flex: 1` does
  const style: Style = {
    width: wide || (p.grow && ctx.dir === 'row') ? 'fill' : 'hug',
    height: p.grow && ctx.dir === 'col' ? 'fill' : 'hug',
    ...(p.max !== null ? { maxW: p.max } : {}),
    ...(p.center ? { self: 'center' as const } : {}),
  };
  const paint = card
    ? (b: Rect, out: Out): void => {
        const shadow = p.lift ? shadowOf(k, 'high') : undefined;
        const lifted = p.lift && t.wire;
        if (lifted) rectOf(out, c.id, 'lift', { x: b.x, y: b.y + 4, w: b.w, h: b.h }, { radius: t.radius.l, fill: t.colour.shadow, fillAlpha: 0.16 });
        rectOf(out, c.id, 'card', b, { radius: t.radius.l, fill: t.colour.surface, edge: { colour: t.wire ? t.colour.edge : t.colour.line, width: 1 }, ...(shadow === undefined ? {} : { shadow }) });
      }
    : p.lift
      ? (b: Rect, out: Out): void => {
          const shadow = shadowOf(k, 'high');
          rectOf(out, c.id, 'lift', b, { radius: t.radius.l, fill: null, ...(shadow === undefined ? {} : { shadow }) });
        }
      : undefined;
  const item: Item = { id: c.id, part: c.kind, quiet: !card, ...(paint === undefined ? {} : { paint }) };
  return mk(style, flex(dir, { gap, pad, align, justify: p.spread ? 'between' : 'start', wrap: p.wrap || fit >= 2 }), null, kids, item);
}

function build(k: Kit, node: UiContainer | UiPartNode, ctx: Ctx): N {
  if (isUiContainer(node)) return boxOf(k, node, buildAll(k, node.children, { dir: node.kind, align: node.props.align ?? (node.kind === 'row' ? 'center' : 'stretch') }), ctx);
  switch (node.kind) {
    case 'nav':
      return navOf(k, node);
    case 'tabbar':
      return tabbarOf(k, node);
    case 'heading':
      return headingOf(k, node, ctx);
    case 'text':
      return textOf(k, node, ctx);
    case 'note':
      return noteOf(k, node, ctx);
    case 'button':
      return buttonOf(k, node);
    case 'field':
      return fieldOf(k, node, true);
    case 'input':
      return fieldOf(k, node, false);
    case 'item':
      return itemOf(k, node);
    case 'badge':
      return badgeOf(k, node);
    case 'price':
      return priceOf(k, node);
    case 'progress':
      return progressOf(k, node);
    case 'image':
      return imageOf(k, node);
    case 'icon':
      return iconOf(k, node);
    case 'divider':
      return dividerOf(k, node);
    case 'space':
      return spaceOf(node, ctx);
    case 'pick':
      return pickOf(k, node);
    case 'toggle':
      return toggleOf(k, node);
    case 'slider':
      return sliderOf(k, node);
    case 'chart':
      return chartOf(k, node);
    case 'media':
    case 'carousel':
    case 'player':
    case 'chat':
    case 'map':
    case 'stat':
    case 'people':
    case 'segment':
      return richOf(k, node, ctx) ?? textOf(k, node, ctx);
  }
}

/** Builds a container's children, giving a part that hugs the start of a container that stretches. Consecutive list rows stand as a list. */
function buildAll(k: Kit, nodes: readonly (UiContainer | UiPartNode)[], ctx: Ctx): N[] {
  const out: N[] = [];
  let run: N[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    if (run.length === 1) out.push(run[0] as N);
    else out.push(mk({ width: 'fill', height: 'hug' }, flex('col', { gap: k.t.wire ? 0 : 8 }), null, run, { id: `${run[0]?.payload.id ?? 'list'}:list`, part: 'list', quiet: true }));
    run = [];
  };
  for (const node of nodes) {
    const built = withGrow(build(k, node, ctx), node, ctx);
    const isItem = ctx.dir === 'col' && !isUiContainer(node) && node.kind === 'item';
    if (isItem) {
      run.push(built);
      continue;
    }
    flush();
    out.push(built);
  }
  flush();
  return out.map((n) => (n.payload.hug === true && ctx.align === 'stretch' ? { ...n, style: { ...n.style, self: 'start' as const } } : n));
}

/** A part that says `grow` takes the room that is left along the line it stands in. */
function withGrow(n: N, node: UiContainer | UiPartNode, ctx: Ctx): N {
  if (isUiContainer(node) || !node.flags.includes('grow') || node.kind === 'space') return n;
  return ctx.dir === 'row' ? { ...n, style: { ...n.style, width: 'fill' } } : { ...n, style: { ...n.style, height: 'fill' } };
}

// ------------------------------------------------------------------ a screen

const BLEED: ReadonlySet<string> = new Set(['nav', 'tabbar', 'progress', 'carousel']);

/** The device's own furniture: the status bar and the home bar of a phone. */
function statusBar(k: Kit, id: string): N {
  const c = k.t.colour;
  const time = text(k, '9:41', { size: Math.max(15, k.t.minText ?? 0), line: 20, weight: 'bold' }, { id, nowrap: true, colour: c.ink, what: 'time' });
  const right = mk({ width: 'hug', height: 'hug' }, flex('row', { gap: 6, align: 'center' }), null, [icon(id, 'wifi', 16, c.ink, 2.25), icon(id, 'battery', 20, c.ink, 2.25)], { id: `${id}:status-icons`, part: 'status', quiet: true });
  return mk({ width: 'fill', height: 44 }, flex('row', { align: 'center', justify: 'between', pad: [12, 28, 0, 28] }), null, [time, right], { id: `${id}:status`, part: 'status', quiet: true });
}

function homeBar(k: Kit, id: string): N {
  return mk({ width: 'fill', height: 20 }, null, { fit: () => ({ w: 0, h: 20 }), minW: 0 }, [], {
    id: `${id}:home`,
    part: 'home-bar',
    quiet: true,
    paint: (b, out) => rectOf(out, `${id}:home`, 'bar', { x: b.x + (b.w - 134) / 2, y: b.y + 8, w: 134, h: 5 }, { radius: 3, fill: k.t.colour.ink, fillAlpha: 0.85 }),
  });
}

/** The tree of a whole screen, as the solver wants it. */
export function buildScreen(k: Kit, screen: UiScreen, width: number, height: number): N {
  const phone = k.device === 'phone';
  const ctx: Ctx = { dir: 'col', align: 'stretch' };
  const body: N[] = [];
  for (const child of screen.children) {
    const n = buildAll(k, [child], ctx)[0];
    if (n === undefined) continue;
    const loose = !isUiContainer(child) && !BLEED.has(child.kind) && child.kind !== 'space' && child.kind !== 'divider';
    const gutter = gutterOf(k);
    body.push(loose ? mk({ width: 'fill', height: 'hug' }, flex('col', { pad: [0, gutter, 0, gutter], align: 'stretch' }), null, [n], { id: `${child.id}:gutter`, part: 'gutter', quiet: true, owner: child.id }) : n);
  }
  // a tab bar sits at the foot of the screen: when nothing grows to push it there, a spring does
  const tabAt = screen.children.findIndex((c) => !isUiContainer(c) && c.kind === 'tabbar');
  const grows = screen.children.some((c) => isUiContainer(c) && c.props.grow) || screen.children.some((c) => !isUiContainer(c) && c.kind === 'space' && c.flags.includes('grow'));
  if (tabAt >= 0 && !grows) body.splice(tabAt, 0, mk({ width: 0, height: 0, grow: 1, shrink: 0 }, null, { fit: () => ({ w: 0, h: 0 }), minW: 0 }, [], { id: `${screen.id}:spring`, part: 'space', quiet: true }));
  const kids: N[] = [];
  if (phone) kids.push(statusBar(k, screen.id));
  kids.push(...body);
  if (phone) kids.push(homeBar(k, screen.id));
  const root = mk({ width, height }, flex('col', { align: 'stretch' }), null, kids, { id: screen.id, part: 'screen', quiet: true });
  return root;
}
