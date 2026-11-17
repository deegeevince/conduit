// Motion that keeps time (PLAN-motion.md): the words and their contract, then the pure arithmetic. Run by `pnpm timeline`.
import { EMPTY_STAGE, LineNormalizer, LineReader, parseLine, serializeLine, TurnScore } from '../src/index';
import type { Issue, Schedule } from '../src/index';
import { LOOP_DEFAULT, NO_OFFSET, clockAt, cycleAt, frac, loopOffset, openClock, pinnedClock, rebase, rideShare, turnAbout } from '../src/motion';
import { pointAlong } from '../src/geometry';

interface Played {
  readonly end: number;
  readonly pen: number;
  readonly issues: readonly string[];
  readonly serialized: readonly string[];
  readonly schedule: Schedule;
}

/** Plays lines as the server and the painter do: read, normalised, pushed at an estimated playhead of 0. */
function play(lines: readonly string[]): Played {
  const reader = new LineReader();
  let auto = 0;
  const normalizer = new LineNormalizer(() => `x${(auto += 1)}`);
  const score = new TurnScore(EMPTY_STAGE);
  const issues: string[] = [];
  const serialized: string[] = [];
  const note = (found: readonly Issue[]): void => {
    for (const issue of found) issues.push(`${issue.code}`);
  };
  let seq = 0;
  for (const raw of lines) {
    const read = reader.read(raw);
    if (read.kind === 'reject') {
      issues.push('reject');
      continue;
    }
    if (read.kind !== 'line') continue;
    note(read.issues);
    const normalized = normalizer.normalize(read.line);
    note(normalized.issues);
    for (const line of normalized.line === null ? [] : [normalized.line, ...(normalized.rest ?? [])]) {
      seq += 1;
      score.push(line, seq, 0);
      serialized.push(serializeLine(line));
    }
  }
  const schedule = score.schedule;
  for (const found of schedule.issues) issues.push(found.issue.code);
  return { end: schedule.end, pen: schedule.pen, issues, serialized, schedule };
}

export function motionChecks(): boolean {
  let ok = true;
  const expect = (what: string, got: unknown, want: unknown): void => {
    if (got !== want) {
      ok = false;
      process.stdout.write(`  MOTION CHECK FAILED: ${what} (got ${String(got)}, wanted ${String(want)})\n`);
    }
  };
  const has = (played: Played, code: string): number => played.issues.filter((issue) => issue === code).length;

  // Every new word survives parse, serialise and parse, with all its decimals.
  const words = [
    'circle moon 85,50 1 loop=spin around=earth period=-0.0748',
    'circle moon 85,50 1 phase=0.2408467 amp=0.00001234 period=0.0000001',
    'circle moon 85,50 1 around=10.5,20.25 period=123456789.123456',
    'group pend at=50,10 loop=sway amp=20 period=2',
    'circle sun 50,50 6 along=track period=27.3',
    'move train along=track period=8.123456789',
    'move train along=none',
    'set train along=track period=0.3333333333',
    'set train along=none',
    'slider yr 0 3 0 step=0.01 unit=yr clock=time | Years',
    'slider speed 0 10 1 clock=rate | Speed',
    'toggle run on clock=rate | Running',
  ];
  for (const text of words) {
    const first = parseLine(text);
    if (first.kind !== 'line') {
      expect(`parses: ${text}`, first.kind, 'line');
      continue;
    }
    const written = serializeLine(first.line);
    const second = parseLine(written);
    expect(`round trip keeps the line: ${text}`, second.kind === 'line' ? serializeLine(second.line) : 'does not parse', written);
    // every number written in the line comes back with its own digits
    for (const number of text.match(/(?:period|phase|amp)=-?[\d.]+/g) ?? []) expect(`digits kept: ${number}`, written.includes(number), true);
    expect(`no warning on a good line: ${text}`, first.issues.length, 0);
  }
  expect('a toggle takes clock=rate only', parseLine('toggle run on clock=time | Running').kind === 'line' && (parseLine('toggle run on clock=time | Running') as { issues: readonly Issue[] }).issues.length, 1);
  expect('period=0 is refused with a warning', (parseLine('circle a 1,1 2 period=0') as { issues: readonly Issue[] }).issues.some((issue) => issue.code === 'bad-value'), true);

  // The schedule: motion takes no time on the turn clock.
  const still = ['scene caption', 'circle sun 50,50 6 fill=accent', 'circle earth 80,50 2.5 fill=#4f8fe0', 'circle moon 85,50 1 fill=dim', 'say a | Hello'];
  const moving = ['scene caption', 'circle sun 50,50 6 fill=accent', 'circle earth 80,50 2.5 fill=#4f8fe0 loop=spin around=sun period=-1', 'circle moon 85,50 1 fill=dim loop=spin around=earth period=-0.0748', 'say a | Hello'];
  const base = play(still);
  const motion = play(moving);
  expect('movers add nothing to schedule.end', motion.end, base.end);
  expect('movers hold no pen', motion.pen, base.pen);
  expect('no issue for a moon about a planet about a sun', motion.issues.length, 0);
  const track = ['circle sun 50,50 6', 'path track stroke=dim | M10 50 q40 -40 80 0'];
  const before = play([...track, 'circle dot 10,50 1']);
  expect('set along= period= takes no time', play([...track, 'circle dot 10,50 1', 'set dot along=track period=8']).end, before.end);
  expect('move along= period= takes no time', play([...track, 'circle dot 10,50 1', 'move dot along=track period=8']).end, before.end);
  expect('a plain move along= still takes its pass', play([...track, 'circle dot 10,50 1', 'move dot along=track']).end > before.end, true);
  expect('same lines, same schedule', JSON.stringify(play(moving).end), JSON.stringify(motion.end));

  // The issues.
  expect('period= with nothing to time is a bad-value', has(play(['circle a 50,50 3 period=4']), 'bad-value'), 1);
  expect('period= with a loop is fine', has(play(['circle a 50,50 3 loop=spin period=4']), 'bad-value'), 0);
  expect('around= naming nothing is unknown-id', has(play(['circle a 50,50 3 around=ghost period=4']), 'unknown-id'), 1);
  expect('around= may name what comes later', has(play(['circle moon 85,50 1 around=earth period=4', 'circle earth 80,50 2 fill=dim']), 'unknown-id'), 0);
  expect('around= a point needs no one', play(['circle a 50,50 3 around=60,60 period=4']).issues.length, 0);
  expect('along= naming nothing is unknown-id', has(play(['circle a 50,50 3 along=ghost period=4']), 'unknown-id'), 1);
  expect('a top-level mover about a grouped pivot is bad-around', has(play(['group g at=20,20', 'circle earth 80,50 2 in=g', 'circle moon 85,50 1 loop=spin around=earth period=4']), 'bad-around'), 1);
  expect('two in the same group may turn about one another', has(play(['group g at=20,20', 'circle earth 80,50 2 in=g', 'circle moon 85,50 1 in=g loop=spin around=earth period=4']), 'bad-around'), 0);
  expect('over= past 20 s warns', has(play(['circle a 50,50 3', 'move a 80,50 over=40s']), 'bad-value'), 1);
  expect('over= of 20 s does not', has(play(['circle a 50,50 3', 'move a 80,50 over=20s']), 'bad-value'), 0);
  expect('a second clock=time slider warns', has(play(['slider a 0 3 0 clock=time | A', 'slider b 0 5 0 clock=time | B']), 'bad-value'), 1);
  expect('one clock=time slider is fine', has(play(['slider a 0 3 0 clock=time | A', 'slider b 0 5 0 clock=rate | B']), 'bad-value'), 0);

  return pureChecks() && ok;
}

const near = (a: number, b: number, tolerance: number): boolean => Math.abs(a - b) <= tolerance;
/** a clockwise turn of `degrees` of `(r, 0)`, by exact decimal arithmetic where the caller gives the fraction */
const mod = (value: number, size: number): number => ((value % size) + size) % size;

/** The pure arithmetic: a pose is a function of the drawing and T, and nothing is added up. */
function pureChecks(): boolean {
  let ok = true;
  const expect = (what: string, got: unknown, want: unknown): void => {
    if (got !== want) {
      ok = false;
      process.stdout.write(`  MOTION CHECK FAILED: ${what} (got ${String(got)}, wanted ${String(want)})\n`);
    }
  };
  const within = (what: string, got: number, want: number, tolerance: number): void => {
    if (!near(got, want, tolerance)) {
      ok = false;
      process.stdout.write(`  MOTION CHECK FAILED: ${what} (got ${got}, wanted ${want}, to ${tolerance})\n`);
    }
  };

  // The loop constants that moved out of the painter are the ones it used.
  expect('spin 6 s', LOOP_DEFAULT.spin.period, 6);
  expect('bob 1.8 s, 1.2 units', `${LOOP_DEFAULT.bob.period} ${LOOP_DEFAULT.bob.amp}`, '1.8 1.2');
  expect('sway 4 degrees in 3.2 s', `${LOOP_DEFAULT.sway.amp} ${LOOP_DEFAULT.sway.period}`, '4 3.2');
  expect('the others', [LOOP_DEFAULT.breathe.period, LOOP_DEFAULT.breathe.amp, LOOP_DEFAULT.pulse.period, LOOP_DEFAULT.pulse.amp, LOOP_DEFAULT.blink.period, LOOP_DEFAULT.drift.period, LOOP_DEFAULT.drift.amp, LOOP_DEFAULT.shake.rate].join(' '), '4 0.03 1.2 0.08 0.9 9 1.6 24');

  // At T = 0 every offset is exactly nothing.
  for (const loop of ['breathe', 'pulse', 'blink', 'drift', 'spin', 'bob', 'sway'] as const) {
    for (const [period, phase] of [[LOOP_DEFAULT[loop] && 'period' in LOOP_DEFAULT[loop] ? (LOOP_DEFAULT[loop] as { period: number }).period : 1, 0], [-3.7, 0], [0.0748, 0]] as const) {
      const offset = loopOffset(loop, cycleAt(0, period, phase));
      for (const key of ['dx', 'dy', 'rot'] as const) expect(`${loop} ${key} at T=0, period ${period}`, offset[key] === 0, true);
      expect(`${loop} scale at T=0`, offset.scale, 1);
      expect(`${loop} opacity at T=0`, offset.opacity, 1);
    }
  }
  expect('a loop with no clock is nothing', loopOffset('none', 0.3), NO_OFFSET);

  // A spin about a point lands on the four exact points.
  const pivot = { x: 50, y: 50 };
  const drawn = { x: 60, y: 50 };
  const period = 8;
  const wanted = [{ x: 60, y: 50 }, { x: 50, y: 60 }, { x: 40, y: 50 }, { x: 50, y: 40 }, { x: 60, y: 50 }];
  [0, 1, 2, 3, 4].forEach((quarter) => {
    const at = turnAbout(drawn, pivot, loopOffset('spin', cycleAt((quarter * period) / 4, period)).rot);
    const want = wanted[quarter] ?? drawn;
    within(`quarter ${quarter} x`, at.x, want.x, 1e-9);
    within(`quarter ${quarter} y`, at.y, want.y, 1e-9);
    expect(`quarter ${quarter} is exact`, at.x === want.x && at.y === want.y, true);
  });
  const back = turnAbout(drawn, pivot, loopOffset('spin', cycleAt(5 * 8, -8)).rot);
  within('a negative period runs backwards: a whole number of laps is home', back.x, 60, 1e-9);
  const reverse = turnAbout(drawn, pivot, loopOffset('spin', cycleAt(2, -8)).rot);
  within('a negative period: a quarter lap goes the other way (x)', reverse.x, 50, 1e-9);
  within('a negative period: a quarter lap goes the other way (y)', reverse.y, 40, 1e-9);
  expect('a turn of 360 comes home', turnAbout(drawn, pivot, 360).x, 60);
  const phased = turnAbout(drawn, pivot, loopOffset('spin', cycleAt(0, 8, 0.25)).rot);
  within('phase puts it a quarter in at T=0', phased.y, 60, 1e-9);

  // At T = 1000, a moon about an earth about a sun: the distance is the drawn radius, and both angles are 360 x frac(1000 / period).
  {
    const T = 1000;
    const sun = { x: 50, y: 50 };
    const earthDrawn = { x: 80, y: 50 };
    const moonDrawn = { x: 85, y: 50 };
    const earthPeriod = 0.241;
    const moonPeriod = 0.0748;
    const earthAngle = 360 * cycleAt(T, earthPeriod);
    const moonAngle = 360 * cycleAt(T, moonPeriod);
    const earth = turnAbout(earthDrawn, sun, earthAngle);
    // the carrier: the moon goes where the earth went, then turns about the earth
    const carried = { x: moonDrawn.x + (earth.x - earthDrawn.x), y: moonDrawn.y + (earth.y - earthDrawn.y) };
    const moon = turnAbout(carried, earth, moonAngle);
    within('the moon is the drawn radius from the earth', Math.hypot(moon.x - earth.x, moon.y - earth.y), 5, 1e-9);
    within('the earth is the drawn radius from the sun', Math.hypot(earth.x - sun.x, earth.y - sun.y), 30, 1e-9);
    // frac(1000 / 0.241) and frac(1000 / 0.0748) by whole-number arithmetic, which no float can disturb
    const earthTurns = (1_000_000 % 241) / 241;
    const moonTurns = (10_000_000 % 748) / 748;
    within('earth angle is 360 x frac(1000 / period)', earthAngle, 360 * earthTurns, 1e-9);
    within('moon angle is 360 x frac(1000 / period)', moonAngle, 360 * moonTurns, 1e-9);
    const angleOf = (from: { x: number; y: number }, to: { x: number; y: number }): number => mod((Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI, 360);
    within('the moon sits at its angle round the earth', angleOf(earth, moon), mod(360 * moonTurns, 360), 1e-7);
    within('the earth sits at its angle round the sun', angleOf(sun, earth), mod(360 * earthTurns, 360), 1e-7);
  }

  // A clock's hands at T = 1000 and 100 000 (in seconds): twelve hours and one hour round.
  for (const T of [1000, 100_000]) {
    const hour = 360 * cycleAt(T, 43_200);
    const minute = 360 * cycleAt(T, 3600);
    within(`12 x hour = minute at T=${T}`, mod(12 * hour - minute + 180, 360) - 180, 0, 1e-7);
    const tip = turnAbout({ x: 50, y: 20 }, { x: 50, y: 50 }, minute);
    within(`the minute hand keeps its length at T=${T}`, Math.hypot(tip.x - 50, tip.y - 50), 30, 1e-9);
    within(`the minute hand is where its angle says at T=${T}`, mod((Math.atan2(tip.y - 50, tip.x - 50) * 180) / Math.PI + 90, 360), minute, 1e-7);
  }
  expect('a hand on the hour points straight up', (() => { const tip = turnAbout({ x: 50, y: 20 }, { x: 50, y: 50 }, 360 * cycleAt(3 * 3600, 3600)); return tip.x === 50 && tip.y === 20; })(), true);
  expect('a hand a quarter round points right, exactly', (() => { const tip = turnAbout({ x: 50, y: 20 }, { x: 50, y: 50 }, 360 * cycleAt(900, 3600)); return tip.x === 80 && tip.y === 50; })(), true);

  // Gears of 12 and 36 teeth, with periods 4 and -12, stay in mesh: teeth passed agree, mod the whole turn of the big one.
  for (const T of [0, 1, 37.3, 1000, 100_000, 123_456.789]) {
    const small = 360 * cycleAt(T, 4);
    const big = 360 * cycleAt(T, -12);
    const passed = mod(12 * small + 36 * big, 12 * 360);
    within(`gears in mesh at T=${T}`, Math.min(passed, 12 * 360 - passed), 0, 1e-6);
  }

  // A closed ride is back at its start at T = P; an open one is at its far end at P/2 and home again at P.
  {
    const P = 8;
    const square = { closed: true, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] };
    const ride = (start: number, T: number, closed: boolean): number => rideShare(start, cycleAt(T, P), closed);
    within('closed: home at T=P', ride(0.3, P, true), 0.3, 1e-12);
    within('closed: halfway round at P/2', ride(0, P / 2, true), 0.5, 1e-12);
    within('closed: a lap and a quarter', ride(0, 1.25 * P, true), 0.25, 1e-12);
    within('closed: backwards, a quarter lap before the start', rideShare(0, cycleAt(2, -P), true), 0.75, 1e-12);
    expect('closed: a quarter lap round a square is its corner', JSON.stringify(pointAlong(square, ride(0, P / 4, true))), JSON.stringify({ x: 10, y: 0 }));
    within('open: far end at P/2', ride(0, P / 2, false), 1, 1e-12);
    within('open: home again at P', ride(0, P, false), 0, 1e-12);
    within('open: a quarter of the way there at P/8', ride(0, P / 8, false), 0.25, 1e-12);
    within('open: three quarters back at 5P/8', ride(0, (5 * P) / 8, false), 0.75, 1e-12);
    within('open: drawn halfway, the far end is a quarter cycle away', ride(0.5, P / 4, false), 1, 1e-12);
    for (const T of [0, 0.37, 3, 5.5, 7.99, 100_000.123]) expect(`open: stays on the outline at T=${T}`, ride(0.2, T, false) >= 0 && ride(0.2, T, false) <= 1, true);
  }

  // The clock: rate 1 for 10 s, 0 for 5 s, 2 for 3 s reads exactly 16. A scrub to 100 reads 100. Ten thousand re-bases move it by nothing.
  {
    let clock = openClock(0, 1);
    expect('at rest at zero when a scene opens', clockAt(clock, 0), 0);
    expect('rate 1 for 10 s', clockAt(clock, 10), 10);
    clock = rebase(clock, 10, { rate: 0 });
    expect('rate 0 holds', clockAt(clock, 15), 10);
    clock = rebase(clock, 15, { rate: 2 });
    expect('rate 2 for 3 s: the sequence reads exactly 16', clockAt(clock, 18), 16);
    const scrubbed = rebase(clock, 18, { time: 100 });
    expect('a scrub to 100 reads 100', clockAt(scrubbed, 18), 100);
    expect('and runs on from there at the same rate', clockAt(scrubbed, 19), 102);
    let held = rebase(scrubbed, 18, { rate: 0 });
    for (let i = 0; i < 10_000; i += 1) held = rebase(held, 18 + i * 0.37);
    expect('ten thousand re-bases at rate 0 move it by nothing', clockAt(held, 5000), 100);
    let running = openClock(0, 1);
    for (let i = 1; i <= 10_000; i += 1) running = rebase(running, i);
    expect('ten thousand re-bases at rate 1, a second apart', clockAt(running, 10_000), 10_000);
    let fractional = openClock(0, 1);
    for (let i = 1; i <= 10_000; i += 1) fractional = rebase(fractional, i * 0.1);
    within('ten thousand re-bases a tenth of a second apart', clockAt(fractional, 1000), 1000, 1e-9);
    let backwards = openClock(0, -0.5);
    for (let i = 1; i <= 100; i += 1) backwards = rebase(backwards, i);
    expect('a negative rate runs backwards', clockAt(backwards, 100), -50);
    // two periods never drift apart: the clock is read, not added to
    const direct = clockAt(openClock(0, 1), 100_000.5);
    expect('the reading at a late time is one multiplication', direct, 100_000.5);
  }

  // A film, a seek, a draft.
  {
    const schedule = play(['scene caption', 'say a | Hello']).schedule;
    const start = schedule.scenes[schedule.scenes.length - 1]?.start ?? 0;
    expect('a seek reads rate x (time - the scene start)', pinnedClock(schedule, start + 7, { time: null, rate: 2 }), 14);
    expect('a seek with no rate runs at one', pinnedClock(schedule, start + 7, { time: null }), 7);
    expect('the time slider wins in a film', pinnedClock(schedule, start + 7, { time: 3, rate: 2 }), 3);
    expect('a draft with no slider is the drawing', pinnedClock(schedule, start + 7, { time: null, rest: true }), 0);
    expect('a draft with a slider is its value', pinnedClock(schedule, start + 7, { time: 1.5, rest: true }), 1.5);
  }

  // frac is the one reduction.
  expect('frac of a negative', frac(-0.25), 0.75);
  expect('frac of a whole number', frac(5), 0);
  expect('no period holds at the phase', cycleAt(1000, undefined, 0.25), 0.25);
  return ok;
}
