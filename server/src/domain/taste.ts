// The owner's sittings: which twenty answers to ask about, where a sitting stands, and the sheet it is saved to.
//
// A sitting draws on the newest runs of the battery that were judged. The twenty are spread across families and across
// the judge's scores (some it liked, some it did not, in every family), because agreement measured only on answers the
// judge scored the same would say nothing. The judge's score never leaves this file until the sitting is done.
// Sheets are `explore/taste/<stamp>.json`, written after every score, so a sitting can be left and picked up again.

import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TASTE_SITTING, agreementLine, agreementOf } from '@conduit/language';
import type { ExploreFamily, ExploreResult, ExploreRun, TasteCard, TasteItem, TasteSheet, TasteState } from '@conduit/language';

const NAME = /^[A-Za-z0-9_-]{1,80}$/;
const RUNS_TO_DRAW_ON = 4;
const AHEAD = 3;

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

/** A hash-free name for the judge's instructions: the run's own hash when the judge recorded one, else its model. */
function rubricOf(result: ExploreResult): string {
  const judge = result.judge as ({ readonly rubric?: unknown } & NonNullable<ExploreResult['judge']>) | null | undefined;
  if (judge === null || judge === undefined) return 'none';
  return typeof judge.rubric === 'string' ? judge.rubric : judge.model;
}

/** Every judged answer of the newest runs, newest first. An answer with no lines, or no verdict from the judge, is not worth asking about. */
export async function candidatesOf(exploreDir: string): Promise<TasteItem[]> {
  const runsDir = join(exploreDir, 'runs');
  const names = (await readdir(runsDir).catch(() => [] as string[])).filter((name) => NAME.test(name));
  const runs = (await Promise.all(names.map((name) => readJson(join(runsDir, name, 'index.json')))))
    .filter((item): item is ExploreRun => typeof item === 'object' && item !== null && 'id' in item && 'prompts' in item)
    .sort((a, b) => (a.started < b.started ? 1 : -1));
  const found: TasteItem[] = [];
  let drawn = 0;
  for (const run of runs) {
    if (!NAME.test(run.id)) continue;
    const entries = run.prompts.filter((entry) => entry.kind !== 'case' && NAME.test(entry.id) && entry.id !== 'index');
    const results = await Promise.all(entries.map((entry) => readJson(join(runsDir, run.id, `${entry.id}.json`))));
    let any = false;
    results.forEach((value, at) => {
      const result = value as ExploreResult | null;
      const entry = entries[at];
      if (result === null || entry === undefined || result.judge === null || result.judge === undefined) return;
      if (result.judge.failure !== null && result.judge.failure !== undefined) return;
      if (result.lines.length === 0) return;
      any = true;
      found.push({ run: run.id, answer: entry.id, prompt: result.prompt.prompt, family: result.prompt.family ?? 'open', judge: result.judge.coherence });
    });
    if (any) drawn += 1;
    if (drawn >= RUNS_TO_DRAW_ON) break;
  }
  return found;
}

/**
 * Twenty answers, a few of each family, from the judge's lowest and highest and middle in turn, no prompt twice while
 * another is left. Pure: the same candidates give the same twenty.
 */
export function pickItems(candidates: readonly TasteItem[], count: number = TASTE_SITTING): TasteItem[] {
  const families = new Map<ExploreFamily, TasteItem[]>();
  for (const item of candidates) families.set(item.family, [...(families.get(item.family) ?? []), item]);
  for (const list of families.values()) list.sort((a, b) => a.judge - b.judge || (a.answer < b.answer ? -1 : 1));
  const order = [...families.keys()].sort();
  const turn = new Map<ExploreFamily, number>();
  const promptOf = (item: TasteItem): string => item.prompt;
  const picked: TasteItem[] = [];
  const spent = new Set<string>();
  while (picked.length < count && order.some((family) => (families.get(family) ?? []).length > 0)) {
    for (const family of order) {
      if (picked.length >= count) break;
      const list = families.get(family) ?? [];
      if (list.length === 0) continue;
      const step = turn.get(family) ?? 0;
      turn.set(family, step + 1);
      const wanted = step % 3 === 0 ? 'low' : step % 3 === 1 ? 'high' : 'middle';
      const fresh = list.filter((item) => !spent.has(promptOf(item)));
      const pool = fresh.length > 0 ? fresh : list;
      const choice = wanted === 'low' ? pool[0] : wanted === 'high' ? pool[pool.length - 1] : pool[Math.floor(pool.length / 2)];
      if (choice === undefined) continue;
      families.set(family, list.filter((item) => item !== choice));
      spent.add(promptOf(choice));
      picked.push(choice);
    }
  }
  return picked;
}

const cardOf = (item: TasteItem): TasteCard => ({ run: item.run, answer: item.answer, prompt: item.prompt, family: item.family });
const keyOf = (item: { readonly run: string; readonly answer: string }): string => `${item.run}/${item.answer}`;

/** What the page is told of a sheet: the next answers, never their judge scores, until the sitting is done. */
export function stateOf(sheet: TasteSheet): TasteState {
  const done = new Set(sheet.scores.map(keyOf));
  const left = sheet.items.filter((item) => !done.has(keyOf(item)));
  const finished = left.length === 0 && sheet.items.length > 0;
  let result: TasteState['result'] = null;
  if (finished) {
    const found = agreementOf([sheet]);
    const differ = (found?.missed ?? []).flatMap((miss) => {
      const item = sheet.items.find((candidate) => keyOf(candidate) === miss.answer);
      return item === undefined ? [] : [{ run: item.run, answer: item.answer, prompt: item.prompt, judge: miss.judge, up: miss.up, word: miss.word }];
    });
    result = { line: agreementLine(found), agreement: found, differ };
  }
  return {
    id: sheet.id,
    total: sheet.items.length,
    scored: sheet.scores.length,
    next: left[0] === undefined ? null : cardOf(left[0]),
    ahead: left.slice(1, 1 + AHEAD).map(cardOf),
    result,
    empty: null,
  };
}

export const EMPTY_STATE: TasteState = {
  id: '',
  total: 0,
  scored: 0,
  next: null,
  ahead: [],
  result: null,
  empty: 'There is no judged run to ask about yet. Run `pnpm explore` with the judge on, then come back.',
};

/** The sheets on disk, oldest first. */
export async function readSheets(exploreDir: string): Promise<TasteSheet[]> {
  const dir = join(exploreDir, 'taste');
  const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith('.json')).sort();
  const sheets = await Promise.all(names.map((name) => readJson(join(dir, name))));
  return sheets.filter((sheet): sheet is TasteSheet => typeof sheet === 'object' && sheet !== null && 'items' in sheet && 'scores' in sheet);
}

async function saveSheet(exploreDir: string, sheet: TasteSheet): Promise<void> {
  const dir = join(exploreDir, 'taste');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${sheet.id}.json`);
  await writeFile(`${path}.tmp`, `${JSON.stringify(sheet, null, 2)}\n`, 'utf8');
  await rename(`${path}.tmp`, path);
}

/** The owner's sittings. One instance per server; writes are taken one at a time, so two quick taps cannot lose one. */
export interface Taste {
  /** the sitting in progress, or the last one finished; a new one is drawn when there is none */
  current(): Promise<TasteState>;
  /** draws a fresh sitting from answers not yet scored */
  fresh(): Promise<TasteState>;
  score(id: string, run: string, answer: string, up: boolean, word: string): Promise<TasteState>;
  undo(id: string): Promise<TasteState>;
}

export class TasteMissing extends Error {}

export function createTaste(exploreDir: string, now: () => Date = () => new Date()): Taste {
  let chain: Promise<unknown> = Promise.resolve();
  const alone = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work, work);
    chain = next.catch(() => undefined);
    return next;
  };

  const draw = async (): Promise<TasteState> => {
    const seen = new Set((await readSheets(exploreDir)).flatMap((sheet) => sheet.scores.map(keyOf)));
    const candidates = await candidatesOf(exploreDir);
    const unseen = candidates.filter((item) => !seen.has(keyOf(item)));
    // Fewer than a sitting's worth unseen: ask again about the ones seen, rather than ask nothing.
    const items = pickItems(unseen.length >= TASTE_SITTING ? unseen : candidates);
    if (items.length === 0) return EMPTY_STATE;
    const first = candidates.find((item) => keyOf(item) === keyOf(items[0] as TasteItem));
    const stamp = now().toISOString().replace(/[:.]/g, '-').replace('Z', '');
    const sheet: TasteSheet = { id: stamp, rubric: first === undefined ? 'unknown' : (await rubricFor(exploreDir, first)), items, scores: [] };
    await saveSheet(exploreDir, sheet);
    return stateOf(sheet);
  };

  const sheetNamed = async (id: string): Promise<TasteSheet> => {
    const found = (await readSheets(exploreDir)).find((sheet) => sheet.id === id);
    if (found === undefined) throw new TasteMissing(`sheet ${id}`);
    return found;
  };

  return {
    current: () =>
      alone(async () => {
        const sheets = await readSheets(exploreDir);
        const open = [...sheets].reverse().find((sheet) => sheet.scores.length < sheet.items.length);
        if (open !== undefined) return stateOf(open);
        const last = sheets[sheets.length - 1];
        return last === undefined ? draw() : stateOf(last);
      }),
    fresh: () => alone(draw),
    score: (id, run, answer, up, word) =>
      alone(async () => {
        const sheet = await sheetNamed(id);
        const item = sheet.items.find((candidate) => candidate.run === run && candidate.answer === answer);
        if (item === undefined) throw new TasteMissing(`answer ${run}/${answer} in sheet ${id}`);
        // Scoring the same answer twice replaces the first: a double tap is not two opinions.
        const scores = [...sheet.scores.filter((score) => !(score.run === run && score.answer === answer)), { run, answer, up, word: word.trim().slice(0, 80), at: now().toISOString() }];
        const next: TasteSheet = { ...sheet, scores };
        await saveSheet(exploreDir, next);
        return stateOf(next);
      }),
    undo: (id) =>
      alone(async () => {
        const sheet = await sheetNamed(id);
        const next: TasteSheet = { ...sheet, scores: sheet.scores.slice(0, -1) };
        await saveSheet(exploreDir, next);
        return stateOf(next);
      }),
  };
}

async function rubricFor(exploreDir: string, item: TasteItem): Promise<string> {
  const result = (await readJson(join(exploreDir, 'runs', item.run, `${item.answer}.json`))) as ExploreResult | null;
  return result === null ? 'unknown' : rubricOf(result);
}
