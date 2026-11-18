// pnpm check's showcase group: "What Conduit can do". No model, no account. The table (language/src/showcase.ts) says what each page claims; this plays the
// pages the language holds (language/demos/showcase/<category>.series, the turns after a page's own scene from the table) on a replay server that has a recorded case, at 1280x720
// and 390x844, and holds the table and the painter to each other.
//
//   page      each live page is played in a tab of its own and judged like a demo (check.ts `judge`): it comes to rest, every line reads, nothing overlaps or is cut off, every
//             line of words is really drawn (footprints), there is ink in each box, nothing covers the stage, no console error and no failed request. Every turn of a page is
//             judged at its own rest (`showcase-sum`, `showcase-sum#2`)
//   expect    each id the page claims to show is on stage at rest, opaque, on the screen, with ink in its box
//   hands     a page with something to work is worked with real input (Tab.drag, Tab.tap, real keys), in the stage's own page:
//             drag      the slider is dragged along its track to both ends and the middle: the value follows, everything the page expects moves with it, the words that
//                       name its value change, and no turn is sent (no round trip)
//             switch    a real tap on the pick and on the switch each change the drawing, with no turn sent
//             type      the prompt is typed with real keys and sent with Enter; the replay brain answers it from the recorded case, and that answer is the page
//             tap       a real tap on the choice sends it as a turn; the recorded case answers it, and the answer is judged as the page's second scene
//             sum       the answer is written in the blank and marked right; the act turn that tells the brain is answered by the recorded case, so the page holds
//             undo      (on `changes`, the page that changes a drawing in place) the Undo chip stands after the second turn and a real tap on it puts the first drawing back
//             photo     the picture is the person's own turn (put up as u1), and each callout's leader reaches its spot
//             app       the app in its locked box loaded, ran, threw nothing and drew something
//   table     the table and the painter agree both ways, from what the page says it can paint (the `ready` event's capabilities): a live page needs nothing unpainted; a
//             "not yet" entry whose needs are all painted now fails ("code is painted now: write its page"); a structure the painter paints that no live page needs fails
//
// The replay server's case (`showcaseCase`) answers three turns of one session each: the typed prompt, the tap, and the act turn of `sum`. Run by `pnpm check` (`--only showcase`);
// SHOWCASE_ONLY=sum,type plays just those pages.

import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOOK, LineReader, parseLine, readShowcase } from '@conduit/language';
import type { LookId } from '@conduit/language';
import type { Capabilities, ShowcaseEntry, ShowcaseReader } from '@conduit/language';
import { sleep } from './explore-browser';
import { MIN_INK_SHARE, MIN_LINE_INK_PX, MIN_TEXT_INK_SHARE, testPattern } from './real-check';
import type { Footprint } from './real-check';
import type { Conversation, Tab } from './smoke';
import type { CheckResult } from './smoke';

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface Piece {
  readonly id: string;
  readonly kind: string;
  readonly text: string;
  readonly phase: string;
  readonly opacity: number;
  readonly tappable: boolean;
  readonly colour: string | null;
  readonly box: Box;
}

interface Ctl {
  readonly id: string;
  readonly control: string;
  readonly options: readonly string[];
  readonly min: number;
  readonly max: number;
  readonly value: unknown;
  readonly valueText: string;
  readonly parts: readonly { readonly part: string; readonly box: Box }[];
  readonly box: Box;
  readonly askState?: { readonly verdict: string };
}

/** What a judged scene gives back: its results, which a page's own questions are added to. */
interface Judged {
  readonly results: CheckResult[];
}

/** What the group needs of check.ts's `Screen`: a tab, the judge every scene gets, and what the judge learned. A closure over the class, so its private parts stay private. */
export interface ShowcaseHost {
  /** the replay server with the recorded case */
  readonly base: string;
  readonly timeoutMs: number;
  note(text: string): void;
  open(): Promise<{ readonly tab: Tab; readonly talk: Conversation }>;
  look(tab: Tab): Promise<void>;
  judge(tab: Tab, talk: Conversation, name: string, results: CheckResult[], began: number, options: { readonly footprints: boolean; readonly photo?: readonly (readonly [string, number, number])[] }): Promise<Judged>;
  /** what hiding each line of words showed, as the last `judge` found it */
  feet(): ReadonlyMap<string, Footprint>;
  appsLooked(tab: Tab): Promise<void>;
  apps(tab: Tab): Promise<readonly { readonly id: string; readonly running: boolean; readonly loaded: boolean; readonly crashes: number; readonly blank: boolean | null; readonly box: Box }[]>;
  sessionOf(tab: Tab): Promise<string | null>;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The pages

const norm = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();
const area = (b: Box): number => Math.max(0, b.width) * Math.max(0, b.height);

/** the pages of one category's file, by scene id: each is the lines from its `scene` line down to the next */
export function pageSources(category: string): Map<string, string> {
  const path = fileURLToPath(import.meta.resolve(`@conduit/language/demos/showcase/${category}.series`));
  const pages = new Map<string, string>();
  if (!existsSync(path)) return pages;
  let id: string | null = null;
  let lines: string[] = [];
  const close = (): void => {
    if (id === null) return;
    while (lines.length > 0 && (lines[lines.length - 1] as string).trim() === '') lines.pop();
    if (!pages.has(id)) pages.set(id, lines.join('\n'));
  };
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    if (/^scene(\s|$)/.test(raw)) {
      close();
      const read = parseLine(raw);
      id = read.kind === 'line' && read.line.verb === 'scene' ? (read.line.id ?? null) : null;
      lines = [raw];
    } else if (id !== null && !raw.trimStart().startsWith('#')) lines.push(raw);
  }
  close();
  return pages;
}

/** the effects of a look that move pixels on a stage that is standing still: two pictures of it differ, which the footprint judge would read as ink */
const MOVING_FX = ['persistence', 'signal'];

/** whether the look a page ends in (its last `look` line) has an effect that moves while the stage rests: the phosphor terminal and teletext */
function endsMoving(scripts: readonly string[]): boolean {
  const looks = [...scripts.join('\n').matchAll(/^look\s+(\S+)/gm)].map((found) => found[1] as string);
  const last = looks[looks.length - 1] as LookId | undefined;
  return last !== undefined && LOOK[last]?.fx.some((name) => MOVING_FX.includes(name)) === true;
}

/** the lines of a script that the language rejects: the page would skip each without a word */
function rejectedLines(source: string): string[] {
  const reader = new LineReader();
  const bad: string[] = [];
  source.split('\n').forEach((raw, index) => {
    const result = reader.read(raw);
    if (result.kind === 'reject') bad.push(`line ${index + 1} "${raw.slice(0, 50)}": ${result.issues.map((issue) => issue.message).join('; ')}`);
  });
  return bad;
}

/** the pages a category holds that can be played: its live entries that are not a hand or a recording */
export function livePages(reader: ShowcaseReader, category: string): ShowcaseEntry[] {
  return reader.band(category).filter((entry) => entry.page !== 'hand' && entry.page !== 'recorded');
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The recorded case

/** what `type`'s hand types: the case answers exactly these words with the page's own lines */
export const TYPED = 'Why is the sky blue?';

/** the choice `tap`'s hand taps */
export const TAPPED = 'Orange';

/** the brain's answer to a right answer on `sum`: it has nothing to add, so the page holds as it was marked */
const SUM_REPLY = 'wait 0.2s';

/** The case file the replay brain answers from (REPLAY_CASE): the typed question, the tap, and the act turn of `sum`, in the order they are asked and each once a session. */
export async function showcaseCase(): Promise<string> {
  const reader = readShowcase();
  const type = pageSources('ask').get('type');
  const tap = reader.entry('tap')?.turns?.[0];
  if (type === undefined || tap === undefined) throw new Error('the showcase case needs the page `type` and the first turn of `tap`');
  const dir = await mkdtemp(join(tmpdir(), 'conduit-showcase-'));
  const file = join(dir, 'case.json');
  await writeFile(file, JSON.stringify({ turns: [{ match: TYPED, script: type }, { match: 'kind:tap', script: tap }, { match: 'kind:act', script: SUM_REPLY }] }));
  return file;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The table and the painter

/** whether the painter paints what a `needs` entry names. A `feature` is a name the painter has no list for, so nothing says it is painted. */
export function painted(need: string, caps: Capabilities): boolean {
  const [dimension, name = ''] = need.split(':');
  const lists: Readonly<Record<string, readonly string[]>> = {
    structure: caps.structures,
    chart: caps.charts,
    control: caps.controls,
    medium: caps.media,
    look: caps.looks,
    camera: caps.camera,
    ambient: caps.ambient,
    fx: caps.fx,
    texture: caps.textures,
    brush: caps.brushes,
    kind: caps.kinds,
  };
  if (dimension === 'flag') return (caps as unknown as Readonly<Record<string, unknown>>)[name] === true;
  return lists[dimension ?? '']?.includes(name) ?? false;
}

/** The table held to the painter, both ways, as results a run prints. */
export function tableResults(reader: ShowcaseReader, caps: Capabilities | null): CheckResult[] {
  const out: CheckResult[] = [];
  const add = (check: string, problems: readonly string[], good: string): void => void out.push({ turn: 0, check, verdict: problems.length === 0 ? 'PASS' : 'FAIL', detail: problems.length === 0 ? good : problems.join('; ') });
  if (caps === null) {
    add('showcase-painter', ['the page never said what it can paint (no `ready` event in the hook)'], '');
    return out;
  }
  const live = reader.live();
  const unpainted: string[] = [];
  for (const entry of live) for (const need of entry.needs) if (!painted(need, caps)) unpainted.push(`${entry.id} needs ${need}, which the painter does not paint`);
  add('showcase-needs', unpainted, `every need of the ${live.length} live entries is painted (${live.reduce((sum, entry) => sum + entry.needs.length, 0)} needs)`);
  const now: string[] = [];
  for (const entry of reader.notYet()) if (entry.needs.length > 0 && entry.needs.every((need) => painted(need, caps))) now.push(`${entry.id} is painted now (${entry.needs.join(', ')}): write its page`);
  add('showcase-not-yet', now, `none of the ${reader.notYet().length} "not yet" entries has all it needs painted`);
  const wanted = new Set(live.flatMap((entry) => entry.needs.filter((need) => need.startsWith('structure:')).map((need) => need.slice('structure:'.length))));
  const orphans = caps.structures.filter((kind) => !wanted.has(kind)).map((kind) => `the painter paints the structure "${kind}" and no live page needs it`);
  add('showcase-structures', orphans, `each of the ${caps.structures.length} structures the painter paints (${caps.structures.join(', ')}) is the need of a live page`);
  return out;
}

/** What the painter said it can paint: the `ready` event the page sent, from the hook's list of what it handed the link. */
export async function painterCaps(tab: Tab): Promise<Capabilities | null> {
  const events = await tab.eval<readonly { readonly type: string; readonly capabilities?: Capabilities }[]>('window.__stage.events()');
  return events.find((event) => event.type === 'ready')?.capabilities ?? null;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// One page

const pieces = (tab: Tab): Promise<Piece[]> => tab.eval<Piece[]>('window.__stage.elements().map((e) => ({ id: e.id, kind: e.kind, text: String(e.text || ""), phase: e.phase, opacity: e.opacity, tappable: Boolean(e.tappable), colour: e.colour || null, box: e.box }))');
const controls = (tab: Tab): Promise<Ctl[]> => tab.eval<Ctl[]>('window.__stage.controls().map((c) => ({ id: c.id, control: c.control, options: c.options, min: c.min, max: c.max, value: c.value, valueText: c.valueText, parts: c.parts, box: c.box, askState: c.askState }))');
const centre = (box: Box): { x: number; y: number } => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

/** the drawing as numbers (where, how big, how opaque and what colour every drawn thing is) and the words on stage: what a control that does something changes */
const drawing = async (tab: Tab): Promise<{ readonly shapes: string; readonly words: string }> => {
  const all = (await pieces(tab)).filter((piece) => piece.kind !== 'control');
  return {
    shapes: JSON.stringify(all.map((piece) => [piece.id, Math.round(piece.box.x), Math.round(piece.box.y), Math.round(piece.box.width), Math.round(piece.box.height), Math.round(piece.opacity * 100), piece.colour])),
    words: all.filter((piece) => piece.kind === 'text').map((piece) => piece.text).join(' | '),
  };
};

/** the drawing standing still for three looks in a row, after the stage's own rest */
async function settled(tab: Tab, talk: Conversation): Promise<{ readonly shapes: string; readonly words: string }> {
  await talk.rest(null, false);
  let last = await drawing(tab);
  for (let still = 0; still < 3; ) {
    await sleep(250);
    const now = await drawing(tab);
    still = now.shapes === last.shapes && now.words === last.words ? still + 1 : 0;
    last = now;
  }
  return last;
}

const play = (tab: Tab, script: string): Promise<{ readonly id: string | null; readonly error: string | null }> =>
  tab.eval(`Promise.resolve(window.__stage.playScript(${JSON.stringify(script)})).then((id) => ({ id: String(id), error: null }), (e) => ({ id: null, error: String(e && e.message || e) }))`);

const restResult = (note: string, began: number): CheckResult => ({ turn: 0, check: 'rest', verdict: note === '' ? 'PASS' : 'FAIL', detail: note === '' ? `at rest ${((Date.now() - began) / 1000).toFixed(0)} s after the start` : note });

interface Hand {
  readonly host: ShowcaseHost;
  readonly tab: Tab;
  readonly talk: Conversation;
  readonly entry: ShowcaseEntry;
  /** what stood on stage at the rest of each turn, in turn order */
  readonly after: readonly (readonly Piece[])[];
}

/** a hand returns what went wrong, and what it saw when nothing did */
type Worked = { readonly problems: string[]; readonly saw: string };

/** drag: the slider follows a real drag along its track, the picture follows the slider, and nothing is sent */
async function dragHand(hand: Hand): Promise<Worked> {
  const { tab, talk, entry } = hand;
  const problems: string[] = [];
  const slider = (await controls(tab)).find((control) => control.control === 'slider');
  if (slider === undefined) return { problems: ['there is no slider on stage'], saw: '' };
  const track = slider.parts.find((part) => part.part === 'track')?.box ?? slider.box;
  const y = track.y + track.height / 2;
  const at = (share: number): { x: number; y: number } => ({ x: track.x + 2 + (track.width - 4) * share, y });
  const value = async (): Promise<number> => Number((await controls(tab)).find((control) => control.id === slider.id)?.value);
  const placed = async (): Promise<Map<string, Box>> => new Map((await pieces(tab)).filter((piece) => piece.kind !== 'control').map((piece) => [piece.id, piece.box]));
  const sent = tab.posted.length;
  await tab.drag(at(0), at(0));
  const low = await settled(tab, talk);
  const lowAt = await placed();
  await tab.drag(at(0), at(1));
  const high = await settled(tab, talk);
  const highAt = await placed();
  const top = await value();
  await tab.drag(at(1), at(0.5));
  const middle = await value();
  await settled(tab, talk);
  if (Math.abs(top - slider.max) > 0.05 * (slider.max - slider.min)) problems.push(`a drag to the end of the track left the slider at ${String(top)}, not ${slider.max}`);
  if (Math.abs(middle - (slider.min + slider.max) / 2) > 0.1 * (slider.max - slider.min)) problems.push(`a drag to the middle of the track left the slider at ${String(middle)}`);
  if (low.shapes === high.shapes) problems.push('dragging the slider from one end to the other changed nothing in the drawing');
  if (low.words === high.words) problems.push(`the words did not change as the slider went from one end to the other ("${low.words.slice(0, 60)}")`);
  const followed: string[] = [];
  for (const id of entry.expect.filter((expected) => expected !== slider.id)) {
    const a = lowAt.get(id);
    const b = highAt.get(id);
    if (a === undefined || b === undefined) problems.push(`${id} is not on stage while the slider moves`);
    else if (Math.hypot(centre(a).x - centre(b).x, centre(a).y - centre(b).y) + Math.abs(a.width - b.width) + Math.abs(a.height - b.height) < 2) problems.push(`${id} did not move or change with the slider`);
    else followed.push(id);
  }
  if (tab.posted.length !== sent) problems.push(`dragging the slider sent ${tab.posted.length - sent} turn(s): a bound change needs no round trip`);
  return { problems, saw: `a real drag moved the slider ${slider.min} to ${String(top)} and back to ${String(middle)}; ${followed.join(' and ')} followed, the words changed, no turn was sent` };
}

/** switch: a real tap on the pick and on the switch each change the drawing, with no turn sent */
async function switchHand(hand: Hand): Promise<Worked> {
  const { tab, talk } = hand;
  const problems: string[] = [];
  const list = await controls(tab);
  const pick = list.find((control) => control.control === 'pick');
  const toggle = list.find((control) => control.control === 'toggle');
  if (pick === undefined || toggle === undefined) return { problems: [`the page should hold a pick and a toggle; found ${list.map((control) => control.control).join(', ') || 'nothing'}`], saw: '' };
  const sent = tab.posted.length;
  const start = await settled(tab, talk);
  const option = pick.parts.find((part) => part.part === 'option:2')?.box;
  if (option === undefined) problems.push('the pick has no second option to tap');
  else {
    await tab.tap(centre(option).x, centre(option).y);
    const after = await settled(tab, talk);
    const held = (await controls(tab)).find((control) => control.id === pick.id)?.valueText;
    if (held !== pick.options[1]) problems.push(`a tap on "${String(pick.options[1])}" left the pick at "${String(held)}"`);
    else if (after.shapes === start.shapes) problems.push(`choosing "${String(pick.options[1])}" changed nothing in the drawing`);
    const before = await settled(tab, talk);
    const flip = toggle.parts.find((part) => part.part === 'switch')?.box ?? toggle.box;
    await tab.tap(centre(flip).x, centre(flip).y);
    const flipped = await settled(tab, talk);
    const now = (await controls(tab)).find((control) => control.id === toggle.id)?.value;
    if (now === toggle.value) problems.push('a tap on the switch did not flip it');
    else if (flipped.shapes === before.shapes) problems.push('flipping the switch changed nothing in the drawing');
  }
  if (tab.posted.length !== sent) problems.push(`working the pick and the switch sent ${tab.posted.length - sent} turn(s): they need no round trip`);
  return { problems, saw: `a real tap on "${String(pick.options[1])}" and on the switch each changed the drawing, with no turn sent` };
}

/** undo: after the page's second turn the Undo chip stands, and a real tap on it puts the first drawing back */
async function undoHand(hand: Hand): Promise<Worked> {
  const { tab, talk, after, entry } = hand;
  const problems: string[] = [];
  const chip = (): Promise<Box | null> => tab.eval<Box | null>(`(() => { const c = document.querySelector('[data-undo-chip]'); if (!c || c.hidden || getComputedStyle(c).display === 'none') return null; const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`);
  const box = await chip();
  if (box === null) return { problems: ['no Undo chip stands after a turn that changed the drawing'], saw: '' };
  const first = after[0];
  if (first === undefined) return { problems: ['the page has no first drawing to go back to'], saw: '' };
  const sent = tab.posted.length;
  talk.seenReports = new Set((await tab.call<{ reports: string[] }>('probe')).reports);
  await tab.tap(centre(box).x, centre(box).y);
  for (let waited = 0; waited < 5000 && tab.posted.length === sent; waited += 200) await sleep(200);
  if (tab.posted.length === sent) problems.push('a tap on the Undo chip sent no turn');
  const note = await talk.rest(true);
  if (note !== '') problems.push(`after Undo: ${note}`);
  const now = new Map((await pieces(tab)).map((piece) => [piece.id, piece.box]));
  const wrong: string[] = [];
  for (const id of entry.expect) {
    const was = first.find((piece) => piece.id === id)?.box;
    const here = now.get(id);
    if (was === undefined || here === undefined) wrong.push(`${id} is gone`);
    else if (Math.abs(was.x - here.x) + Math.abs(was.y - here.y) + Math.abs(was.width - here.width) + Math.abs(was.height - here.height) > 4) wrong.push(`${id} is not as the first drawing had it`);
  }
  const changed = entry.expect.filter((id) => {
    const a = first.find((piece) => piece.id === id)?.box;
    const b = (after[after.length - 1] ?? []).find((piece) => piece.id === id)?.box;
    return a !== undefined && b !== undefined && Math.abs(a.width - b.width) + Math.abs(a.height - b.height) + Math.abs(a.x - b.x) + Math.abs(a.y - b.y) > 4;
  });
  if (changed.length === 0) problems.push('the second turn changed nothing the page expects, so Undo has nothing to put back');
  problems.push(...wrong);
  return { problems, saw: `the Undo chip stood after the second turn; a real tap on it put ${changed.join(' and ')} back as the first drawing had it` };
}

/** sum: the answer written in the blank is marked right, and the stage holds through the turn that tells the brain */
async function sumHand(hand: Hand): Promise<Worked> {
  const { tab } = hand;
  const ask = (await controls(tab)).find((control) => control.askState !== undefined);
  if (ask === undefined) return { problems: ['there is no blank to answer in'], saw: '' };
  const verdict = ask.askState?.verdict ?? 'none';
  return { problems: verdict === 'right' ? [] : [`the answer written in the blank was marked "${verdict}"`], saw: 'the answer written in the blank is marked right, and the page holds through the turn that tells the brain' };
}

/** app: the app in its locked box loaded, ran, threw nothing and drew something */
async function appHand(hand: Hand): Promise<Worked> {
  const { host, tab, entry } = hand;
  await host.appsLooked(tab);
  const app = (await host.apps(tab)).find((one) => one.id === entry.expect[0] && one.running);
  if (app === undefined) return { problems: [`the app ${entry.expect[0] ?? ''} is not running`], saw: '' };
  const problems: string[] = [];
  if (!app.loaded) problems.push('the app never loaded');
  if (app.crashes > 0) problems.push(`the app threw ${app.crashes} time${app.crashes === 1 ? '' : 's'}`);
  if (app.blank === true) problems.push('the app drew nothing');
  else if (app.blank === null) problems.push('the app was never looked at for something visible');
  return { problems, saw: 'the app loaded, ran, threw nothing and drew something' };
}

/** photo: the callouts' leaders reach their spots (the same two percent of the photo's width the hard cases allow) */
function photoSpots(source: string): [string, number, number][] {
  return [...source.matchAll(/^say\s+(\S+)\s+callout\b[^|\n]*?\bat=(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)/gm)].flatMap((found) => (found[1] === undefined || found[2] === undefined || found[3] === undefined ? [] : [[found[1], Number(found[2]), Number(found[3])] as [string, number, number]]));
}

async function photoHand(hand: Hand, spots: readonly (readonly [string, number, number])[]): Promise<Worked> {
  const { host, tab } = hand;
  const problems: string[] = [];
  const photo = (await pieces(tab)).find((piece) => piece.id === 'p1');
  if (photo === undefined) return { problems: ['the photo p1 is not on stage'], saw: '' };
  for (const [name] of spots) {
    const gap = host.feet().get(`${name}/leader`)?.spotGap;
    if (gap === undefined || gap === null) problems.push(`${name} has no leader to its spot`);
    else if (gap > 0.02 * photo.box.width) problems.push(`${name}'s leader stops ${gap.toFixed(0)} px (${((100 * gap) / photo.box.width).toFixed(1)}% of the photo's width) short of its spot`);
  }
  return { problems, saw: `the photo is the person's own turn (u1) and all ${spots.length} callouts paint to within 2% of the photo's width of their spots` };
}

/** `expect`: each id the page claims to show is on stage, opaque, on the screen, with ink in its box */
async function expectCheck(host: ShowcaseHost, tab: Tab, entry: ShowcaseEntry): Promise<{ readonly problems: string[]; readonly saw: string }> {
  const problems: string[] = [];
  // a live app stands in the page as a frame of its own: the stage's element for it has no size, the host knows where it is
  const frames = new Map((await host.apps(tab)).filter((app) => app.running).map((app) => [app.id, app.box]));
  const view = await tab.eval<{ w: number; h: number }>('({ w: innerWidth, h: innerHeight })');
  const live = await pieces(tab);
  const found: { readonly piece: Piece; readonly box: { x: number; y: number; w: number; h: number } }[] = [];
  for (const id of entry.expect) {
    const here = live.filter((piece) => piece.id === id).sort((a, b) => area(b.box) - area(a.box));
    const shown = here.find((piece) => piece.phase === 'on' && piece.opacity > 0.3);
    if (shown === undefined) {
      problems.push(here.length === 0 ? `${id} is not on stage` : `${id} is on stage but not shown (${here[0]?.phase ?? ''}, opacity ${(here[0]?.opacity ?? 0).toFixed(2)})`);
      continue;
    }
    const where = area(shown.box) === 0 ? (frames.get(id) ?? shown.box) : shown.box;
    const x = Math.max(0, where.x);
    const y = Math.max(0, where.y);
    const box = { x, y, w: Math.max(0, Math.min(where.x + where.width, view.w) - x), h: Math.max(0, Math.min(where.y + where.height, view.h) - y) };
    if (box.w * box.h < 1 || box.w * box.h < 0.5 * area(where)) problems.push(`${id} is on stage but outside the screen (${Math.round(where.x)},${Math.round(where.y)} ${Math.round(where.width)}x${Math.round(where.height)})`);
    else found.push({ piece: shown, box });
  }
  if (found.length > 0) {
    const marks = await tab.call<{ px: number; share: number }[]>('inkIn', await tab.shot(), found.map((one) => one.box), tab.dpr);
    found.forEach(({ piece }, index) => {
      const mark = marks[index] ?? { px: 0, share: 0 };
      const enough = mark.share >= (piece.kind === 'text' ? MIN_TEXT_INK_SHARE : MIN_INK_SHARE) || (piece.kind !== 'text' && mark.px >= MIN_LINE_INK_PX * tab.dpr * tab.dpr);
      if (!enough) problems.push(`${piece.id} (${piece.kind}) is on stage but nothing is drawn in its box (${(100 * mark.share).toFixed(1)}% inked)`);
    });
  }
  return { problems, saw: `${entry.expect.join(', ')} ${entry.expect.length === 1 ? 'is' : 'are'} on stage with ink in ${entry.expect.length === 1 ? 'its' : 'their'} box${entry.expect.length === 1 ? '' : 'es'}` };
}

/** One page, played in a tab of its own from its first turn to its last, every turn judged at its rest. */
async function playPage(host: ShowcaseHost, entry: ShowcaseEntry, source: string): Promise<void> {
  const scripts = [source, ...(entry.turns ?? [])];
  host.note(`showcase ${entry.id}`);
  const { tab, talk } = await host.open();
  try {
    await host.look(tab);
    tab.drain();
    const after: Piece[][] = [];
    let first: string | null = null;
    let last: Judged | null = null;
    // the photo is the person's own turn: the server keeps the test pattern for this session as u1, and the page puts it on stage
    let photo = '';
    if (entry.id === 'photo') {
      const session = await host.sessionOf(tab);
      if (session === null) photo = 'no session to put the photo in';
      else {
        const sent = await fetch(`${host.base}/api/sessions/${session}/uploads`, { method: 'POST', body: new Uint8Array(testPattern(900, 600)), headers: { 'content-type': 'image/png' } }).catch(() => null);
        photo = sent !== null && sent.status === 201 ? '' : `the server kept no photo (${sent === null ? 'no answer' : sent.status})`;
      }
    }
    const spots = entry.id === 'photo' ? photoSpots(source) : [];
    for (let turn = 0; turn < scripts.length; turn += 1) {
      const began = Date.now();
      const results: CheckResult[] = [];
      const script = (scripts[turn] as string).replaceAll('{1}', first ?? '');
      const name = turn === 0 ? `showcase-${entry.id}` : `showcase-${entry.id}#${turn + 1}`;
      if (turn === 0) {
        const bad = scripts.flatMap((one) => rejectedLines(one.replaceAll('{1}', 't1'))).slice(0, 3);
        results.push({ turn: 0, check: 'script-lines', verdict: bad.length === 0 ? 'PASS' : 'FAIL', detail: bad.length === 0 ? 'every line of the page reads' : bad.join('; ') });
        if (photo !== '') results.push({ turn: 0, check: 'showcase-hands', verdict: 'FAIL', detail: photo });
      }
      tab.drain();
      let note = '';
      const posted = tab.posted.length;
      if (turn === 0 && entry.id === 'type') {
        // real keys in the real box: the case answers these words with the page's own lines
        const sent = await talk.say(TYPED, results);
        note = sent ? await talk.rest(true) : 'the typed question never started a turn';
      } else if (turn === 1 && entry.id === 'tap') {
        // a real tap on the choice: the page sends it as a turn, and the case answers it
        const choice = (await pieces(tab)).find((piece) => piece.kind === 'text' && piece.tappable && norm(piece.text) === norm(TAPPED));
        if (choice === undefined) note = `no choice "${TAPPED}" on stage to tap`;
        else {
          await tab.tap(centre(choice.box).x, centre(choice.box).y);
          for (let waited = 0; waited < 8000 && tab.posted.length === posted; waited += 200) await sleep(200);
          const sent = tab.posted[posted];
          if (sent === undefined) note = 'a real tap on the choice sent no turn';
          else if (sent.kind !== 'tap' || norm(sent.text ?? '') !== norm(TAPPED)) note = `the tap sent a ${sent.kind ?? 'turn'} with "${sent.text ?? ''}", not the choice's words`;
          else note = await talk.rest(true);
        }
      } else {
        const played = await play(tab, script);
        if (played.error !== null) note = `the page would not play: ${played.error}`;
        else {
          if (turn === 0) first = played.id;
          if (entry.id === 'sum' && turn === 1) {
            // the right answer tells the brain: that turn goes to the server, whose recorded reply holds the page
            for (let waited = 0; waited < 6000 && !tab.posted.slice(posted).some((one) => one.kind === 'act'); waited += 200) await sleep(200);
            if (!tab.posted.slice(posted).some((one) => one.kind === 'act')) note = 'writing the answer in the blank sent no turn to tell the brain (a right answer does)';
          }
          if (note === '') note = await talk.rest(true);
        }
      }
      results.push(restResult(note, began));
      await host.appsLooked(tab);
      // the footprint judge is not run where it cannot tell ink from its own noise: a map's pins are not separate pictures (hiding a node leaves its label drawn, so it calls every pin
      // undrawn; their ink is `expect`'s), and a stage that ends in the phosphor look keeps moving at rest (two pictures of it differ round every bright thing)
      const footprints = !entry.needs.includes('structure:map') && !endsMoving(scripts);
      last = await host.judge(tab, talk, name, results, began, { footprints, ...(spots.length > 0 ? { photo: spots } : {}) });
      after.push(await pieces(tab));
    }
    if (last === null) return;
    const results = last.results;
    const verdict = (check: string, problems: readonly string[], saw: string): void => void results.push({ turn: 0, check, verdict: problems.length === 0 ? 'PASS' : 'FAIL', detail: problems.length === 0 ? saw : problems.slice(0, 4).join('; ') });
    const expected = await expectCheck(host, tab, entry);
    verdict('showcase-expect', expected.problems, expected.saw);
    const hand: Hand = { host, tab, talk, entry, after };
    const hands: Readonly<Record<string, () => Promise<Worked>>> = {
      drag: () => dragHand(hand),
      switch: () => switchHand(hand),
      changes: () => undoHand(hand),
      sum: () => sumHand(hand),
      app: () => appHand(hand),
      photo: () => photoHand(hand, spots),
    };
    const typed: Readonly<Record<string, string>> = { type: `the prompt was typed with real keys and sent with Enter, and the recorded case answered it with the page`, tap: `a real tap on "${TAPPED}" sent the choice as a turn, and the recorded case answered it` };
    const work = hands[entry.id];
    const worked = work === undefined ? null : await work();
    const hurt = tab.drain();
    const errors = [...hurt.consoleErrors, ...hurt.failedRequests].map((one) => one.text);
    if (worked !== null) verdict('showcase-hands', [...worked.problems, ...errors.slice(0, 2).map((text) => `while it was worked: ${text.slice(0, 120)}`)], worked.saw);
    else if (typed[entry.id] !== undefined) verdict('showcase-hands', errors.slice(0, 2), typed[entry.id] as string);
  } finally {
    await tab.close().catch(() => undefined);
  }
}

/** Every page of one category, one after another, each in a tab of its own. `only` (SHOWCASE_ONLY) picks pages by id. */
export async function showcaseCategory(host: ShowcaseHost, category: string, only: readonly string[] | null): Promise<void> {
  const reader = readShowcase();
  const sources = pageSources(category);
  for (const entry of livePages(reader, category)) {
    if (only !== null && !only.includes(entry.id)) continue;
    const source = sources.get(entry.id);
    if (source === undefined) throw new Error(`no page "${entry.id}" in ${category}.series`);
    await playPage(host, entry, source);
  }
}
