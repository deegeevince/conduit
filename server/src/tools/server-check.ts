// Checks of the server's own rules that need no model and no network (the v2.1 review's server, conductor and brief items).
//   pnpm server-check
// Each line is PASS or FAIL with what was seen. Exits 1 if any failed.
import { asksWhatsNew, FIX_POLICY, NEW_COMMAND_TEXT, newsText, NO_SIGHT } from '@conduit/language';
import type { ContentCount, TurnInput } from '@conduit/language';
import type { Snapshot } from '../domain/brain';
import type { Critic } from '../domain/critic';
import { worthQueuing } from '../domain/critic';
import { judgeFix } from '../domain/review';
import type { DraftReport } from '../domain/review';
import { createLogger } from '../log';
import { ART_POLICY, FAKE_SVG, commissionOf, createStudio } from '../art/studio';
import type { Maker, MakerKind, Studio, StudioEvent } from '../art/studio';
import { createShelf } from '../art/shelf';
import type { ThrottleState } from '../usage';

let failed = 0;
const check = (ok: boolean, what: string, saw: string): void => {
  if (!ok) failed += 1;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${what}   [${saw}]\n`);
};

const picture: Snapshot = { mime: 'image/jpeg', bytes: new Uint8Array(4), width: 2, height: 2 };
const content: ContentCount = { structures: 0, parts: 0, drawn: 4, controls: 0, words: 40, choices: ['and why?'] };
const report = (): DraftReport => ({ turn: 't1', pass: 1, sight: NO_SIGHT, placed: [], picture, content });

async function criticChecks(): Promise<void> {
  // P1-2: a critic that never answers must not hold a fix. It used to be waited for, 8 s a fix, and it never answered in time.
  const calls: number[] = [];
  const hanging: Pick<Critic, 'compare'> = {
    compare: (_request, _a, _b, deadlineMs) => {
      calls.push(deadlineMs);
      return new Promise(() => undefined);
    },
  };
  const input: TurnInput = { kind: 'prompt', text: 'which model are you?' };
  const started = Date.now();
  const verdict = await judgeFix(
    { critic: hanging, session: 'c1', turn: 't1', input, now: Date.now, log: createLogger('error') } as never,
    { policy: FIX_POLICY, form: 'fix', pass: 2, draft: report(), draftContent: content, tried: { ...report(), pass: 2 } },
  );
  const took = Date.now() - started;
  check(verdict.refusal === null && took < 200, 'a fix is shown without waiting for a critic that never answers', `refusal ${verdict.refusal}, ${took} ms`);
  check(calls.length === 1, 'the comparison is still started, in the background', `${calls.length} call(s), deadline ${calls[0]} ms`);
}

function newsChecks(): void {
  const asks = (text: string): boolean => asksWhatsNew({ kind: 'prompt', text });
  // P1-5: the changelog reached the brief of "what's new in Python 3.13?".
  for (const yes of [NEW_COMMAND_TEXT, "what's new", "What's new?", "whats new", "what is new here", "what's new with you?", "What's new in Conduit", "what changed", "so, what's new in this app?", "what\u2019s new in the app"]) check(asks(yes), `asks what is new: "${yes}"`, 'matched');
  for (const no of ["what's new in Python 3.13?", 'is there anything new in fusion research?', 'showcase the water cycle', "what's new in the world", 'what changed in the 1990s', 'what is new york like']) check(!asks(no), `is not about the app: "${no}"`, 'not matched');
  check(!newsText('x').includes('The user asked for it'), 'the brief no longer says the user asked for the changelog', 'checked');
}

function queueChecks(): void {
  const finding = (coherence: number, weights: readonly ('blocks' | 'hurts' | 'polish')[]) => ({ coherence, problems: weights.map((weight) => ({ id: null, what: 'x', weight })) });
  check(!worthQueuing(finding(2, []), 4), 'a low score with no problem named is not queued', 'checked');
  check(!worthQueuing(finding(2, ['hurts', 'polish', 'polish']), 4), 'one hurt and some polish is not queued', 'checked');
  check(worthQueuing(finding(2, ['hurts', 'hurts']), 4), 'two hurts are queued', 'checked');
  check(worthQueuing(finding(3, ['blocks']), 4), 'a blocking problem is queued', 'checked');
  check(!worthQueuing(finding(4, ['blocks']), 4), 'a good score is never queued', 'checked');
}

/** The art studio's rules, with a fake maker: one at a time, one drawing for two askers, a ceiling an hour, a stop near the usage cap, a kill switch, a failure not retried. */
async function studioChecks(): Promise<void> {
  const quiet = createLogger('error');
  const shelf = createShelf({ seedDir: '/nonexistent', cacheDir: null });
  let clock = 1_000_000;
  const throttle = { state: 'ok' as ThrottleState };
  const make = (maker: MakerKind, perHour: number, impl: Maker): Studio =>
    createStudio({ policy: { ...ART_POLICY, maker, perHour }, shelf, maker: impl, throttle: { capUsd: 10, spentLastHour: () => 0, state: () => throttle.state }, log: quiet, now: () => clock });
  let running = 0;
  let overlap = 0;
  let made = 0;
  const slow: Maker = async () => {
    running += 1;
    overlap = Math.max(overlap, running);
    await new Promise<void>((resolve) => setTimeout(resolve, 15));
    running -= 1;
    made += 1;
    return { svg: FAKE_SVG, by: 'fake', arm: 'B', how: 'a fixed drawing', usd: 0 };
  };
  const ask = (studio: Studio, subject: string, heard: StudioEvent[] = []): ReturnType<Studio['commission']> => studio.commission(commissionOf(subject, subject, { pose: null, view: null, facing: null }, ''), (event) => heard.push(event));

  const studio = make('one', 3, slow);
  const heard: StudioEvent[] = [];
  const again: StudioEvent[] = [];
  const first = ask(studio, 'giraffe', heard);
  const joined = ask(studio, 'giraffe', again);
  ask(studio, 'zebra');
  await studio.idle();
  check(first.ok && !first.joined && joined.ok && joined.joined, 'two askers for one subject share one commission', `${JSON.stringify(joined)}`);
  check(made === 2 && heard.some((event) => event.kind === 'made') && again.some((event) => event.kind === 'made'), 'both askers hear the drawing, and it is made once', `${made} made`);
  check(overlap === 1, 'commissions are made one at a time', `at most ${overlap} at once`);
  check(shelf.find('giraffe', { pose: null, view: null }) !== null, 'the drawing is on the shelf when it is made', 'giraffe found');
  ask(studio, 'hippo');
  const over = ask(studio, 'llama');
  check(!over.ok && /an hour/.test(over.why), 'the hourly ceiling refuses the next commission', over.ok ? 'accepted' : over.why);
  await studio.idle();
  clock += 3_600_001;
  check(ask(studio, 'llama').ok, 'the ceiling opens again an hour later', 'accepted');
  await studio.idle();

  throttle.state = 'near';
  const near = ask(make('one', 12, slow), 'okapi');
  check(!near.ok && /usage/.test(near.why), 'no commission while usage is near the cap', near.ok ? 'accepted' : near.why);
  throttle.state = 'ok';
  const off = ask(make('off', 12, slow), 'okapi');
  check(!off.ok && /off/.test(off.why), 'ART_MAKER=off refuses every commission', off.ok ? 'accepted' : off.why);

  let tries = 0;
  const broken: Maker = async () => {
    tries += 1;
    throw new Error('the model call failed');
  };
  const failing = make('one', 12, broken);
  const told: StudioEvent[] = [];
  ask(failing, 'emu', told);
  await failing.idle();
  const retried = ask(failing, 'emu');
  check(told.some((event) => event.kind === 'failed') && !retried.ok && tries === 1, 'a failed drawing is told, and not retried within the hour', `${tries} try, ${retried.ok ? 'accepted again' : retried.why}`);
  clock += 3_600_001;
  check(ask(failing, 'emu').ok, 'it may be tried again after the hour', 'accepted');
  await failing.idle();
  const junk = make('one', 12, async () => ({ svg: '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>', by: 'fake', arm: 'B', how: 'junk', usd: 0 }));
  const junkHeard: StudioEvent[] = [];
  ask(junk, 'newt', junkHeard);
  await junk.idle();
  check(junkHeard.some((event) => event.kind === 'failed') && shelf.find('newt', { pose: null, view: null }) === null, 'a drawing the converter refuses is not put on the shelf', junkHeard.map((event) => event.kind).join(','));
}

await criticChecks();
await studioChecks();
queueChecks();
newsChecks();
process.stdout.write(failed === 0 ? '\nall passed\n' : `\n${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
