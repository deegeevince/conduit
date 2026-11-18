// What a tap on the tour does (`/demo`). The pages and the words are the language's (language/src/tour.ts); this only shows them and opens the real
// controls. Nothing here asks the model except "Try it yourself", which sends the card's prompt as the person's own words.

import { chapterSource, howSource, MEMORY_STEPS, TOUR_MEMORY_NOTE, tourChapterOf, tourSource, tourTryFor } from '@conduit/language';
import type { TourAction, TourControl } from '@conduit/language';
import type { StageApp } from '../app/stage-app';

export interface TourDeps {
  /** the canvas is open on the page the app has just shown */
  readonly showCanvas: () => void;
  /** the canvas is open on the answer that is now being played */
  readonly showAnswer: () => void;
  /** a real prompt, sent as the person's own words */
  readonly prompt: (text: string) => void;
  /** opens the real control, from a tap that is itself the gesture */
  readonly open: (control: TourControl) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Waits until the stage is not busy, or the time is up; false when something else took the stage meanwhile. */
async function settled(app: StageApp, turn: string): Promise<boolean> {
  for (let waited = 0; waited < 25000; waited += 200) {
    await sleep(200);
    if (app.lastTurn() !== turn) return false;
    if (!app.status().busy) return true;
  }
  return true;
}

/** The live sequence of the memory card: real scripts, one turn each, so the server remembers them as it remembers an answer. */
async function playMemory(app: StageApp, deps: TourDeps): Promise<void> {
  const tryText = tourTryFor('memory') ?? 'Draw a cat, then draw a dog, then bring the cat back';
  // the bar is up for the whole sequence, so the stage keeps its room from the first turn (fb-004); "Try it yourself" waits for the end
  app.showTourBar(tryText, false);
  let first = '';
  for (const [index, step] of MEMORY_STEPS.entries()) {
    const turn = await app.playScript(step.replaceAll('{1}', first));
    if (index === 0) first = turn;
    if (index === 0) deps.showAnswer();
    if (!(await settled(app, turn))) return;
    await sleep(900);
  }
  app.announce(TOUR_MEMORY_NOTE);
  app.showTourBar(tryText, true);
}

export function mountTour(app: StageApp, deps: TourDeps): void {
  app.onTour((action: TourAction) => {
    switch (action.kind) {
      case 'tour':
        app.showPage(tourSource());
        deps.showCanvas();
        return;
      case 'chapter':
        if (tourChapterOf(action.id) === null) return;
        app.showPage(chapterSource(action.id));
        deps.showCanvas();
        return;
      case 'how':
        app.showPage(howSource(action.id));
        deps.showCanvas();
        return;
      case 'demo':
        if (action.lines === true) app.lang.set(true);
        void app.playTourDemo(action.name).then(deps.showAnswer, (cause: unknown) => app.announce(cause instanceof Error ? cause.message : 'That demo could not be played.'));
        return;
      case 'memory':
        void playMemory(app, deps).catch((cause: unknown) => app.announce(cause instanceof Error ? cause.message : 'That could not be played.'));
        return;
      case 'open':
        deps.open(action.control);
        return;
      case 'try':
        deps.prompt(action.text);
        return;
    }
  });
}
