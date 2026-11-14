// The lesson's two looks. The shell gives a surface one bit (light or dark) and these are the tokens it wears for it; each pair is held to
// 4.5:1 for text (checked by the census at run time, and by the bench in both). The real shell's tokens (SH1) replace these.

import type { AppTokens } from '../../contracts/app';
import { contrastRatio, mix, worstContrast } from '../../looks/colour-math';
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

/** Moves a colour toward `toward` until it reads at `ratio` on every ground (or is `toward` itself). */
function reads(colour: string, grounds: readonly string[], toward: string, ratio = 4.5): string {
  for (let t = 0; t <= 1.001; t += 0.05) {
    const next = t === 0 ? colour : mix(colour, toward, Math.min(1, t));
    if (worstContrast(next, grounds) >= ratio) return next;
  }
  return toward;
}

/**
 * The lesson's palette from the stage's look (the tokens the host passes a live app): the same ground, ink, accent, face and corners as the
 * canvas, so the view reads as the same product in paper and in night. Every text pair is held to 4.5:1 here, whatever the look gave.
 */
export function tokensFromLook(app: AppTokens, scale = 1, target = 48): LessonTokens {
  const dark = app.dark;
  const away = dark ? '#ffffff' : '#000000';
  const ground = app.ground;
  const card = dark ? mix(ground, app.ink, 0.08) : mix(ground, '#ffffff', 0.6);
  const soft = mix(ground, app.accent, dark ? 0.2 : 0.12);
  const surfaces = [ground, card, soft];
  const ink = reads(app.ink, surfaces, away);
  const dim = reads(app.dim, surfaces, away);
  const accent = reads(app.accent, surfaces, away);
  const onAccent = [app.onAccent, '#ffffff', '#000000'].find((c) => contrastRatio(c, accent) >= 4.5) ?? (contrastRatio('#ffffff', accent) > contrastRatio('#000000', accent) ? '#ffffff' : '#000000');
  const goodSoft = mix(ground, app.good, dark ? 0.22 : 0.14);
  const nudgeSoft = mix(ground, app.bad, dark ? 0.2 : 0.12);
  return {
    ground,
    card,
    ink,
    dim,
    accent,
    onAccent,
    soft,
    line: reads(app.line, [ground, card], away, 1.6),
    good: reads(app.good, [goodSoft, ground, card], away),
    goodSoft,
    nudge: ink,
    nudgeSoft,
    font: app.font,
    dark,
    radius: app.radius,
    scale,
    target,
  };
}
