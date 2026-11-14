// `wireframe` (PLAN-v2.2 E13): boxes and lines. A screen is white paper, every control is an outline, a picture is a
// crossed box, an accent is the ink itself. It is what an interface looks like before anyone has chosen a colour: the same
// lines serve it and `studio`, so `look studio` after a wireframe is the wireframe becoming the design.
//
// Two things in this file. The TOKENS the kit reads (colours, radii, a type scale on a four-point line height, elevation),
// and a LookSpec so that a renderer can be mounted in it: no paper, no grain, no sway, a ruled stroke, Inter. The preset
// table in `looks/index.ts` and the `LookId` union list both looks (v2.2 integration).

import type { UiTokens } from '../painter/blocks/ui/lang';
import type { LookSpec } from '../contracts/look';
import { softType } from './common';
import { PAPER } from './paper';

export const WIREFRAME_TOKENS: UiTokens = {
  id: 'wireframe',
  wire: true,
  radius: { s: 4, m: 8, l: 8, device: 48 },
  type: {
    caption: { size: 11, line: 16, weight: 'normal' },
    note: { size: 13, line: 20, weight: 'normal' },
    body: { size: 15, line: 24, weight: 'normal' },
    label: { size: 15, line: 20, weight: 'bold' },
    title: { size: 17, line: 24, weight: 'bold' },
    heading: { size: 24, line: 32, weight: 'bold' },
    display: { size: 34, line: 40, weight: 'bold' },
    hero: { size: 52, line: 56, weight: 'bold' },
    price: { size: 44, line: 48, weight: 'bold' },
  },
  elevation: { none: { dy: 0, blur: 0, alpha: 0 }, low: { dy: 2, blur: 0, alpha: 0.14 }, high: { dy: 4, blur: 0, alpha: 0.2 } },
  colour: {
    ground: '#171a21',
    bezel: '#ffffff',
    bezelEdge: '#2a2f3b',
    screen: '#ffffff',
    surface: '#ffffff',
    sunken: '#eceef2',
    ink: '#1d2129',
    dim: '#5d6573',
    faint: '#8a93a3',
    line: '#c9ced8',
    edge: '#1d2129',
    accent: '#1d2129',
    onAccent: '#ffffff',
    accentWash: '#eceef2',
    success: '#1d2129',
    danger: '#1d2129',
    shadow: '#1d2129',
  },
};

/** A LookSpec for a flat, crisp surface set in Inter: what a renderer is mounted in to draw a mock-up. */
export function uiLookSpec(name: string, machine: string, t: UiTokens): LookSpec {
  const calm = { agitation: 0, dim: 0, sway: 0, swayPeriod: 12, lean: 0, snap: 1 };
  return {
    ...PAPER,
    id: t.id,
    name,
    machine,
    // the ROOM's roles: the words on the dark ground around the device (the caption, the chrome bar). The ink on the screen itself is the kit's, from the tokens
    roles: { ground: t.colour.ground, ink: '#eef0f5', dim: '#a3aab8', accent: t.wire ? '#ffffff' : t.colour.accent, alt: t.colour.faint },
    groundAlt: null,
    hot: null,
    fx: [],
    stroke: { character: 'clean', thick: 1, wobble: 0 },
    type: softType('sans'),
    mood: { calm, neutral: calm, tense: calm, playful: calm, grave: calm },
    margin: 0.02,
  };
}

export const WIREFRAME: LookSpec = uiLookSpec('wireframe', 'boxes and lines on white paper', WIREFRAME_TOKENS);
