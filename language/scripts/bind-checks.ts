// What a control's binds do, and a choice that is revised (feedback fb-051 and fb-054). Run by `pnpm timeline`. The browser half of both is the scenes `fb-051` and
// `fb-054` of language/demos/hard.series (a real drag of the slider; the revised choice on screen and still a tap).
import { EMPTY_STAGE, LineNormalizer, LineReader, settle, TurnScore } from '../src/index';
import type { ElementSpan, Issue, StageBase, TurnOpening } from '../src/index';

interface Played {
  readonly score: TurnScore;
  /** the issues each line was given as it was pushed, by its text */
  readonly told: ReadonlyMap<string, readonly Issue[]>;
}

/** Lines of Series pushed as a turn would push them, each at the playhead `floorOf` says (`wait`: they all arrive at once). */
function play(lines: readonly string[], opened: TurnOpening, base: StageBase = EMPTY_STAGE, floorOf: (index: number) => number = () => 0): Played {
  const score = new TurnScore(base, opened);
  const reader = new LineReader();
  const told = new Map<string, Issue[]>();
  let auto = 0;
  const normalizer = new LineNormalizer(() => `x${(auto += 1)}`);
  lines.forEach((raw, index) => {
    const read = reader.read(raw);
    if (read.kind !== 'line') throw new Error(`bind check: does not parse: ${raw}`);
    const normalized = normalizer.normalize(read.line);
    if (normalized.line === null) throw new Error(`bind check: dropped: ${raw}`);
    const pushed = score.push(normalized.line, index + 1, floorOf(index));
    told.set(raw, [...read.issues, ...normalized.issues, ...pushed.issues]);
  });
  return { score, told };
}

const named = (score: TurnScore, id: string): ElementSpan | undefined => [...score.schedule.elements].reverse().find((element) => element.id === id);
const codes = (played: Played, raw: string): string => (played.told.get(raw) ?? []).map((issue) => issue.code).join(',');

export function bindChecks(): boolean {
  let ok = true;
  const expect = (what: string, got: unknown, want: unknown): void => {
    if (got !== want) {
      ok = false;
      process.stdout.write(`  BIND CHECK FAILED: ${what} (got ${String(got)}, wanted ${String(want)})\n`);
    }
  };

  // #fb-051: a bind that moves a thing to a point is on the thing, with the point; one that moves nothing is told, once the turn is in
  const shapes = ['circle a 30,20 4 fill=#ff0000', 'rect b 50,20 8x4 fill=#00ff00', 'slider s 0 90 0 unit=deg | Turn'];
  const moving = play([...shapes, 'bind s | move a 60,60', 'bind s | move b 20,70'], 'script');
  for (const [id, x, y] of [['a', 60, 60], ['b', 20, 70]] as const) {
    const effect = named(moving.score, id)?.driven[0]?.effect;
    expect(`#fb-051 bind s | move ${id}: attached with its point`, effect?.kind === 'move' && typeof effect.to === 'object' && effect.to.x === x && effect.to.y === y, true);
  }
  expect('#fb-051 a slider whose binds move things is not told it does nothing', moving.score.settledIssues().length, 0);

  const still = play(['circle a 30,20 4 fill=#ff0000', 'slider s 0 90 0 unit=deg | Turn', 'bind s | move a 30,20'], 'script');
  const stillSaid = still.score.settledIssues();
  expect('#fb-051 a bind that moves a thing to where it is: one dead-bind', stillSaid.map((item) => item.issue.code).join(','), 'dead-bind');
  expect('#fb-051 the dead-bind names the control', stillSaid[0]?.issue.token, 's');
  expect('#fb-051 the dead-bind says what is the matter', /already at 30,20/.test(stillSaid[0]?.issue.message ?? ''), true);
  expect('#fb-051 the dead-bind is on the control\'s last bind', stillSaid[0]?.seq, 3);
  expect('#fb-051 the line itself was not told early (a later bind may make it work)', codes(still, 'bind s | move a 30,20'), '');

  const same = play(['circle a 30,20 4 fill=#ff0000', 'toggle t on | Show', 'bind t=on | set a opacity=1', 'bind t=off | set a opacity=1'], 'script');
  expect('#fb-051 sets of what is already set: dead', same.score.settledIssues().length, 1);
  const words = play(['say t | Hello', 'toggle k | Say', 'bind k | correct t | Hello'], 'script');
  expect('#fb-051 a correct to the words already shown: dead', words.score.settledIssues().length, 1);

  // the documented pair: the first alone changes nothing, the two together work
  const pair = play(['rect sales 10,10 20x10', 'pick view tabs | chart | table', 'bind view=chart | set sales opacity=1', 'bind view=table | set sales opacity=0'], 'script');
  expect('#fb-051 `bind view=chart | set sales opacity=1` with its pair is not dead', pair.score.settledIssues().length, 0);
  expect('#fb-051 and was not told so when its line came', codes(pair, 'bind view=chart | set sales opacity=1'), '');
  const bare = play(['circle a 30,20 4', 'slider s 0 90 0 | go'], 'script');
  expect('#fb-051 a control with no bind is left alone', bare.score.settledIssues().length, 0);

  // what a control cannot carry is refused by name, at the line
  for (const [what, lines, line, target] of [
    ['words', ['say lab at=20,40 | Label', 'slider s 0 90 0 | go'], 'bind s | move lab 60,60', 'lab'],
    ['a chart', ['chart c1 line | A', '| 2019 | 2.9', '| 2020 | 3.1', 'slider s 0 90 0 | go'], 'bind s | move c1 60,60', 'c1'],
    ['a diagram', ['flow f1 right | A', 'node n1 | One', 'node n2 from=n1 | Two', 'slider s 0 90 0 | go'], 'bind s | move f1 60,60', 'f1'],
  ] as const) {
    const refused = play([...lines, line], 'script');
    expect(`#fb-051 a bound move of ${what} is a bad-bind`, codes(refused, line), 'bad-bind');
    expect(`#fb-051 ... that names the control and the thing`, (refused.told.get(line) ?? []).every((issue) => issue.message.includes('"s"') && issue.message.includes(`"${target}"`)), true);
    expect(`#fb-051 ... and binds nothing`, named(refused.score, target)?.driven.length, 0);
  }
  const nothing = play(['slider s 0 90 0 | go', 'bind s | move ghost 60,60'], 'script');
  expect('#fb-051 a bind that names nothing drawn is a bad-bind', codes(nothing, 'bind s | move ghost 60,60'), 'bad-bind');

  // #fb-054: a choice that has left, revised by its id, is a choice again with the new words
  const offered = play(['say c1 choice | One', 'say c2 choice | Two'], 'prompt');
  const carried = settle(offered.score.schedule, EMPTY_STAGE, offered.score.schedule.end + 1);
  for (const opened of ['prompt', 'tap'] as const) {
    // the first line of the answer retires the choices of the turn before; the brain then rewords them by id
    const lines = ['say intro | Hello', 'revise c1 | Uno', 'revise c2 | Dos'];
    const turn = play(lines, opened, carried, () => 100);
    for (const [id, text] of [['c1', 'Uno'], ['c2', 'Dos']] as const) {
      const now = named(turn.score, id);
      expect(`#fb-054 ${opened}: revise ${id} shows "${text}"`, now?.text, text);
      expect(`#fb-054 ${opened}: ${id} is still a tap`, now?.style.tap, true);
      expect(`#fb-054 ${opened}: ${id} is on stage, not leaving`, now?.exit, null);
    }
    expect(`#fb-054 ${opened}: the brain is told the choice had left`, (turn.told.get('revise c1 | Uno') ?? []).some((issue) => /had left the stage/.test(issue.message)), true);
  }
  // a choice that is still there keeps its tap through the same revise, played or not
  for (const [name, floor] of [['not yet played', 0], ['played', 100]] as const) {
    const turn = play(['say c1 choice | One', 'say c2 choice | Two', 'revise c1 | Uno'], 'prompt', EMPTY_STAGE, (index) => (index === 2 ? floor : 0));
    const now = turn.score.schedule.elements.filter((element) => element.id === 'c1' && element.exit === null);
    expect(`#fb-054 ${name}: one c1 on stage`, now.length, 1);
    expect(`#fb-054 ${name}: it says "Uno"`, now[0]?.text, 'Uno');
    expect(`#fb-054 ${name}: it is a tap`, now[0]?.style.tap, true);
  }
  // plain words that left stay plain words when they are written again
  const plain = play(['say t | Hello', 'drop t', 'wait 1', 'correct t | Hi'], 'script');
  expect('#fb-054 words that were not a choice do not become one', named(plain.score, 't')?.style.tap, false);
  return ok;
}
