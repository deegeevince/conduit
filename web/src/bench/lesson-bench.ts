// Entry for bench-lesson.html (PLAN-v3-core WS6): the lesson view with no model and no server. A fixture document is mounted in the
// sandboxed surface, her state is kept in this page's storage (so a reload restores her place, as the server will), and `window.__lesson`
// is what a driver reads: the last census, her state, every event and state change.
//
//   ?fixture=case0|tens|money     the document (default case0)
//   ?dark=1                       the dark tokens
//   ?reset=1                      forget her place first
//   ?open=<node>&at=<k>           start on a node (a question, or a way at step k)
//   ?stream=1                     a way is written while she is on the sheet: outlined, filling, filled
//   ?nocatalogue=1                no "My sheets"

import { DocumentHost } from '../app/document-host';
import { advance, findNode, initialState } from '@conduit/language';
import type { DocNode, LessonStep, NodeStatus } from '@conduit/language';
import { FIXTURES, catalogueFrom, standInCrop } from '../surfaces/lesson/fixtures';
import type { DocState, Document, LessonEvent, LessonInput, StateChange } from '../surfaces/lesson/types';

const params = new URLSearchParams(location.search);
const DOCS = FIXTURES;
const id = params.get('fixture') ?? 'case0';
const dark = params.get('dark') === '1';
let doc: Document = DOCS[id] ?? DOCS['case0'] ?? Object.values(DOCS)[0] ?? fail();

interface BenchWindow extends Window {
  __lesson?: unknown;
}
const win: BenchWindow = window;
function fail(): never {
  throw new Error('no fixture');
}

function keyOf(name: string): string {
  return `lesson-bench:${name}`;
}
function load(d: Document): DocState {
  try {
    const raw = localStorage.getItem(keyOf(d.id));
    if (raw !== null) return JSON.parse(raw) as DocState;
  } catch {
    // no storage: start fresh
  }
  return initialState(d);
}
function save(name: string, state: DocState): void {
  try {
    localStorage.setItem(keyOf(name), JSON.stringify(state));
  } catch {
    // no storage: the place is not kept
  }
}

if (params.get('reset') === '1') for (const key of Object.keys(DOCS)) localStorage.removeItem(keyOf(key));

let state = load(doc);
const openNode = params.get('open');
const opened = openNode === null ? null : findNode(doc, openNode);
if (opened !== null) state = advance(doc, state, { kind: 'go', node: opened.id, at: { at: Number(params.get('at') ?? '0') } });

function crops(d: Document): LessonInput['crops'] {
  const q = findNode(d, 'q3');
  return d.id === 'money' && q !== null ? { [q.id]: standInCrop(dark) } : {};
}
function input(): LessonInput {
  const states: Record<string, DocState> = {};
  for (const key of Object.keys(DOCS)) states[key] = key === doc.id ? state : load(DOCS[key] ?? doc);
  const catalogue = params.get('nocatalogue') === '1' ? [] : catalogueFrom(Object.values(DOCS), states, doc.id);
  return { doc, state, crops: crops(doc), catalogue };
}

const events: LessonEvent[] = [];
const changes: StateChange[] = [];
const mount = document.getElementById('lesson');
if (mount === null) throw new Error('no mount');
const host = new DocumentHost({
  mount,
  dark,
  input: input(),
  onState: (next) => {
    state = next;
    save(doc.id, next);
  },
  onChange: (change) => changes.push(change),
  onEvent: (event) => {
    events.push(event);
    if (event.kind === 'document') {
      const next = DOCS[event.id];
      if (next !== undefined) {
        const u = new URL(location.href);
        u.searchParams.set('fixture', next.id);
        u.searchParams.delete('open');
        u.searchParams.delete('reset');
        location.href = u.toString();
      }
    }
  },
});

if (params.get('stream') === '1') {
  // the brain writes ahead while she is on the sheet: a way named, then its first step, then the rest, then verified
  const target = findNode(doc, doc.id === 'tens' ? 'q3b' : 'q1d');
  if (target !== null) {
    const steps: readonly LessonStep[] = [
      { kind: 'step', id: 'x1', show: { visual: 'groups', range: null, args: { count: '5', each: '12', label: 'flowers' } }, words: 'Pretend you pour all the flowers out and share them back between the vases.' },
      { kind: 'step', id: 'x2', show: null, words: 'Each vase gets the same.' },
      { kind: 'ask', id: 'a9', prompt: 'How many does each vase get?', accepted: ['12'], pick: null, unit: null, hints: ['Share the flowers between the five vases.'] },
    ];
    const put = (n: number, status: NodeStatus): void => {
      const node: DocNode = { ...target, status, body: n === 0 ? null : { kind: 'lesson', steps: steps.slice(0, n) } };
      doc = { ...doc, nodes: { ...doc.nodes, [target.id]: node } };
      host.setInput(input());
    };
    put(0, 'outlined');
    window.setTimeout(() => put(1, 'filling'), 1500);
    window.setTimeout(() => put(2, 'filling'), 3500);
    window.setTimeout(() => put(3, 'verified'), 5500);
  }
}

win.__lesson = {
  host,
  census: () => host.lastCensus(),
  state: () => state,
  events,
  changes,
  probe: () => host.probe(),
  frame: () => host.element.getBoundingClientRect().toJSON(),
  shoot: () => host.shoot(),
};
