// pnpm check's fb-064 group: the Undo chip puts the answer before back as it was, labels and words included, and takes everything of the answer it undoes (a real mouse over
// the DevTools protocol, the replay brain, no model). Two answers are played as the brain writes them: a labelled car with its words and a choice, then a different answer that
// replaces it with a drawing, a slider and a line of words. One click on the Undo chip, and:
//
//   labels    the first answer's labels are back (and can be tapped: a click on one is one act that names it), so a journey can go on from the earlier answer
//   words     its drawing (the car's shapes, or the figure), its words and its choice are back
//   gone      nothing of the answer undone stands: its drawing, its slider and its words are gone, not left over
// Both ways the brain draws a labelled thing are played: callouts on a drawing (`say callout near=`), and a figure with `label=` on its parts.
//
// Run by `pnpm check` (as `fb-064`) and standalone: `tsx undo-check.ts --url <server>`, with smoke's own Tab and Conversation.

import { mkdir } from 'node:fs/promises';
import { sleep } from './explore-browser';
import { Conversation, Tab } from './smoke';
import type { CheckResult, Options, Posted } from './smoke';
import type { LensScene } from './lens-check';
import { CAR, HEART, LABEL_SCREEN, acts, labelsOf, partOf } from './label-check';

/** the answer that replaces the car: other drawing, a control and words */
const NEXT = ['scene layout=figure canvas=wide', 'circle sun 50,30 12 fill=accent', 'slider v 20 130 50 step=10 unit=km/h | Speed', 'say y1 | A different answer, with a slider.'].join('\n');

interface Standing {
  readonly id: string;
  readonly kind: string;
  readonly text: string;
}

interface Case {
  readonly name: string;
  readonly first: string;
  /** the labels the first answer's stage can be tapped by */
  readonly labels: readonly string[];
  /** ids that stand on the stage of the first answer, and the words and choices it said */
  readonly ids: readonly string[];
  readonly words: readonly RegExp[];
  /** the label to click once it is back */
  readonly click: string;
}

/** a labelled figure, with words and a choice of its own */
const FIGURE = [HEART, 'say h1 | The heart has four chambers.', 'say h2 choice | How does it beat?'].join('\n');

const CASES: readonly Case[] = [
  { name: 'callouts', first: CAR, labels: ['engine', 'brake disc', 'rear wheel'], ids: ['engine', 'disc1', 'body'], words: [/words beside a part/, /^Show an electric car$/], click: 'engine' },
  { name: 'figure', first: FIGURE, labels: ['right atrium', 'left ventricle'], ids: ['heart'], words: [/four chambers/, /^How does it beat\?$/], click: 'left ventricle' },
];

export async function undoGroup(base: string, dir: string, timeoutMs: number, note: (text: string) => void = () => undefined): Promise<LensScene[]> {
  await mkdir(dir, { recursive: true });
  const scenes: LensScene[] = [];
  for (const one of CASES) {
    const began = Date.now();
    note(`fb-064: undo (${one.name})`);
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

        const first = await play(one.first);
        if (first !== '') labelProblems.push(first);
        const before = await labels();
        for (const wanted of one.labels) if (!before.includes(wanted)) labelProblems.push(`the first answer did not draw its label "${wanted}" (${before.join(', ') || 'none'})`);
        const second = await play(NEXT);
        if (second !== '') labelProblems.push(second);
        const between = await labels();
        if (between.includes(one.click)) labelProblems.push('the first answer\'s labels were still up under the next answer, so undo has nothing to bring back');
        const chip = await tab.eval<{ x: number; y: number } | null>(`(() => { const b = document.querySelector('[data-undo-chip]'); if (!b || b.hidden) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
        if (chip === null) labelProblems.push('the Undo chip did not show after the second answer');
        else {
          await tab.tap(chip.x, chip.y);
          const rest = await conv.rest(true);
          if (rest !== '') labelProblems.push(rest);
          const back = await labels();
          for (const wanted of one.labels) if (!back.includes(wanted)) labelProblems.push(`after Undo the label "${wanted}" is not back (${back.join(', ') || 'no labels'})`);
          const now = await standing();
          for (const id of one.ids) if (!now.some((element) => element.id === id)) wordProblems.push(`${id}, of the first answer, is not back`);
          for (const words of one.words) if (!now.some((element) => words.test(element.text))) wordProblems.push(`the first answer's words ${words} are not back`);
          for (const id of ['sun', 'v', 'y1']) if (now.some((element) => element.id === id)) goneProblems.push(`${id}, of the answer that was undone, still stands`);
          if (goneProblems.length === 0 && now.some((element) => /different answer/.test(element.text))) goneProblems.push('the undone answer\'s words still stand');
          // a restored label is a live one: a click on it asks about it
          const target = (await labelsOf(tab)).find((label) => label.label === one.click);
          if (target === undefined) labelProblems.push(`no restored "${one.click}" label to click`);
          else {
            const mark = tab.posted.length;
            await tab.tap(target.x, target.y);
            await sleep(1400);
            const sent = acts(tab, mark);
            const part = sent.length === 1 ? partOf(sent[0] as Posted) : null;
            if (part === null || part.label !== one.click) labelProblems.push(`a click on the restored "${one.click}" label sent ${sent.length} acts naming ${part === null ? 'nothing' : `"${part.label}"`}`);
          }
        }
        add(`fb-064-${one.name}-labels`, labelProblems, `after Undo the first answer's labels (${one.labels.join(', ')}) are back and a click on "${one.click}" asks about it`);
        add(`fb-064-${one.name}-words`, wordProblems, 'after Undo the first answer\'s drawing, its words and its choice are back');
        add(`fb-064-${one.name}-gone`, goneProblems, 'nothing of the answer that was undone (its drawing, slider, words) stands over it');
        const drained = tab.drain();
        add(`fb-064-${one.name}-console`, [...drained.consoleErrors, ...drained.failedRequests].map((entry) => entry.text).slice(0, 3), 'no console errors or failed requests');
      } finally {
        await tab.close();
      }
    } catch (error) {
      add(`fb-064-${one.name}`, [error instanceof Error ? error.message : String(error)], '');
    }
    scenes.push({ name: `fb-064-${one.name}`, picture: '', results, seconds: (Date.now() - began) / 1000 });
  }
  return scenes;
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
