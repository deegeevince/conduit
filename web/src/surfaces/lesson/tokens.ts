// The lesson's two looks. The shell gives a surface one bit (light or dark) and these are the tokens it wears for it; each pair is held to
// 4.5:1 for text (checked by the census at run time, and by the bench in both). The real shell's tokens (SH1) replace these.

import type { LessonTokens } from './types';

const FONT = "ui-rounded, 'SF Pro Rounded', system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

export const LIGHT: LessonTokens = {
  ground: '#fbf6ea',
  card: '#ffffff',
  ink: '#1c2233',
  dim: '#4a5368',
  accent: '#2459d9',
  onAccent: '#ffffff',
  soft: '#e6ecfb',
  line: '#cdc4ad',
  good: '#11663a',
  goodSoft: '#def2e5',
  nudge: '#7a3b00',
  nudgeSoft: '#fff0d3',
  font: FONT,
  dark: false,
};

export const DARK: LessonTokens = {
  ground: '#141925',
  card: '#1e2535',
  ink: '#f3efe4',
  dim: '#b9c0d0',
  accent: '#8fadff',
  onAccent: '#0b1330',
  soft: '#28324b',
  line: '#4a5470',
  good: '#8fe0b0',
  goodSoft: '#17382a',
  nudge: '#ffd08f',
  nudgeSoft: '#3d2c12',
  font: FONT,
  dark: true,
};

export function tokensFor(dark: boolean): LessonTokens {
  return dark ? DARK : LIGHT;
}
