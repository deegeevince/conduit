// pnpm check's fb-064 group: the Undo chip puts the answer before back as it was, labels and words included, and takes everything of the answer it undoes (a real mouse over
// the DevTools protocol, the replay brain, no model). Two answers are played as the brain writes them: a labelled car with its words and a choice, then a different answer that
// replaces it with a drawing, a slider and a line of words. One click on the Undo chip, and:
//
//   labels    the car's labels are back (and can be tapped: a click on "engine" is one act that names it), so a journey can go on from the earlier answer
//   words     the car's words and its choice are back; the shapes of the car too
//   gone      nothing of the answer undone stands: its drawing, its slider and its words are gone, not left over the car
//
// Run by `pnpm check` (as `fb-064`) and standalone: `tsx undo-check.ts --url <server>`, with smoke's own Tab and Conversation.

import { mkdir } from 'node:fs/promises';
import { sleep } from './explore-browser';
import { Conversation, Tab } from './smoke';
import type { CheckResult, Options, Posted } from './smoke';
import type { LensScene } from './lens-check';
import { CAR, LABEL_SCREEN, acts, labelsOf, partOf } from './label-check';

/** the answer that replaces the car: other drawing, a control and words */
const NEXT = ['scene layout=figure canvas=wide', 'circle sun 50,30 12 fill=accent', 'slider v 20 130 50 step=10 unit=km/h | Speed', 'say y1 | A different answer, with a slider.'].join('\n');

interface Standing {
  readonly id: string;
  readonly kind: string;
  readonly text: string;
}

export async function undoGroup(base: string, dir: string, timeoutMs: number, note: (text: string) => void = () => undefined): Promise<LensScene[]> {
  await mkdir(dir, { recursive: true });
  const began = Date.now();
  note('fb-064: undo');
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
      const standing = (): Promise<Standing[]> =>
        tab.eval<Standing[]>(`window.__stage.elements().filter((e) => e.opacity > 0.05 && e.phase !== 'struck').map((e) => ({ id: e.id, kind: e.kind, text: String(e.text || '') }))`);
      const labels = async (): Promise<string[]> => {
        for (let waited = 0; waited < 4000; waited += 250) {
          const found = (await labelsOf(tab)).map((label) => label.label);
          if (found.length > 0) return found;
          await sleep(250);
        }
        return [];
      };
      const labelProblems: string[] = [];
      const wordProblems: string[] = [];
      const goneProblems: string[] = [];

      const first = await play(CAR);
      if (first !== '') labelProblems.push(first);
      const before = await labels();
      if (!before.includes('engine')) labelProblems.push(`the car did not draw its labels (${before.join(', ') || 'none'})`);
      const second = await play(NEXT);
      if (second !== '') labelProblems.push(second);
      const between = await labels();
      if (between.includes('engine')) labelProblems.push('the car\'s labels were still up under the next answer, so undo has nothing to bring back');
      const chip = await tab.eval<{ x: number; y: number } | null>(`(() => { const b = document.querySelector('[data-undo-chip]'); if (!b || b.hidden) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      if (chip === null) labelProblems.push('the Undo chip did not show after the second answer');
      else {
        await tab.tap(chip.x, chip.y);
        const rest = await conv.rest(true);
        if (rest !== '') labelProblems.push(rest);
        const back = await labels();
        for (const wanted of ['engine', 'brake disc', 'rear wheel']) if (!back.includes(wanted)) labelProblems.push(`after Undo the label "${wanted}" is not back (${back.join(', ') || 'no labels'})`);
        const now = await standing();
        const has = (id: string): boolean => now.some((element) => element.id === id);
        for (const id of ['engine', 'disc1', 'body']) if (!has(id)) wordProblems.push(`the part ${id} of the car is not back`);
        if (!now.some((element) => element.id === 'x4' && /words beside/.test(element.text))) wordProblems.push('the car\'s line of words is not back');
        if (!now.some((element) => element.text === 'Show an electric car')) wordProblems.push('the car\'s choice is not back');
        for (const id of ['sun', 'v', 'y1']) if (has(id)) goneProblems.push(`${id}, of the answer that was undone, still stands`);
        if (!goneProblems.some(() => true) && now.some((element) => /different answer/.test(element.text))) goneProblems.push('the undone answer\'s words still stand');
        // a restored label is a live one: a click on it asks about it
        const engine = (await labelsOf(tab)).find((label) => label.label === 'engine');
        if (engine === undefined) labelProblems.push('no restored engine label to click');
        else {
          const mark = tab.posted.length;
          await tab.tap(engine.x, engine.y);
          await sleep(1400);
          const sent = acts(tab, mark);
          const part = sent.length === 1 ? partOf(sent[0] as Posted) : null;
          if (part === null || part.label !== 'engine') labelProblems.push(`a click on the restored engine label sent ${sent.length} acts naming ${part === null ? 'nothing' : `"${part.label}"`}`);
        }
      }
      add('fb-064-labels', labelProblems, 'after Undo the car\'s labels (engine, brake disc, rear wheel) are back and a click on one asks about it');
      add('fb-064-words', wordProblems, 'after Undo the car\'s parts, its line of words and its choice are back');
      add('fb-064-gone', goneProblems, 'nothing of the answer that was undone (its drawing, slider, words) stands over the car');
      const drained = tab.drain();
      add('fb-064-console', [...drained.consoleErrors, ...drained.failedRequests].map((entry) => entry.text).slice(0, 3), 'no console errors or failed requests');
    } finally {
      await tab.close();
    }
  } catch (error) {
    add('fb-064-undo', [error instanceof Error ? error.message : String(error)], '');
  }
  return [{ name: 'fb-064-undo', picture: '', results, seconds: (Date.now() - began) / 1000 }];
}

const flag = process.argv.indexOf('--url');
if (import.meta.url === `file://${process.argv[1]}` && flag > 0) {
  const base = (process.argv[flag + 1] ?? '').replace(/\/+$/, '');
  void undoGroup(base, process.env['UNDO_OUT'] ?? '/tmp/conduit-undo-check', 90_000, (text) => process.stdout.write(`${text}\n`)).then((scenes) => {
    let failed = 0;
    for (const scene of scenes) for (const outcome of scene.results) {
      process.stdout.write(`${outcome.verdict} ${outcome.check}: ${outcome.detail}\n`);
      if (outcome.verdict === 'FAIL') failed += 1;
    }
    process.exit(failed === 0 ? 0 : 1);
  });
}
