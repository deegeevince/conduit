// A hand on a drawn thing works a slider (PLAN-depth.md, D1): the solver that finds the value keeping a thing nearest the finger, for one slider and for two.
// Run by `pnpm timeline` (through `spaceChecks`). Pure: the pose is a function the check writes, so there is no drawing and no pointer here.
import { nearestPair, nearestValue } from '../src/handle';
import type { HandleRange } from '../src/handle';
import { turnAbout } from '../src/motion';
import { lift, project, turn } from '../src/space';
import type { Point } from '../src/types';

/** A small seeded generator, so a check that draws 200 cases draws the same 200 every run. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIVOT: Point = { x: 50, y: 50 };
const ARM: Point = { x: 80, y: 50 };

/** A thing 30 units out from a pivot, turned by the slider's value in degrees. */
const spin = (degrees: number): Point => turnAbout(ARM, PIVOT, degrees);

/** The angle between two bearings, 0 to 180. */
function apart(a: number, b: number): number {
  const gap = (((a - b) % 360) + 360) % 360;
  return Math.min(gap, 360 - gap);
}

export function handleChecks(): boolean {
  let ok = true;
  const expect = (what: string, got: unknown, want: unknown): void => {
    if (got !== want) {
      ok = false;
      process.stdout.write(`  HANDLE CHECK FAILED: ${what} (got ${String(got)}, wanted ${String(want)})\n`);
    }
  };
  const within = (what: string, got: number, want: number, tolerance: number): void => {
    if (!(Math.abs(got - want) <= tolerance)) {
      ok = false;
      process.stdout.write(`  HANDLE CHECK FAILED: ${what} (got ${got}, wanted ${want}, to ${tolerance})\n`);
    }
  };
  /** A pose that counts how often it is asked, so a check can hold the solver to its budget. */
  const counted = (pose: (v: number) => Point): { pose: (v: number) => Point; calls: () => number } => {
    let calls = 0;
    return { pose: (v) => ((calls += 1), pose(v)), calls: () => calls };
  };
  let most = 0;
  const solve = (pose: (v: number) => Point, target: Point, range: HandleRange, from: number): number => {
    const measured = counted(pose);
    const value = nearestValue(measured.pose, target, range, from);
    most = Math.max(most, measured.calls());
    return value;
  };

  const free: HandleRange = { min: 0, max: 360, step: null };

  // One slider that turns a thing about a pivot: 90 degrees is found to within 0.1, from anywhere, and so is every other bearing.
  {
    for (const from of [0, 10, 200, 359]) within(`a hand at 90 degrees gives 90 (the slider stands at ${from})`, solve(spin, spin(90), free, from), 90, 0.1);
    for (const degrees of [0, 1, 45, 90, 179, 180, 181, 270, 359]) {
      const got = solve(spin, spin(degrees), free, 200);
      within(`a hand at ${degrees} degrees`, apart(got, degrees), 0, 0.1);
    }
    // a finger beside the ring, not on it: the nearest place on the ring
    within('a finger outside the ring, towards 120 degrees', apart(solve(spin, { x: 50 + 45 * Math.cos((120 * Math.PI) / 180), y: 50 + 45 * Math.sin((120 * Math.PI) / 180) }, free, 0), 120), 0, 0.1);
    within('a finger inside the ring, towards 250 degrees', apart(solve(spin, { x: 50 + 8 * Math.cos((250 * Math.PI) / 180), y: 50 + 8 * Math.sin((250 * Math.PI) / 180) }, free, 0), 250), 0, 0.1);
  }

  // The lap: a slider of 0 to 1080 reaches 90 degrees at 90, 450 and 810, and the one nearest where it stands is the answer.
  {
    const laps: HandleRange = { min: 0, max: 1080, step: null };
    const cases: readonly [number, number][] = [[400, 450], [100, 90], [800, 810], [0, 90], [1080, 810], [600, 450], [700, 810], [260, 90], [280, 450]];
    for (const [from, want] of cases) within(`a 0-1080 slider at ${from}, the hand at 90 degrees, gives ${want}`, solve(spin, spin(90), laps, from), want, 0.1);
    expect('the plan\'s case: a 0-1080 slider standing at 400 gives 450, not 90', Math.round(solve(spin, spin(90), laps, 400)), 450);
    const whole: HandleRange = { min: 0, max: 1080, step: 1 };
    expect('the same on a slider of whole degrees is exactly 450', solve(spin, spin(90), whole, 400), 450);
    expect('and 810 from 700', solve(spin, spin(90), whole, 700), 810);
    expect('a step of 10: the hand at 94 (454 round) is on 450, the nearer step', solve(spin, spin(94), { min: 0, max: 1080, step: 10 }, 400), 450);
    // a time slider of three years, a lap a year: it stays in its lap
    const orbit = (years: number): Point => turnAbout(ARM, PIVOT, 360 * years);
    const years: HandleRange = { min: 0, max: 3, step: 0.01 };
    for (const [from, want] of [[2.4, 2.1], [0.4, 0.1], [1.4, 1.1], [1.7, 2.1], [2.95, 2.1]] as const) {
      expect(`a time slider of 3 years standing at ${from}, the Earth where it is at 0.1 years, gives ${want}`, solve(orbit, orbit(0.1), years, from), want);
    }
    // few enough steps are all tried, and the nearest of equals wins
    const coarse: HandleRange = { min: 0, max: 3, step: 0.05 };
    for (const [from, want] of [[2.4, 2.1], [0.4, 0.1], [1.4, 1.1]] as const) {
      expect(`the same with 61 steps, all tried, standing at ${from}`, solve(orbit, orbit(0.1), coarse, from), want);
    }
  }

  // A thing that moves along a wire: the answer is where the wire is nearest the finger, and never off the slider.
  {
    const wire = (v: number): Point => ({ x: 10 + 0.8 * v, y: 20 + 0.3 * v });
    const range: HandleRange = { min: 0, max: 100, step: null };
    const next = seeded(3);
    let worst = 0;
    for (let i = 0; i < 60; i += 1) {
      const target = { x: next() * 120 - 10, y: next() * 70 };
      const along = ((target.x - 10) * 0.8 + (target.y - 20) * 0.3) / (0.8 * 0.8 + 0.3 * 0.3);
      const want = Math.min(100, Math.max(0, along));
      worst = Math.max(worst, Math.abs(solve(wire, target, range, next() * 100) - want));
    }
    within('a bead on a wire: 60 fingers, each found to 0.001 of the slider', worst, 0, 1e-3);
    expect('past the far end it stays at the end', Math.abs(solve(wire, { x: 200, y: 100 }, range, 10) - 100) < 1e-3, true);
    expect('past the near end it stays at the start', Math.abs(solve(wire, { x: -50, y: -10 }, range, 90)) < 1e-3, true);
    // steps: only the steps there are, inside the ends, and the best of them
    const stepped: HandleRange = { min: 0, max: 100, step: 5 };
    let off = 0;
    let wrong = 0;
    for (let i = 0; i < 60; i += 1) {
      const target = { x: next() * 120 - 10, y: next() * 70 };
      const got = solve(wire, target, stepped, next() * 100);
      if (got % 5 !== 0 || got < 0 || got > 100) off += 1;
      let best = 0;
      for (let v = 0; v <= 100; v += 5) if (Math.hypot(wire(v).x - target.x, wire(v).y - target.y) < Math.hypot(wire(best).x - target.x, wire(best).y - target.y)) best = v;
      if (Math.abs(Math.hypot(wire(got).x - target.x, wire(got).y - target.y) - Math.hypot(wire(best).x - target.x, wire(best).y - target.y)) > 1e-9) wrong += 1;
    }
    expect('steps of 5 are all respected, inside the ends', off, 0);
    expect('and each is the best of the 21 there are', wrong, 0);
    const tenths: HandleRange = { min: 0, max: 100, step: 0.1 };
    const got = solve(wire, { x: 10 + 0.8 * 33.3, y: 20 + 0.3 * 33.3 }, tenths, 50);
    expect('a step of 0.1 gives 33.3, with no dust on it', got, 33.3);
    expect('a slider whose ends are one value is that value', nearestValue(wire, { x: 5, y: 5 }, { min: 7, max: 7, step: null }, 7), 7);
    expect('a slider given the wrong way round is read the right way round', Math.abs(nearestValue(wire, wire(40), { min: 100, max: 0, step: null }, 90) - 40) < 1e-3, true);
  }

  // Near first, but not stuck: out and back, the nearer of two equal places; a hairpin, the nearer lane unless the other is really nearer.
  {
    const range: HandleRange = { min: 0, max: 100, step: null };
    const outAndBack = (v: number): Point => ({ x: 50 - 40 * Math.cos((2 * Math.PI * v) / 100), y: 50 });
    const first = (100 * Math.acos(-0.25)) / (2 * Math.PI);
    within('out and back, from the first half: the first place', solve(outAndBack, { x: 60, y: 50 }, range, 20), first, 0.01);
    within('out and back, from the second half: the second place', solve(outAndBack, { x: 60, y: 50 }, range, 80), 100 - first, 0.01);
    const hairpin = (v: number): Point => (v <= 50 ? { x: v, y: 0 } : { x: 100 - v, y: 10 });
    within('a hairpin, the finger much nearer the far lane: the far lane', solve(hairpin, { x: 25, y: 12 }, range, 10), 75, 0.01);
    within('a hairpin, the finger as far from one lane as the other (5 and 5): it stays in its lane', solve(hairpin, { x: 25, y: 5 }, range, 10), 25, 0.01);
    within('a hairpin from the far lane stays there for the same finger', solve(hairpin, { x: 25, y: 5 }, range, 90), 75, 0.01);
    within('a hairpin, the finger a little nearer the far lane (4.9 and 5.1): the far lane', solve(hairpin, { x: 25, y: 5.1 }, range, 10), 75, 0.01);
  }

  // Random fingers: 300 on a ring read from a 0-360 slider, and 300 on a 0-1080 slider that must give the lap nearest where it stands.
  {
    const next = seeded(5);
    let worstRing = 0;
    let worstLap = 0;
    const laps: HandleRange = { min: 0, max: 1080, step: null };
    for (let i = 0; i < 300; i += 1) {
      const bearing = next() * 359.99 + 0.005;
      const reach = 5 + next() * 60;
      const target = { x: 50 + reach * Math.cos((bearing * Math.PI) / 180), y: 50 + reach * Math.sin((bearing * Math.PI) / 180) };
      worstRing = Math.max(worstRing, apart(solve(spin, target, free, next() * 360), bearing));
      const from = next() * 1080;
      const want = [bearing, bearing + 360, bearing + 720].sort((p, q) => Math.abs(p - from) - Math.abs(q - from))[0] ?? bearing;
      worstLap = Math.max(worstLap, Math.abs(solve(spin, target, laps, from) - want));
    }
    within('300 random fingers about a ring: the bearing is found to 0.05 degrees', worstRing, 0, 0.05);
    within('300 random fingers on a 0-1080 slider: always the lap nearest where it stands, to 0.05 degrees', worstLap, 0, 0.05);
  }
  expect(`one slider never takes more than 96 calls (the most was ${most})`, most <= 96, true);
  const asked = counted(spin);
  nearestValue(asked.pose, spin(90), { min: 0, max: 1080, step: null }, 400, 30);
  expect('a smaller budget is kept to: 30 calls asked, no more made', asked.calls() <= 30, true);
  const tiny = counted(spin);
  nearestValue(tiny.pose, spin(90), { min: 0, max: 1080, step: null }, 400, 3);
  expect('even 3 calls are kept to', tiny.calls() <= 3, true);

  // Two sliders: a point on a ball turned by a yaw and a pitch (an orbit by drag). The finger is found to 0.5 px in at most 256 calls.
  {
    const R = 120;
    const centre: Point = { x: 200, y: 160 };
    const yaws: HandleRange = { min: -180, max: 180, step: null };
    const pitches: HandleRange = { min: -90, max: 90, step: null };
    const ball = (lat: number, lon: number) => (yaw: number, pitch: number): Point => {
      const p = project(turn(lift({ x: lat, y: lon }, { kind: 'sphere', r: R }), { yaw, pitch, roll: 0 }));
      return { x: centre.x + p.x, y: centre.y + p.y };
    };
    const solvePair = (pose: (a: number, b: number) => Point, target: Point, ra: HandleRange, rb: HandleRange, from: readonly [number, number]): { value: [number, number]; calls: number } => {
      let calls = 0;
      const value = nearestPair((a, b) => ((calls += 1), pose(a, b)), target, ra, rb, from);
      return { value, calls };
    };
    const miss = (pose: (a: number, b: number) => Point, value: readonly [number, number], target: Point): number => Math.hypot(pose(value[0], value[1]).x - target.x, pose(value[0], value[1]).y - target.y);

    const cairo = ball(30, 31);
    const one = solvePair(cairo, cairo(40, 35), yaws, pitches, [0, 20]);
    within('a city dragged from yaw 0, pitch 20 to where it is at yaw 40, pitch 35: within 0.5 px', miss(cairo, one.value, cairo(40, 35)), 0, 0.5);
    within('and it found the yaw', one.value[0], 40, 0.05);
    within('and the pitch', one.value[1], 35, 0.05);

    // A hand takes hold of a point it can see, so a drag starts with the point facing you; the finger then goes up to 50 degrees either way on each slider.
    const next = seeded(11);
    let worst = 0;
    let calls = 0;
    let bad = 0;
    let measured = 0;
    for (let i = 0; i < 600; i += 1) {
      const lat = (next() - 0.5) * 150;
      const lon = (next() - 0.5) * 360;
      const pose = ball(lat, lon);
      const from: [number, number] = [(next() - 0.5) * 300, (next() - 0.5) * 120];
      const goal: [number, number] = [Math.max(-180, Math.min(180, from[0] + (next() - 0.5) * 100)), Math.max(-80, Math.min(80, from[1] + (next() - 0.5) * 100))];
      const target = pose(goal[0], goal[1]);
      const facing = turn(lift({ x: lat, y: lon }, { kind: 'sphere', r: R }), { yaw: from[0], pitch: from[1], roll: 0 }).z;
      if (facing < 0.2 * R || Math.hypot(target.x - centre.x, target.y - centre.y) > 0.97 * R) continue;
      measured += 1;
      const found = solvePair(pose, target, yaws, pitches, from);
      const off = miss(pose, found.value, target);
      worst = Math.max(worst, off);
      calls = Math.max(calls, found.calls);
      if (!(off <= 0.5)) bad += 1;
    }
    expect(`${measured} seeded drags of a point on a ball: every one within 0.5 px of the finger (the worst was ${worst.toFixed(4)} px)`, bad, 0);
    expect('and enough of the 600 were measured', measured >= 150, true);
    expect(`and none takes more than 256 calls (the most was ${calls})`, calls <= 256, true);

    // a finger past the edge of the ball: the nearest the point can be. On the equator that is the limb itself, 0.4 r away; for a city at 30 degrees north
    // it can come no further right than r cos 30 (the pitch turns it about the horizontal, so its x stays), and the answer is that far short of the finger.
    const far: Point = { x: centre.x + 1.4 * R, y: centre.y };
    const equatorial = ball(0, 20);
    const onLimb = solvePair(equatorial, far, yaws, pitches, [0, 0]);
    within('a finger past the limb, a point on the equator: it ends on the limb, 0.4 r from the finger, to 0.5 px', miss(equatorial, onLimb.value, far), 0.4 * R, 0.5);
    const short = solvePair(cairo, far, yaws, pitches, [0, 0]);
    within('a finger past the limb, a city at 30 north: as near as it can come, r cos 30 across, to 0.5 px', miss(cairo, short.value, far), 1.4 * R - R * Math.cos((30 * Math.PI) / 180), 0.5);
    expect('and the budget holds there too', Math.max(onLimb.calls, short.calls) <= 256, true);

    // whole degrees: integers inside the ends, and near enough (half a degree each is 1.3 px of a ball of 120)
    const whole = solvePair(cairo, cairo(40.4, 35.4), { min: -180, max: 180, step: 1 }, { min: -90, max: 90, step: 1 }, [0, 20]);
    expect('whole degrees give whole degrees', Number.isInteger(whole.value[0]) && Number.isInteger(whole.value[1]), true);
    expect('and near the finger: within 2 px', miss(cairo, whole.value, cairo(40.4, 35.4)) <= 2, true);
    expect('in 256 calls', whole.calls <= 256, true);

    // a slider that cannot move: only the other one does
    const pinned = solvePair(cairo, cairo(60, 20), yaws, { min: 20, max: 20, step: null }, [0, 20]);
    within('with the pitch pinned, only the yaw moves, and it finds it', pinned.value[0], 60, 0.05);
    expect('and the pitch stays where it is pinned', pinned.value[1], 20);
  }
  return ok;
}
