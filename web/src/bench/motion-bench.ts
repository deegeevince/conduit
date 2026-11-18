// The painter performing motion that keeps time (PLAN-motion step 2), with no browser and no model: the real timeline and the real film, read back as data.
// Prints JSON for `server/src/tools/motion-check.ts` to judge: for each case, where named things stood (centres, and the two ends of a line) at chosen clock readings T.
//
//   tsx --import ./src/bench/node-register.mjs src/bench/motion-bench.ts        (from language/, as `pnpm check --only motion` does)
//
// Positions are read from the frames' own transforms, in the units the lines were written in. Every case draws two small rulers at known places, and the canvas-to-stage map
// is worked out from them in each frame, so nothing here knows how the page fits its canvas: a position is what a person would measure on the picture.
//
// Three ways to ask, each the real thing:
//   direct   the timeline asked at an instant that carries `motion: T` (or none: a frame with no clock, which is the drawing)
//   film     the film of the lines asked at a time: its clock is `rate x (time - the scene's start)`, or the time slider's value
//   (a film is also asked with controls, which is how a time slider or a rate is set)

import { EMPTY_STAGE, TurnScore, parseScript } from '@conduit/language';
import type { Line } from '@conduit/language';
import type { Frame, ShapeFrame } from '../contracts/frame';
import type { Viewport } from '../contracts/space';
import { noteArrivals } from '../painter/arrivals';
import { pinnedWallTime } from '../painter/clock';
import { createControlStore } from '../painter/controls';
import { createRuntime } from '../painter/bound';
import { createFilm } from '../painter/film';
import { buildTimeline } from '../painter/timeline';
import { CHARTS_READY } from '../render/chart';
import { apply } from '../painter/affine';

const VIEWPORT: Viewport = { width: 1280, height: 720, dpr: 1 };
/** a time at which every line has come in and settled */
const SETTLED = 30;
/** where the two rulers stand, in the canvas units the lines are written in: they say how the page maps canvas to stage */
const RULERS = { ra: { x: 8, y: 8 }, rb: { x: 152, y: 82 } } as const;
/** the look in which nothing wobbles, so that the two ends of a line are where they were drawn */
const STILL_LOOK = 'look blueprint';
const RULER_LINES = [`circle ra ${RULERS.ra.x},${RULERS.ra.y} 0.5 fill=dim`, `circle rb ${RULERS.rb.x},${RULERS.rb.y} 0.5 fill=dim`];

/** Where one shape stood: the middle of its outline, and the first and last points of its first polyline (the two ends of a line). */
interface Pose {
  readonly cx: number;
  readonly cy: number;
  readonly fx: number;
  readonly fy: number;
  readonly lx: number;
  readonly ly: number;
}

interface Probe {
  readonly how: 'direct' | 'film';
  /** direct: the clock reading handed to the timeline; null: the instant carries none */
  readonly T?: number | null;
  /** direct: the ambient time (default: the time) */
  readonly ambient?: number;
  /** film or direct: the time asked (default: a settled one) */
  readonly time?: number;
  /** film: what the hand holds */
  readonly controls?: Readonly<Record<string, number | boolean>>;
  readonly reduced?: boolean;
}

interface Case {
  readonly name: string;
  readonly lines: readonly string[];
  readonly probes: readonly Probe[];
  /** the ids to read */
  readonly ids: readonly string[];
}

interface Read {
  readonly probe: Probe;
  /** null: that id was not in the frame */
  readonly poses: Readonly<Record<string, Pose | null>>;
  /** how far the two rulers say the map from canvas to stage is from a plain scale (it must be none) */
  readonly skew: number;
}

const point = (x: number, y: number): string => `${x},${y}`;

/** Canvas-unit pose of a shape frame under the map the rulers give. */
function readFrame(frame: Frame, ids: readonly string[]): { poses: Record<string, Pose | null>; skew: number } {
  const stage = (shape: ShapeFrame): { c: { x: number; y: number }; first: { x: number; y: number }; last: { x: number; y: number } } => {
    const all = shape.outline.flatMap((line) => line.points.map((p) => apply(shape.transform, p)));
    const first = shape.outline[0]?.points ?? [];
    const c = { x: all.reduce((sum, p) => sum + p.x, 0) / all.length, y: all.reduce((sum, p) => sum + p.y, 0) / all.length };
    const a = first[0];
    const b = first[first.length - 1];
    return { c, first: a === undefined ? c : apply(shape.transform, a), last: b === undefined ? c : apply(shape.transform, b) };
  };
  const find = (id: string): ShapeFrame | undefined => frame.figures.find((figure): figure is ShapeFrame => figure.kind === 'shape' && figure.id === id);
  const ra = find('ra');
  const rb = find('rb');
  if (ra === undefined || rb === undefined) throw new Error('the rulers are not in the frame');
  const a = stage(ra).c;
  const b = stage(rb).c;
  // canvas -> stage is x' = ox + k x, y' = oy + k y (a camera at rest keeps the plane's shape), so one ruler pair gives it, and the two axes must agree on k
  const kx = (b.x - a.x) / (RULERS.rb.x - RULERS.ra.x);
  const ky = (b.y - a.y) / (RULERS.rb.y - RULERS.ra.y);
  const ox = a.x - kx * RULERS.ra.x;
  const oy = a.y - ky * RULERS.ra.y;
  const back = (p: { x: number; y: number }): { x: number; y: number } => ({ x: (p.x - ox) / kx, y: (p.y - oy) / ky });
  const poses: Record<string, Pose | null> = {};
  for (const id of ids) {
    const shape = find(id);
    if (shape === undefined) {
      poses[id] = null;
      continue;
    }
    const s = stage(shape);
    const c = back(s.c);
    const f = back(s.first);
    const l = back(s.last);
    poses[id] = { cx: c.x, cy: c.y, fx: f.x, fy: f.y, lx: l.x, ly: l.y };
  }
  return { poses, skew: Math.abs(kx - ky) / Math.abs(kx) };
}

function linesOf(lines: readonly string[]): readonly Line[] {
  const parsed = parseScript([STILL_LOOK, ...RULER_LINES, ...lines].join('\n'));
  if (parsed.rejects.length > 0) throw new Error(`a line was rejected: ${parsed.rejects.map((reject) => reject.raw).join(' | ')}`);
  return parsed.lines;
}

/** The timeline of the lines as the page builds it, to be asked at instants of our own. */
function timelineOf(lines: readonly Line[]): ReturnType<typeof buildTimeline> {
  const score = new TurnScore(EMPTY_STAGE, 'none');
  const arrivals = new Map<string, number>();
  lines.forEach((line, index) => {
    const result = score.push(line, index + 1, 0);
    noteArrivals(arrivals, result.schedule, 0);
  });
  return buildTimeline(score.schedule, EMPTY_STAGE, { viewport: VIEWPORT, reducedMotion: false, lockLook: null, paintings: new Map(), arrivals, controls: createRuntime(createControlStore()), charts: { kinds: CHARTS_READY, data: new Map() } });
}

/** When each scene of the lines opens, on the turn's clock: what a film's clock is counted from. */
function sceneStartsOf(lines: readonly Line[]): number[] {
  const score = new TurnScore(EMPTY_STAGE, 'none');
  lines.forEach((line, index) => score.push(line, index + 1, 0));
  return score.schedule.scenes.map((scene) => scene.start);
}

function run(one: Case): Read[] {
  const lines = linesOf(one.lines);
  const timeline = lines.length === 0 ? null : timelineOf(lines);
  return one.probes.map((probe): Read => {
    const time = probe.time ?? SETTLED;
    let frame: Frame;
    if (probe.how === 'direct') {
      if (timeline === null) throw new Error('no lines');
      const ambient = probe.ambient ?? time;
      frame = timeline.frameAt({ time, ambient, wallTime: pinnedWallTime(ambient), clock: 'paused', ...(probe.T === undefined || probe.T === null ? {} : { motion: probe.T }) });
    } else {
      const film = createFilm({ turn: 't1', base: EMPTY_STAGE, lines: lines.map((line, index) => ({ seq: index + 1, line })), paintings: {} }, { viewport: VIEWPORT, reducedMotion: probe.reduced === true, arrival: 'at-once', ...(probe.controls === undefined ? {} : { controls: probe.controls }) });
      frame = film.frameAt(time);
    }
    let found: ReturnType<typeof readFrame>;
    try {
      found = readFrame(frame, one.ids);
    } catch (error) {
      throw new Error(`${one.name} ${JSON.stringify(probe)}: ${error instanceof Error ? error.message : String(error)} (the frame has ${frame.figures.map((figure) => figure.id).join(' ')})`);
    }
    const { poses, skew } = found;
    return { probe, poses, skew };
  });
}

// ---------------------------------------------------------------------------
// The cases. Each is a picture of the kind the plan names; the judge knows what each must read.

const direct = (T: number | null, extra: Partial<Probe> = {}): Probe => ({ how: 'direct', T, ...extra });

/** a moon about an earth about a sun, as in the plan's example, each with a period of its own */
const SYSTEM = ['circle sun 80,45 6 fill=accent', 'circle earth 110,45 2.5 fill=#4f8fe0 loop=spin around=sun period=3.7', 'circle moon 118,45 1 fill=dim loop=spin around=earth period=-0.31'];

/** a clock: two hands, the minute hand 12 times quicker than the hour hand, each a line turning about its inner end */
const HANDS = ['circle face 80,45 20 stroke=dim fill=none', 'line hour 80,45 80,33 around=80,45 loop=spin period=43200', 'line minute 80,45 80,27 around=80,45 loop=spin period=3600'];

/** two gears that mesh: 12 and 36 teeth, so the small one turns three times round the big one's one, the other way */
const GEARS = ['group g1 at=50,45 loop=spin period=4', 'circle m1 6,0 0.8 in=g1', 'group g2 at=74,45 loop=spin period=-12', 'circle m2 -18,0 0.8 in=g2'];

/** a pendulum: a group that sways about its `at=` */
const PENDULUM = ['group pend at=50,10 loop=sway amp=20 period=2', 'circle bob 0,30 2 in=pend'];

const CASES: readonly Case[] = [
  {
    name: 'drawing',
    // a frame with no clock is the drawing, and so is one at the clock's zero
    lines: SYSTEM,
    ids: ['sun', 'earth', 'moon'],
    probes: [direct(null), direct(0), direct(null, { time: 6 })],
  },
  {
    name: 'spin-about-a-point',
    lines: ['circle p 60,45 1 loop=spin around=40,45 period=4', 'circle q 60,60 1 loop=spin around=40,45 period=-4', 'circle r 60,30 1 loop=spin around=40,45 period=4 phase=0.25'],
    ids: ['p', 'q', 'r'],
    probes: [null, 0, 1, 2, 3, 4, 5, 1000, 100000.25].map((T) => direct(T)),
  },
  {
    name: 'moon-about-earth-about-sun',
    lines: SYSTEM,
    ids: ['sun', 'earth', 'moon'],
    probes: [null, 0, 1, 1000, 123456.789].map((T) => direct(T)),
  },
  {
    name: 'hands',
    lines: HANDS,
    ids: ['hour', 'minute'],
    probes: [null, 0, 1000, 100000, 43200, 3600].map((T) => direct(T)),
  },
  {
    name: 'gears',
    lines: GEARS,
    ids: ['m1', 'm2'],
    probes: [null, 0, 1, 2, 4, 1000, 777.7].map((T) => direct(T)),
  },
  {
    name: 'pendulum',
    lines: PENDULUM,
    ids: ['bob'],
    probes: [null, 0, 0.5, 1, 1.5, 2, 1000.25].map((T) => direct(T)),
  },
  {
    name: 'ride-closed',
    // the rider is drawn on the track, and 3 units off it for the second one
    lines: ['circle track 80,45 30 stroke=dim fill=none', 'circle dot 110,45 1 along=track period=8', 'circle off 110,48 1 along=track period=8'],
    ids: ['dot', 'off'],
    probes: [null, 0, 1.234, 4, 8, 16, 20, -2].map((T) => direct(T)),
  },
  {
    name: 'ride-open',
    lines: ['line road 20,80 140,80 stroke=dim', 'circle car 20,80 1 along=road period=8', 'circle van 20,77 1 along=road period=8'],
    ids: ['car', 'van'],
    probes: [null, 0, 2, 4, 6, 8, 12, 1000.5].map((T) => direct(T)),
  },
  {
    name: 'ride-written-three-ways',
    // on the shape's own line, in a `set`, and as `move x along= period=`: the same ride
    lines: ['circle track 80,45 30 stroke=dim fill=none', 'circle a 110,45 1 along=track period=8', 'circle b 110,45 1', 'set b along=track period=8', 'circle c 110,45 1', 'move c along=track period=8', 'circle d 110,45 1 along=track period=8', 'set d along=none'],
    ids: ['a', 'b', 'c', 'd'],
    probes: [null, 0, 2.5, 5].map((T) => direct(T)),
  },
  {
    name: 'pivot-whole-turn',
    // a turn about a pivot is the whole turn: the style's own rot too, so rot=90 about (40,45) is a quarter turn of the centre, and with a spin of 90 more it is a half turn
    lines: ['circle a 60,45 1 rot=90 around=40,45', 'circle b 60,45 1 rot=90 around=40,45 loop=spin period=4', 'circle c 60,45 1 rot=90'],
    ids: ['a', 'b', 'c'],
    probes: [direct(null), direct(0), direct(1), direct(2)],
  },
  {
    name: 'pivot-bound-rot',
    // a bound `set` blends rot, and the blended turn goes about the pivot: the slider at 0.5 is a turn of 45 degrees
    lines: ['slider s 0 1 0 step=0.01 | Turn', 'circle a 60,45 1 around=40,45', 'bind s | set a rot=90'],
    ids: ['a'],
    probes: [0, 0.5, 1].map((value) => ({ how: 'film' as const, controls: { s: value } })),
  },
  {
    name: 'carrier-chain',
    // a moon carried by a planet that rides: the chain e1 -> ... -> e10 (e10 rides): e2 has 8 links to the ride and is carried, e1 has 9 and is not
    lines: ['circle track 80,45 30 stroke=dim fill=none', 'circle e10 110,45 1 along=track period=8', ...Array.from({ length: 9 }, (_, i) => `circle e${9 - i} ${point(100 - i, 20)} 0.5 around=e${10 - i}`)],
    ids: ['e10', 'e9', 'e2', 'e1'],
    probes: [null, 0, 2, 4].map((T) => direct(T)),
  },
  {
    name: 'carrier-ring',
    // two that name each other: nothing carries, nothing hangs, and each is turned about the other's drawn centre
    lines: ['circle a 60,45 1 around=b loop=spin period=4', 'circle b 90,45 1 around=a loop=spin period=4'],
    ids: ['a', 'b'],
    probes: [0, 1, 2].map((T) => direct(T)),
  },
  {
    name: 'carried-before-it-is-written',
    // the moon is written before the planet: it is looked up by id, every frame
    lines: ['circle moon 118,45 1 loop=spin around=earth period=-0.31', 'circle earth 110,45 2.5 around=sun loop=spin period=3.7', 'circle sun 80,45 6'],
    ids: ['earth', 'moon'],
    probes: [direct(0), direct(1000)],
  },
  {
    name: 'around-nothing',
    // an id that names nothing is no pivot: it spins about its own centre, so the centre does not move
    lines: ['circle a 60,45 1 around=ghost loop=spin period=4'],
    ids: ['a'],
    probes: [direct(0), direct(1)],
  },
  {
    name: 'decoration',
    // a loop with no period is as it always was, on the ambient clock: bob 1.2 units in 1.8 s, spin a turn in 6 s, sway 4 degrees in 3.2 s
    lines: ['circle b 40,45 1 loop=bob', 'line s 60,45 70,45 loop=spin', 'line w 90,45 100,45 loop=sway', 'circle d 120,45 1 loop=drift'],
    ids: ['b', 's', 'w', 'd'],
    probes: [direct(null, { ambient: 0 }), direct(null, { ambient: 0.45 }), direct(null, { ambient: 1.3 }), direct(null, { ambient: 100.7 }), direct(5, { ambient: 100.7 })],
  },
  {
    name: 'amp-and-phase',
    // amp= on a sway (a pendulum at 4 degrees is not a pendulum), on a bob, and phase= into the cycle at the clock's zero
    lines: ['line s 60,10 60,30 around=60,10 loop=sway amp=30 period=2', 'circle b 90,45 1 loop=bob amp=5 period=2', 'circle p 110,45 4 loop=pulse amp=0.5 period=2', 'circle h 130,45 1 loop=bob amp=5 period=2 phase=0.25'],
    ids: ['s', 'b', 'p', 'h'],
    probes: [0, 0.5, 1, 1.5].map((T) => direct(T)),
  },
  {
    name: 'film-clock',
    // a film's clock is a clock unit a second from the scene's start
    lines: ['circle p 60,45 1 loop=spin around=40,45 period=4'],
    ids: ['p'],
    probes: [12, 13, 14, 15.5].map((time) => ({ how: 'film' as const, time })),
  },
  {
    name: 'film-rate',
    // a toggle that is the rate: off, the clock is zero; on, a unit a second. A slider that is the rate: two units a second
    lines: ['toggle run on clock=rate | Running', 'circle p 60,45 1 loop=spin around=40,45 period=4'],
    ids: ['p'],
    probes: [{ how: 'film', time: 13, controls: { run: true } }, { how: 'film', time: 13, controls: { run: false } }],
  },
  {
    name: 'film-rate-slider',
    lines: ['slider speed 0 10 1 clock=rate | Speed', 'circle p 60,45 1 loop=spin around=40,45 period=4'],
    ids: ['p'],
    probes: [{ how: 'film', time: 13, controls: { speed: 2 } }, { how: 'film', time: 13, controls: { speed: 0 } }, { how: 'film', time: 13, controls: { speed: 1 } }],
  },
  {
    name: 'film-time-slider',
    // the time slider is the clock: periods are in its units, and where the film is in time does not matter
    lines: ['slider t 0 100000 0 step=0.01 clock=time | Time', 'circle p 60,45 1 loop=spin around=40,45 period=4'],
    ids: ['p'],
    probes: [{ how: 'film', time: 13, controls: { t: 1 } }, { how: 'film', time: 21, controls: { t: 1 } }, { how: 'film', time: 13, controls: { t: 2.5 } }, { how: 'film', time: 13, controls: { t: 1000.5 } }],
  },
  {
    name: 'film-time-slider-and-rate',
    // both: the film is a pure function of time and the slider's value is the clock
    lines: ['slider t 0 100 0 clock=time | Time', 'toggle run on clock=rate | Running', 'circle p 60,45 1 loop=spin around=40,45 period=4'],
    ids: ['p'],
    probes: [{ how: 'film', time: 13, controls: { t: 1, run: true } }, { how: 'film', time: 13, controls: { t: 1, run: false } }],
  },
  {
    name: 'film-reduced',
    // a film made for reduced motion is at rest: the clock does not run, so the movers stand where they were drawn
    lines: ['circle p 60,45 1 loop=spin around=40,45 period=4'],
    ids: ['p'],
    probes: [{ how: 'film', time: 13, reduced: true }, { how: 'film', time: 13, reduced: false }],
  },
  {
    name: 'film-reduced-slider',
    // and a time slider still moves everything, reduced motion or not
    lines: ['slider t 0 100 0 step=0.01 clock=time | Time', 'circle p 60,45 1 loop=spin around=40,45 period=4'],
    ids: ['p'],
    probes: [{ how: 'film', time: 13, reduced: true }, { how: 'film', time: 13, reduced: true, controls: { t: 1 } }],
  },
  {
    name: 'film-two-scenes',
    // the clock restarts at zero when a scene opens: a film asked 3 s into the second scene is at T = 3
    lines: ['circle p 60,45 1 loop=spin around=40,45 period=4', 'say a | A first scene, and a second.', 'scene two', ...RULER_LINES, 'circle p2 60,45 1 loop=spin around=40,45 period=4'],
    ids: ['p2'],
    probes: [{ how: 'film', time: 40 }, { how: 'film', time: 41 }],
  },
  {
    name: 'group-in-a-group-pivot',
    // two parts of one group, one turning about the other, in the group's own units, under a group that is itself moved
    lines: ['group box at=30,30', 'circle hub 10,10 2 in=box', 'circle arm 20,10 1 in=box loop=spin around=hub period=4'],
    ids: ['hub', 'arm'],
    probes: [0, 1, 2].map((T) => direct(T)),
  },
];

function main(): void {
  const out = CASES.map((one) => ({ name: one.name, lines: one.lines, sceneStarts: sceneStartsOf(linesOf(one.lines)), reads: run(one) }));
  console.log(JSON.stringify(out));
}

main();
