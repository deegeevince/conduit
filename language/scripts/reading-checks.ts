// The reading rule (fb-023, fb-042) and what goes with it, for every scene of every demo, from the schedule alone: no browser. Run by `pnpm timeline`
// (and by itself: `pnpm timeline reading` prints the table of every scene; `pnpm check --only fb-023` runs it).
//
//   fb-023  A scene stays on stage as long as reading it takes. For every scene another scene follows:
//             rest = (when the next scene starts clearing it) - (when the last thing in it finished arriving, moving or changing)
//             need = 1.5 s + 0.3 s x N + 0.15 s x B + 0.4 s x C, never under 3 s and never over 8 s;  rest >= need
//           N: the words of the scene's last narration line, plus every label (`near=` or `at=` text).
//           B: the words inside blocks (node and link words, table cells, code lines, a chart's title and marks); half rate: terse, partly read as they land.
//           C: the cells of a written method (each given digit, each sign, each blank, from the written-method layout), or for a picture its numbers and sign.
//           A scene that needs a tap (a `steps` block) must be the last scene. A slide of a `deck` stops the clock, so it is not timed here.
//   fb-023  Arrives after it has left: an element whose entrance ends after the next scene starts.
//
// docs/demo-audit.md part 2 gives the reasoning. The audit's scratch script (need.ts) is what this grew from.
import { maths } from '../src/index';
import type { ElementSpan } from '../src/index';
import { allDemos, play, scenesOf } from './demo-lib';
import type { SceneCut } from './demo-lib';

/** Demos the rule does not time, and why. */
const EXEMPT: Readonly<Record<string, string>> = {
  overture: 'the first-load welcome is brisk on purpose (fifteen seconds in all)',
  problem: 'a fixture of old logs, played one problem at a time by the check; it is not a show',
};

/** Demos whose scenes are reported but do not fail the run: another builder owns them. */
const WARN_ONLY: Readonly<Record<string, string>> = {
  code: 'code.series is v3-codefix\'s and merged without the audit\'s waits (docs/demo-audit.md 2.4: wait 8s after the first listing, 8.4s after the second); add them there and delete this line',
};

export const words = (text: string): number => text.trim().split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;

export interface Reading {
  readonly demo: string;
  readonly number: number;
  readonly name: string;
  readonly N: number;
  readonly B: number;
  readonly C: number;
  readonly landed: number;
  readonly leaves: number;
  readonly need: number;
  readonly rest: number;
  readonly last: boolean;
  readonly slide: boolean;
  /** the scene made nothing (the opening of a `deck` before its first slide): there is nothing to read */
  readonly empty: boolean;
  /** the scene has a block that is stepped by taps */
  readonly tap: boolean;
  /** elements still arriving when the next scene starts: `id (arrives T, next scene at U)` */
  readonly late: readonly string[];
}

/** C for one `math` line: from the layout the painter lays out (the cells of the grid), or for a picture the numbers and signs of its sum. */
function mathCells(method: string, sum: string, worked: boolean, blank: unknown, carry: unknown): number {
  const grid = maths.gridOf({ method: method as never, sum, worked, ...(blank === null ? {} : { blank: blank as never }), ...(carry === null ? {} : { carry: carry as never }) });
  if (grid !== null) return grid.cells.filter((cell) => cell.role === 'given' || cell.role === 'sign' || cell.blank).length;
  return (sum.match(/\d+(?:[.,]\d+)?|[+\-−×÷*/=]/g) ?? []).length;
}

/** When a scene's last thing has finished arriving, moving or changing: ambient fields, camera moves and loops are not arrivals. */
function landedOf(cut: SceneCut, lineEnds: ReadonlyMap<number, number>, verbs: ReadonlyMap<number, string>): number {
  let landed = cut.scene.start;
  for (const element of cut.elements) {
    if (element.kind === 'field') continue;
    landed = Math.max(landed, element.enter?.end ?? 0);
    for (const change of element.changes) landed = Math.max(landed, change.end);
  }
  // rows, hits, nodes and links arrive on their own lines
  for (const seq of cut.seqs) if (['row', 'hit', 'node', 'link'].includes(verbs.get(seq) ?? '')) landed = Math.max(landed, lineEnds.get(seq) ?? 0);
  return landed;
}

export function readingOf(demo: string, source: string): Reading[] {
  const played = play(source);
  const { schedule } = played;
  const lineEnds = new Map(schedule.lines.map((line) => [line.seq, line.end] as const));
  const verbs = new Map([...played.line].map(([seq, line]) => [seq, line.verb as string] as const));
  const slides = new Set(schedule.deck?.slides.map((slide) => slide.scene) ?? []);
  return scenesOf(played).map((cut) => {
    const els = cut.elements;
    const text = els.filter((element) => element.kind === 'text' && !element.struck);
    const isLabel = (element: ElementSpan): boolean => element.style.near !== null || element.style.at !== null || element.style.group !== null;
    const flow = text.filter((element) => !isLabel(element));
    const lastFlow = flow.length === 0 ? null : flow.reduce((a, b) => ((b.enter?.start ?? 0) >= (a.enter?.start ?? 0) ? b : a));
    const labels = text.filter(isLabel).filter((element) => element.exit === null || cut.next === null || element.exit.start >= cut.leaves);
    const N = (lastFlow === null ? 0 : words(lastFlow.text)) + labels.reduce((sum, element) => sum + words(element.text), 0);
    // the words of a table's rows and a code block's lines come from the lines that wrote them
    let block = '';
    let rowWords = 0;
    for (const seq of cut.seqs) {
      const verb = verbs.get(seq) ?? '';
      if (verb === 'row') {
        if (block === 'table' || block === 'code') rowWords += words((played.text.get(seq) ?? '').replace(/\|/g, ' '));
      } else if (['table', 'chart', 'code', 'tune', 'app', 'screen'].includes(verb)) block = verb;
      else if (verb !== 'frame') block = '';
    }
    const B = els.filter((element) => element.kind !== 'text' && element.kind !== 'field' && element.text !== '').reduce((sum, element) => sum + words(element.text), 0) + rowWords;
    let C = 0;
    let tap = false;
    for (const element of els) {
      const figure = element.figure;
      if (figure?.kind === 'structure' && figure.math != null) {
        C += mathCells(figure.math.method, figure.math.sum, figure.math.worked, figure.math.blank, figure.math.carry);
        if (figure.math.steps) tap = true;
      }
    }
    const landed = landedOf(cut, lineEnds, verbs);
    const need = Math.min(8, Math.max(3, 1.5 + 0.3 * N + 0.15 * B + 0.4 * C));
    const late = cut.next === null ? [] : els.filter((element) => element.kind !== 'field' && element.enter !== null && element.enter.end > cut.leaves + 0.001).map((element) => `${element.id} (arrives ${element.enter?.end.toFixed(2)}, next scene at ${cut.leaves.toFixed(2)})`);
    return { demo, number: cut.number, name: `${demo}#${cut.number}`, N, B, C, landed, leaves: cut.leaves, need, rest: cut.leaves - landed, last: cut.next === null, slide: slides.has(cut.scene.id), empty: els.length === 0, tap, late };
  });
}

/** `table`: print every scene. Failures are always printed. */
export function readingChecks(table = false): boolean {
  let ok = true;
  let scenes = 0;
  let timed = 0;
  const out = (text: string): void => void process.stdout.write(text);
  for (const demo of allDemos()) {
    const exempt = EXEMPT[demo.name];
    const warn = WARN_ONLY[demo.name] !== undefined;
    for (const reading of readingOf(demo.name, demo.source)) {
      scenes += 1;
      const problems: string[] = [];
      if (exempt === undefined && !reading.slide && reading.empty === false) {
        timed += 1;
        if (reading.tap && !reading.last) problems.push('a block that waits for a tap must be the last scene: no wait is long enough for it (move it to the end)');
        else if (!reading.last && !reading.tap && reading.rest + 1e-6 < reading.need) problems.push(`on stage ${reading.rest.toFixed(1)} s after it has arrived; reading it takes ${reading.need.toFixed(1)} s (${reading.N} words of narration or label, ${reading.B} in blocks, ${reading.C} cells): add \`wait ${(Math.ceil((reading.need - reading.rest) * 10) / 10 + 0.0).toFixed(1)}s\` more`);
        if (reading.late.length > 0) problems.push(`arrives after the next scene has started clearing it: ${reading.late.join(', ')}`);
      }
      if (table) out(`  ${reading.name.padEnd(14)} N=${String(reading.N).padStart(2)} B=${String(reading.B).padStart(2)} C=${String(reading.C).padStart(2)}  landed ${reading.landed.toFixed(2).padStart(6)}  leaves ${reading.leaves.toFixed(2).padStart(6)}  need ${reading.need.toFixed(1)}  rest ${reading.rest.toFixed(2).padStart(6)}  ${exempt !== undefined ? `exempt: ${exempt}` : reading.empty ? 'nothing on it' : reading.slide ? 'slide: stops the clock' : reading.last ? 'last (rests until the viewer acts)' : problems.length === 0 ? 'ok' : 'SHORT'}\n`);
      for (const problem of problems) {
        if (warn) out(`  READING WARNING (fb-023) ${reading.name}: ${problem}\n      not failing: ${WARN_ONLY[demo.name]}\n`);
        else {
          ok = false;
          out(`  READING CHECK FAILED (fb-023) ${reading.name}: ${problem}\n`);
        }
      }
    }
  }
  out(`reading rule (fb-023): ${timed} of ${scenes} scenes timed, ${ok ? 'every one stays up long enough and arrives before it leaves' : 'see the lines above'}\n`);
  return ok;
}
