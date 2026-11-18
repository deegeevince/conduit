// pnpm check's fb-100 group: a labelled drawing on stage is changed in place (a real page, the replay brain, no model). The owner's film asks for the parts of a car, then to swap the
// engine for an electric motor and battery and keep the rest of the car the same; the brain's answer to that is played as it writes it (the figure said again under its id, the parts that
// go dropped, new ones added), after the first answer has come to rest:
//
//   kept      the stage keeps its scene, the car is the same element in the same box, and the words of the first answer still stand
//   parts     the labels of the parts that stay (the body, the wheel) are still on the drawing; the engine, the tank and the exhaust are gone; the motor and the battery pack are there
//   still     the car stays put: the swap changes the words round it (the aside gets shorter) and widens a label ("electric motor" for "engine"), and the figure's room moves by at most 2 px,
//             its scale by at most 1% and its place in the room by at most 2 px (the figure is not laid out afresh from what is round it)
//   drawn     the same swap of a car the brain drew with shapes (YOUR DRAWING NOW: shapes by id, callouts near them): the engine, tank and its callouts dropped, a motor drawn, the words
//             revised and the choice of the first answer left to go (the foot of the stage empties and the column grows); the body and the wheels keep their ids and their boxes
//   plays     the same swap arriving as a burst (every line within a few milliseconds, as a brain that called a tool first writes them) is not applied in one frame: read frame by frame
//             (`window.__stage.figureFrames`), the engine is still partly visible 200 ms after its drop, the new motor is partly drawn some moments later, the engine has gone before the
//             motor is drawn, the motor's label comes last, and the whole takes a few seconds
//   console   no console error and no failed request
//
// The language half is `pnpm timeline` (`fb-100`: the schedule, and the brief that names the parts and teaches this). Run by `pnpm check` (as `fb-100`) and standalone: `tsx inplace-check.ts --url <server>`.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sleep } from './explore-browser';
import { Conversation, Tab } from './smoke';
import type { CheckResult, Options } from './smoke';
import type { LensScene } from './lens-check';
import { LABEL_SCREEN, labelsOf } from './label-check';

const CAR = [
  'scene layout=caption canvas=wide',
  'figure car cutaway | The main parts of a car',
  'path body fill=steel label="body" | M6 62 L6 50 C6 46 10 44 16 43 L90 41 L90 62 Z',
  'rect engine 70,44 13x12 in=body fill=steel label="engine"',
  'rect tank 25,51 13x7 in=body fill=red label="fuel tank"',
  'path exhaust stroke=dim thick=1.5 label="exhaust" | M72 60 L20 62',
  'ellipse wheel 22,64 9x9 fill=rubber label="wheel"',
  'route power ink=accent via=tank,engine,wheel',
  'step show=tank,engine | Fuel burns in the engine.',
  'step show=wheel | The wheels turn.',
  'end',
  'say x1 aside | Not shown: the brakes at each wheel, the battery and the suspension.',
  'say x3 choice | How does the engine work?',
  'say x5 choice | What changes in an electric car?',
].join('\n');

/** the swap, and the words round the car, in the two ways the brain changes them: the aside is dropped for a shorter one, or the aside and the choices are revised in place (an old line lingers struck beside its new one) */
const SWAP = (words: 'shorter' | 'revised'): string =>
  [
    'figure car cutaway | The same car, electric',
    'drop engine tank exhaust',
    'rect motor 70,48 12x10 in=body fill=copper label="electric motor"',
    'rect pack 25,56 40x6 in=body fill=blue label="battery pack"',
    'route power ink=accent via=pack,motor,wheel',
    'step show=pack,motor | The battery feeds the motor.',
    'step show=wheel | The wheels turn.',
    'end',
    ...(words === 'shorter' ? ['drop x1', 'say x2 aside | A motor and a battery.'] : ['revise x1 | Kept as asked, but a real electric car has no fuel tank or exhaust.', 'revise x3 | Remove the fuel tank and exhaust too', 'revise x5 | How does an electric motor work?']),
  ].join('\n');

interface Resting {
  readonly room: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly scale: number;
  readonly offset: { readonly x: number; readonly y: number };
  readonly parts: number;
}

interface Standing {
  readonly key: string;
  readonly id: string;
  readonly text: string;
  readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

export async function inplaceGroup(base: string, dir: string, timeoutMs: number, note: (text: string) => void = () => undefined): Promise<LensScene[]> {
  await mkdir(dir, { recursive: true });
  const scenes: LensScene[] = [];
  for (const words of ['shorter', 'revised'] as const) scenes.push(await inplaceCase(base, dir, timeoutMs, note, words));
  scenes.push(await drawnCase(base, dir, timeoutMs, note));
  scenes.push(await playsCase(base, dir, timeoutMs, note, 'kept'));
  scenes.push(await playsCase(base, dir, timeoutMs, note, 'refit'));
  return scenes;
}

interface FrameView {
  readonly key: string;
  readonly id: string;
  readonly kind: 'shape' | 'text';
  readonly opacity: number;
  readonly progress: number;
}

/** how much of the figure's part `id` is shown in these frames: its biggest opacity, and its stroke drawn so far (the smallest) */
const partOf = (frames: readonly FrameView[], id: string): { readonly seen: number; readonly progress: number } => {
  const mine = frames.filter((frame) => frame.id === id && frame.kind === 'shape' && !/\/(label|route):/.test(frame.key));
  return { seen: mine.reduce((most, frame) => Math.max(most, frame.opacity), 0), progress: mine.length === 0 ? 0 : mine.reduce((least, frame) => Math.min(least, frame.progress), 1) };
};
const labelOf = (frames: readonly FrameView[], id: string): number => frames.filter((frame) => frame.id === id && frame.kind === 'text' && /\/label:/.test(frame.key)).reduce((most, frame) => Math.max(most, frame.progress * frame.opacity), 0);

/** a swap that adds a part beyond the body (a tow bar): the figure is wider than it was, so the kit cannot keep the car where it was and as big, and sets it afresh in the same room (the parts are the same parts) */
const SWAP_REFIT = [
  'figure car cutaway | The same car, electric',
  'drop engine tank exhaust',
  'rect motor 70,48 12x10 in=body fill=copper label="electric motor"',
  'rect pack 25,56 40x6 in=body fill=blue label="battery pack"',
  'rect hitch 96,58 26x5 fill=steel label="tow bar"',
  'route power ink=accent via=pack,motor,wheel',
  'step show=pack,motor | The battery feeds the motor.',
  'step show=wheel | The wheels turn.',
  'end',
].join('\n');

async function playsCase(base: string, dir: string, timeoutMs: number, note: (text: string) => void, which: 'kept' | 'refit'): Promise<LensScene> {
  const began = Date.now();
  note(`fb-100: a change to a figure arriving as a burst plays in order (${which})`);
  const results: CheckResult[] = [];
  const add = (check: string, problems: readonly string[], good: string): void => void results.push({ turn: 0, check, verdict: problems.length === 0 ? 'PASS' : 'FAIL', detail: problems.length === 0 ? good : problems.join('; ') });
  try {
    // (the refit case is on a narrower page, where the labels have less room beside the car)
    const narrow = which === 'refit';
    const tab = await Tab.open(narrow ? 900 : LABEL_SCREEN.width, narrow ? 660 : LABEL_SCREEN.height);
    try {
      const options: Options = { url: base, screens: [], out: dir, turns: new Set(), timeoutMs, parallel: false, demo: false, quiet: true, page: '', say: null, chat: 'off' };
      const conv = new Conversation(tab, options, narrow ? { ...LABEL_SCREEN, name: '900x660', width: 900, height: 660 } : LABEL_SCREEN, dir);
      await tab.send('DOM.enable');
      await conv.start();
      const play = async (script: string): Promise<string> => {
        const played = await tab.eval<string | null>(`Promise.resolve(window.__stage.playScript(${JSON.stringify(script)})).then(() => null, (e) => String(e && e.message || e))`);
        return played !== null ? `the script would not play: ${played}` : conv.rest(true);
      };
      const problems: string[] = [];
      const first = await play(CAR);
      if (first !== '') problems.push(first);
      const restBefore = await tab.eval<Resting | null>(`(() => { const key = window.__stage.elements().find((e) => e.id === 'car')?.key; const last = key && window.__figures && window.__figures.get(key); return last ? { room: last.room, scale: last.layout.scale, offset: last.layout.offset, parts: last.layout.input.parts.length } : null; })()`);
      const second = await play(which === 'kept' ? SWAP('revised') : SWAP_REFIT);
      if (second !== '') problems.push(second);
      const restAfter = await tab.eval<Resting | null>(`(() => { const key = window.__stage.elements().find((e) => e.id === 'car')?.key; const last = key && window.__figures && window.__figures.get(key); return last ? { room: last.room, scale: last.layout.scale, offset: last.layout.offset, parts: last.layout.input.parts.length } : null; })()`);
      if (which === 'refit' && (restBefore === null || restAfter === null || Math.abs(restAfter.scale / restBefore.scale - 1) < 0.03)) problems.push(`this swap was to make the kit fit the car afresh, and it did not (scale ${restBefore?.scale.toFixed(2)} then ${restAfter?.scale.toFixed(2)}): this is not the case the check is for`);
      // the turn is played back from the start (seek), so that it can be read at any second of it
      await tab.eval<number>('(window.__stage.seek(0), 0)');
      const lines = await tab.eval<{ text: string; start: number; end: number }[]>(`window.__stage.lines().map((l) => ({ text: l.text, start: l.start, end: l.end }))`);
      const dropLine = lines.find((line) => /drop engine/.test(line.text));
      const edits = lines.filter((line) => /^(row car \||figure car)/.test(line.text) || /^(drop|rect|route|step) /.test(line.text));
      if (dropLine === undefined) problems.push('the turn has no line that drops the engine');
      else {
        const spread = Math.max(...edits.map((line) => line.start)) - Math.min(...edits.map((line) => line.start));
        if (spread > 0.5) problems.push(`the lines of the change did not arrive as a burst (they span ${spread.toFixed(2)} s: ${edits.map((line) => `${line.start.toFixed(2)} ${line.text.slice(0, 18)}`).join(' / ')}): this is not the case the check is for`);
        const frames = (seconds: number): Promise<FrameView[]> => tab.eval<FrameView[]>(`window.__stage.figureFrames(${seconds})`);
        const at = dropLine.start;
        const before = await frames(at - 0.05);
        const early = await frames(at + 0.2);
        if (partOf(before, 'engine').seen < 0.5) problems.push('before the drop the engine is not drawn: the figure as it was is not shown');
        const was = partOf(before, 'engine').seen;
        const soon = partOf(early, 'engine').seen;
        if (!(soon > 0.05 * was && soon < 0.95 * was)) problems.push(`200 ms after its drop the engine is shown at ${(100 * soon / Math.max(1e-6, was)).toFixed(0)}% (it should be fading: partly visible)`);
        if (partOf(early, 'motor').seen > 0.05) problems.push('200 ms after the drop the new motor is already drawn: what goes should go before what comes');
        // every tenth of a second to seven: when the engine has gone, when the motor is first drawn and when it is whole, when its label comes
        let gone = -1;
        let drawn = -1;
        let whole = -1;
        let named = -1;
        let partly = false;
        let last = 0;
        const dimmed: string[] = [];
        const everything: FrameView[][] = [];
        // to the end of the turn (the choices and the words that come after the change are part of it) and a second more
        const lasts = Math.min(24, Math.max(...lines.map((line) => line.end)) - at + 1);
        for (let step = 0; step <= Math.max(70, Math.ceil(lasts * 10)); step += 1) everything.push(await frames(at + step / 10));
        everything.forEach((now, step) => {
          const t = step / 10;
          if (gone < 0 && partOf(now, 'engine').seen < 0.02) gone = t;
          const motor = partOf(now, 'motor');
          if (drawn < 0 && motor.seen > 0.02) drawn = t;
          if (motor.seen > 0.02 && motor.progress > 0.1 && motor.progress < 0.9) partly = true;
          if (whole < 0 && motor.seen > 0.98 && motor.progress > 0.99) whole = t;
          if (named < 0 && labelOf(now, 'motor') > 0.02) named = t;
          // what the change leaves alone is never faded or redrawn: the body, the wheel and their labels stay lit, whole, at every moment of the turn
          for (const kept of ['body', 'wheel']) {
            const here = partOf(now, kept);
            const was = partOf(before, kept);
            if (here.seen < 0.98 * was.seen || here.progress < 0.99) dimmed.push(`${kept} at ${t.toFixed(1)} s (shown ${(100 * here.seen / Math.max(1e-6, was.seen)).toFixed(0)}%, stroke ${(100 * here.progress).toFixed(0)}%)`);
            if (labelOf(now, kept) < 0.98 * Math.max(1e-6, labelOf(before, kept))) dimmed.push(`the label of ${kept} at ${t.toFixed(1)} s`);
          }
          const moving = partOf(now, 'motor').seen < 0.99 || partOf(now, 'motor').progress < 0.99 || partOf(now, 'pack').progress < 0.99 || labelOf(now, 'motor') < 0.99;
          if (moving) last = t;
        });
        if (problems.length > 0) problems.push('frames: ' + everything.slice(0, 40).map((now, step) => `${(step / 10).toFixed(1)}s e${partOf(now, 'engine').seen.toFixed(2)} m${partOf(now, 'motor').seen.toFixed(2)}/${partOf(now, 'motor').progress.toFixed(2)} n${now.length}`).join(' | '));
        if (dimmed.length > 0) problems.push(`what the change left alone was faded or redrawn: ${dimmed.slice(0, 4).join(', ')}${dimmed.length > 4 ? ` and ${dimmed.length - 4} more` : ''}`);
        if (!partly) problems.push('the motor was never seen partly drawn (its stroke part-way along) in seven seconds');
        if (gone < 0) problems.push('the engine had not gone seven seconds after its drop');
        if (drawn >= 0 && gone >= 0 && drawn + 0.05 < gone) problems.push(`the motor is drawn (${drawn.toFixed(1)} s) before the engine has gone (${gone.toFixed(1)} s)`);
        if (named >= 0 && whole >= 0 && named + 0.05 < whole) problems.push(`the motor's label (${named.toFixed(1)} s) comes before the motor is whole (${whole.toFixed(1)} s)`);
        if (whole < 0) problems.push('the motor was not whole seven seconds after the drop');
        if (last < 1) problems.push(`the change took ${last.toFixed(1)} s to play: it should take a few seconds, not a frame`);
        add(`fb-100-plays-${which}-order`, problems, `the burst played in order: the engine fades (gone by ${gone.toFixed(1)} s), the motor is drawn in from ${drawn.toFixed(1)} s (whole at ${whole.toFixed(1)} s), its label at ${named.toFixed(1)} s; ${last.toFixed(1)} s in all`);
      }
      if (dropLine === undefined) add(`fb-100-plays-${which}-order`, problems, '');
      const drained = tab.drain();
      add(`fb-100-plays-${which}-console`, [...drained.consoleErrors, ...drained.failedRequests].map((entry) => entry.text).slice(0, 3), 'no console errors or failed requests');
    } finally {
      await tab.close();
    }
  } catch (error) {
    add(`fb-100-plays-${which}`, [error instanceof Error ? error.message : String(error)], '');
  }
  return { name: `fb-100-plays-${which}`, picture: '', results, seconds: (Date.now() - began) / 1000 };
}

/** a car as the brain draws one with shapes: parts by id and a callout on each part that is named */
const DRAWN_CAR = [
  'scene layout=figure canvas=wide',
  'color steel=#9aa5b1 red=#c8452f blue=#3d6fb0 rubber=#2b2b2b',
  'path body fill=steel stroke=ink thick=0.8 | M15 62 L17 46 C20 42 30 40 40 40 L58 38 C66 26 78 20 92 20 L108 20 C118 20 126 30 132 38 L140 40 C145 43 146 54 145 62 Z',
  'rect engine 23,42 23x14 fill=red',
  'rect tank 100,48 24x10 fill=blue',
  'circle front 38,66 11 fill=rubber',
  'circle rear 118,66 11 fill=rubber',
  'say x2 callout near=engine | engine',
  'say x3 callout near=tank | fuel tank',
  'say x1 aside | Not shown: the brakes at each wheel, the battery and the suspension.',
  'say x5 choice | What changes in an electric car?',
].join('\n');

const DRAWN_SWAP = ['drop tank x3 x2', 'rect motor 23,44 20x10 fill=blue', 'rect pack 60,52 36x6 fill=red', 'say x4 callout near=motor | electric motor', 'say x6 callout near=pack | battery pack', 'revise x1 | Kept as asked, but a real electric car has no fuel tank or exhaust.'].join('\n');

async function drawnCase(base: string, dir: string, timeoutMs: number, note: (text: string) => void): Promise<LensScene> {
  const began = Date.now();
  note('fb-100: a car drawn with shapes is changed in place');
  const results: CheckResult[] = [];
  const add = (check: string, problems: readonly string[], good: string): void => void results.push({ turn: 0, check, verdict: problems.length === 0 ? 'PASS' : 'FAIL', detail: problems.length === 0 ? good : problems.join('; ') });
  try {
    const tab = await Tab.open(LABEL_SCREEN.width, LABEL_SCREEN.height);
    try {
      const options: Options = { url: base, screens: [], out: dir, turns: new Set(), timeoutMs, parallel: false, demo: false, quiet: true, page: '', say: null, chat: 'off' };
      const conv = new Conversation(tab, options, LABEL_SCREEN, dir);
      await tab.send('DOM.enable');
      await conv.start();
      const play = async (script: string): Promise<string> => {
        const played = await tab.eval<string | null>(`Promise.resolve(window.__stage.playScript(${JSON.stringify(script)})).then(() => null, (e) => String(e && e.message || e))`);
        return played !== null ? `the script would not play: ${played}` : conv.rest(true);
      };
      const standing = (): Promise<Standing[]> => tab.eval<Standing[]>(`window.__stage.elements().filter((e) => e.opacity > 0.05 && e.phase !== 'struck').map((e) => ({ key: e.key, id: e.id, text: String(e.text || ''), box: e.box }))`);
      const problems: string[] = [];
      const first = await play(DRAWN_CAR);
      if (first !== '') problems.push(first);
      const before = await standing();
      const second = await play(DRAWN_SWAP);
      if (second !== '') problems.push(second);
      const after = await standing();
      for (const id of ['body', 'front', 'rear']) {
        const was = before.find((element) => element.id === id);
        const now = after.find((element) => element.id === id);
        if (was === undefined || now === undefined) problems.push(`${id} is not on the stage ${was === undefined ? 'before' : 'after'} the swap`);
        else for (const side of ['x', 'y', 'width', 'height'] as const) if (Math.abs(now.box[side] - was.box[side]) > 2) problems.push(`${id} moved: ${side} ${was.box[side].toFixed(1)} then ${now.box[side].toFixed(1)} px`);
      }
      for (const gone of ['tank', 'x3']) if (after.some((element) => element.id === gone)) problems.push(`${gone} is still on the stage`);
      for (const added of ['motor', 'pack']) if (!after.some((element) => element.id === added)) problems.push(`${added} was not drawn`);
      add('fb-100-drawn-still', problems, 'the car drawn with shapes: its body and wheels are the same pixels in the same place after the swap, the tank and its callout are gone, the motor and the pack are drawn');
      const drained = tab.drain();
      add('fb-100-drawn-console', [...drained.consoleErrors, ...drained.failedRequests].map((entry) => entry.text).slice(0, 3), 'no console errors or failed requests');
    } finally {
      await tab.close();
    }
  } catch (error) {
    add('fb-100-drawn', [error instanceof Error ? error.message : String(error)], '');
  }
  return { name: 'fb-100-drawn', picture: '', results, seconds: (Date.now() - began) / 1000 };
}

async function inplaceCase(base: string, dir: string, timeoutMs: number, note: (text: string) => void, words: 'shorter' | 'revised'): Promise<LensScene> {
  const began = Date.now();
  note(`fb-100: a figure on stage is changed in place (${words} words round it)`);
  const results: CheckResult[] = [];
  const add = (check: string, problems: readonly string[], good: string): void => void results.push({ turn: 0, check, verdict: problems.length === 0 ? 'PASS' : 'FAIL', detail: problems.length === 0 ? good : problems.join('; ') });
  let picture = '';
  try {
    const tab = await Tab.open(LABEL_SCREEN.width, LABEL_SCREEN.height);
    try {
      const options: Options = { url: base, screens: [], out: dir, turns: new Set(), timeoutMs, parallel: false, demo: false, quiet: true, page: '', say: null, chat: 'off' };
      const conv = new Conversation(tab, options, LABEL_SCREEN, dir);
      await tab.send('DOM.enable');
      await conv.start();
      const play = async (script: string): Promise<string> => {
        const played = await tab.eval<string | null>(`Promise.resolve(window.__stage.playScript(${JSON.stringify(script)})).then(() => null, (e) => String(e && e.message || e))`);
        return played !== null ? `the script would not play: ${played}` : conv.rest(true);
      };
      const standing = (): Promise<Standing[]> => tab.eval<Standing[]>(`window.__stage.elements().filter((e) => e.opacity > 0.05 && e.phase !== 'struck').map((e) => ({ key: e.key, id: e.id, text: String(e.text || ''), box: e.box }))`);
      const scene = (): Promise<string> => tab.eval<string>(`String(window.__stage.state().scene.id)`);
      /** how the kit last set the figure: the room it was given, its scale, and where it put it (the page's own hook, `window.__figures`) */
      const resting = (key: string): Promise<Resting | null> =>
        tab.eval<Resting | null>(`(() => { const last = window.__figures && window.__figures.get(${JSON.stringify(key)}); return last ? { room: last.room, scale: last.layout.scale, offset: last.layout.offset, parts: last.layout.input.parts.length } : null; })()`);
      const labels = async (): Promise<string[]> => (await labelsOf(tab)).map((label) => label.label);
      const shot = async (name: string): Promise<string> => {
        const file = join(dir, `fb-100-${words}-${name}.png`);
        await writeFile(file, Buffer.from((await tab.shot()).replace(/^data:image\/png;base64,/, ''), 'base64'));
        return file;
      };

      const kept: string[] = [];
      const parts: string[] = [];
      const still: string[] = [];
      const first = await play(CAR);
      if (first !== '') kept.push(first);
      const sceneBefore = await scene();
      const before = await standing();
      const labelsBefore = await labels();
      for (const wanted of ['body', 'engine', 'fuel tank', 'exhaust', 'wheel']) if (!labelsBefore.includes(wanted)) parts.push(`the first answer did not label "${wanted}" (${labelsBefore.join(', ') || 'none'})`);
      const carBefore = before.find((element) => element.id === 'car');
      if (carBefore === undefined) kept.push('the first answer has no element "car"');
      const restBefore = carBefore === undefined ? null : await resting(carBefore.key);
      const beforePicture = await shot('before');

      // while the swap plays, how the kit has the figure set is read every so often: it must not breathe as the words round it come and go
      const samples: Resting[] = [];
      let playing = true;
      const sampler = (async (): Promise<void> => {
        while (playing && carBefore !== undefined) {
          const now = await resting(carBefore.key);
          if (now !== null) samples.push(now);
          await sleep(60);
        }
      })();
      const second = await play(SWAP(words));
      playing = false;
      await sampler;
      if (second !== '') kept.push(second);
      picture = await shot('after');
      const after = await standing();
      const carAfter = after.find((element) => element.id === 'car');
      if (carAfter === undefined) kept.push('after the swap there is no element "car"');
      if (carBefore !== undefined && carAfter !== undefined) {
        if (carAfter.key !== carBefore.key) kept.push(`the car is a different element (${carBefore.key} then ${carAfter.key})`);
        for (const side of ['x', 'y', 'width', 'height'] as const) if (Math.abs(carAfter.box[side] - carBefore.box[side]) > 1) kept.push(`the car's box moved: ${side} ${carBefore.box[side].toFixed(1)} then ${carAfter.box[side].toFixed(1)}`);
      }
      const sceneAfter = await scene();
      if (sceneAfter !== sceneBefore) kept.push(`the scene changed: ${sceneBefore} then ${sceneAfter}`);
      const wordsId = words === 'shorter' ? 'x2' : 'x1';
      if (!after.some((element) => element.id === wordsId && /electric|motor/.test(element.text))) kept.push(`the swap's own words (${wordsId}) are not on the stage`);
      const labelsAfter = await labels();
      for (const wanted of ['body', 'wheel', 'electric motor', 'battery pack']) if (!labelsAfter.includes(wanted)) parts.push(`after the swap the label "${wanted}" is not on the drawing (${labelsAfter.join(', ') || 'none'})`);
      for (const gone of ['engine', 'fuel tank', 'exhaust']) if (labelsAfter.includes(gone)) parts.push(`after the swap the label "${gone}" is still on the drawing`);
      const restAfter = carAfter === undefined ? null : await resting(carAfter.key);
      if (restBefore === null || restAfter === null) still.push('the page has no record of how the figure was set (window.__figures)');
      else {
        if (restBefore.parts !== 5 || restAfter.parts !== 4) still.push(`the figure has ${restBefore.parts} parts, then ${restAfter.parts}: the swap leaves four (these are not the figures the check measured)`);
        for (const side of ['x', 'y', 'width', 'height'] as const) if (Math.abs(restAfter.room[side] - restBefore.room[side]) > 2) still.push(`the figure's room moved: ${side} ${restBefore.room[side].toFixed(1)} then ${restAfter.room[side].toFixed(1)} px`);
        const grew = restAfter.scale / restBefore.scale - 1;
        if (Math.abs(grew) > 0.01) still.push(`the drawing's scale changed by ${(grew * 100).toFixed(1)}% (${restBefore.scale.toFixed(3)} then ${restAfter.scale.toFixed(3)})`);
        for (const axis of ['x', 'y'] as const) if (Math.abs(restAfter.offset[axis] - restBefore.offset[axis]) > 2) still.push(`the drawing moved in its room: ${axis} ${restBefore.offset[axis].toFixed(1)} then ${restAfter.offset[axis].toFixed(1)} px`);
        // and at no moment of the turn
        const worst = samples.reduce((most, one) => Math.max(most, Math.abs(one.scale / restBefore.scale - 1), Math.abs(one.room.height - restBefore.room.height) / 100, Math.abs(one.offset.y - restBefore.offset.y) / 100), 0);
        if (samples.length < 3) still.push(`the figure was read only ${samples.length} times while the swap played`);
        else if (worst > 0.02) still.push(`while the swap played the drawing's scale, room or place was off by ${(worst * 100).toFixed(1)}% (or ${(worst * 100).toFixed(0)} px) at one moment of ${samples.length} read`);
      }
      add(`fb-100-${words}-kept`, kept, `the scene (${sceneAfter}) and the car (${carAfter?.key ?? ''}, the same box) are kept, and the swap's own words stand`);
      add(`fb-100-${words}-parts`, parts, `the body and wheel labels stay, the engine, tank and exhaust are gone, the motor and battery pack are there (${labelsAfter.join(', ')})`);
      add(`fb-100-${words}-still`, still, restBefore === null || restAfter === null ? '' : `the car stayed put: its room, its scale (${restBefore.scale.toFixed(3)} then ${restAfter.scale.toFixed(3)}) and its place in the room, though the words round it changed`);
      add(`fb-100-${words}-pictures`, beforePicture === '' || picture === '' ? ['no picture was taken'] : [], `the stage before and after the swap: ${beforePicture} and ${picture}`);
      const drained = tab.drain();
      add(`fb-100-${words}-console`, [...drained.consoleErrors, ...drained.failedRequests].map((entry) => entry.text).slice(0, 3), 'no console errors or failed requests');
    } finally {
      await tab.close();
    }
  } catch (error) {
    add(`fb-100-${words}`, [error instanceof Error ? error.message : String(error)], '');
  }
  return { name: `fb-100-${words}`, picture, results, seconds: (Date.now() - began) / 1000 };
}

const flag = process.argv.indexOf('--url');
if (import.meta.url === `file://${process.argv[1]}` && flag > 0) {
  const base = (process.argv[flag + 1] ?? '').replace(/\/+$/, '');
  void inplaceGroup(base, process.env['INPLACE_OUT'] ?? '/tmp/conduit-inplace-check', 90_000, (text) => process.stdout.write(`${text}\n`)).then((scenes) => {
    let failed = 0;
    for (const scene of scenes) for (const outcome of scene.results) {
      process.stdout.write(`${outcome.verdict} ${outcome.check}: ${outcome.detail}\n`);
      if (outcome.verdict === 'FAIL') failed += 1;
    }
    process.exit(failed === 0 ? 0 : 1);
  });
}
