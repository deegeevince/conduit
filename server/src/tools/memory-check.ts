// pnpm check's drawing-memory group (Design 2): the server's own path, with no model. Scripts are played as turns of a session
// (the replay brain writes them, the conductor reads them), and the page's elements are read back:
//
//   undo      `restore undo` puts the drawing back one version, and the boxes digest of the page equals the earlier version's (twice, back to the first)
//   restore   a turn whose elements a later `scene` dropped comes back whole with `restore <turn>`, with the same boxes digest it had
//   mix       parts of two earlier turns come back on one canvas (`use … from=`): ids unchanged when free, `<id>-<turn>` when taken, a colour name since
//             redefined written as hex; they are real elements, so a later `move` moves one and a `drop` removes one
//   painted   a procedural painting (`paint … as=oil`) is kept in its version and comes back with `restore` and `/undo`; one that asks an image model is not kept
//   chip      an Undo chip stands after a turn that changed a drawing
//
// Run by `pnpm check` and standalone (`tsx memory-check.ts --url <server>`), with smoke's own Tab and Conversation.

import { mkdir } from 'node:fs/promises';
import { LineNormalizer, parseLine, serializeLine as serialize } from '@conduit/language';
import { ENGINE_VERSION, scoreOfCase } from '@conduit/web/engine';
import { DrawingMemory, MEMORY_LIMITS, rebuildMemory } from '../domain/drawing-memory';
import { measureDraft } from '../domain/stage-facts';
import type { MeasureSession } from '../domain/stage-facts';
import { sleep } from './explore-browser';
import { Conversation, Tab } from './smoke';
import type { CheckResult, Options } from './smoke';
import type { LensScene, LensScreen } from './lens-check';

export const MEMORY_SCREEN: LensScreen = { name: '1280x800', width: 1280, height: 800, dpr: 1 };

export interface Live {
  readonly id: string;
  readonly kind: string;
  readonly opacity: number;
  readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

export const standing = (live: readonly Live[]): Live[] => live.filter((element) => element.opacity > 0.05 && ['shape', 'group', 'copy'].includes(element.kind));
const paintings = (live: readonly Live[]): string[] => live.filter((element) => element.kind === 'picture' && element.opacity > 0.05).map((element) => element.id);
/** the boxes of what stands, as one string: ids with their rounded boxes, in id order */
export const digest = (live: readonly Live[]): string =>
  standing(live)
    .map((element) => `${element.id}:${Math.round(element.box.x)},${Math.round(element.box.y)},${Math.round(element.box.width)},${Math.round(element.box.height)}`)
    .sort()
    .join(' ');

/** The page settles to within a pixel or two (the brush's own wobble); the server's measure above is the exact one. */
const alike = (a: string, b: string): boolean => {
  const x = a.split(/[ :,]/);
  const y = b.split(/[ :,]/);
  return x.length === y.length && x.every((part, at) => (/^-?\d+$/.test(part) ? Math.abs(Number(part) - Number(y[at])) <= 3 : part === y[at]));
};

export async function withTab<T>(base: string, screen: LensScreen, dir: string, timeoutMs: number, body: (tab: Tab, live: () => Promise<Live[]>, play: (script: string) => Promise<string>) => Promise<T>): Promise<T> {
  const tab = await Tab.open(screen.width, screen.height, { dpr: screen.dpr });
  const options: Options = { url: base, screens: [], out: dir, turns: new Set(), timeoutMs, parallel: false, demo: false, quiet: true, page: '', say: null, chat: 'off' };
  const conv = new Conversation(tab, options, { name: screen.name, width: screen.width, height: screen.height }, dir);
  try {
    await tab.send('DOM.enable');
    await conv.start();
    const live = (): Promise<Live[]> => tab.eval<Live[]>('window.__stage.elements().map((e) => ({ id: e.id, kind: e.kind, opacity: e.opacity, box: e.box }))');
    /** plays a script as a turn, waits for it to settle, and gives the turn's id */
    const play = async (script: string): Promise<string> => {
      const failed = await tab.eval<string | null>(`Promise.resolve(window.__stage.playScript(${JSON.stringify(script)})).then(() => null, (e) => String(e && e.message || e))`);
      if (failed !== null) throw new Error(`the script would not play: ${failed}`);
      const turn = await tab.eval<string>('String(window.__stage.state().turn || "")');
      let last = '';
      let steady = 0;
      for (let i = 0; i < 60 && steady < 5; i += 1) {
        await sleep(300);
        const now = digest(await live());
        steady = now === last ? steady + 1 : 0;
        last = now;
      }
      return turn;
    };
    return await body(tab, live, play);
  } finally {
    await tab.close().catch(() => undefined);
  }
}

/** What the server measures a draft against: a desk-sized page, the engine's own version. */
const MEASURED = { screen: { width: 1280, height: 800, dpr: 1, reducedMotion: false }, capabilities: { looks: [], engine: ENGINE_VERSION }, tables: [], held: {} } as unknown as MeasureSession;

/**
 * The server's own measure, with no page: the digest of the boxes the engine places for the lines of a version, against the same after later turns
 * changed the drawing and `restore undo` (and `restore <turn>`) put it back. The digests must be equal, character for character.
 */
export function digestProblems(): string[] {
  const problems: string[] = [];
  const turns: { readonly turn: string; readonly said: string; readonly lines: readonly string[] }[] = [
    { turn: 't1', said: 'paint a night', lines: ['scene one canvas=wide', 'color sky=#1b2a49 moon=#f5e6a8', 'rect sky1 0,0 160x90 fill=sky', 'group tree at=40,60', 'circle crown 0,-10 12 fill=#226644 in=tree', 'rect trunk -2,0 4x14 fill=#554433 in=tree', 'circle moon1 130,15 8 fill=moon'] },
    { turn: 't2', said: 'a new one', lines: ['scene two canvas=wide', 'color sky=#880000', 'rect field 0,0 160x90 fill=#334455', 'circle sun 80,45 15 fill=#ffcc00'] },
    { turn: 't3', said: 'warmer', lines: ['set sun fill=#ffffff', 'move sun 90,40'] },
  ];
  const memory = new DrawingMemory();
  let seq = 0;
  const all: { seq: number; text: string; floor: number; turn: string }[] = [];
  for (const turn of turns) {
    memory.begin(turn.turn, turn.said);
    for (const text of turn.lines) {
      seq += 1;
      memory.record(turn.turn, seq, text);
      all.push({ seq, text, floor: 0, turn: turn.turn });
    }
  }
  memory.close();
  const boxesThrough = (last: string, extra: readonly string[] = []): string => {
    const upTo = all.filter((entry) => entry.turn <= last);
    const score = scoreOfCase({ id: 'm', base: null, opened: 'script', lines: upTo });
    const normalizer = new LineNormalizer(() => 'z');
    let next = upTo.length + 1;
    for (const text of extra) {
      const read = parseLine(text);
      if (read.kind !== 'line') continue;
      const done = normalizer.normalize(read.line);
      if (done.line !== null) score.push(done.line, next++, 0);
    }
    return measureDraft(score, MEASURED)?.boxes ?? 'unmeasured';
  };
  const live = (last: string): string[] => {
    const score = scoreOfCase({ id: 'm', base: null, opened: 'script', lines: all.filter((entry) => entry.turn <= last) });
    return [...new Set(score.schedule.elements.filter((element) => element.exit === null && element.parent === null && ['shape', 'group'].includes(element.kind)).map((element) => element.id))];
  };
  const text = (index: number, standing: readonly string[]): string[] => memory.restore(index, standing).lines.map((line) => serialize(line));
  const one = boxesThrough('t1');
  const two = boxesThrough('t2');
  const three = boxesThrough('t3');
  if (memory.versions.length !== 3) problems.push(`the memory holds ${memory.versions.length} versions, expected 3`);
  if (one === two || two === three) problems.push('versions that differ have the same boxes digest');
  // after turn 3, `restore undo` puts back version 2 (index 1), and then, undo again, version 1
  const undo = memory.find('undo');
  const undone = boxesThrough('t3', text(undo?.index ?? -1, live('t3')));
  if (undone !== two) problems.push(`undo: the boxes digest is ${undone}, the second version's is ${two}`);
  const back = boxesThrough('t3', text(0, live('t3')));
  if (back !== one) problems.push(`restore t1 after a scene dropped it: the boxes digest is ${back}, the first version's is ${one}`);
  // a conversation taken up again: the same versions are read back from its log
  const records = turns.flatMap((turn) => [{ type: 'turn', turn: turn.turn, input: { kind: 'prompt', text: turn.said } }, ...all.filter((entry) => entry.turn === turn.turn).map((entry) => ({ type: 'line', turn: turn.turn, seq: entry.seq, text: entry.text }))]);
  const again = rebuildMemory(records);
  if (again.versions.map((version) => version.sig).join('|') !== memory.versions.map((version) => version.sig).join('|')) problems.push('the memory rebuilt from the log is not the memory that was kept');
  // the cap: 4,000 lines a conversation, and the newest version still comes back
  const big = new DrawingMemory();
  for (let n = 1; n <= MEMORY_LIMITS.lines + 200; n += 1) {
    if (n % 400 === 1) big.begin(`t${n}`, `turn ${n}`);
    big.record(`t${n - ((n - 1) % 400)}`, n, `circle c${n} ${n % 150},${n % 80} 3 fill=#${(n * 7919).toString(16).padStart(6, '0').slice(-6)}`);
  }
  big.close();
  if (big.lineCount > MEMORY_LIMITS.lines) problems.push(`the memory holds ${big.lineCount} lines, more than ${MEMORY_LIMITS.lines}`);
  if (big.versions.length === 0) problems.push('past the cap the memory holds no versions');
  // paintings: a procedural one is kept with its version and comes back with it; one that asks an image model is not kept
  const painted = new DrawingMemory();
  const sets: { readonly turn: string; readonly lines: readonly string[] }[] = [
    { turn: 't1', lines: ['scene a canvas=wide', 'group hill at=40,60', 'rect slope 0,0 60x20 fill=#336644 in=hill', 'paint oil1 over=hill as=oil | a hill', 'paint photo1 as=photo | a hill', 'paint plain1 | a hill'] },
    { turn: 't2', lines: ['scene b canvas=wide', 'circle sun 80,45 15 fill=#ffcc00'] },
  ];
  let n = 0;
  for (const set of sets) {
    painted.begin(set.turn, 'x');
    for (const text of set.lines) painted.record(set.turn, (n += 1), text);
  }
  painted.close();
  const first = painted.versions[0];
  if (painted.versions.length !== 2) problems.push(`the painting memory holds ${painted.versions.length} versions, expected 2`);
  if (first === undefined || first.paints.length !== 1 || !first.paints[0]?.startsWith('paint oil1')) problems.push(`a procedural painting was not kept in its version (${first?.paints.join(' / ') ?? 'no version'})`);
  if (first !== undefined && first.paints.some((text) => /photo1|plain1/.test(text))) problems.push('a painting that asks an image model was kept');
  const put = painted.restore(0, ['sun']).lines.map((line) => serialize(line));
  if (!put.some((text) => text.startsWith('paint oil1'))) problems.push('restore did not put the painting back');
  if (put.findIndex((text) => text.startsWith('paint oil1')) < put.findIndex((text) => text.includes('slope'))) problems.push('restore put the painting before the parts it paints over');
  const stepped = painted.find('undo');
  if (!painted.restore(stepped?.index ?? -1, ['sun']).lines.some((line) => line.verb === 'paint')) problems.push('undo did not put the painting back');
  if (painted.paintOf('oil1') === null) problems.push('the memory cannot say the painting again');
  return problems;
}

const FIRST = ['scene one canvas=wide', 'color sky=#1b2a49 moon=#f5e6a8', 'rect sky1 0,0 160x90 fill=sky', 'group tree at=40,60', 'circle crown 0,-10 12 fill=#226644 in=tree', 'rect trunk -2,0 4x14 fill=#554433 in=tree', 'circle moon1 130,15 8 fill=moon', 'wait 1'].join('\n');
const PAINTED = ['scene three canvas=wide', 'group hill at=40,60', 'rect slope 0,0 60x20 fill=#336644 in=hill', 'paint oil1 over=hill as=oil | a hill', 'wait 1'].join('\n');
const SECOND = ['scene two canvas=wide', 'color sky=#880000', 'rect field 0,0 160x90 fill=#334455', 'circle sun 80,45 15 fill=#ffcc00', 'wait 1'].join('\n');

/** Runs the drawing-memory group against a server (BRAIN=replay). A failure is a `FAIL` result, never a throw. */
export async function memoryGroup(base: string, screen: LensScreen, dir: string, timeoutMs: number, note: (text: string) => void = () => undefined): Promise<LensScene[]> {
  await mkdir(dir, { recursive: true });
  const scenes: LensScene[] = [];
  const result = (name: string, began: number, problems: readonly string[], saw: string): void => {
    const results: CheckResult[] = [{ turn: 0, check: 'memory', verdict: problems.length === 0 ? 'PASS' : 'FAIL', detail: problems.length === 0 ? saw : problems.join('; ') }];
    scenes.push({ name, picture: '', results, seconds: (Date.now() - began) / 1000 });
  };
  const began = Date.now();
  note('memory');
  try {
    await withTab(base, screen, dir, timeoutMs, async (tab, live, play) => {
      const problems: string[] = digestProblems();
      const ids = async (): Promise<string[]> => standing(await live()).map((element) => element.id);
      const chip = (): Promise<boolean> => tab.eval<boolean>('(() => { const c = document.querySelector("[data-undo-chip]"); return c !== null && !c.hidden && getComputedStyle(c).display !== "none"; })()');

      // the first drawing, then a second turn that begins a new scene (the first drawing's elements are dropped by it)
      const one = await play(FIRST);
      const digestOne = digest(await live());
      if (!(await ids()).includes('moon1')) problems.push('the first drawing did not appear');
      if (!(await chip())) problems.push('no Undo chip after a turn that drew');
      const two = await play(SECOND);
      const digestTwo = digest(await live());
      if ((await ids()).includes('moon1')) problems.push('the new scene did not drop the first drawing');

      // restore: the dropped turn comes back whole, with the boxes it had
      await play(`restore ${one}`);
      const restored = digest(await live());
      if (!alike(restored, digestOne)) problems.push(`restore ${one}: boxes differ from the first drawing (${restored} against ${digestOne})`);
      if ((await ids()).includes('sun')) problems.push(`restore ${one} left the second drawing on stage`);

      // undo, with no model: back to the second drawing, then to the first
      await play('restore undo');
      const undone = digest(await live());
      if (!alike(undone, digestTwo)) problems.push(`undo: boxes differ from the second drawing (${undone} against ${digestTwo})`);
      await play('restore undo');
      const undoneAgain = digest(await live());
      if (!alike(undoneAgain, digestOne)) problems.push(`a second undo: boxes differ from the first drawing (${undoneAgain} against ${digestOne})`);

      // mix: parts of the first turn onto the second drawing
      await play(`restore ${two}`);
      const before = new Set(await ids());
      await play(`use moon1 tree from=${one} at=40,30 scale=0.8`);
      const mixed = new Set(await ids());
      const added = [...mixed].filter((id) => !before.has(id));
      if (!mixed.has('moon1') || !mixed.has('tree')) problems.push(`parts of ${one} did not come back by their own ids (${added.join(', ')})`);
      if (!mixed.has('sun')) problems.push('the second drawing was lost when parts of the first were mixed in');
      await play(`use moon1 from=${one}`);
      if (!(await ids()).includes(`moon1-${one}`)) problems.push(`a taken id did not come back as moon1-${one}`);
      const moon = (await live()).find((element) => element.id === 'moon1');
      await play('move moon1 20,20 over=0.4s\ndrop tree');
      const after = await live();
      const moved = after.find((element) => element.id === 'moon1');
      if (moon === undefined || moved === undefined || Math.abs(moved.box.x - moon.box.x) < 5) problems.push('a part brought back could not be moved');
      const widthBefore = moved?.box.width ?? 0;
      await play('set moon1 scale=2');
      const grown = (await live()).find((element) => element.id === 'moon1');
      if (grown === undefined || grown.box.width < widthBefore * 1.3) problems.push('a part brought back could not be set');
      if (standing(after).some((element) => element.id === 'tree')) problems.push('a part brought back could not be dropped');
      if (!standing(after).some((element) => element.id === 'sun')) problems.push('dropping a mixed-in part dropped the second drawing too');
      // a painting: kept with its turn, and back with `restore` and with `restore undo` after a new scene dropped it
      const drawn = await play(PAINTED);
      if (!paintings(await live()).includes('oil1')) problems.push('the painting did not appear');
      await play(SECOND);
      if (paintings(await live()).includes('oil1')) problems.push('a new scene left the painting on stage');
      await play('restore undo');
      if (!paintings(await live()).includes('oil1')) problems.push('undo did not bring the painting back');
      await play(SECOND);
      await play(`restore ${drawn}`);
      if (!paintings(await live()).includes('oil1')) problems.push(`restore ${drawn} did not bring the painting back`);
      result('memory', began, problems, `restore ${one} gave the first drawing's boxes back after a scene dropped it; undo stepped back twice with no model; moon1 and tree of ${one} mixed into ${two}, moved and dropped; a procedural painting came back with restore and undo`);
    });
  } catch (error) {
    result('memory', began, [`stopped: ${error instanceof Error ? error.message : String(error)}`], '');
  }
  return scenes;
}

if (process.argv[1] !== undefined && /memory-check\.ts$/.test(process.argv[1])) {
  const at = process.argv.indexOf('--url');
  const url = at >= 0 ? process.argv[at + 1] : undefined;
  if (url === undefined) {
    process.stderr.write('usage: tsx memory-check.ts --url <server with BRAIN=replay>\n');
    process.exit(2);
  }
  void memoryGroup(url, MEMORY_SCREEN, '/tmp/memory-check', 90_000, (text) => process.stdout.write(`${text}\n`)).then((scenes) => {
    let failed = 0;
    for (const scene of scenes) for (const r of scene.results) {
      process.stdout.write(`${r.verdict} ${scene.name} ${r.check}: ${r.detail}\n`);
      if (r.verdict === 'FAIL') failed += 1;
    }
    process.exit(failed === 0 ? 0 : 1);
  });
}
