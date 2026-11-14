// What the lesson shows, worked out from the document and what she did. Pure: (document, state) in, structure out. Also the one
// reducer the lesson runs on (STUB of WS3's `advance`, narrowed to a lesson's changes), so a change is always `advance(...)`.

import { matches } from './answer';
import { WORKED } from './types';
import { parseShow } from './show';
import type { Ask, DocNode, DocState, Document, Held, LessonChange, NodeId, Progress, Status, Technique, ViewStep, VisualSpec } from './types';
import { isTechnique } from './types';

// ---------------------------------------------------------------- the tree, read as a worksheet

export interface Way {
  readonly node: DocNode;
  readonly technique: Technique | null;
  readonly steps: readonly ViewStep[];
  /** she can open it: it has at least its first step */
  readonly ready: boolean;
}
export interface Question {
  readonly node: DocNode;
  readonly number: number;
  readonly ways: readonly Way[];
}
export interface Section {
  readonly node: DocNode | null;
  readonly questions: readonly Question[];
}
export interface Sheet {
  readonly title: string;
  readonly sections: readonly Section[];
  readonly questions: readonly Question[];
}

/** A way is what carries a technique, or a body of steps; a question is anything else with no children or with ways below it. */
function isWay(node: DocNode): boolean {
  return node.body?.kind === 'lesson' || node.tag !== null;
}

/** A way's steps as the lesson reads them: each picture parsed, and every ask of a refused way marked so. */
export function stepsOf(node: DocNode): readonly ViewStep[] {
  if (node.body?.kind !== 'lesson') return [];
  const refused = node.status === 'refused';
  return node.body.steps.map((step): ViewStep => (step.kind === 'step' ? { kind: 'step', id: step.id, words: step.words, show: parseShow(step.show) } : { ...step, refused }));
}

export function sheetOf(doc: Document): Sheet {
  const node = (id: NodeId): DocNode | null => doc.nodes[id] ?? null;
  const waysOf = (question: DocNode): Way[] =>
    question.children.flatMap((id) => {
      const child = node(id);
      if (child === null) return [];
      const steps = stepsOf(child);
      return [{ node: child, technique: isTechnique(child.tag) ? child.tag : null, steps, ready: steps.length > 0 && child.status !== 'outlined' }];
    });
  const sections: Section[] = [];
  let counter = 0;
  const questionsIn = (parent: DocNode): Question[] =>
    parent.children.flatMap((id) => {
      const child = node(id);
      if (child === null || isWay(child)) return [];
      counter += 1;
      return [{ node: child, number: counter, ways: waysOf(child) }];
    });
  const root = node(doc.root);
  if (root === null) return { title: doc.title, sections: [], questions: [] };
  const loose: DocNode[] = [];
  for (const id of root.children) {
    const child = node(id);
    if (child === null) continue;
    const grand = child.children.map(node).filter((n): n is DocNode => n !== null);
    const isSection = grand.length > 0 && grand.some((g) => !isWay(g));
    if (isSection) sections.push({ node: child, questions: questionsIn(child) });
    else loose.push(child);
  }
  if (loose.length > 0) {
    const looseSection: Section = { node: null, questions: loose.flatMap((child) => (isWay(child) ? [] : [{ node: child, number: ++counter, ways: waysOf(child) }])) };
    sections.unshift(looseSection);
  }
  const questions = sections.flatMap((s) => s.questions);
  return { title: root.title.length > 0 ? root.title : doc.title, sections: sections.filter((s) => s.questions.length > 0), questions };
}

export function questionOf(sheet: Sheet, node: NodeId): Question | null {
  return sheet.questions.find((q) => q.node.id === node || q.ways.some((w) => w.node.id === node)) ?? null;
}

export type Where = { readonly view: 'outline' } | { readonly view: 'question'; readonly question: Question } | { readonly view: 'play'; readonly question: Question; readonly way: Way };

/** Where the cursor says she is: on a way, on a question, or on the sheet. */
export function whereOf(sheet: Sheet, state: DocState): Where {
  const q = questionOf(sheet, state.cursor.node);
  if (q === null) return { view: 'outline' };
  const way = q.ways.find((w) => w.node.id === state.cursor.node);
  return way === undefined ? { view: 'question', question: q } : { view: 'play', question: q, way };
}

// ---------------------------------------------------------------- what she has done

const NO_PROGRESS: Progress = { seen: 0, tries: {}, done: false };
export function progressOf(state: DocState, node: NodeId): Progress {
  return state.progress[node] ?? NO_PROGRESS;
}
export function stopOf(state: DocState): number {
  const play = state.cursor.play;
  return typeof play === 'number' ? 0 : play.at;
}

/** She has got this ask past: a right answer, or the worked-through step. */
export function passed(ask: Ask, tries: readonly string[]): boolean {
  return tries.some((text) => text === WORKED || (!ask.refused && matches(text, ask.accepted, ask.unit)));
}
export function rightOf(ask: Ask, tries: readonly string[]): string | null {
  return tries.find((text) => text !== WORKED && matches(text, ask.accepted, ask.unit)) ?? null;
}
export function wrongTries(ask: Ask, tries: readonly string[]): number {
  return tries.filter((text) => text !== WORKED && !matches(text, ask.accepted, ask.unit)).length;
}

/** The first ask at or before the stop that she has not got past: the gate. */
export function gateOf(way: Way, state: DocState, at: number): Ask | null {
  const tries = progressOf(state, way.node.id).tries;
  for (const step of way.steps.slice(0, at)) if (step.kind === 'ask' && !passed(step, tries[step.id] ?? [])) return step;
  return null;
}

/** Every ask of the way she has not got past, shown or not: their answers are sealed (2.6), and nothing past the gate is drawn. */
export function sealedAsks(way: Way, state: DocState): readonly Ask[] {
  const tries = progressOf(state, way.node.id).tries;
  return way.steps.filter((s): s is Ask => s.kind === 'ask' && !passed(s, tries[s.id] ?? []));
}

/** How far she may be shown: up to and including a gate, and no further. */
export function reach(way: Way, state: DocState, at: number): number {
  const gate = gateOf(way, state, at);
  if (gate === null) return Math.min(at, way.steps.length);
  return way.steps.indexOf(gate) + 1;
}

export function statusOf(way: Way): Status {
  return way.node.status;
}

/** A way is finished when she has been shown all of it, every ask got past. */
export function wayFinished(way: Way, state: DocState): boolean {
  if (way.steps.length === 0 || way.node.status === 'filling' || way.node.status === 'outlined') return false;
  const p = progressOf(state, way.node.id);
  return p.seen >= way.steps.length && sealedAsks(way, state).length === 0;
}

export function questionDone(q: Question, state: DocState): boolean {
  return progressOf(state, q.node.id).done || q.ways.some((w) => wayFinished(w, state));
}

// ---------------------------------------------------------------- figures: a visual that carries across steps

export interface Figure {
  readonly key: string;
  readonly spec: VisualSpec;
  /** the step that first showed it */
  readonly from: number;
}
export interface Run {
  /** the steps of this run, each with its index in the way */
  readonly steps: readonly { readonly step: ViewStep; readonly index: number }[];
  readonly figure: Figure | null;
}

/**
 * The page she is shown, in runs. A visual that is the same kind as the one before it is the same picture, grown: it is not drawn again but
 * carried, so nothing she was shown is taken away and a hop she made is still made. A run is the steps that share a picture.
 */
export function runsOf(way: Way, shown: number): readonly Run[] {
  const runs: { steps: { step: ViewStep; index: number }[]; figure: Figure | null }[] = [];
  let current: { steps: { step: ViewStep; index: number }[]; figure: Figure | null } = { steps: [], figure: null };
  runs.push(current);
  way.steps.slice(0, shown).forEach((step, index) => {
    const show: VisualSpec | null = step.kind === 'step' ? step.show : null;
    if (show !== null) {
      const carrying = current.figure !== null && current.figure.spec.kind === show.kind;
      if (carrying && current.figure !== null) current.figure = { key: current.figure.key, spec: show, from: current.figure.from };
      else if (current.steps.length === 0 && current.figure === null) current.figure = { key: `f${index}`, spec: show, from: index };
      else {
        current = { steps: [], figure: { key: `f${index}`, spec: show, from: index } };
        runs.push(current);
      }
    }
    current.steps.push({ step, index });
  });
  return runs;
}

// ---------------------------------------------------------------- the reducer

function withProgress(state: DocState, node: NodeId, change: (p: Progress) => Progress): DocState {
  return { ...state, progress: { ...state.progress, [node]: change(progressOf(state, node)) } };
}

/** The only writer of a lesson's state (STUB of WS3's `advance`). */
export function advance(doc: Document, state: DocState, change: LessonChange): DocState {
  if (change.kind === 'goto') {
    const next: DocState = { ...state, cursor: { node: change.node, play: { at: change.at } } };
    return settle(doc, withProgress(next, change.node, (p) => ({ ...p, seen: Math.max(p.seen, change.at) })), change.node);
  }
  if (change.kind === 'try') {
    const next = withProgress(state, change.node, (p) => ({ ...p, tries: { ...p.tries, [change.ask]: [...(p.tries[change.ask] ?? []), change.text] } }));
    return settle(doc, next, change.node);
  }
  const held: Readonly<Record<string, Held>> = { ...(state.held[change.node] ?? {}), [change.key]: change.value };
  return { ...state, held: { ...state.held, [change.node]: held } };
}

/** When the last stop of a way has been seen and every ask is got past, the way is done and so is its question. */
function settle(doc: Document, state: DocState, node: NodeId): DocState {
  const sheet = sheetOf(doc);
  const q = questionOf(sheet, node);
  const way = q?.ways.find((w) => w.node.id === node);
  if (q === null || way === undefined) return state;
  if (!wayFinished(way, state)) return state;
  const done = withProgress(state, node, (p) => ({ ...p, done: true }));
  return withProgress(done, q.node.id, (p) => ({ ...p, done: true }));
}

/** The start: on the sheet, nothing seen. */
export function freshState(doc: Document): DocState {
  return { cursor: { node: doc.root, play: { at: 0 } }, held: {}, progress: {} };
}
