// What is done to a document, the person's and the mind's, as ops in the log (PLAN-anchors section 4), and the lines of the language that say
// them. Every action is an op; undo is an op; what is on screen is one pure merge by log order (`layerOf`).
import { ANCHOR_LIMITS, anchorFromPairs, anchorQuote, anchorTokens, guards, isAnchorId, isNumberedAnchorId, isObjectId, readAnchor, rebase, resolve } from './anchor';
import type { AnchorId, DocAnchor, PairWord, Pinned, Selector } from './anchor';
import type { Action, Rel } from './action';
import { RELS } from './action';
import type { Structure } from './source';
import type { Issue } from './types';

// ---------------------------------------------------------------------------------------------------------------------------------
// Ops
// ---------------------------------------------------------------------------------------------------------------------------------

export const MARK_STYLES = ['highlight', 'underline', 'box', 'strike', 'note', 'none'] as const;
export type MarkStyle = (typeof MARK_STYLES)[number];

/**
 * `base` is the last revision the writer had been shown. Beyond the plan's six kinds there are two additions the fold needs: `anchor` (an
 * anchor named, by the fold for the person and by the mind's own line), and `remove` on a link (`link ^a ^b none`).
 */
export type Op = {
  readonly id: string;
  readonly seq: number;
  readonly by: 'you' | 'mind';
  readonly turn: string | null;
  readonly base: number;
} & (
  | { readonly kind: 'anchor'; readonly name: AnchorId; readonly anchor: DocAnchor; readonly said: string }
  | { readonly kind: 'mark'; readonly anchor: AnchorId; readonly style: MarkStyle; readonly note?: string; readonly colour?: string; readonly strokes?: readonly string[] }
  | { readonly kind: 'link'; readonly a: AnchorId; readonly b: AnchorId; readonly reason: string; readonly remove?: boolean }
  | { readonly kind: 'fill'; readonly anchor: AnchorId; readonly value: readonly string[]; readonly was: readonly string[] }
  | { readonly kind: 'redact'; readonly anchor: AnchorId; readonly why?: string }
  | { readonly kind: 'move'; readonly anchor: AnchorId; readonly rel: Rel; readonly to: AnchorId; readonly from: AnchorId | null }
  | { readonly kind: 'undo'; readonly op: string }
);

export type OpOf<K extends Op['kind']> = Extract<Op, { kind: K }>;

export const OP_LIMITS = { note: 240, reason: 400, value: 400, values: 64, why: 240, said: 240, title: 120 } as const;

/** An op, read whole or not at all. The log holds nothing it has not read. */
export function readOp(raw: unknown): Op | null {
  if (!guards.rec(raw)) return null;
  const id = guards.str(raw.id, 64, 1);
  const seq = guards.int(raw.seq, 0, 2 ** 40);
  const base = guards.int(raw.base, 0, 2 ** 40);
  const by = raw.by === 'you' ? ('you' as const) : raw.by === 'mind' ? ('mind' as const) : null;
  const turn = raw.turn === null ? null : guards.str(raw.turn, 64, 1);
  if (id === null || seq === null || base === null || by === null || (raw.turn !== null && turn === null)) return null;
  const head = { id, seq, by, turn, base };
  const ref = (value: unknown): AnchorId | null => (isAnchorId(value) ? value : null);
  const strings = (value: unknown, max: number, each: number): readonly string[] | null => {
    const list = guards.list(value, max);
    if (list === null) return null;
    const out: string[] = [];
    for (const item of list) {
      const s = guards.str(item, each);
      if (s === null) return null;
      out.push(s);
    }
    return out;
  };
  switch (raw.kind) {
    case 'anchor': {
      const name = ref(raw.name);
      const anchor = readAnchor(raw.anchor);
      const said = guards.str(raw.said, OP_LIMITS.said);
      return name === null || anchor === null || said === null ? null : { ...head, kind: 'anchor', name, anchor, said };
    }
    case 'mark': {
      const anchor = ref(raw.anchor);
      const style = MARK_STYLES.find((s) => s === raw.style);
      if (anchor === null || style === undefined) return null;
      const out: OpOf<'mark'> = { ...head, kind: 'mark', anchor, style };
      const extra: { -readonly [K in 'note' | 'colour' | 'strokes']?: OpOf<'mark'>[K] } = {};
      if (raw.note !== undefined) {
        const note = guards.str(raw.note, OP_LIMITS.note);
        if (note === null) return null;
        extra.note = note;
      }
      if (raw.colour !== undefined) {
        const colour = guards.str(raw.colour, 24, 1);
        if (colour === null) return null;
        extra.colour = colour;
      }
      if (raw.strokes !== undefined) {
        const strokes = strings(raw.strokes, 64, 64);
        if (strokes === null) return null;
        extra.strokes = strokes;
      }
      return { ...out, ...extra };
    }
    case 'link': {
      const a = ref(raw.a);
      const b = ref(raw.b);
      const reason = guards.str(raw.reason, OP_LIMITS.reason);
      if (a === null || b === null || a === b || reason === null) return null;
      if (raw.remove !== undefined && raw.remove !== true) return null;
      if (raw.remove !== true && reason === '') return null;
      return { ...head, kind: 'link', a, b, reason, ...(raw.remove === true && { remove: true }) };
    }
    case 'fill': {
      const anchor = ref(raw.anchor);
      const value = strings(raw.value, OP_LIMITS.values, OP_LIMITS.value);
      const was = strings(raw.was, OP_LIMITS.values, OP_LIMITS.value);
      return anchor === null || value === null || was === null ? null : { ...head, kind: 'fill', anchor, value, was };
    }
    case 'redact': {
      const anchor = ref(raw.anchor);
      const why = raw.why === undefined ? undefined : guards.str(raw.why, OP_LIMITS.why);
      return anchor === null || why === null ? null : { ...head, kind: 'redact', anchor, ...(why !== undefined && { why }) };
    }
    case 'move': {
      const anchor = ref(raw.anchor);
      const to = ref(raw.to);
      const from = raw.from === null ? null : ref(raw.from);
      const rel = RELS.find((r) => r === raw.rel);
      return anchor === null || to === null || rel === undefined || (raw.from !== null && from === null) ? null : { ...head, kind: 'move', anchor, rel, to, from };
    }
    case 'undo': {
      const op = guards.str(raw.op, 64, 1);
      return op === null ? null : { ...head, kind: 'undo', op };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// From an action to ops: the fold's half of the person's side
// ---------------------------------------------------------------------------------------------------------------------------------

/** Two anchors that point at the same piece (the context a writer happened to have does not make them different). */
export function sameAnchor(a: DocAnchor, b: DocAnchor): boolean {
  if (a.on !== b.on || a.sel.kind !== b.sel.kind) return false;
  if (a.sel.kind === 'text' && b.sel.kind === 'text') return a.sel.scope === b.sel.scope && a.sel.quote === b.sel.quote && a.sel.tail === b.sel.tail && (a.sel.start === b.sel.start || a.sel.start < 0 || b.sel.start < 0);
  return JSON.stringify(a.sel) === JSON.stringify(b.sel);
}

/** What an anchor is, in a few words: its `said` when nothing better is known. */
export function describeAnchor(anchor: DocAnchor): string {
  const sel: Selector = anchor.sel;
  switch (sel.kind) {
    case 'text':
      return sel.quote.length > OP_LIMITS.said ? sel.quote.slice(0, OP_LIMITS.said - 1) : sel.quote;
    case 'cells':
      return `${sel.sheet === '' ? '' : `${sel.sheet} `}${sel.range}`;
    case 'time':
      return sel.from === sel.to ? `at ${sel.from}s` : `${sel.from}s to ${sel.to}s`;
    case 'region':
      return `a region of page ${sel.page}`;
    case 'page':
      return `page ${sel.page}`;
    case 'node':
      return sel.path === '' ? anchor.on : sel.path;
    case 'part':
      return sel.path;
    case 'chart':
      return sel.to === undefined ? sel.x : `${sel.x} to ${sel.to}`;
  }
}

export interface FoldContext {
  /** the anchors already named (the person's and the mind's) */
  readonly pinned: readonly Pinned[];
  /** the number the next of the person's anchors takes: ^1 is 1 */
  readonly next: number;
  /** the log's next seq */
  readonly seq: number;
  readonly turn: string | null;
  readonly base: number;
}

const MARKING: Readonly<Partial<Record<Action['did'], MarkStyle>>> = { highlight: 'highlight', underline: 'underline', strike: 'strike', circle: 'box' };

/**
 * The ops one of the person's actions makes: each anchor it names (once, however many times) is numbered ^n, and a highlight, an underline, a
 * strike or a circle is a mark on each; a drag or a reorder is a `move`. Pure; the fold calls it and logs what it returns.
 */
export function opsOfAction(action: Action, ctx: FoldContext): { readonly ops: readonly Op[]; readonly next: number } {
  const ops: Op[] = [];
  let seq = ctx.seq;
  let next = ctx.next;
  const known = [...ctx.pinned];
  const head = (): Pick<Op, 'id' | 'seq' | 'by' | 'turn' | 'base'> => {
    const at = seq;
    seq += 1;
    return { id: `${ctx.turn ?? 'x'}:${at}`, seq: at, by: 'you', turn: ctx.turn, base: ctx.base };
  };
  const pin = (anchor: DocAnchor): AnchorId => {
    const have = known.find((p) => sameAnchor(p.anchor, anchor));
    if (have !== undefined) return have.id;
    let name = `^${next}`;
    while (known.some((p) => p.id === name)) {
      next += 1;
      name = `^${next}`;
    }
    next += 1;
    const op = { ...head(), kind: 'anchor' as const, name, anchor, said: describeAnchor(anchor) };
    ops.push(op);
    known.push({ id: name, anchor, by: 'you', seq: op.seq, said: op.said });
    return name;
  };
  const ids = action.anchors.map(pin);
  const style = MARKING[action.did];
  if (style !== undefined) {
    for (const anchor of ids) {
      ops.push({ ...head(), kind: 'mark', anchor, style, ...(action.colour !== undefined && { colour: action.colour }), ...(action.strokes !== undefined && { strokes: action.strokes }) });
    }
  }
  if ((action.did === 'drag' || action.did === 'reorder') && action.to !== undefined && action.rel !== undefined) {
    const to = pin(action.to);
    for (const anchor of ids) ops.push({ ...head(), kind: 'move', anchor, rel: action.rel, to, from: null });
  }
  return { ops, next };
}

/** What a v2.1 ink turn's `marks` says it was drawn on (`InkMarks.on` and `background`), read from the old shape. */
export interface MarksOnLike {
  readonly node?: string;
  readonly element?: string;
  readonly ask?: string;
  readonly source?: string;
  readonly page?: number;
}

/**
 * The anchors an old log's `marks` stand for, so it folds as it always did: an `ask` or an element is a `node` selector on its own object
 * (`<node>/<ask>`, `<node>/<element>`); a picture or a page is a `page` selector on its source. Marks on nothing give none.
 */
export function anchorsOfMarks(marks: { readonly on?: MarksOnLike; readonly background?: { readonly source?: string; readonly page?: number } | string } | undefined): readonly DocAnchor[] {
  if (marks === undefined) return [];
  const out: DocAnchor[] = [];
  const on = marks.on;
  const object = (...parts: (string | undefined)[]): string => parts.filter((p): p is string => p !== undefined && p !== '').join('/');
  if (on !== undefined) {
    const place = on.ask ?? on.element;
    const id = place === undefined ? on.node : object(on.node, place);
    if (id !== undefined && isObjectId(id)) out.push({ on: id, sel: { kind: 'node', path: '' } });
    if (on.source !== undefined && isObjectId(on.source)) out.push({ on: on.source, sel: { kind: 'page', page: on.page ?? 1 } });
  }
  const bg = marks.background;
  if (typeof bg === 'object' && bg.source !== undefined && isObjectId(bg.source)) {
    const anchor: DocAnchor = { on: bg.source, sel: { kind: 'page', page: bg.page ?? 1 } };
    if (!out.some((a) => sameAnchor(a, anchor))) out.push(anchor);
  }
  return out.slice(0, ANCHOR_LIMITS.perAction);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The layer (`DocLayer`; `Layer` is the stage's): what is on screen, one pure merge by log order
// ---------------------------------------------------------------------------------------------------------------------------------

export interface DocLayer {
  /** every anchor ever named and not undone, carried through the edits we made; a piece that is gone keeps its last place and is in `lost` */
  readonly anchors: readonly Pinned[];
  readonly marks: readonly OpOf<'mark'>[];
  readonly links: readonly OpOf<'link'>[];
  readonly fills: readonly OpOf<'fill'>[];
  readonly redactions: readonly OpOf<'redact'>[];
  readonly order: readonly OpOf<'move'>[];
  /** the ones that lost their place: kept with their words, listed, never drawn */
  readonly lost: readonly AnchorId[];
}

const pairKey = (a: AnchorId, b: AnchorId): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** The ops not undone, merged by `seq` (and by id, so a replay applies nothing twice). */
export function liveOps(...logs: readonly (readonly Op[])[]): readonly Op[] {
  const seen = new Set<string>();
  const merged: Op[] = [];
  for (const log of logs) {
    for (const op of log) {
      if (seen.has(op.id)) continue;
      seen.add(op.id);
      merged.push(op);
    }
  }
  merged.sort((a, b) => a.seq - b.seq);
  // From the last: an undo that is itself undone does nothing.
  const undone = new Set<string>();
  for (let i = merged.length - 1; i >= 0; i -= 1) {
    const op = merged[i];
    if (op?.kind === 'undo' && !undone.has(op.id)) undone.add(op.op);
  }
  return merged.filter((op) => op.kind !== 'undo' && !undone.has(op.id));
}

/**
 * The anchors, marks, links, fills, redactions, order and orphans the ops not undone leave. `structureOf` names a source's structure, when it
 * is known; with it a piece whose words are no longer found goes to `lost`, and a piece found elsewhere is carried there.
 */
export function layerOf(doc: { readonly ops: readonly Op[] }, state: { readonly ops: readonly Op[] }, structureOf?: (on: string) => Structure | undefined): DocLayer {
  const pins = new Map<AnchorId, Pinned>();
  const lost = new Set<AnchorId>();
  let marks: OpOf<'mark'>[] = [];
  const links = new Map<string, OpOf<'link'>>();
  const fills = new Map<AnchorId, OpOf<'fill'>>();
  const redactions = new Map<AnchorId, OpOf<'redact'>>();
  const order: OpOf<'move'>[] = [];
  for (const op of liveOps(doc.ops, state.ops)) {
    switch (op.kind) {
      case 'anchor':
        pins.set(op.name, { id: op.name, anchor: op.anchor, by: op.by, seq: op.seq, said: op.said });
        lost.delete(op.name);
        break;
      case 'mark':
        if (op.style === 'none') marks = marks.filter((m) => !(m.anchor === op.anchor && m.by === op.by));
        else marks.push(op);
        break;
      case 'link': {
        const key = pairKey(op.a, op.b);
        if (op.remove === true) links.delete(key);
        else links.set(key, op);
        break;
      }
      case 'redact':
        redactions.set(op.anchor, op);
        break;
      case 'fill':
      case 'move': {
        if (op.kind === 'fill') fills.set(op.anchor, op);
        else order.push(op);
        // an edit we made: every anchor named before it is carried through it, by rule, from the places they held just before it
        const before = new Map([...pins].map(([id, pin]) => [id, pin.anchor] as const));
        const at = (id: string): DocAnchor | undefined => before.get(id);
        for (const [id, pin] of pins) {
          if (lost.has(id) || pin.seq > op.seq) continue;
          const carried = rebase(pin.anchor, op, at);
          if (carried === null) lost.add(id);
          else if (carried !== pin.anchor) pins.set(id, { ...pin, anchor: carried });
        }
        break;
      }
      case 'undo':
        break;
    }
  }
  if (structureOf !== undefined) {
    for (const [id, pin] of pins) {
      const structure = lost.has(id) ? undefined : structureOf(pin.anchor.on);
      if (structure === undefined) continue;
      const found = resolve(pin.anchor, structure);
      if (found.state === 'orphan') lost.add(id);
      else if (found.state === 'moved') pins.set(id, { ...pin, anchor: { on: pin.anchor.on, sel: found.sel } });
    }
  }
  return {
    anchors: [...pins.values()].sort((a, b) => a.seq - b.seq),
    marks,
    links: [...links.values()],
    fills: [...fills.values()],
    redactions: [...redactions.values()],
    order,
    lost: [...lost],
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The lines: `anchor`, `mark`, `fill`, `redact`, `doc`, and `link` and `move` with `^` operands
// ---------------------------------------------------------------------------------------------------------------------------------

export const ANNOTATE_VERB = {
  anchor: {
    form: 'anchor ^<name> on=<object> [page=N | sheet=S cells=B2:D9 | t=12.5..31 | box=x,y,w,h | node=<path> | part=<screen/part> | x=<x> [to=<x>] [series=<s>] [y=N]] [| <the exact words>]',
    gist: 'Names a piece of a document (`^terms`) so later lines can act on it. Quote the exact words, and enough of them to be the only place they occur; a quote that is not found is refused.',
  },
  mark: {
    form: 'mark ^<name> [highlight|underline|box|strike|note|none] [| <note>]',
    gist: 'Highlights or annotates a piece you named, in your own ink. `none` clears your marks there.',
  },
  link: {
    form: 'link ^<a> ^<b> | <reason>  or  link ^<a> ^<b> none',
    gist: 'Joins two named pieces and says why. A link with no reason is refused; `none` removes it.',
  },
  fill: {
    form: 'fill ^<name> | <value> [| <value>…]',
    gist: 'Writes into a cell range (across, then down), a form field or a blank. The person can undo it.',
  },
  redact: {
    form: 'redact ^<name> [| <why>]',
    gist: 'Covers a piece and removes it from every export.',
  },
  move: {
    form: 'move ^<name> before=^<other>|after=^<other>|into=^<other>',
    gist: 'Reorders pages, rows or nodes of one document.',
  },
  doc: {
    form: 'doc <id> from=<source> [in=<part>] [pages=a..b] [| <title>]',
    gist: 'Opens a real document given as a source (a PDF, a photo) as a node of the document.',
  },
} as const satisfies Record<string, { form: string; gist: string }>;

export type AnnotateVerb = 'anchor' | 'mark' | 'fill' | 'redact' | 'doc';
export const ANNOTATE_VERBS: readonly AnnotateVerb[] = ['anchor', 'mark', 'fill', 'redact', 'doc'];

export function isAnnotateVerb(verb: string): verb is AnnotateVerb {
  return (ANNOTATE_VERBS as readonly string[]).includes(verb);
}

/** `link` and `move` mean this when an operand is a `^name`; `move x1 …` and `link a b` mean what they always did. */
export function isAnchorOperand(words: readonly string[], pairs: readonly { readonly value: string }[]): boolean {
  return words.some((w) => w.startsWith('^')) || pairs.some((p) => p.value.startsWith('^'));
}

export interface AnchorLine {
  readonly verb: 'anchor';
  readonly id: AnchorId;
  readonly anchor: DocAnchor;
  /** what a non-text piece is, in the mind's words (a text piece's words are its quote) */
  readonly said?: string;
}
export interface MarkLine {
  readonly verb: 'mark';
  readonly anchor: AnchorId;
  readonly style: MarkStyle;
  readonly note?: string;
}
/** `link ^a ^b | reason`. Its `verb` is `tie` so that `link a b` between nodes stays what it was; it is written `link`. */
export interface TieLine {
  readonly verb: 'tie';
  readonly a: AnchorId;
  readonly b: AnchorId;
  readonly reason?: string;
  readonly remove?: boolean;
}
export interface FillLine {
  readonly verb: 'fill';
  readonly anchor: AnchorId;
  readonly value: readonly string[];
}
export interface RedactLine {
  readonly verb: 'redact';
  readonly anchor: AnchorId;
  readonly why?: string;
}
/** `move ^a before=^b`. Its `verb` is `shift`, as `link` is `tie`; it is written `move`. */
export interface ShiftLine {
  readonly verb: 'shift';
  readonly anchor: AnchorId;
  readonly rel: Rel;
  readonly to: AnchorId;
}
export interface DocLine {
  readonly verb: 'doc';
  readonly id: string;
  readonly from: string;
  readonly in?: string;
  readonly pages?: readonly [number, number];
  readonly title?: string;
}

export type AnnotateLine = AnchorLine | MarkLine | TieLine | FillLine | RedactLine | ShiftLine | DocLine;

export function isAnnotateLine(line: { readonly verb: string }): line is AnnotateLine {
  return line.verb === 'tie' || line.verb === 'shift' || isAnnotateVerb(line.verb);
}

/** What `readHead` gives: words, `key=value` pairs (the key and value lowercased, the value as written in `raw`), and a time. */
export interface AnnotateHead {
  readonly words: readonly string[];
  readonly pairs: readonly { readonly key: string; readonly value: string; readonly raw: string; readonly token: string }[];
  readonly when?: unknown;
}

export type AnnotateRead = { readonly line: AnnotateLine | null; readonly issues: readonly Issue[] };

const NAME = /^[a-z][a-z0-9_-]{0,31}$/;

const clip = (text: string | null, max: number, issues: Issue[]): string | null => {
  if (text === null) return null;
  const t = text.trim().replace(/\s+/g, ' ');
  if (t === '') return null;
  if (t.length <= max) return t;
  issues.push({ code: 'text-too-long', severity: 'warn', message: `text cut to ${max} characters; say less per line` });
  return `${t.slice(0, max - 1)}…`;
};

/**
 * One line of the anchor words, from the head `readHead` gave and the text after the first bar. `verb` is `anchor`, `mark`, `fill`, `redact`,
 * `doc`, or `link` / `move` when an operand is a `^name`. Errors drop the line; a warn keeps it.
 */
export function readAnnotate(verb: string, head: AnnotateHead, rawText: string | null): AnnotateRead {
  const issues: Issue[] = [];
  const fail = (code: Issue['code'], message: string, token?: string): AnnotateRead => ({ line: null, issues: [...issues, token === undefined ? { code, severity: 'error', message } : { code, severity: 'error', message, token }] });
  const warn = (code: Issue['code'], message: string, token: string): void => {
    issues.push({ code, severity: 'warn', message, token });
  };
  if (head.when !== undefined) issues.push({ code: 'bad-time', severity: 'warn', message: `${verb} takes no time; ignored` });
  const done = (line: AnnotateLine): AnnotateRead => ({ line, issues });
  const refs = head.words.filter((w) => w.startsWith('^'));
  const bad = refs.find((r) => !isAnchorId(r));
  if (bad !== undefined) return fail('bad-id', `"${bad}" is not an anchor name; use ^1 or ^name`, bad);

  switch (verb) {
    case 'anchor': {
      const name = head.words[0];
      if (name === undefined || !isAnchorId(name)) return fail('missing-id', 'anchor needs a name: anchor ^terms on=u3 page=2 | the exact words');
      if (isNumberedAnchorId(name)) return fail('bad-id', `${name} is a number the page gives; name your own: ^terms`, name);
      for (const w of head.words.slice(1)) warn('unknown-word', `"${w}" means nothing in an anchor; ignored`, w);
      const read = anchorFromPairs(head.pairs.map((p): PairWord => ({ key: p.key, raw: p.raw })), rawText);
      if ('problem' in read) return fail('bad-value', read.problem);
      for (const p of read.unused) warn('unknown-key', `"${p.key}" is not part of an anchor; ignored`, `${p.key}=${p.raw}`);
      const said = read.anchor.sel.kind === 'text' ? null : clip(rawText, OP_LIMITS.said, issues);
      return done({ verb: 'anchor', id: name, anchor: read.anchor, ...(said !== null && { said }) });
    }
    case 'mark': {
      const name = head.words[0];
      if (name === undefined || !isAnchorId(name)) return fail('missing-id', 'mark needs an anchor: mark ^terms highlight');
      let style: MarkStyle | null = null;
      for (const w of head.words.slice(1)) {
        const found = MARK_STYLES.find((s) => s === w);
        if (found !== undefined && style === null) style = found;
        else warn('unknown-word', `"${w}" means nothing in a mark; ignored`, w);
      }
      for (const p of head.pairs) warn('unknown-key', `"${p.key}" is not part of a mark; ignored`, p.token);
      const note = clip(rawText, OP_LIMITS.note, issues);
      if (style === 'none' && note !== null) warn('unexpected-text', 'a mark of none takes no note; ignored', 'none');
      return done({ verb: 'mark', anchor: name, style: style ?? (note === null ? 'highlight' : 'note'), ...(note !== null && style !== 'none' && { note }) });
    }
    case 'link': {
      if (refs.length !== 2) return fail('missing-argument', 'a link between anchors joins exactly two: link ^a ^b | why');
      const [a, b] = refs;
      if (a === undefined || b === undefined || a === b) return fail('bad-value', 'a link joins two different anchors');
      for (const p of head.pairs) warn('unknown-key', `"${p.key}" is not part of a link; ignored`, p.token);
      const rest = head.words.filter((w) => !w.startsWith('^'));
      const remove = rest.includes('none');
      for (const w of rest) if (w !== 'none') warn('unknown-word', `"${w}" means nothing in a link; ignored`, w);
      const reason = clip(rawText, OP_LIMITS.reason, issues);
      if (remove) return done({ verb: 'tie', a, b, remove: true });
      if (reason === null) return fail('missing-text', 'a link between anchors needs its reason: link ^a ^b | why they belong together');
      return done({ verb: 'tie', a, b, reason });
    }
    case 'fill': {
      const name = head.words[0];
      if (name === undefined || !isAnchorId(name)) return fail('missing-id', 'fill needs an anchor: fill ^c1 | 14 | 15');
      for (const w of head.words.slice(1)) warn('unknown-word', `"${w}" means nothing in a fill; ignored`, w);
      for (const p of head.pairs) warn('unknown-key', `"${p.key}" is not part of a fill; ignored`, p.token);
      const value = (rawText ?? '')
        .split('|')
        .map((v) => v.trim())
        .slice(0, OP_LIMITS.values)
        .map((v) => (v.length > OP_LIMITS.value ? v.slice(0, OP_LIMITS.value) : v));
      if (rawText === null || rawText.trim() === '') return fail('missing-text', 'fill needs a value after the bar: fill ^c1 | 14');
      return done({ verb: 'fill', anchor: name, value });
    }
    case 'redact': {
      const name = head.words[0];
      if (name === undefined || !isAnchorId(name)) return fail('missing-id', 'redact needs an anchor: redact ^name | why');
      for (const w of head.words.slice(1)) warn('unknown-word', `"${w}" means nothing in a redact; ignored`, w);
      for (const p of head.pairs) warn('unknown-key', `"${p.key}" is not part of a redact; ignored`, p.token);
      const why = clip(rawText, OP_LIMITS.why, issues);
      return done({ verb: 'redact', anchor: name, ...(why !== null && { why }) });
    }
    case 'move': {
      const name = head.words[0];
      if (name === undefined || !isAnchorId(name)) return fail('missing-id', 'move needs an anchor: move ^a before=^b');
      for (const w of head.words.slice(1)) warn('unknown-word', `"${w}" means nothing in a move; ignored`, w);
      let rel: Rel | null = null;
      let to: AnchorId | null = null;
      for (const p of head.pairs) {
        const found = RELS.find((r) => r === p.key);
        if (found !== undefined && isAnchorId(p.value) && rel === null) {
          rel = found;
          to = p.value;
        } else warn('unknown-key', `${p.token} ignored; move takes before=^b, after=^b or into=^b`, p.token);
      }
      if (rel === null || to === null) return fail('missing-argument', 'move needs somewhere to go: move ^a before=^b');
      if (to === name) return fail('bad-value', 'a piece cannot move relative to itself');
      return done({ verb: 'shift', anchor: name, rel, to });
    }
    case 'doc': {
      const id = head.words[0];
      if (id === undefined || !NAME.test(id)) return fail('missing-id', 'doc needs an id: doc terms from=u3 | The agreement');
      for (const w of head.words.slice(1)) warn('unknown-word', `"${w}" means nothing in a doc; ignored`, w);
      let from: string | null = null;
      let inPart: string | undefined;
      let pages: readonly [number, number] | undefined;
      for (const p of head.pairs) {
        if (p.key === 'from' && isObjectId(p.raw) && from === null) from = p.raw;
        else if (p.key === 'in' && NAME.test(p.value)) inPart = p.value;
        else if (p.key === 'pages') {
          const m = /^(\d+)(?:\.\.(\d+))?$/.exec(p.value);
          const lo = m?.[1] === undefined ? 0 : Number(m[1]);
          const hi = m?.[2] === undefined ? lo : Number(m[2]);
          if (m === null || lo < 1 || hi < lo || hi > 100_000) warn('bad-value', `${p.token} ignored; pages is a span like 3..5`, p.token);
          else pages = [lo, hi];
        } else warn('unknown-key', `"${p.key}" is not part of a doc; ignored`, p.token);
      }
      if (from === null) return fail('missing-argument', 'doc needs its source: doc terms from=u3');
      const title = clip(rawText, OP_LIMITS.title, issues);
      return done({ verb: 'doc', id, from, ...(inPart !== undefined && { in: inPart }), ...(pages !== undefined && { pages }), ...(title !== null && { title }) });
    }
    default:
      return fail('unknown-verb', `"${verb}" is not an anchor word`, verb);
  }
}

/** One line in its one written form. `readAnnotate(serializeAnnotate(line))` is the same line. */
export function serializeAnnotate(line: AnnotateLine): string {
  switch (line.verb) {
    case 'anchor': {
      const quote = anchorQuote(line.anchor);
      const words = quote ?? line.said ?? null;
      return `${['anchor', line.id, ...anchorTokens(line.anchor)].join(' ')}${words === null ? '' : ` | ${words}`}`;
    }
    case 'mark':
      return `mark ${line.anchor} ${line.style}${line.note === undefined ? '' : ` | ${line.note}`}`;
    case 'tie':
      return line.remove === true ? `link ${line.a} ${line.b} none` : `link ${line.a} ${line.b} | ${line.reason ?? ''}`;
    case 'fill':
      return `fill ${line.anchor} | ${line.value.join(' | ')}`;
    case 'redact':
      return `redact ${line.anchor}${line.why === undefined ? '' : ` | ${line.why}`}`;
    case 'shift':
      return `move ${line.anchor} ${line.rel}=${line.to}`;
    case 'doc': {
      const head = ['doc', line.id, `from=${line.from}`];
      if (line.in !== undefined) head.push(`in=${line.in}`);
      if (line.pages !== undefined) head.push(`pages=${line.pages[0] === line.pages[1] ? line.pages[0] : `${line.pages[0]}..${line.pages[1]}`}`);
      return `${head.join(' ')}${line.title === undefined ? '' : ` | ${line.title}`}`;
    }
  }
}

/**
 * The op a mind's line makes in the log. The server puts on the id (`turn:seq`), the seq and `base`; it knows the words an anchor is (`said`) and,
 * for `fill`, what was there (`was`) and, for `move`, where the piece was (`from`). A `doc` line is a node of the document, not an op.
 */
export function opOfLine(
  line: AnnotateLine,
  at: Pick<Op, 'id' | 'seq' | 'turn' | 'base'>,
  known: { readonly said?: string; readonly was?: readonly string[]; readonly from?: AnchorId | null } = {},
): Op | null {
  const head = { ...at, by: 'mind' as const };
  switch (line.verb) {
    case 'anchor':
      return { ...head, kind: 'anchor', name: line.id, anchor: line.anchor, said: line.said ?? known.said ?? describeAnchor(line.anchor) };
    case 'mark':
      return { ...head, kind: 'mark', anchor: line.anchor, style: line.style, ...(line.note !== undefined && { note: line.note }) };
    case 'tie':
      return { ...head, kind: 'link', a: line.a, b: line.b, reason: line.reason ?? '', ...(line.remove === true && { remove: true }) };
    case 'fill':
      return { ...head, kind: 'fill', anchor: line.anchor, value: line.value, was: known.was ?? [] };
    case 'redact':
      return { ...head, kind: 'redact', anchor: line.anchor, ...(line.why !== undefined && { why: line.why }) };
    case 'shift':
      return { ...head, kind: 'move', anchor: line.anchor, rel: line.rel, to: line.to, from: known.from ?? null };
    case 'doc':
      return null;
  }
}
