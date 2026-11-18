// pnpm check's motion group (PLAN-motion step 2, the bench half): the painter performing motion that keeps time, read from the frames' own transforms. No browser, no model.
//
//   drawing      a frame with no clock is the drawing, and so is one at the clock's zero
//   spin         a spin about a point lands on the exact points at every quarter of its period, and on 360 x frac(T / period) at T of a hundred thousand
//   system       a moon about an earth about a sun at T = 1000: the moon is its drawn radius from the earth, the earth its drawn radius from the sun, both angles 360 x frac(T / period)
//   hands        a minute hand turns 12 times as fast as an hour hand: at T = 1000 and T = 100000 the minute angle is 12 x the hour angle, mod 360
//   gears        12 and 36 teeth, periods 4 and -12: they stay in mesh
//   pendulum     a group that sways about its `at=`, and `amp=` and `phase=`
//   ride         a closed outline is back at its start at T = P and opposite at P/2, an open one is at its far end at P/2, a rider keeps its drawn offset, three ways of writing it are one
//   pivot        a turn about a pivot is the whole turn (the style's `rot=` too, bound or written), and a pivot that names nothing is none
//   carrier      what a pivot does to its own centre carries what turns about it, up to eight links and not round a ring, and a name may come before its thing
//   film         a film's clock is a unit a second from its scene's start, or the time slider's value; a rate (a toggle or a slider) scales it; reduced motion holds it at rest
//   decoration   a loop with no period is as it always was, on the ambient clock
//
// The page's half is `web/src/bench/motion-bench.ts` (the real timeline and the real film). Every expectation here is worked out with plain trigonometry from the lines as written,
// not with the language's own `motion.ts`, so the two cannot be wrong in the same way. Run by `pnpm check` and standalone (`tsx motion-check.ts`).

import type { CheckResult } from './smoke';
import { spawnTracked } from '../brains/claude-cli/process';
import { repoRoot } from './explore-browser';

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
  readonly T?: number | null;
  readonly ambient?: number;
  readonly time?: number;
  readonly controls?: Readonly<Record<string, number | boolean>>;
  readonly reduced?: boolean;
}
interface Read {
  readonly probe: Probe;
  readonly poses: Readonly<Record<string, Pose | null>>;
  readonly skew: number;
}
interface Capture {
  readonly name: string;
  readonly lines: readonly string[];
  readonly sceneStarts: readonly number[];
  readonly reads: readonly Read[];
}

async function capture(): Promise<Capture[]> {
  const child = spawnTracked('pnpm', ['--filter', '@conduit/language', 'exec', 'tsx', '--import', '../web/src/bench/node-register.mjs', '../web/src/bench/motion-bench.ts'], undefined, { cwd: repoRoot(), quiet: false });
  let out = '';
  let err = '';
  child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (err += chunk.toString()));
  const code = await new Promise<number | null>((done) => child.once('close', done));
  if (code !== 0) throw new Error(`the page's motion bench stopped (${code}): ${err.slice(-800)}`);
  return JSON.parse(out.slice(out.indexOf('['))) as Capture[];
}

// ---------------------------------------------------------------------------
// Plain arithmetic, written here and not borrowed from the language.

type P = readonly [number, number];
const frac = (x: number): number => x - Math.floor(x);
const mod = (x: number, size: number): number => ((x % size) + size) % size;
const rad = (degrees: number): number => (degrees * Math.PI) / 180;
/** a point turned `degrees` clockwise on a screen (y down) about a pivot */
const turned = (p: P, pivot: P, degrees: number): P => {
  const dx = p[0] - pivot[0];
  const dy = p[1] - pivot[1];
  return [pivot[0] + dx * Math.cos(rad(degrees)) - dy * Math.sin(rad(degrees)), pivot[1] + dx * Math.sin(rad(degrees)) + dy * Math.cos(rad(degrees))];
};
const plus = (a: P, b: P): P => [a[0] + b[0], a[1] + b[1]];
const minus = (a: P, b: P): P => [a[0] - b[0], a[1] - b[1]];
const dist = (a: P, b: P): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
/** the angle of the vector from `a` to `b`, degrees clockwise from the +x axis, in [0, 360) */
const angle = (a: P, b: P): number => mod((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI, 360);
/** how far two angles are apart round a circle of `size` */
const apart = (a: number, b: number, size = 360): number => Math.abs(mod(a - b + size / 2, size) - size / 2);

const TOLERANCE = 1e-6;

class Judge {
  readonly problems: string[] = [];
  tally = 0;
  constructor(readonly area: string) {}
  /** `got` against `want`, in canvas units, to `tolerance` */
  at(what: string, got: P | null, want: P, tolerance = TOLERANCE): void {
    this.tally += 1;
    if (got === null) this.problems.push(`${what}: not in the frame`);
    else if (dist(got, want) > tolerance) this.problems.push(`${what}: at ${got[0].toFixed(7)},${got[1].toFixed(7)}, wanted ${want[0].toFixed(7)},${want[1].toFixed(7)} (off by ${dist(got, want).toExponential(2)})`);
  }
  num(what: string, got: number, want: number, tolerance = TOLERANCE): void {
    this.tally += 1;
    if (!(Math.abs(got - want) <= tolerance)) this.problems.push(`${what}: ${got}, wanted ${want} (off by ${Math.abs(got - want).toExponential(2)})`);
  }
  yes(what: string, condition: boolean): void {
    this.tally += 1;
    if (!condition) this.problems.push(what);
  }
}

const centre = (pose: Pose | null | undefined): P | null => (pose === null || pose === undefined ? null : [pose.cx, pose.cy]);
const first = (pose: Pose | null | undefined): P | null => (pose === null || pose === undefined ? null : [pose.fx, pose.fy]);
const last = (pose: Pose | null | undefined): P | null => (pose === null || pose === undefined ? null : [pose.lx, pose.ly]);
const label = (read: Read): string => (read.probe.how === 'direct' ? `T=${read.probe.T === null || read.probe.T === undefined ? 'none' : read.probe.T}${read.probe.ambient === undefined ? '' : ` ambient=${read.probe.ambient}`}` : `film ${JSON.stringify({ time: read.probe.time, ...read.probe.controls, ...(read.probe.reduced === true ? { reduced: true } : {}) })}`);

export interface MotionVerdict {
  readonly check: string;
  readonly problems: readonly string[];
  readonly detail: string;
}

/** Judges the bench's readings; one verdict an area. Exported so a scratch edit of the painter can be shown to fail. */
export function motionVerdicts(captures: readonly Capture[]): MotionVerdict[] {
  const byName = new Map(captures.map((one) => [one.name, one]));
  const get = (name: string): Capture => {
    const found = byName.get(name);
    if (found === undefined) throw new Error(`the bench has no case "${name}"`);
    return found;
  };
  const out: MotionVerdict[] = [];
  const done = (judge: Judge, detail: string): void => {
    out.push({ check: `motion-${judge.area}`, problems: judge.problems, detail });
  };
  const skew = new Judge('map');
  for (const one of captures) for (const read of one.reads) skew.num(`${one.name} ${label(read)}: the two rulers say canvas to stage is a plain scale`, read.skew, 0, 1e-9);

  // a frame with no clock is the drawing, and the clock's zero is the drawing
  {
    const j = new Judge('drawing');
    const drawn: Record<string, P> = { sun: [80, 45], earth: [110, 45], moon: [118, 45] };
    for (const read of get('drawing').reads) for (const [id, at] of Object.entries(drawn)) j.at(`drawing ${label(read)} ${id}`, centre(read.poses[id]), at, 1e-9);
    // and in every case that has one, a frame with no clock stands everything where it was written
    const written: Record<string, Record<string, P>> = {
      'spin-about-a-point': { p: [60, 45], q: [60, 60], r: [60, 30] },
      'ride-closed': { dot: [110, 45], off: [110, 48] },
      'ride-open': { car: [20, 80], van: [20, 77] },
      pendulum: { bob: [50, 40] },
      gears: { m1: [56, 45], m2: [56, 45] },
      hands: { hour: [80, 39], minute: [80, 36] },
      'moon-about-earth-about-sun': { sun: [80, 45], earth: [110, 45], moon: [118, 45] },
      'carrier-chain': { e10: [110, 45], e9: [100, 20], e2: [93, 20], e1: [92, 20] },
      'carrier-ring': { a: [60, 45], b: [90, 45] },
    };
    for (const [name, ids] of Object.entries(written)) {
      for (const read of get(name).reads.filter((candidate) => candidate.probe.how === 'direct' && (candidate.probe.T === null || candidate.probe.T === undefined))) for (const [id, at] of Object.entries(ids)) j.at(`${name} with no clock: ${id}`, centre(read.poses[id]), at, 1e-9);
    }
    done(j, `${j.tally} things at the written place in a frame with no clock (and at T = 0), to 1e-9`);
  }

  // a spin about a point
  {
    const j = new Judge('spin');
    const cases: { id: string; at: P; period: number; phase: number }[] = [
      { id: 'p', at: [60, 45], period: 4, phase: 0 },
      { id: 'q', at: [60, 60], period: -4, phase: 0 },
      { id: 'r', at: [60, 30], period: 4, phase: 0.25 },
    ];
    for (const read of get('spin-about-a-point').reads) {
      const T = read.probe.T;
      if (T === null || T === undefined) continue;
      for (const c of cases) j.at(`spin ${label(read)} ${c.id}`, centre(read.poses[c.id]), turned(c.at, [40, 45], 360 * frac(T / c.period + c.phase)));
    }
    // the four exact points, to 1e-9
    const exact: [number, P][] = [[0, [60, 45]], [1, [40, 65]], [2, [20, 45]], [3, [40, 25]], [4, [60, 45]], [5, [40, 65]]];
    for (const [T, at] of exact) j.at(`spin quarter T=${T}`, centre(get('spin-about-a-point').reads.find((read) => read.probe.T === T)?.poses['p']), at, 1e-9);
    done(j, `a point turned about another, with periods 4 and -4 and a phase, at T from 0 to 100000.25: ${j.tally} readings to 1e-6, the four quarters to 1e-9`);
  }

  // a moon about an earth about a sun
  {
    const j = new Judge('system');
    for (const read of get('moon-about-earth-about-sun').reads) {
      const T = read.probe.T;
      if (T === null || T === undefined) continue;
      const earthAngle = 360 * frac(T / 3.7);
      const moonAngle = 360 * frac(T / -0.31);
      const earth = turned([110, 45], [80, 45], earthAngle);
      const moon = plus(earth, turned([8, 0], [0, 0], moonAngle));
      j.at(`system ${label(read)} sun stands`, centre(read.poses['sun']), [80, 45]);
      j.at(`system ${label(read)} earth`, centre(read.poses['earth']), earth);
      j.at(`system ${label(read)} moon`, centre(read.poses['moon']), moon);
      const e = centre(read.poses['earth']);
      const m = centre(read.poses['moon']);
      if (e !== null && m !== null) {
        j.num(`system ${label(read)} the moon is its drawn radius from the earth`, dist(m, e), 8);
        j.num(`system ${label(read)} the earth is its drawn radius from the sun`, dist(e, [80, 45]), 30);
        j.num(`system ${label(read)} the earth's angle is 360 x frac(T / period)`, apart(angle([80, 45], e), earthAngle), 0, 1e-6);
        j.num(`system ${label(read)} the moon's angle about the earth is 360 x frac(T / period)`, apart(angle(e, m), moonAngle), 0, 1e-6);
      }
    }
    const before = get('carried-before-it-is-written');
    for (const read of before.reads) {
      const T = read.probe.T ?? 0;
      const earth = turned([110, 45], [80, 45], 360 * frac(T / 3.7));
      j.at(`written before its planet ${label(read)} earth`, centre(read.poses['earth']), earth);
      j.at(`written before its planet ${label(read)} moon`, centre(read.poses['moon']), plus(earth, turned([8, 0], [0, 0], 360 * frac(T / -0.31))));
    }
    done(j, `a moon about an earth about a sun at T = 0 to 123456.789, and written before its planet: ${j.tally} readings, radii and angles to 1e-6`);
  }

  // clock hands
  {
    const j = new Judge('hands');
    for (const read of get('hands').reads) {
      const T = read.probe.T;
      if (T === null || T === undefined) continue;
      const hour = 360 * frac(T / 43200);
      const minute = 360 * frac(T / 3600);
      const pivot: P = [80, 45];
      j.at(`hands ${label(read)} the hour hand's inner end stays on the pivot`, first(read.poses['hour']), pivot);
      j.at(`hands ${label(read)} the minute hand's inner end stays on the pivot`, first(read.poses['minute']), pivot);
      j.at(`hands ${label(read)} hour tip`, last(read.poses['hour']), turned([80, 33], pivot, hour));
      j.at(`hands ${label(read)} minute tip`, last(read.poses['minute']), turned([80, 27], pivot, minute));
      j.at(`hands ${label(read)} hour middle`, centre(read.poses['hour']), turned([80, 39], pivot, hour));
      const h = last(read.poses['hour']);
      const m = last(read.poses['minute']);
      if (h !== null && m !== null) j.num(`hands ${label(read)} the minute angle is 12 x the hour angle, mod 360 (degrees)`, apart(angle(pivot, m) + 90, 12 * (angle(pivot, h) + 90)), 0, 1e-6);
    }
    for (const T of [1000, 100000]) j.yes(`hands: the bench read T=${T}`, get('hands').reads.some((read) => read.probe.T === T));
    done(j, `${j.tally} readings: tips on the exact angles, inner ends fixed, and the minute angle 12 x the hour angle at T = 1000 and 100000`);
  }

  // gears in mesh
  {
    const j = new Judge('gears');
    for (const read of get('gears').reads) {
      const T = read.probe.T;
      if (T === null || T === undefined) continue;
      const a1 = 360 * frac(T / 4);
      const a2 = 360 * frac(T / -12);
      const m1 = centre(read.poses['m1']);
      const m2 = centre(read.poses['m2']);
      j.at(`gears ${label(read)} small gear's tooth`, m1, plus([50, 45], turned([6, 0], [0, 0], a1)));
      j.at(`gears ${label(read)} large gear's tooth`, m2, plus([74, 45], turned([-18, 0], [0, 0], a2)));
      if (m1 !== null && m2 !== null) {
        const t1 = mod(angle([50, 45], m1), 360);
        const t2 = mod(angle([74, 45], m2) - 180, 360);
        // one tooth of the small gear is 30 degrees and one of the large is 10: they are in mesh when the large gear's place in its tooth is a third of the small one's in its own
        const inTooth1 = mod(t1, 30);
        const inTooth2 = mod(-t2, 10);
        j.num(`gears ${label(read)} in mesh: a third of the small gear's place in its tooth is the large gear's (in degrees)`, apart(inTooth2, inTooth1 / 3, 10), 0, 1e-6);
      }
    }
    done(j, `12 and 36 teeth, periods 4 and -12, ${j.tally} readings to T = 1000: the markers where the turns put them, and in mesh to 1e-6 of a degree`);
  }

  // a pendulum, amp and phase
  {
    const j = new Judge('pendulum');
    for (const read of get('pendulum').reads) {
      const T = read.probe.T;
      if (T === null || T === undefined) continue;
      j.at(`pendulum ${label(read)}`, centre(read.poses['bob']), turned([50, 40], [50, 10], 20 * Math.sin((2 * Math.PI * frac(T / 2)))));
    }
    for (const read of get('amp-and-phase').reads) {
      const T = read.probe.T ?? 0;
      const c = frac(T / 2);
      j.at(`amp ${label(read)} the sway line's inner end stays on its pivot`, first(read.poses['s']), [60, 10]);
      j.at(`amp ${label(read)} the sway line's tip, amp=30`, last(read.poses['s']), turned([60, 30], [60, 10], 30 * Math.sin(2 * Math.PI * c)));
      j.at(`amp ${label(read)} bob amp=5`, centre(read.poses['b']), [90, 45 - 5 * Math.sin(2 * Math.PI * c)]);
      j.at(`amp ${label(read)} phase=0.25 bob`, centre(read.poses['h']), [130, 45 - 5 * Math.sin(2 * Math.PI * frac(c + 0.25))]);
      const p = read.poses['p'];
      if (p !== null && p !== undefined) j.num(`amp ${label(read)} pulse amp=0.5 (radius 4)`, p.cy - p.fy, 4 * (1 + 0.5 * (0.5 - 0.5 * Math.cos(2 * Math.PI * c))));
    }
    done(j, `a group that sways about its at= (amp 20, period 2), a line swaying about its end at amp 30, a bob, a pulse and a phase: ${j.tally} readings`);
  }

  // rides
  {
    const j = new Judge('ride');
    const closed = get('ride-closed');
    // a polygon of N sides stands inside its circle by R(1 - cos(pi / N)), so the places that are not vertices are right to that much
    const sag = 0.06;
    for (const read of closed.reads) {
      const T = read.probe.T;
      if (T === null || T === undefined) continue;
      const c = frac(T / 8);
      const dot = centre(read.poses['dot']);
      const on = (cycle: number): P => [80 + 30 * Math.cos(2 * Math.PI * cycle), 45 + 30 * Math.sin(2 * Math.PI * cycle)];
      // the rider is drawn on the track at its start, so it is on the circle, c of a lap round it (clockwise on the screen), to a polygon's sag
      j.at(`ride ${label(read)} the closed rider`, dot, on(c), sag);
      // a rider drawn off the track keeps the offset it was drawn at from the nearest place on it, whichever way the track runs there
      const phi = Math.atan2(3, 30) / (2 * Math.PI);
      const start = on(phi);
      const there = on(phi + c);
      j.at(`ride ${label(read)} the closed rider drawn 3 off the track keeps its offset`, centre(read.poses['off']), plus(there, minus([110, 48], start)), sag);
    }
    for (const [T, at] of [[0, [110, 45]], [4, [50, 45]], [8, [110, 45]], [16, [110, 45]], [20, [50, 45]], [-2, [80, 15]]] as [number, P][]) {
      j.at(`ride closed T=${T} on a vertex (back at its start at T = P, opposite at P/2)`, centre(closed.reads.find((read) => read.probe.T === T)?.poses['dot']), at, 1e-6);
    }
    const open = get('ride-open');
    for (const read of open.reads) {
      const T = read.probe.T;
      if (T === null || T === undefined) continue;
      // there and back: the share along the road is 2c up to a half, then 2 - 2c
      const c = frac(T / 8);
      const share = c <= 0.5 ? 2 * c : 2 - 2 * c;
      j.at(`ride ${label(read)} the open rider`, centre(read.poses['car']), [20 + 120 * share, 80], 1e-6);
      j.at(`ride ${label(read)} the open rider drawn 3 above the road`, centre(read.poses['van']), [20 + 120 * share, 77], 1e-6);
    }
    j.at('ride open T=4 (P/2) is at the far end', centre(open.reads.find((read) => read.probe.T === 4)?.poses['car']), [140, 80], 1e-9);
    j.at('ride open T=8 (P) is back at the start', centre(open.reads.find((read) => read.probe.T === 8)?.poses['car']), [20, 80], 1e-9);
    // written three ways: the shape's own line, a `set`, and `move x along= period=`; and `along=none` stops one
    const three = get('ride-written-three-ways');
    for (const read of three.reads) {
      const a = centre(read.poses['a']);
      for (const id of ['b', 'c']) if (a !== null) j.at(`ride ${label(read)} "${id}" rides as "a" does`, centre(read.poses[id]), a, 1e-9);
      j.at(`ride ${label(read)} a ride stopped by along=none stands where it was drawn`, centre(read.poses['d']), [110, 45], 1e-9);
      if (read.probe.T !== null && read.probe.T !== undefined && read.probe.T > 0) j.yes(`ride ${label(read)} "a" has moved`, a !== null && dist(a, [110, 45]) > 1);
    }
    done(j, `a closed ride is back at its start at T = P and opposite at P/2, an open one at its far end at P/2 and back at P, a rider keeps its drawn offset, three ways of writing it ride as one and along=none stops it: ${j.tally} readings`);
  }

  // a pivot turns the whole turn
  {
    const j = new Judge('pivot');
    for (const read of get('pivot-whole-turn').reads) {
      const T = read.probe.T;
      const spin = T === null || T === undefined ? 0 : 360 * frac(T / 4);
      j.at(`pivot ${label(read)} rot=90 about a point is a quarter turn of the centre`, centre(read.poses['a']), [40, 65], 1e-9);
      j.at(`pivot ${label(read)} rot=90 and a spin: the whole turn goes about the pivot`, centre(read.poses['b']), turned([60, 45], [40, 45], 90 + spin), 1e-9);
      j.at(`pivot ${label(read)} rot=90 with no pivot turns about its own centre`, centre(read.poses['c']), [60, 45], 1e-9);
    }
    for (const read of get('pivot-bound-rot').reads) {
      const value = read.probe.controls?.['s'];
      if (typeof value !== 'number') continue;
      j.at(`pivot bound rot, the slider at ${value}: the blended turn goes about the pivot`, centre(read.poses['a']), turned([60, 45], [40, 45], 90 * value), 1e-9);
    }
    for (const read of get('around-nothing').reads) j.at(`around=ghost ${label(read)} is no pivot: it turns about its own centre`, centre(read.poses['a']), [60, 45], 1e-9);
    for (const read of get('group-in-a-group-pivot').reads) {
      const T = read.probe.T ?? 0;
      j.at(`part ${label(read)} the hub of its group stands`, centre(read.poses['hub']), [40, 40], 1e-9);
      j.at(`part ${label(read)} one part turns about another in the group's own units`, centre(read.poses['arm']), turned([50, 40], [40, 40], 360 * frac(T / 4)), 1e-9);
    }
    done(j, `a turn about a pivot is the whole turn, the style's rot= (written or bound) and the loop's together: ${j.tally} readings to 1e-9`);
  }

  // the carrier
  {
    const j = new Judge('carrier');
    const chain = get('carrier-chain');
    for (const read of chain.reads) {
      const T = read.probe.T;
      if (T === null || T === undefined) continue;
      const c = frac(T / 8);
      const rider: P = [80 + 30 * Math.cos(2 * Math.PI * c), 45 + 30 * Math.sin(2 * Math.PI * c)];
      const e10 = centre(read.poses['e10']);
      j.at(`chain ${label(read)} the root rides`, e10, rider, 0.06);
      if (e10 === null) continue;
      const D = minus(e10, [110, 45]);
      j.at(`chain ${label(read)} e9 is carried (1 link)`, centre(read.poses['e9']), plus([100, 20], D), 1e-6);
      j.at(`chain ${label(read)} e2 is carried (8 links)`, centre(read.poses['e2']), plus([93, 20], D), 1e-6);
      j.at(`chain ${label(read)} e1 is not (9 links: stopped at eight)`, centre(read.poses['e1']), [92, 20], 1e-9);
    }
    const ring = get('carrier-ring');
    for (const read of ring.reads) {
      const T = read.probe.T ?? 0;
      const turn = 360 * frac(T / 4);
      // each turns about the other's DRAWN centre: a ring has no carrier, so nothing hangs and nothing runs away
      j.at(`ring ${label(read)} a`, centre(read.poses['a']), turned([60, 45], [90, 45], turn), 1e-9);
      j.at(`ring ${label(read)} b`, centre(read.poses['b']), turned([90, 45], [60, 45], turn), 1e-9);
    }
    done(j, `the root of a chain rides and the seven below it are carried by it exactly (8 links), the ninth link is not carried, and a ring of two turns each about the other's drawn centre: ${j.tally} readings`);
  }

  // the film
  {
    const j = new Judge('film');
    const spin = (T: number): P => turned([60, 45], [40, 45], 360 * frac(T / 4));
    for (const read of get('film-clock').reads) j.at(`film ${label(read)}: a unit a second from the start of the scene`, centre(read.poses['p']), spin(read.probe.time ?? 0), 1e-6);
    const rate = get('film-rate').reads;
    for (const read of rate) j.at(`film ${label(read)}: a toggle that is the rate, on is one a second, off is none`, centre(read.poses['p']), spin(read.probe.controls?.['run'] === true ? (read.probe.time ?? 0) : 0), 1e-6);
    for (const read of get('film-rate-slider').reads) j.at(`film ${label(read)}: a slider that is the rate`, centre(read.poses['p']), spin((read.probe.controls?.['speed'] as number) * (read.probe.time ?? 0)), 1e-6);
    for (const read of get('film-time-slider').reads) j.at(`film ${label(read)}: the time slider is the clock, wherever the film is`, centre(read.poses['p']), spin(read.probe.controls?.['t'] as number), 1e-6);
    for (const read of get('film-time-slider-and-rate').reads) j.at(`film ${label(read)}: with both, the slider's value is the clock`, centre(read.poses['p']), spin(read.probe.controls?.['t'] as number), 1e-6);
    for (const read of get('film-reduced').reads) j.at(`film ${label(read)}: reduced motion holds the clock at rest (zero, or the slider's value)`, centre(read.poses['p']), spin((read.probe.controls?.['t'] as number | undefined) ?? 0), 1e-6);
    const two = get('film-two-scenes');
    const second = two.sceneStarts[1] ?? 0;
    j.yes('film two scenes: the second scene opens after the first', second > 0);
    for (const read of two.reads) j.at(`film ${label(read)}: the clock starts again at zero when a scene opens (this one at ${second.toFixed(4)} s)`, centre(read.poses['p2']), spin((read.probe.time ?? 0) - second), 1e-6);
    done(j, `a film's clock is a unit a second from its scene's start, or the time slider's value; a rate scales it (a toggle, a slider); reduced motion holds it at rest: ${j.tally} readings`);
  }

  // decoration is as it was
  {
    const j = new Judge('decoration');
    for (const read of get('decoration').reads) {
      const a = read.probe.ambient ?? 0;
      j.at(`decoration ${label(read)} bob (1.2 units in 1.8 s)`, centre(read.poses['b']), [40, 45 - 1.2 * Math.sin((2 * Math.PI * a) / 1.8)]);
      const spinAngle = (360 * a) / 6;
      j.at(`decoration ${label(read)} spin (a turn in 6 s) first end`, first(read.poses['s']), turned([60, 45], [65, 45], spinAngle));
      j.at(`decoration ${label(read)} spin last end`, last(read.poses['s']), turned([70, 45], [65, 45], spinAngle));
      const swayAngle = 4 * Math.sin((2 * Math.PI * a) / 3.2);
      j.at(`decoration ${label(read)} sway (4 degrees in 3.2 s) first end`, first(read.poses['w']), turned([90, 45], [95, 45], swayAngle));
      j.at(`decoration ${label(read)} sway last end`, last(read.poses['w']), turned([100, 45], [95, 45], swayAngle));
      const theta = (2 * Math.PI * a) / 9;
      j.at(`decoration ${label(read)} drift`, centre(read.poses['d']), [120 + 1.6 * Math.sin(theta), 45 + 1.6 * 0.5 * Math.sin(2 * theta)]);
    }
    done(j, `a loop with no period=: bob, spin, sway and drift by the numbers they always had, on the ambient clock, whatever T is: ${j.tally} readings`);
  }
  done(skew, `the two rulers of every frame agree on one scale (${skew.tally} frames)`);
  return out;
}

/** The group as `pnpm check` runs it: one result a kind of motion. */
export async function motionGroup(note: (text: string) => void = () => undefined): Promise<CheckResult[]> {
  note('motion');
  try {
    return motionVerdicts(await capture()).map((verdict) => ({ turn: 0, check: verdict.check, verdict: verdict.problems.length === 0 ? 'PASS' : 'FAIL', detail: verdict.problems.length === 0 ? verdict.detail : verdict.problems.slice(0, 8).join('; ') }));
  } catch (error) {
    return [{ turn: 0, check: 'motion', verdict: 'FAIL', detail: `stopped: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}` }];
  }
}

if (process.argv[1] !== undefined && /motion-check\.ts$/.test(process.argv[1])) {
  motionGroup((text) => process.stdout.write(`${text}\n`)).then((results) => {
    for (const result of results) process.stdout.write(`${result.verdict} ${result.check}: ${result.detail}\n`);
    process.exit(results.every((result) => result.verdict === 'PASS') ? 0 : 1);
  });
}
