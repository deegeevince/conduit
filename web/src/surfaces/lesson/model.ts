// What the view shows, worked out from the document and what she did. Pure: (document, state) in, structure out. The document, the cursor,
// her tries and the gates are WS3's (`advance`, `askView`, `revealed`, `openAsks`); this file only reads them into what a screen needs:
// a node's own steps, its children as cards, where it sits, whether it is done, and what may not be on screen yet.
//
// It knows nothing of homework. A node is a part with a title; it may hold steps (a lesson), a painted scene or an app, and it may have
// children. Whatever the brain composes from those (a question that asks first and keeps its ways in its children, a sheet of questions, an
// explainer in three parts with a branch) is drawn by the same code.

import { accepts, askView, nodeOf, openAskOf, progressOf, stopOf, textHolds } from '@conduit/language';
import type { AskView, DocNode } from '@conduit/language';
import { visualOf } from './visual';
import type { DocState, Document, LessonStep, NodeId, OpenAsk, VisualSpec } from './types';

export function stepsOf(node: DocNode): readonly LessonStep[] {
  return node.body?.kind === 'lesson' ? node.body.steps : [];
}

export function kidsOf(doc: Document, node: DocNode): readonly DocNode[] {
  return node.children.flatMap((id) => nodeOf(doc, id) ?? []);
}

export function parentOf(doc: Document, node: DocNode): DocNode | null {
  return node.parent === null ? null : nodeOf(doc, node.parent);
}

/** The parts above a node, the root first, the node last. */
export function pathOf(doc: Document, node: DocNode): readonly DocNode[] {
  const out: DocNode[] = [];
  for (let at: DocNode | null = node, guard = 0; at !== null && guard < 64; at = parentOf(doc, at), guard += 1) out.unshift(at);
  return out;
}

/** "7. 25 + 25 =" into its printed number and its words: what a child sees on the paper. */
export function splitNumber(title: string): { readonly printed: string | null; readonly text: string } {
  const m = /^\s*(\d{1,3})[.)]\s+([\s\S]*)$/.exec(title);
  return m === null ? { printed: null, text: title } : { printed: m[1] ?? null, text: m[2] ?? title };
}

/** A node has something to step through. */
export function isLesson(node: DocNode): boolean {
  return stepsOf(node).length > 0;
}

// ---------------------------------------------------------------- where she is in a node

/** The stop she rests at on the node the cursor is on: steps up to and including it are shown. */
export function atOf(state: DocState): number {
  return stopOf(state.cursor) ?? 0;
}
/** How many of a node's steps she has been shown: the cursor rests on its stop. */
export function shownOf(doc: Document, state: DocState, node: DocNode): number {
  return state.cursor.node === node.id ? Math.min(stepsOf(node).length, atOf(state) + 1) : 0;
}

/** The ask she must get past before the next step: the last step shown, when it is an ask that is still shut. */
export function gateOf(doc: Document, state: DocState, node: DocNode): AskView | null {
  const steps = stepsOf(node);
  const last = steps[shownOf(doc, state, node) - 1];
  if (last === undefined || last.kind !== 'ask') return null;
  const view = askView(doc, state, node.id, last.id);
  return view !== null && !view.open ? view : null;
}

/** Her accepted answer on a node, as she wrote it: the last of its asks that she has right. */
export function answerOf(doc: Document, state: DocState, node: DocNode): string | null {
  // a part ends on an ask when the ask is its point (a question written to be answered); an ask in the middle of a way is a check on the way
  const ask = stepsOf(node).at(-1);
  if (ask === undefined || ask.kind !== 'ask') return null;
  const view = askView(doc, state, node.id, ask.id);
  return view !== null && view.accepted ? (view.tries.find((t) => accepts(ask, t)) ?? null) : null;
}

/** Done: a part with steps when she has been through them and every ask is got past; a part with only children when all of those are done. */
export function isDone(doc: Document, state: DocState, node: DocNode): boolean {
  if (isLesson(node)) return progressOf(state, node.id).done;
  const kids = kidsOf(doc, node);
  return kids.length > 0 && kids.every((k) => isDone(doc, state, k));
}

/** Something is being written: the part is named and not yet written, or arriving. */
export function isWaiting(node: DocNode): boolean {
  return node.status === 'outlined' || node.status === 'filling';
}

/** How many leaf parts under a node (itself when it has none) are done, and how many there are. */
export function tally(doc: Document, state: DocState, node: DocNode): { readonly done: number; readonly total: number } {
  const kids = kidsOf(doc, node);
  if (kids.length === 0 || isLesson(node)) return { done: isDone(doc, state, node) ? 1 : 0, total: 1 };
  // a question written as its ways alone is one question (it is done when a way is), never one for each way it can be seen in
  if (node.body === null && kids.every((k) => k.for !== null)) return { done: kids.some((k) => isDone(doc, state, k)) ? 1 : 0, total: 1 };
  return kids.reduce((sum, k) => {
    const t = tally(doc, state, k);
    return { done: sum.done + t.done, total: sum.total + t.total };
  }, { done: 0, total: 0 });
}

// ---------------------------------------------------------------- the map: a part's children as cards

export interface CardGroup {
  /** the part that heads the group (a section), or null for children shown at the top level */
  readonly head: DocNode | null;
  readonly items: readonly DocNode[];
}

/** A container whose children are themselves parts with children is a section: its children are shown under it. */
export function cardsOf(doc: Document, node: DocNode): readonly CardGroup[] {
  const groups: CardGroup[] = [];
  let loose: DocNode[] = [];
  const flush = (): void => {
    if (loose.length > 0) groups.push({ head: null, items: loose });
    loose = [];
  };
  for (const kid of kidsOf(doc, node)) {
    const inner = kidsOf(doc, kid);
    if (!isLesson(kid) && inner.length > 0 && inner.some((g) => !isLesson(g) || kidsOf(doc, g).length > 0 || g.for === null)) {
      flush();
      groups.push({ head: kid, items: inner });
    } else loose.push(kid);
  }
  flush();
  return groups;
}

/** The node to go to after this one: its next sibling, or its parent's next, skipping what is inside it. */
export function afterOf(doc: Document, node: DocNode): DocNode | null {
  for (let at: DocNode | null = node, guard = 0; at !== null && guard < 64; at = parentOf(doc, at), guard += 1) {
    const parent = parentOf(doc, at);
    if (parent === null) return null;
    const i = parent.children.indexOf(at.id);
    const next = parent.children[i + 1];
    if (next !== undefined) return nodeOf(doc, next);
  }
  return null;
}

// ---------------------------------------------------------------- what may not be on screen (2.6)

/**
 * The asks whose answers may not be on screen now: every ask of the node that is still shut (shown or not) and of every part above it. WS3's
 * `openAsks` holds the ones shown; the ones ahead are held back too, so a picture cannot give an answer away before it is asked, and a way
 * that is played as help under a question that has asked itself first cannot hold the question's answer.
 * A number a question or part above is itself written with is no secret (WS3's lint says the same).
 */
export function shutAsks(doc: Document, state: DocState, node: DocNode): readonly OpenAsk[] {
  const path = pathOf(doc, node);
  const words = path.map((p) => p.title);
  return path.flatMap((part) =>
    stepsOf(part).flatMap((step) => {
      if (step.kind !== 'ask') return [];
      const view = askView(doc, state, part.id, step.id);
      if (view === null || view.open) return [];
      const open = openAskOf(step);
      return [{ ...open, accepted: open.accepted.filter((answer) => !words.some((w) => textHolds(w, answer, open.unit))) }];
    }),
  );
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
export function runsOf(steps: readonly LessonStep[], shown: number): readonly Run[] {
  type Open = { steps: { step: LessonStep; index: number }[]; figure: Figure | null };
  const runs: Open[] = [];
  let current: Open = { steps: [], figure: null };
  runs.push(current);
  steps.slice(0, shown).forEach((step, index) => {
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

export type { NodeId };
