// The note a doubted line carries ("(from memory)") is put once, whatever the brain wrote (fb-068). Run by `pnpm timeline`.
import { doubted } from '../src/index';

export function doubtChecks(): boolean {
  let ok = true;
  const expect = (what: string, got: string, want: string): void => {
    if (got !== want) {
      ok = false;
      process.stdout.write(`  DOUBT CHECK FAILED: ${what} (got "${got}", wanted "${want}")\n`);
    }
  };
  expect('a plain line is marked', doubted('Most cars drive the front wheels.', 'recalled'), 'Most cars drive the front wheels. (from memory)');
  expect('a line the brain already ended with the note is not marked again', doubted('Most cars drive the front wheels. (from memory)', 'recalled'), 'Most cars drive the front wheels. (from memory)');
  expect('a note before the full stop is not marked again', doubted('Most cars drive the front wheels (from memory).', 'recalled'), 'Most cars drive the front wheels (from memory).');
  expect('a note in the middle is not marked again', doubted('Rear-wheel drive (from memory) is shown; most cars drive the front.', 'recalled'), 'Rear-wheel drive (from memory) is shown; most cars drive the front.');
  expect('marking is idempotent', doubted(doubted('Roughly nothing.', 'yes'), 'yes'), 'Roughly nothing.');
  expect('a guess is marked once', doubted(doubted('It is red.', 'guessed'), 'guessed'), 'It is red. (a guess)');
  expect('a line that already hedges is left', doubted('About four metres.', 'computed'), 'About four metres.');
  return ok;
}
