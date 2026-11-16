// What a hand has done to the asks on the stage (HI1): what was tried, which choice is held, how many hints are open, and how it came out.
//
// An ask is a control that wears the document's ask (`language/lesson.ts`): the same matcher decides right or wrong, and the answers it accepts are
// the brain's own `is=`, carried in the control and never drawn. This module is the painter's whole knowledge of it: it compares, and it keeps what the
// person did, by the ask's id and what it says (so an ask the brain writes again, the same, keeps its tries; one it changes starts fresh).
// It is checked on a press, never live: a hand cannot wiggle a field until it turns green.

import { accepts } from '@conduit/language';
import type { ElementSpan, StageAsk } from '@conduit/language';
import { penReady } from './pen';

export type AskVerdict = 'open' | 'wrong' | 'right' | 'shown';

export interface AskRun {
  /** what was tried, in order */
  readonly tries: string[];
  /** the choice held, 1-based; 0 when none */
  chosen: number;
  /** hints opened */
  hints: number;
  verdict: AskVerdict;
  /** the Hint chip is ringed once after a wrong try; it is cleared by a press on it */
  ringed: boolean;
}

const RUNS = new Map<string, AskRun>();
/** an ask's id to the key of the run it is working now */
const LATEST = new Map<string, string>();
let revision = 0;

export const askOf = (span: ElementSpan): StageAsk | null => (span.figure?.kind === 'control' && span.figure.ask !== undefined ? span.figure.ask : null);

const keyOf = (span: ElementSpan, ask: StageAsk): string => `${span.id}|${span.text}|${ask.accepted.join('\u0001')}|${(ask.pick ?? []).join('\u0001')}|${ask.check ?? ''}`;

/** What the person has done to this ask. Made on first sight, and kept for as long as the page lives. */
export function runOf(span: ElementSpan): AskRun {
  const ask = askOf(span);
  const key = ask === null ? span.key : keyOf(span, ask);
  let run = RUNS.get(key);
  if (run === undefined) {
    run = { tries: [], chosen: 0, hints: 0, verdict: 'open', ringed: false };
    RUNS.set(key, run);
  }
  LATEST.set(span.id, key);
  return run;
}

/** An ask is settled when it is right or has been given up: the next one opens. */
const settled = (id: string): boolean => {
  const key = LATEST.get(id);
  const run = key === undefined ? undefined : RUNS.get(key);
  return run === undefined || run.verdict === 'right' || run.verdict === 'shown';
};

/** Whether an ask still waits for the one before it: it is then a numbered empty row. */
export function lockedOf(span: ElementSpan): boolean {
  const ask = askOf(span);
  return ask !== null && ask.after !== null && !settled(ask.after);
}

/** Whether another ask waits for this one. */
export const hasNext = (span: ElementSpan): boolean => askOf(span)?.next !== undefined;

/** What changes how an ask is drawn, as one string: the layout is remembered by it. */
export function askSignature(span: ElementSpan): string {
  const ask = askOf(span);
  if (ask === null) return '';
  const run = runOf(span);
  return `${run.verdict}.${run.tries.length}.${run.chosen}.${run.hints}.${run.ringed ? 1 : 0}.${lockedOf(span) ? 1 : 0}.${hasNext(span) ? 1 : 0}.${ask.hints.length}.${penReady() ? 1 : 0}`;
}

export const askRevision = (): number => revision;

/** What the person's answer is, as a string: the text typed, or the choice held. */
export function answerOf(span: ElementSpan, typed: string): string {
  const run = runOf(span);
  const picks = span.figure?.kind === 'control' ? span.figure.options : [];
  return picks.length > 0 ? (picks[run.chosen - 1] ?? '') : typed.trim();
}

export function accepted(ask: StageAsk, text: string): boolean {
  return accepts({ accepted: ask.accepted, unit: ask.unit, ...(ask.check === null ? {} : { check: ask.check }) }, text);
}

/** What the page says of an act: a short fragment the server coalesces into one line, and whether it is the next turn's input. */
export interface AskAct {
  readonly text: string;
  readonly value: string;
  readonly send: boolean;
}

/** Whether this ask is the last of its scene: nothing waits for it. */
const isLast = (span: ElementSpan): boolean => !hasNext(span);

const quote = (text: string): string => `"${text.length > 40 ? `${text.slice(0, 39)}…` : text}"`;

/** Check: compare what the person holds. Returns what to say, or null when there is nothing to check yet. */
export function check(span: ElementSpan, typed: string): AskAct | null {
  const ask = askOf(span);
  if (ask === null) return null;
  const run = runOf(span);
  if (run.verdict === 'right' || run.verdict === 'shown' || lockedOf(span)) return null;
  const given = ask.check === 'done' ? 'done' : answerOf(span, typed);
  if (given === '') return null;
  if (run.tries.length >= 50) return null;
  run.tries.push(given);
  const right = ask.check === 'done' || accepted(ask, given);
  revision += 1;
  if (right) {
    run.verdict = 'right';
    run.ringed = false;
    const first = ask.hints.length > 0 && run.hints > 0 ? `, after ${run.hints} hint${run.hints === 1 ? '' : 's'}` : '';
    return { text: ask.check === 'done' ? `ticked${first}` : `${quote(given)} (right${first})`, value: given, send: ask.send === 'yes' || (ask.send === 'last' && isLast(span)) };
  }
  run.verdict = 'wrong';
  run.ringed = run.hints < ask.hints.length;
  return { text: `tried ${quote(given)} (no)`, value: given, send: false };
}

/** A press on Hint: the next hint opens. Never the answer: a hint is the brain's own line. */
export function hint(span: ElementSpan): AskAct | null {
  const ask = askOf(span);
  if (ask === null) return null;
  const run = runOf(span);
  if (run.verdict === 'right' || run.verdict === 'shown' || run.hints >= ask.hints.length || lockedOf(span)) return null;
  run.hints += 1;
  run.ringed = false;
  revision += 1;
  return { text: `took hint ${run.hints}`, value: String(run.hints), send: false };
}

/** Show me: the answer is put in, and the ask is given up (never recorded as right). Only after a wrong try or a hint. */
export function show(span: ElementSpan): AskAct | null {
  const ask = askOf(span);
  if (ask === null || ask.check !== null || ask.accepted.length === 0) return null;
  const run = runOf(span);
  if (run.verdict === 'right' || run.verdict === 'shown' || lockedOf(span)) return null;
  if (run.tries.length === 0 && run.hints === 0) return null;
  run.verdict = 'shown';
  run.ringed = false;
  revision += 1;
  return { text: `gave up after ${run.tries.length} ${run.tries.length === 1 ? 'try' : 'tries'} and was shown the answer`, value: 'shown', send: ask.send === 'yes' || (ask.send === 'last' && isLast(span)) };
}

/** A press on a choice: held, not checked. */
export function choose(span: ElementSpan, n: number): void {
  const run = runOf(span);
  if (run.verdict === 'right' || run.verdict === 'shown' || lockedOf(span)) return;
  if (run.chosen === n) return;
  run.chosen = n;
  if (run.verdict === 'wrong') run.verdict = 'open';
  revision += 1;
}

/** What the field shows when the ask was given up: the first answer it accepts. */
export const shownAnswer = (ask: StageAsk): string => ask.accepted[0]?.replaceAll('_', ' ') ?? '';

/** A new question begins: nothing of an earlier answer's asks is kept. */
export function forgetAsks(): void {
  RUNS.clear();
  LATEST.clear();
  revision += 1;
}
