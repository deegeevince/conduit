// The held-out set, written fresh by a writer that has read neither the seeds nor the tune sets (P1-28).
//
// v2's held-out file sat in the repository beside the tune set from the first commit, and the prompt's own examples were written after it: the
// "held-out" run measured what the prompt had been taught. So this one is made by a cold `claude -p` that is given the definitions of the
// families and how many prompts each needs, and nothing else: no tools, no settings, an empty working folder. It is written to
// BATTERY_SEALED_DIR, which is outside the repository, and this tool never prints a prompt, only counts. `pnpm explore --pool heldout` reads it
// from there and refuses to run when the variable is not set.

import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ExploreBattery, ExploreExpectation, ExploreFamily, ExplorePrompt, StructureKind } from '@conduit/language';
import { runClaude } from '../brains/claude-cli/process';
import { failureOf, parseStreamLine, textDeltaOf } from '../brains/claude-cli/stream-json';

/** How many prompts each family gets: thirty, and at three samples every family the bar sets a floor for has six answers. */
export const HELDOUT_COUNTS: Readonly<Partial<Record<ExploreFamily, number>>> = {
  diagram: 7,
  chart: 4,
  explorable: 4,
  mechanism: 3,
  plain: 2,
  type: 2,
  scene: 2,
  motion: 2,
  pixels: 2,
  paint: 1,
  open: 1,
};

/** What each family is, in the words the writer is given. Nothing here is an example of an answer, and no prompt of any set is quoted. */
const DEFINITIONS: Readonly<Record<string, string>> = {
  diagram: 'The person asks to see information laid out as a structure: a flowchart, a decision, a cycle that loops, a timeline with dates, a family or taxonomy tree, a table that compares things on several measures, or a map with places in order. Some name the structure ("a timeline of ...", "a table comparing ..."), some only imply it ("how should I decide whether ...").',
  chart: 'The person asks for numbers to be drawn as a chart: a line over time, columns, a distribution, a share of a whole, or a price with candles. Some give the figures in the prompt, some ask for well-known figures from memory.',
  explorable: 'The person asks for something they can work with their hand and watch respond: a slider that changes a drawing or a number, a toggle, a choice between options, a small calculator. The drawing or readout must change when the control moves.',
  mechanism: 'The person asks how a thing works, or why something happens, or to be taken through a process, and wants it shown as a drawing with labelled parts, one step at a time. Physical, biological, mathematical or procedural.',
  plain: 'A question that wants a short plain answer in words and nothing drawn: a fact, a how-to command, a few tips.',
  type: 'The person wants words to be the picture: a title card, an opening title, a single line said with weight, a short text with a mood.',
  scene: 'The person asks for a scene or a short story or a painted-feeling picture with depth: a place, weather, a moment, a camera that moves.',
  motion: 'The person asks for something that moves over a stated short time: a clip, an animated logo, a prototype of an interface animation, a sequence of shots.',
  pixels: 'The person asks for pixel art: a creature, an object or a small animated scene made of visible square pixels.',
  paint: 'The person asks for a painting or an illustration in a named style or medium, to be looked at.',
  open: 'An open invitation or an unusual request that fits none of the above: the person wants to be surprised, or asks what can be done, or asks for a game or a toy.',
};

const STRUCTURES: readonly StructureKind[] = ['flow', 'tree', 'cycle', 'timeline', 'map', 'table', 'chart'];

/** The expectation each family implies, so the writer is never asked about the machinery. */
const EXPECTS: Readonly<Record<string, ExploreExpectation>> = {
  diagram: 'structure',
  chart: 'chart',
  explorable: 'explorable',
  mechanism: 'drawn',
  plain: 'plain',
  type: 'type',
  scene: 'scene',
  motion: 'motion',
  pixels: 'pixels',
  paint: 'drawn',
  open: 'any',
};

const SYSTEM = `You write test prompts for a system that answers by drawing and animating on a stage instead of chatting. You are given the kinds of request it must be tested on and how many prompts of each kind to write. Write them as real people write to an assistant: varied in subject, in length, in how exact they are, with nothing in common but their kind. Cover subjects from everyday life, science, money, history, craft, sport, art and technology. Do not write a prompt twice in different words. Do not tell the system how to answer, and do not mention a stage, a canvas or an animation unless the kind is about motion.

Reply with ONE JSON object and nothing else: {"prompts": [{"family": "<kind>", "prompt": "<the request, in the person's own words>", "useCase": "<what this tests, in four to eight words>"}]}. For a diagram prompt that names one structure, also give "structure": one of ${STRUCTURES.join(', ')}.`;

function request(counts: Readonly<Partial<Record<ExploreFamily, number>>>): string {
  const kinds = Object.entries(counts).filter(([, count]) => (count ?? 0) > 0);
  return [
    'The kinds, each with what it is and how many prompts to write:',
    '',
    ...kinds.map(([family, count]) => `- ${family} (${count}): ${DEFINITIONS[family] ?? ''}`),
    '',
    `Write ${kinds.reduce((total, [, count]) => total + (count ?? 0), 0)} prompts in all.`,
  ].join('\n');
}

const words = (text: string): Set<string> => new Set(text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((word) => word.length > 2));

/** Whether two prompts are the same request in other words: a share of their words in common that no two different requests reach. */
function alike(a: string, b: string): boolean {
  const x = words(a);
  const y = words(b);
  if (x.size === 0 || y.size === 0) return false;
  let shared = 0;
  for (const word of x) if (y.has(word)) shared += 1;
  return shared / Math.min(x.size, y.size) > 0.7;
}

function slug(text: string, taken: ReadonlySet<string>): string {
  const base = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').slice(0, 4).join('-') || 'prompt';
  let id = `h-${base}`;
  for (let n = 2; taken.has(id); n += 1) id = `h-${base}-${n}`;
  return id;
}

async function ask(bin: string, model: string, effort: 'low' | 'medium' | 'high', message: string, signal: AbortSignal): Promise<string> {
  let text = '';
  let result = '';
  let failure: string | null = null;
  for await (const raw of runClaude({ bin, model, effort, systemPrompt: SYSTEM, userMessage: message }, signal)) {
    const event = parseStreamLine(raw);
    if (event === null) continue;
    const delta = textDeltaOf(event);
    if (delta !== null) text += delta;
    if (event.type === 'result') {
      failure = failureOf(event);
      const said = (event as { result?: unknown }).result;
      if (typeof said === 'string') result = said;
    }
  }
  if (failure !== null) throw new Error(`the writer failed: ${failure}`);
  return result === '' ? text : result;
}

interface Written {
  readonly family: string;
  readonly prompt: string;
  readonly useCase: string;
  readonly structure: StructureKind | null;
}

function writtenIn(reply: string): Written[] {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return [];
  }
  const list = typeof parsed === 'object' && parsed !== null && 'prompts' in parsed ? parsed.prompts : null;
  if (!Array.isArray(list)) return [];
  const out: Written[] = [];
  for (const item of list as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const family = record['family'];
    const prompt = record['prompt'];
    if (typeof family !== 'string' || typeof prompt !== 'string' || prompt.trim().length < 8 || DEFINITIONS[family] === undefined) continue;
    const structure = STRUCTURES.find((kind) => kind === record['structure']) ?? null;
    out.push({ family, prompt: prompt.trim(), useCase: typeof record['useCase'] === 'string' ? record['useCase'].trim() : family, structure });
  }
  return out;
}

export interface HeldoutOptions {
  readonly dir: string;
  readonly bin: string;
  readonly model: string;
  readonly effort: 'low' | 'medium' | 'high';
  /** the prompts of every set in the repository: the new ones must not repeat them. Read here and never printed */
  readonly existing: readonly string[];
  readonly overwrite: boolean;
}

/** Writes the set and says how it came out: counts only. Throws when the file is there and `overwrite` is not given, or when the writer cannot fill the counts. */
export async function writeHeldout(options: HeldoutOptions, signal: AbortSignal): Promise<{ readonly path: string; readonly counts: Readonly<Record<string, number>>; readonly total: number; readonly rounds: number; readonly dropped: number }> {
  const path = join(options.dir, 'heldout.json');
  if (existsSync(path) && !options.overwrite) throw new Error(`${path} is already there: a held-out set that has decided anything is spent. Pass --yes to replace it`);
  const kept: Written[] = [];
  let dropped = 0;
  let rounds = 0;
  let wanted: Partial<Record<ExploreFamily, number>> = { ...HELDOUT_COUNTS };
  while (rounds < 3 && Object.values(wanted).some((count) => (count ?? 0) > 0)) {
    rounds += 1;
    const reply = await ask(options.bin, options.model, options.effort, request(wanted), signal);
    const left: Partial<Record<ExploreFamily, number>> = { ...wanted };
    for (const item of writtenIn(reply)) {
      const need = left[item.family as ExploreFamily] ?? 0;
      if (need <= 0) continue;
      if (options.existing.some((known) => alike(known, item.prompt)) || kept.some((other) => alike(other.prompt, item.prompt))) {
        dropped += 1;
        continue;
      }
      kept.push(item);
      left[item.family as ExploreFamily] = need - 1;
    }
    wanted = left;
  }
  const missing = Object.entries(wanted).filter(([, count]) => (count ?? 0) > 0);
  if (missing.length > 0) throw new Error(`the writer left ${missing.map(([family, count]) => `${count} ${family}`).join(', ')} unwritten after ${rounds} rounds; nothing was saved`);

  const taken = new Set<string>();
  const prompts: ExplorePrompt[] = kept.map((item) => {
    const family = item.family as ExploreFamily;
    const id = slug(item.prompt, taken);
    taken.add(id);
    return {
      id,
      useCase: item.useCase,
      prompt: item.prompt,
      expects: EXPECTS[family] ?? 'any',
      baseline: family === 'plain' || family === 'diagram' || family === 'mechanism',
      heldOut: true,
      family,
      ...(family === 'diagram' || family === 'mechanism' || family === 'chart' ? { information: true } : {}),
      ...(item.structure === null || family !== 'diagram' ? {} : { structure: item.structure }),
    };
  });
  const battery: ExploreBattery = { version: 1, pool: 'heldout', prompts };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(battery, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  const counts: Record<string, number> = {};
  for (const prompt of prompts) counts[prompt.family ?? 'open'] = (counts[prompt.family ?? 'open'] ?? 0) + 1;
  return { path, counts, total: prompts.length, rounds, dropped };
}

/** Every prompt of the sets in the repository, to keep the new ones from repeating them. */
export async function promptsOf(files: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const file of files) {
    try {
      const battery = JSON.parse(await readFile(file, 'utf8')) as ExploreBattery;
      for (const prompt of battery.prompts) out.push(prompt.prompt);
      for (const scripted of battery.cases ?? []) for (const turn of scripted.turns) if (turn.do === 'prompt') out.push(turn.text);
    } catch {
      // a file that is not there is a set that is not there
    }
  }
  return out;
}
