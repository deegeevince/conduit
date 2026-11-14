// Ahead and verify (PLAN-v3-core WS5): the parts of a document that are named and not yet written are written in the background, a few at a time,
// off the person's turn clock, and each one is checked before it is offered.
//
// This is general: a part is anything that is outlined (a worksheet's question, an explainer's chapter, a panel of a board), and what checks it
// is chosen by what was written (`domain/verify.ts`: `CHECKERS`). The worksheet is the first case. Nothing here names or describes a person.
//
// The life of a part, in the document's own statuses (`DocNode.status`, set only through `setNodeStatus`, so every change is a `node` record):
//
//   outlined ──fill──▶ filling ──turn ends──▶ filled ──verify──▶ verified
//                         │ no turn is open on it                    └──▶ refused ──(once)──▶ outlined (reset, written again with why)
//                         └─ stale: reset to outlined, and filled again           └─ the second time: refused, and marked for the parent
//
// What it does not do: it does not touch a part while a turn of the person's is open (the turn is writing the document), it does not start a
// fill once the hour's spending has reached `AHEAD_NEAR_CAP` of the cap (fill ahead stands down first; what she reaches is still written on
// her own turn), and it does not offer a part the verifier has not passed (nothing here sets `verified` but the verdict).

import type { Crop, DocNode, Document, DocumentView, NodeId, NodeStatus } from '@conduit/language';
import { nodeOf } from '@conduit/language';
import type { Logger } from '../log';
import { roomAhead } from '../usage';
import type { Throttle } from '../usage';
import type { LessonCheckResult } from '../judge/lesson';
import { asksOf, isWay, kindOfPart, lessonText, mechanicalCheck, profileOf, settle, solverOpinion, stepsOf, waysOf } from './verify';
import type { Finding, ModelVerdict, Verdict } from './verify';

// ---------------------------------------------------------------------------------------------------------------------------------
// policy and ports

export interface AheadPolicy {
  /** `AHEAD`: on by default with the claude-cli brain, off with the others (a replay or a relay has nothing to write ahead with) */
  readonly enabled: boolean;
  /** `AHEAD_PARALLEL`: parts written at once, most */
  readonly parallel: number;
  /** `AHEAD_VERIFY_MODEL`, `AHEAD_VERIFY_EFFORT`: the second check */
  readonly verifyModel: string;
  readonly verifyEffort: 'low' | 'medium' | 'high';
  /** `AHEAD_BATCH`: parts checked by one call of the second check, most */
  readonly batch: number;
  /** a part is written at most this many times (the second is after a refusal or a stale fill) before it is marked for the parent */
  readonly fillsPerPart: number;
  /** `AHEAD_LIMIT`: parts a conversation may have written ahead; a document that is longer is written as it is reached */
  readonly limit: number;
  readonly verifyTimeoutMs: number;
}

export const AHEAD_POLICY: AheadPolicy = { enabled: true, parallel: 3, verifyModel: 'sonnet', verifyEffort: 'low', batch: 3, fillsPerPart: 2, limit: 60, verifyTimeoutMs: 120_000 };

/** One part to write: the words of the request, built by `fillPrompt`. */
export interface FillJob {
  readonly node: NodeId;
  /** the brain's own id for it (`q3`) */
  readonly short: string;
  readonly title: string;
  /** which write this is: 1, or 2 after a refusal or a stale fill */
  readonly attempt: number;
  /** why the last try was refused or never finished, for the brain to mend */
  readonly note: string | null;
  /** how the part before it was written, so that a document stays one shape */
  readonly shape: string | null;
  /** the part's box on the photo (`crop=x,y,w,h`), when the outline gave one */
  readonly crop: Crop | null;
  /** the photo is shown to this write: the first try is from the words alone, and a try that was refused is written from the page itself */
  readonly photo: boolean;
}

export interface FillOutcome {
  readonly ok: boolean;
  readonly turn: string;
  /** lines the document took */
  readonly lines: number;
  /** lines the reader refused, after the one rewrite the turn is allowed */
  readonly refused: number;
  readonly costUsd: number | null;
  readonly ms: number;
  readonly reason: string | null;
}

/** What `Ahead` needs of the server: the conductor implements it. */
export interface AheadHost {
  now(): number;
  /** the session's document and the person's place in it; null when it has none */
  view(session: string): DocumentView | null;
  /** a turn of the person's is open on the session: the document is being written by it */
  userTurnOpen(session: string): boolean;
  /** a quiet turn of the brain, aimed at one part: its lines go to the document, none to the stage. Never throws. */
  fill(session: string, job: FillJob, signal: AbortSignal): Promise<FillOutcome>;
  setStatus(session: string, node: NodeId, status: NodeStatus, options: { readonly why: string; readonly reset?: boolean }): boolean;
  /** the second check, asked cold */
  check(session: string, pages: readonly { readonly id: string; readonly text: string }[], signal: AbortSignal): Promise<LessonCheckResult>;
  readonly throttle: Throttle;
  readonly log: Logger;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// what the document has waiting

const shortOf = (id: NodeId): string => id.slice(id.lastIndexOf('/') + 1);

/**
 * The parts that are written one at a time, in the document's order: not the root, not a painted scene, not a way (a way carries a
 * technique), and none whose children are anything but ways. A worksheet's question is one; so is a chapter.
 */
export function unitsOf(doc: Document): readonly DocNode[] {
  const out: DocNode[] = [];
  const visit = (id: NodeId, depth: number): void => {
    const node = nodeOf(doc, id);
    if (node === null || depth > 32 || id.startsWith('#')) return;
    const kids = node.children.map((child) => nodeOf(doc, child)).filter((child): child is DocNode => child !== null);
    if (node.parent !== null && node.tag === null && kids.every((child) => child.tag !== null)) {
      out.push(node);
      return;
    }
    for (const child of node.children) visit(child, depth + 1);
  };
  visit(doc.root, 0);
  return out;
}

/** Whether nothing is written in a part: it has no body of its own and none of its ways has one. */
export function isBlank(doc: Document, node: DocNode): boolean {
  return node.body === null && waysOf(doc, node).every((way) => way.body === null);
}

/** The units in the order they are wanted: from the one she is at, forward through the document (the first section first), then the ones behind her. */
export function wanted(doc: Document, cursor: NodeId): readonly DocNode[] {
  const units = unitsOf(doc);
  const order: NodeId[] = [];
  const walk = (id: NodeId, depth: number): void => {
    const node = nodeOf(doc, id);
    if (node === null || depth > 32) return;
    order.push(id);
    for (const child of node.children) walk(child, depth + 1);
  };
  walk(doc.root, 0);
  const at = Math.max(0, order.indexOf(cursor));
  const rank = (node: DocNode): number => {
    const index = order.indexOf(node.id);
    return index >= at ? index - at : order.length + index;
  };
  return [...units].sort((a, b) => rank(a) - rank(b));
}

/** How the part before `node` was written, in a line, so that the next one is written the same way. Null when none is written yet. */
export function shapeBefore(doc: Document, node: DocNode): string | null {
  const units = unitsOf(doc);
  const at = units.findIndex((unit) => unit.id === node.id);
  for (let i = at - 1; i >= 0; i -= 1) {
    const before = units[i];
    if (before === undefined || isBlank(doc, before)) continue;
    const profile = profileOf(doc, before);
    if (profile === 'ways') {
      const ways = waysOf(doc, before).filter(isWay);
      const steps = ways.map((way) => stepsOf(way).length);
      const asks = ways.reduce((sum, way) => sum + asksOf(way).length, 0);
      return `The part before it, ${shortOf(before.id)}, was written as ${ways.length} ways (${ways.map((way) => way.tag ?? 'untagged').join(', ')}), of ${Math.min(...steps)} to ${Math.max(...steps)} steps each and ${asks} asks in all: write this one the same way.`;
    }
    if (profile === 'both') {
      const ways = waysOf(doc, before).filter(isWay);
      return `The part before it, ${shortOf(before.id)}, was written as her own try first (an ask on the question itself) and then ${ways.length} ways (${ways.map((way) => way.tag ?? 'untagged').join(', ')}): write this one the same way.`;
    }
    if (profile === 'steps') {
      const steps = stepsOf(before);
      return `The part before it, ${shortOf(before.id)}, was written as ${steps.length} steps with ${asksOf(before).length} asks, directly in the part (no ways): write this one the same way.`;
    }
  }
  return null;
}

/** The words the brain is given for one part. It is the TEACH chapter's own rules that say how; this says which part, and what was learned from the last try. */
export function fillPrompt(job: FillJob): string {
  return [
    `AHEAD: write part ${job.short} now, "${job.title}", and nothing else. She is not waiting for it: write it complete, once, in the lines the chapter gives, every line with its own in=. A question is written FIRST as her own try: an \`ask\` straight on the question (\`ask … in=${job.short}\`, no steps before it, no \`pick=\`, she writes the answer; two or three hints; \`check=working\` when it is a sum she works out in steps), THEN three to five ways (never fewer than three), each a part in=${job.short} with its own tag, small steps, and an ask whose answer is the question's own answer, reached last (the ways are the help she asks for); a part of a different kind (a chapter) gets its steps in=${job.short}. Write no outline, no \`reply\`, and no line for any other part.`,
    job.shape ?? '',
    job.photo ? `The page itself is attached: this question is the part of it at ${job.crop === null ? 'its place in the outline' : `x ${job.crop.x}%, y ${job.crop.y}%, ${job.crop.w}% wide, ${job.crop.h}% high`}. Read the question from there, with whatever the words above leave out (a picture, a table, a pattern, a clock), and write only what can be worked from what is on it.` : '',
    job.note === null ? '' : `The first try of this part was refused by the checker: ${job.note} Write it again so that none of that is true.`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

// ---------------------------------------------------------------------------------------------------------------------------------
// the service

export interface AheadStatus {
  readonly waiting: number;
  readonly filling: number;
  readonly filled: number;
  readonly verifying: number;
  readonly verified: number;
  readonly refused: number;
  /** the parts a person must look at: refused twice, or never written */
  readonly forParent: readonly { readonly node: NodeId; readonly why: string }[];
  readonly standingDown: boolean;
  readonly fills: number;
  readonly checks: number;
  readonly fillCostUsd: number;
  readonly verifyCostUsd: number;
}

interface Tries {
  fills: number;
  refusals: number;
  checkFailures: number;
  /** what to tell the brain at the next write */
  note: string | null;
  /** when this part first showed as filled and unchecked, for the batch's patience */
  filledAt: number | null;
}

interface Run {
  readonly session: string;
  readonly abort: AbortController;
  readonly filling: Map<NodeId, number>;
  readonly verifying: Set<NodeId>;
  readonly tries: Map<NodeId, Tries>;
  readonly forParent: Map<NodeId, string>;
  readonly settledWaiters: (() => void)[];
  timer: NodeJS.Timeout | null;
  ticking: boolean;
  again: boolean;
  started: number;
  fills: number;
  checks: number;
  fillCostUsd: number;
  verifyCostUsd: number;
  /** the hour's spending stopped a fill from starting */
  standingDown: boolean;
}

/** How long a filled part waits for others to be checked in the same call, when more are being written. */
const BATCH_PATIENCE_MS = 4_000;
/** How long before a part that could not be checked is tried again. */
const CHECK_RETRY_MS = 15_000;
/** How long before a part that is waiting for the spending to ease is looked at again. */
const STAND_DOWN_RETRY_MS = 30_000;

export interface Ahead {
  /** The document, the person's place or a turn changed: look again, soon. */
  wake(session: string): void;
  /** The session is gone: whatever is being written for it stops. */
  release(session: string): void;
  status(session: string): AheadStatus | null;
  /** Resolves when nothing is waiting, being written or waiting to be checked (or the session is gone). For the tools that measure it. */
  settled(session: string): Promise<AheadStatus | null>;
  close(): void;
}

export const NO_AHEAD: Ahead = { wake: () => undefined, release: () => undefined, status: () => null, settled: async () => null, close: () => undefined };

export function createAhead(host: AheadHost, policy: AheadPolicy): Ahead {
  const runs = new Map<string, Run>();
  const log = host.log;

  const runOf = (session: string): Run => {
    let run = runs.get(session);
    if (run === undefined) {
      run = { session, abort: new AbortController(), filling: new Map(), verifying: new Set(), tries: new Map(), forParent: new Map(), settledWaiters: [], timer: null, ticking: false, again: false, started: 0, fills: 0, checks: 0, fillCostUsd: 0, verifyCostUsd: 0, standingDown: false };
      runs.set(session, run);
    }
    return run;
  };
  const triesOf = (run: Run, node: NodeId): Tries => {
    let tries = run.tries.get(node);
    if (tries === undefined) {
      tries = { fills: 0, refusals: 0, checkFailures: 0, note: null, filledAt: null };
      run.tries.set(node, tries);
    }
    return tries;
  };
  const later = (run: Run, ms: number): void => {
    if (run.timer !== null || run.abort.signal.aborted) return;
    run.timer = setTimeout(() => {
      run.timer = null;
      schedule(run);
    }, ms);
    run.timer.unref();
  };
  const schedule = (run: Run): void => {
    if (run.abort.signal.aborted) return;
    // a turn that ends and a state that moves arrive together: look once
    setTimeout(() => step(run), 20).unref();
  };

  const reset = (run: Run, doc: Document, unit: DocNode, why: string): void => {
    for (const way of waysOf(doc, unit)) host.setStatus(run.session, way.id, 'outlined', { reset: true, why });
    host.setStatus(run.session, unit.id, 'outlined', { reset: true, why });
  };

  const forParent = (run: Run, unit: DocNode, why: string): void => {
    const text = `for the parent: ${why}`;
    run.forParent.set(unit.id, text);
    host.setStatus(run.session, unit.id, 'refused', { why: text });
    log.warn('ahead.for_parent', { session: run.session, node: unit.id, why });
  };

  const statusOf = (run: Run): AheadStatus | null => {
    const view = host.view(run.session);
    if (view === null) return null;
    const units = unitsOf(view.document);
    const count = (status: NodeStatus): number => units.filter((unit) => unit.status === status).length;
    return {
      waiting: units.filter((unit) => unit.status === 'outlined' && isBlank(view.document, unit) && !run.forParent.has(unit.id)).length,
      filling: units.filter((unit) => unit.status === 'filling').length,
      filled: count('filled'),
      verifying: run.verifying.size,
      verified: count('verified'),
      refused: count('refused'),
      forParent: [...run.forParent].map(([node, why]) => ({ node, why })),
      standingDown: run.standingDown,
      fills: run.fills,
      checks: run.checks,
      fillCostUsd: run.fillCostUsd,
      verifyCostUsd: run.verifyCostUsd,
    };
  };

  // ------------------------------------------------------------- one look at the document

  const step = (run: Run): void => {
    if (run.abort.signal.aborted) return;
    if (run.ticking) {
      run.again = true;
      return;
    }
    run.ticking = true;
    try {
      do {
        run.again = false;
        look(run);
      } while (run.again);
    } catch (error) {
      log.error('ahead.step_failed', { session: run.session, error });
    } finally {
      run.ticking = false;
    }
  };

  const look = (run: Run): void => {
    const view = host.view(run.session);
    if (view === null) return;
    const doc = view.document;
    const now = host.now();
    const open = host.userTurnOpen(run.session);
    const order = wanted(doc, view.state.cursor.node);

    // 1. a part that says it is being written and has no turn writing it
    if (!open) {
      for (const unit of order) {
        if (unit.status !== 'filling' || run.filling.has(unit.id) || run.verifying.has(unit.id)) continue;
        const tries = triesOf(run, unit.id);
        if (tries.fills >= policy.fillsPerPart) {
          forParent(run, unit, 'it was started twice and never finished');
          continue;
        }
        log.info('ahead.stale', { session: run.session, node: unit.id });
        tries.note ??= 'the first try never finished.';
        reset(run, doc, unit, 'stale: filling with no turn open');
        run.again = true;
      }
    }

    // 2. what is written and not yet checked
    const over = host.throttle.state(now) === 'over';
    const filled = order.filter((unit) => unit.status === 'filled' && !run.verifying.has(unit.id) && (kindOfPart(doc, unit) !== null || !isBlank(doc, unit)));
    for (const unit of filled) triesOf(run, unit.id).filledAt ??= now;
    if (filled.length > 0 && !over && run.verifying.size < 2) {
      const first = filled[0];
      const writing = run.filling.size > 0;
      const oldest = Math.min(...filled.map((unit) => triesOf(run, unit.id).filledAt ?? now));
      const ready = filled.length >= policy.batch || !writing || now - oldest >= BATCH_PATIENCE_MS || (first !== undefined && first.id === order[0]?.id);
      const retry = filled.filter((unit) => triesOf(run, unit.id).checkFailures < 3);
      if (!ready) later(run, BATCH_PATIENCE_MS);
      else if (retry.length > 0) void verifyBatch(run, retry.slice(0, policy.batch));
    } else if (filled.length > 0 && over) {
      later(run, STAND_DOWN_RETRY_MS);
    }

    // 3. what is only named
    if (!open) {
      const waiting = order.filter((unit) => unit.status === 'outlined' && isBlank(doc, unit) && !run.filling.has(unit.id) && !run.forParent.has(unit.id));
      const room = roomAhead(host.throttle, now);
      run.standingDown = !room && waiting.length > 0;
      if (run.standingDown) later(run, STAND_DOWN_RETRY_MS);
      for (const unit of waiting) {
        if (!room || run.filling.size >= policy.parallel || run.started >= policy.limit) break;
        const tries = triesOf(run, unit.id);
        if (tries.fills >= policy.fillsPerPart) {
          forParent(run, unit, tries.note ?? 'nothing could be written for it');
          continue;
        }
        void fillOne(run, unit, tries);
      }
    }

    // 4. is there anything left to do
    const after = statusOf(run);
    const pendingChecks = after !== null && (after.filled > 0 || after.verifying > 0);
    const pendingFills = after !== null && (after.filling > 0 || run.filling.size > 0 || (after.waiting > 0 && run.started < policy.limit && !open));
    if (after !== null && !pendingChecks && !pendingFills && !run.standingDown) {
      for (const done of run.settledWaiters.splice(0)) done();
    }
  };

  // ------------------------------------------------------------- writing a part

  const fillOne = async (run: Run, unit: DocNode, tries: Tries): Promise<void> => {
    tries.fills += 1;
    run.started += 1;
    run.fills += 1;
    run.filling.set(unit.id, host.now());
    const view = host.view(run.session);
    const job: FillJob = {
      node: unit.id,
      short: shortOf(unit.id),
      title: unit.title,
      attempt: tries.fills,
      note: tries.note,
      shape: view === null ? null : shapeBefore(view.document, unit),
      crop: unit.crop ?? null,
      photo: tries.fills > 1,
    };
    log.info('ahead.fill', { session: run.session, node: unit.id, attempt: tries.fills });
    try {
      const outcome = await host.fill(run.session, job, run.abort.signal);
      run.fillCostUsd += outcome.costUsd ?? 0;
      log.info('ahead.filled', { session: run.session, node: unit.id, ok: outcome.ok, lines: outcome.lines, refused: outcome.refused, ms: outcome.ms, costUsd: outcome.costUsd, reason: outcome.reason });
    } catch (error) {
      log.warn('ahead.fill_failed', { session: run.session, node: unit.id, error });
    } finally {
      run.filling.delete(unit.id);
      schedule(run);
    }
  };

  // ------------------------------------------------------------- checking parts

  const verifyBatch = async (run: Run, units: readonly DocNode[]): Promise<void> => {
    for (const unit of units) run.verifying.add(unit.id);
    const view = host.view(run.session);
    try {
      if (view === null) return;
      const doc = view.document;
      const checks = units.map((unit) => ({ unit, mechanical: mechanicalCheck(doc, unit.id) }));
      // the free checks first: a part they refuse is not worth the model's time
      const needModel = checks.filter((item) => item.mechanical.kind === 'lesson' && !item.mechanical.findings.some((finding) => finding.severity === 'refuse'));
      let answered: ReadonlyMap<string, ModelVerdict> = new Map();
      let failure: string | null = null;
      if (needModel.length > 0) {
        run.checks += 1;
        const result = await host.check(run.session, needModel.map((item) => ({ id: shortOf(item.unit.id), text: lessonText(doc, item.unit.id) })), run.abort.signal);
        run.verifyCostUsd += result.usage.costUsd ?? 0;
        answered = result.verdicts;
        failure = result.failure;
        log.info('ahead.checked', { session: run.session, nodes: needModel.map((item) => item.unit.id), ms: result.usage.ms, costUsd: result.usage.costUsd, failure });
      }
      for (const { unit, mechanical } of checks) {
        const needs = needModel.some((item) => item.unit.id === unit.id);
        const model = needs ? (answered.get(shortOf(unit.id)) ?? null) : null;
        if (needs && model === null) {
          // the second check did not answer for this part: it stays written and unchecked, and is tried again, a few times
          const tries = triesOf(run, unit.id);
          tries.checkFailures += 1;
          log.warn('ahead.check_unanswered', { session: run.session, node: unit.id, failure, failures: tries.checkFailures });
          if (tries.checkFailures < 3) later(run, CHECK_RETRY_MS);
          else forParent(run, unit, `it could not be checked: ${failure ?? 'the check did not answer for it'}`);
          continue;
        }
        applyVerdict(run, doc, unit, settle(mechanical, model, solverOpinion(doc, unit.id)));
      }
    } catch (error) {
      log.error('ahead.verify_failed', { session: run.session, error });
    } finally {
      for (const unit of units) run.verifying.delete(unit.id);
      schedule(run);
    }
  };

  const applyVerdict = (run: Run, doc: Document, unit: DocNode, verdict: Verdict): void => {
    const ways = waysOf(doc, unit);
    for (const note of verdict.overruled) log.info('ahead.overruled', { session: run.session, node: unit.id, note });
    if (verdict.status === 'verified') {
      for (const way of ways) if (way.body !== null) host.setStatus(run.session, way.id, 'verified', { why: verdict.why });
      host.setStatus(run.session, unit.id, 'verified', { why: verdict.why });
      log.info('ahead.verified', { session: run.session, node: unit.id, kind: verdict.kind, why: verdict.why });
      return;
    }
    const tries = triesOf(run, unit.id);
    tries.refusals += 1;
    const reasons = verdict.refused.map((finding: Finding) => `${finding.ask === null ? '' : `ask ${finding.ask}: `}${finding.why}`);
    const why = reasons.slice(0, 4).join('; ');
    for (const way of ways) {
      if (verdict.refused.some((finding) => finding.node === way.id)) host.setStatus(run.session, way.id, 'refused', { why: verdict.why });
    }
    log.warn('ahead.refused', { session: run.session, node: unit.id, kind: verdict.kind, refusals: tries.refusals, why, sources: [...new Set(verdict.refused.map((finding) => finding.source))] });
    if (tries.refusals >= 2 || tries.fills >= policy.fillsPerPart) {
      // the ways that passed are still checked ways: said, so that a page can offer them beside "let's work this one out together"
      for (const way of ways) if (way.body !== null && !verdict.refused.some((finding) => finding.node === way.id)) host.setStatus(run.session, way.id, 'verified', { why: 'this way passed every check; the part has others that did not' });
      forParent(run, unit, why);
      return;
    }
    host.setStatus(run.session, unit.id, 'refused', { why });
    tries.note = reasons.slice(0, 5).join(' ');
    tries.filledAt = null;
    reset(run, doc, unit, `refused: ${why}`.slice(0, 300));
  };

  // ------------------------------------------------------------- the public face

  return {
    wake(session) {
      if (!policy.enabled) return;
      schedule(runOf(session));
    },
    release(session) {
      const run = runs.get(session);
      if (run === undefined) return;
      runs.delete(session);
      run.abort.abort();
      if (run.timer !== null) clearTimeout(run.timer);
      for (const done of run.settledWaiters.splice(0)) done();
    },
    status(session) {
      const run = runs.get(session);
      return run === undefined ? null : statusOf(run);
    },
    settled(session) {
      const run = runs.get(session);
      if (run === undefined) return Promise.resolve(null);
      return new Promise((resolve) => {
        run.settledWaiters.push(() => resolve(statusOf(run)));
        schedule(run);
      });
    },
    close() {
      for (const session of [...runs.keys()]) this.release(session);
    },
  };
}


/** What the brain is told when the reader refused lines of its turn: the lines and why, and what to write. */
export function refusalBrief(refused: readonly { readonly raw: string; readonly why: string }[]): string {
  // a hint refused for want of its ask is only the ask's refusal again
  const lines = refused.filter((item) => !(/^hint\b/.test(item.raw) && /no ask is called that|has no ask to belong to/.test(item.why))).slice(0, 8).map((item) => `- ${item.raw}\n  ${item.why}`);
  return [
    'THE READER REFUSED THESE LINES, so the page does not have them (everything else you wrote is kept):',
    ...lines,
    'Write again only what mends them (an ask that was refused takes its hints with it: write them again after it): the same id replaces a step, so a step that gave the answer away is written again first, then the ask and its hints. Give the ask its sum from what she has seen, never its answer. If nothing needs mending, write `ok`.',
  ].join('\n');
}
