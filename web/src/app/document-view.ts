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

import { initialState, nodeOf } from '@conduit/language';
import type { DocNode } from '@conduit/language';
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
  readonly link: DocumentLink;
  readonly dark: () => boolean;
  readonly onNote?: (text: string) => void;
  /** the pen: how a picture of her writing is kept and read; absent, the typed field is the writing area */
  readonly ink?: {
    upload(png: Blob): Promise<string>;
    read(request: { readonly image: string; readonly node: string; readonly ask: string }): Promise<{ readonly lines: readonly string[]; readonly unclear: boolean }>;
  };
  /** where a photo of this conversation is, by its id: a question's crop is cut from it */
  readonly photoUrl?: (id: string) => string | null;
  /** a document is on screen (or put away) for this id: the page may remember it to resume */
  readonly onShown?: (document: string) => void;
}

export interface DocumentView {
  onDoc(event: DocStageEvent): void;
  /** a document and her place in it, as the server keeps them (a session opened again) */
  load(view: { readonly document: Document; readonly state: DocState }): void;
  reset(): void;
  /** show the picture under it, or the document again */
  toggle(show?: boolean): void;
  readonly shown: boolean;
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
  pill.style.cssText = 'position:absolute;right:12px;bottom:12px;z-index:6;min-height:48px;padding:0 18px;border-radius:24px;border:2px solid #888;background:#fff;color:#111;font:700 18px system-ui;display:none';
  options.stage.append(layer, pill);

  const pen: DocumentInk | null =
    options.ink === undefined
      ? null
      : createDocumentInk({
          mount: body,
          document: () => doc,
          upload: options.ink.upload,
          read: options.ink.read,
          answer: (node, ask, text, said) => host?.write(node, ask, text, said),
          note: (text) => options.onNote?.(text),
        });
  const crops = createCrops(options.photoUrl ?? (() => null), () => {
    if (host !== null && doc !== null) host.setInput(input(doc, host.current));
  });
  const input = (next: Document, state: DocState): LessonInput => ({ doc: next, state, crops: crops.of(next), stills: {}, catalogue, picture: true, ink: pen !== null });

  const refresh = (): void => {
    void options.link.documents().then((summaries) => {
      catalogue = catalogueFromSummaries(summaries, doc?.id ?? '');
      if (host !== null && doc !== null) host.setInput(input(doc, host.current));
    }, () => undefined);
  };

  const mount = (next: Document, state: DocState): void => {
    doc = next;
    if (host === null) {
      layer.style.display = shown ? 'flex' : 'none';
      host = new DocumentHost({ mount: body, dark: options.dark(), input: input(next, state), onNote: options.onNote });
      host.listen({
        onChange: (change) => options.link.sendState(change),
        // another sheet from the catalogue: opened again in a session of its own, and drawn from where she was in it
        onOpen: (id) => {
          void options.link.open(id).then((view) => {
            doc = view.document;
            host?.setInput(input(view.document, view.state), true);
            options.onShown?.(view.document.id);
            refresh();
          }, (cause: unknown) => options.onNote?.(cause instanceof Error ? cause.message : 'That document could not be opened.'));
        },
        onNote: options.onNote,
        onPicture: () => toggle(false), onSlot: (slot) => pen?.slot(slot), onInkCheck: (node, ask) => void pen?.check(node, ask), onInkClear: (node, ask) => pen?.clear(node, ask) });
      options.onShown?.(next.id);
      refresh();
    } else host.setInput(input(next, host.current));
  };

  const toggle = (show?: boolean): void => {
    shown = show ?? !shown;
    layer.style.display = shown && host !== null ? 'flex' : 'none';
    pill.style.display = !shown && host !== null ? 'block' : 'none';
  };
  pill.addEventListener('click', () => toggle(true));

  return {
    onDoc(event) {
      const nodes: Record<NodeId, DocNode> = { ...(doc?.nodes ?? {}) };
      for (const node of event.nodes) nodes[node.id] = node;
      const next: Document = { id: event.document, title: event.title, root: event.root, nodes, defs: {} };
      if (nodeOf(next, next.root) === null || !worthShowing(next)) {
        doc = next;
        return;
      }
      mount(next, host?.current ?? initialState(next));
      toggle(shown);
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
    get shown() {
      return shown && host !== null;
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
