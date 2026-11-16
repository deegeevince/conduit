// The document view: draws a document node by its kind and lets a hand move through it, and nothing else. It runs inside the sandboxed surface
// (program.ts boots it) with the browser's own layout and real inputs.
//
//   a part with children and no steps   a map: its children as cards, grouped under their sections, done ones filled in
//   a part with steps                   a worked page: the steps stacked, a picture carried and grown, an ask that checks and stops the page
//                                       until it holds an accepted answer; its children come under it once the steps are done, or on "Show me how"
//   a painted scene / a live app        its still (or its words) and a way to open it: they are the painter's and the host's
//   always                              the part's title as a card at the top, big; where it sits; back, next, up, resume
//
// Nothing here knows a worksheet. A question that asks first and keeps its ways in its children, a sheet, an explainer in three parts with a
// branch: the brain composes those from these pieces (the TEACH chapter says how), and this draws them. The rules it keeps in code:
//
//   1. the part's title is a card at the top of every step (sticky, headline type, its picture beside it); when the part is help for an ask
//      above it, the ask's part is the card and the part's own title is its kicker;
//   2. a picture has the lead room (about half the width on a desk, the whole width on a phone, pieces at least 36 pixels);
//   3. steps stack into a worked page, nothing shown is taken away;
//   4. a picture is worked by hand (widgets/*), its state kept in `held`;
//   5. a choice is a target of 72 pixels or more, a typed answer is a real field with the number keys, in a slot the ink area takes over;
//   6. a shut ask seals its answer: whatever draws goes through `sealed`/`maskSealed`, and nothing past a gate is drawn.
//
// The document, the cursor, her tries and the gates are WS3's `advance` and `askView`; this file never writes state any other way.

import { accepts, advance, askView, maskSealed, nodeOf, resolveText, sealed } from '@conduit/language';
import type { DocEvent, DocNode } from '@conduit/language';
import { changesBetween } from './changes';
import { h } from './dom';
import { afterOf, answerOf, atOf, cardsOf, gateOf, isDone, isLesson, isWaiting, kidsOf, parentOf, pathOf, runsOf, shownOf, shutAsks, splitNumber, stepsOf, tally } from './model';
import type { Run } from './model';
import { TECHNIQUE_NAMES, isTechnique } from './types';
import type { CatalogueEntry, DocState, Held, LessonAsk, LessonInput, LessonStep, OpenAsk, StateChange, Technique, WriteResult } from './types';
import { orderWriting } from './order';
import { inkWriting, typedWriting } from './writing';
import { drawVisual } from './widgets';
import type { WidgetCtx } from './widgets/common';

export interface PlayerPort {
  /** what advance committed: the changes the page applies to its copy (a cursor moved, an answer tried, a control held) */
  commit(changes: readonly StateChange[], state: DocState): void;
  /** she opened another sheet in the catalogue */
  open(document: string): void;
  /** she asked for a painted scene or a live app to be opened where it is drawn */
  openPart(node: string): void;
  /** she asked to put the document away and see the picture under it */
  picture(): void;
  /** she pressed Check on an ask she wrote by hand: the page reads the ink and answers with `write` */
  inkCheck(node: string, ask: string): void;
  /** she asked for a clean sheet to write on */
  inkClear(node: string, ask: string): void;
  /** words for the page to read aloud if she has Read aloud on: as they arrive (`tap` false), or because she tapped them (`tap` true) */
  say(text: string, tap: boolean): void;
}

/** What is on screen when it is not the part the cursor rests on. Ephemeral: the cursor is what is kept. */
type Screen = { readonly kind: 'map'; readonly node: string } | { readonly kind: 'catalogue' } | null;

const TECHNIQUE_GLYPH: Readonly<Record<Technique, string>> = {
  'draw-it': 'M4 20 L20 4 M14 4 H20 V10',
  'share-it-out': 'M4 8 H20 M4 16 H20 M12 4 V20',
  'count-on-a-line': 'M3 16 H21 M6 16 V12 M12 16 V12 M18 16 V12 M6 10 Q9 4 12 10',
  'make-ten': 'M5 4 V20 M10 8 A4 4 0 1 0 10.01 8 M16 4 H20 V20 H16 Z',
  'break-it-apart': 'M4 4 H20 V20 H4 Z M12 4 V20',
  'find-the-pattern': 'M4 18 L8 10 L12 18 L16 10 L20 18',
  'read-the-question': 'M5 4 H19 V20 H5 Z M8 9 H16 M8 13 H16 M8 17 H13',
  'work-backwards': 'M20 12 H5 M10 6 L4 12 L10 18',
};

function glyph(technique: Technique | null): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '32');
  svg.setAttribute('height', '32');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'glyph');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', technique === null ? 'M4 12 H20 M12 4 V20' : TECHNIQUE_GLYPH[technique]);
  svg.append(path);
  return svg;
}

/** A part's name for a person: a technique's own name when the part is a way of doing something, else its title. */
function nameOf(node: DocNode): string {
  return isTechnique(node.tag) ? TECHNIQUE_NAMES[node.tag] : splitNumber(node.title).text;
}

export class Player {
  private input: LessonInput;
  private state: DocState;
  private screen: Screen;
  private fresh: string | null = null;
  private justShown: number | null = null;
  private draft: Record<string, string> = {};
  private by: 'sheet' | 'technique' = 'sheet';
  private tryMs: number | null = null;
  private docked = false;
  private expanded = false;
  private watcher: IntersectionObserver | null = null;
  /** asks she chose to type, and the ask whose writing the page is reading now, and what it said when it could not */
  private readonly typing = new Set<string>();
  private reading: string | null = null;
  private unread: { readonly ask: string; readonly said: string } | null = null;
  private wrote = 0;
  /** what the reader saw in her last working at an ask, by ask: said before the hint when it was not right */
  private readonly sees = new Map<string, string>();
  /** read aloud: the steps and questions already offered to be read, so a redraw never reads one twice; and whether the first drawing (a page that has just opened) is done */
  private readonly told = new Set<string>();
  private drawn = false;

  constructor(
    private readonly root: HTMLElement,
    input: LessonInput,
    private readonly port: PlayerPort,
  ) {
    this.input = input;
    this.state = input.state;
    // a tap on words reads them (the page says nothing unless Read aloud is on)
    root.addEventListener('click', (event) => {
      if (!(event.target instanceof Element) || event.target.closest('button, a, input, textarea, select, [data-slot], .fig') !== null) return;
      const words = event.target.closest<HTMLElement>('.words, .ask-prompt, .ctx-text, .hint, .verdict, .ask-note');
      const text = words?.textContent?.trim() ?? '';
      if (text !== '') this.port.say(text, true);
    });
    // a document she has not begun opens on its map; one she has begun opens where she was
    this.screen = (input.state.progress[input.state.cursor.node]?.seen ?? 0) === 0 ? { kind: 'map', node: input.doc.root } : null;
  }

  /** The document grew (a part was written, a step arrived): draw again, keep the place. */
  update(input: LessonInput): void {
    this.input = { ...input, doc: this.input.doc, state: this.state };
    this.pending = input.doc;
    this.render();
  }

  /** The newest document that came while she was working on a part that it rewrites: held, and taken the moment she is off that part. */
  private pending: LessonInput['doc'] | null = null;

  /**
   * An update that lands while she is working never takes her screen, her ink or her try away. It goes in at once where it only adds (a hint, a way,
   * a card, another part). Where it rewrites the part she is on (the brain sent it back and wrote it again: other steps, or the check refused it) she
   * keeps the part as she has it, and the new one is taken when she moves off it.
   */
  private keepWhatSheIsOn(next: LessonInput['doc']): LessonInput['doc'] {
    const id = this.state.cursor.node;
    const had = nodeOf(this.input.doc, id);
    if (had === null || this.screen !== null) return next;
    const before = stepsOf(had);
    if (before.length === 0) return next;
    const now = nodeOf(next, id);
    const idOf = (step: LessonStep | undefined): string => (step === undefined ? '' : `${step.kind}:${(step as { id?: string }).id ?? ''}`);
    const after = now === null ? [] : stepsOf(now);
    const adds = now !== null && before.every((step, at) => idOf(step) === idOf(after[at]));
    if (!adds) return { ...next, nodes: { ...next.nodes, [id]: had } };
    if (now !== null && now.status === 'refused' && had.status !== 'refused') return { ...next, nodes: { ...next.nodes, [id]: { ...now, status: had.status } } };
    return next;
  }

  /** The page read her hand (or could not). Taken once; a reading is her try at the ask it was for. */
  written(result: WriteResult): void {
    if (result.seq <= this.wrote) return;
    this.wrote = result.seq;
    this.reading = null;
    const node = nodeOf(this.doc, result.node);
    const ask = node === null ? undefined : stepsOf(node).find((step): step is LessonAsk => step.kind === 'ask' && step.id === result.ask);
    if (node === null || ask === undefined) return this.render();
    if (result.text === null) {
      this.unread = { ask: result.ask, said: result.said ?? 'I could not read that. Write it bigger, or type it.' };
      return this.render();
    }
    this.unread = null;
    if (result.sees !== undefined) this.sees.set(`${result.node}\u0000${result.ask}`, result.sees);
    else this.sees.delete(`${result.node}\u0000${result.ask}`);
    this.tryAnswer(node, ask, result.text, performance.now());
  }

  get current(): DocState {
    return this.state;
  }
  get lastTryMs(): number | null {
    return this.tryMs;
  }
  private get doc(): LessonInput['doc'] {
    return this.input.doc;
  }
  /** The part the screen is about: the cursor's, unless a map or the catalogue is up. */
  private get here(): DocNode | null {
    return nodeOf(this.doc, this.state.cursor.node);
  }
  get shownScreen(): 'map' | 'part' | 'catalogue' {
    if (this.screen !== null) return this.screen.kind;
    const node = this.here;
    return node === null || this.isMap(node) ? 'map' : 'part';
  }
  /** A part is drawn as a map when it has nothing of its own to step through, show or run. */
  private isMap(node: DocNode): boolean {
    return !isLesson(node) && (node.body === null || node.body.kind === 'lesson') && node.children.length > 0;
  }

  // ------------------------------------------------------------ changes

  private apply(event: DocEvent): void {
    const next = advance(this.doc, this.state, event);
    if (next === this.state) return;
    const changes = changesBetween(this.doc, this.state, next);
    this.state = next;
    this.port.commit(changes, next);
  }

  private show(screen: Screen): void {
    this.screen = screen;
    this.render();
    window.scrollTo(0, 0);
  }

  /** Go to a part: where she was in it, or its first step. */
  private go(node: DocNode, at?: number): void {
    this.screen = null;
    this.justShown = null;
    this.apply({ kind: 'go', node: node.id, at: at === undefined ? 'resume' : { at } });
    this.render();
    window.scrollTo(0, 0);
  }

  private tryAnswer(node: DocNode, ask: LessonAsk, text: string, stamp: number): void {
    const clean = text.trim();
    if (clean === '') return;
    this.apply({ kind: 'try', node: node.id, ask: ask.id, value: clean });
    delete this.draft[ask.id];
    this.render();
    this.tryMs = Math.round(performance.now() - stamp);
    requestAnimationFrame(() => this.revealBelowPaper('.nudge, .ask.closed:last-of-type'));
  }

  private next(node: DocNode): void {
    const at = atOf(this.state);
    if (at >= stepsOf(node).length - 1) return;
    this.justShown = at + 1;
    this.apply({ kind: 'next' });
    this.render();
    this.scrollToLatest();
  }
  private back(node: DocNode): void {
    this.justShown = null;
    const at = atOf(this.state);
    if (at > 0) {
      this.apply({ kind: 'stop', at: at - 1 });
      this.render();
      return;
    }
    const up = parentOf(this.doc, node);
    if (up !== null && up.id !== this.doc.root) this.go(up);
    else this.show({ kind: 'map', node: this.doc.root });
  }

  /**
   * A sheet opened where she left off: the paper is brought into view (under the pinned question, clear of the dock), not left below the fold.
   * Only moves the page down when the paper is not wholly on screen; it never scrolls the paper under the card.
   */
  landOnPaper(): void {
    const paper = this.root.querySelector('[data-ink-slot]');
    if (paper === null) return;
    const r = paper.getBoundingClientRect();
    const dock = this.root.querySelector('.dock')?.getBoundingClientRect();
    const card = this.root.querySelector('.ctx.pinned')?.getBoundingClientRect();
    const floor = dock === undefined ? window.innerHeight : dock.top;
    if (r.bottom <= floor - 4) return;
    let by = r.bottom - floor + 12;
    const ceiling = (card === undefined ? 0 : card.bottom) + 4;
    if (r.top - by < ceiling) by = r.top - ceiling;
    if (by > 0) window.scrollBy(0, by);
  }

  /**
   * Bring what was just said (the verdict, a hint) into view, but never at the cost of the paper: she tries again with the pencil, so the paper stays
   * on screen, just under the pinned question. On a phone the words below may then need a scroll; the pencil is never the thing that goes.
   */
  private revealBelowPaper(selector: string): void {
    this.root.querySelector(selector)?.scrollIntoView({ block: 'nearest' });
    const paper = this.root.querySelector('[data-ink-slot]');
    if (paper === null) return;
    const card = this.root.querySelector('.ctx.pinned')?.getBoundingClientRect();
    const gap = paper.getBoundingClientRect().top - (card === undefined ? 0 : card.bottom) - 6;
    if (gap < 0) window.scrollBy(0, gap);
  }

  private scrollToLatest(): void {
    requestAnimationFrame(() => {
      const el = this.root.querySelector('.say.latest, .ask.open');
      if (el instanceof HTMLElement) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }

  // ------------------------------------------------------------ drawing

  render(): void {
    if (this.pending !== null) {
      const kept = this.keepWhatSheIsOn(this.pending);
      this.input = { ...this.input, doc: kept };
      if (kept === this.pending) this.pending = null;
    }
    const keep = document.activeElement instanceof HTMLElement ? { act: document.activeElement.dataset['act'], at: document.activeElement instanceof HTMLInputElement ? document.activeElement.selectionStart : null } : null;
    const x = window.scrollX;
    const y = window.scrollY;
    const where = this.shownScreen;
    const page = h('div', { class: `page view-${where}` });
    page.append(this.header());
    if (where === 'catalogue') page.append(this.catalogue());
    else if (where === 'map') page.append(this.map(this.screen !== null && this.screen.kind === 'map' ? (nodeOf(this.doc, this.screen.node) ?? this.here) : this.here));
    else {
      const node = this.here;
      if (node !== null) this.part(page, node);
    }
    this.root.replaceChildren(page);
    this.readNew();
    window.scrollTo(x, y);
    this.watch();
    this.fit();
    this.root.querySelectorAll('.fig').forEach((fig) => fig.classList.toggle('tall', fig.getBoundingClientRect().height > window.innerHeight * 0.46));
    if (keep?.act === 'answer') {
      const field = this.root.querySelector('[data-act="answer"]');
      if (field instanceof HTMLInputElement) {
        field.focus({ preventScroll: true });
        if (keep.at !== null) field.setSelectionRange(keep.at, keep.at);
      }
    }
  }

  /** The step she has just come to and the question it ends on are offered to be read aloud once each (never on the first drawing of a page that has just opened). */
  private readNew(): void {
    const first = !this.drawn;
    this.drawn = true;
    for (const el of this.root.querySelectorAll<HTMLElement>('.say.latest .words, .ask.open .ask-prompt')) {
      const owner = el.closest<HTMLElement>('[data-step], [data-ask]');
      if (owner === null) continue;
      const key = `${this.state.cursor.node}:${owner.dataset['step'] ?? `ask.${owner.dataset['ask'] ?? ''}`}`;
      if (this.told.has(key)) continue;
      this.told.add(key);
      if (first) continue;
      const text = el.textContent?.trim() ?? '';
      if (text === '') continue;
      this.port.say(text, false);
      const picks = [...(owner.querySelectorAll<HTMLElement>('.choices .choice') ?? [])].map((choice) => choice.firstChild?.textContent?.trim() ?? '').filter((label) => label !== '');
      if (el.classList.contains('ask-prompt') && picks.length > 1) this.port.say(`You can choose: ${picks.slice(0, -1).join(', ')} or ${picks[picks.length - 1] ?? ''}`, false);
    }
  }

  /** A card that has scrolled to the top of the screen is "docked": on a phone it shows fewer lines and opens to the whole on a tap. */
  private watch(): void {
    this.watcher?.disconnect();
    this.watcher = null;
    const mark = this.root.querySelector('.sentinel');
    if (mark === null || typeof IntersectionObserver === 'undefined') return;
    this.watcher = new IntersectionObserver((entries) => {
      const gone = entries.some((entry) => !entry.isIntersecting && entry.boundingClientRect.top < 0);
      if (gone === this.docked) return;
      this.docked = gone;
      const card = this.root.querySelector('.ctx');
      if (card instanceof HTMLElement) card.classList.toggle('docked', gone);
      this.fit();
    });
    this.watcher.observe(mark);
  }

  /** The height of the title card is the top the picture sticks under. */
  private fit(): void {
    const card = this.root.querySelector('.ctx');
    // only the pinned card sticks; the question's own screen is part of the page, so a picture sticks to the very top
    const top = card instanceof HTMLElement && card.classList.contains('pinned') ? card.getBoundingClientRect().height + 8 : 0;
    document.documentElement.style.setProperty('--qh', `${Math.round(top)}px`);
  }

  private header(): HTMLElement {
    const node = this.screen === null ? this.here : null;
    const up = node === null ? null : parentOf(this.doc, node);
    const crumb = node === null ? this.doc.title : pathOf(this.doc, node).slice(1).map((p) => splitNumber(p.title).text).join('  ›  ');
    return h(
      'header',
      { class: 'topbar' },
      h('button', { type: 'button', class: 'nav', 'data-act': 'map', onclick: () => this.show({ kind: 'map', node: this.doc.root }) }, 'Map'),
      up !== null && up.id !== this.doc.root ? h('button', { type: 'button', class: 'nav', 'data-act': 'up', onclick: () => this.go(up) }, '‹ Up') : null,
      h('span', { class: 'crumb' }, crumb),
      this.input.catalogue.length > 0 ? h('button', { type: 'button', class: 'nav', 'data-act': 'catalogue', onclick: () => this.show({ kind: 'catalogue' }) }, 'My documents') : null,
      this.input.picture === true ? h('button', { type: 'button', class: 'nav', 'data-act': 'picture', onclick: () => this.port.picture(), 'aria-label': 'Close and go back to the picture' }, 'Close') : null,
    );
  }

  // ------------------------------------------------------------ the map

  private map(node: DocNode | null): HTMLElement {
    const at = node ?? nodeOf(this.doc, this.doc.root);
    if (at === null) return h('main', { class: 'map' });
    const t = tally(this.doc, this.state, at);
    const view = h('main', { class: 'map' }, h('h1', { class: 'title' }, splitNumber(at.title).text), h('p', { class: 'sub' }, `${t.done} of ${t.total} done`));
    const here = this.here;
    if (here !== null && (this.state.progress[here.id]?.seen ?? 0) > 0 && !isDone(this.doc, this.state, here) && here.id !== at.id && isLesson(here)) {
      view.append(
        h(
          'button',
          { type: 'button', class: 'resume', 'data-act': 'resume', onclick: () => this.go(here) },
          h('span', { class: 'resume-kicker' }, 'Carry on where you were'),
          h('span', { class: 'resume-text' }, nameOf(here)),
          h('span', { class: 'resume-step' }, `step ${Math.min(this.state.progress[here.id]?.seen ?? 0, stepsOf(here).length)} of ${stepsOf(here).length}`),
        ),
      );
    }
    for (const group of cardsOf(this.doc, at)) {
      const block = h('section', { class: 'section' });
      if (group.head !== null) {
        const ht = tally(this.doc, this.state, group.head);
        block.append(h('h2', {}, splitNumber(group.head.title).text, h('span', { class: 'count' }, `${ht.done} of ${ht.total}`)));
      }
      const grid = h('ul', { class: 'cards' });
      for (const item of group.items) grid.append(h('li', {}, this.card(item)));
      block.append(grid);
      view.append(block);
    }
    return view;
  }

  /** One part as a card: its number and words, its picture if it has one, and where she is with it. */
  private card(node: DocNode): HTMLElement {
    const { printed, text } = splitNumber(node.title);
    const done = isDone(this.doc, this.state, node);
    const answer = answerOf(this.doc, this.state, node);
    const waiting = isWaiting(node) && !isLesson(node) && node.children.length === 0;
    const started = (this.state.progress[node.id]?.seen ?? 0) > 0;
    const crop = this.input.crops[node.id];
    const note = done ? (answer === null ? 'Done' : answer) : waiting ? 'Getting ready…' : started ? 'Carry on' : isTechnique(node.tag) ? TECHNIQUE_NAMES[node.tag] : 'Open';
    const card = h(
      'button',
      { type: 'button', class: `pcard${done ? ' done' : ''}${waiting ? ' wait' : ''}${crop === undefined ? '' : ' with-crop'}`, 'data-act': `open:${node.id}`, onclick: () => (this.isMap(node) ? this.show({ kind: 'map', node: node.id }) : this.go(node)) },
      h('span', { class: 'pnum' }, done ? '✓' : isTechnique(node.tag) ? glyph(node.tag) : (printed ?? '•')),
      crop === undefined ? null : h('img', { class: 'pcrop', src: crop, alt: '' }),
      h('span', { class: 'ptext' }, text),
      h('span', { class: `pnote${done && answer !== null ? ' answer' : ''}` }, note),
    );
    return card;
  }

  // ------------------------------------------------------------ a part

  /** The facts she has been asked to look at: the `[bracketed]` words of the thinking rungs of the asks of `node` that she has opened. */
  private factsOf(node: DocNode): readonly string[] {
    const out: string[] = [];
    for (const step of stepsOf(node)) {
      if (step.kind !== 'ask') continue;
      const heldNow = this.state.held[node.id]?.[`hint.${step.id}`];
      const asked = typeof heldNow === 'number' ? heldNow : 0;
      for (const text of step.hints.slice(0, asked)) for (const m of text.matchAll(/\[([^\]]+)\]/g)) if (m[1] !== undefined) out.push(m[1]);
    }
    return out;
  }

  private factsOpen(node: DocNode): boolean {
    return stepsOf(node).some((step) => step.kind === 'ask' && Number(this.state.held[node.id]?.[`hint.${step.id}`] ?? 0) > 0);
  }

  /** The question's words with each fact marked (underlined and highlighted), where the words hold it. */
  private marked(text: string, facts: readonly string[]): (string | HTMLElement)[] {
    // each fact is a text selector on the context, resolved against its words now (an exact or moved match; a fact found twice or not at all is not marked)
    const found = facts
      .flatMap((fact) => {
        const found = resolveText({ kind: 'text', scope: '', quote: fact, prefix: '', suffix: '', start: -1, end: -1 }, text);
        return found.state === 'orphan' || found.sel.kind !== 'text' ? [] : [{ at: found.sel.start, fact }];
      })
      .sort((a, b) => a.at - b.at);
    const out: (string | HTMLElement)[] = [];
    let from = 0;
    for (const { at, fact } of found) {
      if (at < from) continue;
      out.push(text.slice(from, at), h('mark', { class: 'fact' }, fact));
      from = at + fact.length;
    }
    out.push(text.slice(from));
    return out.filter((part) => part !== '');
  }

  /** The title card: the part's, or (when it is help for an ask above it) the part with the ask, so what she is working on never leaves the screen. */
  private titleCard(node: DocNode, open: readonly OpenAsk[]): HTMLElement {
    let context: DocNode = node;
    if (open.length > 0) {
      for (const above of pathOf(this.doc, node).slice(0, -1).reverse()) {
        if (stepsOf(above).some((s) => s.kind === 'ask' && open.some((o) => o.id === s.id))) {
          context = above;
          break;
        }
      }
    }
    const { printed, text } = splitNumber(context.title);
    const kicker = context.id === node.id ? (parentOf(this.doc, node)?.title ?? '') : nameOf(node);
    const onSurface = stepsOf(node).some((step) => step.kind === 'ask' && (step as LessonAsk & { readonly on?: string }).on !== undefined);
    const crop = onSurface ? undefined : this.input.crops[context.id];
    const long = text.length > 70;
    // Once she has left the question's own screen (a way, the thinking help, her working) the whole question stays pinned at the top left, smaller, never shortened.
    // a figure to work on takes the room: the card is the compact header over it
    const figured = runsOf(stepsOf(node), shownOf(this.doc, this.state, node)).some((run) => run.figure !== null);
    const pinned = figured || context.id !== node.id || this.factsOpen(context) || stepsOf(context).some((step) => step.kind === 'ask' && (askView(this.doc, this.state, context.id, step.id)?.tries.length ?? 0) > 0);
    const more = long ? h('button', { type: 'button', class: 'more', 'data-act': 'more', 'aria-expanded': String(this.expanded) }, this.expanded ? 'Show less' : 'Read it all') : null;
    const card = h(
      'section',
      { class: `ctx${pinned ? ' pinned' : ''}${crop === undefined ? '' : ' with-crop'}${long ? ' long' : ''}${this.docked ? ' docked' : ''}${this.expanded ? ' expanded' : ''}`, 'data-act': 'context', 'aria-label': 'What this is about' },
      h('span', { class: 'ctx-kicker' }, `${printed === null || context.id !== node.id ? '' : `${printed}.  `}${splitNumber(kicker).text}`),
      more,
      h('p', { class: 'ctx-text' }, ...this.marked(text, this.factsOf(context))),
      crop === undefined ? null : h('img', { class: 'crop', src: crop, alt: 'The question as it is written on the page. Tap to see it bigger.', role: 'button', tabindex: 0, onclick: (e: Event) => (e.currentTarget as HTMLElement).classList.toggle('zoom') }),
    );
    more?.addEventListener('click', () => {
      this.expanded = !this.expanded;
      card.classList.toggle('expanded', this.expanded);
      more.textContent = this.expanded ? 'Show less' : 'Read it all';
      more.setAttribute('aria-expanded', String(this.expanded));
      this.fit();
    });
    return h('div', { class: 'qwrap' }, h('div', { class: 'sentinel', 'aria-hidden': 'true' }), card);
  }

  private part(page: HTMLElement, node: DocNode): void {
    const steps = stepsOf(node);
    const shown = shownOf(this.doc, this.state, node);
    const open = shutAsks(this.doc, this.state, node);
    const mask = (text: string): string => maskSealed(text, open);
    const seal = (value: string | number): string => (sealed(value, open) ? '?' : String(value));
    page.append(this.titleCard(node, open));
    const main = h('main', { class: 'work' });
    for (const run of runsOf(steps, shown)) main.append(this.run(run, node, mask, seal, shown));
    if (node.body !== null && node.body.kind === 'scene') main.append(this.scene(node));
    else if (node.body !== null && node.body.kind === 'app') main.append(this.app(node));
    const gate = gateOf(this.doc, this.state, node);
    const kids = kidsOf(this.doc, node);
    const waiting = isWaiting(node);
    const over = shown >= steps.length && gate === null;
    if (gate !== null && kids.length > 0) main.append(this.help(kids));
    else if (over && !waiting && steps.length === 0 && kids.length === 0) {
      // nothing is written here (a lesson cut off mid-write keeps what it had): never "done", never a destination of its own
      if (node.body === null) main.append(h('p', { class: 'wait-note', 'data-act': 'cut-off' }, 'This part was cut off before it was written. Say “continue” and it will be written.'));
    } else if (over && !waiting) main.append(kids.length > 0 ? this.inside(node, kids) : this.finish(node));
    else if (over && waiting && steps.length === 0) main.append(h('p', { class: 'wait-note' }, 'This part is being written. It will be here in a moment.'));
    page.append(main, this.dock(node, shown, steps.length, gate !== null, waiting, over));
  }

  private scene(node: DocNode): HTMLElement {
    const still = this.input.stills[node.id];
    return h(
      'section',
      { class: 'leaf scene', 'data-act': `scene:${node.id}` },
      still === undefined ? h('p', { class: 'words' }, node.title) : h('img', { class: 'still', src: still, alt: node.title }),
      h('button', { type: 'button', class: 'btn soft', 'data-act': 'open-part', onclick: () => this.port.openPart(node.id) }, 'Open it'),
    );
  }

  private app(node: DocNode): HTMLElement {
    return h('section', { class: 'leaf app' }, h('p', { class: 'words' }, `${node.title}: a live app.`), h('button', { type: 'button', class: 'btn main', 'data-act': 'open-part', onclick: () => this.port.openPart(node.id) }, 'Open it'));
  }

  /** The way in to the parts under a part whose ask has not been got past: asked for, not shown. */
  private help(kids: readonly DocNode[]): HTMLElement {
    const first = kids[0];
    return h('section', { class: 'help' }, first === undefined ? null : h('button', { type: 'button', class: 'btn soft wide', 'data-act': 'help', onclick: () => this.go(first, 0) }, 'Show me how'));
  }

  /** A part's children once its own steps are done: cards to open. */
  private inside(node: DocNode, kids: readonly DocNode[]): HTMLElement {
    const next = afterOf(this.doc, node);
    const view = h('section', { class: 'inside' }, h('h2', {}, kids.some((k) => k.for !== null) ? 'Other ways to see it' : 'Inside this part'));
    const grid = h('ul', { class: 'cards' });
    for (const kid of kids) grid.append(h('li', {}, this.card(kid)));
    view.append(grid);
    if (next !== null) view.append(h('button', { type: 'button', class: 'btn main', 'data-act': 'next-part', onclick: () => this.go(next) }, 'Next part'));
    return view;
  }

  /** The end of a part with nothing under it: back to what asked for it, or on. */
  private finish(node: DocNode): HTMLElement {
    const up = parentOf(this.doc, node);
    const helping = up !== null && shutAsks(this.doc, this.state, up).length > 0;
    const next = afterOf(this.doc, node);
    const row = h('div', { class: 'finish-row' });
    if (helping && up !== null) row.append(h('button', { type: 'button', class: 'btn main', 'data-act': 'back-to', onclick: () => this.go(up) }, 'Try it now'));
    if (next !== null) row.append(h('button', { type: 'button', class: `btn ${helping ? 'soft' : 'main'}`, 'data-act': 'next-part', onclick: () => this.go(next) }, helping ? 'Skip to the next part' : 'Next part'));
    row.append(h('button', { type: 'button', class: 'btn soft', 'data-act': 'map-2', onclick: () => this.show({ kind: 'map', node: this.doc.root }) }, 'Map'));
    return h('section', { class: 'finish', 'data-act': 'finish' }, h('h2', {}, helping ? 'Now you try' : 'That is this part'), h('p', {}, helping ? 'Go back and write your answer.' : 'You have been all the way through it.'), row);
  }

  /**
   * The figure an ask is about, when the ask names one that is not a step's picture: `on=` a part (or the part's own crop). It is shown big, as the work surface,
   * with a ring where a hand taps (held on the part, so a reload finds it as she left it). Null when no ask in the run names a crop.
   */
  private surface(run: Run, node: DocNode): { readonly src: string; readonly ask: string } | null {
    for (const { step } of run.steps) {
      if (step.kind !== 'ask') continue;
      const on = (step as LessonAsk & { readonly on?: string }).on;
      if (on === undefined) continue;
      const src = this.input.crops[on] ?? this.input.crops[node.id];
      if (src !== undefined) return { src, ask: step.id };
    }
    return null;
  }

  private surfaceFigure(node: DocNode, surface: { readonly src: string; readonly ask: string }): HTMLElement {
    const key = `fig.${surface.ask}.marks`;
    const held = this.state.held[node.id]?.[key];
    const marks = Array.isArray(held) ? held.filter((x): x is number => typeof x === 'number') : [];
    const frame = h('div', { class: 'surface-frame' });
    const image = h('img', { class: 'surface-img', src: surface.src, alt: 'The figure the question is about. Tap it to mark a place.' });
    const put = (next: readonly number[]): void => {
      this.apply({ kind: 'held', node: node.id, key, value: [...next] });
      this.render();
    };
    frame.append(image);
    for (let i = 0; i + 1 < marks.length; i += 2) frame.append(h('span', { class: 'surface-ring', style: `left:${(marks[i] ?? 0) / 10}%;top:${(marks[i + 1] ?? 0) / 10}%` }));
    frame.addEventListener('click', (event) => {
      const box = image.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) return;
      const x = Math.round(((event as MouseEvent).clientX - box.left) / box.width * 1000);
      const y = Math.round(((event as MouseEvent).clientY - box.top) / box.height * 1000);
      if (x < 0 || y < 0 || x > 1000 || y > 1000 || marks.length >= 60) return;
      put([...marks, x, y]);
    });
    const row = h('div', { class: 'controls' });
    row.append(h('span', { class: 'readout' }, marks.length === 0 ? 'Tap the picture to mark a place.' : `Marked: ${marks.length / 2}`));
    if (marks.length > 0) {
      row.append(h('button', { type: 'button', class: 'btn soft', 'data-act': 'surface-undo', onclick: () => put(marks.slice(0, -2)) }, 'Undo'));
      row.append(h('button', { type: 'button', class: 'btn soft', 'data-act': 'surface-clear', onclick: () => put([]) }, 'Start again'));
    }
    return h('div', { class: 'fig surface', 'data-kind': 'surface', 'data-act': 'fig:surface' }, frame, row);
  }

  private run(run: Run, node: DocNode, mask: (text: string) => string, seal: (value: string | number) => string, shown: number): HTMLElement {
    const section = h('section', { class: `run${run.figure === null ? '' : ' has-fig'}` });
    if (run.figure !== null) {
      const figure = run.figure;
      const key = figure.key;
      const held = this.state.held[node.id] ?? {};
      const ctx: WidgetCtx = {
        key,
        get: (name): Held | undefined => held[`${key}.${name}`],
        set: (name, value) => {
          this.fresh = name;
          this.apply({ kind: 'held', node: node.id, key: `${key}.${name}`, value });
          this.render();
        },
        seal,
        fresh: this.fresh,
      };
      section.append(h('div', { class: 'fig', 'data-kind': figure.spec.kind, 'data-act': `fig:${figure.spec.kind}` }, drawVisual(figure.spec, ctx)));
    }
    const surface = run.figure === null ? this.surface(run, node) : null;
    if (surface !== null) {
      section.classList.add('has-fig');
      section.append(this.surfaceFigure(node, surface));
    }
    const says = h('div', { class: 'says' });
    for (const { step, index } of run.steps) {
      if (step.kind === 'step') {
        says.append(
          h(
            'article',
            { class: `say${index === shown - 1 ? ' latest' : ''}${this.justShown === index ? ' arrive' : ''}`, 'data-step': index },
            h('span', { class: 'say-n' }, String(index + 1)),
            h('p', { class: 'words' }, mask(step.words)),
          ),
        );
      } else says.append(this.ask(node, step, mask));
    }
    section.append(says);
    return section;
  }

  private ask(node: DocNode, ask: LessonAsk, mask: (text: string) => string): HTMLElement {
    const view = askView(this.doc, this.state, node.id, ask.id);
    if (view === null) return h('article', { class: 'ask closed' });
    const right = view.accepted ? view.tries.find((t) => accepts(ask, t)) : undefined;
    if (view.open && !view.refused) {
      return h(
        'article',
        { class: `ask closed${right === undefined ? ' worked' : ' right'}`, 'data-ask': ask.id },
        h('p', { class: 'ask-prompt' }, ask.prompt),
        right === undefined ? h('p', { class: 'verdict good' }, 'Let’s see how it works.') : h('p', { class: 'verdict good' }, h('span', { class: 'tick' }, '✓'), ask.check === 'done' ? ' Done.' : ask.check === 'any' ? ` ${right}` : ` Yes! ${right} is right.`),
        this.tries(node, ask),
      );
    }
    const card = h('article', { class: 'ask open', 'data-ask': ask.id, 'aria-label': 'Your turn' }, h('p', { class: 'ask-prompt' }, mask(ask.prompt)));
    if (view.refused) {
      card.append(h('p', { class: 'ask-note' }, 'Let’s work this one out together. Have a think, then press Next.'));
      return card;
    }
    if (ask.check === 'done') {
      // a tick: nothing to get right; the gate opens when it is pressed
      card.append(h('button', { type: 'button', class: 'btn main wide', 'data-act': 'done-tick', onclick: (e: Event) => this.tryAnswer(node, ask, 'done', e.timeStamp) }, 'Done'));
      return card;
    }
    if (ask.pick !== null) {
      const choices = h('div', { class: 'choices', role: 'group', 'aria-label': ask.check === 'any' ? 'Choose one' : 'Choose your answer' });
      for (const label of ask.pick) {
        const tried = view.tries.includes(label);
        const btn = h('button', { type: 'button', class: `choice${tried ? ' tried' : ''}`, 'data-act': `pick:${label}`, onclick: (e: Event) => this.tryAnswer(node, ask, label, e.timeStamp) }, label, ask.unit === null ? null : h('span', { class: 'unit' }, ` ${ask.unit}`));
        if (tried) btn.disabled = true;
        choices.append(btn);
      }
      card.append(choices);
    } else if (ask.check === 'order') {
      const held = this.state.held[node.id]?.[`order.${ask.id}`];
      card.append(
        orderWriting({
          items: ask.accepted,
          arranged: Array.isArray(held) ? held.filter((x): x is string => typeof x === 'string') : null,
          unit: ask.unit,
          seed: `${node.id}/${ask.id}`,
          onMove: (arranged) => this.apply({ kind: 'held', node: node.id, key: `order.${ask.id}`, value: [...arranged] }),
          onCheck: (arranged, stamp) => this.tryAnswer(node, ask, arranged.join(', '), stamp),
        }),
      );
    } else {
      const numeric = ask.accepted.every((a) => /^\d+$/.test(a.trim()));
      const decimal = ask.accepted.every((a) => /^[$\d.,\s]+[a-z]*$/i.test(a.trim()));
      if (this.input.ink === true && !this.typing.has(ask.id)) {
        card.append(
          inkWriting({
            node: node.id,
            ask: ask.id,
            unit: ask.unit,
            reading: this.reading === ask.id,
            note: this.unread?.ask === ask.id ? this.unread.said : null,
            verdict: view.wrong > 0 ? 'Not yet. Try again with the pencil.' : null,
            onCheck: () => {
              this.reading = ask.id;
              this.unread = null;
              this.render();
              this.port.inkCheck(node.id, ask.id);
            },
            onClear: () => {
              this.unread = null;
              this.port.inkClear(node.id, ask.id);
            },
            onType: () => {
              this.typing.add(ask.id);
              this.render();
            },
          }),
        );
        return this.hinted(card, view, ask, mask, node);
      }
      const writing = typedWriting({
        node: node.id,
        ask: ask.id,
        initial: this.draft[ask.id] ?? '',
        unit: ask.unit,
        inputmode: numeric ? 'numeric' : decimal ? 'decimal' : 'text',
        onInput: (text) => {
          this.draft[ask.id] = text;
        },
        onCheck: (text, stamp) => this.tryAnswer(node, ask, text, stamp),
      });
      writing.element.querySelector('input')?.addEventListener('focus', () => window.setTimeout(() => card.scrollIntoView({ block: 'center', behavior: 'smooth' }), 250));
      card.append(writing.element);
    }
    return this.hinted(card, view, ask, mask, node);
  }

  /** Her working for the tries of an ask, as she wrote it: a small picture of the strokes and the words read from them. Null when there is none. */
  private tries(node: DocNode, ask: LessonAsk): HTMLElement | null {
    const kept = this.input.working?.[`${node.id}\u0000${ask.id}`] ?? [];
    if (kept.length === 0) return null;
    const row = h('div', { class: 'tries', 'aria-label': 'What you wrote' });
    for (const item of kept) row.append(h('figure', { class: 'try' }, h('img', { src: item.src, alt: `What you wrote: ${item.text}` }), h('figcaption', {}, item.text === '' ? '' : `${item.n}. ${item.text}`)));
    return row;
  }

  private hinted(card: HTMLElement, view: NonNullable<ReturnType<typeof askView>>, ask: LessonAsk, mask: (text: string) => string, node?: DocNode): HTMLElement {
    const tried = node === undefined ? null : this.tries(node, ask);
    if (tried !== null) card.append(tried);
    if (view.wrong > 0) {
      const seen = node === undefined ? undefined : this.sees.get(`${node.id}\u0000${ask.id}`);
      card.append(h('div', { class: 'nudge', role: 'status' }, h('p', { class: 'verdict' }, seen === undefined ? 'Not yet. Have another look.' : 'Not yet.'), seen === undefined ? null : h('p', { class: 'sees' }, seen)));
    }
    // Help is the person's to pull: nothing shows until they tap Help, and one rung more each tap (labels are neutral defaults; the words of each rung are the brain's).
    // The rungs are the ask's hints, written as questions back to her (what do we know, what is it asking); a `[bracketed]` fact in one is marked in the question itself. The last
    // rung offers the question's ways to think it through, and then she has a go.
    if (node !== undefined && (ask.hints.length > 0 || kidsOf(this.doc, node).some((kid) => kid.for !== null))) {
      const key = `hint.${ask.id}`;
      const ways = kidsOf(this.doc, node).filter((kid) => kid.for !== null);
      const rungs = ask.hints.length + (ways.length > 0 ? 1 : 0);
      const heldNow = this.state.held[node.id]?.[key];
      const asked = Math.min(typeof heldNow === 'number' ? heldNow : 0, rungs);
      if (asked > 0) {
        const box = h('div', { class: 'nudge hints', role: 'status' });
        ask.hints.slice(0, asked).forEach((text, at) => box.append(h('p', { class: 'hint', 'data-hint': at + 1 }, mask(text).replace(/\[([^\]]+)\]/g, '$1'))));
        if (asked > ask.hints.length) {
          const row = h('div', { class: 'ways-row' }, h('p', { class: 'hint' }, 'Pick one to help.'));
          for (const way of ways) row.append(h('button', { type: 'button', class: 'btn soft', 'data-act': `think:${way.tag ?? ''}`, onclick: () => this.go(way) }, isTechnique(way.tag) ? TECHNIQUE_NAMES[way.tag] : way.title));
          box.append(row);
        }
        card.append(box);
      }
      if (asked < rungs) {
        card.append(
          h('button', { type: 'button', class: 'btn soft hint-btn', 'data-act': 'hint', onclick: () => {
            this.apply({ kind: 'held', node: node.id, key, value: asked + 1 });
            this.render();
            // the hint she has just opened is read aloud
            const opened = [...this.root.querySelectorAll<HTMLElement>('.nudge.hints .hint[data-hint]')].pop();
            if (opened?.textContent) this.port.say(opened.textContent, false);
            requestAnimationFrame(() => this.revealBelowPaper('.nudge.hints'));
          } }, asked === 0 ? 'Help' : 'More'),
        );
      } else if (asked > 0) {
        card.append(h('button', { type: 'button', class: 'btn main hint-btn', 'data-act': 'have-a-go', onclick: () => this.root.querySelector<HTMLElement>('.field, [data-slot]')?.focus() }, 'Try it'));
      }
    }
    return card;
  }

  private dock(node: DocNode, shown: number, count: number, gated: boolean, waiting: boolean, over: boolean): HTMLElement {
    const up = parentOf(this.doc, node);
    const back = h('button', { type: 'button', class: 'btn soft', 'data-act': 'back', onclick: () => this.back(node) }, shown <= 1 ? (up !== null && up.id !== this.doc.root ? 'Up' : 'Map') : 'Back');
    let primary: HTMLElement | null = null;
    if (gated) primary = null;
    else if (shown < count) primary = h('button', { type: 'button', class: 'btn main', 'data-act': 'next', onclick: () => this.next(node) }, 'Next');
    else if (count > 0 && waiting) primary = h('button', { type: 'button', class: 'btn main grow', 'data-act': 'next', disabled: true }, 'Getting the next step ready…');
    else if (!over) primary = null;
    return h('footer', { class: 'dock' }, back, primary);
  }

  // ------------------------------------------------------------ the catalogue

  private catalogue(): HTMLElement {
    const entries = this.input.catalogue;
    const view = h('main', { class: 'catalogue' }, h('h1', { class: 'title' }, 'My documents'));
    const seg = h('div', { class: 'seg-control', role: 'tablist' });
    (['sheet', 'technique'] as const).forEach((mode) => {
      seg.append(h('button', { type: 'button', class: `segb${this.by === mode ? ' on' : ''}`, role: 'tab', 'aria-selected': this.by === mode, 'data-act': `by:${mode}`, onclick: () => { this.by = mode; this.render(); } }, mode === 'sheet' ? 'By document' : 'By way of thinking'));
    });
    view.append(seg);
    if (this.by === 'sheet') {
      for (const entry of entries) view.append(this.entryCard(entry));
    } else {
      const groups = new Map<Technique, { entry: CatalogueEntry; id: string; title: string; done: boolean }[]>();
      for (const entry of entries) for (const q of entry.questions) for (const t of q.techniques) groups.set(t, [...(groups.get(t) ?? []), { entry, id: q.id, title: q.title, done: q.done }]);
      for (const [technique, rows] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
        const block = h('section', { class: 'tgroup' }, h('h2', {}, glyph(technique), ` ${TECHNIQUE_NAMES[technique]}`, h('span', { class: 'count' }, `${rows.length}`)));
        for (const row of rows) block.append(h('button', { type: 'button', class: `ctx-row${row.done ? ' done' : ''}`, 'data-act': `open:${row.entry.id}:${row.id}`, onclick: () => this.openEntry(row.entry, row.id) }, h('span', { class: 'ctx-num' }, row.done ? '✓' : '•'), h('span', { class: 'ctx-text' }, splitNumber(row.title).text), h('span', { class: 'ctx-note' }, row.entry.title)));
        view.append(block);
      }
    }
    if (entries.length === 0) view.append(h('p', { class: 'sub' }, 'Nothing here yet. What you start will be kept here.'));
    return view;
  }

  private entryCard(entry: CatalogueEntry): HTMLElement {
    const done = entry.questions.filter((q) => q.done).length;
    const card = h('section', { class: `sheetcard${entry.current ? ' current' : ''}` }, h('h2', {}, entry.title), h('p', { class: 'sub' }, `${done} of ${entry.questions.length} done`));
    const list = h('ul', { class: 'qlist' });
    for (const q of entry.questions) list.append(h('li', {}, h('button', { type: 'button', class: `ctx-row${q.done ? ' done' : ''}`, 'data-act': `open:${entry.id}:${q.id}`, onclick: () => this.openEntry(entry, q.id) }, h('span', { class: 'ctx-num' }, q.done ? '✓' : '•'), h('span', { class: 'ctx-text' }, splitNumber(q.title).text), h('span', { class: 'ctx-note' }, q.techniques.map((t) => TECHNIQUE_NAMES[t]).join(', ')))));
    card.append(list);
    return card;
  }

  private openEntry(entry: CatalogueEntry, node: string): void {
    const target = nodeOf(this.doc, node);
    if (entry.current && target !== null) this.go(target, 0);
    else this.port.open(entry.id);
  }

  // ------------------------------------------------------------ for the brain and the census

  /** The view as the brain is told of it (`HERE`): where she is, what is on stage, what she holds. */
  describe(): string {
    if (this.screen !== null) return this.screen.kind === 'catalogue' ? 'HERE the list of her documents.' : `HERE the map of "${this.doc.title}".`;
    const node = this.here;
    if (node === null) return `HERE the document "${this.doc.title}".`;
    if (this.isMap(node)) return `HERE the map of "${node.title}".`;
    const steps = stepsOf(node);
    const shown = shownOf(this.doc, this.state, node);
    const asks = steps.slice(0, shown).filter((s): s is LessonAsk => s.kind === 'ask');
    const tried = asks.map((a) => `${a.id}: ${(this.state.progress[node.id]?.tries[a.id] ?? []).map((t) => `"${t}"`).join(', ') || 'not tried'}`).join('; ');
    const stage = runsOf(steps, shown).flatMap((r) => (r.figure === null ? [] : [r.figure.spec.kind])).join(', ');
    const held = Object.entries(this.state.held[node.id] ?? {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
    return `HERE ${node.id} step ${shown} of ${steps.length}. On stage: card "${node.title}"${stage === '' ? '' : `; ${stage}`}. Tried: ${tried === '' ? 'nothing yet' : tried}. Held: ${held === '' ? 'nothing' : held}`;
  }

  /** How many steps she has been shown on the part she is on (0 off a part). */
  shownSteps(): number {
    if (this.screen !== null) return 0;
    const node = this.here;
    return node === null ? 0 : shownOf(this.doc, this.state, node);
  }

  /** What is sealed on the page now: what the census looks for on screen. */
  sealedNow(): { readonly open: readonly OpenAsk[] } {
    if (this.screen !== null) return { open: [] };
    const node = this.here;
    return { open: node === null ? [] : shutAsks(this.doc, this.state, node) };
  }

  get shownNode(): DocNode | null {
    return this.screen === null ? this.here : null;
  }

  /** Whether the part drawn is one that has anything of its own: used by the census to tell a map from a part. */
  get tallies(): { readonly done: number; readonly total: number } {
    const root = nodeOf(this.doc, this.doc.root);
    return root === null ? { done: 0, total: 0 } : tally(this.doc, this.state, root);
  }
}
