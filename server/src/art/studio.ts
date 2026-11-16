// The studio (PLAN-art.md, sections 6 and 7): when a `draw` line misses the shelf, a drawing is commissioned here, made off the answer's clock, kept
// in the shelf's cache, and handed back to whoever is waiting for it. Nothing here touches the stage: the conductor listens, and swaps the sheet
// in for the placeholder when it is safe to (`Conductor.showArt`).
//
//   - One commission at a time, deduplicated by the shelf key: two conversations asking for a giraffe share one drawing.
//   - The model is the strongest the login has (Fable, else Opus), on the owner's own `claude` login through `ask()`: no tools, no API key.
//   - Ceilings: `ART_PER_HOUR` commissions an hour; none while the usage throttle says near or over its cap; none when `ART_MAKER=off`.
//   - A drawing that fails (a failed call, no SVG, a refusal by the converter) leaves the placeholder, is logged with why, and is not tried again
//     for the same key within the hour.
//   - The maker is a function, so a test gives the studio a fake one that returns a fixed SVG.

import { ask } from '../judge/ask';
import type { JudgeUsage } from '../judge/ask';
import type { Logger } from '../log';
import type { Throttle } from '../usage';
import { importSvg } from './import';
import { STYLE, svgOf } from './prompts';
import type { Facing, Sheet } from './sheet';
import { shelfKey } from './shelf';
import type { Shelf } from './shelf';

export type MakerKind = 'one' | 'staged' | 'off' | 'fake';

export interface ArtPolicy {
  /** `ART_MAKER`: `one` (arm B, one careful call), `staged` (arm D, the loop that sees its picture), `off` (a miss stays a placeholder), `fake` (a test rig's fixed drawing) */
  readonly maker: MakerKind;
  /** `ART_PER_HOUR`: commissions accepted in any rolling hour */
  readonly perHour: number;
  /** the longest one model call may take */
  readonly callMs: number;
  /** a test rig's wait before the fake maker answers */
  readonly fakeMs: number;
  /** `ART_EYES_PORT`: the web dev server the staged maker looks at its pictures on */
  readonly eyesPort: number;
  /** a test rig's switch: the fake maker offers a rough first stage */
  readonly fakeStages: boolean;
}

export const ART_POLICY: ArtPolicy = { maker: 'off', perHour: 12, callMs: 300_000, fakeMs: 1_500, eyesPort: 4879, fakeStages: false };

/** What is wanted: the shelf's name for the subject, and what the brain said around it. */
export interface Commission {
  /** `subject.pose.view`: what the shelf files the sheet under, and what two askers share */
  readonly key: string;
  readonly subject: string;
  readonly pose: string;
  readonly view: string;
  readonly facing: Facing;
  /** the words the brain used, for the picture-book illustrator to read */
  readonly words: string;
  /** what was said after the bar: pose, view, mood */
  readonly detail: string;
}

export function commissionOf(subject: string, words: string, want: { readonly pose: string | null; readonly view: string | null; readonly facing: 'left' | 'right' | null }, detail: string): Commission {
  const view = want.view ?? 'side';
  const pose = want.pose ?? '';
  return { key: shelfKey(subject, pose, view), subject, pose, view, facing: view === 'front' ? 'front' : (want.facing ?? 'left'), words: clean(words, 80), detail: clean(detail, 120) };
}

const clean = (text: string, max: number): string => text.replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

export type StudioEvent =
  /** a drawing worth showing before the last (the staged maker's rounds) */
  | { readonly kind: 'stage'; readonly sheet: Sheet; readonly round: number }
  /** the drawing is made and kept on the shelf */
  | { readonly kind: 'made'; readonly sheet: Sheet; readonly ms: number; readonly usd: number | null }
  | { readonly kind: 'failed'; readonly why: string };

export type Listener = (event: StudioEvent) => void;

export type Accepted = { readonly ok: true; readonly joined: boolean } | { readonly ok: false; readonly why: string };

export interface Studio {
  readonly maker: MakerKind;
  /** Asks for a drawing. Never waits for it: the answer is `ok` (the listener will hear), or why not. */
  commission(commission: Commission, listener: Listener): Accepted;
  /** resolves when nothing is queued or being made: for tests and for shutdown */
  idle(): Promise<void>;
  /** abandons what is being made */
  stop(): void;
}

/** What a maker hands back. It throws an `Error` whose message says why when it cannot draw. */
export interface Made {
  /** the SVG to convert: the best of its rounds */
  readonly svg: string;
  /** the model that drew it, for the sheet's `made.by` */
  readonly by: string;
  /** the arm's letter, for the sheet's `made.arm` (`B`, `D`) */
  readonly arm: string;
  /** a clause for the sheet's `how` */
  readonly how: string;
  readonly usd: number | null;
}

export interface MakerHooks {
  readonly signal: AbortSignal;
  /** offers a drawing that is better than nothing, while the maker goes on: shown in place, never kept as the finished sheet */
  stage(svg: string, round: number): void;
}

export type Maker = (commission: Commission, hooks: MakerHooks) => Promise<Made>;

export interface StudioDeps {
  readonly policy: ArtPolicy;
  readonly shelf: Shelf;
  readonly maker: Maker;
  readonly throttle: Throttle;
  readonly log: Logger;
  readonly now: () => number;
}

const HOUR_MS = 3_600_000;
const QUEUE_LIMIT = 6;
export const HOUSE_LICENCE = "MIT (made for this project on the owner's own subscription)";

interface Job {
  readonly commission: Commission;
  readonly listeners: Listener[];
}

export function createStudio(deps: StudioDeps): Studio {
  const { policy, shelf, maker, throttle, log, now } = deps;
  const queue: Job[] = [];
  const accepted: number[] = [];
  const failedAt = new Map<string, number>();
  let running: { job: Job; abort: AbortController } | null = null;
  let waiting: (() => void)[] = [];

  const tell = (job: Job, event: StudioEvent): void => {
    for (const listener of job.listeners) {
      try {
        listener(event);
      } catch (error) {
        log.warn('art.listener_failed', { key: job.commission.key, error });
      }
    }
  };

  async function make(job: Job, signal: AbortSignal): Promise<void> {
    const { commission } = job;
    const started = now();
    if (throttle.state(now()) === 'near' || throttle.state(now()) === 'over') {
      log.info('art.skipped', { key: commission.key, why: 'usage is near the cap' });
      return tell(job, { kind: 'failed', why: 'usage is near the cap' });
    }
    // another process may have drawn it while this waited in the queue
    const there = shelf.find(commission.subject, { pose: commission.pose || null, view: commission.view });
    if (there !== null && there.sheets.length > 0) {
      log.info('art.already', { key: commission.key });
      return tell(job, { kind: 'made', sheet: there.sheets[0] as Sheet, ms: 0, usd: null });
    }
    log.info('art.started', { key: commission.key, maker: policy.maker, words: commission.words });
    try {
      const staged = (svg: string, round: number): void => {
        const read = importSvg(svg, metaOf(commission, 'D', 'fable', 'a stage of the drawing'));
        if (read.ok) tell(job, { kind: 'stage', sheet: read.sheet, round });
        else log.info('art.stage_refused', { key: commission.key, round, why: read.reason });
      };
      const made = await maker(commission, { signal, stage: staged });
      const seconds = Math.round((now() - started) / 100) / 10;
      const how = `${made.by}, ${made.how}, ${seconds} s${made.usd === null ? '' : `, $${made.usd.toFixed(2)}`}; read by the strict converter and restyled to the house palette`.slice(0, 200);
      const imported = importSvg(made.svg, { ...metaOf(commission, made.arm, made.by, how) });
      if (!imported.ok) throw new Error(`the converter refused the drawing: ${imported.reason}`);
      await shelf.write(imported.sheet);
      log.info('art.made', { key: commission.key, arm: made.arm, by: made.by, parts: imported.sheet.parts.length, ms: now() - started, usd: made.usd, notes: imported.notes.join('; ') });
      tell(job, { kind: 'made', sheet: imported.sheet, ms: now() - started, usd: made.usd });
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      // a drawing that failed is not tried again for this key within the hour (a stop is not a failure of the drawing)
      if (!signal.aborted) failedAt.set(commission.key, now());
      log.warn('art.failed', { key: commission.key, why, ms: now() - started });
      tell(job, { kind: 'failed', why: signal.aborted ? 'the studio was stopped' : why });
    }
  }

  function kick(): void {
    if (running !== null) return;
    const job = queue.shift();
    if (job === undefined) {
      const done = waiting;
      waiting = [];
      for (const resolve of done) resolve();
      return;
    }
    const abort = new AbortController();
    running = { job, abort };
    void make(job, abort.signal)
      .catch((error: unknown) => log.error('art.escaped', { key: job.commission.key, error }))
      .finally(() => {
        running = null;
        kick();
      });
  }

  return {
    maker: policy.maker,
    commission(commission, listener) {
      if (policy.maker === 'off') return { ok: false, why: 'the art maker is off' };
      const same = running?.job.commission.key === commission.key ? running.job : queue.find((job) => job.commission.key === commission.key);
      if (same !== undefined) {
        same.listeners.push(listener);
        return { ok: true, joined: true };
      }
      const failed = failedAt.get(commission.key);
      if (failed !== undefined && now() - failed < HOUR_MS) return { ok: false, why: 'a drawing of this failed within the hour' };
      const state = throttle.state(now());
      if (state === 'near' || state === 'over') return { ok: false, why: 'usage is near the cap' };
      while (accepted.length > 0 && now() - (accepted[0] as number) >= HOUR_MS) accepted.shift();
      if (accepted.length >= policy.perHour) return { ok: false, why: `${policy.perHour} drawings an hour have been made` };
      if (queue.length >= QUEUE_LIMIT) return { ok: false, why: 'too many drawings are waiting' };
      accepted.push(now());
      queue.push({ commission, listeners: [listener] });
      log.info('art.commissioned', { key: commission.key, words: commission.words, queued: queue.length, running: running !== null });
      kick();
      return { ok: true, joined: false };
    },
    idle() {
      return running === null && queue.length === 0 ? Promise.resolve() : new Promise<void>((resolve) => waiting.push(resolve));
    },
    stop() {
      queue.length = 0;
      running?.abort.abort();
    },
  };
}

function metaOf(commission: Commission, arm: string, by: string, how: string): Parameters<typeof importSvg>[1] {
  return { subject: commission.subject, pose: commission.pose, view: commission.view, facing: commission.facing, by, arm, how, licence: HOUSE_LICENCE, brush: 'ink' };
}

// ---- the makers ----

export interface MakerSettings {
  readonly bin: string;
  readonly callMs: number;
  /** told about every call, whatever came of it */
  readonly meter?: (call: { readonly model: string; readonly usage: JudgeUsage; readonly failure: string | null }) => void;
}

/** The words of one request for a drawing: what to draw, the detail the brain gave, and the way it faces. */
export function requestOf(commission: Commission): string {
  const facing = commission.facing === 'front' ? 'Seen from the front.' : `If it has a front, it faces the viewer's ${commission.facing}; if it has none (a tree, a house), draw it straight on.`;
  return `Draw: ${commission.words}.${commission.detail === '' ? '' : ` Asked for: ${commission.detail}.`} ${facing}`;
}

/** The strongest model the login offers: the first that answers. Remembered, so the second drawing does not ask Fable again if Fable was not there. */
const MODELS = ['fable', 'opus'] as const;

/** Arm B: one call at high effort, one strict SVG (the bake-off's own prompt). */
export function oneShotMaker(settings: MakerSettings): Maker {
  let first = 0;
  return async (commission, hooks) => {
    let failure = 'no model answered';
    for (let at = first; at < MODELS.length; at += 1) {
      const model = MODELS[at] as string;
      const asked = await ask(STYLE, requestOf(commission), [], { bin: settings.bin, model, effort: 'high', timeoutMs: settings.callMs, ...(settings.meter === undefined ? {} : { meter: settings.meter }) }, hooks.signal);
      if (hooks.signal.aborted) throw new Error('the studio was stopped');
      if (asked.failure !== null) {
        failure = `the model call failed (${model}): ${asked.failure}`;
        // a model the login does not offer fails at once: go down one; a slow failure is the model's own, and is not blamed on the name
        if (asked.ms < 60_000 && at + 1 < MODELS.length) continue;
        throw new Error(failure);
      }
      first = at;
      const svg = svgOf(asked.reply);
      if (svg === null) throw new Error('the reply held no <svg>');
      return { svg, by: model, arm: 'B', how: 'one careful drawing off the answer\'s clock (bake-off arm B)', usd: asked.cost };
    }
    throw new Error(failure);
  };
}

/**
 * A test rig's maker: a fixed drawing, after a short wait, whatever was asked. With `stages`, a rough first drawing comes halfway, with a part
 * (`blob`) the finished one does not have, so the swap's morph, new parts and dropped parts can be seen.
 */
export function fakeMaker(waitMs: number, stages = false): Maker {
  const wait = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
    });
  return async (_commission, hooks) => {
    // a test rig's subject that cannot be drawn: the commission fails, with no stage first
    if (_commission.subject === 'unmakeable') {
      await wait(waitMs, hooks.signal);
      throw new Error('the fake maker was told to fail');
    }
    if (stages) {
      await wait(waitMs / 2, hooks.signal);
      if (!hooks.signal.aborted) hooks.stage(FAKE_ROUGH_SVG, 1);
      await wait(waitMs / 2, hooks.signal);
    } else await wait(waitMs, hooks.signal);
    if (hooks.signal.aborted) throw new Error('the studio was stopped');
    return { svg: FAKE_SVG, by: 'fake', arm: stages ? 'D' : 'B', how: 'a fixed drawing for a test', usd: 0 };
  };
}

/** The rough first stage: a body, a neck and a head, and a `blob` the finished drawing leaves out. */
export const FAKE_ROUGH_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<ellipse id="body" cx="50" cy="58" rx="20" ry="10" fill="#e0a83a" stroke="#4a2f10" stroke-width="1.8"/>
<path id="neck" d="M36 56 C34 40 34 30 38 20 L44 22 C42 32 42 44 44 54 Z" fill="#e0a83a" stroke="#4a2f10" stroke-width="1.8"/>
<ellipse id="head" cx="38" cy="16" rx="8" ry="5" fill="#e8b84c" stroke="#4a2f10" stroke-width="1.8"/>
<circle id="blob" cx="70" cy="30" r="6" fill="#a8741c"/>
</svg>`;

/** A tall, long-necked creature in the strict dialect: enough parts to read as one, and a `neck` and a `head` for a label to point at. */
export const FAKE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<ellipse id="shadow" cx="50" cy="90" rx="30" ry="3" fill="#3a3a3a" opacity="0.25"/>
<rect id="back-leg" x="60" y="62" width="6" height="26" rx="3" fill="#c98f2a" stroke="#4a2f10" stroke-width="1.4"/>
<rect id="back-leg-2" x="52" y="62" width="6" height="26" rx="3" fill="#b07a20" stroke="#4a2f10" stroke-width="1.4"/>
<path id="tail" d="M70 58 C78 56 80 64 77 72" fill="none" stroke="#4a2f10" stroke-width="1.8"/>
<ellipse id="body" cx="50" cy="58" rx="22" ry="12" fill="#e0a83a" stroke="#4a2f10" stroke-width="1.8"/>
<rect id="front-leg" x="36" y="62" width="6" height="26" rx="3" fill="#c98f2a" stroke="#4a2f10" stroke-width="1.4"/>
<rect id="front-leg-2" x="44" y="62" width="6" height="26" rx="3" fill="#e0a83a" stroke="#4a2f10" stroke-width="1.4"/>
<path id="neck" d="M34 56 C32 40 32 28 36 18 L44 20 C42 30 42 44 44 54 Z" fill="#e0a83a" stroke="#4a2f10" stroke-width="1.8"/>
<ellipse id="head" cx="36" cy="14" rx="9" ry="6" fill="#e8b84c" stroke="#4a2f10" stroke-width="1.8"/>
<circle id="spot-1" cx="46" cy="55" r="3" fill="#a8741c"/>
<circle id="spot-2" cx="56" cy="60" r="3.4" fill="#a8741c"/>
<circle id="spot-3" cx="40" cy="36" r="2" fill="#a8741c"/>
<rect id="horn" x="34" y="4" width="2" height="5" rx="1" fill="#4a2f10"/>
<circle id="eye" cx="33" cy="13" r="1.4" fill="#2a1a08"/>
</svg>`;
