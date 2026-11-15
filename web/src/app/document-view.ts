// The document view's place on the stage (PLAN-v3-core WS6): when a session has a document, this mounts the document view over the stage by itself,
// builds the document from the stream (`doc` events replace nodes by id), keeps her state (WS3's `advance`, through the host) and takes her back to
// the picture on request. Lessons are quiet verbs for the painter (they draw nothing on the painted stage); this is what makes them visible.
//
// The hook it needs in stage-app.ts and http-link.ts (applied by the integrator), in full:
//
//   stage-app.ts   const docs = createDocumentView({ stage: stageEl, link: documentLink, dark: () => lookIsDark() });
//                  in the stage-event handler:  if (event.type === 'doc') docs.onDoc(event);
//                  when a session is opened again (`GET /api/sessions/:id/document`):  docs.load(view);  on a new session:  docs.reset();
//   http-link.ts   documentLink: DocumentLink = { sendState: (c) => send({ type: 'state', turn, document: id, change: c }), documents, open }

import { accepts, advance, initialState, nodeOf } from '@conduit/language';
import type { DocNode, DocumentInk as KeptInk, InkDocument, LessonAsk } from '@conduit/language';
import { DocumentHost, catalogueFromSummaries } from './document-host';
import type { DocumentLink } from './document-host';
import { createCrops } from './document-crops';
import { createDocumentInk } from './document-ink';
import type { DocumentInk } from './document-ink';
import type { CatalogueEntry, DocState, Document, LessonInput, NodeId } from '../surfaces/lesson/types';

/** The `doc` stage event of the wire (WS4): the nodes that changed, whole. */
export interface DocStageEvent {
  readonly type: 'doc';
  readonly turn: string | null;
  readonly document: string;
  readonly title: string;
  readonly root: NodeId;
  readonly nodes: readonly DocNode[];
}

export interface DocumentViewOptions {
  /** the stage's element: the view is laid over it */
  readonly stage: HTMLElement;
  /** the stage's look as an app wears it, and the person's audience */
  readonly look?: () => import('../contracts/app').AppTokens | null;
  readonly audience?: () => import('../core/contracts').Audience;
  readonly link: DocumentLink;
  readonly dark: () => boolean;
  readonly onNote?: (text: string) => void;
  /** the pen: how a picture of her writing is kept and read; absent, the typed field is the writing area */
  readonly ink?: {
    upload(png: Blob): Promise<string>;
    read(request: { readonly image: string; readonly node: string; readonly ask: string }): Promise<{ readonly lines: readonly string[]; readonly unclear: boolean; readonly sees?: string | null }>;
    /** her writing kept with the document, and fetched again when it is opened */
    keep(record: { readonly node: string; readonly ask: string; readonly n: number; readonly text: string; readonly doc: InkDocument }): void;
    fetch(document: string): Promise<readonly KeptInk[]>;
  };
  /** where a photo of this conversation is, by its id: a question's crop is cut from it */
  readonly photoUrl?: (id: string) => string | null;
  /** a document is on screen (or put away) for this id: the page may remember it to resume */
  readonly onShown?: (document: string, title: string) => void;
}

export interface DocumentView {
  /** `asked`: this turn is one the person began (a prompt or a tap), so the document it writes comes to the front, and a new section opens */
  onDoc(event: DocStageEvent, asked?: boolean): void;
  /** a document and her place in it, as the server keeps them (a session opened again) */
  load(view: { readonly document: Document; readonly state: DocState }): void;
  reset(): void;
  /** show the picture under it, or the document again */
  toggle(show?: boolean): void;
  readonly shown: boolean;
  /** the look or the audience changed */
  restyle(): void;
  /** a picture of the document as she sees it (the surface hands over its own still through the bridge), or null when it is not on screen */
  still(): Promise<Blob | null>;
  host(): DocumentHost | null;
  /** the pen laid over the writing slot, when there is one (for the browser checks) */
  readonly pen: DocumentInk | null;
  dispose(): void;
}

/** A document is worth showing when it holds something to step through, or has more than a name. */
function worthShowing(doc: Document): boolean {
  // a conversation of pictures alone (every scene under the root part `root`) is the painted stage's; the view is for one that has parts or something to step through
  return doc.root !== 'root' || Object.values(doc.nodes).some((n) => n.body !== null && n.body.kind === 'lesson');
}

export function createDocumentView(options: DocumentViewOptions): DocumentView {
  let doc: Document | null = null;
  let host: DocumentHost | null = null;
  let catalogue: readonly CatalogueEntry[] = [];
  let shown = true;
  /** the turns of the person's whose document has been brought to the front once: it is not pulled forward again by every later node */
  const fronted = new Set<string>();
  const layer = document.createElement('div');
  layer.className = 'stage__document';
  layer.setAttribute('data-document-view', '');
  layer.style.cssText = 'position:absolute;inset:0;z-index:5;display:none;flex-direction:column;background:transparent';
  const body = document.createElement('div');
  body.style.cssText = 'position:relative;flex:1;min-height:0';
  layer.append(body);
  // when the document is put away this is how it comes back: a pill over the picture, never over the document
  const pill = document.createElement('button');
  pill.type = 'button';
  pill.textContent = 'Show the document';
  pill.setAttribute('data-act', 'document');
  pill.style.cssText = 'position:absolute;right:12px;bottom:12px;z-index:6;min-height:48px;padding:0 18px;border-radius:24px;border:2px solid var(--stage-accent,#888);background:var(--stage-ground,#fff);color:var(--stage-ink,#111);font:700 18px system-ui;display:none';
  options.stage.append(layer, pill);

  const pen: DocumentInk | null =
    options.ink === undefined
      ? null
      : createDocumentInk({
          mount: body,
          document: () => doc,
          upload: options.ink.upload,
          read: options.ink.read,
          answer: (node, ask, text, said, sees) => host?.write(node, ask, text, said, sees),
          note: (text) => options.onNote?.(text),
          keep: options.ink.keep,
          tryNumber: (node, ask) => (host?.current.progress[node]?.tries[ask]?.length ?? 0) + 1,
          onWorking: () => {
            if (host !== null && doc !== null) host.setInput(input(doc, host.current));
          },
        });
  const crops = createCrops(options.photoUrl ?? (() => null), () => {
    if (host !== null && doc !== null) host.setInput(input(doc, host.current));
  });
  const input = (next: Document, state: DocState): LessonInput => ({ doc: next, state, crops: crops.of(next), stills: {}, catalogue, picture: true, ink: pen !== null, ...(pen === null ? {} : { working: pen.working() }) });

  const refresh = (): void => {
    void options.link.documents().then((summaries) => {
      catalogue = catalogueFromSummaries(summaries, doc?.id ?? '');
      if (host !== null && doc !== null) host.setInput(input(doc, host.current));
    }, () => undefined);
  };

  /** her writing kept with this document (the papers as she left them, and every try's working), for a reload or another browser */
  const keptInk = (id: string): void => {
    void options.ink?.fetch(id).then((records) => pen?.restore(records), () => undefined);
  };

  const mount = (next: Document, state: DocState): void => {
    doc = next;
    if (host === null) {
      layer.style.display = shown ? 'flex' : 'none';
      // a lesson that takes over the stage fades in, calmly (not under reduced motion), and says so
      if (shown && !(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)) {
        layer.style.opacity = '0';
        layer.style.transition = 'opacity 450ms ease';
        requestAnimationFrame(() => requestAnimationFrame(() => (layer.style.opacity = '1')));
      }
      if (shown) options.onNote?.('Opened as a worksheet. Close returns to the picture.');
      host = new DocumentHost({ mount: body, dark: options.dark(), input: input(next, state), onNote: options.onNote, ...(options.look === undefined ? {} : { look: options.look }), ...(options.audience === undefined ? {} : { audience: options.audience }) });
      host.listen({
        onChange: (change) => {
          // the server's own reading of a try wants the page's verdict beside it (the lesson's matcher ran here, with no round trip)
          if (change.kind === 'try' && change.right === undefined && doc !== null) {
            const body = doc.nodes[change.node]?.body;
            const step = body?.kind === 'lesson' ? body.steps.find((candidate): candidate is LessonAsk => candidate.kind === 'ask' && candidate.id === change.ask) : undefined;
            options.link.sendState({ ...change, right: step !== undefined && accepts(step, change.value) });
            return;
          }
          options.link.sendState(change);
        },
        // another sheet from the catalogue: opened again in a session of its own, and drawn from where she was in it
        onOpen: (id) => {
          void options.link.open(id).then((view) => {
            doc = view.document;
            host?.setInput(input(view.document, view.state), true);
            options.onShown?.(view.document.id, view.document.title);
            refresh();
            keptInk(view.document.id);
          }, (cause: unknown) => options.onNote?.(cause instanceof Error ? cause.message : 'That document could not be opened.'));
        },
        onNote: options.onNote,
        onPicture: () => toggle(false), onSlot: (slot) => pen?.slot(slot), onInkCheck: (node, ask) => void pen?.check(node, ask), onInkClear: (node, ask) => pen?.clear(node, ask) });
      options.onShown?.(next.id, next.title);
      refresh();
      keptInk(next.id);
    } else host.setInput(input(next, host.current));
  };

  const toggle = (show?: boolean): void => {
    shown = show ?? !shown;
    layer.style.display = shown && host !== null ? 'flex' : 'none';
    pill.style.display = !shown && host !== null ? 'block' : 'none';
  };
  pill.addEventListener('click', () => toggle(true));

  return {
    onDoc(event, asked = false) {
      const before = doc;
      const nodes: Record<NodeId, DocNode> = { ...(doc?.nodes ?? {}) };
      for (const node of event.nodes) nodes[node.id] = node;
      const next: Document = { id: event.document, title: event.title, root: event.root, nodes, defs: {} };
      if (nodeOf(next, next.root) === null || !worthShowing(next)) {
        doc = next;
        return;
      }
      // a document the person asked for is never written behind her back: it comes to the front, even when she had put the document away
      const bring = asked && event.turn !== null && !fronted.has(event.turn);
      if (bring && event.turn !== null) {
        fronted.add(event.turn);
        shown = true;
      }
      const hadHost = host !== null;
      mount(next, host?.current ?? initialState(next));
      toggle(shown);
      // a new section at the top of the document is what she asked to see: open it
      const fresh = bring && hadHost && host !== null ? event.nodes.find((node) => node.parent === next.root && before?.nodes[node.id] === undefined && node.tag === null) : undefined;
      if (fresh !== undefined && host !== null) {
        const change = { kind: 'cursor' as const, cursor: { node: fresh.id, play: { at: 0 } } };
        const moved = advance(next, host.current, change);
        if (moved !== host.current) {
          host.setInput(input(next, moved), true);
          options.link.sendState(change);
        }
      }
    },
    load(view) {
      if (host !== null) {
        host.dispose();
        host = null;
      }
      mount(view.document, view.state);
      toggle(true);
    },
    reset() {
      host?.dispose();
      host = null;
      doc = null;
      layer.style.display = 'none';
      pill.style.display = 'none';
    },
    toggle,
    restyle() {
      host?.restyle();
    },
    get shown() {
      return shown && host !== null;
    },
    async still() {
      if (host === null || !shown) return null;
      const url = await host.still();
      if (url === null) return null;
      try {
        const image = new Image();
        image.src = url;
        await image.decode();
        const scale = Math.min(1, 1280 / Math.max(image.naturalWidth, image.naturalHeight, 1));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const context = canvas.getContext('2d');
        if (context === null) return null;
        context.fillStyle = options.dark() ? '#111111' : '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
      } catch {
        return null;
      }
    },
    host: () => host,
    pen,
    dispose() {
      pen?.dispose();
      host?.dispose();
      layer.remove();
      pill.remove();
    },
  };
}
