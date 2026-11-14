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

await criticChecks();
queueChecks();
newsChecks();
process.stdout.write(failed === 0 ? '\nall passed\n' : `\n${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
