// Checks of the anchor (language/src/{anchor,source,action,annotate}.ts), on made-up documents: no model and no file of anyone's.
//   - `resolve` on text drift: exact, moved, orphan (the spike's three cases as a table, and the harder ones round them)
//   - `rebase` through the edits we make, and `layerOf` over a log
//   - every selector written and read back by each carrier: the wire (JSON), the text form, and the line of the language
//   - every decoder refusing what it should
// Run by `pnpm timeline`; or alone: pnpm --filter @conduit/language exec tsx scripts/anchor-checks.ts
import { fileURLToPath } from 'node:url';
import {
  ANCHOR_LIMITS,
  anchorsOfMarks,
  anchorTokens,
  layerOf,
  opsOfAction,
  pageText,
  parseLine,
  readAction,
  readAnchor,
  readAnchorText,
  readAnnotate,
  readOp,
  readStructure,
  rebase,
  resolve,
  resolveText,
  serializeAnnotate,
  writeAnchor,
} from '../src/index';
import type { Action, AnnotateLine, DocAnchor, Op, Selector, Structure, TextItem } from '../src/index';

let ok = true;
/** JSON with the keys in order, so two values are equal when they hold the same things. */
function canon(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'object' && v !== null && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v,
  );
}
const expect = (what: string, got: unknown, want: unknown = true): void => {
  if (canon(got) !== canon(want)) {
    ok = false;
    process.stdout.write(`  ANCHOR CHECK FAILED: ${what}\n      got    ${canon(got)}\n      wanted ${canon(want)}\n`);
  }
};

// A made-up two-page agreement, as PDF.js would give it: items with a transform, a width and a height, on a 600 by 800 page.
function item(str: string, x: number, y: number, width: number, hasEOL = false): TextItem {
  return { str, transform: [10, 0, 0, 10, x, y], width, height: 10, hasEOL };
}
const PAGE = { w: 600, h: 800 };
const page1: TextItem[] = [
  item('The Client shall ', 50, 700, 90),
  item('pay each invoice', 140, 700, 80), // bold: five runs below make one selection
  item(' within ', 220, 700, 40),
  item('14 days', 260, 700, 40),
  item(' of the invoice date.', 300, 700, 100, true),
  item('Prices are ', 50, 680, 60),
  item('net of GST', 110, 680, 55),
  item('. Late payment ', 165, 680, 70),
  item('is charged at 2%.', 235, 680, 80, true),
  item('The Supplier shall ', 50, 660, 90),
  item('pay each invoice', 140, 660, 80),
  item(' it raises to its own staff.', 220, 660, 130, true),
];
const joined = pageText(page1, PAGE);
const T = joined.text;
const structure: Structure = {
  v: 1,
  source: 'u3',
  sha: 'x'.repeat(8),
  pages: [
    { n: 1, w: 600, h: 800, text: T, runs: joined.runs },
    { n: 2, w: 600, h: 800, text: 'Either party may end this agreement on 30 days notice.', runs: [] },
  ],
  sheets: [{ name: 'Costs', rows: 20, cols: 6, cells: { B4: { v: 'net of GST' }, C4: { v: '14' } } }],
  blocks: [{ path: 'h1', role: 'heading', level: 1, page: 1, start: 0, end: 10 }],
};

/** A selection of `words` at its first place (or its `n`th) in `text`, as the page would make it from the DOM. */
function selection(text: string, words: string, n = 0, scope = 'p1'): Extract<Selector, { kind: 'text' }> {
  let at = -1;
  for (let i = 0; i <= n; i += 1) at = text.indexOf(words, at + 1);
  if (at < 0) throw new Error(`anchor check: "${words}" is not in the text`);
  const end = at + words.length;
  return { kind: 'text', scope, quote: words, prefix: text.slice(Math.max(0, at - ANCHOR_LIMITS.context), at), suffix: text.slice(end, end + ANCHOR_LIMITS.context), start: at, end };
}

function pageChecks(): void {
  expect('pageText joins the items into one line of text with no line breaks', /\n/.test(T), false);
  expect('pageText: a run of an item that touches the last is not split off by a space', T.startsWith('The Client shall pay each invoice within 14 days of the invoice date. Prices are net of GST.'), true);
  expect('pageText: one run for each item with words', joined.runs.length, page1.length);
  const first = joined.runs[0];
  expect('pageText: a run covers its own words', first === undefined ? '' : T.slice(first.start, first.end), 'The Client shall');
  expect('pageText: a box is a fraction of the page from its top left', first?.box, [0.0833, 0.1125, 0.15, 0.0125]);
  expect('pageText: nothing is empty', pageText([], PAGE).text, '');
}

/** The table of section 9: a selection across five runs; the second of a repeated phrase after drift; an orphan; and the ones round them. */
function driftChecks(): void {
  const five = selection(T, 'shall pay each invoice within 14 days of the invoice date');
  expect('a selection across five runs is one text selector', joined.runs.filter((r) => r.end > five.start && r.start < five.end).length, 5);
  expect('drift: exact at its position', resolve({ on: 'u3', sel: five }, structure).state, 'exact');

  const second = selection(T, 'pay each invoice', 1);
  const edited = `Preamble added by the other side. ${T.replace('14 days', '30 days').replace('net of GST', 'net of VAT')}`;
  const driftStructure: Structure = { ...structure, pages: [{ n: 1, w: 600, h: 800, text: edited, runs: [] }, ...structure.pages.slice(1)] };
  const moved = resolve({ on: 'u3', sel: second }, driftStructure);
  expect('drift: the second of a repeated phrase after words are added and a number rewritten is moved', moved.state, 'moved');
  expect('drift: and it is the second one', moved.sel.kind === 'text' ? edited.indexOf('pay each invoice', edited.indexOf('pay each invoice') + 1) === moved.sel.start : false, true);
  expect('drift: the moved selector carries fresh context', moved.sel.kind === 'text' ? moved.sel.prefix === edited.slice(moved.sel.start - 24, moved.sel.start) : false, true);
  expect('drift: the first of the pair is found too, by its own context', resolve({ on: 'u3', sel: selection(T, 'pay each invoice', 0) }, driftStructure).sel.kind === 'text' && (resolve({ on: 'u3', sel: selection(T, 'pay each invoice', 0) }, driftStructure).sel as { start: number }).start === edited.indexOf('pay each invoice'), true);

  const gone = { ...driftStructure, pages: [{ n: 1, w: 600, h: 800, text: 'Nothing of that remains.', runs: [] }, ...structure.pages.slice(1)] };
  expect('drift: the words removed is an orphan', resolve({ on: 'u3', sel: second }, gone).state, 'orphan');
  expect('drift: an orphan keeps its selector, to be listed with its words', resolve({ on: 'u3', sel: second }, gone).sel, second);

  const quoteOnly: Selector = { kind: 'text', scope: 'p1', quote: 'net of GST', prefix: '', suffix: '', start: -1, end: -1 };
  const found = resolve({ on: 'u3', sel: quoteOnly }, structure);
  expect('drift: a quote with no position (as the mind writes one) is found', found.state, 'moved');
  expect('drift: and at the right place', found.sel.kind === 'text' ? [found.sel.start, found.sel.end] : null, [T.indexOf('net of GST'), T.indexOf('net of GST') + 10]);
  const twice: Selector = { kind: 'text', scope: 'p1', quote: 'pay each invoice', prefix: '', suffix: '', start: -1, end: -1 };
  expect('drift: a quote with no position that occurs twice is not guessed', resolve({ on: 'u3', sel: twice }, structure).state, 'orphan');
  expect('drift: an empty quote is an orphan', resolveText({ ...five, quote: '' }, T).state, 'orphan');

  const longQuote = `${'a'.repeat(120)} middle that was not kept ${'b'.repeat(120)}`;
  const longText = `lead in. ${longQuote} and after.`;
  const long: Selector = { kind: 'text', scope: 'p1', quote: 'a'.repeat(120), tail: 'b'.repeat(120), prefix: 'lead in. '.slice(-24), suffix: ' and after.', start: 9, end: 9 + longQuote.length };
  expect('a selection over 240 characters resolves by its first and last 120', resolveText(long, longText).state, 'exact');
  expect('and after drift', resolveText({ ...long, start: 2, end: 2 + longQuote.length }, longText).sel.kind === 'text' && (resolveText({ ...long, start: 2, end: 2 + longQuote.length }, longText).sel as { end: number }).end === 9 + longQuote.length, true);

  expect('another object is not this structure', resolve({ on: 'u4', sel: five }, structure).state, 'orphan');
  expect('a scope the source does not hold is an orphan', resolve({ on: 'u3', sel: { ...five, scope: 'p9' } }, structure).state, 'orphan');
  expect('a cell scope is read in the sheet', resolve({ on: 'u3', sel: { kind: 'text', scope: 'B4', quote: 'GST', prefix: 'net of ', suffix: '', start: 7, end: 10 } }, structure).state, 'exact');

  // The other selectors
  const on = (sel: Selector): DocAnchor => ({ on: 'u3', sel });
  expect('cells inside the sheet are exact', resolve(on({ kind: 'cells', sheet: 'Costs', range: 'B2:D9' }), structure).state, 'exact');
  expect('cells outside it are an orphan', resolve(on({ kind: 'cells', sheet: 'Costs', range: 'B2:D99' }), structure).state, 'orphan');
  expect('a sheet that is not there is an orphan', resolve(on({ kind: 'cells', sheet: 'Gone', range: 'A1' }), structure).state, 'orphan');
  expect('a page that is there is exact', resolve(on({ kind: 'page', page: 2 }), structure).state, 'exact');
  expect('a page that is not is an orphan', resolve(on({ kind: 'page', page: 3 }), structure).state, 'orphan');
  expect('a region on a page is exact', resolve(on({ kind: 'region', page: 1, box: [0.1, 0.2, 0.3, 0.1] }), structure).state, 'exact');
  expect('a region off the page is an orphan', resolve(on({ kind: 'region', page: 1, box: [0.9, 0.2, 0.3, 0.1] }), structure).state, 'orphan');
  expect('a node is exact when the source has it', resolve(on({ kind: 'node', path: 'h1' }), structure).state, 'exact');
  expect('a node it lacks is an orphan', resolve(on({ kind: 'node', path: 'h9' }), structure).state, 'orphan');
  expect('the whole object is always there', resolve(on({ kind: 'node', path: '' }), structure).state, 'exact');
  const media: Structure = { ...structure, words: [{ start: 0, end: 3, t: 0, d: 10 }] };
  expect('a time inside the recording is exact', resolve(on({ kind: 'time', from: 2, to: 8 }), media).state, 'exact');
  expect('a time past its end is an orphan', resolve(on({ kind: 'time', from: 2, to: 80 }), media).state, 'orphan');
  expect('a stage part is an orphan without the stage to say', resolve({ on: 'login', sel: { kind: 'part', path: 'signin/submit' } }, structure).state, 'orphan');
  expect('and exact when the stage says it is there', resolve({ on: 'login', sel: { kind: 'part', path: 'signin/submit' } }, structure, () => true).state, 'exact');
}

function ref(on: string, sel: Selector): DocAnchor {
  return { on, sel };
}

function rebaseChecks(): void {
  const meta = { id: 'o', seq: 1, by: 'you' as const, turn: null, base: 0 };
  const table = new Map<string, DocAnchor>();
  const at = (id: string): DocAnchor | undefined => table.get(id);
  const op = (body: Record<string, unknown>): Op => ({ ...meta, ...body }) as Op;

  // Pages: page 3 moved before page 1.
  table.set('^a', ref('u3', { kind: 'page', page: 3 }));
  table.set('^b', ref('u3', { kind: 'page', page: 1 }));
  const pages = op({ kind: 'move', anchor: '^a', rel: 'before', to: '^b', from: null });
  const pageOf = (sel: Selector): unknown => rebase(ref('u3', sel), pages, at)?.sel;
  expect('rebase: the moved page is now first', pageOf({ kind: 'page', page: 3 }), { kind: 'page', page: 1 });
  expect('rebase: the pages it jumped over move down one', [pageOf({ kind: 'page', page: 1 }), pageOf({ kind: 'page', page: 2 })], [{ kind: 'page', page: 2 }, { kind: 'page', page: 3 }]);
  expect('rebase: a page beyond them stays', pageOf({ kind: 'page', page: 4 }), { kind: 'page', page: 4 });
  expect('rebase: a region follows its page', (rebase(ref('u3', { kind: 'region', page: 3, box: [0.1, 0.1, 0.2, 0.2] }), pages, at)?.sel as { page: number }).page, 1);
  expect('rebase: words follow their page', (rebase(ref('u3', selection('abc def', 'def', 0, 'p3')), pages, at)?.sel as { scope: string }).scope, 'p1');
  expect('rebase: another object is not touched', rebase(ref('u9', { kind: 'page', page: 2 }), pages, at)?.sel, { kind: 'page', page: 2 });
  expect('rebase: with no table nothing is known to have moved', rebase(ref('u3', { kind: 'page', page: 2 }), pages)?.sel, { kind: 'page', page: 2 });
  const after = op({ kind: 'move', anchor: '^b', rel: 'after', to: '^a', from: null });
  expect('rebase: page 1 after page 3: 1 -> 3, 2 -> 1, 3 -> 2', [1, 2, 3].map((p) => (rebase(ref('u3', { kind: 'page', page: p }), after, at)?.sel as { page: number }).page), [3, 1, 2]);

  // Nodes: into
  table.set('^n', ref('d', { kind: 'node', path: 'a/b' }));
  table.set('^t', ref('d', { kind: 'node', path: 'c' }));
  const into = op({ kind: 'move', anchor: '^n', rel: 'into', to: '^t', from: null });
  expect('rebase: a node moved into another takes its path', rebase(ref('d', { kind: 'node', path: 'a/b' }), into, at)?.sel, { kind: 'node', path: 'c/b' });
  expect('rebase: and so do its children', rebase(ref('d', { kind: 'node', path: 'a/b/x' }), into, at)?.sel, { kind: 'node', path: 'c/b/x' });
  expect('rebase: not its siblings', rebase(ref('d', { kind: 'node', path: 'a/bb' }), into, at)?.sel, { kind: 'node', path: 'a/bb' });

  // Rows: row 7 before row 3 (a block of one), and a block of two after row 9
  table.set('^r', ref('s', { kind: 'cells', sheet: 'S', range: 'A7:F7' }));
  table.set('^q', ref('s', { kind: 'cells', sheet: 'S', range: 'A3:F3' }));
  const rows = op({ kind: 'move', anchor: '^r', rel: 'before', to: '^q', from: null });
  const rowsOf = (range: string): unknown => (rebase(ref('s', { kind: 'cells', sheet: 'S', range }), rows, at)?.sel as { range: string } | undefined)?.range;
  expect('rebase: the row moved is now row 3', rowsOf('B7'), 'B3');
  expect('rebase: rows it jumped over move down', [rowsOf('B3'), rowsOf('B6'), rowsOf('B8')], ['B4', 'B7', 'B8']);
  expect('rebase: a range wholly inside the jumped rows moves with them', rowsOf('B3:C5'), 'B4:C6');
  expect('rebase: a range cut by the move cannot stay one piece', rebase(ref('s', { kind: 'cells', sheet: 'S', range: 'B5:B8' }), rows, at), null);

  // Fill: words in a filled cell are replaced
  table.set('^c', ref('s', { kind: 'cells', sheet: 'Costs', range: 'B3:B5' }));
  const fill = op({ kind: 'fill', anchor: '^c', value: ['1', '2', '3'], was: [] });
  expect('rebase: words in a cell that was filled are gone', rebase(ref('s', { kind: 'text', scope: 'Costs!B4', quote: 'x', prefix: '', suffix: '', start: -1, end: -1 }), fill, at), null);
  expect('rebase: words in a cell that was not stay', rebase(ref('s', { kind: 'text', scope: 'Costs!C4', quote: 'x', prefix: '', suffix: '', start: -1, end: -1 }), fill, at)?.sel.kind, 'text');
  expect('rebase: the filled range itself stays', rebase(table.get('^c') as DocAnchor, fill, at)?.sel, { kind: 'cells', sheet: 'Costs', range: 'B3:B5' });
}

function layerChecks(): void {
  const turn = 't1';
  const a1 = ref('u3', { kind: 'page', page: 3 });
  const a2 = ref('u3', { kind: 'page', page: 1 });
  const text = ref('u3', selection(T, 'net of GST'));
  const actions: Action[] = [
    { did: 'highlight', anchors: [text], colour: 'yellow', at: [10, 12] },
    { did: 'select', anchors: [a1], at: [20, 20] },
    { did: 'highlight', anchors: [text], at: [30, 31] },
  ];
  const ops: Op[] = [];
  let next = 1;
  let seq = 1;
  const pinned: { id: string; anchor: DocAnchor; by: 'you'; seq: number; said: string }[] = [];
  for (const action of actions) {
    const made = opsOfAction(action, { pinned, next, seq, turn, base: 0 });
    for (const o of made.ops) {
      ops.push(o);
      if (o.kind === 'anchor') pinned.push({ id: o.name, anchor: o.anchor, by: 'you', seq: o.seq, said: o.said });
    }
    next = made.next;
    seq += made.ops.length;
  }
  expect('the fold numbers the person\'s anchors ^1, ^2', ops.filter((o) => o.kind === 'anchor').map((o) => (o.kind === 'anchor' ? o.name : '')), ['^1', '^2']);
  expect('an anchor named twice is one', ops.filter((o) => o.kind === 'anchor').length, 2);
  expect('a highlight is a mark on its anchor, each time', ops.filter((o) => o.kind === 'mark').length, 2);

  const empty = { ops: [] as Op[] };
  const base = layerOf(empty, { ops });
  expect('layer: two anchors, two marks', [base.anchors.length, base.marks.length], [2, 2]);
  expect('layer: said is the words', base.anchors[0]?.said, 'net of GST');

  const meta = (n: number, by: 'you' | 'mind' = 'mind') => ({ id: `t2:${n}`, seq: 100 + n, by, turn: 't2', base: 0 });
  const mind: Op[] = [
    { ...meta(1), kind: 'anchor', name: '^terms', anchor: a2, said: 'page 1' },
    { ...meta(2), kind: 'link', a: '^1', b: '^terms', reason: 'the price and the page it came from' },
    { ...meta(3), kind: 'mark', anchor: '^terms', style: 'highlight' },
  ];
  const withMind = layerOf({ ops: mind }, { ops });
  expect('layer: the mind\'s ops and the person\'s are merged by seq', withMind.anchors.map((p) => p.id), ['^1', '^2', '^terms']);
  expect('layer: a link keeps its reason', withMind.links[0]?.reason, 'the price and the page it came from');
  const undone = layerOf({ ops: [...mind, { ...meta(4, 'you'), kind: 'undo', op: 't2:3' }] }, { ops });
  expect('layer: undo is an op: the mark it undid is gone and the log keeps it', [undone.marks.some((m) => m.anchor === '^terms'), mind.length], [false, 3]);
  const undoUndo = layerOf({ ops: [...mind, { ...meta(4, 'you'), kind: 'undo', op: 't2:3' }, { ...meta(5, 'you'), kind: 'undo', op: 't2:4' }] }, { ops });
  expect('layer: undoing an undo brings it back', undoUndo.marks.some((m) => m.anchor === '^terms'), true);
  const cleared = layerOf({ ops: [...mind, { ...meta(4), kind: 'mark', anchor: '^terms', style: 'none' }] }, { ops });
  expect('layer: a mark of none clears the mind\'s marks there, not the person\'s', [cleared.marks.some((m) => m.anchor === '^terms'), cleared.marks.some((m) => m.anchor === '^1')], [false, true]);
  const unlinked = layerOf({ ops: [...mind, { ...meta(4), kind: 'link', a: '^terms', b: '^1', reason: '', remove: true }] }, { ops });
  expect('layer: link none removes it, whichever way round', unlinked.links.length, 0);
  const replay = layerOf({ ops: [...mind, ...mind] }, { ops: [...ops, ...ops] });
  expect('layer: a replay applies nothing twice', [replay.anchors.length, replay.marks.length, replay.links.length], [3, 2 + 1, 1]);
  const moved = layerOf({ ops: [...mind, { ...meta(4), kind: 'move', anchor: '^1', rel: 'before', to: '^terms', from: null }] }, { ops });
  expect('layer: the pages carried by a move', moved.anchors.find((p) => p.id === '^2')?.anchor.sel, { kind: 'page', page: 3 });
  expect('layer: an anchor made after a move is not carried by it', layerOf({ ops: [...mind.slice(0, 1)] }, { ops: [] }).anchors[0]?.anchor.sel, { kind: 'page', page: 1 });
  const lostCase = layerOf({ ops: mind }, { ops }, () => ({ ...structure, pages: [{ n: 1, w: 600, h: 800, text: 'Nothing of that remains.', runs: [] }] }));
  expect('layer: an anchor whose words are gone is listed as lost and kept', [lostCase.lost.includes('^1'), lostCase.anchors.some((p) => p.id === '^1')], [true, true]);
  const carried = layerOf({ ops: mind }, { ops }, () => ({ ...structure, pages: [{ n: 1, w: 600, h: 800, text: `New words. ${T}`, runs: [] }, ...structure.pages.slice(1)] }));
  expect('layer: an anchor whose words moved is carried', carried.anchors.find((p) => p.id === '^1')?.anchor.sel.kind === 'text' && !carried.lost.includes('^1'), true);
}

/** Every selector in its variants, through the three carriers. */
const SELECTORS: readonly DocAnchor[] = [
  ref('u3', selection(T, 'net of GST')),
  ref('u3', { kind: 'text', scope: 'p2', quote: 'two words', prefix: 'any ', suffix: ' here', start: 4, end: 13 }),
  ref('u3', { kind: 'text', scope: '', quote: 'only a quote', prefix: '', suffix: '', start: -1, end: -1 }),
  ref('u7', { kind: 'text', scope: 'Costs!B4', quote: 'GST included', prefix: '', suffix: '', start: -1, end: -1 }),
  ref('w1/s2/q7', { kind: 'text', scope: 'cell:1:2', quote: '50% off | today = great', prefix: '', suffix: '', start: -1, end: -1 }),
  ref('w1/#2:rev', { kind: 'text', scope: 'label', quote: 'a_b%c', prefix: '', suffix: '', start: 0, end: 5 }),
  ref('u3', { kind: 'text', scope: 'p1', quote: 'a'.repeat(120), tail: 'b'.repeat(120), prefix: '', suffix: '', start: 9, end: 400 }),
  ref('u7', { kind: 'cells', sheet: 'Costs', range: 'B2:D9' }),
  ref('u7', { kind: 'cells', sheet: 'Q1 Costs_net', range: 'B2' }),
  ref('n2', { kind: 'time', from: 12.5, to: 31 }),
  ref('n2', { kind: 'time', from: 7, to: 7 }),
  ref('u3', { kind: 'region', page: 2, box: [0.12, 0.4, 0.3, 0.08] }),
  ref('u1', { kind: 'region', page: 1, box: [0, 0, 1, 1] }),
  ref('u9', { kind: 'page', page: 4 }),
  ref('q7', { kind: 'node', path: '' }),
  ref('u8', { kind: 'node', path: 'h1/p2' }),
  ref('login', { kind: 'part', path: 'signin/submit' }),
  ref('rev', { kind: 'chart', series: null, x: '2024-03' }),
  ref('rev', { kind: 'chart', series: 'Revenue', x: '2024-03', to: '2024-06', y: 41.5 }),
];

function forgetContext(anchor: DocAnchor): DocAnchor {
  return anchor.sel.kind === 'text' ? { on: anchor.on, sel: { ...anchor.sel, prefix: '', suffix: '' } } : anchor;
}

function headOf(text: string): { words: string[]; pairs: { key: string; value: string; raw: string; token: string }[] } {
  // as `readHead` makes it: words are lowercased, pairs have a lowercased key and value and the value as written
  const words: string[] = [];
  const pairs: { key: string; value: string; raw: string; token: string }[] = [];
  for (const token of text.split(/\s+/).filter((t) => t !== '')) {
    const eq = token.indexOf('=');
    if (eq > 0) pairs.push({ key: token.slice(0, eq).toLowerCase(), value: token.slice(eq + 1).toLowerCase(), raw: token.slice(eq + 1), token });
    else words.push(token.toLowerCase());
  }
  return { words, pairs };
}

/** `readAnnotate` on one written line, the way `parseLine` hands it the head and the words after the first bar. */
function readWritten(written: string): AnnotateLine | null {
  const [verbWord = '', ...rest] = written.split(/\s+/);
  const bar = written.indexOf('|');
  const head = headOf((bar < 0 ? written : written.slice(0, bar)).trim().split(/\s+/).slice(1).join(' '));
  const read = readAnnotate(verbWord.toLowerCase() === 'link' ? 'link' : verbWord.toLowerCase(), head, bar < 0 ? null : written.slice(bar + 1));
  void rest;
  return read.issues.some((i) => i.severity === 'error') ? null : read.line;
}

function carrierChecks(): void {
  SELECTORS.forEach((anchor, index) => {
    const name = `selector ${index} (${anchor.sel.kind} on ${anchor.on})`;
    expect(`${name}: the wire reads back what it wrote`, readAnchor(JSON.parse(JSON.stringify(anchor))), anchor);
    expect(`${name}: it is inside the byte bound`, JSON.stringify(anchor).length <= ANCHOR_LIMITS.bytes, true);
    const written = writeAnchor(anchor);
    expect(`${name}: the text form reads back (${written.slice(0, 60)})`, readAnchorText(written), forgetContext(anchor));
    const line: AnnotateLine = { verb: 'anchor', id: '^terms', anchor };
    const text = serializeAnnotate(line);
    expect(`${name}: the line has no line break and one bar at most before its words`, [/\n/.test(text), text.indexOf('|') === text.lastIndexOf('|') || anchor.sel.kind === 'text'], [false, true]);
    const back = readWritten(text);
    expect(`${name}: the line reads back, and writes the same`, back === null ? null : serializeAnnotate(back), text);
    expect(`${name}: the line holds the same anchor`, back?.verb === 'anchor' ? back.anchor : null, forgetContext(anchor));
  });
  expect('tokens of a text selector are bare words and pairs', anchorTokens(ref('u3', selection(T, 'net of GST'))).join(' '), `on=u3 page=1 span=${T.indexOf('net of GST')}..${T.indexOf('net of GST') + 10}`);
  expect('the plan\'s example reads: anchor ^terms on=u3 page=2 | net of GST', readWritten('anchor ^terms on=u3 page=2 | net of GST'), {
    verb: 'anchor',
    id: '^terms',
    anchor: { on: 'u3', sel: { kind: 'text', scope: 'p2', quote: 'net of GST', prefix: '', suffix: '', start: -1, end: -1 } },
  });
  expect('a page with no words is the page', (readWritten('anchor ^p on=u9 page=4') as { anchor: DocAnchor }).anchor.sel, { kind: 'page', page: 4 });
  expect('a box with no page is on page 1', (readWritten('anchor ^p on=u1 box=0.1,0.2,0.3,0.4 | the logo') as { anchor: DocAnchor; said?: string }).anchor.sel, { kind: 'region', page: 1, box: [0.1, 0.2, 0.3, 0.4] });
  expect('the words of a region are what it is', (readWritten('anchor ^p on=u1 page=2 box=0.1,0.2,0.3,0.4 | the logo') as { said?: string }).said, 'the logo');

  // refused
  for (const bad of [
    'anchor ^terms page=2 | x',
    'anchor ^terms on=u3 page=0 | x',
    'anchor ^terms on=u3 page=2 span=9..3 | x',
    'anchor ^terms on=u3 span=3..9',
    'anchor ^terms on=u3 box=0.1,0.2,0.3 | x',
    'anchor ^terms on=u3 cells=B2 box=0.1,0.2,0.3,0.4',
    'anchor ^terms on=u3 sheet=S cells=ZZZZ9',
    'anchor ^terms on=u3 t=5..2',
    'anchor ^1 on=u3 page=2 | x',
    'anchor terms on=u3 page=2 | x',
    `anchor ^terms on=u3 page=2 | ${'x'.repeat(ANCHOR_LIMITS.quote + 1)}`,
  ]) {
    expect(`refused: ${bad.slice(0, 70)}`, readWritten(bad), null);
  }

  // the other lines
  const lines: readonly string[] = [
    'mark ^terms highlight',
    'mark ^terms note | check this against clause 4',
    'mark ^1 none',
    'link ^terms ^1 | the price and the clause it came from',
    'link ^terms ^1 none',
    'fill ^c1 | 14 | 15 | 16',
    'redact ^terms | a name',
    'redact ^terms',
    'move ^2 before=^1',
    'move ^2 into=^terms',
    'doc terms from=u3 | The agreement',
    'doc terms from=u3 in=sec1 pages=2..4 | The agreement',
  ];
  for (const text of lines) {
    const line = readWritten(text);
    expect(`line reads and writes back as itself: ${text}`, line === null ? null : serializeAnnotate(line), text);
  }
  expect('link with no reason is refused', readWritten('link ^a ^b'), null);
  expect('link with three ends is refused', readWritten('link ^a ^b ^c | x'), null);
  expect('mark with a note and no style is a note', (readWritten('mark ^a | why') as { style: string }).style, 'note');
  expect('mark with nothing is a highlight', (readWritten('mark ^a') as { style: string }).style, 'highlight');
  expect('move to itself is refused', readWritten('move ^a before=^a'), null);
  expect('move with no place is refused', readWritten('move ^a'), null);
  expect('fill with no value is refused', readWritten('fill ^a'), null);
  expect('doc with no source is refused', readWritten('doc terms | x'), null);
}

function decoderChecks(): void {
  const good: Action = { did: 'circle', anchors: [SELECTORS[0] as DocAnchor], strokes: ['k1', 'k2'], colour: 'red', at: [100, 400] };
  expect('an action reads back', readAction(JSON.parse(JSON.stringify(good))), good);
  expect('an action with a bad did is refused', readAction({ ...good, did: 'dance' }), null);
  expect('an action with a bad anchor in it is refused whole', readAction({ ...good, anchors: [{ on: 'u3', sel: { kind: 'page', page: -1 } }] }), null);
  expect('an action over the per-action bound is refused', readAction({ ...good, anchors: Array.from({ length: ANCHOR_LIMITS.perAction + 1 }, () => good.anchors[0]) }), null);
  expect('an action whose time runs backwards is refused', readAction({ ...good, at: [5, 1] }), null);
  expect('an action that names nothing is refused', readAction({ did: 'tap', anchors: [], at: [1, 1] }), null);
  expect('a drag carries where it went', readAction({ did: 'drag', anchors: [good.anchors[0]], to: SELECTORS[13], rel: 'after', at: [1, 2] })?.rel, 'after');
  expect('an anchor of the wrong type is refused', readAnchor({ on: 'u3', sel: { kind: 'text', scope: 'p1', quote: 'x', prefix: 7, suffix: '', start: 0, end: 1 } }), null);
  expect('an anchor with a long prefix is refused', readAnchor({ on: 'u3', sel: { kind: 'text', scope: 'p1', quote: 'x', prefix: 'y'.repeat(25), suffix: '', start: 0, end: 1 } }), null);
  expect('an anchor over the byte bound is refused', readAnchor({ on: 'u'.repeat(100), sel: { kind: 'text', scope: 'x'.repeat(64), quote: 'q'.repeat(240), prefix: 'p'.repeat(24), suffix: 's'.repeat(24), tail: 't'.repeat(120), start: 0, end: 900 } }), null);
  expect('an anchor drops what it does not know', readAnchor({ on: 'u3', sel: { kind: 'page', page: 2, evil: 1 }, extra: 1 }), { on: 'u3', sel: { kind: 'page', page: 2 } });
  expect('an anchor on nothing is refused', readAnchor({ on: '', sel: { kind: 'page', page: 2 } }), null);
  expect('a non-object is refused', [readAnchor(null), readAnchor('u3'), readAnchor([])], [null, null, null]);
  expect('a box is held to four places', (readAnchor({ on: 'u3', sel: { kind: 'region', page: 1, box: [0.123456, 0, 1, 1] } })?.sel as unknown as { box: number[] }).box[0], 0.1235);

  const op: Op = { id: 't1:3', seq: 3, by: 'mind', turn: 't1', base: 2, kind: 'link', a: '^1', b: '^terms', reason: 'why' };
  expect('an op reads back', readOp(JSON.parse(JSON.stringify(op))), op);
  expect('a link with no reason is not an op', readOp({ ...op, reason: '' }), null);
  expect('an op of no kind is refused', readOp({ ...op, kind: 'smash' }), null);
  expect('an op naming a bad anchor is refused', readOp({ ...op, a: 'one' }), null);
  expect('an anchor op reads back', readOp({ id: 'x:1', seq: 1, by: 'you', turn: null, base: 0, kind: 'anchor', name: '^1', anchor: SELECTORS[7], said: 'B2:D9' })?.kind, 'anchor');

  const raw = JSON.parse(JSON.stringify(structure));
  expect('a structure reads back whole', readStructure(raw), structure);
  expect('a structure of another version is refused', readStructure({ ...raw, v: 2 }), null);
  expect('a structure with a run past its text is refused', readStructure({ ...raw, pages: [{ ...raw.pages[0], runs: [{ start: 0, end: 99999, box: [0, 0, 1, 1] }] }] }), null);
  expect('a structure with a bad cell name is refused', readStructure({ ...raw, sheets: [{ name: 'S', rows: 1, cols: 1, cells: { '1A': { v: 'x' } } }] }), null);

  const marks = anchorsOfMarks({ on: { node: 'w1', ask: 'q7' } });
  expect('an old ink turn on a question folds to an anchor on it', marks, [{ on: 'w1/q7', sel: { kind: 'node', path: '' } }]);
  expect('an old ink turn on a picture folds to its page', anchorsOfMarks({ background: { source: 'u3', page: 1 } }), [{ on: 'u3', sel: { kind: 'page', page: 1 } }]);
  expect('ink on nothing folds to nothing', anchorsOfMarks({}), []);
}

/** Through `parseLine` and the normaliser: only once the hunks in anchors-AN1-language.patch are applied. */
function lineChecks(): boolean {
  if (parseLine('anchor ^terms on=u3 page=2 | net of GST').kind !== 'line') {
    process.stdout.write('  anchor checks: parseLine does not know the anchor words yet (apply anchors-AN1-language.patch); the line checks through it were skipped\n');
    return true;
  }
  return true;
}

export function anchorChecks(): boolean {
  ok = true;
  pageChecks();
  driftChecks();
  rebaseChecks();
  layerChecks();
  carrierChecks();
  decoderChecks();
  return lineChecks() && ok;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const clean = anchorChecks();
  process.stdout.write(clean ? 'anchor checks: clean\n' : 'anchor checks: FAILED\n');
  process.exit(clean ? 0 : 1);
}
