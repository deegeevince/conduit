// The lesson player: the sheet's outline, a question and its ways, a way's steps as a worked page, her tries and the hints, and the
// catalogue's list. It runs inside the sandboxed surface (program.ts boots it), draws with the browser's own layout and real inputs, and keeps
// section 3's six rules in code it owns:
//
//   1. the question is a card at the top of every step (sticky, headline type, its crop of the photo beside it);
//   2. the picture has the lead room (about half the width on a desk, the whole width on a phone, counters at least 34 pixels);
//   3. steps stack into a worked page, nothing shown is taken away (a picture of the same kind is carried and grown, not redrawn);
//   4. a picture is worked by hand (widgets/*), its state kept in `held`;
//   5. a choice is a target of 72 pixels or more, a typed answer is a real field with the number keys;
//   6. an open ask seals its answer: whatever draws goes through `sealed`/`sealText`, and nothing past the gate is drawn.

import { matches, sealText, sealed } from './answer';
import { h } from './dom';
import { advance, gateOf, passed, progressOf, questionDone, questionOf, reach, rightOf, runsOf, sealedAsks, sheetOf, stopOf, whereOf, wayFinished, wrongTries } from './model';
import type { Question, Run, Sheet, Way } from './model';
import { WORKED } from './types';
import type { Ask, CatalogueEntry, DocState, Held, LessonChange, LessonEvent, LessonInput, Technique } from './types';
import { TECHNIQUE_NAMES } from './types';
import { drawVisual } from './widgets';
import type { WidgetCtx } from './widgets/common';

export interface PlayerPort {
  save(state: DocState): void;
  emit(event: LessonEvent): void;
  /** the screen changed: a fresh census may be taken */
  changed(): void;
}

type Screen = 'outline' | 'catalogue' | null;

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
  private screen: Screen = null;
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
    this.screen = whereOf(sheetOf(input.doc), input.state).view === 'outline' ? 'outline' : null;
  }

  /** The document grew (a way was written, a step arrived): draw again, keep the place. */
  update(input: LessonInput): void {
    this.input = { ...input, state: this.state };
    this.render();
  }

  get doc(): LessonInput['doc'] {
    return this.input.doc;
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
    return this.screen === 'catalogue' ? 'catalogue' : this.screen === 'outline' ? 'outline' : whereOf(this.sheet, this.state).view;
  }

  // ------------------------------------------------------------ changes

  private change(change: LessonChange): void {
    this.state = advance(this.input.doc, this.state, change);
    this.port.save(this.state);
  }
  private go(node: string, at: number): void {
    this.screen = null;
    this.change({ kind: 'goto', node, at });
  }
  private openWay(way: Way): void {
    const p = progressOf(this.state, way.node.id);
    const resume = wayFinished(way, this.state) ? 1 : Math.max(1, p.seen);
    this.justShown = null;
    this.go(way.node.id, Math.min(resume, Math.max(1, way.steps.length)));
    this.port.emit({ kind: 'open', node: way.node.id });
    this.render();
    window.scrollTo(0, 0);
  }

  private tryAnswer(way: Way, ask: Ask, text: string, at: number): void {
    const clean = text.trim();
    if (clean === '') return;
    const before = wrongTries(ask, progressOf(this.state, way.node.id).tries[ask.id] ?? []);
    const right = matches(clean, ask.accepted, ask.unit);
    const hint = right ? 0 : Math.min(before + 1, ask.hints.length);
    this.change({ kind: 'try', node: way.node.id, ask: ask.id, text: clean });
    this.port.emit({ kind: 'try', node: way.node.id, ask: ask.id, text: clean.slice(0, 80), right, hint });
    delete this.draft[ask.id];
    const finished = right && wayFinished(way, this.state);
    if (finished) this.port.emit({ kind: 'done', node: way.node.id });
    this.render();
    this.tryMs = Math.round(performance.now() - at);
    this.port.changed();
  }

  private work(way: Way, ask: Ask): void {
    this.change({ kind: 'try', node: way.node.id, ask: ask.id, text: WORKED });
    this.port.emit({ kind: 'worked', node: way.node.id, ask: ask.id });
    this.render();
  }

  private next(way: Way, shown: number): void {
    const at = shown + 1;
    this.justShown = shown;
    this.change({ kind: 'goto', node: way.node.id, at });
    this.port.emit({ kind: 'step', node: way.node.id, at });
    this.render();
    this.scrollToLatest();
  }
  private back(way: Way, shown: number): void {
    this.justShown = null;
    if (shown <= 1) {
      this.screen = null;
      this.change({ kind: 'goto', node: whereOf(this.sheet, this.state).view === 'play' ? (questionOf(this.sheet, way.node.id)?.node.id ?? way.node.id) : way.node.id, at: 0 });
    } else {
      this.change({ kind: 'goto', node: way.node.id, at: shown - 1 });
    }
    this.render();
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
    if (where === 'catalogue') page.append(this.catalogue());
    else if (where === 'outline') page.append(this.outline());
    else {
      const here = whereOf(this.sheet, this.state);
      if (here.view === 'question') page.append(this.questionCard(here.question), this.ways(here.question));
      else if (here.view === 'play') this.play(page, here.question, here.way);
    }
    this.root.replaceChildren(page);
    window.scrollTo(x, y);
    this.watch();
    this.fit();
    this.root.querySelector('.tab.on')?.scrollIntoView({ block: 'nearest', inline: 'center' });
    if (keep?.act === 'answer') {
      const field = this.root.querySelector('[data-act="answer"]');
      if (field instanceof HTMLInputElement) {
        field.focus({ preventScroll: true });
        if (keep.at !== null) field.setSelectionRange(keep.at, keep.at);
      }
    }
    this.port.changed();
  }

  /** A question that has scrolled to the top of the screen is "docked": on a phone it shows two lines and opens to the whole on a tap. */
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
      if (card instanceof HTMLElement) {
        card.classList.toggle('docked', gone);
      }
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
    const here = whereOf(sheet, this.state);
    const q = here.view === 'outline' ? null : here.question;
    return h(
      'header',
      { class: 'topbar' },
      h('button', { type: 'button', class: 'nav', 'data-act': 'outline', onclick: () => { this.screen = 'outline'; this.render(); window.scrollTo(0, 0); } }, 'All questions'),
      h('span', { class: 'crumb' }, q === null ? sheet.title : `${sheet.title}  ·  question ${q.number} of ${sheet.questions.length}`),
      this.input.catalogue.length > 0 ? h('button', { type: 'button', class: 'nav', 'data-act': 'catalogue', onclick: () => { this.screen = 'catalogue'; this.render(); window.scrollTo(0, 0); } }, 'My sheets') : null,
    );
  }

  private outline(): HTMLElement {
    const sheet = this.sheet;
    const done = sheet.questions.filter((q) => questionDone(q, this.state)).length;
    const view = h('main', { class: 'outline' }, h('h1', { class: 'title' }, sheet.title), h('p', { class: 'sub' }, `${done} of ${sheet.questions.length} questions done`));
    const resume = whereOf(sheet, this.state);
    if (resume.view === 'play' && !wayFinished(resume.way, this.state)) {
      const way = resume.way;
      view.append(
        h(
          'button',
          { type: 'button', class: 'resume', 'data-act': 'resume', onclick: () => this.openWay(way) },
          h('span', { class: 'resume-kicker' }, 'Carry on where you were'),
          h('span', { class: 'resume-text' }, `Question ${resume.question.number}: ${way.node.title}`),
          h('span', { class: 'resume-step' }, `step ${Math.min(progressOf(this.state, way.node.id).seen, way.steps.length)} of ${way.steps.length}`),
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
              { type: 'button', class: `qrow${isDone ? ' done' : ''}${ready === 0 ? ' wait' : ''}`, 'data-act': `q:${q.node.id}`, onclick: () => { this.screen = null; this.change({ kind: 'goto', node: q.node.id, at: 0 }); this.port.emit({ kind: 'open', node: q.node.id }); this.render(); window.scrollTo(0, 0); } },
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
    const more = long ? h('button', { type: 'button', class: 'more', 'data-act': 'more', 'aria-expanded': 'false' }, 'Read it all') : null;
    const card = h(
      'section',
      { class: `qcard${crop === undefined ? '' : ' with-crop'}${long ? ' long' : ''}${this.docked ? ' docked' : ''}${this.expanded ? ' expanded' : ''}`, 'data-act': 'question', 'aria-label': 'The question' },
      h('span', { class: 'qkicker' }, `Question ${q.number}`),
      more,
      h('p', { class: 'qtext' }, q.node.title),
      crop === undefined ? null : h('img', { class: 'crop', src: crop, alt: 'The question as it is written on the page' }),
    );
    if (more !== null) {
      more.textContent = this.expanded ? 'Show less' : 'Read it all';
      more.setAttribute('aria-expanded', String(this.expanded));
      more.addEventListener('click', () => {
        this.expanded = !this.expanded;
        card.classList.toggle('expanded', this.expanded);
        more.textContent = this.expanded ? 'Show less' : 'Read it all';
        more.setAttribute('aria-expanded', String(this.expanded));
        this.fit();
        this.port.changed();
      });
    }
    return h('div', { class: 'qwrap' }, h('div', { class: 'sentinel', 'aria-hidden': 'true' }), card);
  }

  private ways(q: Question): HTMLElement {
    const view = h('main', { class: 'ways' }, h('h2', {}, q.ways.length === 0 ? 'Getting some ways ready for you…' : 'Pick a way to work it out'));
    if (q.ways.length === 0) view.append(h('p', { class: 'wait-note' }, 'This takes a moment. You can look at another question while you wait.'));
    for (const way of q.ways) {
      const p = progressOf(this.state, way.node.id);
      const finished = wayFinished(way, this.state);
      const note = !way.ready ? 'Getting ready…' : finished ? 'You did this one' : p.seen > 0 ? `Step ${Math.min(p.seen, way.steps.length)} of ${way.steps.length}` : `${way.steps.length} ${way.steps.length === 1 ? 'step' : 'steps'}`;
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

  private play(page: HTMLElement, q: Question, way: Way): void {
    const at = Math.max(1, stopOf(this.state));
    const shown = Math.min(reach(way, this.state, at), way.steps.length);
    const open = sealedAsks(way, this.state);
    const words = (text: string): string => sealText(text, open, q.node.title);
    page.append(this.questionCard(q), this.tabs(q, way));
    const main = h('main', { class: 'work' });
    const runs = runsOf(way, shown);
    runs.forEach((run) => main.append(this.run(run, way, open, words, shown)));
    const gate = gateOf(way, this.state, shown);
    const filling = way.node.status === 'filling' || way.node.status === 'outlined';
    const finished = shown >= way.steps.length && gate === null && !filling;
    if (finished) main.append(this.finish(q, way));
    page.append(main);
    page.append(this.dock(way, shown, gate, filling, finished));
  }

  private tabs(q: Question, way: Way): HTMLElement {
    const bar = h('nav', { class: 'tabs', 'aria-label': 'Ways to work it out' });
    for (const w of q.ways) {
      const tab = h('button', { type: 'button', class: `tab${w === way || w.node.id === way.node.id ? ' on' : ''}`, 'data-act': `tab:${w.node.id}`, 'aria-current': w.node.id === way.node.id ? 'true' : null, onclick: () => { if (w.node.id !== way.node.id) this.openWay(w); } }, w.technique === null ? w.node.title : TECHNIQUE_NAMES[w.technique]);
      if (!w.ready) tab.disabled = true;
      bar.append(tab);
    }
    return bar;
  }

  private run(run: Run, way: Way, open: readonly Ask[], words: (text: string) => string, shown: number): HTMLElement {
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
          this.change({ kind: 'hold', node: way.node.id, key: `${key}.${name}`, value });
          this.port.emit({ kind: 'hold', node: way.node.id, key: `${key}.${name}`, value });
          this.render();
        },
        seal: (value) => sealed(value, open),
        fresh: this.fresh,
      };
      section.append(h('div', { class: 'fig', 'data-kind': figure.spec.kind, 'data-act': `fig:${figure.spec.kind}` }, drawVisual(figure.spec, ctx)));
    }
    const says = h('div', { class: 'says' });
    for (const { step, index } of run.steps) {
      if (step.kind === 'step') {
        const latest = index === shown - 1;
        says.append(
          h(
            'article',
            { class: `say${latest ? ' latest' : ''}${this.justShown === index ? ' arrive' : ''}`, 'data-step': index },
            h('span', { class: 'say-n' }, String(index + 1)),
            h('p', { class: 'words' }, words(step.words)),
          ),
        );
      } else says.append(this.ask(way, step, words));
    }
    section.append(says);
    return section;
  }

  private ask(way: Way, ask: Ask, words: (text: string) => string): HTMLElement {
    const tries = progressOf(this.state, way.node.id).tries[ask.id] ?? [];
    const right = rightOf(ask, tries);
    const gotPast = passed(ask, tries);
    const wrong = wrongTries(ask, tries);
    if (gotPast) {
      const worked = right === null;
      return h(
        'article',
        { class: `ask closed${worked ? ' worked' : ' right'}`, 'data-ask': ask.id },
        h('p', { class: 'ask-prompt' }, ask.prompt),
        h('p', { class: 'verdict good' }, worked ? 'Let’s see how it works.' : `Yes! ${right} is right.`),
      );
    }
    const card = h('article', { class: 'ask open', 'data-ask': ask.id, 'aria-label': 'Your turn' }, h('p', { class: 'ask-prompt' }, words(ask.prompt)));
    if (ask.refused) {
      card.append(h('p', { class: 'ask-note' }, 'Let’s work this one out together.'), h('button', { type: 'button', class: 'btn main wide', 'data-act': 'work', onclick: () => this.work(way, ask) }, 'Show me'));
      return card;
    }
    if (ask.pick !== null) {
      const choices = h('div', { class: 'choices', role: 'group', 'aria-label': 'Choose your answer' });
      for (const label of ask.pick) {
        const tried = tries.includes(label);
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
    if (wrong > 0) {
      const hint = ask.hints.length === 0 ? null : ask.hints[Math.min(wrong, ask.hints.length) - 1];
      const feedback = h('div', { class: 'nudge', role: 'status' }, h('p', { class: 'verdict' }, 'Not yet. Have another look.'));
      if (hint !== undefined && hint !== null) feedback.append(h('p', { class: 'hint' }, h('b', {}, `Hint ${Math.min(wrong, ask.hints.length)}: `), words(hint)));
      if (wrong > ask.hints.length && wrong >= 2) feedback.append(h('button', { type: 'button', class: 'btn soft wide', 'data-act': 'work', onclick: () => this.work(way, ask) }, 'Show me how to work it out'));
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
        others.length > 0 ? h('button', { type: 'button', class: 'btn main', 'data-act': 'another', onclick: () => { this.screen = null; this.change({ kind: 'goto', node: q.node.id, at: 0 }); this.render(); window.scrollTo(0, 0); } }, 'Try another way') : null,
        next === undefined ? null : h('button', { type: 'button', class: `btn ${others.length > 0 ? 'soft' : 'main'}`, 'data-act': 'next-question', onclick: () => { this.screen = null; this.change({ kind: 'goto', node: next.node.id, at: 0 }); this.render(); window.scrollTo(0, 0); } }, 'Next question'),
        h('button', { type: 'button', class: 'btn soft', 'data-act': 'outline-2', onclick: () => { this.screen = 'outline'; this.render(); window.scrollTo(0, 0); } }, 'All questions'),
      ),
    );
  }

  private dock(way: Way, shown: number, gate: Ask | null, filling: boolean, finished: boolean): HTMLElement {
    const back = h('button', { type: 'button', class: 'btn soft', 'data-act': 'back', onclick: () => this.back(way, shown) }, shown <= 1 ? 'Ways' : 'Back');
    let primary: HTMLElement | null;
    if (finished) primary = null;
    else if (gate !== null) primary = h('button', { type: 'button', class: 'btn main grow', 'data-act': 'next', disabled: true }, 'Answer to go on');
    else if (shown < way.steps.length) primary = h('button', { type: 'button', class: 'btn main grow', 'data-act': 'next', onclick: () => this.next(way, shown) }, 'Next');
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
    if (entry.current) {
      this.screen = null;
      this.change({ kind: 'goto', node: question, at: 0 });
      this.render();
      window.scrollTo(0, 0);
    } else this.port.emit({ kind: 'document', id: entry.id });
  }

  // ------------------------------------------------------------ for the brain

  /** The page as the brain is told of it (`HERE`): where she is, what is on stage, what she holds. Answers are the brain's own; nothing is left out. */
  here(): string {
    const where = whereOf(this.sheet, this.state);
    if (where.view === 'outline') return `HERE the sheet "${this.sheet.title}", the list of questions.`;
    if (where.view === 'question') return `HERE question ${where.question.number} "${where.question.node.title}", choosing a way (${where.question.ways.length} offered).`;
    const at = Math.min(reach(where.way, this.state, Math.max(1, stopOf(this.state))), where.way.steps.length);
    const tries = progressOf(this.state, where.way.node.id).tries;
    const asks = where.way.steps.slice(0, at).filter((s): s is Ask => s.kind === 'ask');
    const tried = asks.map((a) => `${a.id}: ${(tries[a.id] ?? []).map((t) => `"${t}"`).join(', ') || 'not tried'}`).join('; ');
    const stage = runsOf(where.way, at)
      .map((r) => (r.figure === null ? null : r.figure.spec.kind))
      .filter((k) => k !== null)
      .join(', ');
    const held = Object.entries(this.state.held[where.way.node.id] ?? {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
    return `HERE ${where.way.node.id} step ${at} of ${where.way.steps.length}. On stage: question card "${where.question.node.title}"${stage === '' ? '' : `; ${stage}`}. Tried: ${tried === '' ? 'nothing yet' : tried}. Held: ${held === '' ? 'nothing' : held}`;
  }

  /** How many steps she has been shown on the way she is on (0 off a way). */
  shownSteps(): number {
    const where = whereOf(this.sheet, this.state);
    return where.view === 'play' ? Math.min(reach(where.way, this.state, Math.max(1, stopOf(this.state))), where.way.steps.length) : 0;
  }

  /** The asks of the way that are not yet got past, and the question's own words: what the census looks for on screen. */
  sealedNow(): { readonly open: readonly Ask[]; readonly question: string } {
    const where = whereOf(this.sheet, this.state);
    return where.view === 'play' ? { open: sealedAsks(where.way, this.state), question: where.question.node.title } : { open: [], question: '' };
  }

  progress(): { readonly done: number; readonly total: number } {
    const sheet = this.sheet;
    return { done: sheet.questions.filter((q) => questionDone(q, this.state)).length, total: sheet.questions.length };
  }
}
