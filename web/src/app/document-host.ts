// The page's side of the lesson (PLAN-v3-core WS6): mounts the sandboxed lesson in an element, feeds it the document and her state, hears
// what she did and turns it into the state changes and back events of the wire (WS4), and keeps the last census and still for the page's
// witnesses. It knows nothing of the stage or the shell; `attachDocumentLink` is the whole of what stage-app.ts and http-link.ts add.

import { matches } from '../surfaces/lesson/answer';
import { mountLessonFrame } from '../surfaces/lesson/frame';
import type { LessonFrame } from '../surfaces/lesson/frame';
import { tokensFor } from '../surfaces/lesson/tokens';
import { isTechnique } from '../surfaces/lesson/types';
import type { CatalogueEntry, DocState, DocumentSummary, Document, Held, LessonCensus, LessonEvent, LessonInput, LessonUp, NodeId, StateChange } from '../surfaces/lesson/types';

/** What the host needs of the wire. WS4's routes and events, as the page's link will give them (the stub in the bench is a local one). */
export interface DocumentLink {
  /** back event `state` (2.5): a committed change, never a tick */
  sendState(change: StateChange): void;
  /** `seen` as it rides on `tap`, `control` and `act`: the cursor and every held value at this instant */
  sendSeen(event: LessonEvent, seen: { readonly cursor: DocState['cursor']; readonly held: DocState['held'] }): void;
  /** `GET /api/documents` */
  documents(): Promise<readonly DocumentSummary[]>;
  /** `GET /api/documents/:id`, then `POST /api/documents/:id/open` when she opens another sheet */
  open(id: string): Promise<{ readonly document: Document; readonly state: DocState }>;
}

export interface DocumentHostHandlers {
  readonly onState?: (state: DocState) => void;
  readonly onChange?: (change: StateChange) => void;
  readonly onEvent?: (event: LessonEvent, seen: { readonly cursor: DocState['cursor']; readonly held: DocState['held'] }) => void;
}
export interface DocumentHostOptions extends DocumentHostHandlers {
  readonly mount: HTMLElement;
  readonly dark: boolean;
  readonly input: LessonInput;
}

/** The catalogue's entries read from the server's summaries (a question is an outline line with ways, or the deepest line). */
export function catalogueFromSummaries(summaries: readonly DocumentSummary[], current: string): readonly CatalogueEntry[] {
  return summaries.map((s) => {
    const deepest = Math.max(0, ...s.outline.map((o) => o.depth));
    const questions = s.outline.filter((o) => o.ways > 0 || (o.depth === deepest && deepest > 0)).map((o) => ({ id: o.id, title: o.title, done: o.done, techniques: o.tags.filter(isTechnique) }));
    return { id: s.id, title: s.title, updated: Date.parse(s.updated) || 0, current: s.id === current, questions };
  });
}

function sameJson(a: Held | undefined, b: Held | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** What changed between two states, as the wire's changes. A `try` carries the page's verdict, checked here with no round trip. */
export function changesBetween(doc: Document, before: DocState, after: DocState): readonly StateChange[] {
  const out: StateChange[] = [];
  const play = (s: DocState): string => JSON.stringify(s.cursor);
  if (play(before) !== play(after)) out.push({ kind: 'cursor', cursor: after.cursor });
  for (const [node, held] of Object.entries(after.held)) {
    for (const [key, value] of Object.entries(held)) if (!sameJson(before.held[node]?.[key], value)) out.push({ kind: 'held', node, key, value });
  }
  for (const [node, progress] of Object.entries(after.progress)) {
    const was = before.progress[node];
    if (progress.seen > (was?.seen ?? 0)) out.push({ kind: 'seen', node, seen: progress.seen });
    for (const [ask, tries] of Object.entries(progress.tries)) {
      const known = was?.tries[ask]?.length ?? 0;
      const step = doc.nodes[node]?.body?.kind === 'lesson' ? doc.nodes[node].body.steps.find((s) => s.kind === 'ask' && s.id === ask) : undefined;
      for (const value of tries.slice(known)) out.push({ kind: 'try', node, ask, value, right: step?.kind === 'ask' && value !== '~worked' && matches(value, step.accepted, step.unit) });
    }
    if (progress.done !== (was?.done ?? false)) out.push({ kind: 'done', node, done: progress.done });
  }
  return out;
}

export class DocumentHost {
  private readonly frame: LessonFrame;
  private input: LessonInput;
  private state: DocState;
  private dark: boolean;
  private census: LessonCensus | null = null;
  private readonly shots = new Map<number, (data: string | null) => void>();
  private shot = 0;
  private stalledView: HTMLElement | null = null;
  private handlers: DocumentHostHandlers;

  constructor(options: DocumentHostOptions) {
    this.handlers = options;
    this.input = options.input;
    this.state = options.input.state;
    this.dark = options.dark;
    this.frame = mountLessonFrame(options.mount);
    this.frame.onMessage((message) => this.hear(message));
    this.frame.onStall(() => this.stall());
  }

  private hear(message: LessonUp): void {
    switch (message.type) {
      case 'ready':
        this.frame.send({ type: 'init', tokens: tokensFor(this.dark), input: { ...this.input, state: this.state } });
        return;
      case 'save': {
        const changes = changesBetween(this.input.doc, this.state, message.state);
        this.state = message.state;
        this.handlers.onState?.(message.state);
        for (const change of changes) this.handlers.onChange?.(change);
        return;
      }
      case 'emit':
        this.handlers.onEvent?.(message.event, { cursor: this.state.cursor, held: this.state.held });
        return;
      case 'census':
        this.census = message.census;
        return;
      case 'still':
        this.shots.get(message.id)?.(message.data);
        this.shots.delete(message.id);
        return;
      case 'fault':
        console.warn('lesson fault:', message.message);
        return;
      case 'size':
      case 'pong':
        return;
    }
  }

  /** Three pings missed: the leaf is replaced by what it says, in words (never nothing). */
  private stall(): void {
    const view = document.createElement('div');
    view.setAttribute('role', 'status');
    view.style.cssText = 'padding:24px;font:20px/1.4 system-ui,sans-serif';
    view.textContent = this.census === null ? 'The lesson stopped. Reload to carry on from where you were.' : `The lesson stopped. You were here: ${this.census.here}`;
    this.frame.element.replaceWith(view);
    this.stalledView = view;
  }

  /** Who hears what she does (the link, or the bench's own). */
  listen(handlers: DocumentHostHandlers): void {
    this.handlers = handlers;
  }

  /** The document grew, or another sheet was opened. */
  setInput(input: LessonInput): void {
    this.input = input;
    this.state = input.state;
    this.frame.send({ type: 'data', input });
  }
  setDark(dark: boolean): void {
    this.dark = dark;
    this.frame.send({ type: 'theme', tokens: tokensFor(dark) });
  }
  /** The last census the lesson posted: what the invariants and the critic read. */
  lastCensus(): LessonCensus | null {
    return this.census;
  }
  /** A picture of the lesson as it stands, drawn by the lesson itself (the self-portrait: the server's headless Chrome is the better witness). */
  shoot(): Promise<string | null> {
    this.shot += 1;
    const id = this.shot;
    return new Promise((resolve) => {
      this.shots.set(id, resolve);
      this.frame.send({ type: 'shoot', id });
      window.setTimeout(() => {
        if (this.shots.delete(id)) resolve(null);
      }, 4000);
    });
  }
  get element(): HTMLIFrameElement {
    return this.frame.element;
  }
  get current(): DocState {
    return this.state;
  }
  get stalled(): HTMLElement | null {
    return this.stalledView;
  }
  probe(): { readonly frame: ReturnType<LessonFrame['probe']>; readonly node: NodeId } {
    return { frame: this.frame.probe(), node: this.state.cursor.node };
  }
  dispose(): void {
    this.frame.dispose();
  }
}

/**
 * The hook stage-app.ts and http-link.ts take (applied by the integrator): the host's state changes and events go up the link, and a sheet
 * she opens in the catalogue is fetched and drawn. The link's `doc` stage events call `host.setInput` with the new document.
 */
export function bindDocumentLink(host: DocumentHost, link: DocumentLink, context: { readonly currentId: () => string; readonly crops: () => LessonInput['crops'] }): { readonly refresh: () => Promise<readonly CatalogueEntry[]> } {
  const refresh = async (): Promise<readonly CatalogueEntry[]> => catalogueFromSummaries(await link.documents(), context.currentId());
  const openOther = async (id: string): Promise<void> => {
    const view = await link.open(id);
    host.setInput({ doc: view.document, state: view.state, crops: context.crops(), catalogue: await refresh() });
  };
  host.listen({
    onChange: (change) => link.sendState(change),
    onEvent: (event, seen) => {
      if (event.kind === 'document') void openOther(event.id);
      else link.sendSeen(event, seen);
    },
  });
  return { refresh };
}
