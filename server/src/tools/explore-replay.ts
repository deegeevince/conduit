// The geometry pass: every answer a run logged, laid out again in each look at one or more windows, and counted by the battery's own code. No
// brain, no judge, no pictures: it costs nothing and it gives the same counts every time, so it is how rows 4, 5 and 13 are measured on every
// answer, nine looks and two screens, and how a run of v2 is held up against the counter that replaces the painter's own.

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EMPTY_STAGE, LOOK_IDS, parseLine } from '@conduit/language';
import type { ExploreCaseResult, ExploreGeometry, ExploreResult, Line, LookId, StageBase } from '@conduit/language';
import type { Eyes } from './explore-browser';

export interface ReplayRequest {
  readonly dir: string;
  /** the looks to lay each answer out in; `chosen`: only the one the answer asked for */
  readonly looks: readonly LookId[] | 'chosen';
  readonly screens: readonly { readonly width: number; readonly height: number }[];
  readonly only: readonly string[] | null;
}

/** One answer, laid out once. */
export interface Replayed {
  readonly answer: string;
  readonly look: LookId | 'chosen';
  readonly screen: string;
  readonly geometry: ExploreGeometry;
}

export interface ReplayTotals {
  readonly look: LookId | 'chosen';
  readonly screen: string;
  readonly answers: number;
  /** answers with any collision (text over any other box, a route through a node, a label crossed) */
  readonly colliding: number;
  readonly overlaps: number;
  readonly throughNodes: number;
  readonly crossed: number;
  readonly outside: number;
  readonly unrouted: number;
  readonly carriedKept: number;
  readonly carriedMoved: number;
}

export interface ReplayReport {
  readonly run: string;
  readonly answers: number;
  readonly totals: readonly ReplayTotals[];
  /** the answers that collided, by look and screen, for a person to open */
  readonly colliding: readonly { readonly answer: string; readonly look: LookId | 'chosen'; readonly screen: string; readonly pairs: readonly string[] }[];
  /** answers that could not be laid out, and why */
  readonly failed: readonly { readonly answer: string; readonly why: string }[];
}

interface Answer {
  readonly name: string;
  readonly base: StageBase;
  readonly lines: readonly { readonly seq: number; readonly line: Line }[];
}

function isCase(file: unknown): file is ExploreCaseResult {
  return typeof file === 'object' && file !== null && 'turns' in file && Array.isArray((file as { turns: unknown }).turns);
}

function isAnswer(file: unknown): file is ExploreResult {
  return typeof file === 'object' && file !== null && 'lines' in file && 'prompt' in file;
}

function linesOf(result: ExploreResult): readonly { readonly seq: number; readonly line: Line }[] {
  const out: { seq: number; line: Line }[] = [];
  for (const line of result.lines) {
    const parsed = parseLine(line.text);
    if (parsed.kind === 'line') out.push({ seq: line.seq, line: parsed.line });
  }
  return out;
}

/** The answers of a run folder, in file-name order: a prompt's answer, and each turn of a conversation that has lines. */
export async function answersOf(dir: string, only: readonly string[] | null): Promise<Answer[]> {
  const names = (await readdir(dir)).filter((name) => name.endsWith('.json') && name !== 'index.json' && name !== 'summary.json' && !name.startsWith('replay-')).sort();
  const out: Answer[] = [];
  for (const name of names) {
    const stem = name.slice(0, -'.json'.length);
    let file: unknown;
    try {
      file = JSON.parse(await readFile(join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    if (only !== null && !only.some((id) => stem === id || stem.startsWith(`${id}_`))) continue;
    if (isCase(file)) {
      file.turns.forEach((turn, at) => {
        const lines = linesOf(turn);
        if (lines.length > 0) out.push({ name: `${stem}#${at + 1}`, base: turn.base ?? EMPTY_STAGE, lines });
      });
    } else if (isAnswer(file)) {
      const lines = linesOf(file);
      if (lines.length > 0) out.push({ name: stem, base: file.base ?? EMPTY_STAGE, lines });
    }
  }
  return out;
}

const collides = (g: ExploreGeometry): boolean => g.textOverlaps + g.linksThroughNodes + g.crossedLabels > 0;

/** Lays every answer of the run out in every look at every window, and counts. */
export async function replayRun(eyes: Eyes, request: ReplayRequest, log: (line: string) => void): Promise<ReplayReport> {
  const answers = await answersOf(request.dir, request.only);
  const looks: readonly (LookId | null)[] = request.looks === 'chosen' ? [null] : request.looks;
  const done: Replayed[] = [];
  const failed: { answer: string; why: string }[] = [];
  for (const screen of request.screens) {
    const name = `${screen.width}x${screen.height}`;
    for (const look of looks) {
      let count = 0;
      for (const answer of answers) {
        try {
          const reply = await eyes.look({
            turn: `replay-${answer.name}`,
            base: answer.base,
            lines: answer.lines,
            viewport: { width: screen.width, height: screen.height, dpr: 1 },
            playhead: null,
            earlier: [],
            judgeSide: 0,
            look,
            pictures: false,
          });
          done.push({ answer: answer.name, look: look ?? 'chosen', screen: name, geometry: reply.geometry });
        } catch (error) {
          if (!failed.some((entry) => entry.answer === answer.name)) failed.push({ answer: answer.name, why: error instanceof Error ? error.message.split('\n')[0] ?? 'failed' : String(error) });
        }
        count += 1;
      }
      log(`  ${name} ${look ?? 'as chosen'}: ${count} answers laid out`);
    }
  }
  const totals: ReplayTotals[] = [];
  const keys = new Set(done.map((entry) => `${entry.screen}\u0000${entry.look}`));
  for (const key of [...keys].sort()) {
    const [screen = '', look = ''] = key.split('\u0000');
    const rows = done.filter((entry) => entry.screen === screen && entry.look === look);
    const sum = (pick: (g: ExploreGeometry) => number): number => rows.reduce((total, row) => total + pick(row.geometry), 0);
    totals.push({
      look: look === 'chosen' ? 'chosen' : (LOOK_IDS.find((id) => id === look) ?? 'chosen'),
      screen,
      answers: rows.length,
      colliding: rows.filter((row) => collides(row.geometry)).length,
      overlaps: sum((g) => g.textOverlaps),
      throughNodes: sum((g) => g.linksThroughNodes),
      crossed: sum((g) => g.crossedLabels),
      outside: sum((g) => (g.outside ?? 0) + (g.outsideRoom ?? 0)),
      unrouted: sum((g) => g.unrouted ?? 0),
      carriedKept: sum((g) => g.carried?.kept ?? 0),
      carriedMoved: sum((g) => g.carried?.moved ?? 0),
    });
  }
  const colliding = done.filter((entry) => collides(entry.geometry)).map((entry) => ({ answer: entry.answer, look: entry.look, screen: entry.screen, pairs: entry.geometry.pairs ?? [] }));
  return { run: request.dir.split('/').pop() ?? request.dir, answers: answers.length, totals, colliding, failed };
}

/** Writes the report beside the run, one file per window, and returns the table to print. */
export async function writeReplay(dir: string, report: ReplayReport, screens: readonly string[]): Promise<string> {
  for (const screen of screens) {
    await writeFile(join(dir, `replay-${screen}.json`), `${JSON.stringify({ ...report, totals: report.totals.filter((total) => total.screen === screen), colliding: report.colliding.filter((entry) => entry.screen === screen) }, null, 2)}\n`);
  }
  const header = ['screen', 'look', 'answers', 'colliding', 'text over', 'through nodes', 'crossed', 'outside', 'unrouted', 'carried moved/kept'];
  const rows = report.totals.map((total) => [total.screen, total.look, String(total.answers), String(total.colliding), String(total.overlaps), String(total.throughNodes), String(total.crossed), String(total.outside), String(total.unrouted), `${total.carriedMoved}/${total.carriedKept}`]);
  const widths = header.map((title, at) => Math.max(title.length, ...rows.map((row) => (row[at] ?? '').length)));
  const line = (row: readonly string[]): string => row.map((cell, at) => (at < 2 ? cell.padEnd(widths[at] ?? 0) : cell.padStart(widths[at] ?? 0))).join('  ');
  return [line(header), line(widths.map((width) => '-'.repeat(width))), ...rows.map(line)].join('\n');
}
