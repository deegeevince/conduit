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
import { CASE_ZERO, SHEET_MONEY, SHEET_TENS, catalogueFrom, standInCrop } from '../surfaces/lesson/fixtures';
import { advance, freshState } from '../surfaces/lesson/model';
import type { DocState, Document, LessonEvent, LessonInput, StateChange } from '../surfaces/lesson/types';

const params = new URLSearchParams(location.search);
const DOCS: Readonly<Record<string, Document>> = { case0: CASE_ZERO, tens: SHEET_TENS, money: SHEET_MONEY };
const id = params.get('fixture') ?? 'case0';
const dark = params.get('dark') === '1';
let doc: Document = DOCS[id] ?? CASE_ZERO;

interface BenchWindow extends Window {
  __lesson?: unknown;
}
const win: BenchWindow = window;

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
  return freshState(d);
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
if (openNode !== null) state = advance(doc, state, { kind: 'goto', node: openNode, at: Number(params.get('at') ?? '0') });

function crops(d: Document): LessonInput['crops'] {
  return d.id === 'money' ? { q3: standInCrop(dark) } : {};
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
  const target = doc.id === 'tens' ? { q: 'q3', way: 'q3b' } : { q: 'q1', way: 'q1d' };
  const original = doc.nodes[target.way];
  if (original !== undefined) {
    const steps = [
      { kind: 'step', id: 's1', show: 'groups n=5 of=12 parts=6,2,4 start=5 noun=vase thing=flower', words: 'Pretend you pour all the flowers out and share them back between the vases.' },
      { kind: 'step', id: 's2', show: null, words: 'Each vase gets the same.' },
      { kind: 'ask', id: 'a1', accepted: ['12'], pick: null, unit: null, prompt: 'How many does each vase get?', hints: ['Share 60 between 5.'] },
    ] as const;
    const put = (n: number, status: 'outlined' | 'filling' | 'verified'): void => {
      const node = { ...original, status, body: { kind: 'lesson' as const, steps: steps.slice(0, n) } };
      doc = { ...doc, nodes: { ...doc.nodes, [target.way]: node } };
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
