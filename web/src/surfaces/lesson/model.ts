// What the lesson shows, worked out from the document and what she did. Pure: (document, state) in, structure out. The document, the
// cursor, her tries and the gates are WS3's (`advance`, `askView`, `revealed`, `openAsks`): this file only reads them into a worksheet
// (sections, questions, ways), and a way's steps into runs that share a picture.

import { askView, nodeOf, openAskOf, progressOf, stopOf, textHolds } from '@conduit/language';
import type { AskView } from '@conduit/language';
import { visualOf } from './visual';
import type { DocNode } from '@conduit/language';
import type { DocState, Document, LessonAsk, LessonStep, NodeId, OpenAsk, Technique, VisualSpec } from './types';
import { isTechnique } from './types';

// ---------------------------------------------------------------- the tree, read as a worksheet

export interface Way {
  readonly node: DocNode;
  readonly technique: Technique | null;
  readonly steps: readonly LessonStep[];
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

export function stepsOf(node: DocNode): readonly LessonStep[] {
  return node.body?.kind === 'lesson' ? node.body.steps : [];
}

export function sheetOf(doc: Document): Sheet {
  const node = (id: NodeId): DocNode | null => nodeOf(doc, id);
  const waysOf = (question: DocNode): Way[] =>
    question.children.flatMap((id) => {
      const child = node(id);
      if (child === null) return [];
      const steps = stepsOf(child);
      return [{ node: child, technique: isTechnique(child.tag) ? child.tag : null, steps, ready: steps.length > 0 && child.status !== 'outlined' }];
    });
  let counter = 0;
  const questionsIn = (children: readonly DocNode[]): Question[] =>
    children.flatMap((child) => {
      if (isWay(child)) return [];
      counter += 1;
      return [{ node: child, number: counter, ways: waysOf(child) }];
    });
  const root = node(doc.root);
  if (root === null) return { title: doc.title, sections: [], questions: [] };
  const sections: Section[] = [];
  const loose: DocNode[] = [];
  for (const id of root.children) {
    const child = node(id);
    if (child === null) continue;
    const grand = child.children.map(node).filter((n): n is DocNode => n !== null);
    if (grand.some((g) => !isWay(g))) sections.push({ node: child, questions: questionsIn(grand) });
    else loose.push(child);
  }
  if (loose.length > 0) sections.unshift({ node: null, questions: questionsIn(loose) });
  const kept = sections.filter((s) => s.questions.length > 0);
  return { title: root.title.length > 0 ? root.title : doc.title, sections: kept, questions: kept.flatMap((s) => s.questions) };
}

export function questionOf(sheet: Sheet, node: NodeId): Question | null {
  return sheet.questions.find((q) => q.node.id === node || q.ways.some((w) => w.node.id === node)) ?? null;
}
export function wayOf(sheet: Sheet, node: NodeId): { readonly question: Question; readonly way: Way } | null {
  for (const question of sheet.questions) {
    const way = question.ways.find((w) => w.node.id === node);
    if (way !== undefined) return { question, way };
  }
  return null;
}

// ---------------------------------------------------------------- where she is in a way

/** The stop she rests at: steps up to and including it are shown. */
export function atOf(state: DocState): number {
  return stopOf(state.cursor) ?? 0;
}
/** How many steps of the way she has been shown (the cursor rests on its stop). */
export function shownOf(way: Way, state: DocState): number {
  return state.cursor.node === way.node.id ? Math.min(way.steps.length, atOf(state) + 1) : 0;
}

export function viewOf(doc: Document, state: DocState, way: Way, ask: LessonAsk): AskView | null {
  return askView(doc, state, way.node.id, ask.id);
}

/** The ask she must get past before the next step: the last step shown, when it is an ask and is still shut. */
export function gateOf(doc: Document, state: DocState, way: Way): AskView | null {
  const shown = shownOf(way, state);
  const last = way.steps[shown - 1];
  if (last === undefined || last.kind !== 'ask') return null;
  const view = viewOf(doc, state, way, last);
  return view !== null && !view.open ? view : null;
}

/**
 * Every ask of the way that is still shut, shown yet or not: their answers are sealed (2.6). WS3's `openAsks` holds the ones shown; the ones
 * ahead are held back too, so a picture cannot give an answer away before the question is asked.
 */
export function shutAsks(doc: Document, state: DocState, way: Way, question: string): readonly OpenAsk[] {
  return way.steps.flatMap((step) => {
    if (step.kind !== 'ask') return [];
    const view = askView(doc, state, way.node.id, step.id);
    if (view === null || view.open) return [];
    // a number the question itself is made of is no secret (WS3's lint says the same)
    const open = openAskOf(step);
    return [{ ...open, accepted: open.accepted.filter((answer) => !textHolds(question, answer, open.unit)) }];
  });
}

export function wayDone(state: DocState, way: Way): boolean {
  return progressOf(state, way.node.id).done;
}
export function questionDone(q: Question, state: DocState): boolean {
  return q.ways.some((w) => wayDone(state, w));
}

// ---------------------------------------------------------------- figures: a visual that carries across steps

export interface Figure {
  readonly key: string;
  readonly spec: VisualSpec;
  /** the step that first showed it */
  readonly from: number;
}
export interface Run {
  readonly steps: readonly { readonly step: LessonStep; readonly index: number }[];
  readonly figure: Figure | null;
}

/**
 * The page she is shown, in runs. A visual of the same kind as the one before it is the same picture, grown: it is not drawn again but
 * carried, so nothing she was shown is taken away and a hop she made is still made. A run is the steps that share a picture.
 */
export function runsOf(way: Way, shown: number): readonly Run[] {
  type Open = { steps: { step: LessonStep; index: number }[]; figure: Figure | null };
  const runs: Open[] = [];
  let current: Open = { steps: [], figure: null };
  runs.push(current);
  way.steps.slice(0, shown).forEach((step, index) => {
    const show: VisualSpec | null = step.kind === 'step' ? visualOf(step.show) : null;
    if (show !== null) {
      if (current.figure !== null && current.figure.spec.kind === show.kind) current.figure = { key: current.figure.key, spec: show, from: current.figure.from };
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
