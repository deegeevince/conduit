// pnpm check's film group (no model): the film export as the session ran, made headless.
//
//   typing     the input box's words grow a letter at a time, to the whole prompt, in the sampled frames; and in the real frames of the exported file the box's ink grows
//   panel      the lit row of the language panel is inside the panel's box in every sampled frame, on a wide and a narrow picture, the panel really scrolled, and it came back up to a line still being drawn
//   notes      no row of the panel reads "repaired:" or "dropped:" though the log holds such notes
//   cuts       a wait longer than 4 s is cut to 1.2 s with a "⏩ 19 s" marker; the cuts JSON the exporter returns is the gaps of the session (worked out from the recordings), and the film is that much shorter
//   controls   a control the viewer had left moved is at its written value the first time it is on stage, still there before an act turn, and at the act's value from that turn
//   follow     while a line is drawn the framing has its element inside the centre two thirds of the view (zoom 1 to 1.6), and the stage is whole while waiting and at rest
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
  readonly rows: readonly { readonly text: string; readonly top: number; readonly bottom: number; readonly lit: boolean }[];
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
      if (u < 1 / 6 || u > 5 / 6 || v < 1 / 6 || v > 5 / 6) follow.push(`${where}: ${probe.id} sits at ${u.toFixed(2)},${v.toFixed(2)} of the view while it is drawn`);
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
  results.push(result('film-follow', follow, 'the element being drawn is inside the middle two thirds of the view at zoom 1 to 1.6; the stage is whole while waiting and at rest'));
  return results;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The exporter, in a real browser

interface Made {
  readonly cuts: { readonly cuts: readonly { readonly from: number; readonly to: number; readonly removed: number }[]; readonly filmSeconds: number } | null;
  readonly seconds: number;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly inks: readonly number[];
  readonly dark: readonly number[];
  readonly stills: readonly { readonly name: string; readonly png: string }[];
  readonly webm: string | null;
}

const PAGE_SCRIPT = String.raw`async (job) => {
  const [{ buildSession }, { createExporter }, { createPlainRenderer }, { canUseThree, createThreeRenderer }, { ensureMono }] = await Promise.all([
    import('/src/bench/film-session.ts'), import('/src/export/index.ts'), import('/src/render/plain/index.ts'), import('/src/render/three/index.ts'), import('/src/app/lang-style.ts'),
  ]);
  await ensureMono();
  const session = buildSession(job.width, job.height, job.explorable, { height: 70 });
  const exporter = createExporter({ createRenderer: () => (canUseThree() ? createThreeRenderer() : createPlainRenderer()) });
  const formats = await exporter.formats();
  if (!formats.video.includes('webm')) throw new Error('this browser cannot encode WebM');
  const request = { kind: 'video', format: 'webm', width: job.width, height: job.height, fps: job.fps, scope: 'answer', from: 0, ...(job.to === null ? {} : { to: job.to }) };
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
  const frameAt = async (t) => { await seek(t); g.drawImage(video, 0, 0, job.width, job.height); };
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
  const inks = []; for (const t of job.inkTimes) inks.push(await inkAt(t));
  const dark = []; for (const t of job.darkTimes) dark.push(await darkAt(t));
  const stills = [];
  for (const [name, t] of job.stills) { await frameAt(t); stills.push({ name, png: await base64Of(await new Promise((done) => canvas.toBlob(done, 'image/png'))) }); }
  const out = { cuts: made.cuts || null, seconds: video.duration, bytes: made.blob.size, width: video.videoWidth, height: video.videoHeight, inks, dark, stills, webm: job.keep ? await base64Of(made.blob) : null };
  URL.revokeObjectURL(url);
  return out;
}`;

async function inBrowser(job: Record<string, unknown>): Promise<Made> {
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
    return await evaluate<Made>(`(${PAGE_SCRIPT})(${JSON.stringify(job)})`);
  } finally {
    for (const child of started.splice(0)) await stop(child);
    for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
    releasePort(web);
    releasePort(chrome);
  }
}

/** the times (on the cut film's clock) the real frames are looked at, from the bench's own scenes */
function plan(run: Bench): { readonly typed: number[]; readonly marker: number; readonly scrolled: number; readonly back: number; readonly slider: number; readonly act: number; readonly close: number; readonly rest: number; readonly box: Box } {
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
    box: run.samples[0]?.scene.input.box ?? { x: 0, y: 0, width: 1, height: 1 },
  };
}

export async function filmGroup(note: (text: string) => void = () => undefined): Promise<CheckResult[]> {
  const runs = await bench();
  const results = judge(runs);
  note(`film: bench judged (${results.filter((r) => r.verdict === 'FAIL').length} failing)`);
  // the real exporter, on the first twenty seconds of the film at 1280x720: the cuts it returns, its length, and the ink in the input box while the prompt is typed
  const wide = runs[0];
  if (wide === undefined || process.env['FILM_BENCH_ONLY'] === '1') return results;
  const where = plan(wide);
  const shown = 20;
  const made = await inBrowser({ width: 1280, height: 720, fps: 10, to: shown, explorable: await readFile(join(repoRoot(), 'language', 'demos', 'explorable.series'), 'utf8'), box: where.box, inkTimes: [0.2, 1.0, 2.0, 3.0, 3.8], darkTimes: [2.0, where.marker], stills: [], keep: false });
  const problems: string[] = [];
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
  const made = await inBrowser({
    ...size,
    fps: 15,
    to: null,
    explorable: await readFile(join(repoRoot(), 'language', 'demos', 'explorable.series'), 'utf8'),
    box: where.box,
    inkTimes: [],
    darkTimes: [],
    keep: true,
    stills: [
      ['typing-a', where.typed[1]], ['typing-b', where.typed[2]], ['typing-c', where.typed[3]], ['typing-sent', where.typed[4]],
      ['marker', where.marker], ['panel-scrolled', where.scrolled], ['panel-back-up', where.back],
      ['slider-written', where.slider], ['slider-act', where.act], ['follow-close', where.close], ['rest', where.rest],
    ],
  });
  const stem = `film-${size.width}x${size.height}`;
  if (made.webm !== null) await writeFile(join(dir, `${stem}.webm`), Buffer.from(made.webm, 'base64'));
  await writeFile(join(dir, `${stem}.cuts.json`), `${JSON.stringify(made.cuts, null, 2)}\n`);
  for (const still of made.stills) await writeFile(join(dir, `${stem}-${still.name}.png`), Buffer.from(still.png, 'base64'));
  process.stdout.write(`wrote ${stem}.webm (${made.seconds.toFixed(1)} s), its cuts and ${made.stills.length} stills in ${dir}\n`);
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(`/${process.argv[1].split('/').pop() ?? '#'}`)) {
  const at = process.argv.indexOf('--proof');
  if (at >= 0) {
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
