// pnpm check's journey group: the demo mode that plays a scripted walk through a conversation (web/src/app/journey.ts), on the replay brain, no model.
//
//   script     the journey files read, a bad line refused with its line number, and a model id shortened the way the label shows it
//   play       `/?journey=check` types into the real box, taps a pick, drags a slider, taps a button, undoes and rests; the hook's timings are asserted:
//              typing at about 14 characters a second, typed before sent before the first line before rest, the drag as long as asked and the
//              slider where it was sent, the undo's own turn; the language pane is open and cannot be closed; no label (the replay brain reports no model)
//   missing    a tap target that never appears stops the journey with a message on `window.__journey`, not an alert
//
// Run by `pnpm check` and standalone: `tsx journey-check.ts --url <server>`.

import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { sleep } from './explore-browser';
import { Tab } from './smoke';
import type { CheckResult } from './smoke';
import type { LensScene } from './lens-check';
import { modelLabel, modelName, parseJourney } from '../../../web/src/app/journey-script';
import type { JourneyState } from '../../../web/src/app/journey-script';

const read = (name: string): string => readFileSync(fileURLToPath(import.meta.resolve(`@conduit/language/demos/journeys/${name}.journey`)), 'utf8');

const SCREEN = { width: 1280, height: 800 };

/** the script's own reading: pure, no browser */
export function scriptResults(): CheckResult[] {
  const results: CheckResult[] = [];
  const add = (check: string, problems: readonly string[], saw: string): void => void results.push({ turn: 0, check, verdict: problems.length === 0 ? 'PASS' : 'FAIL', detail: problems.length === 0 ? saw : problems.join('; ') });

  const car = parseJourney(read('car'));
  const problems: string[] = [];
  if ('error' in car) problems.push(car.error);
  else {
    const ops = car.steps.map((step) => step.op).join(' ');
    if (!/^hold type rest hold tap rest hold type rest hold drag hold back rest hold tap rest hold drag hold type rest hold type rest hold$/.test(ops)) problems.push(`the car journey reads as: ${ops}`);
    const drag = car.steps.find((step) => step.op === 'drag');
    if (drag === undefined || drag.target !== 'speed' || drag.from !== 50 || drag.to !== 100 || drag.seconds !== 4) problems.push('the first drag should be speed 50 > 100 over 4 s');
    if (car.steps.find((step) => step.op === 'type')?.text !== 'Show me the main parts of a car' || car.steps.find((step) => step.op === 'type')?.name !== 'car') problems.push('the first prompt is not the owner\'s');
  }
  add('journey-script-car', problems, `the car journey reads: ${'steps' in car ? car.steps.length : 0} steps`);

  const bad = ['type | hello\ntap Brakes', 'drag speed fifty > 100', 'wiggle | now', 'hold', ''];
  const wrong: string[] = [];
  for (const text of bad) {
    const parsed = parseJourney(text);
    if (!('error' in parsed)) wrong.push(`${JSON.stringify(text)} was accepted`);
  }
  const named = parseJourney('type | hi\ntap Brakes');
  if (!('error' in named) || !named.error.startsWith('line 2:')) wrong.push('a bad line is not named by its number');
  add('journey-script-refuses', wrong, 'a step with something wrong in it is refused, with its line number');

  const names: [string, string][] = [
    ['claude-opus-5-5', 'Opus 5.5'],
    ['claude-sonnet-4-5-20250929', 'Sonnet 4.5'],
    ['claude-3-5-haiku-20241022', 'Haiku 3.5'],
    ['claude-opus-4-1[1m]', 'Opus 4.1'],
    ['claude-opus-5', 'Opus 5'],
    ['mystery_7', 'mystery_7'],
  ];
  const mapped = names.filter(([id, want]) => modelName(id) !== want).map(([id, want]) => `${id} is ${modelName(id)}, not ${want}`);
  if (modelLabel('claude-opus-5-5', 'medium') !== 'Opus 5.5 · medium') mapped.push(`the label reads ${modelLabel('claude-opus-5-5', 'medium')}`);
  add('journey-model-name', mapped, 'a reported model id is shortened (claude-opus-5-5 is Opus 5.5) and the label adds the effort');
  return results;
}

async function played(tab: Tab, base: string, query: string, ms: number): Promise<JourneyState> {
  await tab.send('Page.navigate', { url: `${base}/?${query}` });
  for (let waited = 0; waited < ms; waited += 250) {
    await sleep(250);
    const status = await tab.eval<string | null>('window.__journey ? window.__journey.status : null').catch(() => null);
    if (status === 'done' || status === 'stopped') break;
  }
  return tab.eval<JourneyState>('JSON.parse(JSON.stringify(window.__journey || null))');
}

export async function journeyGroup(base: string, dir: string, timeoutMs: number, note: (text: string) => void = () => undefined): Promise<LensScene[]> {
  await mkdir(dir, { recursive: true });
  const scenes: LensScene[] = [];
  const push = (name: string, began: number, results: CheckResult[]): void => void scenes.push({ name, picture: '', results, seconds: (Date.now() - began) / 1000 });

  let began = Date.now();
  push('journey-script', began, scriptResults());

  began = Date.now();
  note('journey: play');
  const results: CheckResult[] = [];
  const add = (check: string, problems: readonly string[], saw: string): void => void results.push({ turn: 0, check, verdict: problems.length === 0 ? 'PASS' : 'FAIL', detail: problems.length === 0 ? saw : problems.join('; ') });
  try {
    const tab = await Tab.open(SCREEN.width, SCREEN.height);
    try {
      const journey = await played(tab, base, 'journey=check', Math.max(timeoutMs, 90_000));
      const steps = journey.steps;
      const problems: string[] = [];
      if (journey.status !== 'done') problems.push(`the journey ended ${journey.status}: ${journey.message ?? 'no message'}`);
      for (const step of steps) if (step.status !== 'done') problems.push(`step ${step.n} (${step.op}) is ${step.status}${step.note === null ? '' : `: ${step.note}`}`);
      add('journey-ran', problems, `all ${steps.length} steps ran to the end`);

      const type = steps.find((step) => step.op === 'type');
      const typing: string[] = [];
      if (type === undefined || type.typingStart === null || type.typingEnd === null || type.sent === null || type.firstLine === null || type.turnEnded === null) typing.push('the typing step has no typingStart, typingEnd, sent, firstLine and turnEnded');
      else {
        const seconds = (type.typingEnd.perf - type.typingStart.perf) / 1000;
        const rate = (type.text.length - 1) / seconds;
        if (rate < 9 || rate > 15) typing.push(`typed at ${rate.toFixed(1)} characters a second, not about 12`);
        if (!(type.typingStart.perf < type.typingEnd.perf && type.typingEnd.perf < type.sent.perf && type.sent.perf < type.firstLine.perf && type.firstLine.perf < type.turnEnded.perf)) typing.push('typingStart, typingEnd, sent, firstLine and turnEnded are not in that order');
        if (Math.abs(type.typingStart.at - type.typingStart.perf - (type.typingEnd.at - type.typingEnd.perf)) > 50) typing.push('the page clock and performance.now() drift apart');
        const rest = steps.find((step) => step.op === 'rest');
        if (rest === undefined || rest.rest === null || rest.rest.perf < type.turnEnded.perf) typing.push('rest came before the turn had ended');
      }
      add('journey-typing', typing, `typed at about 12 characters a second; sent, first line, turn end and rest are in order (${type?.text ?? ''})`);

      const tap = steps.find((step) => step.op === 'tap');
      const taps: string[] = [];
      if (tap === undefined || tap.tapAt === null || tap.tapped === null) taps.push('the tap step has no tapAt');
      else if (!/dusk/i.test(tap.tapped)) taps.push(`the tap landed on "${tap.tapped}", not on Dusk`);
      add('journey-tap', taps, `a tap landed on "${tap?.tapped ?? ''}"`);

      const dragStep = steps.find((step) => step.op === 'drag');
      const drags: string[] = [];
      if (dragStep === undefined || dragStep.dragStart === null || dragStep.dragEnd === null || dragStep.drag === null) drags.push('the drag step has no dragStart, dragEnd and drag');
      else {
        const took = (dragStep.dragEnd.perf - dragStep.dragStart.perf) / 1000;
        if (took < 1.4 || took > 3.2) drags.push(`the drag took ${took.toFixed(2)} s, asked for 1.5`);
        if (Math.abs(dragStep.drag.reached - 70) > 2) drags.push(`the slider ended at ${dragStep.drag.reached}, asked for 70`);
        if (dragStep.drag.readout.before.join('|') === dragStep.drag.readout.after.join('|')) drags.push(`the words bound to the slider did not change as it moved (${JSON.stringify(dragStep.drag.readout)})`);
      }
      add('journey-drag', drags, `the knob was dragged for ${dragStep?.dragStart === null || dragStep?.dragEnd === null || dragStep === undefined ? '?' : ((dragStep.dragEnd.perf - dragStep.dragStart.perf) / 1000).toFixed(1)} s to ${dragStep?.drag?.reached ?? '?'}, and the words bound to it changed`);

      const undo = steps.find((step) => step.op === 'undo');
      const undoes: string[] = [];
      if (undo === undefined || undo.tapAt === null || undo.turn === null) undoes.push('the undo step tapped nothing or opened no turn');
      const last = steps[steps.length - 1];
      if (last === undefined || last.rest === null) undoes.push('the last rest never came');
      add('journey-undo', undoes, 'the Undo chip was tapped, its turn opened, and the stage rested after it');

      const pane = await tab.eval<{ open: boolean; switchShown: boolean; labelShown: boolean }>(
        `(() => { const pane = document.querySelector('.lang'); const label = document.querySelector('.model-label'); const item = document.querySelector('.composer__item[data-item="lines"]'); return { open: !!pane && !pane.hidden && document.getElementById('app').dataset.lang === 'on', switchShown: !!item && !item.hidden && getComputedStyle(item).display !== 'none', labelShown: !!label && !label.hidden }; })()`,
      );
      const panes: string[] = [];
      if (!pane.open) panes.push('the language pane is not open in demo mode');
      if (pane.switchShown) panes.push('the menu still offers to close the language pane');
      if (pane.labelShown) panes.push('a model label shows though the replay brain reported no model');
      add('journey-pane', panes, 'the language pane is open in demo mode and has no switch; no model label with a brain that reports none');

      const follow = journey.follow;
      const followed: string[] = [];
      if (follow.samples < 5) followed.push(`the pane's follow was sampled only ${follow.samples} times`);
      if (follow.longestMissMs > 700) followed.push(`the line being drawn was out of view for ${follow.longestMissMs} ms at a stretch (${follow.misses} of ${follow.samples} samples)`);
      add('journey-follow', followed, `the line being drawn stayed in view (${follow.misses} of ${follow.samples} samples out, longest ${follow.longestMissMs} ms)`);

      const drained = tab.drain();
      const errors = [...drained.consoleErrors, ...drained.failedRequests].map((entry) => entry.text);
      add('journey-console', errors.slice(0, 3), 'no console errors or failed requests');
    } finally {
      await tab.close();
    }
  } catch (error) {
    add('journey-play', [error instanceof Error ? error.message : String(error)], '');
  }
  push('journey-play', began, results);

  const missing = async (): Promise<void> => {
  const began = Date.now();
  note('journey: missing target');
  const stopped: CheckResult[] = [];
  try {
    const tab = await Tab.open(SCREEN.width, SCREEN.height);
    try {
      let dialog = false;
      tab.browser.onEvent((event) => {
        if (event.sessionId === tab.session && event.method === 'Page.javascriptDialogOpening') dialog = true;
      });
      await tab.send('Page.enable').catch(() => undefined);
      const journey = await played(tab, base, 'journey=missing&journeywait=3', 40_000);
      const problems: string[] = [];
      if (journey.status !== 'stopped') problems.push(`the journey is ${journey.status}, not stopped`);
      if (!/never appeared/.test(journey.message ?? '') || !/A label no answer has/.test(journey.message ?? '')) problems.push(`the message does not say what never appeared: ${journey.message ?? 'none'}`);
      if (dialog) problems.push('an alert was shown');
      stopped.push({ turn: 0, check: 'journey-missing-target', verdict: problems.length === 0 ? 'PASS' : 'FAIL', detail: problems.length === 0 ? `stopped with: ${journey.message}` : problems.join('; ') });
    } finally {
      await tab.close();
    }
  } catch (error) {
    stopped.push({ turn: 0, check: 'journey-missing-target', verdict: 'FAIL', detail: error instanceof Error ? error.message : String(error) });
  }
  push('journey-missing', began, stopped);
  };
  const long = async (): Promise<void> => {
    const began = Date.now();
    note('journey: a long turn');
    const out: CheckResult[] = [];
    try {
      const tab = await Tab.open(SCREEN.width, SCREEN.height);
      try {
        const journey = await played(tab, base, 'journey=follow', Math.max(timeoutMs, 120_000));
        const problems: string[] = [];
        if (journey.status !== 'done') problems.push(`the journey ended ${journey.status}: ${journey.message ?? 'no message'}`);
        if (journey.follow.samples < 100) problems.push(`the lit line was sampled only ${journey.follow.samples} times`);
        if (journey.follow.longestMissMs > 700) problems.push(`the lit line was out of view for ${journey.follow.longestMissMs} ms at a stretch (${journey.follow.misses} of ${journey.follow.samples} samples)`);
        out.push({ turn: 0, check: 'journey-follow-long', verdict: problems.length === 0 ? 'PASS' : 'FAIL', detail: problems.length === 0 ? `down a page of lines and back to the top of the next turn, the lit line stayed in view (${journey.follow.misses} of ${journey.follow.samples} samples out, longest ${journey.follow.longestMissMs} ms)` : problems.join('; ') });
      } finally {
        await tab.close();
      }
    } catch (error) {
      out.push({ turn: 0, check: 'journey-follow-long', verdict: 'FAIL', detail: error instanceof Error ? error.message : String(error) });
    }
    push('journey-follow-long', began, out);
  };
  await Promise.all([missing(), long()]);
  return scenes;
}

const flag = process.argv.indexOf('--url');
if (import.meta.url === `file://${process.argv[1]}` && flag > 0) {
  const base = (process.argv[flag + 1] ?? '').replace(/\/+$/, '');
  void journeyGroup(base, '/tmp/conduit-journey-check', 120_000, (text) => process.stdout.write(`${text}\n`)).then((scenes) => {
    let failed = 0;
    for (const scene of scenes) for (const result of scene.results) {
      process.stdout.write(`${result.verdict} ${result.check}: ${result.detail}\n`);
      if (result.verdict === 'FAIL') failed += 1;
    }
    process.exit(failed === 0 ? 0 : 1);
  });
}
