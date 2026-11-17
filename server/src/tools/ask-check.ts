// pnpm check's ask group: the blanks of an `ask` on the stage, worked with a real finger and a real pen over the DevTools protocol, on a tablet (1180x820 at two
// pixels to the point, touch) with the lens off and with it on. A staged chain like the brain writes it (`ask w1 … stage=1`, `ask w2 … send=yes stage=2:w1`):
//
//   keyboard    a finger tap on the blank puts the focus on its real input (what makes a phone raise its keyboard), with Draw closed
//   draw        with Draw open and a pen stroke already seen: a finger tap and a short pen tap on the blank do the same and leave no ink; a pen drag across it writes
//   fill        `fill w1 | <wrong>` shows in the blank and is marked wrong; `fill w2` before w1 is right is not taken; `fill w1 | <right>` shows, is marked right and opens
//               stage 2 with no turn sent; `fill w2 | <right>` reports as a typed answer does (send=yes)
//   marks       Send drawing with ink over the blank names the ask in the marks' boxes
//
// Run by `pnpm check` and standalone (`tsx ask-check.ts --url <server>`), with smoke's own Tab and Conversation.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sleep } from './explore-browser';
import { Conversation, Tab } from './smoke';
import { Hands, line } from './lens-check';
import type { LensScene, LensScreen, Point } from './lens-check';
import type { CheckResult, Options } from './smoke';

export const ASK_SCREEN: LensScreen = { name: '1180x820', width: 1180, height: 820, dpr: 2 };

const CHAIN = [
  'scene layout=stack mood=calm',
  'say x1 | 4x + 3 = 23',
  'say x2 | take 3 from both sides',
  'ask w1 is=20,4x=20 stage=1 | 4x = __',
  'hint in=w1 stage=yes | What is 23 take away 3?',
  'say x3 | divide both sides by 4',
  'ask w2 is=5,x=5 send=yes stage=2:w1 | x = __',
  'hint in=w2 stage=yes | How many 4s make your last answer?',
].join('\n');

/** working as on paper: 12 six times as a column of digits on the right edge of one x, a rule, and the ask for the total below */
const COLUMN = [
  'scene layout=free canvas=square',
  'say h at=50,8 size=l | 12 + 12 + 12 + 12 + 12 + 12',
  ...[22, 30, 38, 46, 54, 62].map((y, i) => `say d${i + 1} at=62,${y} align=right face=mono | 12`),
  'say pl at=40,62 face=mono | +',
  'path r1 stroke=ink thick=0.6 | M32,67 L64,67',
  'ask a1 is=72,seventy_two | Write the total with the pen',
  'hint in=a1 | Add the ones first.',
].join('\n');

interface AskView {
  readonly id: string;
  readonly value: unknown;
  readonly parts: { readonly part: string; readonly box: { x: number; y: number; width: number; height: number } }[];
  readonly askState?: { readonly verdict: string; readonly tries: number; readonly locked: boolean };
}

/** Runs the ask group on the tablet, once per variant (the lens off, then on). A failure is a `FAIL` result, never a throw. */
export async function askGroup(base: string, screen: LensScreen, dir: string, timeoutMs: number, note: (text: string) => void = () => undefined): Promise<LensScene[]> {
  await mkdir(dir, { recursive: true });
  const scenes: LensScene[] = [];
  for (const variant of [{ name: 'plain', page: '' }, { name: 'lens', page: 'lens=1' }]) {
    const began = Date.now();
    const results: CheckResult[] = [];
    const problems: Record<string, string[]> = { keyboard: [], draw: [], fill: [], marks: [] };
    note(`ask: ${variant.name}`);
    const tab = await Tab.open(screen.width, screen.height, { dpr: screen.dpr, touch: true });
    const options: Options = { url: base, screens: [], out: dir, turns: new Set(), timeoutMs, parallel: false, demo: false, quiet: true, page: variant.page, say: null, chat: 'off' };
    const conv = new Conversation(tab, options, { name: screen.name, width: screen.width, height: screen.height }, dir);
    let picture = '';
    try {
      await tab.send('DOM.enable');
      await conv.start();
      const hands = new Hands(tab);
      const play = (script: string): Promise<string | null> => tab.eval<string | null>(`Promise.resolve(window.__stage.playScript(${JSON.stringify(script)})).then(() => null, (e) => String(e && e.message || e))`);
      const played = await play(CHAIN);
      const rest = played !== null ? `the script would not play: ${played}` : await conv.rest(true);
      if (rest !== '') problems['keyboard']?.push(rest);
      const asks = (): Promise<AskView[]> => tab.eval<AskView[]>(`window.__stage.controls().filter((c) => c.ask).map((c) => ({ id: c.id, value: c.value, parts: c.parts, askState: c.askState }))`);
      const one = async (id: string): Promise<AskView | undefined> => (await asks()).find((view) => view.id === id);
      const origin = await hands.origin();
      const blankOf = async (id: string): Promise<Point | null> => {
        const view = await one(id);
        const box = view?.parts.find((part) => part.part === 'field')?.box;
        return box === undefined ? null : hands.onScreen({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
      };
      const focused = (): Promise<string> => tab.eval<string>(`(() => { const a = document.activeElement; if (!a || a.tagName !== 'INPUT') return ''; const h = a.closest('[data-control]'); return h ? h.dataset.control : 'other-input'; })()`);
      // a phone raises its keyboard only for a focus made inside the gesture: what was focused at the moment each pointer-up had been handled, not later
      await tab.eval(`window.__upFocus = []; document.addEventListener('pointerup', () => { const a = document.activeElement; const h = a && a.tagName === 'INPUT' ? a.closest('[data-control]') : null; window.__upFocus.push(h ? h.dataset.control : ''); })`);
      const inGesture = async (): Promise<boolean> => {
        const seen = await tab.eval<string[]>('window.__upFocus.splice(0)');
        return seen.includes('w1');
      };
      const blur = (): Promise<unknown> => tab.eval(`document.activeElement && document.activeElement.blur()`);
      const strokes = async (): Promise<number> => (await hands.strokes())?.strokes.length ?? 0;
      const w1 = await blankOf('w1');
      if (w1 === null) problems['keyboard']?.push('no blank for w1 on stage');
      else {
        // 1. a finger on the blank, Draw closed
        await inGesture();
        await hands.finger([w1]);
        const got = await focused();
        if (got === 'w1' && !(await inGesture())) problems['keyboard']?.push('the focus came after the tap, not inside it: a phone would not raise its keyboard');
        if (got !== 'w1') problems['keyboard']?.push(`a finger tap on the blank focused "${got || 'nothing'}": no keyboard would open`);
        await blur();
        picture = await shot(tab, dir, `${screen.name}-ask-${variant.name}-keyboard.png`);
        // 2. Draw open, a pen stroke seen first (away from the blank): then a finger, a pen tap and a pen drag on the blank
        await tab.eval(`document.querySelector('.composer__plus').click()`);
        await sleep(200);
        await tab.eval(`[...document.querySelectorAll('.composer__item')].find((n) => /^Draw/.test(n.textContent.trim())).click()`);
        await sleep(300);
        const open = await tab.eval<boolean>(`!!document.querySelector('.ink-stage') && !document.querySelector('.ink-stage').hidden && !document.querySelector('.ink-stage').classList.contains('ink-stage--through')`);
        if (!open) problems['draw']?.push('Draw did not open');
        const far = { x: origin.x + 60, y: origin.y + screen.height - 160 };
        await hands.pen(line(far, { x: far.x + 160, y: far.y + 20 }, 12));
        const n0 = await strokes();
        if (n0 < 1) problems['draw']?.push('the pen left no stroke (the pen was not seen)');
        await inGesture();
        await hands.finger([w1]);
        const f = await focused();
        if (f === 'w1' && !(await inGesture())) problems['draw']?.push('with Draw open, the focus after a finger tap came after the tap, not inside it');
        if (f !== 'w1') problems['draw']?.push(`with Draw open, a finger tap on the blank focused "${f || 'nothing'}"`);
        if ((await strokes()) !== n0) problems['draw']?.push('a finger tap on the blank left ink');
        await blur();
        await inGesture();
        await hands.pen([w1, w1]);
        const p = await focused();
        if (p === 'w1' && !(await inGesture())) problems['draw']?.push('with Draw open, the focus after a pen tap came after the tap, not inside it');
        if (p !== 'w1') problems['draw']?.push(`with Draw open, a short pen tap on the blank focused "${p || 'nothing'}"`);
        if ((await strokes()) !== n0) problems['draw']?.push('a short pen tap on the blank left ink');
        await blur();
        const view = await one('w1');
        const box = view?.parts.find((part) => part.part === 'field')?.box;
        if (box !== undefined) {
          const a = await hands.onScreen({ x: box.x + box.width * 0.15, y: box.y + box.height / 2 });
          const b = await hands.onScreen({ x: box.x + box.width * 0.85, y: box.y + box.height * 0.3 });
          await hands.pen(line(a, b, 16));
          if ((await strokes()) !== n0 + 1) problems['draw']?.push(`a pen drag across the blank left ${(await strokes()) - n0} new stroke(s), wanted 1`);
          if ((await focused()) !== '') problems['draw']?.push('a pen drag across the blank focused its input');
          // 3. Send drawing: the marks name the ask whose blank they cover
          const before = tab.posted.length;
          await tab.eval(`[...document.querySelectorAll('.ink-stage__bar button')].find((n) => /send drawing/i.test(n.textContent)).click()`);
          let sent: (typeof tab.posted)[number] | undefined;
          for (let waited = 0; waited < 8000 && sent === undefined; waited += 200) {
            sent = tab.posted.slice(before).find((turn) => turn.kind === 'prompt');
            if (sent === undefined) await sleep(200);
          }
          if (sent === undefined) problems['marks']?.push('Send drawing posted no turn');
          else {
            const body = JSON.parse(sent.body) as { input?: { marks?: { regions?: { id: string; strokes: string[] }[] } } };
            const hit = body.input?.marks?.regions?.find((region) => region.id === 'w1');
            if (hit === undefined) problems['marks']?.push(`the marks do not name ask w1 among their boxes: ${sent.body.slice(0, 200)}`);
            else if (hit.strokes.length === 0) problems['marks']?.push('the marks\' box for w1 holds no stroke');
          }
          await conv.rest(true, false).catch(() => undefined);
        } else problems['draw']?.push('no blank box to draw over');
      }
    } catch (error) {
      problems['keyboard']?.push(`stopped: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await tab.close();
    }
    const add = (check: string, list: readonly string[] | undefined, good: string): void => {
      results.push({ turn: 0, check, verdict: (list ?? []).length === 0 ? 'PASS' : 'FAIL', detail: (list ?? []).length === 0 ? good : (list ?? []).join('; ') });
    };
    add(`ask-keyboard-${variant.name}`, problems['keyboard'], 'a finger tap on an ask blank focuses its real input');
    add(`ask-draw-${variant.name}`, problems['draw'], 'with Draw open and a pen seen, a finger tap and a short pen tap reach the blank and leave no ink; a pen drag writes');
    add(`ask-marks-${variant.name}`, problems['marks'], 'Send drawing names the ask the marks cover');
    scenes.push({ name: `ask-${variant.name}`, picture, results, seconds: (Date.now() - began) / 1000 });
  }
  // fill: no gestures, a script turn per line
  {
    const began = Date.now();
    const results: CheckResult[] = [];
    const list: string[] = [];
    note('ask: fill');
    const tab = await Tab.open(screen.width, screen.height, { dpr: screen.dpr, touch: true });
    const options: Options = { url: base, screens: [], out: dir, turns: new Set(), timeoutMs, parallel: false, demo: false, quiet: true, page: '', say: null, chat: 'off' };
    const conv = new Conversation(tab, options, { name: screen.name, width: screen.width, height: screen.height }, dir);
    let picture = '';
    try {
      await tab.send('DOM.enable');
      await conv.start();
      const play = async (script: string): Promise<string> => {
        const played = await tab.eval<string | null>(`Promise.resolve(window.__stage.playScript(${JSON.stringify(script)})).then(() => null, (e) => String(e && e.message || e))`);
        return played !== null ? `the script would not play: ${played}` : conv.rest(true);
      };
      const state = (id: string): Promise<{ verdict: string; locked: boolean; value: unknown } | null> =>
        tab.eval(`(() => { const c = window.__stage.controls().find((n) => n.id === ${JSON.stringify(id)}); return c ? { verdict: c.askState.verdict, locked: c.askState.locked, value: c.value } : null; })()`);
      const first = await play(CHAIN);
      if (first !== '') list.push(first);
      const acts = (): number => tab.posted.filter((turn) => turn.kind === 'act').length;
      const sent = acts();
      await play('fill w2 | 5');
      const early = await state('w2');
      if (early === null || early.verdict !== 'open' || early.value === '5') list.push(`a fill into ask w2 before w1 was right was taken (${JSON.stringify(early)})`);
      await play('fill w1 | 7');
      const wrong = await state('w1');
      if (wrong === null || wrong.verdict !== 'wrong') list.push(`a wrong fill was marked "${wrong?.verdict}"`);
      else if (wrong.value !== '7') list.push(`the blank holds "${String(wrong.value)}", not the 7 put in it`);
      await play('fill w1 | 20');
      const right = await state('w1');
      const next = await state('w2');
      if (right === null || right.verdict !== 'right') list.push(`a right fill was marked "${right?.verdict}"`);
      else if (right.value !== '20') list.push(`the blank holds "${String(right.value)}", not the 20 put in it`);
      if (next === null || next.locked) list.push('stage 2 did not open after a right fill of stage 1');
      if (acts() !== sent) list.push('filling w1 (no send) told the brain of a try');
      picture = await shot(tab, dir, `${screen.name}-ask-fill.png`);
      const before = tab.posted.length;
      await play('fill w2 | 5');
      // a right answer to a send=yes ask is told to the brain at once, as a typed one is, and the stage is then the brain's next turn's
      let told: string | undefined;
      for (let waited = 0; waited < 6000 && told === undefined; waited += 200) {
        told = tab.posted.slice(before).find((turn) => turn.kind === 'act' && /\(right/.test(turn.text ?? ''))?.text ?? undefined;
        if (told === undefined) await sleep(200);
      }
      if (told === undefined) list.push('a right fill of a send=yes ask told the brain nothing');
    } catch (error) {
      list.push(`stopped: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await tab.close();
    }
    results.push({ turn: 0, check: 'ask-fill', verdict: list.length === 0 ? 'PASS' : 'FAIL', detail: list.length === 0 ? 'a fill shows in the blank, is marked wrong or right, opens stage 2, and reports as typed when send=yes' : list.join('; ') });
    scenes.push({ name: 'ask-fill', picture, results, seconds: (Date.now() - began) / 1000 });
  }
  // column: working as on paper on the canvas. The pen writes the total in the answer area, Check reads it (the reader is stood in for here: no model) and marks it right
  {
    const began = Date.now();
    const results: CheckResult[] = [];
    const list: string[] = [];
    note('ask: column');
    const tab = await Tab.open(screen.width, screen.height, { dpr: screen.dpr, touch: true });
    const options: Options = { url: base, screens: [], out: dir, turns: new Set(), timeoutMs, parallel: false, demo: false, quiet: true, page: '', say: null, chat: 'off' };
    const conv = new Conversation(tab, options, { name: screen.name, width: screen.width, height: screen.height }, dir);
    let picture = '';
    try {
      await tab.send('DOM.enable');
      await conv.start();
      const hands = new Hands(tab);
      await tab.eval(`(() => { const real = window.fetch.bind(window); window.fetch = (url, init) => /read-ink/.test(String(url)) ? Promise.resolve(new Response(JSON.stringify({ text: '72', lines: ['72'], unclear: false, sees: '72' }), { headers: { 'content-type': 'application/json' } })) : real(url, init); })()`);
      const played = await tab.eval<string | null>(`Promise.resolve(window.__stage.playScript(${JSON.stringify(COLUMN)})).then(() => null, (e) => String(e && e.message || e))`);
      const rest = played !== null ? `the script would not play: ${played}` : await conv.rest(true);
      if (rest !== '') list.push(rest);
      // the digits stand in one column: every "12" ends at the same x, a row apart
      const digits = await tab.eval<{ readonly right: number; readonly top: number }[]>(`window.__stage.elements().filter((e) => e.text.trim() === '12' && e.kind !== 'control').map((e) => ({ right: Math.round(e.box.x + e.box.width), top: Math.round(e.box.y) }))`);
      if (digits.length !== 6) list.push(`six 12s were wanted on the canvas, found ${digits.length}`);
      else if (Math.max(...digits.map((d) => d.right)) - Math.min(...digits.map((d) => d.right)) > 2) list.push(`the digits do not share a right edge: ${digits.map((d) => d.right).join(',')}`);
      else if (new Set(digits.map((d) => d.top)).size !== 6) list.push('two rows of digits stand on each other');
      await tab.eval(`document.querySelector('.composer__plus').click()`);
      await sleep(200);
      await tab.eval(`[...document.querySelectorAll('.composer__item')].find((n) => /^Draw/.test(n.textContent.trim())).click()`);
      await sleep(300);
      const view = (await tab.eval<AskView[]>(`window.__stage.controls().filter((c) => c.ask).map((c) => ({ id: c.id, value: c.value, parts: c.parts, askState: c.askState }))`)).find((c) => c.id === 'a1');
      const field = view?.parts.find((part) => part.part === 'field')?.box;
      const check = view?.parts.find((part) => part.part === 'check')?.box;
      if (field === undefined || check === undefined) list.push('the ask has no answer area or no Check');
      else {
        const a = await hands.onScreen({ x: field.x + field.width * 0.2, y: field.y + field.height * 0.3 });
        const b = await hands.onScreen({ x: field.x + field.width * 0.8, y: field.y + field.height * 0.7 });
        await hands.pen(line(a, b, 16));
        if (((await hands.strokes())?.strokes.length ?? 0) < 1) list.push('the pen left no stroke in the answer area');
        await sleep(200);
        await hands.finger([await hands.onScreen({ x: check.x + check.width / 2, y: check.y + check.height / 2 })]);
        let state: { verdict: string; value: unknown } | null = null;
        for (let waited = 0; waited < 8000; waited += 250) {
          state = await tab.eval(`(() => { const c = window.__stage.controls().find((n) => n.id === 'a1'); return c ? { verdict: c.askState.verdict, value: c.value } : null; })()`);
          if (state?.verdict === 'right') break;
          await sleep(250);
        }
        if (state?.verdict !== 'right') list.push(`Check after the pen wrote 72 marked it "${state?.verdict ?? 'nothing'}", not right`);
        if (String(state?.value ?? '') !== '72') list.push(`the answer area holds "${String(state?.value ?? '')}", not 72`);
      }
      picture = await shot(tab, dir, `${screen.name}-ask-column.png`);
    } catch (error) {
      list.push(`stopped: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await tab.close();
    }
    results.push({ turn: 0, check: 'ask-column', verdict: list.length === 0 ? 'PASS' : 'FAIL', detail: list.length === 0 ? 'six 12s stand in one right-aligned column; the pen writes 72 in the answer area and Check marks it right' : list.join('; ') });
    scenes.push({ name: 'ask-column', picture, results, seconds: (Date.now() - began) / 1000 });
  }
  return scenes;
}

async function shot(tab: Tab, dir: string, name: string): Promise<string> {
  await writeFile(join(dir, name), Buffer.from((await tab.shot()).split(',')[1] ?? '', 'base64'));
  return name;
}

if (process.argv[1] !== undefined && /ask-check\.ts$/.test(process.argv[1])) {
  const url = process.argv[process.argv.indexOf('--url') + 1];
  const out = process.argv.includes('--out') ? (process.argv[process.argv.indexOf('--out') + 1] as string) : '/tmp/conduit-ask';
  if (url === undefined || !url.startsWith('http')) {
    process.stderr.write('usage: tsx ask-check.ts --url http://127.0.0.1:<port> [--out <dir>]\n');
    process.exit(2);
  }
  void (async () => {
    const all = await askGroup(url, ASK_SCREEN, out, 90_000, (text) => process.stdout.write(`${text}\n`));
    let failed = 0;
    for (const scene of all) for (const r of scene.results) {
      process.stdout.write(`${r.verdict} ${scene.name} ${r.check}: ${r.detail}\n`);
      if (r.verdict === 'FAIL') failed += 1;
    }
    process.exit(failed === 0 ? 0 : 1);
  })();
}
