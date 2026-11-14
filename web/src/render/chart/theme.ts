// A look, as a chart wears it (DESIGN.md "Charts"). Pure: a LookSpec in, a ChartTheme out. The chart has no
// colour, size or face of its own; everything it shows comes through here, already in the look's gamut and
// past the contrast rule.

import type { Face } from '@conduit/language';
import type { ChartTheme } from '../../contracts/chart';
import type { Colour } from '../../contracts/frame';
import type { LookSpec } from '../../contracts/look';
import type { Viewport } from '../../contracts/space';
import { FACES } from '../../fonts/faces';
import { fontFor } from '../../fonts';
import { enforceInGamut, fromHsl, mix, toHsl, worstContrast } from '../../looks/colour-math';
import { cellOf } from '../../painter/layout/metrics';

/** The faces a chart is set in: a poster face is unreadable at label size, so it reads in the plain sans. */
const CHART_FACE: Readonly<Record<Face, Face>> = { serif: 'serif', sans: 'sans', hand: 'hand', display: 'sans', mono: 'mono', terminal: 'terminal', teletext: 'teletext', dot: 'dot' };

/** The looks whose machine had no antialiasing or no curves. */
const HARD_FACES: ReadonlySet<Face> = new Set<Face>(['terminal', 'teletext', 'dot']);

const SERIES_CONTRAST = 3;

/** The least a chart's text is ever set at, CSS pixels: below it a tick label is a smudge (A6). */
export const LEAST_LABEL_PX = 11;
/** A hand face is set larger: its strokes are thin. */
const LEAST_HAND_PX = 14;
/** The size words are in the stage's own steps: the title is `s` and a label is `xs`, so the title is this many times a label. */
export const TITLE_OVER_LABEL = 0.8 / 0.64;

/** What a screen of 1280x720 is, for a caller that has no viewport to hand (the bench, an export). */
const DESK: Viewport = { width: 1280, height: 720, dpr: 1 };

/**
 * The chart's label size on this stage: the stage's own `xs` at this viewport and in this look, so a chart reads at
 * the scale of the words round it, and never under 11 CSS pixels. The title (`s`, bold) and a mark's words (`xs`,
 * in ink) are set from it: `fontPx * TITLE_OVER_LABEL` and `fontPx`.
 */
export function labelPx(look: LookSpec, viewport: Viewport): number {
  const least = look.type.face === 'hand' ? LEAST_HAND_PX : LEAST_LABEL_PX;
  return Math.max(least, Math.round(cellOf('xs', viewport, look).fontSize));
}

export function chartThemeOf(look: LookSpec, viewport: Viewport = DESK): ChartTheme {
  const { ground, ink, dim, accent } = look.roles;
  const grounds = look.groundAlt === null ? [ground] : [ground, look.groundAlt];
  const fit = (colour: Colour, minimum: number): Colour => enforceInGamut(colour, grounds, minimum, look.gamut);
  const face = CHART_FACE[look.type.face];

  // reduced weight: a step toward the ground, kept at 4.5:1
  const text = fit(mix(ink, ground, 0.12), 4.5);
  // a hairline: a fifth of the way from the ground to the ink, off the machine's ramp on purpose (a ramp's lowest step is far louder)
  const hairline = mix(ground, ink, 0.2);

  const series = seriesColours(look, fit);
  const [up, down] = candleColours(look, fit);

  return {
    ground,
    ink: text,
    grid: hairline,
    crosshair: dim,
    series,
    up,
    down,
    accent,
    face,
    fontFamily: fontFor(FACES[face].font).family,
    fontPx: labelPx(look, viewport),
    hard: HARD_FACES.has(look.type.face) || look.id === 'pixel',
  };
}

/** Accent, alt, then steps round the hue from them; in a one-phosphor look, steps of brightness; in a fixed palette, its other members. */
function seriesColours(look: LookSpec, fit: (c: Colour, m: number) => Colour): readonly Colour[] {
  const { ground, accent, alt } = look.roles;
  const out: Colour[] = [];
  const add = (colour: Colour): void => {
    const c = fit(colour, SERIES_CONTRAST);
    if (!out.includes(c) && worstContrast(c, [ground]) >= SERIES_CONTRAST - 0.01) out.push(c);
  };
  add(accent);
  add(alt);
  const g = look.gamut;
  if (g.kind === 'palette') {
    for (const member of g.colours) add(member);
  } else if (g.kind === 'mono') {
    for (const t of [1, 0.78, 0.6, 0.88, 0.7]) add(mix(g.low, g.high, t));
  } else {
    const [h, s, l] = toHsl(accent);
    const [h2] = toHsl(alt);
    for (const step of [150, 210, 60, 270]) {
      const hue = (step < 100 ? h2 : h) + step / 360;
      add(fromHsl(hue % 1, Math.max(0.45, s), Math.min(0.62, Math.max(0.4, l))));
    }
  }
  // a short list is cycled: a sixth series is never drawn, but a look with few colours still answers
  let i = 0;
  while (out.length < 5) {
    out.push(out[i % Math.max(1, out.length)] ?? accent);
    i += 1;
  }
  return out;
}

/** Up and down are told apart by more than hue: the adapter draws an up candle hollow. Hue still helps where the look has some. */
function candleColours(look: LookSpec, fit: (c: Colour, m: number) => Colour): readonly [Colour, Colour] {
  const g = look.gamut;
  if (g.kind === 'mono') return [fit(mix(g.low, g.high, 1), SERIES_CONTRAST), fit(mix(g.low, g.high, 0.62), SERIES_CONTRAST)];
  if (g.kind === 'palette') return [fit('#00ff00', SERIES_CONTRAST), fit('#ff0000', SERIES_CONTRAST)];
  return [fit(fromHsl(0.38, 0.55, 0.45), SERIES_CONTRAST), fit(fromHsl(0.01, 0.62, 0.5), SERIES_CONTRAST)];
}
