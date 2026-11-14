// The lesson player: the sheet's outline, a question and its ways, a way's steps as a worked page, her tries and the hints, and the
// catalogue's list. It runs inside the sandboxed surface (program.ts boots it), draws with the browser's own layout and real inputs, and keeps
// section 3's six rules in code it owns:
//
//   1. the question is a card at the top of every step (sticky, headline type, its crop of the photo beside it);
//   2. the picture has the lead room (about half the width on a desk, the whole width on a phone, counters at least 36 pixels);
//   3. steps stack into a worked page, nothing shown is taken away (a picture of the same kind is carried and grown, not redrawn);
//   4. a picture is worked by hand (widgets/*), its state kept in `held`;
//   5. a choice is a target of 72 pixels or more, a typed answer is a real field with the number keys;
//   6. an open ask seals its answer: whatever draws goes through `sealed`/`maskSealed`, and nothing past the gate is drawn.
//
// The document, the cursor, her tries and the gates are WS3's `advance` and `askView`; this file never writes state any other way.

import { accepts, advance, maskSealed, sealed } from '@conduit/language';
import type { DocEvent } from '@conduit/language';
import { h } from './dom';
import { atOf, gateOf, questionDone, runsOf, shownOf, shutAsks, sheetOf, viewOf, wayDone, wayOf } from './model';
import type { Question, Run, Sheet, Way } from './model';
import { TECHNIQUE_NAMES } from './types';
import type { CatalogueEntry, DocState, Held, LessonAsk, LessonEvent, LessonInput, OpenAsk, Technique } from './types';
import { drawVisual } from './widgets';
import type { WidgetCtx } from './widgets/common';

export interface PlayerPort {
  save(state: DocState): void;
  emit(event: LessonEvent): void;
  /** the screen changed: a fresh census may be taken */
  changed(): void;
}

/** What is on screen when it is not the way the cursor rests on. Ephemeral: the cursor is what is kept. */
type Screen = { readonly kind: 'outline' } | { readonly kind: 'catalogue' } | { readonly kind: 'ways'; readonly question: string } | null;

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

  constructor(
    private readonly root: HTMLElement,
    input: LessonInput,
    private readonly port: PlayerPort,
  ) {
    this.input = input;
    this.state = input.state;
    const here = wayOf(sheetOf(input.doc), input.state.cursor.node);
    // a sheet she has not begun opens on its list; one she has begun opens where she was
    this.screen = here === null || (input.state.progress[here.way.node.id]?.seen ?? 0) === 0 ? { kind: 'outline' } : null;
  }

  /** The document grew (a way was written, a step arrived): draw again, keep the place. */
  update(input: LessonInput): void {
    this.input = { ...input, state: this.state };
    this.render();
  }

  get current(): DocState {
    return this.state;
  }
  get lastTryMs(): number | null {
    return this.tryMs;
  }
  get sheet(): Sheet {
    return sheetOf(this.input.doc);
  }
  get shownScreen(): 'outline' | 'question' | 'play' | 'catalogue' {
    if (this.screen === null) return wayOf(this.sheet, this.state.cursor.node) === null ? 'outline' : 'play';
    return this.screen.kind === 'ways' ? 'question' : this.screen.kind;
  }

  // ------------------------------------------------------------ changes

  private apply(event: DocEvent): void {
    const next = advance(this.input.doc, this.state, event);
    if (next === this.state) return;
    this.state = next;
    this.port.save(next);
  }

  private show(screen: Screen): void {
    this.screen = screen;
    this.render();
    window.scrollTo(0, 0);
  }

  private openWay(way: Way): void {
    const finished = wayDone(this.state, way);
    this.screen = null;
    this.justShown = null;
    this.apply({ kind: 'go', node: way.node.id, at: finished ? { at: 0 } : 'resume' });
    this.port.emit({ kind: 'open', node: way.node.id });
    this.render();
    window.scrollTo(0, 0);
  }

  private tryAnswer(way: Way, ask: LessonAsk, text: string, stamp: number): void {
    const clean = text.trim();
    if (clean === '') return;
    const was = wayDone(this.state, way);
    this.apply({ kind: 'try', node: way.node.id, ask: ask.id, value: clean });
    const view = viewOf(this.input.doc, this.state, way, ask);
    this.port.emit({ kind: 'try', node: way.node.id, ask: ask.id, text: clean.slice(0, 80), right: accepts(ask, clean), hint: view === null || accepts(ask, clean) ? 0 : Math.min(view.wrong, ask.hints.length) });
    delete this.draft[ask.id];
    if (!was && wayDone(this.state, way)) this.port.emit({ kind: 'done', node: way.node.id });
    this.render();
    this.tryMs = Math.round(performance.now() - stamp);
    requestAnimationFrame(() => this.root.querySelector('.nudge, .ask.closed:last-of-type')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    this.port.changed();
  }

  private next(way: Way): void {
    const at = atOf(this.state);
    if (at >= way.steps.length - 1) return;
    this.justShown = at + 1;
    this.apply({ kind: 'next' });
    this.port.emit({ kind: 'step', node: way.node.id, at: at + 2 });
    this.render();
    this.scrollToLatest();
  }
  private back(question: Question): void {
    this.justShown = null;
    if (atOf(this.state) > 0) {
      this.apply({ kind: 'back' });
      this.render();
    } else this.show({ kind: 'ways', question: question.node.id });
  }

  private scrollToLatest(): void {
    requestAnimationFrame(() => {
      const el = this.root.querySelector('.say.latest, .ask.open');
      if (el instanceof HTMLElement) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }

  // ------------------------------------------------------------ drawing

  render(): void {
    const keep = document.activeElement instanceof HTMLElement ? { act: document.activeElement.dataset['act'], at: document.activeElement instanceof HTMLInputElement ? document.activeElement.selectionStart : null } : null;
    const x = window.scrollX;
    const y = window.scrollY;
    const where = this.shownScreen;
    const page = h('div', { class: `page view-${where}` });
    page.append(this.header());
    const sheet = this.sheet;
    if (where === 'catalogue') page.append(this.catalogue());
    else if (where === 'outline') page.append(this.outline());
    else if (this.screen !== null && this.screen.kind === 'ways') {
      const id = this.screen.question;
      const q = sheet.questions.find((n) => n.node.id === id);
      if (q !== undefined) page.append(this.questionCard(q), this.ways(q));
    } else {
      const here = wayOf(sheet, this.state.cursor.node);
      if (here !== null) this.play(page, here.question, here.way);
    }
    this.root.replaceChildren(page);
    window.scrollTo(x, y);
    this.watch();
    this.fit();
    this.root.querySelector('.tab.on')?.scrollIntoView({ block: 'nearest', inline: 'center' });
    this.root.querySelectorAll('.fig').forEach((fig) => fig.classList.toggle('tall', fig.getBoundingClientRect().height > window.innerHeight * 0.46));
    if (keep?.act === 'answer') {
      const field = this.root.querySelector('[data-act="answer"]');
      if (field instanceof HTMLInputElement) {
        field.focus({ preventScroll: true });
        if (keep.at !== null) field.setSelectionRange(keep.at, keep.at);
      }
    }
    this.port.changed();
  }

  /** A question that has scrolled to the top of the screen is "docked": on a phone it shows fewer lines and opens to the whole on a tap. */
  private watch(): void {
    this.watcher?.disconnect();
    this.watcher = null;
    const mark = this.root.querySelector('.sentinel');
    if (mark === null || typeof IntersectionObserver === 'undefined') return;
    this.watcher = new IntersectionObserver((entries) => {
      const gone = entries.some((entry) => !entry.isIntersecting && entry.boundingClientRect.top < 0);
      if (gone === this.docked) return;
      this.docked = gone;
      const card = this.root.querySelector('.qcard');
      if (card instanceof HTMLElement) card.classList.toggle('docked', gone);
      this.fit();
      this.port.changed();
    });
    this.watcher.observe(mark);
  }

  /** The height of the question card is the top the picture sticks under. */
  private fit(): void {
    const card = this.root.querySelector('.qcard');
    const top = card instanceof HTMLElement ? card.getBoundingClientRect().height + 8 : 0;
    document.documentElement.style.setProperty('--qh', `${Math.round(top)}px`);
  }

  private header(): HTMLElement {
    const sheet = this.sheet;
    const here = wayOf(sheet, this.state.cursor.node);
    const q = this.screen === null && here !== null ? here.question : null;
    return h(
      'header',
      { class: 'topbar' },
      h('button', { type: 'button', class: 'nav', 'data-act': 'outline', onclick: () => this.show({ kind: 'outline' }) }, 'All questions'),
      h('span', { class: 'crumb' }, q === null ? sheet.title : `${sheet.title}  ·  question ${q.number} of ${sheet.questions.length}`),
      this.input.catalogue.length > 0 ? h('button', { type: 'button', class: 'nav', 'data-act': 'catalogue', onclick: () => this.show({ kind: 'catalogue' }) }, 'My sheets') : null,
    );
  }

  private outline(): HTMLElement {
    const sheet = this.sheet;
    const done = sheet.questions.filter((q) => questionDone(q, this.state)).length;
    const view = h('main', { class: 'outline' }, h('h1', { class: 'title' }, sheet.title), h('p', { class: 'sub' }, `${done} of ${sheet.questions.length} questions done`));
    const resume = wayOf(sheet, this.state.cursor.node);
    if (resume !== null && !wayDone(this.state, resume.way) && (this.state.progress[resume.way.node.id]?.seen ?? 0) > 0) {
      const { way, question } = resume;
      view.append(
        h(
          'button',
          { type: 'button', class: 'resume', 'data-act': 'resume', onclick: () => this.openWay(way) },
          h('span', { class: 'resume-kicker' }, 'Carry on where you were'),
          h('span', { class: 'resume-text' }, `Question ${question.number}: ${way.node.title}`),
          h('span', { class: 'resume-step' }, `step ${Math.min(this.state.progress[way.node.id]?.seen ?? 0, way.steps.length)} of ${way.steps.length}`),
        ),
      );
    }
    for (const section of sheet.sections) {
      const block = h('section', { class: 'section' });
      if (section.node !== null) block.append(h('h2', {}, section.node.title));
      const list = h('ul', { class: 'qlist' });
      for (const q of section.questions) {
        const ready = q.ways.filter((w) => w.ready).length;
        const isDone = questionDone(q, this.state);
        const note = isDone ? 'Done' : ready > 0 ? `${ready} ${ready === 1 ? 'way' : 'ways'} to try` : 'Getting ready…';
        list.append(
          h(
            'li',
            {},
            h(
              'button',
              { type: 'button', class: `qrow${isDone ? ' done' : ''}${ready === 0 ? ' wait' : ''}`, 'data-act': `q:${q.node.id}`, onclick: () => { this.port.emit({ kind: 'open', node: q.node.id }); this.show({ kind: 'ways', question: q.node.id }); } },
              h('span', { class: 'qnum' }, isDone ? '✓' : String(q.number)),
              h('span', { class: 'qtext' }, q.node.title),
              h('span', { class: 'qnote' }, note),
            ),
          ),
        );
      }
      block.append(list);
      view.append(block);
    }
    return view;
  }

  private questionCard(q: Question): HTMLElement {
    const crop = this.input.crops[q.node.id];
    const long = q.node.title.length > 70;
    const more = long ? h('button', { type: 'button', class: 'more', 'data-act': 'more', 'aria-expanded': String(this.expanded) }, this.expanded ? 'Show less' : 'Read it all') : null;
    const card = h(
      'section',
      { class: `qcard${crop === undefined ? '' : ' with-crop'}${long ? ' long' : ''}${this.docked ? ' docked' : ''}${this.expanded ? ' expanded' : ''}`, 'data-act': 'question', 'aria-label': 'The question' },
      h('span', { class: 'qkicker' }, `Question ${q.number}`),
      more,
      h('p', { class: 'qtext' }, q.node.title),
      crop === undefined ? null : h('img', { class: 'crop', src: crop, alt: 'The question as it is written on the page' }),
    );
    more?.addEventListener('click', () => {
      this.expanded = !this.expanded;
      card.classList.toggle('expanded', this.expanded);
      more.textContent = this.expanded ? 'Show less' : 'Read it all';
      more.setAttribute('aria-expanded', String(this.expanded));
      this.fit();
      this.port.changed();
    });
    return h('div', { class: 'qwrap' }, h('div', { class: 'sentinel', 'aria-hidden': 'true' }), card);
  }

  private ways(q: Question): HTMLElement {
    const view = h('main', { class: 'ways' }, h('h2', {}, q.ways.length === 0 ? 'Getting some ways ready for you…' : 'Pick a way to work it out'));
    if (q.ways.length === 0) view.append(h('p', { class: 'wait-note' }, 'This takes a moment. You can look at another question while you wait.'));
    for (const way of q.ways) {
      const seen = this.state.progress[way.node.id]?.seen ?? 0;
      const finished = wayDone(this.state, way);
      const steps = way.steps.length;
      const note = !way.ready ? 'Getting ready…' : finished ? 'You did this one' : seen > 0 ? `Step ${Math.min(seen, steps)} of ${steps}` : `${steps} ${steps === 1 ? 'step' : 'steps'}`;
      const card = h(
        'button',
        { type: 'button', class: `way${finished ? ' done' : ''}`, 'data-act': `way:${way.node.id}`, onclick: () => this.openWay(way) },
        glyph(way.technique),
        h('span', { class: 'way-body' }, h('span', { class: 'way-tech' }, way.technique === null ? 'A way' : TECHNIQUE_NAMES[way.technique]), h('span', { class: 'way-title' }, way.node.title)),
        h('span', { class: 'way-note' }, note),
      );
      if (!way.ready) card.disabled = true;
      view.append(card);
    }
    return view;
  }

  // ------------------------------------------------------------ playing a way

  /** What may not be on screen now, and how a drawer says a word or a number through it. */
  private sealing(q: Question, way: Way): { readonly open: readonly OpenAsk[]; readonly words: (text: string) => string; readonly seal: (value: string | number) => string } {
    const open = shutAsks(this.input.doc, this.state, way, q.node.title);
    return { open, words: (text) => maskSealed(text, open), seal: (value) => (sealed(value, open) ? '?' : String(value)) };
  }

  private play(page: HTMLElement, q: Question, way: Way): void {
    const shown = shownOf(way, this.state);
    const seal = this.sealing(q, way);
    page.append(this.questionCard(q), this.tabs(q, way));
    const main = h('main', { class: 'work' });
    for (const run of runsOf(way, shown)) main.append(this.run(run, way, seal, shown));
    const gate = gateOf(this.input.doc, this.state, way);
    const filling = way.node.status === 'filling' || way.node.status === 'outlined';
    const finished = shown >= way.steps.length && gate === null && !filling;
    if (finished) main.append(this.finish(q, way));
    page.append(main);
    page.append(this.dock(q, way, shown, gate !== null, filling, finished));
  }

  private tabs(q: Question, way: Way): HTMLElement {
    const bar = h('nav', { class: 'tabs', 'aria-label': 'Ways to work it out' });
    for (const w of q.ways) {
      const on = w.node.id === way.node.id;
      const tab = h('button', { type: 'button', class: `tab${on ? ' on' : ''}`, 'data-act': `tab:${w.node.id}`, 'aria-current': on ? 'true' : null, onclick: () => { if (!on) this.openWay(w); } }, w.technique === null ? w.node.title : TECHNIQUE_NAMES[w.technique]);
      if (!w.ready) tab.disabled = true;
      bar.append(tab);
    }
    return bar;
  }

  private run(run: Run, way: Way, seal: ReturnType<Player['sealing']>, shown: number): HTMLElement {
    const section = h('section', { class: `run${run.figure === null ? '' : ' has-fig'}` });
    if (run.figure !== null) {
      const figure = run.figure;
      const key = figure.key;
      const held = this.state.held[way.node.id] ?? {};
      const ctx: WidgetCtx = {
        key,
        get: (name): Held | undefined => held[`${key}.${name}`],
        set: (name, value) => {
          this.fresh = name;
          this.apply({ kind: 'held', node: way.node.id, key: `${key}.${name}`, value });
          this.port.emit({ kind: 'hold', node: way.node.id, key: `${key}.${name}`, value });
          this.render();
        },
        seal: seal.seal,
        fresh: this.fresh,
      };
      section.append(h('div', { class: 'fig', 'data-kind': figure.spec.kind, 'data-act': `fig:${figure.spec.kind}` }, drawVisual(figure.spec, ctx)));
    }
    const says = h('div', { class: 'says' });
    for (const { step, index } of run.steps) {
      if (step.kind === 'step') {
        says.append(
          h(
            'article',
            { class: `say${index === shown - 1 ? ' latest' : ''}${this.justShown === index ? ' arrive' : ''}`, 'data-step': index },
            h('span', { class: 'say-n' }, String(index + 1)),
            h('p', { class: 'words' }, seal.words(step.words)),
          ),
        );
      } else says.append(this.ask(way, step, seal.words));
    }
    section.append(says);
    return section;
  }

  private ask(way: Way, ask: LessonAsk, words: (text: string) => string): HTMLElement {
    const view = viewOf(this.input.doc, this.state, way, ask);
    if (view === null) return h('article', { class: 'ask closed' });
    const right = view.accepted ? view.tries.find((t) => accepts(ask, t)) : undefined;
    if (view.open && !view.refused) {
      return h(
        'article',
        { class: `ask closed${right === undefined ? ' worked' : ' right'}`, 'data-ask': ask.id },
        h('p', { class: 'ask-prompt' }, ask.prompt),
        h('p', { class: 'verdict good' }, right === undefined ? 'Let’s see how it works.' : `Yes! ${right} is right.`),
      );
    }
    const card = h('article', { class: 'ask open', 'data-ask': ask.id, 'aria-label': 'Your turn' }, h('p', { class: 'ask-prompt' }, words(ask.prompt)));
    if (view.refused) {
      card.append(h('p', { class: 'ask-note' }, 'Let’s work this one out together. Have a think, then press Next.'));
      return card;
    }
    if (ask.pick !== null) {
      const choices = h('div', { class: 'choices', role: 'group', 'aria-label': 'Choose your answer' });
      for (const label of ask.pick) {
        const tried = view.tries.includes(label);
        const btn = h('button', { type: 'button', class: `choice${tried ? ' tried' : ''}`, 'data-act': `pick:${label}`, onclick: (e: Event) => this.tryAnswer(way, ask, label, e.timeStamp) }, label, ask.unit === null ? null : h('span', { class: 'unit' }, ` ${ask.unit}`));
        if (tried) btn.disabled = true;
        choices.append(btn);
      }
      card.append(choices);
    } else {
      const numeric = ask.accepted.every((a) => /^\d+$/.test(a.trim()));
      const decimal = ask.accepted.every((a) => /^[$\d.,\s]+[a-z]*$/i.test(a.trim()));
      const field = h('input', {
        class: 'field',
        'data-act': 'answer',
        type: 'text',
        inputmode: numeric ? 'numeric' : decimal ? 'decimal' : 'text',
        enterkeyhint: 'done',
        autocomplete: 'off',
        autocapitalize: 'none',
        spellcheck: false,
        'aria-label': 'Your answer',
        placeholder: 'Type your answer',
      });
      field.value = this.draft[ask.id] ?? '';
      field.addEventListener('input', () => {
        this.draft[ask.id] = field.value;
      });
      const submit = (e: Event): void => this.tryAnswer(way, ask, field.value, e.timeStamp);
      field.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submit(e);
      });
      field.addEventListener('focus', () => window.setTimeout(() => card.scrollIntoView({ block: 'center', behavior: 'smooth' }), 250));
      card.append(h('div', { class: 'answer-row' }, field, ask.unit === null ? null : h('span', { class: 'unit' }, ask.unit), h('button', { type: 'button', class: 'btn main check', 'data-act': 'check', onclick: submit }, 'Check')));
    }
    if (view.wrong > 0) {
      const feedback = h('div', { class: 'nudge', role: 'status' }, h('p', { class: 'verdict' }, 'Not yet. Have another look.'));
      if (view.hint !== null) feedback.append(h('p', { class: 'hint' }, h('b', {}, `Hint ${Math.min(view.wrong, ask.hints.length)}: `), words(view.hint)));
      card.append(feedback);
    }
    return card;
  }

  private finish(q: Question, way: Way): HTMLElement {
    const next = this.sheet.questions.find((n) => n.number === q.number + 1);
    const others = q.ways.filter((w) => w.ready && w.node.id !== way.node.id);
    return h(
      'section',
      { class: 'finish', 'data-act': 'finish' },
      h('h2', {}, 'You worked it out!'),
      h('p', {}, others.length > 0 ? 'That is one way. Want to see how another way does it?' : 'That is one way to do it.'),
      h(
        'div',
        { class: 'finish-row' },
        others.length > 0 ? h('button', { type: 'button', class: 'btn main', 'data-act': 'another', onclick: () => this.show({ kind: 'ways', question: q.node.id }) }, 'Try another way') : null,
        next === undefined ? null : h('button', { type: 'button', class: `btn ${others.length > 0 ? 'soft' : 'main'}`, 'data-act': 'next-question', onclick: () => this.show({ kind: 'ways', question: next.node.id }) }, 'Next question'),
        h('button', { type: 'button', class: 'btn soft', 'data-act': 'outline-2', onclick: () => this.show({ kind: 'outline' }) }, 'All questions'),
      ),
    );
  }

  private dock(q: Question, way: Way, shown: number, gated: boolean, filling: boolean, finished: boolean): HTMLElement {
    const back = h('button', { type: 'button', class: 'btn soft', 'data-act': 'back', onclick: () => this.back(q) }, shown <= 1 ? 'Ways' : 'Back');
    let primary: HTMLElement | null;
    if (finished) primary = null;
    else if (gated) primary = h('button', { type: 'button', class: 'btn main grow', 'data-act': 'next', disabled: true }, 'Answer to go on');
    else if (shown < way.steps.length) primary = h('button', { type: 'button', class: 'btn main grow', 'data-act': 'next', onclick: () => this.next(way) }, 'Next');
    else primary = h('button', { type: 'button', class: 'btn main grow', 'data-act': 'next', disabled: true }, filling ? 'Getting the next step ready…' : 'Next');
    return h('footer', { class: 'dock' }, back, primary);
  }

  // ------------------------------------------------------------ the catalogue

  private catalogue(): HTMLElement {
    const entries = this.input.catalogue;
    const view = h('main', { class: 'catalogue' }, h('h1', { class: 'title' }, 'My sheets'));
    const seg = h('div', { class: 'seg-control', role: 'tablist' });
    (['sheet', 'technique'] as const).forEach((mode) => {
      seg.append(h('button', { type: 'button', class: `segb${this.by === mode ? ' on' : ''}`, role: 'tab', 'aria-selected': this.by === mode, 'data-act': `by:${mode}`, onclick: () => { this.by = mode; this.render(); } }, mode === 'sheet' ? 'By sheet' : 'By way of thinking'));
    });
    view.append(seg);
    if (this.by === 'sheet') {
      for (const entry of entries) view.append(this.sheetCard(entry));
    } else {
      const groups = new Map<Technique, { sheet: CatalogueEntry; id: string; title: string; done: boolean }[]>();
      for (const entry of entries) for (const q of entry.questions) for (const t of q.techniques) groups.set(t, [...(groups.get(t) ?? []), { sheet: entry, id: q.id, title: q.title, done: q.done }]);
      for (const [technique, rows] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
        const block = h('section', { class: 'tgroup' }, h('h2', {}, glyph(technique), ` ${TECHNIQUE_NAMES[technique]}`, h('span', { class: 'count' }, `${rows.length}`)));
        for (const row of rows) block.append(h('button', { type: 'button', class: `qrow${row.done ? ' done' : ''}`, 'data-act': `open:${row.sheet.id}:${row.id}`, onclick: () => this.openEntry(row.sheet, row.id) }, h('span', { class: 'qnum' }, row.done ? '✓' : '•'), h('span', { class: 'qtext' }, row.title), h('span', { class: 'qnote' }, row.sheet.title)));
        view.append(block);
      }
    }
    if (entries.length === 0) view.append(h('p', { class: 'sub' }, 'Nothing here yet. A sheet you start will be kept here.'));
    return view;
  }

  private sheetCard(entry: CatalogueEntry): HTMLElement {
    const done = entry.questions.filter((q) => q.done).length;
    const card = h('section', { class: `sheetcard${entry.current ? ' current' : ''}` }, h('h2', {}, entry.title), h('p', { class: 'sub' }, `${done} of ${entry.questions.length} done`));
    const list = h('ul', { class: 'qlist' });
    for (const q of entry.questions) list.append(h('li', {}, h('button', { type: 'button', class: `qrow${q.done ? ' done' : ''}`, 'data-act': `open:${entry.id}:${q.id}`, onclick: () => this.openEntry(entry, q.id) }, h('span', { class: 'qnum' }, q.done ? '✓' : '•'), h('span', { class: 'qtext' }, q.title), h('span', { class: 'qnote' }, q.techniques.map((t) => TECHNIQUE_NAMES[t]).join(', ')))));
    card.append(list);
    return card;
  }

  private openEntry(entry: CatalogueEntry, question: string): void {
    if (entry.current) this.show({ kind: 'ways', question });
    else this.port.emit({ kind: 'document', id: entry.id });
  }

  // ------------------------------------------------------------ for the brain and the census

  /** The page as the brain is told of it (`HERE`): where she is, what is on stage, what she holds. */
  here(): string {
    const sheet = this.sheet;
    if (this.screen !== null) {
      if (this.screen.kind === 'ways') {
        const id = this.screen.question;
        const q = sheet.questions.find((n) => n.node.id === id);
        return q === undefined ? `HERE the sheet "${sheet.title}".` : `HERE question ${q.number} "${q.node.title}", choosing a way (${q.ways.length} offered).`;
      }
      return this.screen.kind === 'catalogue' ? 'HERE the list of her sheets.' : `HERE the sheet "${sheet.title}", the list of questions.`;
    }
    const here = wayOf(sheet, this.state.cursor.node);
    if (here === null) return `HERE the sheet "${sheet.title}", the list of questions.`;
    const shown = shownOf(here.way, this.state);
    const asks = here.way.steps.slice(0, shown).filter((s): s is LessonAsk => s.kind === 'ask');
    const tried = asks.map((a) => `${a.id}: ${(this.state.progress[here.way.node.id]?.tries[a.id] ?? []).map((t) => `"${t}"`).join(', ') || 'not tried'}`).join('; ');
    const stage = runsOf(here.way, shown).flatMap((r) => (r.figure === null ? [] : [r.figure.spec.kind])).join(', ');
    const held = Object.entries(this.state.held[here.way.node.id] ?? {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
    return `HERE ${here.way.node.id} step ${shown} of ${here.way.steps.length}. On stage: question card "${here.question.node.title}"${stage === '' ? '' : `; ${stage}`}. Tried: ${tried === '' ? 'nothing yet' : tried}. Held: ${held === '' ? 'nothing' : held}`;
  }

  /** How many steps she has been shown on the way she is on (0 off a way). */
  shownSteps(): number {
    if (this.screen !== null) return 0;
    const here = wayOf(this.sheet, this.state.cursor.node);
    return here === null ? 0 : shownOf(here.way, this.state);
  }

  /** What is sealed on the page now, and the question's own words: what the census looks for on screen. */
  sealedNow(): { readonly open: readonly OpenAsk[]; readonly question: string } {
    if (this.screen !== null) return { open: [], question: '' };
    const here = wayOf(this.sheet, this.state.cursor.node);
    return here === null ? { open: [], question: '' } : { open: shutAsks(this.input.doc, this.state, here.way, here.question.node.title), question: here.question.node.title };
  }
}
