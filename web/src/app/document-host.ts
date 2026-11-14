// The page's side of the lesson (PLAN-v3-core WS6): runs the lesson program on the surface host (web/src/surfaces/host.ts), gives it the document
// and her state, hears what she did, and keeps the page's copy of her state by running WS3's `advance` on the same changes. It knows nothing of
// the stage or the shell: the element it is given is the box the lesson fills. `bindDocumentLink` is the whole of what stage-app.ts and
// http-link.ts add (the ten-line hook of the plan).
//
// The host carries the look to a surface and nothing else, so the lesson's payload (the document, her state, the palette) rides the look's
// tokens object: the host forwards the whole object in its `data` message, and the lesson takes `tokens.lesson`. A payload is sent when the
// lesson says `hello`, and again whenever the document or the look changes (the host sends a `data` message when the tokens object is a new one).

import { advance } from '@conduit/language';
import type { AppTokens } from '../contracts/app';
import type { SurfaceHost, SurfaceProbe } from '../contracts/surface';
import { createSurfaceHost } from '../surfaces/host';
import { decode } from '../surfaces/lesson/changes';
import { lessonSource } from '../surfaces/lesson/source';
import { tokensFor } from '../surfaces/lesson/tokens';
import { isTechnique } from '../surfaces/lesson/types';
import type { CatalogueEntry, DocState, Document, DocumentSummary, LessonInput, LessonPayload, LessonTokens, NodeId, StateChange, WriteResult } from '../surfaces/lesson/types';

/** What the host needs of the wire. WS4's routes and events, as the page's link will give them (the bench has a local one). */
export interface DocumentLink {
  /** back event `state` (2.5): a committed change, never a tick */
  sendState(change: StateChange): void;
  /** `GET /api/documents` */
  documents(): Promise<readonly DocumentSummary[]>;
  /** `GET /api/documents/:id`, then `POST /api/documents/:id/open` when she opens another sheet */
  open(id: string): Promise<{ readonly document: Document; readonly state: DocState }>;
}

export interface DocumentHostOptions {
  /** the box the lesson fills (the canvas panel on a desk, the whole screen on a phone) */
  readonly mount: HTMLElement;
  readonly dark: boolean;
  readonly input: LessonInput;
  readonly onChange?: (change: StateChange, state: DocState) => void;
  /** she opened another sheet in the catalogue */
  readonly onOpen?: (document: string) => void;
  /** she asked for a painted scene or an app in the document to be opened where it is drawn */
  readonly onOpenPart?: (node: NodeId) => void;
  /** she asked to put the document away and see the picture */
  readonly onPicture?: () => void;
  /** where the writing area is in the frame, or null: the ink module is laid over it (`overlayOn`, in the page) and keyed on `{ node, ask }` */
  readonly onSlot?: (slot: { readonly node: NodeId; readonly ask: string; readonly x: number; readonly y: number; readonly w: number; readonly h: number } | null) => void;
  /** she pressed Check on an ask she wrote by hand: read the ink and answer with `host.write` */
  readonly onInkCheck?: (node: NodeId, ask: string) => void;
  /** she asked for a clean sheet */
  readonly onInkClear?: (node: NodeId, ask: string) => void;
  /** a line for the status line: a fault, a frame that stopped */
  readonly onNote?: (text: string) => void;
}

/** The catalogue's entries read from the server's summaries (a question is an outline line with ways, or the deepest line). */
export function catalogueFromSummaries(summaries: readonly DocumentSummary[], current: string): readonly CatalogueEntry[] {
  return summaries.map((s) => {
    const deepest = Math.max(0, ...s.outline.map((o) => o.depth));
    const questions = s.outline.filter((o) => o.ways > 0 || (o.depth === deepest && deepest > 0)).map((o) => ({ id: o.id, title: o.title, done: o.done, techniques: o.tags.filter(isTechnique) }));
    return { id: s.id, title: s.title, updated: Date.parse(s.updated) || 0, current: s.id === current, questions };
  });
}

/** The host's own token type for a palette: what a frame would be given as its look. */
function hostTokens(t: LessonTokens): AppTokens {
  return { ground: t.ground, ink: t.ink, dim: t.dim, accent: t.accent, onAccent: t.onAccent, alt: t.soft, line: t.line, good: t.good, bad: t.nudge, font: t.font, fontPx: 20, radius: 16, gap: 12, dark: t.dark };
}

const KEY = 'lesson';

export class DocumentHost {
  private readonly host: SurfaceHost;
  private input: LessonInput;
  private state: DocState;
  private dark: boolean;
  private rev = 0;
  private asked = 0;
  private replace = false;
  private written: WriteResult | undefined;
  private writeSeq = 0;
  private tokens: AppTokens;
  private summary: unknown = null;
  private wanted: ((summary: unknown) => void) | null = null;
  private readonly observer: ResizeObserver | null;
  /** who is listening now (the link, or the page's own) */
  handlers: Pick<DocumentHostOptions, 'onChange' | 'onOpen' | 'onOpenPart' | 'onPicture' | 'onSlot' | 'onInkCheck' | 'onInkClear' | 'onNote'>;
  private problem: string | null;

  constructor(private readonly options: DocumentHostOptions) {
    this.input = options.input;
    this.state = options.input.state;
    this.dark = options.dark;
    this.handlers = options;
    const made = lessonSource();
    this.problem = made.problem;
    if (this.problem !== null) options.onNote?.(`The lesson cannot run: ${this.problem}`);
    this.tokens = this.carry();
    this.host = createSurfaceHost({
      stage: options.mount,
      onEmit: (emit) => this.hear(emit.name, emit.value),
      onSave: ({ json }) => this.reconcile(json),
      onNote: (text) => this.handlers.onNote?.(text),
    });
    this.observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.sync());
    this.observer?.observe(options.mount);
    this.sync();
  }

  /** The look's tokens with the payload on them: a new object each time, so the host sends it. */
  private carry(): AppTokens & { readonly lesson: LessonPayload } {
    const palette = tokensFor(this.dark);
    this.rev += 1;
    const lesson: LessonPayload = { rev: this.rev, tokens: palette, input: { ...this.input, state: this.state }, replace: this.replace, census: this.asked, ...(this.written === undefined ? {} : { write: this.written }) };
    this.replace = false;
    return { ...hostTokens(palette), lesson };
  }

  private sync(): void {
    if (this.problem !== null) return;
    const rect = this.options.mount.getBoundingClientRect();
    const box = { x: 0, y: 0, width: Math.max(1, rect.width), height: Math.max(1, rect.height) };
    this.host.sync([{ key: KEY, id: KEY, title: 'Your lesson', source: lessonSource().source, ready: true, box, rest: box, opacity: 1, z: 1, tokens: this.tokens }]);
  }

  private push(): void {
    this.tokens = this.carry();
    this.sync();
  }

  private hear(name: string, value: string | number | boolean): void {
    if (name === 'hello') return this.push();
    if (name === 'open') {
      if (typeof value === 'string') this.handlers.onOpen?.(value);
      return;
    }
    if (name === 'picture') return this.handlers.onPicture?.();
    if (name === 'slot') {
      let read: unknown = null;
      try {
        read = typeof value === 'string' ? JSON.parse(value) : null;
      } catch {
        read = null;
      }
      const s = Array.isArray(read) ? read : [];
      this.handlers.onSlot?.(typeof s[0] === 'string' && typeof s[1] === 'string' && s.slice(2).every((n) => typeof n === 'number') ? { node: s[0], ask: s[1], x: Number(s[2]), y: Number(s[3]), w: Number(s[4]), h: Number(s[5]) } : null);
      return;
    }
    if (name === 'inkcheck' || name === 'inkclear') {
      let read: unknown = null;
      try {
        read = typeof value === 'string' ? JSON.parse(value) : null;
      } catch {
        read = null;
      }
      if (Array.isArray(read) && typeof read[0] === 'string' && typeof read[1] === 'string') (name === 'inkcheck' ? this.handlers.onInkCheck : this.handlers.onInkClear)?.(read[0], read[1]);
      return;
    }
    if (name === 'openpart') {
      if (typeof value === 'string') this.handlers.onOpenPart?.(value);
      return;
    }
    if (name === 'census') {
      try {
        this.summary = typeof value === 'string' ? (JSON.parse(value) as unknown) : null;
      } catch {
        this.summary = null;
      }
      this.wanted?.(this.summary);
      this.wanted = null;
      return;
    }
    const change = decode(name, value);
    if (change === null) return;
    const next = advance(this.input.doc, this.state, change);
    if (next === this.state) return;
    this.state = next;
    this.handlers.onChange?.(change, next);
  }

  /** The state the frame kept (told a moment after it stops changing, and as it leaves): any try or control an event was too big or too quick for. */
  private reconcile(json: string): void {
    let saved: DocState;
    try {
      saved = JSON.parse(json) as DocState;
    } catch {
      return;
    }
    if (saved.cursor === undefined || saved.progress === undefined) return;
    let state = this.state;
    for (const [node, progress] of Object.entries(saved.progress)) {
      for (const [ask, tries] of Object.entries(progress.tries)) {
        const have = state.progress[node]?.tries[ask]?.length ?? 0;
        for (const value of tries.slice(have)) {
          const change: StateChange = { kind: 'try', node, ask, value };
          const next = advance(this.input.doc, state, change);
          if (next !== state) {
            state = next;
            this.handlers.onChange?.(change, next);
          }
        }
      }
    }
    const sync: StateChange = { kind: 'sync', seen: { cursor: saved.cursor, held: saved.held } };
    const next = advance(this.input.doc, state, sync);
    if (next !== state) {
      state = next;
      this.handlers.onChange?.(sync, next);
    }
    this.state = state;
  }

  // ------------------------------------------------------------ for the page

  /** Who hears what she does (the link, or the bench's own). */
  listen(handlers: Pick<DocumentHostOptions, 'onChange' | 'onOpen' | 'onOpenPart' | 'onPicture' | 'onSlot' | 'onInkCheck' | 'onInkClear' | 'onNote'>): void {
    this.handlers = handlers;
  }

  /** The document grew, or another sheet was opened (`replace`: the state in `input` is the truth). */
  setInput(input: LessonInput, replace = false): void {
    this.input = input;
    if (replace) this.state = input.state;
    this.replace = replace;
    this.push();
  }
  /** What the page read from her hand for an ask (`text`: her working as lines; null: it could not be read, and `said` tells her). The lesson tries it as her answer. */
  write(node: NodeId, ask: string, text: string | null, said?: string): void {
    this.writeSeq += 1;
    this.written = { seq: this.writeSeq, node, ask, text, ...(said === undefined ? {} : { said }) };
    this.push();
  }
  setDark(dark: boolean): void {
    this.dark = dark;
    this.push();
  }
  /** Her state as the page holds it. */
  get current(): DocState {
    return this.state;
  }
  /** The summary of what is on screen (the numbers of the rules of 2.8), asked of the frame and answered within a second; null when it does not answer. */
  census(): Promise<unknown> {
    this.asked += 1;
    this.push();
    return new Promise((resolve) => {
      this.wanted = resolve;
      window.setTimeout(() => {
        if (this.wanted === resolve) {
          this.wanted = null;
          resolve(null);
        }
      }, 1000);
    });
  }
  /** A picture of the lesson as it stands, drawn by the lesson's own frame (the server's headless Chrome is the better witness, 2.6). */
  async still(): Promise<string | null> {
    await this.host.refresh(2000);
    const canvas = this.host.still(KEY);
    return canvas instanceof HTMLCanvasElement ? canvas.toDataURL('image/png') : null;
  }
  probe(): readonly SurfaceProbe[] {
    return this.host.probe();
  }
  get node(): NodeId {
    return this.state.cursor.node;
  }
  dispose(): void {
    this.observer?.disconnect();
    this.host.dispose();
  }
}

/**
 * The hook stage-app.ts and http-link.ts take (applied by the integrator): the host's state changes go up the link, and a sheet she opens in the
 * catalogue is fetched and drawn. The link's `doc` stage events call `host.setInput` with the new document.
 */
export function bindDocumentLink(host: DocumentHost, link: DocumentLink, context: { readonly currentId: () => string; readonly crops: () => LessonInput['crops'] }): { readonly refresh: () => Promise<readonly CatalogueEntry[]> } {
  const refresh = async (): Promise<readonly CatalogueEntry[]> => catalogueFromSummaries(await link.documents(), context.currentId());
  host.listen({
    onChange: (change) => link.sendState(change),
    onOpen: (id) => {
      void link.open(id).then(async (view) => host.setInput({ doc: view.document, state: view.state, crops: context.crops(), stills: {}, catalogue: await refresh() }, true));
    },
  });
  return { refresh };
}
