// The devices (PLAN-v2.2 E13): a phone at its true proportions, a tablet, a desk window, a browser. A screen is
// measured inside in points (a phone is 390 across); the body and the chrome are drawn around it. Pure: shapes in the
// device's own points, origin at its outer top-left.

import type { UiDevice, UiTokens } from './lang';
import { UI_DEVICE_SIZE } from './lang';
import { placeIcon } from './icons';
import type { UiMeasure } from './measure';
import type { UiPart } from './types';

export interface DeviceShape {
  /** the whole device, body and chrome included, points */
  readonly width: number;
  readonly height: number;
  /** where the screen's own top-left sits inside it */
  readonly inset: { readonly x: number; readonly y: number };
  /** drawn before the screen's parts */
  readonly under: readonly UiPart[];
  /** drawn after them: what covers a corner the screen's square parts would otherwise poke through */
  readonly over: readonly UiPart[];
}

function rounded(x: number, y: number, w: number, h: number, r: number): { x: number; y: number }[] {
  const steps = Math.max(6, Math.min(24, Math.ceil(r / 2)));
  const pts: { x: number; y: number }[] = [];
  const corner = (cx: number, cy: number, from: number): void => {
    for (let i = 0; i <= steps; i++) {
      const a = from + (i / steps) * (Math.PI / 2);
      pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
  };
  corner(x + w - r, y + r, -Math.PI / 2);
  corner(x + w - r, y + h - r, 0);
  corner(x + r, y + h - r, Math.PI / 2);
  corner(x + r, y + r, Math.PI);
  return pts;
}

export function deviceShape(device: UiDevice, name: string, t: UiTokens, measure: UiMeasure, id: string, height?: number): DeviceShape {
  // a page may be longer than its fold (`layoutScreen` grows it): the glass is as tall as the screen laid out in it
  const size = height === undefined ? UI_DEVICE_SIZE[device] : { width: UI_DEVICE_SIZE[device].width, height };
  const c = t.colour;
  const under: UiPart[] = [];
  const over: UiPart[] = [];
  const key = (what: string): string => `${id}/device/${what}`;
  if (device === 'phone' || device === 'tablet') {
    const bezel = device === 'phone' ? 10 : 16;
    const outerR = device === 'phone' ? 56 : 44;
    const innerR = outerR - bezel;
    const w = size.width + bezel * 2;
    const h = size.height + bezel * 2;
    under.push({
      kind: 'rect',
      key: key('body'),
      owner: id,
      x: 0,
      y: 0,
      w,
      h,
      radius: outerR,
      fill: c.bezel,
      edge: { colour: c.bezelEdge, width: 1 },
      shadow: t.wire ? undefined : { colour: '#000000', dy: 14, blur: 36, alpha: 0.38 },
    });
    under.push({ kind: 'rect', key: key('screen'), owner: id, x: bezel, y: bezel, w: size.width, h: size.height, radius: innerR, fill: c.screen, edge: null });
    // the body drawn again over the screen as a ring: the screen's square corners cannot show through it
    over.push({
      kind: 'path',
      key: key('ring'),
      owner: id,
      outline: [
        { closed: true, points: rounded(0, 0, w, h, outerR) },
        { closed: true, points: rounded(bezel, bezel, size.width, size.height, innerR).reverse() },
      ],
      fill: c.bezel,
      stroke: null,
    });
    if (device === 'phone') {
      // the camera island
      over.push({ kind: 'rect', key: key('island'), owner: id, x: bezel + size.width / 2 - 56, y: bezel + 11, w: 112, h: 32, radius: 16, fill: '#05060a', edge: null });
    }
    return { width: w, height: h, inset: { x: bezel, y: bezel }, under, over };
  }
  // a window on a desk, or a browser
  const browser = device === 'browser';
  const bar = browser ? 52 : 36;
  const w = size.width;
  const h = size.height + bar;
  const chrome = t.wire ? '#e8eaef' : '#e9ebf1';
  under.push({
    kind: 'rect',
    key: key('body'),
    owner: id,
    x: 0,
    y: 0,
    w,
    h,
    radius: 12,
    fill: chrome,
    edge: { colour: t.wire ? '#9aa1ae' : c.bezelEdge, width: 1 },
    shadow: t.wire ? undefined : { colour: '#000000', dy: 18, blur: 44, alpha: 0.4 },
  });
  under.push({ kind: 'rect', key: key('screen'), owner: id, x: 0, y: bar, w: size.width, h: size.height, radius: 0, fill: c.screen, edge: null });
  [['#ff5f57', 20], ['#febc2e', 40], ['#28c840', 60]].forEach(([colour, x], i) => {
    under.push({ kind: 'rect', key: key(`light${i}`), owner: id, x: (x as number) - 6, y: bar / 2 - 6, w: 12, h: 12, radius: 6, fill: t.wire ? '#ffffff' : (colour as string), edge: t.wire ? { colour: '#9aa1ae', width: 1 } : null });
  });
  if (browser) {
    const ink = '#59606e';
    under.push({ kind: 'path', key: key('back'), owner: id, outline: placeIcon('chevron-left', 84, bar / 2 - 10, 20), fill: null, stroke: { colour: ink, width: 2 } });
    under.push({ kind: 'path', key: key('forward'), owner: id, outline: placeIcon('chevron-right', 110, bar / 2 - 10, 20), fill: null, stroke: { colour: '#9aa1ae', width: 2 } });
    const aw = Math.min(560, w - 360);
    const ax = (w - aw) / 2;
    under.push({ kind: 'rect', key: key('address'), owner: id, x: ax, y: 10, w: aw, h: bar - 20, radius: (bar - 20) / 2, fill: '#ffffff', edge: { colour: t.wire ? '#9aa1ae' : '#d6dae3', width: 1 } });
    under.push({ kind: 'path', key: key('lock'), owner: id, outline: placeIcon('lock', ax + 12, bar / 2 - 7, 14), fill: null, stroke: { colour: ink, width: 2 } });
    const address = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'site'}.example`;
    under.push({ kind: 'text', key: key('url'), owner: id, x: ax + 34, y: bar / 2 - 10, w: aw - 46, h: 20, lines: [{ text: address, width: measure.width(address, 13, 'normal') }], size: 13, line: 20, weight: 'normal', colour: ink, align: 'left' });
  } else {
    const wide = Math.min(w - 200, measure.width(name, 13, 'bold'));
    under.push({ kind: 'text', key: key('title'), owner: id, x: (w - wide) / 2, y: bar / 2 - 10, w: wide, h: 20, lines: [{ text: name, width: wide }], size: 13, line: 20, weight: 'bold', colour: '#59606e', align: 'left' });
  }
  return { width: w, height: h, inset: { x: 0, y: bar }, under, over };
}
