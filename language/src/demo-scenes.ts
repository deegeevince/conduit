// A demo (or any script) played the way the server and the painter play it, and its schedule cut into scenes: the base of the checks that judge a
// demo from its schedule alone (`pnpm timeline`: language/scripts/reading-checks.ts, web/src/painter/demo-checks.ts) and of the page check that asks what
// each scene declared (server/src/tools/check.ts).
import { LineNormalizer, LineReader } from './normalize';
import { EMPTY_STAGE } from './schedule';
import type { ElementSpan, SceneSpan, Schedule } from './schedule';
import { TurnScore } from './score';
import { serializeLine } from './serialize';
import type { Line } from './types';

export interface Played {
  readonly schedule: Schedule;
  /** each accepted line by its sequence number, in the one written form */
  readonly text: ReadonlyMap<number, string>;
  readonly line: ReadonlyMap<number, Line>;
}

/** A script played from an empty stage. Lines the language rejects are skipped (`pnpm timeline` reports those on its own). */
export function playSource(source: string): Played {
  const score = new TurnScore(EMPTY_STAGE);
  const reader = new LineReader();
  let seq = 0;
  let auto = 0;
  const normalizer = new LineNormalizer(() => `x${(auto += 1)}`);
  for (const raw of source.split('\n')) {
    const read = reader.read(raw);
    if (read.kind !== 'line') continue;
    const normalized = normalizer.normalize(read.line);
    if (normalized.line === null) continue;
    seq += 1;
    score.push(normalized.line, seq, 0);
  }
  const text = new Map<number, string>();
  const line = new Map<number, Line>();
  for (const entry of score.score) {
    if (entry.void) continue;
    text.set(entry.seq, serializeLine(entry.line));
    line.set(entry.seq, entry.line);
  }
  return { schedule: score.schedule, text, line };
}

/** One scene of a script and the elements it made: the scene line that opens it is `scene.seq`, and the next scene's `seq` ends it. */
export interface SceneCut {
  /** 1-based, as `demo-diagrams#2` names it */
  readonly number: number;
  readonly scene: SceneSpan;
  readonly next: SceneSpan | null;
  /** when the next scene starts clearing this one; for the last scene, when everything is done */
  readonly leaves: number;
  /** the elements this scene made (not carried in), in order */
  readonly elements: readonly ElementSpan[];
  /** the sequence numbers of its lines, after the scene line and before the next scene's */
  readonly seqs: readonly number[];
}

export function cutScenes(played: Played): SceneCut[] {
  const { schedule } = played;
  const scenes = schedule.scenes.filter((scene) => scene.seq > 0);
  return scenes.map((scene, at) => {
    const next = scenes[at + 1] ?? null;
    const inside = (seq: number): boolean => seq > scene.seq && (next === null || seq < next.seq);
    return {
      number: at + 1,
      scene,
      next,
      leaves: next === null ? schedule.end : next.start,
      elements: schedule.elements.filter((element) => !element.carried && inside(element.seq)),
      seqs: [...played.line.keys()].filter(inside).sort((a, b) => a - b),
    };
  });
}

/** What a scene declares that must be on screen when it has come to rest. `id` is null for an element the language named itself (`x12`): it is found by its words. */
export interface Declared {
  readonly id: string | null;
  readonly kind: string;
  readonly text: string;
  /** the least opacity it may be seen at: its own, less a tenth */
  readonly opacity: number;
}

/** Explicit ids stay the same however many lines came before; the language's own (`x12`) depend on the count. */
const AUTO_ID = /^x\d+$/;

/**
 * The elements a scene's lines put on stage that are still there when the next scene begins to clear it: words, shapes, blocks and controls (not ambient fields, groups, the parts of a
 * block or words that have shorter forms). A page that does not show one of these at the scene's rest frame has lost something the script said.
 */
export function declaredAtRest(cut: SceneCut): Declared[] {
  const out: Declared[] = [];
  // the sketch a painting is made over fades as the painting grows: what it was drawn from is not on stage at rest by design
  const sketches = new Set(cut.elements.flatMap((element) => (element.figure?.kind === 'picture' && element.figure.over !== null && element.figure.sketch === 'fade' ? [element.figure.over] : [])));
  for (const element of cut.elements) {
    if (sketches.has(element.key) || (element.parent !== null && sketches.has(element.parent))) continue;
    if (!['text', 'shape', 'structure', 'control'].includes(element.kind)) continue;
    if (element.struck || element.optional === true || (element.alts?.length ?? 0) > 0) continue;
    // words that carry a live value (`{name}`) are what the control says they are, not what they were written as
    if (element.kind === 'text' && element.text.includes('{')) continue;
    if (element.exit !== null && cut.next !== null && element.exit.start < cut.leaves) continue;
    if (element.exit !== null && cut.next === null && element.exit.start < cut.leaves) continue;
    const last = [...element.changes].reverse().find((change) => 'style' in change);
    const style = last !== undefined && 'style' in last ? last.style : element.style;
    if (style.opacity <= 0.05) continue;
    out.push({ id: AUTO_ID.test(element.id) ? null : element.id, kind: element.kind, text: element.kind === 'text' ? element.text : '', opacity: Math.min(0.9, style.opacity * 0.9) });
  }
  return out;
}
