// Checks of the server's own rules that need no model and no network (the v2.1 review's server, conductor and brief items).
//   pnpm server-check
// Each line is PASS or FAIL with what was seen. Exits 1 if any failed.
import { FIX_POLICY, NO_SIGHT } from '@conduit/language';
import type { ContentCount, TurnInput } from '@conduit/language';
import type { Snapshot } from '../domain/brain';
import type { Critic } from '../domain/critic';
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

await criticChecks();
process.stdout.write(failed === 0 ? '\nall passed\n' : `\n${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
