// Live apps on stage. An app is real HTML the brain wrote; the painter does not run it. It works out, for every app on stage, where its room
// is through the camera, whether its document is whole and may run, how far it is in or out, and the look as CSS variables, and hands the
// app host an `AppCue` for each (the way `chartFrames` hands the chart host a `ChartFrame`). Pure: (schedule, time, look) in, cues out.

import { appSourceOf, shelfOf, styleAt } from '@conduit/language';
import type { ElementSpan, Face, Schedule } from '@conduit/language';
import type { AppCue, AppTokens } from '../contracts/app';
import type { LookSpec } from '../contracts/look';
import { layerZ, planeScale, projectToScreen, REST_POSE } from '../contracts/space';
import type { Box, CameraPose, Viewport } from '../contracts/space';
import { chartThemeOf } from '../render/chart/theme';
import { contrastRatio, enforceInGamut, luminance, mix } from '../looks/colour-math';
import { clamp01 } from './affine';
import type { CanvasFit } from './canvas';
import { cellOf } from './layout/metrics';

export interface AppEnv {
  readonly viewport: Viewport;
  readonly camera: CameraPose;
  /** the turn is closed: an app that was the last thing said is whole */
  readonly closed: boolean;
  readonly fitOf: (element: ElementSpan) => CanvasFit;
  /** the room the stage plan gave the app at this instant, reading-plane stage units; null: it has none */
  readonly roomOf: (element: ElementSpan) => Box | null;
}

/** System faces only: the sandbox loads nothing, so a look's own font file cannot go with the app. */
const SANS = "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
const STACK: Readonly<Record<Face, string>> = {
  serif: "Georgia, 'Iowan Old Style', 'Times New Roman', serif",
  sans: SANS,
  hand: "'Segoe Print', 'Bradley Hand', 'Marker Felt', 'Comic Sans MS', cursive",
  display: SANS,
  mono: "ui-monospace, 'SF Mono', Menlo, Consolas, 'Courier New', monospace",
  terminal: "ui-monospace, 'SF Mono', Menlo, Consolas, 'Courier New', monospace",
  teletext: "ui-monospace, 'SF Mono', Menlo, Consolas, 'Courier New', monospace",
  dot: "ui-monospace, 'SF Mono', Menlo, Consolas, 'Courier New', monospace",
};

const tokens = new WeakMap<LookSpec, Map<string, AppTokens>>();

/** The look as an app wears it: the look's own colours through its gamut and the contrast rule, a system font stack, its corners and its rhythm. */
export function appTokensOf(look: LookSpec, viewport: Viewport): AppTokens {
  let bySize = tokens.get(look);
  if (bySize === undefined) {
    bySize = new Map();
    tokens.set(look, bySize);
  }
  const key = `${viewport.width}x${viewport.height}`;
  const kept = bySize.get(key);
  if (kept !== undefined) return kept;
  const theme = chartThemeOf(look, viewport);
  const { ground, accent } = look.roles;
  const grounds = look.groundAlt === null ? [ground] : [ground, look.groundAlt];
  const ink = theme.ink;
  const dim = enforceInGamut(mix(ink, ground, 0.32), grounds, 4.5, look.gamut);
  const strong = enforceInGamut(accent, grounds, 3, look.gamut);
  // the words on an action read against the action: the ground or the ink, whichever is clearer, else plain black or white
  const onAccent = [ground, ink, '#ffffff', '#000000'].reduce((best, candidate) => (contrastRatio(candidate, strong) > contrastRatio(best, strong) ? candidate : best), ground);
  const fontPx = Math.max(15, Math.min(18, Math.round(cellOf('m', viewport, look).fontSize)));
  const made: AppTokens = {
    ground,
    ink,
    dim,
    accent: strong,
    onAccent,
    alt: theme.series[1] ?? strong,
    line: theme.grid,
    good: theme.up,
    bad: theme.down,
    font: STACK[look.type.face],
    fontPx,
    radius: look.type.snapToCells ? 0 : Math.round(fontPx * 0.6),
    gap: Math.round(fontPx * 0.75),
    dark: luminance(ground) < 0.3,
  };
  bySize.set(key, made);
  return made;
}

const kept = new Map<string, { readonly signature: string; readonly cue: AppCue }>();
/** the document a figure's rows make, joined once: a figure is a new object whenever its rows change */
const sources = new WeakMap<object, string>();
function sourceOf(figure: Extract<NonNullable<ElementSpan['figure']>, { kind: 'structure' }>): string {
  let source = sources.get(figure);
  if (source === undefined) {
    source = appSourceOf(figure.rows);
    sources.set(figure, source);
  }
  return source;
}

/**
 * The scenes in which a live app is the whole answer: nothing else is drawn or placed there, and no words either. Such an app is the page: it takes the whole
 * stage, edge to edge, with no frame or caption drawn about it. An app beside other drawing, or beside the answer's words, is a block like any other: it
 * keeps the room the stage plan gives it and the words stay on stage beside it or above it, never under it.
 */
export function loneAppScenes(schedule: Schedule): ReadonlySet<string> {
  const lone = new Set<string>();
  const crowded = new Set<string>();
  for (const element of schedule.elements) {
    const app = element.figure?.kind === 'structure' && element.figure.structure === 'app';
    if (app) lone.add(element.scene);
    else crowded.add(element.scene);
  }
  for (const scene of crowded) lone.delete(scene);
  return lone;
}

export function appCues(schedule: Schedule, tq: number, look: LookSpec, env: AppEnv): AppCue[] {
  const out: AppCue[] = [];
  const live = new Set<string>();
  const alone = loneAppScenes(schedule);
  for (const element of schedule.elements) {
    const figure = element.figure;
    if (figure === null || figure.kind !== 'structure' || figure.structure !== 'app') continue;
    const enter = element.enter;
    if (!element.carried && (enter === null || tq < enter.start)) continue;
    const exit = element.exit;
    if (exit !== null && tq >= exit.end) continue;
    const ps = planeScale(element.style.layer, env.viewport);
    const given = env.roomOf(element);
    const fit = env.fitOf(element);
    const room: Box = alone.has(element.scene)
      ? { x: -env.viewport.width / ps / 2, y: -env.viewport.height / ps / 2, width: env.viewport.width / ps, height: env.viewport.height / ps }
      : given !== null
        ? { x: given.x / ps, y: given.y / ps, width: given.width / ps, height: given.height / ps }
        : figure.box === null
          ? { x: fit.box.x / ps, y: fit.box.y / ps, width: fit.box.width / ps, height: fit.box.height / ps }
          : { x: (fit.box.x + figure.box.x * fit.unit) / ps, y: (fit.box.y + figure.box.y * fit.unit) / ps, width: (figure.box.w * fit.unit) / ps, height: (figure.box.h * fit.unit) / ps };
    const z = layerZ(element.style.layer, env.viewport);
    const corner = (pose: CameraPose, x: number, y: number) => projectToScreen({ x, y, z }, pose, env.viewport);
    const a = corner(env.camera, room.x, room.y);
    const b = corner(env.camera, room.x + room.width, room.y + room.height);
    const ra = corner(REST_POSE, room.x, room.y);
    const rb = corner(REST_POSE, room.x + room.width, room.y + room.height);
    // The page is the stage, edge to edge down to the composer, whatever the camera is doing: it is never moved or sized by it.
    const page = alone.has(element.scene);
    const whole: Box = { x: 0, y: 0, width: env.viewport.width, height: env.viewport.height };
    const box: Box = page ? whole : { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
    const rest: Box = page ? whole : { x: Math.min(ra.x, rb.x), y: Math.min(ra.y, rb.y), width: Math.abs(rb.x - ra.x), height: Math.abs(rb.y - ra.y) };

    let opacity = 1;
    if (enter !== null && tq < enter.end) opacity = enter.end > enter.start ? clamp01((tq - enter.start) / (enter.end - enter.start)) : 1;
    if (exit !== null && tq >= exit.start) opacity *= exit.end > exit.start ? 1 - clamp01((tq - exit.start) / (exit.end - exit.start)) : 0;
    opacity *= styleAt(element, tq).opacity;
    if (opacity <= 0.001) continue;

    const last = figure.rows[figure.rows.length - 1]?.at ?? 0;
    const sealed = figure.sealed ?? null;
    // whole when a later line closed it (or the turn ended) and its last line has landed; what an earlier turn left was whole then
    const ready = element.carried || (tq >= last && (sealed === null ? env.closed : tq >= sealed));
    const source = ready ? sourceOf(figure) : '';
    const uses = ready ? shelfOf(figure.uses, source) : (figure.uses ?? []);
    const tokenSet = appTokensOf(look, env.viewport);
    const signature = [alone.has(element.scene) ? 'page' : '', uses.join('+'), source.length, ready ? 1 : 0, element.carried ? 1 : 0, element.text, element.id, opacity.toFixed(3), element.order, box.x.toFixed(1), box.y.toFixed(1), box.width.toFixed(1), box.height.toFixed(1), rest.x.toFixed(1), rest.y.toFixed(1), rest.width.toFixed(1), rest.height.toFixed(1)].join('|');
    live.add(element.key);
    const known = kept.get(element.key);
    if (known !== undefined && known.signature === signature && known.cue.tokens === tokenSet && known.cue.source === source) {
      out.push(known.cue);
      continue;
    }
    const cue: AppCue = { key: element.key, id: element.id, title: element.text, source, ...(uses.length > 0 && { uses }), ...(alone.has(element.scene) && { page: true }), ready, carried: element.carried, box, rest, opacity, layer: element.style.layer, z: element.order, tokens: tokenSet };
    kept.set(element.key, { signature, cue });
    out.push(cue);
  }
  if (kept.size > 32) for (const key of [...kept.keys()]) if (!live.has(key)) kept.delete(key);
  return out;
}
