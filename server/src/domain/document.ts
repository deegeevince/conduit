// The document on the server (PLAN-v3-core 2.1, 2.11, WS4).
//
// A conversation's document is a FOLD over its session log, and nothing else: `DocumentFold.apply` takes one record at a time, in
// order, and is the only thing that ever builds a document. The conductor feeds it the very record it has just written to the log;
// a restart feeds it the same records read back from the file. So a logged session folded twice gives the same document, and a
// document that is live and one that was folded from its log cannot differ (the check of WS4).
//
// What it reads, from the log:
//   `line`   a document line (`part`, `step`, `ask`, `hint`, `reply`: 2.10) read from the line's own text, so it holds whether the
//            parser knew the verb or not, and the same on every restart
//   `end`    a turn ended: what it was filling is filled (reason `done`) or is left as it was
//   `node`   a node's status was set from outside the turn (verified, refused, reset): WS5
//   `state`  something the person did, committed in the page: the one writer of `DocState` is `applyChange`
//   `session` an epoch begins; the one that opens a document again says `resumes`
//
// Nothing here reads a file, a clock or the network. Nothing here names or describes the learner.

import type {
  DocNode,
  DocState,
  Document,
  DocumentSummary,
  DocumentView,
  Held,
  LessonStep,
  NodeId,
  NodeProgress,
  NodeStatus,
  OutlineItem,
  StateChange,
} from '@conduit/language';
import { STATE_LIMITS } from '@conduit/language';
import type { SessionEntry } from './session-log';

/** What one document may hold: a model that goes on writing is bounded here, not trusted. */
export const DOCUMENT_BOUNDS = { nodes: 2_000, stepsPerNode: 60, hintsPerAsk: 8, title: 300, words: 2_000, show: 400, answers: 20, answerChars: 80 } as const;

// ---------------------------------------------------------------- reading a document line

/** GUESS: the grammar of 2.10, read from a line's text. A bare word is an id; `key=value` is an option; `|` begins the words. */
export type DocLine =
  | { readonly verb: 'part'; readonly id: string; readonly in: string | null; readonly tag: string | null; readonly title: string }
  | { readonly verb: 'step'; readonly id: string | null; readonly in: string | null; readonly show: string | null; readonly words: string }
  | { readonly verb: 'ask'; readonly id: string; readonly in: string | null; readonly accepted: readonly string[]; readonly pick: readonly string[] | null; readonly unit: string | null; readonly prompt: string }
  | { readonly verb: 'hint'; readonly in: string; readonly words: string }
  | { readonly verb: 'reply'; readonly words: string };

const ID = /^[A-Za-z][A-Za-z0-9_.-]{0,40}$/;
const FIRST_WORD = /^(part|step|ask|hint|reply)(?=[\s|]|$)/;

function listOf(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .slice(0, DOCUMENT_BOUNDS.answers)
    .map((part) => part.slice(0, DOCUMENT_BOUNDS.answerChars));
}

/**
 * The document line this text is, or null when it is anything else. Strict on purpose: a sentence that happens to begin with one of
 * these words ("part of the answer | …") is not a line, because the words after it are not options.
 */
export function readDocLine(text: string): DocLine | null {
  const trimmed = text.trim();
  if (!FIRST_WORD.test(trimmed)) return null;
  const bar = trimmed.indexOf('|');
  const head = (bar < 0 ? trimmed : trimmed.slice(0, bar)).trim();
  const words = (bar < 0 ? '' : trimmed.slice(bar + 1).trim()).slice(0, DOCUMENT_BOUNDS.words);
  const tokens = head.split(/\s+/).filter((token) => token !== '');
  const verb = tokens.shift();
  const options = new Map<string, string>();
  let bare: string | null = null;
  let show: string | null = null;
  for (const token of tokens) {
    const eq = token.indexOf('=');
    if (show !== null) {
      // everything after `show=` is the visual and its own options, kept whole
      show += ` ${token}`;
      continue;
    }
    if (eq > 0) {
      const key = token.slice(0, eq);
      const value = token.slice(eq + 1);
      if (key === 'show' && verb === 'step') show = value;
      else options.set(key, value);
      continue;
    }
    if (bare !== null) return null;
    bare = token;
  }
  const into = options.get('in') ?? null;
  if (into !== null && !ID.test(into)) return null;
  if (bare !== null && !ID.test(bare)) return null;
  switch (verb) {
    case 'part':
      if (bare === null) return null;
      return { verb, id: bare, in: into, tag: options.get('tag') ?? null, title: (words === '' ? bare : words).slice(0, DOCUMENT_BOUNDS.title) };
    case 'step':
      return { verb, id: bare, in: into, show: show === null ? null : show.slice(0, DOCUMENT_BOUNDS.show), words };
    case 'ask': {
      const is = options.get('is');
      if (bare === null || is === undefined) return null;
      const accepted = listOf(is);
      if (accepted.length === 0) return null;
      const pick = options.get('pick');
      return { verb, id: bare, in: into, accepted, pick: pick === undefined ? null : listOf(pick), unit: options.get('unit') ?? null, prompt: words };
    }
    case 'hint':
      if (bare !== null || into === null || words === '') return null;
      return { verb, in: into, words };
    case 'reply':
      if (bare !== null || options.size > 0 || show !== null) return null;
      return { verb, words };
    default:
      return null;
  }
}

// ---------------------------------------------------------------- the one writer of state

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function playOk(play: unknown): boolean {
  if (typeof play === 'number') return Number.isFinite(play) && play >= 0;
  if (typeof play !== 'object' || play === null) return false;
  const at = (play as { at?: unknown }).at;
  return typeof at === 'number' && Number.isInteger(at) && at >= 0;
}

export function initialState(root: NodeId | null): DocState {
  return { cursor: { node: root ?? '', play: 0 }, held: {}, progress: {} };
}

const NO_PROGRESS: NodeProgress = { seen: 0, tries: {}, done: false };

/**
 * The one writer of what the person did (2.1: `advance`, for the changes that are committed and logged). Returns the new state, or
 * null when the change is for a node that is not there, is malformed, or changes nothing: such a change is not logged.
 */
export function applyChange(doc: { readonly has: (node: NodeId) => boolean; readonly askIn: (node: NodeId, ask: string) => boolean }, state: DocState, change: StateChange): DocState | null {
  switch (change.kind) {
    case 'cursor': {
      const { cursor } = change;
      if (!doc.has(cursor.node) || !playOk(cursor.play) || sameValue(cursor, state.cursor)) return null;
      return { ...state, cursor };
    }
    case 'held': {
      if (!doc.has(change.node) || change.key === '' || change.key.length > STATE_LIMITS.key || JSON.stringify(change.value ?? null).length > STATE_LIMITS.heldBytes) return null;
      const there = state.held[change.node] ?? {};
      if (sameValue(there[change.key], change.value)) return null;
      return { ...state, held: { ...state.held, [change.node]: { ...there, [change.key]: change.value } } };
    }
    case 'try': {
      if (!doc.askIn(change.node, change.ask)) return null;
      const progress = state.progress[change.node] ?? NO_PROGRESS;
      const before = progress.tries[change.ask] ?? [];
      if (before.length >= STATE_LIMITS.triesPerAsk) return null;
      const tries = { ...progress.tries, [change.ask]: [...before, change.value.slice(0, STATE_LIMITS.tryChars)] };
      return { ...state, progress: { ...state.progress, [change.node]: { ...progress, tries } } };
    }
    case 'seen': {
      const progress = state.progress[change.node] ?? NO_PROGRESS;
      const seen = Math.min(Math.max(0, Math.round(change.seen)), DOCUMENT_BOUNDS.stepsPerNode);
      if (!doc.has(change.node) || !Number.isFinite(change.seen) || seen <= progress.seen) return null;
      return { ...state, progress: { ...state.progress, [change.node]: { ...progress, seen } } };
    }
    case 'done': {
      const progress = state.progress[change.node] ?? NO_PROGRESS;
      if (!doc.has(change.node) || progress.done === change.done) return null;
      return { ...state, progress: { ...state.progress, [change.node]: { ...progress, done: change.done } } };
    }
    case 'sync': {
      const { cursor, held } = change.seen;
      let next = state;
      if (doc.has(cursor.node) && playOk(cursor.play) && !sameValue(cursor, state.cursor)) next = { ...next, cursor };
      const merged: Record<NodeId, Readonly<Record<string, Held>>> = { ...next.held };
      let moved = false;
      for (const [node, values] of Object.entries(held)) {
        if (!doc.has(node) || JSON.stringify(values).length > STATE_LIMITS.heldBytes || sameValue(values, merged[node])) continue;
        merged[node] = values;
        moved = true;
      }
      if (moved) next = { ...next, held: merged };
      return next === state ? null : next;
    }
  }
}

// ---------------------------------------------------------------- the fold

/** What one record did to the document. `nodes` are whole nodes, each once: the ones that changed and any parent whose children did. */
export interface FoldResult {
  readonly nodes: readonly DocNode[];
  readonly state: boolean;
  /** false: a `state` or `node` record that changed nothing, which must not be logged */
  readonly applied: boolean;
}

const NOTHING: FoldResult = { nodes: [], state: false, applied: false };

export class DocumentFold {
  readonly id: string;
  private readonly nodes = new Map<NodeId, DocNode>();
  private root: NodeId | null = null;
  private title = '';
  private created: string | null = null;
  /** the brain's own id of a part to the node it became */
  private readonly local = new Map<string, NodeId>();
  /** the id of an `ask` to the node it is in */
  private readonly askOwner = new Map<string, NodeId>();
  /** by turn: nodes that something landed in, and so are being filled until it ends */
  private readonly touched = new Map<string, Set<NodeId>>();
  private lastLeaf: NodeId | null = null;
  private current: DocState = initialState(null);
  /** a monotone count of what was applied, for the caller to see whether anything moved */
  private revision = 0;

  constructor(id: string) {
    this.id = id;
  }

  /** Whether any part has ever been named: a conversation without one is not a document. */
  isDocument(): boolean {
    return this.root !== null;
  }

  version(): number {
    return this.revision;
  }

  state(): DocState {
    return this.current;
  }

  node(id: NodeId): DocNode | undefined {
    return this.nodes.get(id);
  }

  /** The title and root, without building the whole document: what a `doc` event carries beside its nodes. */
  heading(): { readonly title: string; readonly root: NodeId } {
    return { title: this.title, root: this.root ?? '' };
  }

  document(): Document {
    return { id: this.id, title: this.title, root: this.root ?? '', nodes: Object.fromEntries(this.nodes), defs: {} };
  }

  /** The node this line text would land in, or null when it is not a document line or has no home. Reads, never writes. */
  place(text: string): NodeId | null {
    const line = readDocLine(text);
    if (line === null) return null;
    switch (line.verb) {
      case 'part':
        return this.local.get(line.id) ?? this.idForNew(line.id, this.parentOf(line.in));
      case 'step':
      case 'ask':
        return this.target(line.in);
      case 'hint':
        return this.askOwner.get(line.in) ?? null;
      case 'reply':
        return null;
    }
  }

  apply(entry: SessionEntry): FoldResult {
    switch (entry.type) {
      case 'session':
        // An epoch: the server was started again, or the document was opened in a new session. What was being filled has no turn now.
        this.touched.clear();
        if (this.created === null) this.created = entry.started;
        return NOTHING;
      case 'line':
        return this.line(entry.turn, entry.text);
      case 'end':
        return this.end(entry.turn, entry.reason === 'done');
      case 'node':
        return this.setStatus(entry.node, entry.status, entry.reset === true);
      case 'state': {
        const next = applyChange({ has: (node) => this.nodes.has(node), askIn: (node, ask) => this.askOwner.get(ask) === node }, this.current, entry.change);
        if (next === null) return NOTHING;
        this.current = next;
        this.revision += 1;
        return { nodes: [], state: true, applied: true };
      }
      default:
        return NOTHING;
    }
  }

  // ---- lines

  private parentOf(into: string | null): NodeId | null {
    return (into !== null ? this.local.get(into) : undefined) ?? this.root;
  }

  private idForNew(id: string, parent: NodeId | null): NodeId {
    return parent === null ? id : `${parent}/${id}`;
  }

  /** Where a step or an ask lands: the part it says (`in=`), else the part last written into. */
  private target(into: string | null): NodeId | null {
    const named = into === null ? undefined : this.local.get(into);
    return named ?? (into === null ? this.lastLeaf : null);
  }

  private line(turn: string, text: string): FoldResult {
    const line = readDocLine(text);
    if (line === null) return NOTHING;
    const changed = new Map<NodeId, DocNode>();
    const put = (node: DocNode): void => {
      this.nodes.set(node.id, node);
      changed.set(node.id, node);
    };
    switch (line.verb) {
      case 'part':
        this.part(turn, line, put);
        break;
      case 'step':
      case 'ask':
        this.lesson(turn, line, put);
        break;
      case 'hint':
        this.hint(turn, line, put);
        break;
      case 'reply':
        return { ...NOTHING, applied: true };
    }
    if (changed.size === 0) return { ...NOTHING, applied: true };
    this.revision += 1;
    return { nodes: [...changed.values()].map((node) => this.nodes.get(node.id) ?? node), state: false, applied: true };
  }

  private part(turn: string, line: Extract<DocLine, { verb: 'part' }>, put: (node: DocNode) => void): void {
    const known = this.local.get(line.id);
    if (known !== undefined) {
      // Said again: the title and the technique may be corrected ("question 7 says 25, not 28"); nothing else moves.
      const node = this.nodes.get(known);
      if (node === undefined) return;
      if (known === this.root) this.title = line.title;
      const tag = line.tag ?? node.tag;
      if (node.title !== line.title || node.tag !== tag) put({ ...node, title: line.title, tag });
      this.lastLeaf = known;
      return;
    }
    if (this.nodes.size >= DOCUMENT_BOUNDS.nodes) return;
    const parent = this.parentOf(line.in);
    const id = this.idForNew(line.id, parent);
    if (this.nodes.has(id)) return;
    put({ id, parent, title: line.title, tag: line.tag, children: [], body: null, status: 'outlined' });
    this.local.set(line.id, id);
    if (parent === null) {
      this.root = id;
      this.title = line.title;
      this.current = { ...this.current, cursor: { node: id, play: 0 } };
    } else {
      const holder = this.nodes.get(parent);
      if (holder !== undefined) put({ ...holder, children: [...holder.children, id] });
      this.touch(turn, parent, put);
    }
    this.lastLeaf = id;
  }

  private lesson(turn: string, line: Extract<DocLine, { verb: 'step' | 'ask' }>, put: (node: DocNode) => void): void {
    const id = this.target(line.in);
    const node = id === null ? undefined : this.nodes.get(id);
    if (id === null || node === undefined) return;
    if (node.body !== null && node.body.kind !== 'lesson') return;
    const steps = node.body === null ? [] : node.body.steps;
    let next: readonly LessonStep[];
    if (line.verb === 'step') {
      if (steps.length >= DOCUMENT_BOUNDS.stepsPerNode) return;
      const made: LessonStep = { kind: 'step', id: line.id ?? `step${steps.length + 1}`, show: line.show, words: line.words };
      next = [...steps, made];
    } else {
      const made: LessonStep = { kind: 'ask', id: line.id, accepted: line.accepted, pick: line.pick, unit: line.unit, prompt: line.prompt, hints: [] };
      // An `ask` said again is the same ask with its words and answers corrected; the hints it had stay.
      const at = steps.findIndex((step) => step.kind === 'ask' && step.id === line.id);
      if (at >= 0) {
        const old = steps[at];
        next = steps.map((step, index) => (index === at ? { ...made, hints: old?.kind === 'ask' ? old.hints : [] } : step));
      } else {
        if (steps.length >= DOCUMENT_BOUNDS.stepsPerNode || this.askOwner.has(line.id)) return;
        next = [...steps, made];
      }
      this.askOwner.set(line.id, id);
    }
    put({ ...node, body: { kind: 'lesson', steps: next } });
    this.touch(turn, id, put);
    this.lastLeaf = id;
  }

  private hint(turn: string, line: Extract<DocLine, { verb: 'hint' }>, put: (node: DocNode) => void): void {
    const id = this.askOwner.get(line.in);
    const node = id === undefined ? undefined : this.nodes.get(id);
    if (id === undefined || node === undefined || node.body === null || node.body.kind !== 'lesson') return;
    const steps = node.body.steps.map((step) => (step.kind === 'ask' && step.id === line.in && step.hints.length < DOCUMENT_BOUNDS.hintsPerAsk ? { ...step, hints: [...step.hints, line.words] } : step));
    put({ ...node, body: { kind: 'lesson', steps } });
    this.touch(turn, id, put);
  }

  /** Something landed in a node: it is being filled until the turn ends. A node already `verified` or `refused` keeps what the verifier said. */
  private touch(turn: string, id: NodeId, put: (node: DocNode) => void): void {
    let set = this.touched.get(turn);
    if (set === undefined) {
      set = new Set();
      this.touched.set(turn, set);
    }
    set.add(id);
    const node = this.nodes.get(id);
    if (node !== undefined && (node.status === 'outlined' || node.status === 'filled')) put({ ...node, status: 'filling' });
  }

  private end(turn: string, done: boolean): FoldResult {
    const set = this.touched.get(turn);
    this.touched.delete(turn);
    if (set === undefined || !done) return { ...NOTHING, applied: true };
    const changed: DocNode[] = [];
    for (const id of set) {
      const node = this.nodes.get(id);
      if (node === undefined || node.status !== 'filling') continue;
      const next: DocNode = { ...node, status: 'filled' };
      this.nodes.set(id, next);
      changed.push(next);
    }
    if (changed.length > 0) this.revision += 1;
    return { nodes: changed, state: false, applied: true };
  }

  /** WS5's: the verifier's word (`verified`, `refused`), or a node sent back to be written again (`reset`: its body goes, its children stay). */
  private setStatus(id: NodeId, status: NodeStatus, reset: boolean): FoldResult {
    const node = this.nodes.get(id);
    if (node === undefined) return NOTHING;
    if (reset) {
      if (node.body !== null && node.body.kind === 'lesson') for (const step of node.body.steps) if (step.kind === 'ask') this.askOwner.delete(step.id);
      const next: DocNode = { ...node, body: null, status };
      this.nodes.set(id, next);
      this.revision += 1;
      return { nodes: [next], state: false, applied: true };
    }
    if (node.status === status) return NOTHING;
    const next: DocNode = { ...node, status };
    this.nodes.set(id, next);
    this.revision += 1;
    return { nodes: [next], state: false, applied: true };
  }

  // ---- what the catalogue lists

  summary(meta: { readonly updated: string; readonly files: readonly string[]; readonly live: boolean; readonly thumbnail: string | null }): DocumentSummary {
    const outline: OutlineItem[] = [];
    const tagged = new Map<string, NodeId[]>();
    let lessons = 0;
    let outlined = 0;
    let done = 0;
    const isLesson = (node: DocNode): boolean => node.body !== null && node.body.kind === 'lesson';
    const walk = (id: NodeId, depth: number): void => {
      const node = this.nodes.get(id);
      if (node === undefined) return;
      if (node.tag !== null) tagged.set(node.tag, [...(tagged.get(node.tag) ?? []), id]);
      if (isLesson(node)) lessons += 1;
      if (node.status === 'outlined' && node.children.length === 0) outlined += 1;
      if (this.current.progress[id]?.done === true) done += 1;
      if (!isLesson(node)) {
        const ways = node.children.map((child) => this.nodes.get(child)).filter((child): child is DocNode => child !== undefined && isLesson(child));
        outline.push({
          id,
          title: node.title,
          depth,
          status: node.status,
          ways: ways.length,
          tags: [...new Set(ways.flatMap((way) => (way.tag === null ? [] : [way.tag])))],
          done: this.current.progress[id]?.done === true,
        });
      }
      for (const child of node.children) walk(child, depth + 1);
    };
    if (this.root !== null) walk(this.root, 0);
    return {
      id: this.id,
      title: this.title === '' ? 'A conversation' : this.title,
      created: this.created,
      updated: meta.updated,
      files: meta.files,
      nodes: this.nodes.size,
      lessons,
      outlined,
      done,
      cursor: this.current.cursor.node,
      outline,
      techniques: [...tagged.entries()].map(([tag, nodes]) => ({ tag, nodes })),
      thumbnail: meta.thumbnail,
      live: meta.live,
    };
  }

  view(meta: { readonly updated: string; readonly files: readonly string[]; readonly live: boolean; readonly thumbnail: string | null }): DocumentView {
    return { document: this.document(), state: this.current, summary: this.summary(meta) };
  }
}

// ---------------------------------------------------------------- the port the conductor holds

/** A document folded from its log, with the files it came from. */
export interface LoadedDocument {
  readonly fold: DocumentFold;
  readonly files: readonly string[];
}

/** What a record did, for the conductor to send: the `doc` event's content, whether state moved, and whether the record is worth keeping. */
export interface DocChange {
  readonly document: string;
  readonly title: string;
  readonly root: NodeId;
  readonly nodes: readonly DocNode[];
  readonly state: boolean;
  readonly applied: boolean;
}

/** What the conductor needs of the documents. The file system is behind it (`S/documents`). */
export interface Documents {
  /** Folds a document from its log files, or answers what is live; null when there is no such document. */
  load(id: string): Promise<LoadedDocument | null>;
  /** A session begins. `file` is its log file's name ('' when nothing is logged); `resume` is the document it opens again, if it does. */
  begin(session: string, file: string, resume: LoadedDocument | null): void;
  /** The node this line text would land in, for the log record; null when it is no document line. */
  place(session: string, text: string): NodeId | null;
  /** Feeds the document the record the conductor has just written (or is about to). Null when the session has no document and the record is nothing to it. */
  record(session: string, entry: SessionEntry): DocChange | null;
  /** The document this session is making or has opened, with the person's state in it; null while it has none. */
  viewOfSession(session: string): DocumentView | null;
  view(id: string): Promise<DocumentView | null>;
  list(): Promise<readonly DocumentSummary[]>;
  release(session: string): void;
  close(): Promise<void>;
}

export const NO_DOCUMENTS: Documents = {
  load: async () => null,
  begin: () => undefined,
  place: () => null,
  record: () => null,
  viewOfSession: () => null,
  view: async () => null,
  list: async () => [],
  release: () => undefined,
  close: async () => undefined,
};

/** A document's id is the stem of the log file that began it (`20261114-173639-c3`): it names a file and is never taken from a path. */
export const DOCUMENT_ID = /^[0-9]{8}-[0-9]{6}-[A-Za-z0-9_-]{1,40}$|^mem-[A-Za-z0-9_-]{1,60}$/;
