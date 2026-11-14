import type { CameraMove, CameraSpan } from '@conduit/language';
import type { MoodCharacter } from '../contracts/look';
import { MAX_DOLLY, REST_POSE, restDistance } from '../contracts/space';
import type { CameraPose, Viewport } from '../contracts/space';
import { ease, quantise } from './ease';

/**
 * How far each move travels at amount=1. Dolly is a share of the rest
 * distance, truck a share of the viewport width, angles are radians, shake a
 * share of the viewport height.
 */
/** The camera's idle sway from the mood. Off: the owner found it made them dizzy. */
const CAMERA_SWAYS = false;

export const CAMERA_TRAVEL: Readonly<Record<CameraMove, { readonly dolly: number; readonly truck: number; readonly yaw: number; readonly shake: number }>> = {
  push: { dolly: 0.18, truck: 0, yaw: 0, shake: 0 },
  pull: { dolly: -0.25, truck: 0, yaw: 0, shake: 0 },
  pan: { dolly: 0, truck: 0.35, yaw: 0, shake: 0 },
  drift: { dolly: 0, truck: 0.06, yaw: 0, shake: 0 },
  orbit: { dolly: 0, truck: 0, yaw: 0.14, shake: 0 },
  focus: { dolly: 0.12, truck: 0, yaw: 0, shake: 0 },
  shake: { dolly: 0, truck: 0, yaw: 0, shake: 0.012 },
  rest: { dolly: 0, truck: 0, yaw: 0, shake: 0 },
};

/** With reduced motion every move travels this share of its distance, and shake travels none. */
export const REDUCED_MOTION_TRAVEL = 0.35;

export interface CameraContext {
  readonly viewport: Viewport;
  /** the mood as it is blended now: its lean, agitation and the like. Its sway is NOT read; see `sway` */
  readonly mood: MoodCharacter;
  /**
   * The sway is a sine of ambient time, so its period must never be blended
   * (a sine with a sweeping period chirps). The offset is computed for each
   * of these characters on its own and the offsets are added with these
   * weights (which sum to 1): the outgoing and incoming mood across a mood
   * change, and the outgoing and incoming look across a look change.
   */
  readonly sway: readonly { readonly mood: MoodCharacter; readonly weight: number }[];
  readonly reducedMotion: boolean;
  /** frames per second the look samples the camera at; null is smooth */
  readonly step: number | null;
  /** the centre of a focus target on its plane at a time, or null if it is not on stage */
  readonly centreOf: (key: string, time: number) => { readonly x: number; readonly y: number } | null;
  /** how large a drawn target is on the reading plane at a time, stage units; null for text and for what is not there */
  readonly sizeOf: (key: string, time: number) => { readonly width: number; readonly height: number } | null;
  /** whether the key is a drawn element */
  readonly isDrawn: (key: string) => boolean;
  /** whether the scene open at a time has a picture: a pan then has its room, not the text's */
  readonly hasPicture: (time: number) => boolean;
  /** index of the scene open at a time; moves alternate direction with it */
  readonly sceneIndexAt: (time: number) => number;
  /**
   * What the scene open at a time leaves room for: the furthest the camera may
   * dolly before text reaches 16 px from an edge, and how far it may truck
   * sideways and up at a given dolly.
   */
  readonly roomAt: (time: number, dolly: number) => { readonly maxDolly: number; readonly x: number; readonly y: number };
  /**
   * Whether every element of every layer the scene open at `time` ever shows
   * stays at least 16 px inside the edge at `pose`, projected exactly (so it
   * covers orbit parallax on the near and far planes), with the sway and, if
   * `withLean`, the scene's strongest lean included. Drifting words count
   * with the amplitude they are allowed.
   */
  readonly fits: (time: number, pose: CameraPose, withLean: boolean) => boolean;
  /** the strongest lean any mood of the scene open at `time` has, as a share of the rest distance */
  readonly sceneLean: (time: number) => number;
  /** the time the scene open at `time` began */
  readonly sceneStartAt: (time: number) => number;
}

/** Seconds over which the mood's lean is allowed to follow a change of room at a scene boundary. */
const ROOM_BLEND_SECONDS = 0.6;

const MIN_DOLLY = -0.6;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function lerpPose(a: CameraPose, b: CameraPose, t: number): CameraPose {
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    dolly: lerp(a.dolly, b.dolly, t),
    yaw: lerp(a.yaw, b.yaw, t),
    pitch: lerp(a.pitch, b.pitch, t),
    roll: lerp(a.roll, b.roll, t),
  };
}

/** Where a move ends up when it begins from `from`. */
function destination(move: CameraSpan, from: CameraPose, context: CameraContext): CameraPose {
  const wanted = rawDestination(move, from, context);
  if (move.move === 'rest' || move.move === 'shake') return wanted;
  // A close-up on a drawing is as free as the words allow: it stops where resting text (labels included) would leave the safe frame.
  return confine(from, wanted, move.start, context);
}

/** Share of the viewport a pan may carry the camera from the middle when there is a picture to look at. */
const PICTURE_PAN_SHARE = 0.45;
/** Share of the viewport a focused drawn thing is framed to fill. */
const FOCUS_FILL = 0.6;
const FOCUS_ZOOM = { min: 1.15, max: 1.8 } as const;

/**
 * The furthest along the way from `from` to `to` that keeps every element of
 * the scene inside the safe frame, found on the exact projection. A move that
 * would leave the frame stops short of it; it is never what clips the text.
 */
function confine(from: CameraPose, to: CameraPose, time: number, context: CameraContext): CameraPose {
  if (context.fits(time, to, true)) return to;
  if (!context.fits(time, from, true)) return to.dolly < from.dolly ? to : from;
  let low = 0;
  let high = 1;
  for (let i = 0; i < 12; i += 1) {
    const mid = (low + high) / 2;
    if (context.fits(time, lerpPose(from, to, mid), true)) low = mid;
    else high = mid;
  }
  return lerpPose(from, to, low);
}

function rawDestination(move: CameraSpan, from: CameraPose, context: CameraContext): CameraPose {
  const travel = CAMERA_TRAVEL[move.move];
  const reach = (context.reducedMotion ? REDUCED_MOTION_TRAVEL : 1) * move.amount;
  const rest = restDistance(context.viewport);
  const sign = context.sceneIndexAt(move.start) % 2 === 0 ? 1 : -1;
  const room = context.roomAt(move.start, from.dolly);
  const reserved = context.sceneLean(move.start) * rest;
  // A push stops short of clipping the text; it never pulls the camera back to do so.
  const pushed = (extra: number): number => {
    const wanted = clamp(from.dolly + extra, MIN_DOLLY * rest, MAX_DOLLY * rest);
    return extra > 0 ? Math.min(wanted, Math.max(from.dolly, room.maxDolly - reserved)) : wanted;
  };
  switch (move.move) {
    case 'push':
    case 'pull':
      return { ...from, dolly: pushed(travel.dolly * rest * reach) };
    case 'drift':
      return { ...from, x: clamp(from.x + sign * travel.truck * context.viewport.width * reach, -room.x, room.x) };
    case 'pan': {
      // The text's room keeps words inside the safe frame; a scene with a picture has the picture's room instead.
      const picture = context.hasPicture(move.start);
      const roomX = picture ? Math.max(room.x, PICTURE_PAN_SHARE * context.viewport.width) : room.x;
      const roomY = picture ? Math.max(room.y, PICTURE_PAN_SHARE * context.viewport.height) : room.y;
      const along = move.direction === 'left' ? -1 : move.direction === 'right' ? 1 : 0;
      const down = move.direction === 'up' ? -1 : move.direction === 'down' ? 1 : 0;
      return {
        ...from,
        x: clamp(from.x + along * travel.truck * context.viewport.width * reach, -roomX, roomX),
        y: clamp(from.y + down * travel.truck * context.viewport.height * reach, -roomY, roomY),
      };
    }
    case 'orbit':
      return { ...from, yaw: sign * travel.yaw * reach };
    case 'focus': {
      const centre = move.target === null ? null : context.centreOf(move.target, move.start);
      const size = move.target === null ? null : context.sizeOf(move.target, move.start);
      if (centre !== null && size !== null && size.width > 0 && size.height > 0) {
        // A drawn thing is framed: pushed in until its box fills about three fifths of the screen, never less than a nudge and never more than a close-up.
        const fill = Math.min((FOCUS_FILL * context.viewport.width) / size.width, (FOCUS_FILL * context.viewport.height) / size.height);
        const zoom = clamp(fill, FOCUS_ZOOM.min, FOCUS_ZOOM.max);
        const framed = clamp(from.dolly + rest * (1 - 1 / zoom) * reach, MIN_DOLLY * rest, MAX_DOLLY * rest);
        const halfW = Math.max(context.viewport.width / 2 - 16, 0);
        const halfH = Math.max(context.viewport.height / 2 - 16, 0);
        return { ...from, x: lerp(from.x, clamp(centre.x, -halfW, halfW), reach), y: lerp(from.y, clamp(centre.y, -halfH, halfH), reach), dolly: framed };
      }
      const dolly = pushed(travel.dolly * rest * reach);
      if (centre === null) return { ...from, dolly };
      const after = context.roomAt(move.start, dolly);
      return { ...from, x: lerp(from.x, clamp(centre.x, -after.x, after.x), reach), y: lerp(from.y, clamp(centre.y, -after.y, after.y), reach), dolly };
    }
    case 'rest':
      return REST_POSE;
    case 'shake':
      return from;
  }
}

/** The pose after the first `count` moves of the chain, at `time`. Each move begins from where the chain was at its own start. */
function chainAt(moves: readonly CameraSpan[], count: number, time: number, context: CameraContext): CameraPose {
  let latest = -1;
  for (let i = 0; i < count; i += 1) {
    const move = moves[i];
    if (move !== undefined && move.start <= time) latest = i;
  }
  const move = moves[latest];
  if (move === undefined) return REST_POSE;
  const from = chainAt(moves, latest, move.start, context);
  const to = destination(move, from, context);
  const length = move.end - move.start;
  const progress = length <= 0 ? 1 : clamp((time - move.start) / length, 0, 1);
  return lerpPose(from, to, ease('in-out', progress));
}

/**
 * The camera at a time. Each move eases from wherever the camera was when it
 * began, so moves chain without a jump; `rest` eases home. The mood's sway
 * rides on top, driven by ambient time, so the camera is never dead still
 * while the stage holds.
 */
export function cameraAt(moves: readonly CameraSpan[], time: number, ambient: number, context: CameraContext): CameraPose {
  const t = quantise(time, context.step);
  const a = quantise(ambient, context.step);
  const { viewport, mood, reducedMotion } = context;
  const chain = moves.filter((move) => move.move !== 'shake').sort((p, q) => p.start - q.start);
  const base = chainAt(chain, chain.length, t, context);

  let shakeX = 0;
  let shakeY = 0;
  let shakeRoll = 0;
  if (!reducedMotion) {
    for (const move of moves) {
      if (move.move !== 'shake' || t < move.start || t >= move.end) continue;
      const p = (t - move.start) / Math.max(1e-6, move.end - move.start);
      const decay = (1 - p) ** 2;
      const size = CAMERA_TRAVEL.shake.shake * viewport.height * move.amount * decay;
      const u = t - move.start;
      shakeX += size * Math.sin(u * 61 + move.seq);
      shakeY += size * 0.7 * Math.sin(u * 47 + 1.3 * move.seq);
      shakeRoll += size * 0.0004 * Math.sin(u * 37);
    }
  }

  let swayX = 0;
  let swayY = 0;
  // The owner: "stop the swaying motion, it's making me dizzy". The camera no longer sways on its own; motion the brain asks for still plays.
  if (!reducedMotion && CAMERA_SWAYS) {
    const swayOf = (m: MoodCharacter): { x: number; y: number } => {
      if (m.swayPeriod <= 0) return { x: 0, y: 0 };
      const phase = (2 * Math.PI * a) / m.swayPeriod;
      return { x: m.sway * viewport.height * Math.sin(phase), y: m.sway * viewport.height * 0.6 * Math.sin(phase * 0.73 + 1) };
    };
    for (const part of context.sway) {
      const offset = swayOf(part.mood);
      swayX += offset.x * part.weight;
      swayY += offset.y * part.weight;
    }
  }

  const rest = restDistance(viewport);
  // The lean is the one thing added to the dolly without a move, so it asks the room: it takes what fits.
  const leanWanted = mood.lean * rest;
  const leanFor = (at: number): number => {
    if (leanWanted <= 0) return leanWanted;
    const probe = (lean: number): boolean => context.fits(at, { ...base, dolly: base.dolly + lean }, false);
    if (probe(leanWanted)) return leanWanted;
    let low = 0;
    let high = leanWanted;
    if (!probe(0)) return 0;
    for (let i = 0; i < 10; i += 1) {
      const mid = (low + high) / 2;
      if (probe(mid)) low = mid;
      else high = mid;
    }
    return low;
  };
  // Across a scene boundary the room changes at once; the lean follows it over a moment so the picture does not step.
  const sceneStart = context.sceneStartAt(t);
  let lean = leanFor(t);
  const since = t - sceneStart;
  if (sceneStart > 0 && since < ROOM_BLEND_SECONDS) lean = lerp(leanFor(sceneStart - 1e-6), lean, ease('out', since / ROOM_BLEND_SECONDS));
  return {
    x: base.x + shakeX + swayX,
    y: base.y + shakeY + swayY,
    dolly: clamp(base.dolly + lean, MIN_DOLLY * rest, MAX_DOLLY * rest),
    yaw: base.yaw,
    pitch: base.pitch,
    roll: base.roll + shakeRoll,
  };
}
