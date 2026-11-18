// Arm D, the staged illustrator: a loop of calls, each shown the picture the last one drew, rendered by the real painter
// in a headless page. At most `looks` rounds and `budgetMs` milliseconds. Each round that draws is offered to the studio as a stage, which the
// conductor shows in place (parts keep their ids and change, new parts draw in); the best round is what is kept, not the last.
//
// It needs a way to look at a picture (`Looker`). Without one, or when the look fails, it does what arm B does: one careful call.

import { parseLine } from '@conduit/language';
import type { Line } from '@conduit/language';
import { ask } from '../judge/ask';
import type { Asked, JudgeSettings, Picture } from '../judge/ask';
import { CHECKLIST, D_SYSTEM, SCORE_SYSTEM, STAGES, svgOf } from './prompts';
import type { Stage } from './prompts';
import { convertSvg } from './svg';
import { requestOf } from './studio';
import type { Commission, Maker, MakerSettings } from './studio';

/** Renders drawn lines to a PNG (base64), in a headless page. */
export interface Looker {
  look(lines: readonly Line[]): Promise<string>;
}

export interface StagedOptions {
  readonly settings: MakerSettings;
  readonly looker: Looker | null;
  /** the maker to fall back on when there is nothing to look with (arm B) */
  readonly fallback: Maker;
  /** the most rounds: 4 */
  readonly looks?: number;
  /** the most time, from the first call: 4 minutes */
  readonly budgetMs?: number;
  /** the model for each call; the strongest the login has. A test gives its own. */
  readonly model?: string;
  readonly call?: typeof ask;
}

/** The look the painter gives every picture: paper, a square canvas, nothing else on stage. */
export const PRELUDE: readonly Line[] = ['look paper', 'scene art layout=free canvas=square'].map((raw) => {
  const parsed = parseLine(raw);
  if (parsed.kind !== 'line') throw new Error(`prelude does not parse: ${raw}`);
  return parsed.line;
});

export const STAGED = { looks: 4, budgetMs: 240_000 } as const;

interface Round {
  readonly stage: string;
  readonly svg: string | null;
  readonly png: string | null;
  score: number | null;
}

export function stagedMaker(options: StagedOptions): Maker {
  const call = options.call ?? ask;
  const looks = options.looks ?? STAGED.looks;
  const budgetMs = options.budgetMs ?? STAGED.budgetMs;
  return async (commission: Commission, hooks) => {
    if (options.looker === null) return options.fallback(commission, hooks);
    const looker = options.looker;
    const started = Date.now();
    const model = options.model ?? 'fable';
    const settings = (effort: JudgeSettings['effort']): JudgeSettings => ({ bin: options.settings.bin, model, effort, timeoutMs: options.settings.callMs, ...(options.settings.meter === undefined ? {} : { meter: options.settings.meter }) });
    const rounds: Round[] = [];
    let usd: number | null = null;
    const pay = (asked: Asked): void => {
      if (asked.cost !== null) usd = (usd ?? 0) + asked.cost;
    };
    let last: { svg: string; png: string } | null = null;
    let complaint: string | null = null;
    let shown = -1;
    for (let at = 0; at < looks; at += 1) {
      if (hooks.signal.aborted) throw new Error('the studio was stopped');
      if (at > 0 && Date.now() - started > budgetMs) break;
      const stage = STAGES[Math.min(at, STAGES.length - 1)] as Stage;
      const parts: string[] = [requestOf(commission), `Round ${at + 1} of at most ${looks}. Stage: ${stage.brief}`];
      const pictures: Picture[] = [];
      if (last !== null) {
        parts.push(`The picture as last drawn is attached, and this is the SVG behind it:\n${last.svg}`, `Checklist for this stage: ${CHECKLIST[stage.name] ?? ''}`);
        pictures.push({ data: last.png, mime: 'image/png' });
      }
      if (complaint !== null) parts.push(`Your last SVG was rejected by the converter and not drawn: ${complaint}. Fix that.`);
      const asked = await call(D_SYSTEM, parts.join('\n\n'), pictures, settings(stage.effort), hooks.signal);
      pay(asked);
      if (asked.failure !== null) {
        if (rounds.some((round) => round.png !== null)) break;
        throw new Error(`the model call failed: ${asked.failure}`);
      }
      const seen = /SEEN:\s*(\d+(?:\.\d+)?)/i.exec(asked.reply);
      if (seen !== null && shown >= 0 && rounds[shown] !== undefined) (rounds[shown] as Round).score = Number(seen[1]);
      const svg = svgOf(asked.reply);
      if (svg === null) {
        if (/^\s*DONE\s*$/im.test(asked.reply) && last !== null) break;
        complaint = 'the reply held no <svg>';
        rounds.push({ stage: stage.name, svg: null, png: null, score: null });
        continue;
      }
      const converted = convertSvg(svg);
      if (!converted.ok) {
        complaint = converted.reason;
        rounds.push({ stage: stage.name, svg, png: null, score: null });
        continue;
      }
      complaint = null;
      let png: string;
      try {
        png = await looker.look([...PRELUDE, ...converted.lines]);
      } catch (error) {
        // nothing to look with: what has been drawn is kept, and if it is nothing, arm B's one careful call stands in
        if (rounds.some((round) => round.png !== null)) break;
        void error;
        return options.fallback(commission, hooks);
      }
      rounds.push({ stage: stage.name, svg, png, score: null });
      shown = rounds.length - 1;
      last = { svg, png };
      hooks.stage(svg, at + 1);
    }
    const final = rounds[shown];
    if (final !== undefined && final.score === null && final.png !== null && !hooks.signal.aborted) {
      const scored = await call(SCORE_SYSTEM, `Subject: ${commission.words}. Score this picture as a finished illustration of it.`, [{ data: final.png, mime: 'image/png' }], settings('low'), hooks.signal);
      pay(scored);
      const n = /\d+(?:\.\d+)?/.exec(scored.reply);
      if (scored.failure === null && n !== null) final.score = Number(n[0]);
    }
    const drawn = rounds.filter((round) => round.svg !== null && round.png !== null);
    if (drawn.length === 0) throw new Error('no round drew');
    // the best round, not the last: the highest self-score, the later one on a tie; with no scores at all, the last
    let best = drawn[drawn.length - 1] as Round;
    for (const round of drawn) if (round.score !== null && (best.score === null || round.score >= best.score)) best = round;
    return { svg: best.svg as string, by: model, arm: 'D', how: `the staged illustrator, ${rounds.length} look${rounds.length === 1 ? '' : 's'}, kept round ${rounds.indexOf(best) + 1} (bake-off arm D)`, usd };
  };
}
