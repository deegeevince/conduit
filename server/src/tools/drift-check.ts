// pnpm check's drift group: the server measures what the page measured. No model, no browser.
//
//   pnpm drift-check        (also run by `pnpm check` as the `drift` group)
//
// The page's own painter runs a turn headlessly (`web/src/bench/drift-bench.ts`: a renderer that draws nothing, a clock turned by hand, lines made
// up in the shape of the ones the owner's drifted sessions had) and says what it says to the server: `ready`, then a `draft` and a `report`, each
// with the digest of its boxes and the `facts` it measured with. This file is the server's half. It builds the turn's score as the server holds it
// (every line at an estimated playhead of 0, which is as wrong as an estimate gets), measures it the way the conductor does, with the page's facts,
// and holds the digest against the page's. It does this at the screens the drifted sessions ran on and for each pattern they had in them:
//
//   revise     a revision that came after its words had played is a visible change on the page; the server's estimate said otherwise
//   ask        a hand had answered an ask: the next ask opens and the first one folds, which only the page knew
//   choices    a mouse's target is smaller than a finger's, so a choice is shorter (the server always measured as a finger)
//   controls   a slider the hand moved, then a new question with a slider of the same name
//   cjk, flow, carry, words   the plain cases, so that the check has something that must never drift
//   scripts    Greek, Cyrillic, Arabic: the page measures them in the device's own font, so the server leaves the turn to the page
//   app        a live app is sized by the browser: the server says so and leaves the turn to the page
//
// And the check must be able to see: without the page's facts, the same measure is held against the same digest, and at least one case of each
// of revise, ask and choices has to differ, or the case no longer tests what it was made for.

import { EMPTY_STAGE, TurnScore, parseLine } from '@conduit/language';
import type { BackEvent, Line, PageFacts, StageBase, TurnReport } from '@conduit/language';
import { ENGINE_VERSION } from '@conduit/web/engine';
import { measurable, measureDraft } from '../domain/stage-facts';
import type { MeasureSession } from '../domain/stage-facts';
import { spawnTracked } from '../brains/claude-cli/process';
import { repoRoot } from './explore-browser';
import type { CheckResult } from './smoke';

interface Capture {
  readonly pattern: string;
  readonly screen: { readonly name: string; readonly width: number; readonly height: number; readonly dpr: number; readonly pointer: string };
  readonly ready: Extract<BackEvent, { type: 'ready' }> | null;
  readonly turns: readonly { readonly id: string; readonly opened: string; readonly base: StageBase | null; readonly lines: readonly { readonly seq: number; readonly text: string }[]; readonly events: readonly BackEvent[] }[];
}

/** The page's run, as the bench prints it. */
export async function capture(): Promise<Capture[]> {
  const child = spawnTracked('pnpm', ['--filter', '@conduit/language', 'exec', 'tsx', '--import', '../web/src/bench/node-register.mjs', '../web/src/bench/drift-bench.ts'], undefined, { cwd: repoRoot(), quiet: false });
  let out = '';
  let err = '';
  child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (err += chunk.toString()));
  const code = await new Promise<number | null>((done) => child.once('close', done));
  if (code !== 0) throw new Error(`the page's bench stopped (${code}): ${err.slice(-600)}`);
  return JSON.parse(out.slice(out.indexOf('['))) as Capture[];
}

/** The turn's score as the server holds it: every line at an estimated playhead of 0. */
function serverScore(base: StageBase | null, opened: string, lines: readonly { seq: number; text: string }[]): TurnScore {
  const score = new TurnScore(base ?? EMPTY_STAGE, opened as never);
  for (const { seq, text } of lines) {
    const parsed = parseLine(text);
    if (parsed.kind === 'line') score.push(parsed.line as Line, seq, 0);
  }
  return score;
}

export interface Tally {
  /** every comparison the page made a digest for, and the server's measure with its facts agreed */
  agreed: number;
  /** digests the server could not make agree even with the page's facts */
  differed: string[];
  /** comparisons made, with the same measure but no facts, that differed (the check seeing what it is for) */
  seen: Map<string, number>;
  /** cases the server leaves to the page, as it must */
  left: string[];
}

export function compare(captures: readonly Capture[]): Tally {
  const tally: Tally = { agreed: 0, differed: [], seen: new Map(), left: [] };
  for (const one of captures) {
    const ready = one.ready;
    if (ready === null) {
      tally.differed.push(`${one.pattern} at ${one.screen.name}: the page never said ready`);
      continue;
    }
    const session: MeasureSession = { screen: ready.screen, capabilities: { ...ready.capabilities, engine: ENGINE_VERSION }, tables: [], held: {} };
    let stale: Record<string, import('@conduit/language').ControlValue> = {};
    for (const turn of one.turns) {
      const closing = turn.events.find((event) => event.type === 'report');
      const score = serverScore(turn.base, turn.opened, turn.lines);
      const where = `${one.pattern} at ${one.screen.name} ${turn.id}`;
      if (!measurable(score.schedule)) {
        tally.left.push(where);
        continue;
      }
      const afterwards = closing?.type === 'report' ? (closing.report.controls ?? {}) : {};
      for (const event of turn.events) {
        if (event.type !== 'draft' && event.type !== 'report') continue;
        const pageBoxes = event.boxes;
        if (pageBoxes === undefined) continue;
        if (event.type === 'report' && event.report.outcome !== 'finished') continue;
        const facts: PageFacts | undefined = event.facts;
        const held = event.type === 'report' ? ((event.report as TurnReport).controls ?? {}) : {};
        const kind = event.type === 'report' ? 'report' : `draft ${event.pass}`;
        if (facts === undefined) {
          tally.differed.push(`${where} ${kind}: the page sent no facts`);
          continue;
        }
        const measured = measureDraft(score, { ...session, held }, facts);
        if (measured === null) tally.differed.push(`${where} ${kind}: the server's engine threw`);
        else if (measured.boxes === pageBoxes) tally.agreed += 1;
        else tally.differed.push(`${where} ${kind}: page ${pageBoxes}, server ${measured.boxes}`);
        // the same measure as the server made it before: with no facts at all, with a finger's target whatever the pointer, and with the controls
        // every earlier turn left held (what the server kept for the conversation). Where one of them differs, the facts are what made it agree.
        const variants = [
          measureDraft(score, { ...session, held }),
          measureDraft(score, { ...session, held }, { ...facts, target: 44 }),
          measureDraft(score, { ...session, held }, { ...facts, controls: { ...stale, ...facts.controls } }),
        ];
        if (variants.some((variant) => variant !== null && variant.boxes !== pageBoxes)) tally.seen.set(one.pattern, (tally.seen.get(one.pattern) ?? 0) + 1);
      }
      stale = { ...stale, ...afterwards };
    }
  }
  return tally;
}

/** What each pattern's cases must be able to show without the page's facts, or the case is not testing what it was made for. */
const MUST_SEE = ['revise-late', 'ask-answered', 'choices', 'controls'] as const;

export async function driftProblems(): Promise<{ problems: string[]; tally: Tally }> {
  const problems: string[] = [];
  const tally = compare(await capture());
  if (tally.agreed < 40) problems.push(`only ${tally.agreed} comparisons were made`);
  for (const line of tally.differed.slice(0, 12)) problems.push(line);
  if (tally.differed.length > 12) problems.push(`... and ${tally.differed.length - 12} more`);
  for (const pattern of MUST_SEE) if ((tally.seen.get(pattern) ?? 0) === 0) problems.push(`${pattern}: measured without the page's facts, nothing differed, so this case no longer shows what it was made to`);
  if (!tally.left.some((name) => name.startsWith('app '))) problems.push('app: a live app was not left to the page');
  if (!tally.left.some((name) => name.startsWith('scripts '))) problems.push('scripts: words in a device-font script were not left to the page');
  return { problems, tally };
}

/** The group as `pnpm check` runs it: one result. */
export async function driftGroup(note: (text: string) => void = () => undefined): Promise<CheckResult[]> {
  note('drift');
  try {
    const { problems, tally } = await driftProblems();
    const seen = [...tally.seen].map(([name, count]) => `${name} ${count}`).join(', ');
    return [{ turn: 0, check: 'drift', verdict: problems.length === 0 ? 'PASS' : 'FAIL', detail: problems.length === 0 ? `${tally.agreed} drafts and reports of the page's own painter, at six screens, measured by the server with the page's facts: all agree (without them, differing: ${seen}); ${tally.left.length} left to the page` : problems.join('; ') }];
  } catch (error) {
    return [{ turn: 0, check: 'drift', verdict: 'FAIL', detail: `stopped: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}` }];
  }
}

if (process.argv[1] !== undefined && /drift-check\.ts$/.test(process.argv[1])) {
  driftGroup().then((results) => {
    for (const result of results) process.stdout.write(`${result.verdict} ${result.check}: ${result.detail}\n`);
    process.exit(results.every((result) => result.verdict === 'PASS') ? 0 : 1);
  });
}
