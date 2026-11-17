// A made-up session for the film's checks and its proof: four turns that between them hold a control, a long wait and a choice.
//
//   t1  a prompt typed and sent; the model takes twenty seconds to its first line; it draws an explorable (a slider `height` written at 20, a toggle, a pick, a button)
//   t2  the viewer's tap on the button (an `act`) with the slider at 60 when they used it
//   t3  a tap on a choice
//   t4  a prompt again, a ball that moves for twelve seconds while a dozen short lines are written after it (the pane goes down, then back up to the move)
//
// Pure: no DOM and no files (the explorable's lines are handed in), so a node bench and a browser page build the very same film from it.

import { EMPTY_STAGE, TurnScore, parseScript, serializeLine, settle } from '@conduit/language';
import type { StageBase } from '@conduit/language';
import type { Film, Recording } from '../contracts/film';
import { createLangLog } from '../app/lang-log';
import type { LangLog } from '../app/lang-log';
import { langLayout, withPane } from '../app/lang-film';
import type { LangLayout } from '../app/lang-film';
import { createReel } from '../painter/reel';
import type { Reel } from '../painter/reel';

export const PROMPT = 'show me how the sun and a post make a shadow';
export const PROMPT_AGAIN = 'and let the ball roll across while you explain';
/** real seconds the model took to its first line in turn one */
export const WAITED = 20;

/** The stage a turn leaves, as the next turn finds it. */
function leftBy(recording: Recording): StageBase {
  const score = new TurnScore(recording.base, recording.opened ?? 'none');
  for (const { seq, line, floor } of recording.lines) score.push(line, seq, floor ?? 0);
  return settle(score.schedule, recording.base, score.schedule.end + 1);
}

function recordingOf(turn: string, lines: readonly import('@conduit/language').Line[], extra: Partial<Recording>): Recording {
  return { turn, base: EMPTY_STAGE, lines: lines.map((line, index) => ({ seq: index + 1, line, floor: index * 0.35 })), paintings: {}, ...extra };
}

export interface Session {
  readonly recordings: readonly Recording[];
  readonly log: LangLog;
  readonly layout: LangLayout;
  readonly reel: Reel;
  /** the reel with the pane and the input box laid round it */
  readonly film: Film;
  /** how many notes ("repaired: …", "dropped: …") the log holds that the pane must not show */
  readonly notes: number;
}

/** `explorable`: the text of the explorable demo (`language/demos/explorable.series`). `held`: what the viewer's hand held when the film was asked for (a film must ignore it). */
export function buildSession(width: number, height: number, explorable: string, held?: Record<string, number>): Session {
  const one = recordingOf('t1', parseScript(explorable).lines, { opened: 'prompt', asked: PROMPT, typed: PROMPT, waited: WAITED });
  const second = parseScript('set sun fill=#ff8a4c\nsay | At dusk the sun is low and the shadow is long.').lines;
  const two = { ...recordingOf('t2', second, { opened: 'act', asked: 'Used "Why is it longer at dusk?"', touched: { id: 'ask', text: 'Why is it longer at dusk?' }, controls: { height: 60 }, waited: 0.3 }), base: leftBy(one) };
  const three = { ...recordingOf('t3', parseScript('say | Here is why it is longer at dusk.').lines, { opened: 'tap', asked: 'Tapped "Day"', touched: { id: 'x1', text: 'Day' }, waited: 0.2 }), base: leftBy(two) };
  const ball = parseScript(['circle b1 20,20 4 fill=accent', 'move b1 70,60 over=12s', ...Array.from({ length: 12 }, (_, index) => `circle c${index + 1} ${10 + index * 6},80 2 fill=dim`)].join('\n')).lines;
  const four = { ...recordingOf('t4', ball, { opened: 'prompt', asked: PROMPT_AGAIN, typed: PROMPT_AGAIN, waited: 1 }), base: leftBy(three) };
  const recordings: Recording[] = [one, two, three, four];
  const log = createLangLog(false);
  let notes = 0;
  for (const recording of recordings) {
    log.openTurn(recording.turn);
    recording.lines.forEach((entry, index) => {
      // the second line of the first turn was mended by the page: its note is never shown
      const issues = recording.turn === 't1' && index === 1 ? [{ code: 'unknown-name' as const, severity: 'warn' as const, message: 'the id was a word' }] : [];
      if (issues.length > 0) notes += 1;
      log.line(recording.turn, entry.seq, serializeLine(entry.line), issues, 0);
    });
    if (recording.turn === 't1') {
      log.dropped('t1', 'not a line at all', [{ code: 'unknown-verb' as const, severity: 'error' as const, message: 'the verb is not one' }], 0);
      notes += 1;
    }
  }
  const layout = langLayout(width, height);
  const options = { apps: false, viewport: { width: layout.stage.width, height: layout.stage.height, dpr: 1 }, reducedMotion: false, arrival: 'at-once' as const, ...(held === undefined ? {} : { controls: held }) };
  const reel = createReel(recordings, options, { cards: false, maxSeconds: 600, session: true });
  return { recordings, log, layout, reel, film: withPane(reel, recordings, log, layout), notes };
}
