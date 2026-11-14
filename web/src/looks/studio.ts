// `studio` (PLAN-v2.2 E13): a finished design. Surfaces on a quiet ground, soft shadows, rounded corners, one accent. The
// same lines as `wireframe`; this look is only what a designer would do next. See wireframe.ts for what is in these files and why the
// spec still carries paper's id.

import type { UiTokens } from '../painter/blocks/ui/lang';
import type { LookSpec } from '../contracts/look';
import { uiLookSpec } from './wireframe';

export const STUDIO_TOKENS: UiTokens = {
  id: 'studio',
  wire: false,
  radius: { s: 8, m: 12, l: 16, device: 48 },
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
  elevation: { none: { dy: 0, blur: 0, alpha: 0 }, low: { dy: 2, blur: 6, alpha: 0.08 }, high: { dy: 8, blur: 20, alpha: 0.14 } },
  colour: {
    ground: '#14161d',
    bezel: '#0b0c10',
    bezelEdge: '#2b303b',
    screen: '#f5f6fa',
    surface: '#ffffff',
    sunken: '#e9ecf3',
    ink: '#12151c',
    dim: '#5b6479',
    faint: '#97a0b3',
    line: '#e1e5ee',
    edge: '#d3d8e4',
    accent: '#1f5eff',
    onAccent: '#ffffff',
    accentWash: '#e4ecff',
    success: '#12a36a',
    danger: '#e5484d',
    shadow: '#101828',
  },
};

export const STUDIO: LookSpec = uiLookSpec('studio', 'a finished design: surfaces, soft shadows, one accent', STUDIO_TOKENS);
