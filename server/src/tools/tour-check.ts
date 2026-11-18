// pnpm check's tour group (`/demo`): no model. In a browser at three screens, `/demo` is typed in the box and the tour opens on the canvas with a card for each
// chapter; a chapter opens its cards; a card plays its demo (scripted, instant, the replay brain) and, when it has come to rest, "Back to the tour" and
// "Try it yourself" stand at the foot of the stage; "Back to the tour" returns to the tour. `/demo <name>` jumps straight to one demo. The tour, a chapter and a demo
// are photographed at each screen.
//
// Run by `pnpm check` and standalone (`tsx tour-check.ts --url <server> [--out dir]`).

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TOUR_CHAPTERS } from '@conduit/language';
import { sleep } from './explore-browser';
import { checkPill, checkPillThroughToggles, checkTourBar } from './demo-check';
import { Conversation, Tab } from './smoke';
import type { LensScene, LensScreen } from './lens-check';
import type { CheckResult, Options } from './smoke';

export const TOUR_SCREENS: readonly LensScreen[] = [
  { name: '1280x800', width: 1280, height: 800, dpr: 1 },
  { name: '820x971', width: 820, height: 971, dpr: 1 },
  { name: '390x844', width: 390, height: 844, dpr: 2 },
];

interface Seen {
  readonly id: string;
  readonly text: string;
  readonly tappable: boolean;
  readonly opacity: number;
  readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

export async function tourGroup(base: string, screen: LensScreen, dir: string, timeoutMs: number, note: (text: string) => void = () => undefined): Promise<LensScene[]> {
  await mkdir(dir, { recursive: true });
  const began = Date.now();
  const list: string[] = [];
  let picture = '';
  const tab = await Tab.open(screen.width, screen.height, { dpr: screen.dpr, touch: screen.width < 600 });
  const options: Options = { url: base, screens: [], out: dir, turns: new Set(), timeoutMs, parallel: false, demo: false, quiet: true, page: '', say: null, chat: 'off' };
  const conv = new Conversation(tab, options, { name: screen.name, width: screen.width, height: screen.height }, dir);
  const tag = screen.name;
  const shoot = async (name: string): Promise<string> => {
    await until('the stage to be at rest', async () => !(await tab.eval<boolean>(`/^Playing/.test(document.querySelector('.prompt__input').placeholder)`)), 40_000);
    await sleep(600);
    const file = `${tag}-${name}.png`;
    await writeFile(join(dir, file), Buffer.from((await tab.shot()).split(',')[1] ?? '', 'base64'));
    return file;
  };
  const seen = (): Promise<Seen[]> => tab.eval<Seen[]>('window.__stage.elements().map((e) => ({ id: e.id, text: e.text, tappable: e.tappable, opacity: e.opacity, box: e.box }))');
  const shown = async (text: string): Promise<Seen | null> => (await seen()).find((e) => e.text === text && e.opacity > 0.9) ?? null;
  const until = async (what: string, test: () => Promise<boolean>, ms = 25_000): Promise<boolean> => {
    for (let waited = 0; waited < ms; waited += 250) {
      if (await test()) return true;
      await sleep(250);
    }
    list.push(`${what} did not happen in ${ms / 1000} s`);
    return false;
  };
  const typeCommand = async (text: string): Promise<void> => {
    await tab.eval(`document.querySelector('.prompt__input').focus()`);
    await tab.type(text);
    await tab.key('Enter');
  };
  // `wait`: the tour's page plays at the pace of reading (about 13 s for all seven chapters): the last of them comes late
  const tapCard = async (text: string, wait = 12_000): Promise<boolean> => {
    if (!(await until(`the card "${text}"`, async () => (await shown(text)) !== null, wait))) {
      list.push(`on stage then: ${(await seen()).filter((e) => e.opacity > 0.05 && e.text !== '').map((e) => `"${e.text.slice(0, 30)}"${e.tappable ? '*' : ''} ${Math.round(e.opacity * 100)}%`).join(', ')}`);
      return false;
    }
    const card = await shown(text);
    if (card === null) return false;
    if (!card.tappable) await sleep(1500);
    if (!(await shown(text))?.tappable) list.push(`the card "${text}" is not tappable`);
    if (card.box.x < -1 || card.box.x + card.box.width > screen.width + 1) list.push(`the card "${text}" is cut off at the side (${Math.round(card.box.x)}..${Math.round(card.box.x + card.box.width)} of ${screen.width})`);
    await tab.eval(`window.__stage.tap(${JSON.stringify(card.id)})`);
    return true;
  };
  const barText = (): Promise<string[]> => tab.eval<string[]>(`[...document.querySelectorAll('[data-tour-bar] button')].filter((b) => !b.hidden && b.offsetParent !== null && !b.disabled).map((b) => b.textContent)`);
  /** the bar is up from the start of a demo with "Try it yourself" held back (disabled) until the demo's end */
  const barHeld = (): Promise<string[]> => tab.eval<string[]>(`[...document.querySelectorAll('[data-tour-bar] button')].filter((b) => !b.hidden && b.offsetParent !== null).map((b) => b.textContent + (b.disabled ? ' (held)' : ''))`);
  const barReady = (): Promise<boolean> => until('the tour bar after the demo', async () => (await barText()).includes('Try it yourself'), 40_000);
  /** fb-004, 031: nothing on the stage or over it meets the bar */
  const barClear = async (what: string): Promise<void> => {
    const found = await checkTourBar(tab, true);
    if (found.length > 0) list.push(`${what}: ${found.join('; ')}`);
  };
  try {
    note(`tour: ${tag}`);
    await tab.send('DOM.enable');
    await conv.start();
    // /demo opens the tour
    await typeCommand('/demo');
    const first = TOUR_CHAPTERS[0];
    const chapter = TOUR_CHAPTERS[0]?.title ?? '';
    if (first === undefined) throw new Error('the tour has no chapters');
    if (await until('the tour page', async () => (await shown('A tour of Conduit')) !== null, 12_000)) {
      await until('every chapter card to be tappable', async () => {
        const now = await seen();
        return TOUR_CHAPTERS.every((entry) => now.some((card) => card.text === entry.title && card.tappable));
      }, 12_000);
      const cards = await seen();
      for (const entry of TOUR_CHAPTERS) if (!cards.some((card) => card.text === entry.title && card.tappable)) list.push(`the tour has no tappable card "${entry.title}"`);
      picture = await shoot('tour');
      // a chapter, then a demo of it
      if (await tapCard(chapter)) {
        // the shortest demo card of the chapter: the card's demo is judged by the demo pass, here it only has to start and give the way back
        const demoCard = first.cards.find((card) => card.kind === 'demo' && card.name === 'art') ?? first.cards[0];
        if (demoCard === undefined || demoCard.kind !== 'demo') throw new Error('the first chapter starts with no demo');
        if (await until('the chapter page', async () => (await shown(demoCard.label)) !== null, 12_000)) {
          await shoot('chapter');
          if (await tapCard(demoCard.label)) {
            // the bar is there from the start, with "Try it yourself" held back, and the stage already keeps its room
            if (!(await until('the tour bar at the start of the demo', async () => (await barHeld()).includes('Back to the tour'), 8_000))) list.push('the tour bar was not up while the demo played');
            else if (!(await barHeld()).includes('Try it yourself (held)') && !(await barText()).includes('Try it yourself')) list.push('"Try it yourself" was not offered (held or ready) while the demo played');
            if (await barReady()) {
              const bar = await barText();
              if (!bar.includes('Try it yourself')) list.push('"Try it yourself" is not offered after the demo');
              await shoot('demo');
              await barClear('the demo at its end');
              // no model was asked: the turn was a demo
              const asked = await tab.eval<string>('JSON.stringify(window.__stage.events().filter((e) => e.type === "tap").length)');
              if (asked !== '0') list.push(`a tap on a tour card was sent to the brain (${asked} tap events)`);
              await tab.eval(`[...document.querySelectorAll('[data-tour-bar] button')].find((b) => b.textContent === 'Back to the tour').click()`);
              if (await until('the tour page again', async () => (await shown('A tour of Conduit')) !== null, 12_000)) await shoot('back');
            }
          }
        }
      }
    }
    // the memory card: five real turns (draw, draw again, restore the first, undo, reuse its moon), with the bar up throughout
    if (await tapCard('Iteration and memory')) {
      if (await tapCard('Bring back an earlier drawing')) {
        if (await barReady()) {
          const ids = await tab.eval<string[]>('window.__stage.elements().filter((e) => e.opacity > 0.05).map((e) => e.id)');
          if (!ids.some((id) => id.startsWith('moon1'))) list.push(`the first drawing's moon did not come back with use (on stage: ${ids.join(', ')})`);
          await shoot('memory');
          await barClear('the memory card at its end');
          await tab.eval(`[...document.querySelectorAll('[data-tour-bar] button')].find((b) => b.textContent === 'Back to the tour').click()`);
          await until('the tour page after the memory card', async () => (await shown('A tour of Conduit')) !== null, 12_000);
        }
      }
    }
    // the language view: the pane of lines is on beside the stage, so the stage is only the right part of the page; the line over the stage's lower edge is centred on the stage
    // (fb-006), and the bar and everything on the stage keep apart (fb-004)
    if (await tapCard('The language view', 30_000)) {
      if (await tapCard('Watch the picture being written')) {
        // while it plays, the line over the stage's lower edge holds "Show all"; tapped, it says where the earlier scenes are. Each stands over the middle of the stage's column (fb-006), on one line
        const pillUp = (): Promise<boolean> => tab.eval<boolean>(`(() => { const t = document.querySelector('.prompt__top'); return !!t && !t.hidden && t.offsetParent !== null; })()`);
        // the line is up from the tour's own page (it says it is playing), so it is the pane that is waited for: looked at before the pane opens, the line is trivially over the stage's middle
        await until('the language pane to open beside the stage', () => tab.eval<boolean>(`document.getElementById('app').dataset.lang === 'on'`), 15_000);
        if (!(await until('the line over the stage (Show all) while the language view plays', pillUp, 15_000))) list.push('there was no line over the stage while the language view played');
        else {
          // looked at the moment the pane is open, with no wait for a frame: the line stands over the stage's column as soon as the stage is in it
          const pill = await checkPill(tab);
          if (pill.length > 0) list.push(`the language view, Show all: ${pill.join('; ')}`);
          // and through five quick switches of the pane, looked at between the switch and the next frame, and 300 ms on
          const toggled = await checkPillThroughToggles(tab);
          if (toggled.length > 0) list.push(`the language view, switched on and off: ${toggled.join('; ')}`);
          await tab.eval(`document.querySelector('.action--show').click()`);
          // the note is said only when the stage can rest on the last of several scenes; when it is, it stands where the Show all line did
          let noted = false;
          for (let waited = 0; waited < 6000 && !noted; waited += 250) {
            noted = await tab.eval<boolean>(`[...document.querySelectorAll('.prompt__top .prompt__status')].some((n) => /Transcript/.test(n.textContent) && !n.classList.contains('prompt__status--quiet'))`);
            if (!noted) await sleep(250);
          }
          if (noted) {
            const note = await checkPill(tab);
            if (note.length > 0) list.push(`the language view, the Transcript note: ${note.join('; ')}`);
          }
        }
        if (await barReady()) {
          await shoot('language');
          await barClear('the language view at its end');
          await tab.eval(`[...document.querySelectorAll('[data-tour-bar] button')].find((b) => b.textContent === 'Back to the tour').click()`);
          await until('the tour page after the language view', async () => (await shown('A tour of Conduit')) !== null, 12_000);
        }
      }
    }
    // an input how-to card, and a named jump
    if (await tapCard('Input')) {
      if (await tapCard('Your voice')) {
        if (await until('the voice card', async () => (await shown('Try it: the mic')) !== null, 12_000)) await shoot('how');
      }
    }
    await typeCommand('/demo nonesuch');
    const said = async (): Promise<boolean> => tab.eval<boolean>(`[...document.querySelectorAll('.prompt__status, .prompt__notice')].some((n) => /no demo called/.test(n.textContent))`);
    let told = false;
    for (let waited = 0; waited < 6000 && !told; waited += 100) {
      told = await said();
      if (!told) await sleep(100);
    }
    if (!told) list.push('/demo with an unknown name did not say so');
    // a named jump starts its demo (its first lines land); the demo itself is judged by the demo pass, so it is not played to the end here
    await typeCommand('/demo controls');
    await until('the named demo to start', async () => (await tab.eval<boolean>(`/^Playing/.test(document.querySelector('.prompt__input').placeholder)`)) && (await seen()).some((e) => e.opacity > 0.05), 12_000);
    const failedRequests = tab.drain();
    if (failedRequests.consoleErrors.length > 0) list.push(`console errors: ${failedRequests.consoleErrors.map((e) => e.text).slice(0, 3).join(' | ')}`);
  } catch (error) {
    list.push(`stopped: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await tab.close();
  }
  const results: CheckResult[] = [
    { turn: 0, check: `tour-${tag}`, verdict: list.length === 0 ? 'PASS' : 'FAIL', detail: list.length === 0 ? '/demo opens the tour, a chapter lists its cards, a card plays its demo with no model call, "Back to the tour" returns, /demo <name> jumps to one' : list.join('; ') },
  ];
  return [{ name: `tour-${tag}`, picture, results, seconds: (Date.now() - began) / 1000 }];
}

if (process.argv[1] !== undefined && /tour-check\.ts$/.test(process.argv[1])) {
  const arg = (name: string, fallback: string): string => (process.argv.includes(name) ? (process.argv[process.argv.indexOf(name) + 1] as string) : fallback);
  const url = arg('--url', '');
  const out = arg('--out', '/tmp/conduit-tour');
  if (!url.startsWith('http')) {
    process.stderr.write('usage: tsx tour-check.ts --url http://127.0.0.1:<port> [--out <dir>]\n');
    process.exit(2);
  }
  void (async () => {
    let failed = 0;
    for (const screen of TOUR_SCREENS) {
      for (const scene of await tourGroup(url, screen, out, 90_000, (text) => process.stdout.write(`${text}\n`))) {
        for (const r of scene.results) {
          process.stdout.write(`${r.verdict} ${scene.name} ${r.check}: ${r.detail}\n`);
          if (r.verdict === 'FAIL') failed += 1;
        }
      }
    }
    process.exit(failed === 0 ? 0 : 1);
  })();
}
