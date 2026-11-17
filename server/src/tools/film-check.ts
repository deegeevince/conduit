// pnpm check's film group (no model): the film export as the session ran, made headless.
//
//   typing     the input box's words grow a letter at a time, to the whole prompt, in the sampled frames; and in the real frames of the exported file the box's ink grows
//   panel      the lit row of the language panel is inside the panel's box in every sampled frame, on a wide and a narrow picture, the panel really scrolled, and it came back up to a line still being drawn
//   notes      no row of the panel reads "repaired:" or "dropped:" though the log holds such notes
//   cuts       a wait longer than 4 s is cut to 1.2 s with a "⏩ 19 s" marker; the cuts JSON the exporter returns is the gaps of the session (worked out from the recordings), and the film is that much shorter
//   controls   a control the viewer had left moved is at its written value the first time it is on stage, still there before an act turn, and at the act's value from that turn
//   follow     while a line is drawn the framing has its element inside the centre two thirds of the view (zoom 1 to 1.6), and the stage is whole while waiting and at rest
//
// The video request's options (the reel's), each judged on the film the request makes and in real frames of an exported file:
//   cards      `cards: false` leaves out the title card of each turn of a conversation; left alone, every turn has one
//   surround   `surround: { pane, prompt }`: each part is in or out of the picture, the stage takes the room, with both out it is the whole picture
//   captions   a caption for a turn fades in 0.3 s after the turn starts and out at its end, at the stage's bottom left, 34 and 22 px at 1920x1080, in the look's colours (paper and night)
//   tag        a tag at the stage's top right in every frame, and none unless asked
//   drag       `drag: true`: a slider the session recorded moved is dragged to its new value over 1.1 s, the bound picture following, and ends where the jump would have put it
//
// The bench half is `web/src/bench/film-bench.ts` (no browser); the exporter half runs the real exporter in headless Chrome on the dev server (WebCodecs), and writes stills.
// Standalone proof: `tsx film-check.ts --proof <dir>` exports the whole session as a film and writes stills and the cuts JSON beside it.

import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnTracked } from '../brains/claude-cli/process';
import { claimPort, releasePort } from './check-ports';
import { CHROME_CANDIDATES, Cdp, chromeFlags, repoRoot, stop, waitFor } from './explore-browser';
import type { CheckResult } from './smoke';

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
interface Scene {
  readonly panel: Box;
  readonly rows: readonly { readonly text: string; readonly top: number; readonly bottom: number; readonly lit: boolean; readonly width: number; readonly lines: number }[];
  readonly lit: { readonly top: number; readonly bottom: number } | null;
  readonly input: { readonly box: Box; readonly text: string; readonly sending: boolean };
  readonly marker: string | null;
}
interface Framing {
  readonly zoom: number;
  readonly x: number;
  readonly y: number;
}
interface Bench {
  /** only the first run has them: what each option of the video request does to the made-up session */
  readonly options?: OptionsData;
  readonly screen: string;
  readonly realDuration: number;
  readonly filmDuration: number;
  readonly cutList: { readonly threshold: number; readonly keep: number; readonly realSeconds: number; readonly filmSeconds: number; readonly cuts: readonly { readonly from: number; readonly to: number; readonly removed: number }[] };
  readonly gaps: readonly { readonly turn: string; readonly quietFrom: number; readonly quietTo: number }[];
  readonly notes: number;
  readonly samples: readonly { readonly at: number; readonly real: number; readonly scene: Scene }[];
  readonly height: Record<'first' | 'beforeAct' | 'inAct', { readonly at: number; readonly value: unknown }>;
  readonly follow: {
    readonly probes: readonly { readonly id: string; readonly real: number; readonly framing: Framing; readonly box: Box; readonly stage: { readonly width: number; readonly height: number } }[];
    readonly rest: { readonly framing: Framing };
    readonly waiting: { readonly framing: Framing };
  };
}

interface CardsRun {
  readonly turns: number;
  readonly parts: number;
  readonly cardParts: number;
  readonly duration: number;
  readonly cardFrames: number;
}
interface SurroundRun {
  readonly screen: string;
  readonly pane: boolean;
  readonly prompt: boolean;
  readonly width: number;
  readonly height: number;
  readonly layout: { readonly stage: Box; readonly pane: Box; readonly bar: Box };
  readonly stageOfFilm: Box;
  readonly typing: Scene;
  readonly rowsAt: number;
  readonly rows: Scene | null;
}
interface LabelSample {
  readonly at: number;
  readonly caption: { readonly name: string; readonly caption: string; readonly alpha: number; readonly box: Box; readonly sizes: { readonly name: number; readonly words: number } } | null;
  readonly tag: { readonly text: string; readonly box: Box; readonly size: number } | null;
}
interface LabelRun {
  readonly look: string;
  readonly width: number;
  readonly height: number;
  readonly stage: Box;
  readonly turns: readonly { readonly turn: string; readonly from: number; readonly to: number }[];
  readonly duration: number;
  readonly samples: readonly LabelSample[];
  readonly colours: { readonly ground: string; readonly name: number; readonly words: number; readonly tag: number; readonly roleGround: string } | null;
}
interface DragSample {
  readonly at: number;
  readonly value: unknown;
  readonly sun: { readonly x: number; readonly y: number } | null;
  readonly shadow: number | null;
}
interface DragRun {
  readonly drag: boolean;
  readonly duration: number;
  readonly lead: { readonly from: number; readonly acting: number; readonly waiting: number; readonly drag: number };
  readonly turnFrom: number;
  /** where the drag begins on the cut film's clock, which the exporter's `from` is on */
  readonly cutFrom: number;
  readonly samples: readonly DragSample[];
  readonly rippleAt: number | null;
  readonly control: Box | null;
  /** where the sun stands when the drag begins (stage pixels): the room it leaves, in the file, is the picture following the knob */
  readonly sunBox: Box | null;
  /** where the picture stands when the first turn's own film is made with the slider at 60 */
  readonly held60: { readonly sun: { readonly x: number; readonly y: number } | null; readonly shadow: number | null };
  readonly stage: Box;
}
interface OptionsData {
  readonly cards: { readonly off: CardsRun; readonly default: CardsRun; readonly on: CardsRun };
  readonly surround: readonly SurroundRun[];
  readonly labels: readonly LabelRun[];
  /** frames of a film with no captions and no tag that have either */
  readonly unlabelled: number;
  readonly drag: { readonly on: DragRun | null; readonly off: DragRun | null; readonly seconds: number };
}

const CAPTIONS: Record<string, { name: string; caption: string }> = {
  t1: { name: 'Type a question', caption: 'Write what you want to know. The answer is drawn in front of you.' },
  t3: { name: 'Tap an answer', caption: 'Tap a choice on the canvas and it becomes your next question.' },
};
const TAG = 'Scripted tour, no model';

const PROMPT = 'show me how the sun and a post make a shadow';
const result = (check: string, problems: readonly string[], good: string): CheckResult => ({ turn: 0, check, verdict: problems.length === 0 ? 'PASS' : 'FAIL', detail: problems.length === 0 ? good : problems.slice(0, 6).join(' | ') });

async function bench(): Promise<Bench[]> {
  const child = spawnTracked('pnpm', ['--filter', '@conduit/language', 'exec', 'tsx', '--import', '../web/src/bench/node-register.mjs', '../web/src/bench/film-bench.ts'], undefined, { cwd: repoRoot(), quiet: false });
  let out = '';
  let err = '';
  child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (err += chunk.toString()));
  const code = await new Promise<number | null>((done) => child.once('close', done));
  if (code !== 0) throw new Error(`the film bench stopped (${code}): ${err.slice(-600)}`);
  return JSON.parse(out.slice(out.indexOf('['))) as Bench[];
}

/** what the sampled frames say, judged. Exported so a scratch break of any part can be seen to fail. */
export function judge(runs: readonly Bench[]): CheckResult[] {
  const results: CheckResult[] = [];
  const typing: string[] = [];
  const panel: string[] = [];
  const notes: string[] = [];
  const cuts: string[] = [];
  const controls: string[] = [];
  const follow: string[] = [];
  for (const run of runs) {
    const where = run.screen;
    // typing: every shown text is a prefix of the prompt, never shrinks while the prompt is typed, and ends as the whole prompt
    const texts = run.samples.map((sample) => sample.scene.input.text);
    const first = texts.findIndex((text) => text !== '');
    if (first < 0) typing.push(`${where}: nothing is ever typed into the input box`);
    else {
      const upTo = texts.findIndex((text, index) => index > first && text === PROMPT);
      const typed = texts.slice(first, upTo < 0 ? texts.length : upTo + 1);
      for (let i = 1; i < typed.length; i += 1) if ((typed[i] ?? '').length < (typed[i - 1] ?? '').length) typing.push(`${where}: the typed words shrank from ${JSON.stringify(typed[i - 1])} to ${JSON.stringify(typed[i])}`);
      if (typed.some((text) => !PROMPT.startsWith(text))) typing.push(`${where}: the box shows words that are not the start of the prompt`);
      if (new Set(typed).size < 20) typing.push(`${where}: only ${new Set(typed).size} different texts were typed (a prompt of ${PROMPT.length} letters at 14 a second is typed one at a time)`);
      if (upTo < 0) typing.push(`${where}: the whole prompt never appears`);
      const gap = (texts.slice(first).findIndex((text) => text === PROMPT) / 10) / (PROMPT.length / 14);
      if (!(gap > 0.8 && gap < 1.5)) typing.push(`${where}: the prompt took ${(gap * (PROMPT.length / 14)).toFixed(1)} s to type, not about ${(PROMPT.length / 14).toFixed(1)} s`);
    }
    // panel: the lit row inside the panel's window in every frame, the panel scrolled, and came back to the line still being drawn
    let lit = 0;
    let scrolled = false;
    let back = false;
    let sawCircle = false;
    for (const sample of run.samples) {
      const { scene } = sample;
      if (scene.lit !== null) {
        lit += 1;
        if (scene.lit.top < scene.panel.y - 0.5 || scene.lit.bottom > scene.panel.y + scene.panel.height + 0.5) panel.push(`${where}: at ${sample.at} s the lit row is out of the panel (${Math.round(scene.lit.top)}-${Math.round(scene.lit.bottom)} in ${Math.round(scene.panel.y)}-${Math.round(scene.panel.y + scene.panel.height)})`);
        const row = scene.rows.find((candidate) => candidate.lit);
        if (row?.text.startsWith('circle c') === true) sawCircle = true;
        if (row?.text.startsWith('move b1') === true && sawCircle) back = true;
      }
      if (scene.rows.some((row) => row.top < scene.panel.y - 1 && row.bottom > scene.panel.y - 1)) scrolled = true;
      for (const row of scene.rows) if (/repaired:|dropped:/.test(row.text)) notes.push(`${where}: a row reads ${JSON.stringify(row.text)}`);
    }
    if (lit < 100) panel.push(`${where}: a line was lit in only ${lit} frames`);
    if (run.screen.startsWith('390') && !scrolled) panel.push(`${where}: the panel never scrolled (the check proves nothing)`);
    if (!back) panel.push(`${where}: the panel never came back up to a line that was still being drawn`);
    if (run.notes < 2) notes.push(`${where}: the log holds only ${run.notes} notes, so the check proves nothing`);
    // cuts: from the gaps of the session
    const expected = run.gaps.filter((gap) => gap.quietTo - gap.quietFrom > run.cutList.threshold);
    if (run.cutList.cuts.length !== expected.length) cuts.push(`${where}: ${run.cutList.cuts.length} cuts for ${expected.length} waits longer than ${run.cutList.threshold} s`);
    expected.forEach((gap, index) => {
      const cut = run.cutList.cuts[index];
      if (cut === undefined) return;
      const keepEnds = gap.quietFrom + run.cutList.keep;
      if (Math.abs(cut.from - keepEnds) > 0.05 || Math.abs(cut.to - gap.quietTo) > 0.05) cuts.push(`${where}: the cut is ${cut.from}-${cut.to}, the wait is ${keepEnds.toFixed(2)}-${gap.quietTo.toFixed(2)}`);
      if (Math.abs(cut.removed - (cut.to - cut.from)) > 0.01) cuts.push(`${where}: the cut says ${cut.removed} s removed of ${(cut.to - cut.from).toFixed(2)}`);
      const marked = run.samples.filter((sample) => sample.scene.marker === `⏩ ${Math.round(cut.removed)} s`);
      if (marked.length < 8 || marked.length > 14) cuts.push(`${where}: the marker "⏩ ${Math.round(cut.removed)} s" is on in ${marked.length} frames, not for about 1.2 s`);
    });
    const removed = run.cutList.cuts.reduce((sum, cut) => sum + cut.removed, 0);
    if (Math.abs(run.realDuration - removed - run.filmDuration) > 0.01) cuts.push(`${where}: ${run.realDuration.toFixed(2)} s less ${removed.toFixed(2)} s is not ${run.filmDuration.toFixed(2)} s`);
    // controls
    if (run.height.first.value !== 20) controls.push(`${where}: the slider first shows ${String(run.height.first.value)}, not its written 20 (the viewer had left it at 70)`);
    if (run.height.beforeAct.value !== 20) controls.push(`${where}: before the act turn the slider shows ${String(run.height.beforeAct.value)}`);
    if (run.height.inAct.value !== 60) controls.push(`${where}: in the act turn the slider shows ${String(run.height.inAct.value)}, not the 60 it was used at`);
    // follow
    let zoomed = 0;
    for (const probe of run.follow.probes) {
      const { framing, box, stage } = probe;
      if (framing.zoom < 1 - 1e-6 || framing.zoom > 1.6 + 1e-6) follow.push(`${where}: zoom ${framing.zoom} is outside 1 to 1.6`);
      if (framing.zoom > 1.2) zoomed += 1;
      const u = ((box.x + box.width / 2) / stage.width - framing.x) * framing.zoom + 0.5;
      const v = ((box.y + box.height / 2) / stage.height - framing.y) * framing.zoom + 0.5;
      // the view stays inside the stage (no blank margin): its middle is at least half a view from every edge
      if (framing.x < 0.5 / framing.zoom - 1e-6 || framing.x > 1 - 0.5 / framing.zoom + 1e-6 || framing.y < 0.5 / framing.zoom - 1e-6 || framing.y > 1 - 0.5 / framing.zoom + 1e-6) follow.push(`${where}: the view of ${probe.id} leaves the stage (zoom ${framing.zoom.toFixed(2)} at ${framing.x.toFixed(2)},${framing.y.toFixed(2)})`);
      // the element is in the middle two thirds of the view, or, where the view is held at the stage's edge, at least in the view on the side of that edge
      const heldX = framing.x <= 0.5 / framing.zoom + 1e-6 || framing.x >= 1 - 0.5 / framing.zoom - 1e-6;
      const heldY = framing.y <= 0.5 / framing.zoom + 1e-6 || framing.y >= 1 - 0.5 / framing.zoom - 1e-6;
      const fits = (at: number, held: boolean): boolean => (held ? at >= 0 && at <= 1 : at >= 1 / 6 && at <= 5 / 6);
      if (!fits(u, heldX) || !fits(v, heldY)) follow.push(`${where}: ${probe.id} sits at ${u.toFixed(2)},${v.toFixed(2)} of the view while it is drawn`);
    }
    if (zoomed < 1) follow.push(`${where}: no line was ever followed in close (the check proves nothing)`);
    if (run.follow.rest.framing.zoom > 1.001) follow.push(`${where}: the film ends at zoom ${run.follow.rest.framing.zoom.toFixed(2)}, not on the whole stage`);
    if (run.follow.waiting.framing.zoom > 1.001) follow.push(`${where}: the stage is zoomed ${run.follow.waiting.framing.zoom.toFixed(2)} while the film waits`);
  }
  results.push(result('film-typing', typing, `the prompt is typed into the input box a letter at a time at 14 a second (${runs.length} pictures)`));
  results.push(result('film-panel', panel, `the lit row stays inside the panel in every frame sampled (${runs.reduce((sum, run) => sum + run.samples.length, 0)}), the narrow panel scrolled, and came back up`));
  results.push(result('film-notes', notes, 'no row reads "repaired:" or "dropped:" though the log holds such notes'));
  results.push(result('film-cuts', cuts, 'the 20 s wait is cut to 1.2 s with its marker, and the cuts are the session\'s gaps'));
  results.push(result('film-controls', controls, 'the slider starts at its written value whatever the viewer left, and the act turn shows the value it was used at'));
  results.push(result('film-follow', follow, 'the element being drawn is in view (the middle two thirds, or held at the stage edge), the view never leaves the stage, zoom 1 to 1.6; the stage is whole while waiting and at rest'));
  return results;
}

/** The film's rows against the live pane's, by the row's first line: every row's text width within 5% (the live page is 1280 wide, so a CSS pixel is a picture pixel at 1280x720). Exported so a break can be seen to fail. */
export function judgeLook(wide: Bench, live: Live): CheckResult {
  const problems: string[] = [];
  const film = new Map<string, { width: number; lines: number }>();
  for (const sample of wide.samples) for (const row of sample.scene.rows) film.set((row.text.split('\n')[0] ?? '').trim(), { width: row.width, lines: row.lines });
  let compared = 0;
  let wrapped = 0;
  for (const row of live.rows) {
    const key = row.text.replace(/\s+/g, ' ').trim();
    const mine = [...film.entries()].find(([text]) => text.replace(/\s+/g, ' ').trim() === key);
    if (mine === undefined) continue;
    compared += 1;
    const ratio = mine[1].width / row.width;
    if (Math.abs(ratio - 1) > 0.05) problems.push(`${JSON.stringify(key.slice(0, 40))}: the film row is ${mine[1].width.toFixed(0)} px wide, the live row ${row.width.toFixed(0)} px (${((ratio - 1) * 100).toFixed(0)}%)`);
    if (mine[1].lines === row.lines) wrapped += 1;
  }
  if (compared < 15) problems.push(`only ${compared} rows could be compared`);
  if (compared > 0 && wrapped < compared * 0.9) problems.push(`only ${wrapped} of ${compared} rows wrap into as many rows as the live pane's`);
  if (!/JetBrains Mono/.test(live.font)) problems.push(`the live pane is set in ${live.font}, not the mono face`);
  return result('film-look', problems, `${compared} rows of the film's panel are as wide as the live pane's (within 5%) and wrap as it does (${wrapped} of ${compared}), in ${live.font.split(',')[0]} at ${live.size}`);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The request's options

/** What real frames of exported files say about the options: ink counts in regions the bench named, by probe. Probe times are on the file's own clock. */
export interface OptionsMade {
  /** the four exports of the surround, `pane` and `prompt` as asked: ink in the room the pane has, ink in the room the input box has, and how many pixels of the picture are still the black it is laid on */
  readonly surround: readonly { readonly pane: boolean; readonly prompt: boolean; readonly paneInk: number; readonly barInk: number; readonly blank: number }[];
  /** ink inside the caption's box and the tag's box at `LABEL_TIMES`: with captions and the tag asked, and with neither */
  readonly labelled: { readonly caption: readonly number[]; readonly tag: readonly number[] };
  readonly plain: { readonly caption: readonly number[]; readonly tag: readonly number[] };
  /** pixels that changed in the slider's box and in the room the sun starts in between the drag's moments (`DRAG_TIMES`), with the drag asked and without */
  readonly drag: { readonly on: { readonly knob: readonly number[]; readonly sun: readonly number[] }; readonly off: { readonly knob: readonly number[]; readonly sun: readonly number[] } };
}

/** where in the file (seconds) the labels are looked for: before the caption begins to come, when it is whole, and later while the turn still goes on */
const LABEL_TIMES = [0.1, 1.0, 3.8] as const;
/** where in the file the drag is looked at: the drag begins at the second; before it, early in it, late in it, after it */
const DRAG_LEAD = 0.4;
const DRAG_TIMES = [0.2, DRAG_LEAD + 0.45, DRAG_LEAD + 0.75, DRAG_LEAD + 1.25] as const;

const area = (box: Box): number => box.width * box.height;
const sameBox = (a: Box, b: Box): boolean => Math.abs(a.x - b.x) < 0.51 && Math.abs(a.y - b.y) < 0.51 && Math.abs(a.width - b.width) < 0.51 && Math.abs(a.height - b.height) < 0.51;
const luminance = (hex: string): number => {
  const channel = (at: number): number => {
    const v = parseInt(hex.slice(at, at + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
};

/** the film each option of the request makes, judged as data, and (when `made` is given) in real frames of exported files. Exported so a break of any option can be seen to fail. */
export function judgeOptions(data: OptionsData, made?: OptionsMade): CheckResult[] {
  const cards: string[] = [];
  const surround: string[] = [];
  const captions: string[] = [];
  const tag: string[] = [];
  const drag: string[] = [];

  // cards
  const { off, default: left, on } = data.cards;
  if (off.cardParts !== 0) cards.push(`cards: false still has ${off.cardParts} title cards`);
  if (off.cardFrames !== 0) cards.push(`cards: false still shows a title card in ${off.cardFrames} frames`);
  if (off.parts !== off.turns) cards.push(`cards: false has ${off.parts} parts for ${off.turns} turns`);
  for (const [name, run] of [['cards left alone', left], ['cards: true', on]] as const) {
    if (run.cardParts !== run.turns) cards.push(`${name}: ${run.cardParts} title cards for ${run.turns} turns`);
    if (run.cardFrames < 20) cards.push(`${name}: a title card is in only ${run.cardFrames} frames`);
    if (run.duration < off.duration + 2 * run.turns) cards.push(`${name}: ${run.duration.toFixed(1)} s is not at least 2 s a turn longer than the ${off.duration.toFixed(1)} s without cards`);
  }
  if (Math.abs(left.duration - on.duration) > 1e-6) cards.push('a conversation with cards left alone is not the one with cards: true');

  // surround
  for (const run of data.surround) {
    const where = `${run.screen} pane ${run.pane ? 'on' : 'off'}, prompt ${run.prompt ? 'on' : 'off'}`;
    const { stage, pane, bar } = run.layout;
    const picture = run.width * run.height;
    if (Math.abs(area(stage) + area(pane) + area(bar) - picture) > 1) surround.push(`${where}: the stage, the pane and the input box's strip come to ${Math.round(area(stage) + area(pane) + area(bar))} px of the picture's ${picture}`);
    if (!run.pane && area(pane) !== 0) surround.push(`${where}: the pane has room though it is out`);
    if (run.pane && area(pane) === 0) surround.push(`${where}: the pane has no room`);
    if (!run.prompt && area(bar) !== 0) surround.push(`${where}: the input box has room though it is out`);
    if (run.prompt && area(bar) === 0) surround.push(`${where}: the input box has no room`);
    if (!run.pane && !run.prompt && !sameBox(stage, { x: 0, y: 0, width: run.width, height: run.height })) surround.push(`${where}: with both out the stage is ${JSON.stringify(stage)}, not the whole picture`);
    if (!sameBox(run.stageOfFilm, stage)) surround.push(`${where}: the film puts the stage at ${JSON.stringify(run.stageOfFilm)}, not where the layout does`);
    if (!run.pane) {
      if (run.rowsAt >= 0) surround.push(`${where}: the pane's lines are in the picture at ${run.rowsAt} s though the pane is out`);
      if (area(run.typing.panel) !== 0) surround.push(`${where}: the pane has a window though it is out`);
    } else if (run.rowsAt < 0 || (run.rows?.rows.length ?? 0) < 3) surround.push(`${where}: the pane never shows its lines`);
    if (!run.prompt) {
      if (run.typing.input.text !== '' || area(run.typing.input.box) !== 0) surround.push(`${where}: the input box is in the picture though it is out (${JSON.stringify(run.typing.input.text)})`);
    } else if (run.typing.input.text.length < 8) surround.push(`${where}: nothing is typed into the input box at 2 s`);
  }
  if (made !== undefined) {
    for (const run of made.surround) {
      const where = `pane ${run.pane ? 'on' : 'off'}, prompt ${run.prompt ? 'on' : 'off'}`;
      if (run.pane && run.paneInk < 150) surround.push(`${where}: only ${run.paneInk} pixels of ink in the pane's room in the file (the pane is on)`);
      if (!run.pane && run.paneInk > 10) surround.push(`${where}: ${run.paneInk} pixels of ink in the pane's room in the file (the pane is out)`);
      if (run.prompt && run.barInk < 150) surround.push(`${where}: only ${run.barInk} pixels of ink in the input box's room in the file (the box is on)`);
      if (!run.prompt && run.barInk > 10) surround.push(`${where}: ${run.barInk} pixels of ink in the input box's room in the file (the box is out)`);
      if (run.blank !== 0) surround.push(`${where}: ${run.blank} pixels of the picture are black in the file, so the stage, the pane and the input box do not cover it`);
    }
    if (made.surround.length < 4) surround.push(`only ${made.surround.length} of the 4 exports were made`);
  }

  // captions and the tag
  for (const run of data.labels) {
    const where = `${run.look} ${run.width}x${run.height}`;
    const tall = run.height > run.width;
    const at = (t: number): LabelSample | undefined => run.samples.find((sample) => Math.abs(sample.at - t) < 0.026);
    for (const span of run.turns) {
      const entry = CAPTIONS[span.turn];
      const inside = run.samples.filter((sample) => sample.at >= span.from && sample.at < span.to - 1e-6);
      if (entry === undefined) {
        const shown = inside.filter((sample) => sample.caption !== null).length;
        if (shown > 0) captions.push(`${where}: ${span.turn} has no caption but one is shown in ${shown} frames`);
        continue;
      }
      // not yet: nothing until 0.3 s after the turn starts
      const early = inside.filter((sample) => sample.at < span.from + 0.3 - 0.026 && sample.caption !== null).length;
      if (early > 0) captions.push(`${where}: ${span.turn}'s caption is shown in ${early} frames before it is 0.3 s into the turn`);
      // coming in over 0.3 s, whole after, going out over the 0.3 s before the end
      const rising = inside.filter((sample) => sample.at >= span.from + 0.3 && sample.at < span.from + 0.6).map((sample) => sample.caption?.alpha ?? 0);
      if (rising.length < 4 || rising.some((alpha, index) => index > 0 && alpha < (rising[index - 1] ?? 0) - 1e-9) || rising.filter((alpha) => alpha > 0.02 && alpha < 0.98).length < 3) captions.push(`${where}: ${span.turn}'s caption does not fade in over the 0.3 s after its first 0.3 s (${rising.map((alpha) => alpha.toFixed(2)).join(' ')})`);
      const whole = inside.filter((sample) => sample.at >= span.from + 0.6 + 0.026 && sample.at < span.to - 0.3 - 0.026);
      if (whole.length < 5) captions.push(`${where}: ${span.turn} is too short (${whole.length} frames) to check its caption`);
      const stage = run.stage;
      for (const sample of whole) {
        const caption = sample.caption;
        if (caption === null || caption.alpha < 0.999) {
          captions.push(`${where}: ${span.turn}'s caption is at ${caption?.alpha.toFixed(2) ?? 'nothing'} at ${sample.at} s, not whole`);
          break;
        }
        if (caption.name !== entry.name || caption.caption !== entry.caption) {
          captions.push(`${where}: ${span.turn}'s caption says ${JSON.stringify(caption.name)} / ${JSON.stringify(caption.caption)} at ${sample.at} s`);
          break;
        }
        const box = caption.box;
        if (box.x < stage.x - 0.5 || box.x + box.width > stage.x + stage.width + 0.5 || box.y < stage.y - 0.5 || box.y + box.height > stage.y + stage.height + 0.5) {
          captions.push(`${where}: ${span.turn}'s caption (${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)}) is not inside the stage`);
          break;
        }
        if (box.x - stage.x > 0.12 * stage.width || box.y + box.height < stage.y + 0.8 * stage.height) {
          captions.push(`${where}: ${span.turn}'s caption is not at the stage's bottom left (${Math.round(box.x - stage.x)} from its left, ${Math.round(stage.y + stage.height - box.y - box.height)} up from its foot)`);
          break;
        }
        if (!tall && box.x + box.width > stage.x + stage.width * 0.5) {
          captions.push(`${where}: ${span.turn}'s caption reaches past the middle of the stage (the cut marker stands there)`);
          break;
        }
      }
      const falling = inside.filter((sample) => sample.at >= span.to - 0.3 && sample.at < span.to).map((sample) => sample.caption?.alpha ?? 0);
      if (falling.length < 4 || falling.some((alpha, index) => index > 0 && alpha > (falling[index - 1] ?? 0) + 1e-9) || falling.filter((alpha) => alpha > 0.02 && alpha < 0.98).length < 3 || (falling[falling.length - 1] ?? 1) > 0.25) captions.push(`${where}: ${span.turn}'s caption does not fade out over the 0.3 s before the turn ends (${falling.map((alpha) => alpha.toFixed(2)).join(' ')})`);
      // the sizes: 34 and 22 px at 1920x1080, scaled with the width at others
      const sizes = whole[0]?.caption?.sizes;
      if (sizes !== undefined && !tall) {
        const scale = run.width / 1920;
        if (Math.abs(sizes.name - 34 * scale) > 0.01 || Math.abs(sizes.words - 22 * scale) > 0.01) captions.push(`${where}: the caption is set at ${sizes.name.toFixed(1)} / ${sizes.words.toFixed(1)} px, not ${(34 * scale).toFixed(1)} / ${(22 * scale).toFixed(1)}`);
      }
      if (sizes !== undefined && tall && (sizes.name < 12 || sizes.words < 9 || sizes.name <= sizes.words)) captions.push(`${where}: the caption is set at ${sizes.name.toFixed(1)} / ${sizes.words.toFixed(1)} px on a tall picture`);
    }
    // the tag: in every frame, the same words, at the stage's top right
    const without = run.samples.filter((sample) => sample.tag === null).length;
    if (without > 0) tag.push(`${where}: the tag is missing from ${without} of ${run.samples.length} frames`);
    const wrong = run.samples.find((sample) => sample.tag !== null && sample.tag.text !== TAG);
    if (wrong !== undefined) tag.push(`${where}: the tag says ${JSON.stringify(wrong.tag?.text)}`);
    const first = at(1.0)?.tag;
    if (first === undefined || first === null) tag.push(`${where}: no tag at 1 s`);
    else {
      const stage = run.stage;
      const box = first.box;
      if (box.x + box.width > stage.x + stage.width + 0.5 || box.x < stage.x + stage.width / 2 || box.y < stage.y - 0.5 || box.y - stage.y > 0.1 * stage.height) tag.push(`${where}: the tag (${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)}) is not at the stage's top right`);
      if (first.size < 10.9) tag.push(`${where}: the tag is set at ${first.size.toFixed(1)} px`);
    }
    // the look's tokens: held to 4.5:1 on the look's ground, the ground the look's own (light on paper, dark at night)
    const colours = run.colours;
    if (colours === null) captions.push(`${where}: the caption's colours are not in the picture at the moment they were looked for`);
    else {
      if (colours.name < 4.5 || colours.words < 4.5) captions.push(`${where}: the caption reads at ${colours.name.toFixed(1)}:1 (the name) and ${colours.words.toFixed(1)}:1 (the words), under 4.5:1`);
      if (colours.tag < 4.5) tag.push(`${where}: the tag reads at ${colours.tag.toFixed(1)}:1, under 4.5:1`);
      const lum = luminance(colours.ground);
      if (run.look === 'paper' && lum < 0.6) captions.push(`${where}: the caption's ground ${colours.ground} is not light on the paper look`);
      if (run.look === 'night' && lum > 0.3) captions.push(`${where}: the caption's ground ${colours.ground} is not dark on the night look`);
      if (Math.abs(lum - luminance(colours.roleGround)) > 0.12) captions.push(`${where}: the caption's ground ${colours.ground} is not near the look's own ground ${colours.roleGround}`);
    }
  }
  if (!data.labels.some((run) => run.look === 'paper') || !data.labels.some((run) => run.look === 'night')) captions.push('the paper and night looks were not both looked at');
  if (data.unlabelled !== 0) tag.push(`with no captions and no tag asked, ${data.unlabelled} frames have one`);
  if (made !== undefined) {
    const [early, inside, late] = made.labelled.caption;
    if (early === undefined || inside === undefined || late === undefined || early > 20 || inside < 200 || late < 200) captions.push(`ink in the caption's box in the file at ${LABEL_TIMES.join(', ')} s is ${made.labelled.caption.join(', ')}, not (none, then some, then some)`);
    if (made.plain.caption.some((ink) => ink > 20)) captions.push(`ink in the caption's box with no captions asked is ${made.plain.caption.join(', ')}`);
    if (made.labelled.tag.length < LABEL_TIMES.length || made.labelled.tag.some((ink) => ink < 30)) tag.push(`ink in the tag's box in the file at ${LABEL_TIMES.join(', ')} s is ${made.labelled.tag.join(', ')}, not some in every frame`);
    if (made.plain.tag.some((ink) => ink > 5)) tag.push(`ink in the tag's box with no tag asked is ${made.plain.tag.join(', ')}`);
  }

  // drag
  const { on: dragged, off: jumped, seconds } = data.drag;
  if (dragged === null || jumped === null) drag.push('the made-up session has no turn that carries a slider');
  else {
    if (Math.abs(dragged.lead.drag - seconds) > 1e-9) drag.push(`the drag takes ${dragged.lead.drag} s of the lead, not ${seconds}`);
    if (jumped.lead.drag !== 0) drag.push(`without the drag the lead still has ${jumped.lead.drag} s of it`);
    if (Math.abs(dragged.duration - jumped.duration - seconds) > 0.01) drag.push(`the film is ${(dragged.duration - jumped.duration).toFixed(2)} s longer with the drag, not ${seconds} s`);
    const begin = dragged.lead.from;
    const inDrag = dragged.samples.filter((sample) => sample.at >= begin - 0.001 && sample.at < begin + seconds - 0.001);
    const values = inDrag.map((sample) => Number(sample.value));
    if (values[0] !== 20) drag.push(`the drag starts at ${String(values[0])}, not the 20 the slider stood at`);
    if (values.some((value, index) => index > 0 && value < (values[index - 1] ?? 0))) drag.push(`the knob goes back during the drag (${values.join(' ')})`);
    const between = new Set(values.filter((value) => value > 20 && value < 60));
    if (between.size < 12) drag.push(`the knob takes only ${between.size} values between 20 and 60 over the drag (${values.join(' ')})`);
    const after = dragged.samples.filter((sample) => sample.at >= begin + seconds + 0.026 && sample.at < dragged.turnFrom + 0.4).map((sample) => Number(sample.value));
    if (after.length < 10 || after.some((value) => value !== 60)) drag.push(`after the drag the slider is not held at 60 until the turn begins (${[...new Set(after)].join(' ')})`);
    // eased: slow at the start and the end of the drag, quick in the middle
    const stepAt = (from: number): number => Number(inDrag.find((sample) => Math.abs(sample.at - (begin + from)) < 0.026)?.value);
    const first = stepAt(0.15) - stepAt(0);
    const middle = stepAt(seconds / 2 + 0.075) - stepAt(seconds / 2 - 0.075);
    if (!(first >= 0 && first < 6 && middle > 12)) drag.push(`the drag is not eased: the knob moves ${first} in the first 0.15 s and ${middle} in the middle 0.15 s`);
    // the bound picture follows the knob, and ends where the jump would have put it
    const suns = inDrag.map((sample) => sample.sun?.x ?? Number.NaN);
    const shadows = inDrag.map((sample) => sample.shadow ?? Number.NaN);
    for (const [name, series] of [['sun', suns], ['shadow', shadows]] as const) {
      if (series.some((value) => Number.isNaN(value))) drag.push(`the ${name} is not on stage during the drag`);
      else {
        const sign = Math.sign((series[series.length - 1] ?? 0) - (series[0] ?? 0));
        if (sign === 0 || series.some((value, index) => index > 0 && Math.sign(value - (series[index - 1] ?? 0)) * sign < 0)) drag.push(`the ${name} does not follow the knob one way (${series.map((value) => Math.round(value)).join(' ')})`);
        if (new Set(series.map((value) => Math.round(value))).size < 10) drag.push(`the ${name} takes only ${new Set(series.map((value) => Math.round(value))).size} places over the drag`);
      }
    }
    const landed = dragged.samples.find((sample) => sample.at >= begin + seconds + 0.026);
    const held = dragged.held60;
    if (landed === undefined || held.sun === null || held.shadow === null || landed.sun === null || landed.shadow === null || Math.abs(landed.sun.x - held.sun.x) > 1 || Math.abs(landed.sun.y - held.sun.y) > 1 || Math.abs(landed.shadow - held.shadow) > 1) drag.push(`the picture at the end of the drag (sun ${JSON.stringify(landed?.sun)}, shadow ${landed?.shadow}) is not where the slider held at 60 puts it (${JSON.stringify(held.sun)}, ${held.shadow})`);
    // without the drag the knob stands at 20 until the turn begins and is at 60 from then: nothing in between
    const jumps = new Set(jumped.samples.map((sample) => Number(sample.value)));
    if ([...jumps].some((value) => value !== 20 && value !== 60)) drag.push(`without the drag the knob takes values other than 20 and 60 (${[...jumps].join(' ')})`);
    const early = jumped.samples.filter((sample) => sample.at < jumped.turnFrom - 0.05).map((sample) => Number(sample.value));
    if (early.some((value) => value !== 20)) drag.push('without the drag the slider is not at 20 until the turn begins');
    // the tap comes after the drag
    if (dragged.rippleAt === null || dragged.rippleAt < begin + seconds + 0.05) drag.push(`the tap's ripple begins at ${String(dragged.rippleAt)} s, before the drag is over at ${(begin + seconds).toFixed(2)} s`);
    if (jumped.rippleAt === null || jumped.rippleAt > jumped.lead.from + 0.25) drag.push(`without the drag the tap's ripple begins at ${String(jumped.rippleAt)} s, not at the lead's start ${jumped.lead.from.toFixed(2)} s`);
  }
  if (made !== undefined) {
    const [a, b, c] = made.drag.on.knob;
    if (a === undefined || b === undefined || c === undefined || a < 40 || b < 40 || c < 40) drag.push(`in the file the knob's box changes by ${made.drag.on.knob.join(', ')} pixels between the moments of the drag (it moves at each)`);
    const [d] = made.drag.on.sun;
    if (d === undefined || d < 100) drag.push(`in the file the room the sun starts in changes by ${d} pixels over the drag (the picture follows the knob, and the sun leaves it)`);
    const [f, g] = made.drag.off.knob;
    if (f === undefined || g === undefined || f > 8 || g > 8) drag.push(`without the drag the knob's box changes by ${made.drag.off.knob.join(', ')} pixels before the turn begins`);
    const [h] = made.drag.off.sun;
    if (h === undefined || h > 8) drag.push(`without the drag the sun's room changes by ${h} pixels before the turn begins`);
  }

  return [
    result('film-cards', cards, `\`cards: false\` leaves ${data.cards.off.turns} turns with no title card (${data.cards.off.duration.toFixed(1)} s); left alone each has one (${data.cards.default.duration.toFixed(1)} s)`),
    result('film-surround', surround, `the pane and the input box are each in or out of the picture at ${new Set(data.surround.map((run) => run.screen)).size} sizes; with both out the stage is the whole picture${made === undefined ? '' : ', and so in the file (no ink where they would be, no black left over)'}`),
    result('film-captions', captions, `a caption fades in 0.3 s after its turn starts and out over the 0.3 s before it ends, at the stage's bottom left, 34 and 22 px at 1920x1080, readable (4.5:1) on paper and night at ${new Set(data.labels.map((run) => `${run.width}x${run.height}`)).size} sizes${made === undefined ? '' : ', and in the file'}`),
    result('film-tag', tag, `the tag stands at the stage's top right in every frame (${data.labels.reduce((sum, run) => sum + run.samples.length, 0)} sampled), readable on paper and night, and a film that asked for none has none${made === undefined ? '' : '; in the file too'}`),
    result('film-drag', drag, `the slider is dragged from 20 to 60 over ${seconds} s with ${new Set(data.drag.on?.samples.map((sample) => sample.value)).size - 1} values on the way, the sun and the shadow follow, the picture ends where the slider held at 60 puts it${made === undefined ? '' : ', and in the file the knob and the sun move; without the drag they do not'}`),
  ];
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The exporter, in a real browser

interface Made {
  /** the pane's mono face is in the page's font set and loaded when the film is drawn */
  readonly monoLoaded: boolean;
  readonly cuts: { readonly cuts: readonly { readonly from: number; readonly to: number; readonly removed: number }[]; readonly filmSeconds: number } | null;
  readonly seconds: number;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly inks: readonly number[];
  readonly dark: readonly number[];
  readonly regions: readonly number[];
  readonly changes: readonly number[];
  readonly blank: number | null;
  readonly stills: readonly { readonly name: string; readonly png: string }[];
  readonly webm: string | null;
}

const PAGE_SCRIPT = String.raw`async (job) => {
  const [{ buildSession }, { createExporter }, { createPlainRenderer }, { canUseThree, createThreeRenderer }, { ensureMono }] = await Promise.all([
    import('/src/bench/film-session.ts'), import('/src/export/index.ts'), import('/src/render/plain/index.ts'), import('/src/render/three/index.ts'), import('/src/app/lang-style.ts'),
  ]);
  await ensureMono();
  const monoLoaded = [...document.fonts].some((face) => face.family.replace(/["']/g, '') === 'Conduit JetBrains Mono 400' && face.status === 'loaded');
  const session = buildSession(job.width, job.height, job.explorable, { height: 70 }, job.session || undefined, job.look || undefined);
  const exporter = createExporter({ createRenderer: () => (canUseThree() ? createThreeRenderer() : createPlainRenderer()) });
  const formats = await exporter.formats();
  if (!formats.video.includes('webm')) throw new Error('this browser cannot encode WebM');
  const request = { kind: 'video', format: 'webm', width: job.width, height: job.height, fps: job.fps, scope: 'conversation', ...(job.session || {}), from: job.from || 0, ...(job.to === null ? {} : { to: job.to }) };
  const made = await exporter.start(session.film, request).done;
  exporter.dispose();
  const url = URL.createObjectURL(made.blob);
  const video = document.createElement('video');
  video.muted = true; video.src = url; video.preload = 'auto';
  await new Promise((done, fail) => { video.onloadeddata = done; video.onerror = () => fail(new Error('the exported film does not play')); });
  const canvas = document.createElement('canvas');
  canvas.width = job.width; canvas.height = job.height;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  const seek = (t) => new Promise((done) => { video.onseeked = () => done(); video.currentTime = Math.min(t, Math.max(0, video.duration - 0.05)); });
  const frameAt = async (t) => { await seek(t); await new Promise((done) => setTimeout(done, 80)); g.drawImage(video, 0, 0, job.width, job.height); };
  const base64Of = (blob) => new Promise((done) => { const r = new FileReader(); r.onload = () => done(String(r.result).split(',')[1] || ''); r.readAsDataURL(blob); });
  const scene = session.film.surround;
  // the box's ink: pixels in the words' room that differ from the box's own ground
  const inkAt = async (t) => {
    await frameAt(t);
    const box = job.box;
    const x = Math.round(box.x + box.height * 1.15), w = Math.round(box.width - box.height * 2.4), y = Math.round(box.y + 4), h = Math.round(box.height - 8);
    const data = g.getImageData(x, y, w, h).data;
    const bg = [data[0], data[1], data[2]];
    let n = 0;
    for (let i = 0; i < data.length; i += 4) if (Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]) > 150) n += 1;
    return n;
  };
  // the stage's lower middle (above the input box) against how it was at the first time: a marker's pill is what differs
  let still = null;
  const darkAt = async (t) => {
    await frameAt(t);
    const x = Math.round(job.width * 0.45), y = Math.round(job.height * 0.55), w = Math.round(job.width * 0.45), h = Math.round(job.height * 0.3);
    const data = g.getImageData(x, y, w, h).data;
    if (still === null) { still = data; return 0; }
    let n = 0;
    for (let i = 0; i < data.length; i += 4) if (Math.abs(data[i] - still[i]) + Math.abs(data[i + 1] - still[i + 1]) + Math.abs(data[i + 2] - still[i + 2]) > 100) n += 1;
    return n;
  };
  // ink in a region at a time: pixels that differ from the region's own first pixel; and how much of a region changed between two times
  const inkIn = async (r) => {
    await frameAt(r.t);
    const data = g.getImageData(Math.round(r.x) + 1, Math.round(r.y) + 1, Math.max(1, Math.round(r.w) - 2), Math.max(1, Math.round(r.h) - 2)).data;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) if (Math.abs(data[i] - data[0]) + Math.abs(data[i + 1] - data[1]) + Math.abs(data[i + 2] - data[2]) > 150) n += 1;
    return n;
  };
  const changedIn = async (r) => {
    const box = [Math.round(r.x), Math.round(r.y), Math.max(1, Math.round(r.w)), Math.max(1, Math.round(r.h))];
    await frameAt(r.a); const before = g.getImageData(...box).data;
    await frameAt(r.b); const after = g.getImageData(...box).data;
    let n = 0;
    for (let i = 0; i < before.length; i += 4) if (Math.abs(before[i] - after[i]) + Math.abs(before[i + 1] - after[i + 1]) + Math.abs(before[i + 2] - after[i + 2]) > 60) n += 1;
    return n;
  };
  // how much of the picture is the black the exporter lays it on: none of it when the stage, the pane and the input box between them cover it
  const spreadAt = async (t) => {
    await frameAt(t);
    const data = g.getImageData(0, 0, job.width, job.height).data;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] + data[i + 1] + data[i + 2] < 40) n += 1;
    return n;
  };
  const regions = []; for (const r of job.regions || []) regions.push(await inkIn(r));
  const changes = []; for (const r of job.changes || []) changes.push(await changedIn(r));
  const blank = job.spreadAt === null || job.spreadAt === undefined ? null : await spreadAt(job.spreadAt);
  const inks = []; for (const t of job.inkTimes) inks.push(await inkAt(t));
  const dark = []; for (const t of job.darkTimes) dark.push(await darkAt(t));
  const stills = [];
  for (const [name, t] of job.stills) { await frameAt(t); stills.push({ name, png: await base64Of(await new Promise((done) => canvas.toBlob(done, 'image/png'))) }); }
  const out = { monoLoaded, cuts: made.cuts || null, seconds: video.duration, bytes: made.blob.size, width: video.videoWidth, height: video.videoHeight, inks, dark, regions, changes, blank, stills, webm: job.keep ? await base64Of(made.blob) : null };
  URL.revokeObjectURL(url);
  return out;
}`;

interface Tools {
  evaluate<T>(expression: string): Promise<T>;
  /** the page as a PNG (base64), or a part of it */
  screenshot(clip?: Box): Promise<string>;
}


/**
 * The live pane, mounted for real (`chrome/lang-pane.ts` with the page's own stylesheets) on the same lines, in a 1280x720 page: how wide each row's text is and how many rows it
 * wraps to, by the row's first line. With `film`, a picture of the film's panel is laid beside it, so one screenshot has both.
 */
const LIVE_SCRIPT = String.raw`async (job) => {
  const [{ buildSession }, { createLangLog }, { mountLangPane }, { ensureMono }] = await Promise.all([
    import('/src/bench/film-session.ts'), import('/src/app/lang-log.ts'), import('/src/chrome/lang-pane.ts'), import('/src/app/lang-style.ts'),
  ]);
  await ensureMono();
  for (const name of ['tokens', 'chrome', 'lang']) {
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = '/src/styles/' + name + '.css?direct';
    document.head.append(link);
    await new Promise((done) => { link.onload = done; link.onerror = done; });
  }
  document.body.className = 'page-stage';
  document.body.style.cssText = 'margin:0;background:#fff';
  const session = buildSession(job.width, job.height, job.explorable);
  const roles = session.film.frameAt(job.paletteAt).spec.roles;
  const root = document.documentElement;
  root.style.setProperty('--stage-ground', roles.ground); root.style.setProperty('--stage-ink', roles.ink); root.style.setProperty('--stage-dim', roles.dim); root.style.setProperty('--stage-accent', roles.accent);
  const app = document.createElement('div');
  app.id = 'app';
  app.style.cssText = 'position:fixed;left:0;top:0;width:' + job.width + 'px;height:' + job.height + 'px;display:grid;background:var(--stage-ground)';
  const stage = document.createElement('div'); stage.className = 'stage';
  app.append(stage); document.body.append(app);
  const log = createLangLog(false);
  const none = () => ({ lines: [], playhead: 0, motions: [], elements: [], turn: null });
  const menu = { add: () => ({ set() {}, remove() {} }) };
  const pane = mountLangPane(app, stage, { lang: log, painter: { snapshot: none } }, menu);
  log.set(true);
  const turn = session.recordings[0];
  log.openTurn(turn.turn);
  for (const entry of session.log.entriesOf(turn.turn)) {
    if (entry.kind === 'dropped') log.dropped(turn.turn, entry.text, entry.issues, 0);
    else log.line(turn.turn, entry.seq, entry.text, entry.issues, 0);
  }
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  const list = app.querySelector('.lang__body');
  list.scrollTop = 0;
  const rows = [];
  for (const row of app.querySelectorAll('.lang__row')) {
    const range = document.createRange();
    range.selectNodeContents(row);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0);
    const left = row.getBoundingClientRect().left + parseFloat(getComputedStyle(row).paddingLeft) - parseFloat(getComputedStyle(row).fontSize) * 0.6 * 2;
    const tops = new Set(rects.map((r) => Math.round(r.top)));
    const right = Math.max(...rects.map((r) => r.right));
    rows.push({ text: row.textContent, width: right - left, lines: tops.size, font: getComputedStyle(row).fontFamily + ' ' + getComputedStyle(row).fontSize });
  }
  if (job.filmPng) {
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:' + (job.width * 0.3 + 16) + 'px;top:0;width:' + (job.width * 0.3) + 'px;height:' + job.height + 'px;overflow:hidden;outline:2px solid #888';
    const image = new Image();
    image.src = 'data:image/png;base64,' + job.filmPng;
    image.style.cssText = 'position:absolute;left:0;top:0;width:' + job.width + 'px;height:' + job.height + 'px';
    holder.append(image);
    document.body.append(holder);
    await image.decode();
  }
  return { rows, font: getComputedStyle(app.querySelector('.lang')).fontFamily, size: getComputedStyle(app.querySelector('.lang')).fontSize, panel: JSON.parse(JSON.stringify(app.querySelector('.lang').getBoundingClientRect())) };
}`;

interface Live {
  readonly rows: readonly { readonly text: string; readonly width: number; readonly lines: number; readonly font: string }[];
  readonly font: string;
  readonly size: string;
}

const exportFilm = (tools: Tools, job: Record<string, unknown>): Promise<Made> => tools.evaluate<Made>(`(${PAGE_SCRIPT})(${JSON.stringify(job)})`);

async function withBrowser<T>(use: (tools: Tools) => Promise<T>): Promise<T> {
  const web = await claimPort('the film page');
  const chrome = await claimPort('the film Chrome');
  const started: ChildProcess[] = [];
  const cleanups: (() => Promise<void>)[] = [];
  try {
    const url = `http://127.0.0.1:${web}`;
    started.push(spawnTracked('pnpm', ['--filter', '@conduit/web', 'exec', 'vite'], undefined, { cwd: repoRoot(), env: { VITE_PORT: String(web), VITE_API: 'http://127.0.0.1:1' }, quiet: true }));
    await waitFor('the web dev server', 240_000, async () => ((await fetch(`${url}/explore.html`)).ok ? true : null));
    const binary = CHROME_CANDIDATES.find((path) => existsSync(path));
    if (binary === undefined) throw new Error('no Chrome found: set CHROME_BIN to a Chrome or Chromium executable');
    const profile = await mkdtemp(join(tmpdir(), 'conduit-film-'));
    cleanups.push(() => rm(profile, { recursive: true, force: true }));
    started.push(spawnTracked(binary, [...chromeFlags(), `--remote-debugging-port=${chrome}`, `--user-data-dir=${profile}`, '--window-size=1280,800', 'about:blank'], undefined, { quiet: true }));
    const endpoint = await waitFor('Chrome', 90_000, async () => {
      const body = (await (await fetch(`http://127.0.0.1:${chrome}/json/version`)).json()) as { webSocketDebuggerUrl?: string };
      return body.webSocketDebuggerUrl ?? null;
    });
    const browser = await Cdp.open(endpoint);
    cleanups.unshift(async () => browser.close());
    const { targetId } = await browser.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await browser.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    await browser.send('Page.enable', {}, sessionId);
    await browser.send('Page.navigate', { url: `${url}/explore.html` }, sessionId);
    const evaluate = async <T>(expression: string): Promise<T> => {
      const out = await browser.send<{ result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (out.exceptionDetails !== undefined) throw new Error(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text);
      return out.result.value as T;
    };
    await waitFor('the page', 30_000, async () => ((await evaluate<string>('document.readyState')) === 'complete' ? true : null));
    const screenshot = async (clip?: Box): Promise<string> => (await browser.send<{ data: string }>('Page.captureScreenshot', { format: 'png', ...(clip === undefined ? {} : { clip: { ...clip, scale: 1 } }) }, sessionId)).data;
    return await use({ evaluate, screenshot });
  } finally {
    for (const child of started.splice(0)) await stop(child);
    for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
    releasePort(web);
    releasePort(chrome);
  }
}

/** the times (on the cut film's clock) the real frames are looked at, from the bench's own scenes */
function plan(run: Bench): { readonly typed: number[]; readonly marker: number; readonly scrolled: number; readonly back: number; readonly slider: number; readonly act: number; readonly close: number; readonly rest: number; readonly t1End: number; readonly box: Box } {
  const at = (find: (sample: Bench['samples'][number], index: number) => boolean, fallback: number): number => run.samples.find(find)?.at ?? fallback;
  const typedAt = (letters: number): number => at((sample) => sample.scene.input.text.length >= letters, 1);
  const cut = run.cutList.cuts[0];
  const markerStart = at((sample) => sample.scene.marker !== null, 4);
  let scrolledAt = 0;
  for (const sample of run.samples) if (sample.scene.rows.some((row) => row.top < sample.scene.panel.y - 1 && row.bottom > sample.scene.panel.y - 1) && sample.scene.lit !== null) { scrolledAt = sample.at; break; }
  let sawCircle = false;
  let backAt = 0;
  for (const sample of run.samples) {
    const row = sample.scene.rows.find((candidate) => candidate.lit);
    if (row?.text.startsWith('circle c') === true) sawCircle = true;
    if (sawCircle && row?.text.startsWith('move b1') === true) { backAt = sample.at; break; }
  }
  // a followed line: the first probe whose framing is closest in, shown a little later than the probe (cut clock = real clock less the cut)
  const closest = [...run.follow.probes].sort((a, b) => b.framing.zoom - a.framing.zoom)[0];
  const removed = (real: number): number => (cut === undefined ? 0 : real >= cut.to ? cut.removed : 0);
  return {
    typed: [typedAt(1) - 0.3, typedAt(6), typedAt(18), typedAt(34), typedAt(PROMPT.length) + 0.1],
    marker: (cut === undefined ? markerStart : markerStart + 0.6),
    scrolled: scrolledAt + 0.3,
    back: backAt + 0.3,
    slider: run.height.first.at - removed(run.height.first.at) + 1.5,
    act: run.height.inAct.at - removed(run.height.inAct.at),
    close: closest === undefined ? 1 : closest.real - removed(closest.real),
    rest: run.filmDuration - 0.2,
    // the end of the first turn: every one of its rows has come and none of the second turn's yet
    t1End: [...run.samples].reverse().find((sample) => !sample.scene.rows.some((row) => row.text.startsWith('set sun')) && sample.scene.rows.some((row) => row.text.startsWith('button ask')))?.at ?? 1,
    box: run.samples[0]?.scene.input.box ?? { x: 0, y: 0, width: 1, height: 1 },
  };
}

/** The options' exports, in a real browser: short files of the made-up session, probed where the bench says the caption, the tag, the pane, the input box, the knob and the sun are. */
async function optionsMade(tools: Tools, data: OptionsData, explorable: string): Promise<OptionsMade> {
  const width = 1280;
  const height = 720;
  const base = { width, height, fps: 10, to: 4, from: 0, explorable, box: { x: 0, y: 0, width: 1, height: 1 }, inkTimes: [], darkTimes: [], stills: [], keep: false };
  const surroundOf = (pane: boolean, prompt: boolean): SurroundRun => {
    const found = data.surround.find((run) => run.screen === `${width}x${height}` && run.pane === pane && run.prompt === prompt);
    if (found === undefined) throw new Error('the bench has no run of that surround');
    return found;
  };
  const labelled = data.labels.find((run) => run.look === 'paper' && run.width === width);
  const shown = labelled?.samples.find((sample) => Math.abs(sample.at - 1) < 0.026);
  const captionBox = shown?.caption?.box;
  const tagBox = shown?.tag?.box;
  if (labelled === undefined || captionBox === undefined || tagBox === undefined) throw new Error('the bench has no caption and tag at 1 s');
  const region = (t: number, box: Box): { t: number; x: number; y: number; w: number; h: number } => ({ t, x: box.x, y: box.y, w: box.width, h: box.height });
  const labelRegions = [...LABEL_TIMES.map((t) => region(t, captionBox)), ...LABEL_TIMES.map((t) => region(t, tagBox))];
  const all = surroundOf(true, true).layout;
  const surround: { pane: boolean; prompt: boolean; paneInk: number; barInk: number; blank: number }[] = [];
  let plain: { caption: number[]; tag: number[] } = { caption: [], tag: [] };
  for (const [pane, prompt] of [[true, true], [true, false], [false, true], [false, false]] as const) {
    const made = await exportFilm(tools, { ...base, session: { cards: false, surround: { pane, prompt } }, regions: [region(0.2, all.pane), region(3.0, all.bar), ...(pane && prompt ? labelRegions : [])], spreadAt: 0.2 });
    surround.push({ pane, prompt, paneInk: made.regions[0] ?? -1, barInk: made.regions[1] ?? -1, blank: made.blank ?? -1 });
    if (pane && prompt) plain = { caption: made.regions.slice(2, 2 + LABEL_TIMES.length), tag: made.regions.slice(2 + LABEL_TIMES.length) };
  }
  const withLabels = await exportFilm(tools, { ...base, session: { cards: false, captions: CAPTIONS, tag: TAG }, regions: labelRegions });
  const dragOf = async (run: DragRun | null): Promise<{ knob: number[]; sun: number[] }> => {
    if (run === null || run.control === null || run.sunBox === null) throw new Error('the bench has no drag run');
    const on = (box: Box): { x: number; y: number; w: number; h: number } => ({ x: run.stage.x + box.x, y: run.stage.y + box.y, w: box.width, h: box.height });
    const [t0, t1, t2, t3] = DRAG_TIMES;
    const from = Math.max(0, run.cutFrom - DRAG_LEAD);
    const made = await exportFilm(tools, { ...base, from, to: from + 2.2, session: { cards: false, follow: false, ...(run.drag ? { drag: true } : {}) }, changes: [{ a: t0, b: t1, ...on(run.control) }, { a: t1, b: t2, ...on(run.control) }, { a: t2, b: t3, ...on(run.control) }, { a: t0, b: t2, ...on(run.sunBox) }, { a: t2, b: t3, ...on(run.sunBox) }] });
    return { knob: made.changes.slice(0, 3), sun: made.changes.slice(3) };
  };
  return {
    surround,
    labelled: { caption: withLabels.regions.slice(0, LABEL_TIMES.length), tag: withLabels.regions.slice(LABEL_TIMES.length) },
    plain,
    drag: { on: await dragOf(data.drag.on), off: await dragOf(data.drag.off) },
  };
}

export async function filmGroup(note: (text: string) => void = () => undefined): Promise<CheckResult[]> {
  const runs = await bench();
  const results = judge(runs);
  const options = runs[0]?.options;
  if (options === undefined) throw new Error('the film bench gave no options');
  note(`film: bench judged (${results.filter((r) => r.verdict === 'FAIL').length} failing)`);
  // the real exporter, on the first twenty seconds of the film at 1280x720: the cuts it returns, its length, and the ink in the input box while the prompt is typed
  const wide = runs[0];
  if (wide === undefined || process.env['FILM_BENCH_ONLY'] === '1') return [...results, ...judgeOptions(options)];
  const where = plan(wide);
  const shown = 20;
  const explorable = await readFile(join(repoRoot(), 'language', 'demos', 'explorable.series'), 'utf8');
  const { made, live, optionsReal } = await withBrowser(async (tools) => {
    const exported = await exportFilm(tools, { width: 1280, height: 720, fps: 10, to: shown, explorable, box: where.box, inkTimes: [0.2, 1.0, 2.0, 3.0, 3.8], darkTimes: [2.0, where.marker], stills: [], keep: false });
    const looked = await tools.evaluate<Live>(`(${LIVE_SCRIPT})(${JSON.stringify({ width: 1280, height: 720, paletteAt: 30, explorable })})`);
    return { made: exported, live: looked, optionsReal: await optionsMade(tools, options, explorable) };
  });
  results.push(judgeLook(wide, live));
  results.push(...judgeOptions(options, optionsReal));
  const problems: string[] = [];
  if (!made.monoLoaded) problems.push('the pane\'s mono face was not loaded when the film was drawn (the rows would be set in a fallback face)');
  if (made.cuts === null) problems.push('the exporter returned no cuts');
  else if (JSON.stringify(made.cuts.cuts) !== JSON.stringify(wide.cutList.cuts)) problems.push(`the exporter's cuts ${JSON.stringify(made.cuts.cuts)} are not the session's ${JSON.stringify(wide.cutList.cuts)}`);
  if (Math.abs(made.seconds - shown) > 0.6) problems.push(`the file is ${made.seconds.toFixed(2)} s, not the ${shown} s asked`);
  if (made.width !== 1280 || made.height !== 720) problems.push(`the file is ${made.width}x${made.height}`);
  const [a, b, c, d, e] = made.inks;
  if (a === undefined || b === undefined || c === undefined || d === undefined || e === undefined || !(b < c && c < d && d < e)) problems.push(`the ink in the input box does not grow as the prompt is typed (${made.inks.join(', ')})`);
  if ((made.dark[1] ?? 0) < 400) problems.push(`the marker's pill is not in the frame inside the cut (${made.dark[1] ?? 0} pixels differ from the same stage before)`);
  results.push(result('film-export', problems, `the exporter made a ${made.seconds.toFixed(1)} s WebM at 1280x720 (${Math.round(made.bytes / 1024)} KB): its cuts are the session's, and the input box fills (${made.inks.join(', ')} px)`));
  return results;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The proof: the whole session as a film, with stills

async function proof(dir: string, size: { width: number; height: number }): Promise<void> {
  await mkdir(dir, { recursive: true });
  const runs = await bench();
  const run = runs.find((candidate) => candidate.screen === `${size.width}x${size.height}`) ?? runs[0];
  if (run === undefined) throw new Error('no bench run');
  const where = plan(run);
  const explorable = await readFile(join(repoRoot(), 'language', 'demos', 'explorable.series'), 'utf8');
  const { made, live, shot } = await withBrowser(async (tools) => {
    const exported = await exportFilm(tools, {
      ...size,
      fps: 15,
      to: null,
      explorable,
      box: where.box,
      inkTimes: [],
      darkTimes: [],
      keep: true,
      stills: [
        ['typing-a', where.typed[1]], ['typing-b', where.typed[2]], ['typing-c', where.typed[3]], ['typing-sent', where.typed[4]],
        ['marker', where.marker], ['panel-scrolled', where.scrolled], ['panel-back-up', where.back],
        ['slider-written', where.slider], ['slider-act', where.act], ['follow-close', where.close], ['rest', where.rest], ['panel-t1', where.t1End],
      ],
    });
    const filmPng = exported.stills.find((still) => still.name === 'panel-t1')?.png ?? '';
    const looked = await tools.evaluate<Live>(`(${LIVE_SCRIPT})(${JSON.stringify({ ...size, paletteAt: 30, explorable, filmPng })})`);
    return { made: exported, live: looked, shot: await tools.screenshot({ x: 0, y: 0, width: size.width, height: size.height }) };
  });
  await writeFile(join(dir, `film-${size.width}x${size.height}-live-vs-film.png`), Buffer.from(shot, 'base64'));
  const look = judgeLook(run, live);
  process.stdout.write(`${look.verdict} ${look.check}: ${look.detail}\n`);
  const stem = `film-${size.width}x${size.height}`;
  if (made.webm !== null) await writeFile(join(dir, `${stem}.webm`), Buffer.from(made.webm, 'base64'));
  await writeFile(join(dir, `${stem}.cuts.json`), `${JSON.stringify(made.cuts, null, 2)}\n`);
  for (const still of made.stills) await writeFile(join(dir, `${stem}-${still.name}.png`), Buffer.from(still.png, 'base64'));
  process.stdout.write(`wrote ${stem}.webm (${made.seconds.toFixed(1)} s), its cuts and ${made.stills.length} stills in ${dir}\n`);
}

/**
 * The options, as a person sees them: the session exported at the reel's own size with the surround out, with captions and the tag (paper, then night), and with the drag, each as a WebM
 * and stills in `dir`. `tsx film-check.ts --options <dir>`.
 */
async function proofOptions(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const runs = await bench();
  const options = runs[0]?.options;
  const dragged = options?.drag.on;
  if (options === undefined || dragged === null || dragged === undefined) throw new Error('no bench run');
  const explorable = await readFile(join(repoRoot(), 'language', 'demos', 'explorable.series'), 'utf8');
  const size = { width: 1920, height: 1080 };
  const base = { ...size, fps: 6, from: 0, to: null as number | null, explorable, box: { x: 0, y: 0, width: 1, height: 1 }, inkTimes: [], darkTimes: [], keep: true };
  const save = async (name: string, made: Made): Promise<void> => {
    if (made.webm !== null) await writeFile(join(dir, `${name}.webm`), Buffer.from(made.webm, 'base64'));
    for (const still of made.stills) await writeFile(join(dir, `${name}-${still.name}.png`), Buffer.from(still.png, 'base64'));
    process.stdout.write(`wrote ${name}.webm (${made.seconds.toFixed(1)} s) and ${made.stills.length} stills\n`);
  };
  const tour = [['a-typing', 1.0], ['b-first-lines', 6.5], ['c-drawn', 10], ['d-later', 15]] as const;
  await withBrowser(async (tools) => {
    // the stage is the whole picture; the caption and the tag over it (paper, and the night look once the first line has come)
    await save('reel-paper-surround-off', await exportFilm(tools, { ...base, to: 20, session: { cards: false, surround: { pane: false, prompt: false }, captions: CAPTIONS, tag: TAG, follow: false }, stills: tour }));
    await save('reel-night-surround-off', await exportFilm(tools, { ...base, to: 20, look: 'night', session: { cards: false, surround: { pane: false, prompt: false }, captions: CAPTIONS, tag: TAG, follow: false }, stills: tour }));
    // the same with the input box on, as the reel's "Ask it" section has it
    await save('reel-night-prompt-only', await exportFilm(tools, { ...base, to: 12, look: 'night', session: { cards: false, surround: { pane: false, prompt: true }, captions: CAPTIONS, tag: TAG, follow: false }, stills: [['a-typing', 2.0], ['b-drawn', 10]] }));
    // with the pane too (what the film is without any option, plus the caption and the tag)
    await save('film-paper-everything', await exportFilm(tools, { ...base, width: 1280, height: 720, to: 12, session: { cards: false, captions: CAPTIONS, tag: TAG }, stills: [['a-typing', 2.0], ['b-drawn', 10]] }));
    // a phone
    await save('film-paper-phone', await exportFilm(tools, { ...base, width: 390, height: 844, to: 12, session: { cards: false, captions: CAPTIONS, tag: TAG }, stills: [['a-typing', 2.0], ['b-drawn', 10]] }));
    // the drag: the knob and the picture, then the tap; and the same turn with no drag, where it jumps
    const lead = DRAG_LEAD;
    const times = [['a-before', lead - 0.2], ['b-early', lead + 0.3], ['c-middle', lead + 0.55], ['d-late', lead + 0.85], ['e-after', lead + 1.25], ['f-tap', lead + 1.5], ['g-turn', lead + 2.9]] as const;
    for (const drag of [true, false]) {
      // as the check looks at it: the pane and the input box in, 1280x720, at the check's own moments
      const at = Math.max(0, dragged.cutFrom - lead);
      await save(drag ? 'probe-on' : 'probe-off', await exportFilm(tools, { ...base, width: 1280, height: 720, fps: 10, from: at, to: at + 2.2, session: { cards: false, follow: false, ...(drag ? { drag: true } : {}) }, stills: DRAG_TIMES.map((t, index) => [`t${index}`, t]) }));
    }
    for (const drag of [true, false]) {
      const from = Math.max(0, dragged.cutFrom - lead);
      await save(drag ? 'drag-on' : 'drag-off', await exportFilm(tools, { ...base, fps: 15, from, to: from + 4, session: { cards: false, surround: { pane: false, prompt: true }, ...(drag ? { drag: true } : {}), follow: false }, stills: times }));
    }
  });
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(`/${process.argv[1].split('/').pop() ?? '#'}`)) {
  const at = process.argv.indexOf('--proof');
  const optionsAt = process.argv.indexOf('--options');
  if (optionsAt >= 0) {
    void proofOptions(process.argv[optionsAt + 1] ?? join(tmpdir(), 'conduit-film-options')).then(() => process.exit(0), (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
  } else if (at >= 0) {
    const sized = /^(\d+)x(\d+)$/.exec(process.argv[at + 2] ?? '1280x720');
    void proof(process.argv[at + 1] ?? join(tmpdir(), 'conduit-film-proof'), { width: Number(sized?.[1] ?? 1280), height: Number(sized?.[2] ?? 720) }).then(() => process.exit(0), (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
  } else {
    void filmGroup((text) => process.stdout.write(`${text}\n`)).then((results) => {
      for (const r of results) process.stdout.write(`${r.verdict} ${r.check}: ${r.detail}\n`);
      process.exit(results.some((r) => r.verdict === 'FAIL') ? 1 : 0);
    });
  }
}
