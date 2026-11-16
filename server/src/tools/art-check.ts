// pnpm check's art-maker group: a drawing the shelf lacks is made in the background and put in its placeholder's place (PLAN-art.md, steps 5 and 6).
// It needs a server whose studio has a fake maker (`ART_MAKER=fake`, `ART_FAKE_MS` a few seconds), so no model is called. Three conversations, one tab each:
//
//   swap      `draw giraffe1 giraffe` shows a soft placeholder; a `move` and a label `near=giraffe1-neck` are said meanwhile; then the parts of the drawing
//             appear in the placeholder's place (the group kept, the move kept, the label by the neck), the placeholder is gone, and a second `draw` of the
//             subject is an immediate hit (the sheet is on the shelf)
//   caption   the caption of a pending drawing stands directly under its placeholder (a little dim line, no box), and follows the placeholder when it moves
//   typing    the person keeps typing while the drawing is made: the placeholder stays; when the keys stop, the drawing arrives
//   newer     a new scene is said before the drawing is made: the placeholder is gone with the old scene, nothing is swapped over the new one, and the
//             drawing is on the shelf for the next `draw`
//
//   stages    the maker offers a rough drawing first (`ART_FAKE_STAGES=on`): it is shown in the placeholder's place, and the finished drawing then
//             changes it in place (the body stays), draws in the new parts, and drops the part (`blob`) the finished drawing does not have
//
// Run by `pnpm check` and standalone (`tsx art-check.ts --url <server with ART_MAKER=fake ART_FAKE_MS=4000>`), with smoke's own Tab and Conversation.

import { mkdir, writeFile } from 'node:fs/promises';
import { sleep } from './explore-browser';
import { Conversation, Tab } from './smoke';
import type { CheckResult, Options } from './smoke';
import type { LensScene, LensScreen } from './lens-check';

export const ART_SCREEN: LensScreen = { name: '1280x800', width: 1280, height: 800, dpr: 1 };
/** the fake maker's wait the group is written for (`ART_FAKE_MS`) */
export const ART_FAKE_MS = 4000;

interface Live {
  readonly id: string;
  readonly kind: string;
  readonly text: string;
  readonly opacity: number;
  readonly phase: string;
  readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

const centre = (box: Live['box']): { x: number; y: number } => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

async function withTab<T>(base: string, screen: LensScreen, dir: string, timeoutMs: number, body: (tab: Tab, conv: Conversation, live: () => Promise<Live[]>, play: (script: string) => Promise<string | null>) => Promise<T>): Promise<T> {
  const tab = await Tab.open(screen.width, screen.height, { dpr: screen.dpr });
  const options: Options = { url: base, screens: [], out: dir, turns: new Set(), timeoutMs, parallel: false, demo: false, quiet: true, page: '', say: null, chat: 'off' };
  const conv = new Conversation(tab, options, { name: screen.name, width: screen.width, height: screen.height }, dir);
  try {
    await tab.send('DOM.enable');
    await conv.start();
    const live = (): Promise<Live[]> => tab.eval<Live[]>('window.__stage.elements().map((e) => ({ id: e.id, kind: e.kind, text: String(e.text || ""), phase: e.phase, opacity: e.opacity, box: e.box }))');
    const play = (script: string): Promise<string | null> => tab.eval<string | null>(`Promise.resolve(window.__stage.playScript(${JSON.stringify(script)})).then(() => null, (e) => String(e && e.message || e))`);
    return await body(tab, conv, live, play);
  } finally {
    await tab.close().catch(() => undefined);
  }
}

/** polls until `test` gives a value, or `ms` pass; null on the deadline */
async function until<T>(ms: number, test: () => Promise<T | null>): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const got = await test();
    if (got !== null) return got;
    if (Date.now() > end) return null;
    await sleep(150);
  }
}

const parts = (live: readonly Live[], group: string): Live[] => live.filter((element) => element.id.startsWith(`${group}-`) && element.id !== `${group}-soft` && element.opacity > 0.05);
const soft = (live: readonly Live[], group: string): Live | undefined => live.find((element) => element.id === `${group}-soft` && element.opacity > 0.05);

const HEAD = ['look paper', 'scene shelf figure canvas=square lines=2'];

/** Runs the art-maker group against a server with a fake maker. A failure is a `FAIL` result, never a throw. */
export async function artGroup(base: string, screen: LensScreen, dir: string, timeoutMs: number, note: (text: string) => void = () => undefined): Promise<LensScene[]> {
  await mkdir(dir, { recursive: true });
  const scenes: LensScene[] = [];
  const result = (name: string, picture: string, began: number, problems: readonly string[], saw: string): void => {
    const results: CheckResult[] = [{ turn: 0, check: 'art-maker', verdict: problems.length === 0 ? 'PASS' : 'FAIL', detail: problems.length === 0 ? saw : problems.join('; ') }];
    scenes.push({ name, picture, results, seconds: (Date.now() - began) / 1000 });
  };
  const fail = (name: string, began: number, error: unknown): void => result(name, '', began, [`stopped: ${error instanceof Error ? error.message : String(error)}`], '');

  // ---- swap ----
  {
    const began = Date.now();
    note('art-maker: swap');
    try {
      await withTab(base, screen, dir, timeoutMs, async (tab, conv, live, play) => {
        const problems: string[] = [];
        const script = [...HEAD, 'draw giraffe1 giraffe at=40,50 size=46', 'move giraffe1 60,50 over=1s', 'say label near=giraffe1-neck:below | neck', 'say facelabel near=giraffe1-face:right | face', 'wait 1'].join('\n');
        const started = await play(script);
        if (started !== null) problems.push(`the script would not play: ${started}`);
        const first = await until(8000, async () => (soft(await live(), 'giraffe1') === undefined ? null : await live()));
        if (first === null) problems.push('no soft placeholder for the giraffe');
        else if (parts(first, 'giraffe1').length > 0) problems.push('the drawing was on stage before it could have been made');
        const captioned = first === null ? null : await until(4000, async () => ((await live()).some((element) => element.kind === 'text' && /Drawing a giraffe/.test(element.text)) ? true : null));
        if (first !== null && captioned === null) problems.push('no caption ("Drawing a giraffe…") under the placeholder');
        // labels said for the parts of a drawing still on its way are held, not shown piled at the centre
        const showing = (now: readonly Live[], words: string): boolean => now.some((element) => element.kind === 'text' && element.text.trim() === words && element.opacity > 0.05);
        const early = await live();
        if (first !== null && (showing(early, 'neck') || showing(early, 'face'))) problems.push('a label for a part of the pending drawing is on stage before the drawing arrived');
        // at rest with the placeholder still standing: where the move took the group
        await sleep(2500);
        const before = soft(await live(), 'giraffe1');
        const resting = before === undefined ? null : centre(before.box);
        const after = await until(ART_FAKE_MS + 20_000, async () => {
          const now = await live();
          return parts(now, 'giraffe1').length >= 8 ? now : null;
        });
        await sleep(1800);
        const settled = await live();
        if (after === null) problems.push('the drawing never replaced the placeholder');
        else {
          const body = settled.find((element) => element.id === 'giraffe1-body');
          const neck = settled.find((element) => element.id === 'giraffe1-neck');
          const label = settled.find((element) => element.kind === 'text' && element.text.trim() === 'neck');
          if (soft(settled, 'giraffe1') !== undefined) problems.push('the placeholder is still on stage beside the drawing');
          if (settled.some((element) => element.kind === 'text' && /Drawing a giraffe/.test(element.text) && element.opacity > 0.05)) problems.push('the caption is still on stage after the drawing arrived');
          if (!settled.some((element) => element.id === 'giraffe1')) problems.push('the group giraffe1 is gone (its id was not kept)');
          if (body === undefined || neck === undefined) problems.push('the drawing has no body or neck part');
          else {
            if (resting !== null) {
              const c = centre(body.box);
              const off = Math.hypot(c.x - resting.x, c.y - resting.y);
              const reach = Math.max(neck.box.width, neck.box.height, body.box.width) * 0.7;
              if (off > reach) problems.push(`the drawing's body sits ${off.toFixed(0)} px from where the placeholder stood after the move (more than ${reach.toFixed(0)})`);
            }
            // a label that named a part by the brain's guess (`face`; the drawing's part is `head`) was pointed at the part when the drawing came
            const faceLabel = settled.find((element) => element.kind === 'text' && element.text.trim() === 'face');
            const head = settled.find((element) => element.id === 'giraffe1-head');
            if (faceLabel === undefined || head === undefined) problems.push('the label "face" or the head part is not on stage');
            else {
              const a = centre(faceLabel.box);
              const b = centre(head.box);
              const gap = Math.hypot(a.x - b.x, a.y - b.y);
              const reach = Math.max(head.box.width, head.box.height) * 1.2 + faceLabel.box.height * 2 + faceLabel.box.width / 2;
              if (gap > reach) problems.push(`the label "face" is ${gap.toFixed(0)} px from the head's middle (more than ${reach.toFixed(0)}): it was not pointed at the part`);
            }
            if (label === undefined) problems.push('the label "neck" is not on stage');
            else {
              const a = centre(label.box);
              const b = centre(neck.box);
              const gap = Math.hypot(a.x - b.x, a.y - b.y);
              const reach = Math.max(neck.box.width, neck.box.height) * 1.2 + label.box.height * 2;
              if (gap > reach) problems.push(`the label "neck" is ${gap.toFixed(0)} px from the neck's middle (more than ${reach.toFixed(0)})`);
            }
          }
        }
        // a second figure of the subject is a hit, at once
        const again = await play('draw giraffe2 giraffe at=20,20 size=30');
        if (again !== null) problems.push(`the second script would not play: ${again}`);
        const quick = await until(2500, async () => {
          const now = await live();
          return parts(now, 'giraffe2').length >= 8 ? now : null;
        });
        if (quick === null) problems.push('a second giraffe was not drawn from the shelf at once');
        else if (soft(quick, 'giraffe2') !== undefined) problems.push('the second giraffe had a placeholder: the sheet was not on the shelf');
        await conv.rest(null, false).catch(() => undefined);
        const picture = `${dir}/art-swap.png`;
        await tab.shot().then((data) => writeFile(picture, Buffer.from(data.split(',')[1] ?? '', 'base64'))).catch(() => undefined);
        result('swap', picture, began, problems, `a placeholder, then the giraffe's ${after === null ? 0 : parts(after, 'giraffe1').length} parts in its place, the group and its move kept, the label by the neck, and a second giraffe from the shelf at once`);
      });
    } catch (error) {
      fail('swap', began, error);
    }
  }

  // ---- caption ----
  {
    const began = Date.now();
    note('art-maker: caption');
    try {
      await withTab(base, screen, dir, timeoutMs, async (tab, conv, live, play) => {
        const problems: string[] = [];
        const script = ['look dusk like=night ground=#2b1d3a ink=#f6e3c0 accent=#ffb454', 'scene captioned layout=caption', 'rect sky full layer=far fill=#3a2a55', 'rect ground 0,70 160x20 layer=bg fill=#3d5a3a', 'circle sun 120,58 14 layer=far fill=#ffb454', 'draw ostrich1 ostrich at=45,45 size=66', 'draw vole1 vole at=125,68 size=12', 'say story | A story is told under the picture, in the usual place.', 'say headlabel near=ostrich1-head:right | head', 'wait 1'].join('\n');
        const started = await play(script);
        if (started !== null) problems.push(`the script would not play: ${started}`);
        const placed = async (name: string): Promise<{ soft: Live; cap: Live } | null> => {
          const now = await live();
          const placeholder = soft(now, name);
          const cap = now.find((element) => element.id === `cap-${name}` && element.opacity > 0.5);
          return placeholder === undefined || cap === undefined ? null : { soft: placeholder, cap };
        };
        // the caption's box is wider than its words, so it is judged by its middle and by how far its top is below the placeholder's bottom
        const under = (name: string, at: { soft: Live; cap: Live }): void => {
          const drop = at.cap.box.y - (at.soft.box.y + at.soft.box.height);
          const across = Math.abs(centre(at.cap.box).x - centre(at.soft.box).x);
          if (drop < -2 || drop > 60) problems.push(`the caption of ${name} is ${drop.toFixed(0)} px below its placeholder's bottom (wanted 0 to 60)`);
          if (across > Math.max(40, at.soft.box.width * 0.3)) problems.push(`the caption of ${name} is ${across.toFixed(0)} px to the side of its placeholder's middle`);
        };
        const heldOk = await live();
        if (heldOk.some((element) => element.kind === 'text' && element.text.trim() === 'head' && element.opacity > 0.05)) problems.push('a label for a part of the pending ostrich is on stage');
        const mouse = await until(8000, () => placed('vole1'));
        const giraffe = await until(8000, () => placed('ostrich1'));
        if (mouse === null || giraffe === null) problems.push('a placeholder or its caption is missing');
        else {
          under('ostrich1', giraffe);
          under('vole1', mouse);
          // the mouse is moved while its drawing is on its way: the caption goes with it
          const moved = await play('move vole1 125,25 over=1s');
          if (moved !== null) problems.push(`the move would not play: ${moved}`);
          const later = await until(5000, async () => {
            const at = await placed('vole1');
            return at !== null && Math.hypot(centre(at.soft.box).x - centre(mouse.soft.box).x, centre(at.soft.box).y - centre(mouse.soft.box).y) > 30 ? at : null;
          });
          if (later === null) problems.push('the placeholder of vole1 did not move');
          else {
            await sleep(1500);
            const settled = await placed('vole1');
            if (settled === null) problems.push('the caption of vole1 is gone after its move');
            else {
              under('vole1 after its move', settled);
              if (Math.hypot(centre(settled.cap.box).x - centre(mouse.cap.box).x, centre(settled.cap.box).y - centre(mouse.cap.box).y) < 20) problems.push('the caption of vole1 did not follow its placeholder');
            }
          }
        }
        const picture = `${dir}/art-caption.png`;
        await tab.shot().then((data) => writeFile(picture, Buffer.from(data.split(',')[1] ?? '', 'base64'))).catch(() => undefined);
        await conv.rest(null, false).catch(() => undefined);
        result('caption', picture, began, problems, 'each pending drawing has its caption directly under its placeholder, and the caption of the one that moved went with it');
      });
    } catch (error) {
      fail('caption', began, error);
    }
  }

  // ---- failed ----
  {
    const began = Date.now();
    note('art-maker: failed');
    try {
      await withTab(base, screen, dir, timeoutMs, async (tab, conv, live, play) => {
        const problems: string[] = [];
        const started = await play([...HEAD, 'draw unmakeable1 unmakeable at=50,50 size=46', 'say whisker near=unmakeable1-whisker:below | whisker', 'wait 1'].join('\n'));
        if (started !== null) problems.push(`the script would not play: ${started}`);
        await until(8000, async () => (soft(await live(), 'unmakeable1') === undefined ? null : true));
        const shows = (now: readonly Live[]): Live | undefined => now.find((element) => element.kind === 'text' && element.text.trim() === 'whisker' && element.opacity > 0.05);
        if (shows(await live()) !== undefined) problems.push('the label for a part is on stage while the drawing is pending');
        // the maker fails: the label is shown beside the placeholder, so that its words are not lost
        const label = await until(ART_FAKE_MS + 20_000, async () => shows(await live()) ?? null);
        await sleep(1500);
        const now = await live();
        const placeholder = soft(now, 'unmakeable1');
        const word = shows(now);
        if (label === null || word === undefined) problems.push('the label was lost when the drawing could not be made');
        else if (placeholder === undefined) problems.push('the placeholder is gone');
        else {
          const a = centre(word.box);
          const b = centre(placeholder.box);
          const reach = Math.max(placeholder.box.width, placeholder.box.height) * 0.5 + word.box.height * 2 + word.box.width / 2;
          if (Math.hypot(a.x - b.x, a.y - b.y) > reach) problems.push(`the label is ${Math.hypot(a.x - b.x, a.y - b.y).toFixed(0)} px from the placeholder (more than ${reach.toFixed(0)})`);
        }
        await conv.rest(null, false).catch(() => undefined);
        const picture = `${dir}/art-failed.png`;
        await tab.shot().then((data) => writeFile(picture, Buffer.from(data.split(',')[1] ?? '', 'base64'))).catch(() => undefined);
        result('failed', picture, began, problems, 'a label for a part was held while the drawing was pending, and shown beside the placeholder when the drawing could not be made');
      });
    } catch (error) {
      fail('failed', began, error);
    }
  }

  // ---- typing ----
  {
    const began = Date.now();
    note('art-maker: typing');
    try {
      await withTab(base, screen, dir, timeoutMs, async (tab, conv, live, play) => {
        const problems: string[] = [];
        const started = await play([...HEAD, 'draw zebra1 zebra at=50,50 size=46', 'wait 1'].join('\n'));
        if (started !== null) problems.push(`the script would not play: ${started}`);
        await until(8000, async () => (soft(await live(), 'zebra1') === undefined ? null : true));
        await tab.eval(`document.querySelector('.prompt__input').focus()`);
        // keys keep coming for longer than the drawing takes to make
        const typingUntil = Date.now() + ART_FAKE_MS + 3500;
        let early = false;
        while (Date.now() < typingUntil) {
          await tab.type('a');
          await sleep(500);
          if (parts(await live(), 'zebra1').length > 0) early = true;
        }
        if (early) problems.push('the drawing was swapped in while the person was typing');
        if (soft(await live(), 'zebra1') === undefined) problems.push('the placeholder was lost while the person was typing');
        // the keys stop: the typing lapses and the drawing arrives
        const after = await until(20_000, async () => {
          const now = await live();
          return parts(now, 'zebra1').length >= 8 ? now : null;
        });
        if (after === null) problems.push('the drawing did not arrive after the person stopped typing');
        await tab.eval(`(() => { const i = document.querySelector('.prompt__input'); if (i) { i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); } })()`).catch(() => undefined);
        await conv.rest(null, false).catch(() => undefined);
        result('typing', '', began, problems, 'the placeholder stood while keys were coming, and the drawing replaced it once they stopped');
      });
    } catch (error) {
      fail('typing', began, error);
    }
  }

  // ---- a newer scene ----
  {
    const began = Date.now();
    note('art-maker: newer scene');
    try {
      await withTab(base, screen, dir, timeoutMs, async (tab, conv, live, play) => {
        const problems: string[] = [];
        const started = await play([...HEAD, 'draw hippo1 hippo at=50,50 size=46', 'wait 1'].join('\n'));
        if (started !== null) problems.push(`the script would not play: ${started}`);
        await until(8000, async () => (soft(await live(), 'hippo1') === undefined ? null : true));
        await conv.rest(null, false).catch(() => undefined);
        const next = await play(['scene later figure canvas=square lines=2', 'say new1 | A new scene, said before the drawing was made.', 'wait 1'].join('\n'));
        if (next !== null) problems.push(`the second script would not play: ${next}`);
        await sleep(ART_FAKE_MS + 4000);
        const now = await live();
        if (parts(now, 'hippo1').length > 0 || soft(now, 'hippo1') !== undefined) problems.push('part of the hippo is on stage over the newer scene');
        if (!now.some((element) => element.kind === 'text' && element.text.includes('A new scene'))) problems.push('the newer scene is not on stage');
        // the sheet was kept: a hippo said again is a hit
        const again = await play([...HEAD, 'draw hippo2 hippo at=50,50 size=46', 'wait 1'].join('\n'));
        if (again !== null) problems.push(`the third script would not play: ${again}`);
        const hit = await until(3000, async () => {
          const live2 = await live();
          return parts(live2, 'hippo2').length >= 8 ? live2 : null;
        });
        if (hit === null) problems.push('the hippo was not on the shelf after the swap was blocked');
        await conv.rest(null, false).catch(() => undefined);
        result('newer-scene', '', began, problems, 'the placeholder left with its scene, nothing was swapped over the newer one, and the sheet was on the shelf for the next draw');
      });
    } catch (error) {
      fail('newer-scene', began, error);
    }
  }

  // ---- stages ----
  {
    const began = Date.now();
    note('art-maker: stages');
    try {
      await withTab(base, screen, dir, timeoutMs, async (_tab, conv, live, play) => {
        const problems: string[] = [];
        const started = await play([...HEAD, 'draw llama1 llama at=50,50 size=46', 'wait 1'].join('\n'));
        if (started !== null) problems.push(`the script would not play: ${started}`);
        const rough = await until(ART_FAKE_MS + 15_000, async () => {
          const now = await live();
          return now.some((element) => element.id === 'llama1-blob' && element.opacity > 0.05) ? now : null;
        });
        if (rough === null) problems.push('the rough first stage never replaced the placeholder');
        else if (parts(rough, 'llama1').length >= 8) problems.push('the finished drawing was on stage with the rough one');
        await sleep(1500);
        const roughSettled = await live();
        if (rough !== null && soft(roughSettled, 'llama1') !== undefined) problems.push('the placeholder stood beside the rough stage');
        const body0 = roughSettled.find((element) => element.id === 'llama1-body');
        const done = await until(ART_FAKE_MS + 15_000, async () => {
          const now = await live();
          return parts(now, 'llama1').length >= 8 ? now : null;
        });
        await sleep(2000);
        const settled = await live();
        if (done === null) problems.push('the finished drawing never replaced the rough stage');
        else {
          if (settled.some((element) => element.id === 'llama1-blob' && element.opacity > 0.05)) problems.push('the part the finished drawing leaves out (blob) is still on stage');
          if (!settled.some((element) => element.id === 'llama1')) problems.push('the group llama1 is gone');
          const body = settled.find((element) => element.id === 'llama1-body');
          if (body === undefined) problems.push('the body is gone');
          else if (body0 !== undefined && Math.hypot(centre(body.box).x - centre(body0.box).x, centre(body.box).y - centre(body0.box).y) > 60) problems.push('the body jumped between the stages');
        }
        await conv.rest(null, false).catch(() => undefined);
        result('stages', '', began, problems, 'a rough stage in the placeholder\'s place, then the finished drawing in place: the body kept, new parts drawn in, the blob dropped');
      });
    } catch (error) {
      fail('stages', began, error);
    }
  }
  return scenes;
}

if (process.argv[1] !== undefined && /art-check\.ts$/.test(process.argv[1])) {
  const at = process.argv.indexOf('--url');
  const base = at >= 0 ? process.argv[at + 1] : undefined;
  if (base === undefined) {
    process.stderr.write('usage: tsx art-check.ts --url <a server started with ART_MAKER=fake ART_FAKE_MS=4000>\n');
    process.exit(2);
  }
  artGroup(base, ART_SCREEN, process.argv[process.argv.indexOf('--out') + 1] ?? '/tmp/art-check', 120_000, (text) => process.stdout.write(`${text}\n`))
    .then((scenes) => {
      let bad = 0;
      for (const scene of scenes) for (const r of scene.results) {
        process.stdout.write(`${r.verdict} ${scene.name}: ${r.detail}\n`);
        if (r.verdict === 'FAIL') bad += 1;
      }
      process.exit(bad === 0 ? 0 : 1);
    })
    .catch((error: unknown) => {
      process.stderr.write(`art-check: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(2);
    });
}
