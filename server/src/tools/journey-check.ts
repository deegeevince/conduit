// pnpm check's journey group: the demo mode that plays a scripted walk through a conversation (web/src/app/journey.ts), on the replay brain, no model.
//
//   script     the journey files read, a bad line refused with its line number, and a model id shortened the way the label shows it
//   play       `/?journey=check` types into the real box, taps a pick, drags a slider, taps a button, undoes and rests; the hook's timings are asserted:
//              typing at about 14 characters a second, typed before sent before the first line (painted, and arrived in the log no later) before rest (the last visible change,
//              before restSettled, the page's own judgement), the drag as long as asked and the
//              slider where it was sent, the undo's own turn; the language pane is open and cannot be closed; no label (the replay brain reports no model)
//   missing    a tap target that never appears stops the journey with a message on `window.__journey`, not an alert
//   mover      a stage with something that goes round for ever (3b of PLAN-romer): `rest` comes and its last visible change is the turn's own, well before the page judged the stage settled
//              (not the mover's, which never stops); a label that goes round, the text layer made again at each frame as a clock that moves words will, is tapped where it is: one act
//              that names it
//   words      a tap asks for whole words: "Io" is not found in "motion" or in "position", and the choice or the label that only has the letters is not tapped for it
//
// Run by `pnpm check` and standalone: `tsx journey-check.ts --url <server>`.

import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { sleep } from './explore-browser';
import { Tab } from './smoke';
import type { CheckResult, Posted } from './smoke';
import type { LensScene } from './lens-check';
import { modelLabel, modelName, parseJourney } from '../../../web/src/app/journey-script';
import { rank } from '../../../web/src/app/journey-words';
import { acts, partOf } from './label-check';
import { chooseView } from './record-view';
import type { JourneyState } from '../../../web/src/app/journey-script';

const read = (name: string): string => readFileSync(fileURLToPath(import.meta.resolve(`@conduit/language/demos/journeys/${name}.journey`)), 'utf8');

const SCREEN = { width: 1280, height: 800 };

/** the stage of `mover.journey`: Jupiter with a moon that turns round it for ever (a loop) and a label on Jupiter, "Io", which the check sets going once the stage has rested */
const MOVER = [
  'scene layout=caption canvas=wide lines=2',
  'circle jup 80,45 12 fill=accent',
  'group arm at=80,45 loop=spin',
  'circle io in=arm 36,0 3 fill=ink',
  'say x1 callout near=jup | Io',
  'say x2 | A moon that never stops.',
].join('\n');

/** the stage of `words.journey`: a label and a choice that each hold the letters "io" in a longer word, and nothing called "Io" */
const WORDS = ['scene layout=caption canvas=wide lines=3', 'circle jup 80,45 12 fill=accent', 'say x1 callout near=jup | position', 'say x2 choice | Show me the motion'].join('\n');

/**
 * What a clock that moves words will do to the text layer (PLAN-motion step 4, not built yet): the label "Io" goes round in a circle of 60 px, a lap in 6 s, and the layer's
 * block for it is made again at every frame (a copy put in the old one's place), so a node a press found is gone by the time it is let go.
 */
const GO_ROUND = `(() => {
  const find = () => [...document.querySelectorAll('.stage__text-block--ask')].find((holder) => holder.dataset.ask === 'Io');
  if (!find()) return false;
  const began = performance.now();
  window.__mover = { rebuilt: 0 };
  const frame = () => {
    const holder = find();
    if (holder) {
      const at = ((performance.now() - began) / 6000) * Math.PI * 2;
      const fresh = holder.cloneNode(true);
      fresh.querySelector('.stage__text-line').style.transform = 'translate(' + Math.round(Math.cos(at) * 600) / 10 + 'px, ' + Math.round(Math.sin(at) * 600) / 10 + 'px)';
      holder.replaceWith(fresh);
      window.__mover.rebuilt += 1;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  return true;
})()`;

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

  // a tap's words are found as whole words (3b of PLAN-romer): "Io" is not in "motion" or "position"; the same words, or the words a label begins with, or has inside it, are
  const ranks: [string, string, number][] = [
    ['Show me the motion', 'Io', -1],
    ['position', 'Io', -1],
    ['Options', 'Io', -1],
    ['Io', 'Io', 0],
    ['Io / Jupiter', 'Io', 1],
    ['Why is it longer at dusk?', 'Why is it longer', 1],
    ['Why is it longer at dusk?', 'why is it long', -1],
    ['Show the Io orbit', 'Io', 2],
    ['Dusk', 'dusk', 0],
    ['Brakes', 'brake', 0],
    ['the brake disc', 'Brakes', 2],
    ['', 'Io', -1],
    ['Io', '', -1],
  ];
  add('journey-whole-words', ranks.filter(([label, wanted, want]) => rank(label, wanted) !== want).map(([label, wanted, want]) => `"${wanted}" in "${label}" ranks ${rank(label, wanted)}, not ${want}`), 'a tap\'s words are found as whole words ("Io" is not in "motion" or "position", "brake" is "brakes"), the same words first, the ones a label begins with next');

  // pnpm record's page: a 1920x1080 film is laid out in 1280x720 at 1.5 (every word 1.5 times as big), the old way is behind --legacy, and a bad flag is said
  const view = (flags: Parameters<typeof chooseView>[0]): string => {
    const got = chooseView(flags);
    return typeof got === 'string' ? got : `${got.width}x${got.height} from ${got.cssWidth}x${got.cssHeight} at ${got.scale} (zoom ${got.zoom})`;
  };
  const views: [string, string, string][] = [
    ['the default', view({}), '1920x1080 from 1280x720 at 1.5 (zoom 1.5)'],
    ['--css 1280x720 --scale 1.5', view({ css: '1280x720', scale: '1.5' }), '1920x1080 from 1280x720 at 1.5 (zoom 1.5)'],
    ['--legacy', view({ legacy: true }), '1920x1080 from 1920x1080 at 2 (zoom 1)'],
    ['--css 1920x1080', view({ css: '1920x1080' }), '1920x1080 from 1920x1080 at 2 (zoom 1)'],
    ['--size 1280x720', view({ size: '1280x720' }), '1280x720 from 1280x720 at 2 (zoom 1)'],
    ['--css 960x540', view({ css: '960x540' }), '1920x1080 from 960x540 at 2 (zoom 2)'],
    ['--scale 3', view({ scale: '3' }), '1920x1080 from 1280x720 at 3 (zoom 1.5)'],
    ['--css 12', view({ css: '12' }), '--css is like 1280x720'],
  ];
  add('journey-record-view', views.filter(([, got, want]) => got !== want).map(([name, got, want]) => `${name} is ${got}, not ${want}`), 'pnpm record lays a 1920x1080 film out in 1280x720 at 1.5 by default; --legacy and an explicit --css keep the old way; a bad --css is refused');
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
        if (rest === undefined || rest.rest === null || rest.restSettled === null) typing.push('the rest step has no rest and restSettled');
        else {
          if (rest.restSettled.perf < type.turnEnded.perf) typing.push('the stage was judged settled before the turn had ended');
          // the film's own clock: the first line painted no earlier than it was sent, and the last visible change came after it and no later than the page's own judgement
          if (type.firstLineEvent === null) typing.push('the first line\'s arrival in the log was not stamped (firstLineEvent)');
          else if (type.firstLine.perf + 1 < type.firstLineEvent.perf) typing.push('the first line painted before it arrived in the log');
          if (rest.rest.perf < type.firstLine.perf) typing.push('the last visible change is before the first line painted');
          if (rest.rest.perf > rest.restSettled.perf) typing.push('the last visible change is after the page judged the stage settled');
        }
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
  const mover = async (): Promise<void> => {
    const began = Date.now();
    note('journey: a mover on stage');
    const out: CheckResult[] = [];
    const add = (check: string, problems: readonly string[], saw: string): void => void out.push({ turn: 0, check, verdict: problems.length === 0 ? 'PASS' : 'FAIL', detail: problems.length === 0 ? saw : problems.join('; ') });
    try {
      const tab = await Tab.open(SCREEN.width, SCREEN.height);
      try {
        // a journey that cannot find its label gives up after 14 s, not the minute it would wait for a person's own
        await tab.send('Page.navigate', { url: `${base}/?journey=mover&journeywait=14` });
        const status = async (): Promise<string | null> => tab.eval<string | null>('window.__journey ? window.__journey.status : null').catch(() => null);
        for (let waited = 0; waited < 30_000 && (await status()) !== 'running'; waited += 250) await sleep(250);
        const problems: string[] = [];
        const played = await tab.eval<string | null>(`Promise.resolve(window.__stage.playScript(${JSON.stringify(MOVER)})).then(() => null, (e) => String(e && e.message || e))`);
        if (played !== null) problems.push(`the script would not play: ${played}`);
        // once the first rest is over, the label is set going: it goes round Jupiter, the layer's line made again at each frame, as it will be when the stage's clock moves words
        let going = false;
        for (let waited = 0; waited < 60_000 && !going; waited += 100) {
          const done = await tab.eval<string | null>('window.__journey && window.__journey.steps[1] ? window.__journey.steps[1].status : null').catch(() => null);
          if (done === 'done' || done === 'stopped') {
            going = (await tab.eval<boolean>(GO_ROUND)) === true;
            break;
          }
          await sleep(100);
        }
        if (!going) problems.push('the label "Io" was not on stage to set going when the first rest was over');
        let journey: JourneyState | null = null;
        for (let waited = 0; waited < Math.max(timeoutMs, 90_000); waited += 250) {
          await sleep(250);
          const now = await status();
          if (now === 'done' || now === 'stopped') break;
        }
        journey = await tab.eval<JourneyState | null>('JSON.parse(JSON.stringify(window.__journey || null))');
        const rebuilt = await tab.eval<number>('window.__mover ? window.__mover.rebuilt : 0').catch(() => 0);
        const [first, , tapped] = journey?.steps.filter((step) => step.op === 'rest' || step.op === 'tap') ?? [];
        const tap = journey?.steps.find((step) => step.op === 'tap');
        if (journey === null || first === undefined || tap === undefined) problems.push('the journey has no rest and tap');
        else {
          if (journey.status !== 'done') problems.push(`the journey ended ${journey.status}: ${journey.message ?? 'no message'}`);
          // the mover moves for ever, so the last thing anyone could see change must not be it: the turn's last change stands well before the page judged the stage settled (which
          // waits a moment of stillness after it)
          if (first.rest === null || first.restSettled === null) problems.push('the first rest has no rest and restSettled');
          else if (first.restSettled.perf - first.rest.perf < 600) problems.push(`the last visible change was ${Math.round(first.restSettled.perf - first.rest.perf)} ms before the stage was judged at rest: it follows the mover, not the turn (a stage that is still is judged after 900 ms)`);
          if (tap.status !== 'done' || tap.tapAt === null) problems.push(`the tap on the label that goes round is ${tap.status}${tap.note === null ? '' : ` (${tap.note})`}`);
          else {
            if (!/^io$/i.test(tap.tapped ?? '')) problems.push(`the tap landed on "${tap.tapped ?? ''}", not on "Io"`);
            if (tap.turn === null) problems.push('the tap opened no turn');
          }
          if (tapped === undefined) problems.push('the second rest is missing');
        }
        if (rebuilt < 50) problems.push(`the label went round for only ${rebuilt} frames`);
        const sent = acts(tab, 0);
        const part = sent.length === 1 ? partOf(sent[0] as Posted) : null;
        if (part === null || part.label !== 'Io') problems.push(`the server was sent ${sent.length} acts naming ${part === null ? 'nothing' : `"${part.label}"`}, not one naming "Io"`);
        const restNote = journey?.steps.find((step) => step.op === 'rest');
        add('journey-mover', problems, `with something going round for ever, rest came ${restNote?.rest === null || restNote?.restSettled === null || restNote === undefined ? '?' : Math.round(restNote.restSettled.perf - restNote.rest.perf)} ms after the last change of the turn, and a label going round (made again ${rebuilt} times) was tapped: one act, naming "Io"`);
      } finally {
        await tab.close();
      }
    } catch (error) {
      add('journey-mover', [error instanceof Error ? error.message : String(error)], '');
    }
    push('journey-mover', began, out);
  };
  const words = async (): Promise<void> => {
    const began = Date.now();
    note('journey: whole words');
    const out: CheckResult[] = [];
    try {
      const tab = await Tab.open(SCREEN.width, SCREEN.height);
      try {
        await tab.send('Page.navigate', { url: `${base}/?journey=words&journeywait=14` });
        for (let waited = 0; waited < 30_000 && (await tab.eval<string | null>('window.__journey ? window.__journey.status : null').catch(() => null)) !== 'running'; waited += 250) await sleep(250);
        const problems: string[] = [];
        const played = await tab.eval<string | null>(`Promise.resolve(window.__stage.playScript(${JSON.stringify(WORDS)})).then(() => null, (e) => String(e && e.message || e))`);
        if (played !== null) problems.push(`the script would not play: ${played}`);
        let journey: JourneyState | null = null;
        for (let waited = 0; waited < Math.max(timeoutMs, 90_000); waited += 250) {
          await sleep(250);
          const now = await tab.eval<string | null>('window.__journey ? window.__journey.status : null').catch(() => null);
          if (now === 'done' || now === 'stopped') break;
        }
        journey = await tab.eval<JourneyState | null>('JSON.parse(JSON.stringify(window.__journey || null))');
        const [refused, taken] = journey?.steps.filter((step) => step.op === 'tap') ?? [];
        if (journey === null || refused === undefined || taken === undefined) problems.push('the journey has no taps');
        else {
          if (journey.status !== 'done') problems.push(`the journey ended ${journey.status}: ${journey.message ?? 'no message'}`);
          if (refused.status !== 'skipped' || refused.tapAt !== null) problems.push(`a tap for "Io" was ${refused.status} and touched "${refused.tapped ?? 'nothing'}": the letters are in "motion" and in "position", and a word is not found in another`);
          if (!/^position$/i.test(taken.tapped ?? '') || taken.used !== 'position') problems.push(`"Io / position" tapped ${taken.tapped === null ? 'nothing' : `"${taken.tapped}"`} (by "${taken.used ?? ''}"), not the label "position"`);
        }
        const sent = acts(tab, 0);
        const part = sent.length === 1 ? partOf(sent[0] as Posted) : null;
        const choices = tab.posted.filter((turn) => turn.kind === 'tap');
        if (choices.length > 0) problems.push(`${choices.length} choice${choices.length === 1 ? ' was' : 's were'} tapped`);
        if (part === null || part.label !== 'position') problems.push(`the server was sent ${sent.length} acts naming ${part === null ? 'nothing' : `"${part.label}"`}, not one naming "position"`);
        out.push({ turn: 0, check: 'journey-words', verdict: problems.length === 0 ? 'PASS' : 'FAIL', detail: problems.length === 0 ? '"Io" tapped nothing (it is in "motion" and "position" only as letters), and the label "position" was tapped by its own word: one act' : problems.join('; ') });
      } finally {
        await tab.close();
      }
    } catch (error) {
      out.push({ turn: 0, check: 'journey-words', verdict: 'FAIL', detail: error instanceof Error ? error.message : String(error) });
    }
    push('journey-words', began, out);
  };
  await Promise.all([missing(), long(), mover(), words()]);
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
