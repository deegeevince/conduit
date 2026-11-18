// The capability reel (PLAN-catalogue.md, S5): "What Conduit can do" as one film, built from the showcase table (language/src/showcase.ts) and the pages
// (language/demos/showcase/*.series). No model is ever called: the server's brain is the replay brain, and the only turns it answers (a typed question, a tap, a
// slider that sends) are answered from a REPLAY_CASE this file writes out of the pages' own text.
//
//   sections   an opening, the seven categories, a close. A category is its title card (a turn), then each page of the table that has `reel` seconds, in table order (the photo
//              and the pen and the voice are not in it: see `reelPlan`). Every card and page is a session of its own on a tab of its own, and is exported by the app's own exporter at
//              1920x1080 and 30 fps as a film of that session (`scope: 'conversation'`, no title cards, no cuts, no following), with the page's name and caption over the stage and
//              the tag "Scripted tour, no model" in every frame. The input box is drawn in "Ask it" only and the language pane in "It keeps going" only. (A page that follows another
//              in one session begins 0.22 s late, while what was on stage leaves: over 21 pages that is 4.6 s the reel cannot spare, so the pages are cut, not crossfaded. The
//              turns of one page, a tap or a typed question and its answer, stay in one session.)
//   join       each piece is trimmed at the end of its last turn (a film rests 1.2 s past it) and given a mono AAC track (silence where it has no music, so the joins are the same
//              stream layout), and `ffmpeg -f concat -c copy` joins them; if that faults at a join the reel is re-encoded once, H.264 CRF 18.
//   stills     one still per page, at its rest, and one per category card, in a contact sheet: what a person looking for a fault looks at.
//
// `pnpm showcase reel [--out dir] [--only opening,ask,...] [--photo file] [--print] [--no-stills]`; `showcase-reel` is the check group (`pnpm check --only showcase-reel`).

import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readShowcase, SHOWCASE_CATEGORIES, SHOWCASE_REEL } from '@conduit/language';
import type { ShowcaseEntry, ShowcaseReader } from '@conduit/language';
import { spawnTracked } from '../brains/claude-cli/process';
import { claimPort, releasePort } from './check-ports';
import { repoRoot, sleep, stop, waitFor } from './explore-browser';
import { Tab } from './smoke';
import type { CheckResult } from './smoke';

export const FFMPEG = process.env['FFMPEG_BIN'] ?? '/opt/homebrew/bin/ffmpeg';
export const FFPROBE = process.env['FFPROBE_BIN'] ?? '/opt/homebrew/bin/ffprobe';

/** the standing tag, in every frame of every section */
export const REEL_TAG = 'Scripted tour, no model';
/** the picture of every section */
export const REEL_SIZE = { width: 1920, height: 1080, fps: 30 } as const;
/** what is typed in "Ask it": the page's answer is to this question */
export const REEL_PROMPT = 'Why is the sky blue?';
/**
 * The opening and the close are held to 3.5 s, not the table's "about 4": a typed question, a tap, a slider and a written answer each carry a lead (typing, a touch, a drag) that the
 * table's seconds do not count, and the whole reel has to stay under 90 s.
 */
export const REEL_OPENING = 3.5;
export const REEL_CLOSE = 3.5;
/** the seconds a film rests at its end, past its last turn (web/src/painter/reel.ts): cut from each section, the last page having held its own */
const TAIL = 1.2;

// ------------------------------------------------------------------------------------------------------------------------------------------------ the plan

/** One thing a person (or the tour) does in a beat. A step that has an `answer` is a turn the replay brain answers from the case file. */
export type ReelStep =
  | { readonly kind: 'script'; readonly source: string }
  | { readonly kind: 'prompt'; readonly text: string; readonly answer: string }
  | { readonly kind: 'tap'; readonly id: string; readonly answer: string }
  | { readonly kind: 'set'; readonly id: string; readonly value: number | string; readonly answer: string }
  | { readonly kind: 'photo'; readonly file: string };

/** A title card, a page, or the opening and close: one or more turns that are captioned as one. */
export interface ReelBeat {
  readonly id: string;
  readonly kind: 'opening' | 'card' | 'page' | 'close';
  readonly steps: readonly ReelStep[];
  /** the name and caption over the stage while it plays, and the corner it stands in; null for a card, the opening and the close */
  readonly caption: { readonly name: string; readonly caption: string; readonly at?: 'bottom-left' | 'bottom-right' | 'top-left' } | null;
  /** what the table (or the plan) says it lasts, seconds */
  readonly seconds: number;
}

export interface ReelSection {
  readonly id: string;
  readonly name: string;
  /** is the input box drawn round the stage, and the language pane */
  readonly prompt: boolean;
  readonly pane: boolean;
  readonly beats: readonly ReelBeat[];
}

export interface ReelPlan {
  readonly sections: readonly ReelSection[];
  /** the pages in it */
  readonly pages: number;
  /** what the table has in the reel that this reel leaves out, and why */
  readonly left: readonly string[];
  /** the seconds the plan comes to by the table (its own cards, opening and close included) */
  readonly seconds: number;
}

/** What the replay brain is given to answer a beat's typed question, tap or set control from: nothing else a beat does reaches it. Matched as `REPLAY_CASE` matches (a prompt by its words, a tap by `kind:tap`, a control that sends by `kind:act`). */
export function replayOf(beat: ReelBeat): { readonly match: string; readonly script: string }[] {
  const turns: { match: string; script: string }[] = [];
  for (const step of beat.steps) {
    if (step.kind === 'prompt') turns.push({ match: step.text, script: step.answer });
    else if (step.kind === 'tap') turns.push({ match: 'kind:tap', script: step.answer });
    else if (step.kind === 'set') turns.push({ match: 'kind:act', script: step.answer });
  }
  return turns;
}

/** Where the pages are: one file to a category. A page is the scene in it, from its `scene` line down, without comments or blank lines. */
export function pageSources(): Map<string, string> {
  const dir = join(repoRoot(), 'language', 'demos', 'showcase');
  const out = new Map<string, string>();
  for (const category of SHOWCASE_CATEGORIES) {
    const path = join(dir, `${category.id}.series`);
    if (!existsSync(path)) continue;
    let id: string | null = null;
    let lines: string[] = [];
    const close = (): void => {
      if (id !== null && !out.has(id)) out.set(id, lines.join('\n'));
    };
    for (const raw of readFileSync(path, 'utf8').split('\n')) {
      const trimmed = raw.trim();
      const scene = /^scene\s+(\S+)/.exec(trimmed);
      if (scene !== null) {
        close();
        id = scene[1] ?? null;
        lines = [raw];
      } else if (id !== null && trimmed !== '' && !(trimmed.startsWith('#') && !trimmed.startsWith('#!'))) lines.push(raw);
    }
    close();
  }
  return out;
}

const script = (...lines: readonly string[]): string => lines.join('\n');

/**
 * The opening: the title, and the seven categories under it, all arriving at once. A line of `say` lasts its reading time and the scene lasts the longest thing in it, so
 * the opening, the cards and the close are held to their seconds by a slow push of the camera (`cam push over=`), as the table's big-type page is; the last thing arrives well inside it.
 */
function openingScript(): string {
  return script(
    'scene opening stack brisk',
    'look paper',
    'style whisper size=s ink=dim',
    'style title size=xxl weight=bold face=display',
    'style names size=m ink=accent',
    `cam push over=${REEL_OPENING}s`,
    'say lead whisper enter=fade by=all | Conduit',
    'say head title @with enter=fade by=all | What Conduit can do',
    ...SHOWCASE_CATEGORIES.map((category) => `say ${category.id} names @with enter=fade by=all | ${category.name}`),
  );
}

/** A category's card: its name, large. */
function cardScript(category: { readonly name: string }): string {
  return script('scene card stack brisk', 'look paper', 'style title size=xxl weight=bold face=display', 'cam push over=1.2s', `say head title enter=fade by=all | ${category.name}`);
}

/** The close: the name, one line, the repository, and what the reel is. */
function closeScript(pages: number): string {
  return script(
    'scene close stack brisk',
    'look paper',
    'style whisper size=s ink=dim',
    'style title size=xxl weight=bold face=display',
    'style repo size=m ink=accent',
    `cam push over=${REEL_CLOSE}s`,
    'say head title enter=fade by=all | Conduit',
    'say line @with enter=fade by=all | A different way to interact with the AI you already use.',
    'say repo repo @with enter=fade by=all | github.com/your-name/conduit',
    `say note whisper @with enter=fade by=all | Exported by Conduit from ${pages} scripted pages.`,
    'say none whisper @with enter=fade by=all | No model was called.',
  );
}

/** "It shows its working" is a tap on the language view, which the film has on for the whole section: a small drawing made line by line, so the lit row has something to follow. */
const STREAM_SCRIPT = script(
  'scene stream figure brisk',
  'look paper',
  'line ground 10,78 150,78 thick=1',
  'rect wall 52,46 56x32 fill=ink',
  'poly roof 46,46 80,22 114,46 fill=accent',
  'rect door 74,58 12x20 fill=dim',
  'circle sun 128,18 8 fill=accent stroke=none',
  'say enter=fade by=all | Each line draws one thing.',
  'wait 0.4s',
);

/** The drag page's slider also sends: moving it ends in a turn, so that the film has the slider's recorded change to play as a drag. */
function draggable(source: string): string {
  return source.replace(/^(slider height .*?) (in=tools \|)/m, '$1 send $2');
}
const SLIDE_TO = 55;
const SLIDE_ANSWER = script('# the slider sends: nothing to add, the picture already followed', 'wait 0.2s');
/** The sum's blank is written by a hand (a control set, which the app takes as the person writing and sending), not by a `fill` line of a script: a film of a script's `fill` shows the blank empty. */
const SUM_ANSWER = script('# the written answer is marked', 'wait 1.0s');

/** Pages whose own picture or words reach the bottom-left corner, where a caption stands unless told otherwise: the list of seven scripts runs down to it, the chart's years along its foot. */
const CAPTION_AT: Readonly<Record<string, 'bottom-right' | 'top-left'>> = { alphabets: 'bottom-right', chart: 'bottom-right' };

function pageBeat(entry: ShowcaseEntry, source: string, photo: string | null): ReelBeat | null {
  const caption = { name: entry.name, caption: entry.caption, ...(CAPTION_AT[entry.id] === undefined ? {} : { at: CAPTION_AT[entry.id] }) };
  const seconds = entry.reel ?? 0;
  const beat = (steps: readonly ReelStep[]): ReelBeat => ({ id: entry.id, kind: 'page', steps, caption, seconds });
  switch (entry.id) {
    case 'type':
      return beat([{ kind: 'prompt', text: REEL_PROMPT, answer: source }]);
    case 'tap': {
      const answer = entry.turns?.[0];
      return answer === undefined ? null : beat([{ kind: 'script', source }, { kind: 'tap', id: 'orange', answer }]);
    }
    case 'drag':
      return beat([{ kind: 'script', source: draggable(source) }, { kind: 'set', id: 'height', value: SLIDE_TO, answer: SLIDE_ANSWER }]);
    case 'sum':
      return beat([{ kind: 'script', source }, { kind: 'set', id: 'p3', value: '83', answer: SUM_ANSWER }]);
    case 'photo':
      return photo === null ? null : beat([{ kind: 'photo', file: photo }, { kind: 'script', source }]);
    case 'stream':
      return beat([{ kind: 'script', source: STREAM_SCRIPT }]);
    default:
      return beat([{ kind: 'script', source }, ...(entry.turns ?? []).map((turn): ReelStep => ({ kind: 'script', source: turn }))]);
  }
}

/** Why a page that has seconds in the table is not in the reel. */
const LEFT_OUT: Readonly<Record<string, string>> = {
  pen: 'pen: no recorded footage of a pen yet (a real iPad still, tagged "Recorded")',
  voice: 'voice: no recorded footage of the microphone yet (a real still, tagged "Recorded")',
};

/**
 * The reel from the table: the pages in it are the table's `reel` entries, in table order. The pen and the
 * voice cannot be filmed from a script and have no footage yet, so they are left out; the photo needs a real photo (`--photo <file>`; the owner has not given one, and a test
 * pattern is not a photo), so it is left out too until there is one. Each says so in `left`.
 */
export function reelPlan(options: { readonly photo?: string | null; readonly reader?: ShowcaseReader } = {}): ReelPlan {
  const reader = options.reader ?? readShowcase();
  const photo = options.photo ?? null;
  const sources = pageSources();
  const left: string[] = [];
  const sections: ReelSection[] = [];
  let pages = 0;
  const opening: ReelBeat = { id: 'opening', kind: 'opening', steps: [{ kind: 'script', source: openingScript() }], caption: null, seconds: REEL_OPENING };
  sections.push({ id: 'opening', name: 'Opening', prompt: false, pane: false, beats: [opening] });
  for (const category of reader.categories) {
    const entries = reader.reel().filter((entry) => entry.category === category.id);
    const beats: ReelBeat[] = [];
    for (const entry of entries) {
      const source = sources.get(entry.id) ?? '';
      const beat = entry.page === 'recorded' ? null : pageBeat(entry, source, photo);
      if (beat === null) {
        left.push(LEFT_OUT[entry.id] ?? (entry.id === 'photo' ? 'photo: needs a real photo (the owner has not given one; a test pattern is not a photo): `--photo <file>` puts it in' : `${entry.id}: no page`));
        continue;
      }
      beats.push(beat);
    }
    if (beats.length === 0) continue;
    pages += beats.length;
    const card: ReelBeat = { id: `card-${category.id}`, kind: 'card', steps: [{ kind: 'script', source: cardScript(category) }], caption: null, seconds: SHOWCASE_REEL.card };
    sections.push({ id: category.id, name: category.name, prompt: category.id === 'ask', pane: category.id === 'keeps', beats: [card, ...beats] });
  }
  sections.push({ id: 'close', name: 'Close', prompt: false, pane: false, beats: [{ id: 'close', kind: 'close', steps: [{ kind: 'script', source: closeScript(pages) }], caption: null, seconds: REEL_CLOSE }] });
  const seconds = Math.round(sections.reduce((sum, section) => sum + section.beats.reduce((s, beat) => s + beat.seconds, 0), 0) * 10) / 10;
  return { sections, pages, left, seconds };
}

/** The plan's text: the whole reel as one `.series`, in chapters (one per section), each page with its turns. A typed question, a tap and a slide are said in comments; their answers are the script that follows. */
export function printReel(plan: ReelPlan): string {
  const out: string[] = [`# Conduit: what Conduit can do. The reel: ${plan.pages} pages in ${plan.sections.length} chapters, about ${plan.seconds} s. A scripted tour: no model was called.`];
  plan.sections.forEach((section, index) => {
    out.push('', `# ${'='.repeat(70)}`, `# chapter ${index}: ${section.name}${section.prompt ? ' (the input box is on)' : ''}${section.pane ? ' (the language view is on)' : ''}`);
    for (const beat of section.beats) {
      out.push('', `# ${beat.kind === 'page' ? `page ${beat.id}: ${beat.caption?.name ?? ''}, ${beat.seconds} s: ${beat.caption?.caption ?? ''}` : `${beat.kind}, ${beat.seconds} s`}`);
      for (const step of beat.steps) {
        if (step.kind === 'script') out.push(step.source);
        else if (step.kind === 'prompt') out.push(`# typed: ${step.text}`, step.answer);
        else if (step.kind === 'tap') out.push(`# the person taps "${step.id}"`, step.answer);
        else if (step.kind === 'set') out.push(`# the person sets ${step.id} to ${step.value}; it sends`, step.answer);
        else out.push(`# the person gives a photo (${step.file})`);
      }
    }
  });
  return `${out.join('\n')}\n`;
}

/** The stage a section is drawn on, as the film lays it out (web/src/app/lang-film.ts `langLayout`, for a wide picture): the input box takes `68 * k` px along the bottom, the pane 30% of the width. */
export function stageOf(section: { readonly prompt: boolean; readonly pane: boolean }, size: { readonly width: number; readonly height: number } = REEL_SIZE): { readonly width: number; readonly height: number } {
  const k = size.width / 1280;
  const bar = section.prompt ? Math.round(68 * k) : 0;
  const pane = section.pane ? Math.round(Math.max(256 * k, size.width * 0.3)) : 0;
  return { width: size.width - pane, height: size.height - bar };
}

// ------------------------------------------------------------------------------------------------------------------------------------------------ the server and the browser

interface Run {
  readonly code: number | null;
  readonly out: string;
  readonly err: string;
}

/** A tool run to its end, its output kept. */
export async function run(bin: string, args: readonly string[]): Promise<Run> {
  const child = spawnTracked(bin, args, undefined, { cwd: tmpdir(), quiet: false });
  let out = '';
  let err = '';
  child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (err = (err + chunk.toString()).slice(-6000)));
  const code = await new Promise<number | null>((done) => {
    child.once('close', done);
    child.once('error', () => done(-1));
  });
  return { code, out, err };
}

export interface ReelServer {
  readonly url: string;
  /** what the replay brain answers from from now on: a page's own turns, put in place before the page is played (the case file is read at each turn) */
  useCase(turns: readonly { readonly match: string; readonly script: string }[]): Promise<void>;
  stop(): Promise<void>;
}

/** The server from the current build with the replay brain and the plan's recorded answers: a fresh data folder, a port from CHECK_PORTS, nothing else. */
export async function startReelServer(): Promise<ReelServer> {
  const root = repoRoot();
  if (!existsSync(join(root, 'web', 'dist', 'index.html'))) throw new Error('there is no build to film: run "pnpm build" first');
  const scratch = await mkdtemp(join(tmpdir(), 'conduit-reel-'));
  await mkdir(join(scratch, 'skills'), { recursive: true });
  const caseFile = join(scratch, 'case.json');
  await writeFile(caseFile, JSON.stringify({ turns: [] }));
  const port = await claimPort('the reel server');
  let log = '';
  const child: ChildProcess = spawnTracked(process.execPath, ['--import', 'tsx', 'src/main.ts'], undefined, {
    cwd: join(root, 'server'),
    env: { NODE_ENV: 'production', BRAIN: 'replay', HOST: '127.0.0.1', PORT: String(port), DATA_DIR: join(scratch, 'data'), SKILL_ROOTS: join(scratch, 'skills'), LIBRARY: 'seed', READ_LINKS: 'off', LOG_LEVEL: 'warn', REPLAY_CPS: '3000', REPLAY_CASE: caseFile },
  });
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', (chunk: Buffer) => (log = (log + chunk.toString()).slice(-4000)));
  const url = `http://127.0.0.1:${port}`;
  const stopAll = async (): Promise<void> => {
    await stop(child);
    releasePort(port);
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  };
  try {
    await waitFor('the server', 60_000, async () => {
      if (child.exitCode !== null) throw new Error(`the server exited with ${child.exitCode}:\n${log}`);
      return (await fetch(`${url}/api/health`)).ok ? true : null;
    });
  } catch (error) {
    await stopAll();
    throw new Error(`the server did not start: ${error instanceof Error ? error.message : String(error)}\n${log}`);
  }
  return { url, useCase: (turns) => writeFile(caseFile, JSON.stringify({ turns })), stop: stopAll };
}

interface Standing {
  readonly turn: string | null;
  readonly anticipating: boolean;
}

/**
 * The app on `tab`, ready, with no demo playing: what a person sees first, empty, in a session of its own. The tab is kept from one page to the next (a Chrome started for each is slow and
 * once failed to start), so what the last page kept in the browser (an answer kept for a reload) is cleared before the page is loaded again, and the server gives a new session.
 */
async function openStage(base: string, tab: Tab): Promise<void> {
  // what the page before kept (the answer kept for a reload) is cleared from that page, while it is still the page; a tab with nothing loaded has none to clear
  await tab.eval('(() => { try { localStorage.clear(); sessionStorage.clear(); } catch { /* nothing kept */ } return true; })()').catch(() => undefined);
  await tab.send('Page.navigate', { url: `${base}/?demo=none` });
  await waitFor('the stage', 60_000, async () => ((await tab.eval<boolean>('Boolean(window.__stage)').catch(() => false)) ? true : null));
  await tab.eval('window.__stage.ready.then(() => true)');
  await settle(tab, null);
  const kept = await tab.eval<number>('window.__stage.elements().length');
  if (kept > 0) throw new Error(`the page began with ${kept} things on stage: an answer kept from the page before`);
}

const standing = (tab: Tab): Promise<Standing> => tab.eval<Standing>('(() => { const s = window.__stage.state(); return { turn: s.turn, anticipating: s.anticipating === true }; })()');

/** Waits until the turn `id` (or, with null, whichever is open) has played to its end and the stage is at rest. A turn that was over before it was first looked at is let go after 3 s. */
async function settle(tab: Tab, id: string | null, limitMs = 60_000): Promise<void> {
  const began = Date.now();
  let seen = id === null;
  for (;;) {
    const now = await standing(tab);
    if (now.turn === id) seen = true;
    if (now.turn === null && !now.anticipating && (seen || Date.now() - began > 3000)) {
      await sleep(80);
      if ((await standing(tab)).turn === null) return;
    }
    if (Date.now() - began > limitMs) throw new Error(`the turn ${id ?? ''} did not come to rest in ${limitMs / 1000} s`);
    await sleep(60);
  }
}

/** The id of the turn that opens next (a tap or a control opens one and says no id), once it has opened. */
async function nextTurn(tab: Tab, known: ReadonlySet<string>, limitMs = 15_000): Promise<string> {
  const until = Date.now() + limitMs;
  for (;;) {
    const now = await standing(tab);
    if (now.turn !== null && !known.has(now.turn)) return now.turn;
    if (Date.now() > until) throw new Error('no turn opened');
    await sleep(40);
  }
}

export interface PlayedSection {
  /** every turn the section had, in order, each with the beat it belongs to */
  readonly turns: readonly { readonly id: string; readonly beat: string }[];
  /** the caption of each turn of a page */
  readonly captions: Readonly<Record<string, { readonly name: string; readonly caption: string }>>;
}

/** Plays a section on the stage as a person would: a card, then each page; a typed question is typed, a tap is a tap on the choice, a set is the control set by hand. */
export async function playSection(tab: Tab, section: ReelSection, base: string): Promise<PlayedSection> {
  const turns: { id: string; beat: string }[] = [];
  const captions: Record<string, { name: string; caption: string }> = {};
  const known = new Set<string>();
  for (const beat of section.beats) {
    let first: string | null = null;
    for (const step of beat.steps) {
      let id: string;
      if (step.kind === 'script') {
        id = await tab.eval<string>(`window.__stage.playScript(${JSON.stringify(step.source.replaceAll('{1}', first ?? 't1'))})`);
      } else if (step.kind === 'prompt') {
        id = await tab.eval<string>(`window.__stage.prompt(${JSON.stringify(step.text)})`);
      } else if (step.kind === 'tap') {
        const waited = Date.now() + 15_000;
        while (!(await tab.eval<boolean>(`window.__stage.elements().some((e) => e.id === ${JSON.stringify(step.id)} && e.tappable && e.opacity > 0.9)`))) {
          if (Date.now() > waited) throw new Error(`${beat.id}: "${step.id}" never became tappable`);
          await sleep(100);
        }
        await tab.eval(`window.__stage.tap(${JSON.stringify(step.id)})`);
        id = await nextTurn(tab, known);
      } else if (step.kind === 'set') {
        await tab.eval(`window.__stage.control(${JSON.stringify(step.id)}, ${JSON.stringify(step.value)})`);
        id = await nextTurn(tab, known);
      } else {
        const session = await tab.eval<string | null>(`(() => { for (const r of performance.getEntriesByType('resource')) { const m = /\\/api\\/sessions\\/([^/]+)\\//.exec(r.name); if (m) return m[1]; } return null; })()`);
        if (session === null) throw new Error('no session to put the photo in');
        const sent = await fetch(`${base}/api/sessions/${session}/uploads`, { method: 'POST', body: new Uint8Array(await readFile(step.file)), headers: { 'content-type': /\.png$/i.test(step.file) ? 'image/png' : 'image/jpeg' } });
        if (sent.status !== 201) throw new Error(`the server kept no photo (${sent.status})`);
        continue;
      }
      known.add(id);
      first ??= id;
      turns.push({ id, beat: beat.id });
      if (beat.caption !== null) captions[id] = beat.caption;
      await settle(tab, id);
      // a turn nobody asked for (the app answering a blank that was written, say) would be filmed and answered by whatever the case holds: say so
      await sleep(300);
      const after = await standing(tab);
      if (after.turn !== null && !known.has(after.turn)) throw new Error(`${beat.id}: a turn nobody asked for opened (${after.turn})`);
    }
  }
  return { turns, captions };
}

// ------------------------------------------------------------------------------------------------------------------------------------------------ the export

export interface FilmTurn {
  readonly turn: string;
  readonly from: number;
  readonly start: number;
  readonly to: number;
}

export interface Exported {
  readonly file: string;
  readonly bytes: number;
  readonly hasSound: boolean;
  readonly turns: readonly FilmTurn[];
  readonly format: 'mp4' | 'webm';
  readonly seconds: number;
}

export interface ExportOptions {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly from?: number;
  readonly to?: number;
  readonly format?: 'mp4' | 'webm';
}

/** Whether this Chrome encodes H.264 into an MP4 (the app's exporter then makes one), else WebM. */
async function videoFormat(tab: Tab): Promise<'mp4' | 'webm'> {
  const mp4 = await tab.eval<boolean>(`(async () => { try { const s = await VideoEncoder.isConfigSupported({ codec: 'avc1.640034', width: 1920, height: 1080, framerate: 30, bitrate: 8e6 }); return s.supported === true; } catch { return false; } })()`);
  return mp4 ? 'mp4' : 'webm';
}

/** Makes the film of the session on `tab` with the app's exporter and writes it to `file`: the section's request, the progress polled (the call to the page may not outlast a minute), the file read out in pieces. */
export async function exportSection(tab: Tab, section: ReelSection, played: PlayedSection, file: string, options: ExportOptions, note: (text: string) => void = () => undefined): Promise<Exported> {
  const format = options.format ?? (await videoFormat(tab));
  const request = {
    kind: 'video',
    format,
    width: options.width,
    height: options.height,
    fps: options.fps,
    ...(options.from === undefined ? {} : { from: options.from }),
    ...(options.to === undefined ? {} : { to: options.to }),
    scope: 'conversation',
    cards: false,
    follow: false,
    cuts: false,
    drag: true,
    surround: { pane: section.pane, prompt: section.prompt },
    captions: played.captions,
    tag: REEL_TAG,
  };
  await tab.eval(`(() => {
    const state = { progress: null, error: null, result: null };
    window.__reel = state;
    const job = window.__stage.export(${JSON.stringify(request)});
    job.onProgress((p) => { state.progress = p; });
    job.done.then((r) => { state.result = { fileName: r.fileName, hasSound: r.hasSound === true, turns: r.turns || null, note: r.note || null, blob: r.blob, size: r.blob.size }; }, (e) => { state.error = String((e && e.message) || e); });
    return true;
  })()`);
  const began = Date.now();
  let shown = -1;
  for (;;) {
    const now = await tab.eval<{ done: number | null; frames: number | null; error: string | null; finished: boolean }>(`(() => { const s = window.__reel; return { done: s.progress ? s.progress.done : null, frames: s.progress ? s.progress.frames : null, error: s.error, finished: s.result !== null }; })()`);
    if (now.error !== null) throw new Error(`${section.id}: the film could not be made: ${now.error}`);
    if (now.finished) break;
    const percent = now.done === null ? 0 : Math.floor(now.done * 10);
    if (percent !== shown) {
      shown = percent;
      note(`  ${section.id}: ${now.done === null ? 'starting' : `${Math.round(now.done * 100)}% of ${now.frames ?? '?'} frames`} (${Math.round((Date.now() - began) / 1000)} s)`);
    }
    if (Date.now() - began > 20 * 60_000) throw new Error(`${section.id}: the film took more than 20 minutes`);
    await sleep(500);
  }
  const made = await tab.eval<{ size: number; hasSound: boolean; turns: FilmTurn[] | null }>(`({ size: window.__reel.result.size, hasSound: window.__reel.result.hasSound, turns: window.__reel.result.turns })`);
  const pieces: Buffer[] = [];
  const piece = 4 * 1024 * 1024;
  for (let at = 0; at < made.size; at += piece) {
    const data = await tab.eval<string>(`new Promise((done) => { const r = new FileReader(); r.onload = () => done(String(r.result).split(',')[1]); r.readAsDataURL(window.__reel.result.blob.slice(${at}, ${at + piece})); })`);
    pieces.push(Buffer.from(data, 'base64'));
  }
  await writeFile(file, Buffer.concat(pieces));
  await tab.eval('(() => { window.__reel = null; return true; })()');
  const turns = made.turns ?? [];
  return { file, bytes: made.size, hasSound: made.hasSound, turns, format, seconds: (turns[turns.length - 1]?.to ?? 0) + TAIL };
}

// ------------------------------------------------------------------------------------------------------------------------------------------------ ffmpeg

interface Probe {
  readonly seconds: number;
  readonly video: { readonly codec: string; readonly width: number; readonly height: number; readonly fps: number } | null;
  readonly audio: { readonly codec: string; readonly rate: number; readonly channels: number } | null;
}

export async function probe(file: string): Promise<Probe> {
  const out = await run(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
  if (out.code !== 0) throw new Error(`ffprobe could not read ${file}: ${out.err.slice(-300)}`);
  const data = JSON.parse(out.out) as { streams: { codec_type: string; codec_name: string; width?: number; height?: number; r_frame_rate?: string; sample_rate?: string; channels?: number }[]; format: { duration?: string } };
  const video = data.streams.find((stream) => stream.codec_type === 'video');
  const audio = data.streams.find((stream) => stream.codec_type === 'audio');
  const [num, den] = (video?.r_frame_rate ?? '0/1').split('/').map(Number);
  return {
    seconds: Number(data.format.duration ?? 0),
    video: video === undefined ? null : { codec: video.codec_name, width: video.width ?? 0, height: video.height ?? 0, fps: (num ?? 0) / (den ?? 1) },
    audio: audio === undefined ? null : { codec: audio.codec_name, rate: Number(audio.sample_rate ?? 0), channels: audio.channels ?? 0 },
  };
}

/** The peak level of a file's sound, dB (about -91 for silence); null when it has none. */
export async function loudness(file: string): Promise<number | null> {
  const out = await run(FFMPEG, ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-']);
  const found = /max_volume:\s*(-?[\d.]+) dB/.exec(out.err);
  return found?.[1] === undefined ? null : Number(found[1]);
}

/** A section made ready for the join: cut at `seconds` (stream copy), the same mono 48 kHz AAC track in every one (its own where it has sound, silence where not). */
export async function prepare(exported: Exported, seconds: number, file: string): Promise<void> {
  const sound = exported.hasSound;
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error', '-i', exported.file,
    ...(sound ? [] : ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono']),
    '-map', '0:v:0', '-map', sound ? '0:a:0' : '1:a:0',
    '-c:v', 'copy', '-c:a', 'aac', '-ar', '48000', '-ac', '1', '-b:a', '96k',
    '-t', seconds.toFixed(3), '-movflags', '+faststart', file,
  ];
  const made = await run(FFMPEG, args);
  if (made.code !== 0) throw new Error(`ffmpeg could not prepare ${exported.file}: ${made.err.slice(-400)}`);
}

/** The sections joined: stream copy; if it faults (ffmpeg says so, or the result does not decode clean to its end), once more with H.264 CRF 18. Says which it was. */
export async function joinSections(files: readonly string[], out: string, work: string): Promise<{ readonly how: 'copy' | 're-encoded'; readonly why: string }> {
  const list = join(work, 'list.txt');
  await writeFile(list, files.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join('\n'));
  const clean = async (file: string): Promise<string> => {
    const test = await run(FFMPEG, ['-v', 'error', '-i', file, '-f', 'null', '-']);
    return test.code === 0 ? test.err.trim() : `exit ${test.code}: ${test.err.trim()}`;
  };
  const copied = await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out]);
  const problem = copied.code !== 0 ? `concat copy failed: ${copied.err.slice(-300)}` : await clean(out);
  if (problem === '') return { how: 'copy', why: '' };
  const again = await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', out]);
  if (again.code !== 0) throw new Error(`the sections could not be joined: ${again.err.slice(-300)}`);
  return { how: 're-encoded', why: problem.slice(0, 200) };
}

// ------------------------------------------------------------------------------------------------------------------------------------------------ the reel

export interface BuiltPiece {
  readonly section: ReelSection;
  readonly beat: ReelBeat;
  readonly exported: Exported;
  /** where the piece begins in the reel, seconds, and how long it is there */
  readonly at: number;
  readonly seconds: number;
  readonly file: string;
}

export interface BuiltReel {
  readonly file: string;
  readonly seconds: number;
  readonly how: 'copy' | 're-encoded';
  readonly why: string;
  readonly pieces: readonly BuiltPiece[];
  readonly probe: Probe;
}

/** One card, page, opening or close: its own session on its own tab, its answers from the case the replay brain is given, its film made and cut at its last turn's end. */
async function filmBeat(server: ReelServer, tab: Tab, section: ReelSection, beat: ReelBeat, dir: string, note: (text: string) => void): Promise<{ readonly exported: Exported; readonly seconds: number; readonly file: string }> {
  const alone: ReelSection = { ...section, beats: [beat] };
  await server.useCase(replayOf(beat));
  await openStage(server.url, tab);
  const played = await playSection(tab, alone, server.url);
  const stem = `${section.id}-${beat.id}`;
  const exported = await exportSection(tab, alone, played, join(dir, `${stem}.raw.mp4`), { ...REEL_SIZE }, (text) => note(text.replace(/^ {2}[a-z]+: /, `  ${stem}: `)));
  const seconds = exported.turns[exported.turns.length - 1]?.to ?? exported.seconds - TAIL;
  const file = join(dir, `${stem}.mp4`);
  await prepare(exported, seconds, file);
  return { exported, seconds, file };
}

/** Builds every piece of the plan (or those of the sections named), joins them, and writes the reel to `dir/reel.mp4`. */
export async function buildReel(plan: ReelPlan, dir: string, options: { readonly only?: readonly string[]; readonly note?: (text: string) => void } = {}): Promise<BuiltReel> {
  const note = options.note ?? (() => undefined);
  await mkdir(dir, { recursive: true });
  const server = await startReelServer();
  const made: { section: ReelSection; beat: ReelBeat; exported: Exported; seconds: number; file: string }[] = [];
  const tab = await Tab.open(1280, 800).catch(async (error: unknown) => {
    await server.stop();
    throw error;
  });
  try {
    // the first turn of a server that has just started is slow to its first line, and the film would hold that wait: one turn nobody sees, first
    await server.useCase([]);
    await openStage(server.url, tab);
    await settle(tab, await tab.eval<string>("window.__stage.playScript('scene warm solo\\nsay w | .\\nwait 0.1s')"));
    for (const section of plan.sections) {
      if (options.only !== undefined && !options.only.includes(section.id)) continue;
      for (const beat of section.beats) {
        const piece = await filmBeat(server, tab, section, beat, dir, (text) => (text.includes('100%') || text.includes('starting') ? note(text) : undefined));
        made.push({ section, beat, ...piece });
        note(`reel: ${section.name} / ${beat.id}: ${piece.seconds.toFixed(2)} s (table ${beat.seconds} s), ${Math.round(piece.exported.bytes / 1024)} KB${piece.exported.hasSound ? ', with sound' : ''}`);
      }
    }
  } finally {
    await tab.close();
    await server.stop();
  }
  const file = join(dir, 'reel.mp4');
  const joined = await joinSections(made.map((entry) => entry.file), file, dir);
  let at = 0;
  const pieces = made.map((entry): BuiltPiece => {
    const piece = { ...entry, at };
    at += entry.seconds;
    return piece;
  });
  const looked = await probe(file);
  return { file, seconds: looked.seconds, how: joined.how, why: joined.why, pieces, probe: looked };
}

export interface Still {
  readonly name: string;
  readonly at: number;
  readonly section: string;
  readonly beat: string;
  readonly caption: { readonly name: string; readonly caption: string } | null;
}

/** Where a still of each piece is taken from the reel: just before its last turn ends (a page at its rest, a card whole); the table's `still` where the page says its rest does not show it; the drag also half way. */
export function stillsOf(built: BuiltReel): Still[] {
  const out: Still[] = [];
  const reader = readShowcase();
  for (const piece of built.pieces) {
    const turns = piece.exported.turns;
    const last = turns[turns.length - 1];
    if (last === undefined) continue;
    const table = reader.entry(piece.beat.id);
    const rest = table?.still !== undefined ? (turns[0]?.start ?? 0) + table.still : last.to - 0.12;
    out.push({ name: `${piece.section.id}-${piece.beat.id}`, at: piece.at + Math.max(0, Math.min(rest, last.to - 0.02)), section: piece.section.id, beat: piece.beat.id, caption: piece.beat.caption });
    // looks: the page's rest is its last look; the others are on the way
    if (piece.beat.id === 'looks') for (const [index, delta] of [0.9, 1.9, 2.9].entries()) out.push({ name: `${piece.section.id}-looks-${index + 1}`, at: piece.at + (turns[0]?.start ?? 0) + delta, section: piece.section.id, beat: 'looks', caption: piece.beat.caption });
    // the drag, with the knob on its way: the drag is the first 1.1 s of the second turn's lead
    if (piece.beat.id === 'drag' && turns[1] !== undefined) out.push({ name: `${piece.section.id}-drag-mid`, at: piece.at + turns[1].from + 0.55, section: piece.section.id, beat: 'drag', caption: piece.beat.caption });
  }
  return out;
}

/** Writes each still as a PNG into `dir`, and contact sheets (`sheet-1.png`, ...) of them in reel order, `columns` across. */
export async function writeStills(reel: string, stills: readonly Still[], dir: string, columns = 3, rows = 3): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const files: string[] = [];
  for (const still of stills) {
    const file = join(dir, `${still.name}.png`);
    const made = await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', still.at.toFixed(3), '-i', reel, '-frames:v', '1', file]);
    if (made.code !== 0) throw new Error(`no still at ${still.at.toFixed(2)} s for ${still.name}: ${made.err.slice(-200)}`);
    files.push(file);
  }
  const sheets: string[] = [];
  const per = columns * rows;
  const tile = Math.floor(1920 / columns);
  const tileHeight = Math.round((tile * 9) / 16);
  for (let first = 0; first < files.length; first += per) {
    const chunk = files.slice(first, first + per);
    const sheet = join(dir, `sheet-${first / per + 1}.png`);
    const inputs = chunk.flatMap((file) => ['-i', file]);
    const scaled = chunk.map((_, index) => `[${index}:v]scale=${tile}:${tileHeight}[s${index}]`).join(';');
    const layout = chunk.map((_, index) => `${(index % columns) * tile}_${Math.floor(index / columns) * tileHeight}`).join('|');
    const stacked = chunk.length === 1 ? '[s0]null[out]' : `${chunk.map((_, index) => `[s${index}]`).join('')}xstack=inputs=${chunk.length}:layout=${layout}[out]`;
    const made = await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...inputs, '-filter_complex', `${scaled};${stacked}`, '-map', '[out]', '-frames:v', '1', sheet]);
    if (made.code !== 0) throw new Error(`no contact sheet: ${made.err.slice(-300)}`);
    sheets.push(sheet);
  }
  return sheets;
}

export function summary(built: BuiltReel, plan: ReelPlan): string[] {
  const v = built.probe.video;
  const lines = [`reel: ${built.file}`, `  ${built.seconds.toFixed(2)} s (by the table ${plan.seconds} s), ${v?.width}x${v?.height} at ${v?.fps} fps, ${v?.codec}, audio ${built.probe.audio === null ? 'none' : `${built.probe.audio.codec} ${built.probe.audio.rate} Hz x${built.probe.audio.channels}`}, joined by ${built.how === 'copy' ? 'stream copy' : `re-encoding (${built.why})`}`];
  for (const piece of built.pieces) {
    const turns = piece.exported.turns.map((turn) => `${(turn.start - turn.from).toFixed(1)}+${(turn.to - turn.start).toFixed(2)}`).join(' ');
    lines.push(`  ${piece.at.toFixed(1).padStart(5)}  ${piece.section.id.padEnd(9)} ${piece.beat.id.padEnd(14)} ${piece.seconds.toFixed(2).padStart(5)} s (table ${String(piece.beat.seconds).padStart(3)})  lead+own: ${turns}${piece.exported.hasSound ? '  sound' : ''}`);
  }
  for (const text of plan.left) lines.push(`  left out: ${text}`);
  return lines;
}

export async function size(file: string): Promise<number> {
  return (await stat(file)).size;
}


// ------------------------------------------------------------------------------------------------------------------------------------------------ the check group

/** a stat of one frame's region, from ffmpeg's `signalstats`: the darkest pixel (Y, 0..255) is the ink of whatever words are in it */
async function darkest(file: string, at: number, box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }): Promise<number> {
  const out = await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', at.toFixed(3), '-i', file, '-frames:v', '1', '-vf', `crop=${box.width}:${box.height}:${box.x}:${box.y},format=gray,signalstats,metadata=mode=print:key=lavfi.signalstats.YMIN:file=-`, '-f', 'null', '-']);
  const found = /YMIN=(\d+)/.exec(out.out);
  if (found?.[1] === undefined) throw new Error(`no frame at ${at.toFixed(2)} s of ${file}: ${out.err.slice(-200)}`);
  return Number(found[1]);
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The words a page puts on stage that must be whole: their boxes at rest, in the stage's own pixels, with what each is. */
interface Standing {
  readonly id: string;
  readonly kind: string;
  readonly text: string;
  readonly opacity: number;
  readonly box: Box;
}

/** A tab whose stage is exactly `size`: the window is the size plus what the page keeps round the stage (its own prompt box), found by asking the page. */
async function stageTab(base: string, size: { readonly width: number; readonly height: number }): Promise<Tab> {
  const tab = await Tab.open(size.width, size.height + 120);
  try {
    await openStage(base, tab);
    const seen = async (): Promise<{ readonly width: number; readonly height: number }> => tab.eval<{ width: number; height: number }>('(() => { const v = window.__stage.state().viewport; return { width: v.width, height: v.height }; })()');
    const first = await seen();
    const window_ = { width: size.width + (size.width - first.width), height: size.height + 120 + (size.height - first.height) };
    await tab.send('Emulation.setDeviceMetricsOverride', { width: window_.width, height: window_.height, deviceScaleFactor: 1, mobile: false });
    for (let waited = 0; waited < 5000; waited += 100) {
      const now = await seen();
      if (now.width === size.width && now.height === size.height) return tab;
      await sleep(100);
    }
    throw new Error(`could not make the stage ${size.width}x${size.height} (it is ${JSON.stringify(await seen())})`);
  } catch (error) {
    await tab.close();
    throw error;
  }
}

/**
 * How much of the panel the film stands a caption in is ink on the stage as it is drawn now: the share of the panel's pixels that differ from its own median colour (the ground, under
 * words) by more than a mark does. The panel is worked out here as web/src/app/film-labels.ts works it (`setCaption` and `paintCaption`: the name at 34 px and the words at 22 on a stage
 * 1920 wide, the words wrapped to 0.36 of the stage's width, the panel as wide as its widest row is in the face the film draws it in, 36 px from its corner), and the stage's own picture
 * (`capture`) has no caption in it.
 */
async function inkUnder(tab: Tab, stage: { readonly width: number; readonly height: number }, caption: NonNullable<ReelBeat['caption']>): Promise<number> {
  return tab.eval<number>(`(async () => {
    const W = ${stage.width}, H = ${stage.height}, at = ${JSON.stringify(caption.at ?? 'bottom-left')};
    const FACE = 'system-ui, -apple-system, "Segoe UI", sans-serif';
    const [nameSize, wordsSize, pad, gap, margin] = [34, 22, 20, 7, 36];
    const room = Math.max(wordsSize * 8, W * 0.36 - pad * 2 - margin);
    const wrap = (text, size, least) => {
      const cols = Math.max(least, Math.floor(room / (size * 0.5)));
      const rows = [];
      let row = '';
      for (const word of text.replace(/\\s+/g, ' ').trim().split(' ')) {
        if (row !== '' && [...row].length + 1 + [...word].length > cols) { rows.push(row); row = word; } else row = row === '' ? word : row + ' ' + word;
      }
      if (row !== '') rows.push(row);
      return rows;
    };
    const nameRows = wrap(${JSON.stringify(caption.name)}, nameSize, 6), wordRows = wrap(${JSON.stringify(caption.caption)}, wordsSize, 8);
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = '600 ' + nameSize + 'px ' + FACE;
    let wide = Math.max(0, ...nameRows.map((r) => ctx.measureText(r).width));
    ctx.font = '400 ' + wordsSize + 'px ' + FACE;
    wide = Math.max(wide, ...wordRows.map((r) => ctx.measureText(r).width));
    const width = wide + pad * 1.34 + pad;
    const height = pad * 2 + nameRows.length * nameSize * 1.2 + (wordRows.length > 0 ? gap + wordRows.length * wordsSize * 1.35 : 0);
    const box = { x: at === 'bottom-right' ? W - margin - width : margin, y: at === 'top-left' ? margin : H - margin - height, width, height };
    const url = await window.__stage.capture(${Math.max(stage.width, stage.height)});
    if (url === null) return -1;
    const img = new Image();
    img.src = url;
    await img.decode();
    const k = img.width / W;
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const g = canvas.getContext('2d');
    g.drawImage(img, 0, 0);
    const x = Math.max(0, Math.round(box.x * k)), y = Math.max(0, Math.round(box.y * k));
    const w = Math.min(img.width - x, Math.round(box.width * k)), h = Math.min(img.height - y, Math.round(box.height * k));
    const px = g.getImageData(x, y, w, h).data;
    const median = [0, 1, 2].map((c) => { const v = []; for (let i = c; i < px.length; i += 4) v.push(px[i]); v.sort((a, b) => a - b); return v[v.length >> 1]; });
    let ink = 0;
    for (let i = 0; i < px.length; i += 4) if (Math.abs(px[i] - median[0]) + Math.abs(px[i + 1] - median[1]) + Math.abs(px[i + 2] - median[2]) > 90) ink += 1;
    return ink / (w * h);
  })()`);
}

/** Pages whose picture is the whole stage (a painting, edge to edge): a caption stands over some of it, which is what a caption over a picture is. */
const FULL_BLEED: ReadonlySet<string> = new Set(['paint']);

/** A page played to its rest at once (the stage's own "show all") rather than in real time: what its stage looks like when it is done. */
async function restOf(tab: Tab, beat: ReelBeat): Promise<readonly Standing[]> {
  let first: string | null = null;
  for (const step of beat.steps) {
    const source = step.kind === 'script' ? step.source : step.kind === 'prompt' || step.kind === 'tap' ? step.answer : null;
    if (source === null) continue;
    const id: string = await tab.eval<string>(`window.__stage.playScript(${JSON.stringify(source.replaceAll('{1}', first ?? 't1'))})`);
    first ??= id;
    await sleep(250);
    await tab.eval('window.__stage.showAll()');
    await settle(tab, id);
    await sleep(900);
  }
  return tab.eval<Standing[]>('window.__stage.elements().map((e) => ({ id: e.id, kind: e.kind, text: String(e.text || ""), opacity: e.opacity, box: e.box }))');
}

/** What is wrong with a page at rest on a stage `size`: words cut by its edge, and a thing mostly off it. */
export function fitProblems(who: string, rest: readonly Standing[], size: { readonly width: number; readonly height: number }): string[] {
  const problems: string[] = [];
  const slack = 2;
  for (const element of rest) {
    if (element.opacity < 0.3 || element.box.width <= 0 || element.box.height <= 0) continue;
    const { x, y, width, height } = element.box;
    const inside = Math.max(0, Math.min(x + width, size.width) - Math.max(x, 0)) * Math.max(0, Math.min(y + height, size.height) - Math.max(y, 0));
    const share = inside / (width * height);
    const name = `${element.kind} ${element.id}${element.text === '' ? '' : ` "${element.text.slice(0, 24)}"`}`;
    if (element.kind === 'text' && (x < -slack || y < -slack || x + width > size.width + slack || y + height > size.height + slack)) problems.push(`${who}: ${name} runs off the stage (${Math.round(x)},${Math.round(y)} ${Math.round(width)}x${Math.round(height)} on ${size.width}x${size.height})`);
    else if (element.kind !== 'text' && share < 0.5) problems.push(`${who}: ${name} is only ${Math.round(share * 100)}% on the stage`);
  }
  return problems;
}

const result = (check: string, problems: readonly string[], good: string): CheckResult => ({ turn: 0, check, verdict: problems.length === 0 ? 'PASS' : 'FAIL', detail: problems.length === 0 ? good : problems.slice(0, 8).join(' | ') });

/** the table's reel and the plan made from it: the seconds, and that nothing in it is lost without being said */
export function planProblems(reader: ShowcaseReader = readShowcase(), plan: ReelPlan = reelPlan({ reader })): string[] {
  const problems: string[] = [];
  const seconds = reader.reelSeconds();
  if (seconds < SHOWCASE_REEL.min || seconds > SHOWCASE_REEL.max) problems.push(`the table's reel is ${seconds} s (${SHOWCASE_REEL.min}..${SHOWCASE_REEL.max})`);
  if (plan.seconds < SHOWCASE_REEL.min || plan.seconds > SHOWCASE_REEL.max) problems.push(`the plan's reel is ${plan.seconds} s (${SHOWCASE_REEL.min}..${SHOWCASE_REEL.max})`);
  const planned = new Set(plan.sections.flatMap((section) => section.beats.map((beat) => beat.id)));
  for (const entry of reader.reel()) {
    if (!planned.has(entry.id) && !plan.left.some((text) => text.startsWith(`${entry.id}:`))) problems.push(`${entry.id} has seconds in the reel and is neither in the plan nor said to be left out`);
  }
  const sections = plan.sections.map((section) => section.id);
  if (sections[0] !== 'opening' || sections[sections.length - 1] !== 'close') problems.push('the reel does not begin with the opening and end with the close');
  for (const section of plan.sections) for (const beat of section.beats) for (const step of beat.steps) if (step.kind === 'script' && step.source.trim() === '') problems.push(`${beat.id} has no page`);
  return problems;
}

/**
 * pnpm check's showcase-reel group (no model): the table's reel and the plan (60..90 s, nothing lost unsaid); in a real Chrome, a 5 s piece of the "Words" section exported at the reel's
 * own size and rate (over 50 KB, 1920x1080, its length, the tag in its frames); a page that takes a tap, whose caption stands through the turn between (a caption that left and came back
 * would flicker); the music page exported with sound that can be heard; and every page of the reel at rest on its section's own stage, with no words cut by its edge and none under its caption.
 */
export async function showcaseReelGroup(note: (text: string) => void = () => undefined, dir: string = join(tmpdir(), 'conduit-reel-check')): Promise<CheckResult[]> {
  await mkdir(dir, { recursive: true });
  const reader = readShowcase();
  const plan = reelPlan({ reader });
  const results: CheckResult[] = [result('reel-plan', planProblems(reader, plan), `the table's reel is ${reader.reelSeconds()} s and the plan ${plan.seconds} s for ${plan.pages} pages in ${plan.sections.length} sections; left out and said so: ${plan.left.map((text) => text.split(':')[0]).join(', ')}`)];
  const beatOf = (id: string): { readonly section: ReelSection; readonly beat: ReelBeat } => {
    for (const section of plan.sections) for (const beat of section.beats) if (beat.id === id) return { section, beat };
    throw new Error(`the reel has no ${id}`);
  };
  // while a check is being proved to bite, `REEL_CHECK=fit` (or `export`, for the piece, the caption and the music) runs only that half
  const only = (process.env['REEL_CHECK'] ?? '').split(',').filter((name) => name !== '');
  const wants = (name: string): boolean => only.length === 0 || only.includes(name);
  if (wants('fit')) results.push(await fitCheck(plan, note));
  if (!wants('export')) return results;
  note('showcase-reel: server and Chrome');
  const server = await startReelServer();
  let tab: Tab | null = null;
  /** each half stands on its own: one that cannot be made says so, and the others are still run */
  const guarded = async (check: string, body: (tab: Tab) => Promise<CheckResult>): Promise<void> => {
    try {
      if (tab === null) throw new Error('no Chrome');
      results.push(await body(tab));
    } catch (error) {
      results.push({ turn: 0, check, verdict: 'FAIL', detail: `stopped: ${error instanceof Error ? (error.stack ?? error.message).split('\n').slice(0, 3).join(' ') : String(error)}` });
    }
  };
  try {
    tab = await Tab.open(1280, 800);
    // 1. a 5 s piece of the Words section, at the reel's own size and rate: card, then big type, in one session
    await guarded('reel-piece', async (page) => {
      const words = plan.sections.find((section) => section.id === 'words');
      if (words === undefined) throw new Error('the reel has no Words section');
      const piece: ReelSection = { ...words, beats: words.beats.slice(0, 2) };
      await server.useCase([]);
      await openStage(server.url, page);
      const played = await playSection(page, piece, server.url);
      const file = join(dir, 'piece.mp4');
      const exported = await exportSection(page, piece, played, file, { ...REEL_SIZE, from: 0, to: 5 }, () => undefined);
      const problems: string[] = [];
      const looked = await probe(file);
      if (exported.bytes <= 50 * 1024) problems.push(`the 5 s piece is ${exported.bytes} bytes (over 50 KB wanted)`);
      if (Math.abs(looked.seconds - 5) > 0.25) problems.push(`the piece is ${looked.seconds.toFixed(2)} s, not 5`);
      if (looked.video === null || looked.video.width !== 1920 || looked.video.height !== 1080) problems.push(`the piece is ${looked.video?.width}x${looked.video?.height}, not 1920x1080`);
      if (looked.video !== null && Math.abs(looked.video.fps - 30) > 0.5) problems.push(`the piece is ${looked.video.fps} fps, not 30`);
      const tag = await darkest(file, Math.max(0, Math.min(2.0, looked.seconds - 0.2)), { x: 1500, y: 10, width: 400, height: 80 });
      if (tag > 150) problems.push(`the tag is not in the frame (the darkest pixel of its corner is ${tag})`);
      return result('reel-piece', problems, `a 5 s piece of Words at ${looked.video?.width}x${looked.video?.height}, ${looked.video?.fps} fps, ${looked.video?.codec}: ${Math.round(exported.bytes / 1024)} KB, ${looked.seconds.toFixed(2)} s, the tag in its frames (darkest pixel ${tag})`);
    });

    // 2. the page that takes a tap: its caption stands through the turn between the two
    await guarded('reel-caption-holds', async (page) => {
      const tapPart = beatOf('tap');
      const section: ReelSection = { ...tapPart.section, beats: [tapPart.beat] };
      await server.useCase(replayOf(tapPart.beat));
      await openStage(server.url, page);
      const tapped = await playSection(page, section, server.url);
      const tapFile = join(dir, 'tap.mp4');
      const tapMade = await exportSection(page, section, tapped, tapFile, { ...REEL_SIZE, fps: 15 }, () => undefined);
      const second = tapMade.turns[1];
      const kept: string[] = [];
      if (second === undefined) kept.push('the tap page has one turn in the film');
      else {
        // the caption's words, in the part of the stage it stands in (above the input box of "Ask it")
        const stage = stageOf(tapPart.section);
        const region: Box = { x: 40, y: stage.height - 36 - 190, width: 560, height: 190 };
        const before = await darkest(tapFile, second.from - 0.6, region);
        const deltas = [-0.12, 0, 0.12, 0.3];
        const across = await Promise.all(deltas.map((delta) => darkest(tapFile, second.from + delta, region)));
        if (before > 140) kept.push(`the caption is not on screen before the tap (darkest pixel ${before})`);
        for (const [index, ink] of across.entries()) if (ink > 140) kept.push(`the caption has left the screen ${deltas[index]} s from the tap (darkest pixel ${ink}, ${before} before): it would flicker`);
      }
      return result('reel-caption-holds', kept, `the caption of "Tap an answer" stands through the tap that opens its second turn`);
    });

    // a page whose words reach the bottom-left corner asks for the other (`at`), and the file has its caption there and nothing in the corner it left
    await guarded('reel-caption-side', async (page) => {
      const sidePart = beatOf('alphabets');
      const section: ReelSection = { ...sidePart.section, beats: [sidePart.beat] };
      await server.useCase([]);
      await openStage(server.url, page);
      const played = await playSection(page, section, server.url);
      const file = join(dir, 'alphabets.mp4');
      // at the reel's own size (the page lays its words out for the picture, so a smaller one is not the same page), a few frames a second
      const made = await exportSection(page, section, played, file, { width: REEL_SIZE.width, height: REEL_SIZE.height, fps: 10 }, () => undefined);
      const problems: string[] = [];
      const rest = (made.turns[made.turns.length - 1]?.to ?? 1) - 0.25;
      const right = await darkest(file, rest, { x: 1300, y: 960, width: 560, height: 70 });
      const left = await darkest(file, rest, { x: 40, y: 960, width: 560, height: 70 });
      if (right > 150) problems.push(`the caption is not at the bottom right (the darkest pixel there is ${right})`);
      if (left < 200) problems.push(`something stands at the bottom left, where the caption would be by default (the darkest pixel there is ${left})`);
      return result('reel-caption-side', problems, `a page that asks for it has its caption at the bottom right and the corner it left is clear (darkest pixel ${right} there, ${left} here)`);
    });

    // 3. music: the page with sound exported with sound, at a lower size, and the sound is not silence
    await guarded('reel-music', async (page) => {
      const musicPart = beatOf('music');
      const section: ReelSection = { ...musicPart.section, beats: [musicPart.beat] };
      await server.useCase(replayOf(musicPart.beat));
      await openStage(server.url, page);
      const played = await playSection(page, section, server.url);
      const file = join(dir, 'music.mp4');
      const made = await exportSection(page, section, played, file, { width: 640, height: 360, fps: 10 }, () => undefined);
      const problems: string[] = [];
      const looked = await probe(file);
      if (!made.hasSound) problems.push('the exporter says the music is not in the file');
      if (looked.audio === null) problems.push('the file has no audio stream');
      const peak = looked.audio === null ? null : await loudness(file);
      if (peak !== null && peak < -40) problems.push(`the sound is silence (peak ${peak} dB)`);
      return result('reel-music', problems, `"A tune you can hear" exports with sound: ${looked.audio?.codec} ${looked.audio?.rate} Hz, peak ${peak} dB`);
    });
  } catch (error) {
    results.push({ turn: 0, check: 'reel-export', verdict: 'FAIL', detail: `stopped: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}` });
  } finally {
    await tab?.close();
    await server.stop();
  }

  return results;
}

/** every page at rest on its section's own stage: nothing cut by the edge, nothing under its caption */
async function fitCheck(plan: ReelPlan, note: (text: string) => void): Promise<CheckResult> {
  const fits: string[] = [];
  let looked = 0;
  const stages = new Map<string, { readonly width: number; readonly height: number }>();
  for (const section of plan.sections) stages.set(`${stageOf(section).width}x${stageOf(section).height}`, stageOf(section));
  const fitServer = await startReelServer();
  try {
    for (const size of stages.values()) {
      note(`showcase-reel: pages on a ${size.width}x${size.height} stage`);
      const stage = await stageTab(fitServer.url, size);
      try {
        for (const section of plan.sections) {
          const here = stageOf(section);
          if (here.width !== size.width || here.height !== size.height) continue;
          for (const beat of section.beats) {
            await fitServer.useCase(replayOf(beat));
            await openStage(fitServer.url, stage);
            const rest = await restOf(stage, beat);
            fits.push(...fitProblems(beat.id, rest, here));
            if (beat.caption !== null && !FULL_BLEED.has(beat.id)) {
              const ink = await inkUnder(stage, here, beat.caption);
              if (ink < 0) fits.push(`${beat.id}: the stage could not be captured`);
              else if (ink > 0.002) fits.push(`${beat.id}: the caption stands over the page (${(ink * 100).toFixed(1)}% of its panel is ink)`);
            }
            looked += 1;
          }
        }
      } finally {
        await stage.close();
      }
    }
  } catch (error) {
    fits.push(`stopped: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  } finally {
    await fitServer.stop();
  }
  return result('reel-fit', fits, `${looked} cards and pages at rest on their sections' own stages (${[...stages.values()].map((size) => `${size.width}x${size.height}`).join(', ')}): no words off the stage, none under a caption (pixels of the stage under each caption's panel)`);
}
