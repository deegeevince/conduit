// Long text is never cut: a `say` over the per-element limit arrives whole, as consecutive lines of the same verb and styles. Run by `pnpm timeline`.
import { EMPTY_STAGE, LIMITS, LineNormalizer, LineReader, serializeLine, splitSpeech, TurnScore } from '../src/index';

/** A paragraph of `length` characters or a little more, made of whole sentences. */
export function paragraph(length: number): string {
  const sentences = [
    'Every morning, Clara walked to the harbour before the town was awake.',
    'She liked the quite streets, the smell of salt and diesel, and the way the fishing boats creeked against there ropes.',
    'Most days she bought a coffee from the kiosk by the pier, where the owner allways had a new theory about the whether.',
    'Today he said the tide would turn early, and nobody argued.',
  ];
  let text = '';
  for (let i = 0; text.length < length; i += 1) text += `${text === '' ? '' : ' '}${sentences[i % sentences.length]}`;
  return text;
}

const words = (text: string): string => text.replace(/\s+/g, ' ').trim();

export function nocutChecks(): boolean {
  let ok = true;
  const expect = (what: string, got: unknown, want: unknown): void => {
    if (got !== want) {
      ok = false;
      process.stdout.write(`  NOCUT CHECK FAILED: ${what} (got ${String(got)}, wanted ${String(want)})\n`);
    }
  };
  const long = paragraph(1000);
  for (const layout of ['page', 'caption']) {
    const reader = new LineReader();
    let auto = 0;
    const normalizer = new LineNormalizer(() => `x${(auto += 1)}`);
    const score = new TurnScore(EMPTY_STAGE);
    const sent: string[] = [];
    let seq = 0;
    for (const raw of [`scene layout=${layout}`, `say x24 strong | ${long}`, 'say x26 aside | Ten mistakes are hidden in it.']) {
      const read = reader.read(raw);
      if (read.kind !== 'line') throw new Error(`nocut check: does not parse: ${raw.slice(0, 40)}`);
      const normalized = normalizer.normalize(read.line);
      expect(`${layout}: no warning on a long say`, normalized.issues.length + read.issues.length, 0);
      for (const line of normalized.line === null ? [] : [normalized.line, ...(normalized.rest ?? [])]) {
        seq += 1;
        score.push(line, seq, 0);
        sent.push(serializeLine(line));
      }
    }
    const pieces = sent.filter((text) => /^say x24/.test(text));
    expect(`${layout}: the paragraph is several lines`, pieces.length >= 3, true);
    expect(`${layout}: first keeps the id`, pieces[0]?.startsWith('say x24 strong | '), true);
    expect(`${layout}: continuations are x24-2, x24-3...`, pieces.slice(1).every((text, at) => text.startsWith(`say x24-${at + 2} strong | `)), true);
    const body = pieces.map((text) => text.slice(text.indexOf('| ') + 2));
    expect(`${layout}: every piece fits`, body.every((text) => text.length <= LIMITS.text), true);
    expect(`${layout}: every word arrives, in order`, words(body.join(' ')), words(long));
    expect(`${layout}: no ellipsis`, body.join('').includes('…'), false);
    const onStage = score.schedule.elements.filter((element) => element.kind === 'text').map((element) => element.id);
    expect(`${layout}: the stage holds every piece and the line after`, ['x24', 'x24-2', 'x24-3', 'x26'].every((id) => onStage.includes(id)), true);
  }
  // the rules of the split
  expect('a short text is one piece', splitSpeech('Hello there.').length, 1);
  const noSpace = 'a'.repeat(700);
  expect('text with no space is split hard, nothing lost', splitSpeech(noSpace).join(''), noSpace);
  const oneSentence = Array.from({ length: 120 }, () => 'word').join(' ');
  expect('one long sentence is split at a space, nothing lost', words(splitSpeech(oneSentence).join(' ')), oneSentence);
  expect('every piece of one long sentence fits', splitSpeech(oneSentence).every((piece) => piece.length <= LIMITS.text), true);
  // an id near the limit keeps its continuation inside the id rule
  const reader = new LineReader();
  const normalizer = new LineNormalizer(() => 'q');
  const read = reader.read(`say abcdefghijklmnopqrstuvwx | ${long}`);
  if (read.kind === 'line') {
    const done = normalizer.normalize(read.line);
    expect('a 24-character id still has continuations within 24', (done.rest ?? []).every((line) => line.verb === 'say' && line.id.length <= LIMITS.name), true);
  }
  // a choice is one thing to press: kept whole, not split
  const choice = reader.read(`say x9 choice | ${long}`);
  if (choice.kind === 'line') {
    const done = normalizer.normalize(choice.line);
    expect('a long choice is not split', (done.rest ?? []).length, 0);
    expect('a long choice keeps its words', done.line?.verb === 'say' ? done.line.text : '', long);
  }
  // a row of speech after all (a bar with no sprite open) is split as well
  const row = new LineReader().read(`| ${long}`);
  if (row.kind === 'line') {
    const done = new LineNormalizer(() => 'r').normalize(row.line);
    expect('a bar line of speech is split too', (done.rest ?? []).length >= 2, true);
  }
  return ok;
}
