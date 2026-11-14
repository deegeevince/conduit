// A scripted conversation of two to four turns, played the way a person would: each answer is laid out by the
// painter's own engine (explore-browser), the report the painter would have sent is turned into the brain's memory,
// and the next turn is asked of the SAME brain session, so a warm process, the cache, a look change, an interruption,
// a tap and "look at what you drew; fix it" are all exercised for real.

import { LEAD_WINDOW, REFERENCE_SCREEN, verdictsOf } from '@conduit/language';
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
import { STRIP, techniquesFor } from './explore-rig';
import { driveOf, inspect } from './explore-inspect';
import type { DriveReply } from './explore-browser';

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
  let screen: ScreenFacts = rig.screen;
  let stage: StageBase = rig.emptyStage;
  const history: TurnMemory[] = [];
  let snapshot: Snapshot | null = null;
  const played: ExploreResult[] = [];
  const judgements: (Promise<ExploreJudgement | null> | null)[] = [];
  const conversation: string[] = [];
  // Working a control sends no word to the brain and opens no turn, so it is not a turn here: the run works every control of every
  // answer (explore-inspect) and records it on that answer. The step only asserts there was something to work.
  const steps = scripted.turns.filter((turn) => turn.do !== 'control');
  const controlSteps = scripted.turns.length - steps.length;
  let driven = null as DriveReply | null;
  let controlsSeen = 0;

  rig.brain.open?.({ session, capabilities: rig.capabilities, screen, services });

  for (let index = 1; index <= steps.length; index += 1) {
    const step: ExploreCaseTurn | undefined = steps[index - 1];
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
      rig.brain.open?.({ session, capabilities: rig.capabilities, screen, services });
    }

    let input: TurnInput;
    let said: string;
    if (step.do === 'prompt') {
      input = { kind: 'prompt', text: step.text };
      said = step.text;
    } else if (step.do === 'fix') {
      said = step.text ?? FIX_TEXT;
      input = { kind: 'prompt', text: said };
    } else if (step.do === 'press') {
      const pressed = driven?.pressed ?? null;
      if (pressed === null) {
        problem = 'the previous answer left no button to press';
        said = '(nothing to press)';
        input = { kind: 'prompt', text: 'Go on.' };
      } else {
        said = pressed.text;
        input = { kind: 'act', id: pressed.id, text: pressed.text, values: pressed.values };
      }
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

    const chosen = techniquesFor(rig, input);
    const prompt: ExplorePrompt = { id: `${scripted.id}-t${index}`, useCase: scripted.useCase, prompt: said, expects: 'any', baseline: false };
    const next = steps[index];
    const cut = step.do === 'prompt' && step.interruptAfterMs !== undefined && next !== undefined ? step.interruptAfterMs : null;
    const play: TurnPlay = {
      prompt,
      session,
      turn: `${session}-t${index}`,
      idPrefix: `t${index}`,
      input,
      context: { screen, capabilities: rig.capabilities, services, lead: LEAD_WINDOW, stage, history: [...history], heard: [], techniques: chosen.cards },
      snapshot,
      brain: rig.brain,
      timeoutMs: rig.timeoutMs,
      interruptAfterMs: cut,
      signal: rig.running.controller.signal,
      why: () => rig.running.reason,
    };
    const done = await playTurn(play);
    const kind = step.do === 'press' ? 'act' : step.do;
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
    const before = stage;
    let result: ExploreResult = { ...done.result, turn: meta, ...(before === rig.emptyStage ? {} : { base: before }), ...(chosen.ids.length > 0 ? { techniques: chosen.ids } : {}) };
    const mayJudge = scripted.judged !== false && done.interruptedAtMs === null && problem === null && rig.judgeSettings !== null;
    let reply: HarnessReply | null = null;
    let seeing: string | null = null;
    let judgement: Promise<ExploreJudgement | null> = Promise.resolve(null);
    try {
      const request = `${conversation.join('\n')}${changes.length > 0 ? `\n(The viewer's window changed first: ${changes.join('; ')}.)` : ''}\n\nJudge the stage after the user's LAST message.`;
      const seen = await inspect(
        rig,
        eyes,
        {
          turn: play.turn,
          base: stage,
          lines: done.result.lines.map((line, at) => ({ seq: line.seq, line: done.accepted[at] as Line })),
          viewport: { width: screen.width, height: screen.height, dpr: 1 },
          playhead: done.playhead,
          earlier: rig.judgeEarlier,
          judgeSide: rig.judgeSide,
          strip: STRIP,
        },
        request,
        result,
        mayJudge,
      );
      reply = seen.reply;
      judgement = seen.judgement;
      driven = seen.driven;
      controlsSeen += seen.driven?.controls.length ?? 0;
      result = { ...result, geometry: seen.geometry, ...(seen.driven === null ? {} : { drive: driveOf(seen.driven) }) };
    } catch (error) {
      seeing = error instanceof Error ? error.message : String(error);
    }
    if (seeing !== null) result = { ...result, message: `${result.message ?? ''}${result.message === null ? '' : '; '}could not picture the stage: ${seeing}` };
    played.push(result);
    judgements.push(judgement);
    if (step.do === 'press' && problem === null && index > 1) {
      // The press is answered when the act turn ran to its end with lines on stage.
      const answered = done.result.end === 'done' && done.result.lines.length > 0;
      const earlier = played[index - 2];
      if (earlier?.drive !== undefined) {
        played[index - 2] = { ...earlier, drive: { ...earlier.drive, controls: earlier.drive.controls.map((control) => (control.kind === 'button' && control.answered === null ? { ...control, answered } : control)) } };
      }
    }

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
      const previous = steps[index - 2];
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
    if (controlSteps > 0) verdictsOfTurns.push({ label: 'a control was left to work', ok: controlsSeen > 0, detail: controlsSeen > 0 ? `${controlsSeen} worked` : 'the answer left none' });
    verdictsOfTurns.sort((a, b) => Number(a.ok) - Number(b.ok));
    return { case: scripted, variant, sample, turns, fix, verdicts: verdictsOfTurns };
  };

  // The caller gets the played turns at once and the finished record when the judge has spoken.
  const settled = finalize();
  const provisional: ExploreCaseResult = { case: scripted, variant, sample, turns: played, fix: null, verdicts: [] };
  return { result: provisional, settled };
}
