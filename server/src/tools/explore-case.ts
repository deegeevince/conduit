// A scripted conversation of two to four turns, played the way a person would: each answer is laid out by the
// painter's own engine (explore-browser), the report the painter would have sent is turned into the brain's memory,
// and the next turn is asked of the SAME brain session, so a warm process, the cache, a look change, an interruption,
// a tap and "look at what you drew; fix it" are all exercised for real.

import { FULL_CAPABILITIES, LEAD_WINDOW, REFERENCE_SCREEN, verdictsOf } from '@conduit/language';
import type {
  ExploreCase,
  ExploreCaseResult,
  ExploreCaseTurn,
  ExploreJudgement,
  ExplorePrompt,
  ExploreResult,
  ExploreVariant,
  ExploreVerdict,
  Line,
  LineProblem,
  ScreenFacts,
  Services,
  StageBase,
  TurnMemory,
  TurnInput,
} from '@conduit/language';
import type { Snapshot } from '../domain/brain';
import type { Eyes, HarnessReply } from './explore-browser';
import { cacheShareOf, playTurn } from './explore-turn';
import type { TurnPlay } from './explore-turn';
import type { Rig } from './explore-rig';
import { judgeStills } from './explore-rig';

export const PHONE_SCREEN: ScreenFacts = { width: 390, height: 844, dpr: 3, cols: 30, rows: 14, canvas: 'tall', reducedMotion: false, pointer: 'coarse' };

const FIX_TEXT = 'Look at what you drew. Fix whatever is wrong with it.';

/** Verdicts of a turn that say something about the conversation rather than the single answer. */
const CONVERSATION_LABELS: ReadonlySet<string> = new Set([
  'finished',
  'no rejected line',
  'first line within 4 s',
  'warm (brief was since)',
  'cache reads over 80%',
  'turn could be played',
  'judge: shows what was asked',
  'judge: text readable',
  'judge: drawing correct',
  'judge: coherence 4 or more',
]);

function snapshotOf(reply: HarnessReply, viewport: { width: number; height: number }): Snapshot | null {
  if (reply.snapshot === null) return null;
  const long = Math.max(viewport.width, viewport.height);
  const scale = Math.min(1, 768 / long);
  return { mime: 'image/jpeg', bytes: new Uint8Array(Buffer.from(reply.snapshot, 'base64')), width: Math.round(viewport.width * scale), height: Math.round(viewport.height * scale) };
}

export interface CaseDone {
  readonly result: ExploreCaseResult;
  /** the judge verdicts are still being asked for; settles when they are in and `result` is final */
  readonly settled: Promise<ExploreCaseResult>;
}

/** Plays one case once. Resolves with the played turns at once; `settled` has the judge's verdicts too. */
export async function playCase(rig: Rig, scripted: ExploreCase, variant: ExploreVariant, sample: number, eyes: Eyes): Promise<CaseDone> {
  const session = `explore-${rig.runId}-${scripted.id}-${variant}-${sample}`;
  const services: Services = rig.services;
  let screen: ScreenFacts = REFERENCE_SCREEN;
  let stage: StageBase = rig.emptyStage;
  const history: TurnMemory[] = [];
  let snapshot: Snapshot | null = null;
  const played: ExploreResult[] = [];
  const judgements: (Promise<ExploreJudgement | null> | null)[] = [];
  const conversation: string[] = [];

  rig.brain.open?.({ session, capabilities: FULL_CAPABILITIES, screen, services });

  for (let index = 1; index <= scripted.turns.length; index += 1) {
    const step: ExploreCaseTurn | undefined = scripted.turns[index - 1];
    if (step === undefined || rig.stopped()) break;
    let problem: string | null = null;
    const changes: string[] = [];

    // What the viewer did to the window before speaking.
    if (step.do === 'prompt' && step.look !== undefined) {
      stage = { ...stage, look: step.look, lookName: step.look };
      changes.push(`look changed to ${step.look}`);
    }
    if (step.do === 'prompt' && step.screen !== undefined) {
      screen = step.screen === 'phone' ? PHONE_SCREEN : REFERENCE_SCREEN;
      changes.push(`window became ${step.screen} (${screen.width}x${screen.height})`);
    }
    if (changes.length > 0 && step.do === 'prompt') {
      // The server tells the brain again whenever the painter says `ready`; a brain that rebuilds for it would be caught here.
      rig.brain.open?.({ session, capabilities: FULL_CAPABILITIES, screen, services });
    }

    let input: TurnInput;
    let said: string;
    if (step.do === 'prompt') {
      input = { kind: 'prompt', text: step.text };
      said = step.text;
    } else if (step.do === 'fix') {
      said = step.text ?? FIX_TEXT;
      input = { kind: 'prompt', text: said };
    } else {
      const choice = stage.elements.find((element) => element.style.tap && !element.struck && element.parent === null);
      if (choice === undefined) {
        problem = 'the previous answer left no choice to tap';
        said = '(nothing to tap)';
        input = { kind: 'prompt', text: 'Go on.' };
      } else {
        said = choice.text;
        input = { kind: 'tap', id: choice.id, text: choice.text };
      }
    }
    conversation.push(`User: ${said}`);

    const prompt: ExplorePrompt = { id: `${scripted.id}-t${index}`, useCase: scripted.useCase, prompt: said, expects: 'any', baseline: false };
    const next = scripted.turns[index];
    const cut = step.do === 'prompt' && step.interruptAfterMs !== undefined && next !== undefined ? step.interruptAfterMs : null;
    const play: TurnPlay = {
      prompt,
      session,
      turn: `${session}-t${index}`,
      idPrefix: `t${index}`,
      input,
      context: { screen, capabilities: FULL_CAPABILITIES, services, lead: LEAD_WINDOW, stage, history: [...history], heard: [] },
      snapshot,
      brain: rig.brain,
      timeoutMs: rig.timeoutMs,
      interruptAfterMs: cut,
      signal: rig.running.controller.signal,
      why: () => rig.running.reason,
    };
    const done = await playTurn(play);
    const kind = step.do;
    const meta: ExploreResult['turn'] = {
      case: scripted.id,
      index,
      kind,
      said,
      form: done.form,
      cacheReadShare: cacheShareOf(done.result.usage),
      withSnapshot: done.withSnapshot,
      interruptedAtMs: done.interruptedAtMs,
      changed: changes.length === 0 ? null : changes.join('; '),
      problem,
    };

    // What the painter would have reported when this turn stopped, and the pictures.
    let reply: HarnessReply | null = null;
    let seeing: string | null = null;
    try {
      reply = await eyes.look({
        turn: play.turn,
        base: stage,
        lines: done.result.lines.map((line, at) => ({ seq: line.seq, line: done.accepted[at] as Line })),
        viewport: { width: screen.width, height: screen.height, dpr: 1 },
        playhead: done.playhead,
        earlier: rig.judgeEarlier,
        judgeSide: rig.judgeSide,
      });
    } catch (error) {
      seeing = error instanceof Error ? error.message : String(error);
    }

    const before = stage;
    let result: ExploreResult = { ...done.result, turn: meta, ...(before === rig.emptyStage ? {} : { base: before }) };
    if (seeing !== null) result = { ...result, message: `${result.message ?? ''}${result.message === null ? '' : '; '}could not picture the stage: ${seeing}` };
    played.push(result);

    // Memory is what was shown. Without a report nothing can be assumed seen.
    const problems: LineProblem[] = done.rejectedNotes.map((note) => ({ raw: note.raw, kind: 'rejected', why: note.why }));
    if (reply !== null) {
      history.push({ turn: play.turn, input, outcome: reply.report.outcome, playhead: reply.report.playhead, shown: reply.report.shown, sight: reply.report.sight, skippedAt: null, problems, snapshot: reply.snapshot !== null });
      stage = reply.report.stage;
      snapshot = snapshotOf(reply, { width: screen.width, height: screen.height });
    } else {
      history.push({ turn: play.turn, input, outcome: done.result.end === 'done' ? 'unseen' : 'failed', playhead: null, shown: [], sight: null, skippedAt: null, problems, snapshot: false });
      snapshot = null;
    }

    // A turn after a cut must have been told; a tap must arrive as a tap.
    if (index > 1) {
      const previous = scripted.turns[index - 2];
      const wasCut = previous !== undefined && previous.do === 'prompt' && previous.interruptAfterMs !== undefined;
      const prior = played[index - 2];
      if (wasCut && prior !== undefined && prior.turn?.interruptedAtMs != null) {
        const told = done.brief.includes('interrupted');
        played[index - 1] = { ...result, verdicts: [...(result.verdicts ?? []), { label: 'brief says the last answer was cut off', ok: told, detail: told ? 'it does' : 'the brief does not mention it' }] };
        result = played[index - 1] as ExploreResult;
      }
      if (step.do === 'fix') {
        const sees = done.withSnapshot && /picture attached/i.test(done.brief);
        played[index - 1] = { ...result, verdicts: [...(result.verdicts ?? []), { label: 'fix turn was given the picture and the sight report', ok: sees, detail: sees ? 'picture attached' : 'no picture in the brief' }] };
        result = played[index - 1] as ExploreResult;
      }
    }

    // The judge looks while the next turn is being written. A cut-off answer is not a finished picture.
    const judged = scripted.judged !== false && reply !== null && done.interruptedAtMs === null && problem === null && rig.judgeSettings !== null;
    if (judged && reply !== null) {
      const request = `${conversation.join('\n')}${changes.length > 0 ? `\n(The viewer's window changed first: ${changes.join('; ')}.)` : ''}\n\nJudge the stage after the user's LAST message.`;
      judgements.push(judgeStills(rig, request, reply));
    } else {
      judgements.push(null);
    }
    conversation.push('(The assistant answered on the stage.)');
  }
  rig.brain.release?.(session);

  const finalize = async (): Promise<ExploreCaseResult> => {
    const verdictsOfTurns: ExploreVerdict[] = [];
    const judges = await Promise.all(judgements);
    const turns: ExploreResult[] = played.map((turn, at) => {
      const judge = judges[at] ?? null;
      const withJudge: ExploreResult = { ...turn, ...(judge === null ? {} : { judge }) };
      const verdicts = [...verdictsOf(withJudge), ...(turn.verdicts ?? []).filter((extra) => !verdictsOf(withJudge).some((v) => v.label === extra.label))];
      verdicts.sort((a, b) => Number(a.ok) - Number(b.ok));
      for (const verdict of verdicts) {
        if (CONVERSATION_LABELS.has(verdict.label) || verdict.label.startsWith('brief says') || verdict.label.startsWith('fix turn')) {
          verdictsOfTurns.push({ ...verdict, label: `turn ${at + 1}: ${verdict.label}` });
        }
      }
      return { ...withJudge, verdicts };
    });

    // Did looking at its own picture help? Compare the judge's score on the answer before the fix with the fix.
    let fix: ExploreCaseResult['fix'] = null;
    const fixAt = scripted.turns.findIndex((turn) => turn.do === 'fix');
    if (fixAt > 0) {
      const before = judges[fixAt - 1]?.failure === null ? (judges[fixAt - 1]?.coherence ?? null) : null;
      const after = judges[fixAt]?.failure === null ? (judges[fixAt]?.coherence ?? null) : null;
      const improved = before === null || after === null ? null : after > before || (before === 5 && after === 5);
      fix = { before, after, improved };
      if (improved !== null) {
        verdictsOfTurns.push({ label: 'fixing it raised the judge’s score', ok: improved, detail: `coherence ${before} before, ${after} after` });
      }
    }
    verdictsOfTurns.sort((a, b) => Number(a.ok) - Number(b.ok));
    return { case: scripted, variant, sample, turns, fix, verdicts: verdictsOfTurns };
  };

  // The caller gets the played turns at once and the finished record when the judge has spoken.
  const settled = finalize();
  const provisional: ExploreCaseResult = { case: scripted, variant, sample, turns: played, fix: null, verdicts: [] };
  return { result: provisional, settled };
}
