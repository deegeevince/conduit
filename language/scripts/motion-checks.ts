// Motion that keeps time (PLAN-motion.md): the words and their contract, then the pure arithmetic. Run by `pnpm timeline`.
import { EMPTY_STAGE, LineNormalizer, LineReader, parseLine, serializeLine, TurnScore } from '../src/index';
import type { Issue } from '../src/index';

interface Played {
  readonly end: number;
  readonly pen: number;
  readonly issues: readonly string[];
  readonly serialized: readonly string[];
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
  return { end: schedule.end, pen: schedule.pen, issues, serialized };
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

  return ok;
}
