// Read aloud, what and when. The painter says each line of words as it begins to show (`said`), and a hint when it is opened (`hint`); this hands them to
// the speaker, in order, while Read aloud is on. A drawing's labels, code, a table's cells, a chart's numbers, a mock-up's screens and a live app are never
// said: the painter does not tell them as lines of words, and a label (`near=`) is told as one but is not read. Choices come at the end of the answer, as one
// sentence. A tap on a block of words on the stage reads that block.
//
// It adds nothing to what the brain is asked and changes nothing of the language: it listens to what the painter already says.

import type { Painter } from '../contracts/painter';
import type { Speaker } from './speak';
import { spokenChoices } from './speak-text';

export interface Reader {
  dispose(): void;
}

/** What a tap on the stage may read: words, not what a finger works or what is a part of a drawing. */
const READABLE = new Set(['heading', 'body', 'aside']);

export function mountReader(painter: Painter, speaker: Speaker, stage: HTMLElement): Reader {
  /** the choices of the answer playing, said once it has finished */
  let choices: string[] = [];

  const live = (): boolean => {
    const view = painter.snapshot();
    // a kept answer put back, an answer cut short and "show all" are not an answer being played: nothing is read
    return view.turn !== null && !view.showingAll;
  };

  const offTranscript = painter.on('transcript', (event) => {
    if (event.kind === 'turn') {
      speaker.stop();
      choices = [];
      return;
    }
    if (!speaker.on) return;
    if (event.kind === 'hint') {
      speaker.say(event.text);
      return;
    }
    if (event.kind !== 'said' || !live()) return;
    if (event.tappable) {
      choices.push(event.text);
      return;
    }
    if (event.ask !== undefined) {
      speaker.say(event.text);
      const options = spokenChoices(event.ask.options);
      if (options !== '') speaker.say(options);
      return;
    }
    if (!event.near) speaker.say(event.text);
  });

  // whatever is stopped, the choices that waited for the end of the answer go with it
  const offStop = speaker.onStop(() => {
    choices = [];
  });

  // the answer is over: its choices are the last thing said
  let was = painter.snapshot().clock;
  const offClock = painter.on('clock', (state) => {
    const finished = state === 'idle' && was !== 'idle';
    was = state;
    if (!finished || choices.length === 0) return;
    const said = spokenChoices(choices);
    choices = [];
    if (speaker.on) speaker.say(said);
  });

  // a tap on a block of words: read that block (a choice and a control are not text blocks, and a drag that selects words is not a tap)
  const onClick = (event: MouseEvent): void => {
    if (!speaker.on || !(event.target instanceof Element)) return;
    const block = event.target.closest<HTMLElement>('.stage__text-block');
    if (block === null || !READABLE.has(block.dataset['role'] ?? '')) return;
    const selection = window.getSelection();
    if (selection !== null && !selection.isCollapsed) return;
    const words = [...block.querySelectorAll('.stage__text-line')].map((line) => line.textContent ?? '').join(' ');
    if (words.trim() === '') return;
    speaker.sayNow(words);
  };
  stage.addEventListener('click', onClick);

  // the lesson page (a sandboxed frame) offers its steps, questions and hints as words to read, and a tap on its words
  const onLesson = (event: Event): void => {
    if (!speaker.on || !(event instanceof CustomEvent)) return;
    const detail = event.detail as { readonly text?: unknown; readonly tap?: unknown } | null;
    if (typeof detail?.text !== 'string') return;
    if (detail.tap === true) speaker.sayNow(detail.text);
    else speaker.say(detail.text);
  };
  window.addEventListener('conduit:say', onLesson);

  return {
    dispose() {
      window.removeEventListener('conduit:say', onLesson);
      offTranscript();
      offClock();
      offStop();
      stage.removeEventListener('click', onClick);
    },
  };
}
