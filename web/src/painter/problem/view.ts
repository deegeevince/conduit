// The problem workspace: one maths question, the whole screen, and nothing else (the owner's spec: "one canvas that is full screen that I can focus on
// the question and nothing else using my pen"). The brain said the question and its answer; this draws the rest, the same way every time:
//
//   the question      large and centred, typeset from the tokens `readProblem` found: numbers, signs, words, and a blank the pen writes on
//   Check, Hint, Type it   close under the blank; the answer is checked here (`problemAnswerRight`), reading the handwriting through the page's reader
//   hints             written from the question's own parts and shown on the question itself, one short line each
//   ways              small chips under the question; each draws a layout from the numbers (`ways.ts`), one step at a time, the unknown always a "?"
//
// A question it cannot read as a sum is a plain workspace: the question, the blank, the pen, Check, and whatever hints the brain wrote. Nothing here
// calls a model for marking, and nothing here ever shows the answer before it is right.

import { problemAnswerRight, problemHints, problemWays, readProblem } from '@conduit/language';
import type { ProblemHint, ProblemRead, ProblemSpec, ProblemWayInfo } from '@conduit/language';
import { penRead, penReady } from '../controls/pen';
import { drawWay } from './ways';
import type { WayDrawing } from './ways';

export interface ProblemViewOptions {
  readonly spec: ProblemSpec;
  /** hints the brain wrote for it (`hint | words`), in order: used when the sum is not one the painter can read */
  readonly said: readonly string[];
  /** whether the person's setting asks for no motion */
  readonly calm: () => boolean;
  /** a try was made: for the page to tell no one but remember (the check reads the state from the page) */
  readonly onTry?: (given: string, right: boolean) => void;
}

export interface ProblemState {
  readonly verdict: 'open' | 'wrong' | 'right';
  readonly tries: readonly string[];
  readonly way: string | null;
  readonly step: number;
  readonly steps: number;
  readonly lit: 'know' | 'find' | null;
  readonly line: string;
  readonly playing: boolean;
}

export interface ProblemView {
  readonly element: HTMLElement;
  readonly key: string;
  state(): ProblemState;
  /** draws the ways again at the room the view has now */
  relayout(): void;
  /** the brain put an answer the person gave (by voice, pen or chat) in the blank: shown there and marked like a typed one; once per `key` */
  fill(key: string, text: string): void;
  dispose(): void;
}

const NS = 'http://www.w3.org/2000/svg';

export const problemKey = (spec: ProblemSpec): string => `${spec.id}|${spec.question}|${spec.answer.join('\u0001')}`;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function button(className: string, label: string, run: () => void): HTMLButtonElement {
  const node = el('button', className, label);
  node.type = 'button';
  node.addEventListener('click', run);
  return node;
}

/** the size class of the question by how much there is to set */
function sizeOf(read: ProblemRead): 'xxl' | 'xl' | 'l' | 'm' {
  const chars = read.tokens.slice(0, read.sumEnd).reduce((n, token) => n + token.text.length + 1, 0);
  return chars <= 16 ? 'xxl' : chars <= 22 ? 'xl' : chars <= 42 ? 'l' : 'm';
}

export function createProblemView(options: ProblemViewOptions): ProblemView {
  const { spec } = options;
  const read = readProblem(spec.question);
  const info: ProblemWayInfo[] = problemWays(read.form, spec.ways as never);
  const hints: ProblemHint[] = problemHints(read, spec.for);
  const root = el('section', 'pb');
  const key = problemKey(spec);
  root.dataset['problem'] = spec.id;
  root.dataset['size'] = sizeOf(read);
  if (read.form === null) root.dataset['plain'] = '1';
  root.setAttribute('aria-label', 'A maths question to work out');
  // a press on the workspace is the workspace's own: the stage under it takes no tap from it
  for (const type of ['pointerdown', 'pointerup', 'pointermove', 'click', 'mousedown', 'mouseup', 'touchstart', 'touchend']) root.addEventListener(type, (event) => event.stopPropagation());

  // ---- state
  let verdict: ProblemState['verdict'] = 'open';
  const tries: string[] = [];
  let wayIndex = -1;
  let step = 0;
  let lit: 'know' | 'find' | null = null;
  let line = '';
  let playing = false;
  let hintsOpen = false;
  let typing = false;
  let reading = false;
  let timer: number | undefined;
  let drawn: WayDrawing | null = null;

  // ---- the question
  const top = el('div', 'pb__top');
  const question = el('h1', 'pb__question');
  question.setAttribute('aria-label', `${read.tokens.map((token) => (token.kind === 'blank' ? 'blank' : token.text)).join(' ')}`);
  const tokenNodes: HTMLElement[] = [];
  const sum = el('span', 'pb__sum');
  if (read.form !== null) sum.dataset['fit'] = '1';
  question.append(sum);
  let remark: HTMLElement | null = null;
  let blankNode: HTMLElement | null = null;
  read.tokens.forEach((token, index) => {
    const node = el('span', `pb__tok pb__tok--${token.kind}`);
    node.dataset['tok'] = String(index);
    node.dataset['kind'] = token.kind;
    if (token.gap) node.classList.add('pb__tok--gap');
    if (token.kind === 'blank') {
      node.setAttribute('role', 'img');
      node.setAttribute('aria-label', 'blank: write the answer here with the pen');
      node.dataset['blank'] = '1';
      const written = el('span', 'pb__written');
      node.append(written);
      blankNode = node;
      node.addEventListener('click', () => openTyping(true));
    } else node.textContent = token.text;
    if (read.added && index === read.blank && read.tokens.length > 1 && index === read.tokens.length - 1 && read.form === null) {
      const lead = el('span', 'pb__answer-word', 'Answer');
      lead.dataset['added'] = '1';
      sum.append(lead);
    }
    tokenNodes.push(node);
    if (index >= read.sumEnd) {
      if (remark === null) {
        remark = el('span', 'pb__remark');
        question.append(remark);
      }
      remark.append(node);
    } else sum.append(node);
  });
  const lineNode = el('p', 'pb__line');
  lineNode.setAttribute('aria-live', 'polite');
  top.append(question, lineNode);

  // ---- Check, Hint, Type it
  const controls = el('div', 'pb__controls');
  const checkButton = button('pb__btn pb__btn--primary', 'Check', () => void check());
  checkButton.dataset['act'] = 'check';
  const hintButton = button('pb__btn', 'Hint', () => toggleHints());
  hintButton.dataset['act'] = 'hint';
  hintButton.setAttribute('aria-expanded', 'false');
  const typeButton = button('pb__btn pb__btn--quiet', 'Type it', () => openTyping(!typing));
  typeButton.dataset['act'] = 'type';
  const showButton = button('pb__btn pb__btn--quiet', 'Show me', () => void showMe());
  showButton.dataset['act'] = 'show';
  showButton.hidden = true;
  const input = el('input', 'pb__input');
  input.type = 'text';
  input.autocomplete = 'off';
  input.setAttribute('autocapitalize', 'off');
  input.setAttribute('autocorrect', 'off');
  input.spellcheck = false;
  input.setAttribute('enterkeyhint', 'done');
  input.setAttribute('inputmode', spec.answer.every((a) => /^[\d .,]+$/.test(a)) ? 'decimal' : 'text');
  input.setAttribute('aria-label', 'Type your answer');
  input.hidden = true;
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void check();
    }
  });
  controls.append(checkButton, hintButton, typeButton, showButton, input);

  // ---- the hints
  const hintRow = el('div', 'pb__hints');
  hintRow.hidden = true;
  const hintChips: HTMLButtonElement[] = [];
  const shown: { readonly id: string; readonly label: string; readonly line: string; readonly lights: readonly number[] }[] = [];
  for (const hint of hints) {
    if (hint.id === 'picture' && (read.form === null || info.length === 0)) continue;
    shown.push(hint);
  }
  if (read.form === null || info.length === 0) options.said.slice(0, 4).forEach((words, i) => shown.push({ id: `said${i}`, label: `Hint ${i + 1}`, line: words, lights: [] }));
  for (const hint of shown) {
    const chip = button('pb__chip', hint.label, () => takeHint(hint.id));
    chip.dataset['hint'] = hint.id;
    chip.setAttribute('aria-pressed', 'false');
    hintChips.push(chip);
    hintRow.append(chip);
  }

  // ---- the ways
  const waysRow = el('div', 'pb__ways');
  const wayChips: HTMLButtonElement[] = [];
  const usable: ProblemWayInfo[] = read.form === null ? [] : info.filter((entry) => drawWay(read.form as NonNullable<typeof read.form>, entry.way, { width: 600, height: 380 }) !== null);
  usable.forEach((entry, index) => {
    const chip = button('pb__chip pb__chip--way', entry.name, () => openWay(wayIndex === index ? -1 : index));
    chip.dataset['way'] = entry.way;
    chip.setAttribute('aria-pressed', 'false');
    wayChips.push(chip);
    waysRow.append(chip);
  });
  waysRow.hidden = usable.length === 0;

  // ---- the drawing under it, and its stepper
  const wayBox = el('div', 'pb__way');
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'pb__svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'A picture of the question, one step at a time');
  wayBox.append(svg);
  const stepper = el('div', 'pb__stepper');
  stepper.hidden = true;
  const prev = button('pb__step pb__step--prev', '‹', () => goStep(step - 1));
  prev.setAttribute('aria-label', 'Previous step');
  prev.dataset['act'] = 'prev';
  const next = button('pb__step pb__step--next', '›', () => goStep(step + 1));
  next.setAttribute('aria-label', 'Next step');
  next.dataset['act'] = 'next';
  const counter = el('span', 'pb__count');
  counter.dataset['count'] = '1';
  const caption = el('p', 'pb__caption');
  stepper.append(prev, counter, next);
  const lower = el('div', 'pb__lower');
  const under = el('div', 'pb__under');
  under.append(stepper, caption);
  lower.append(wayBox, under);

  const chips = el('div', 'pb__chips');
  chips.append(hintRow, waysRow);
  root.append(top, controls, chips, lower);

  // ---- drawing
  function room(): { width: number; height: number } {
    const box = wayBox.getBoundingClientRect();
    return { width: Math.round(box.width) || 600, height: Math.round(box.height) || 320 };
  }

  function paintWay(): void {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    drawn = null;
    if (wayIndex < 0 || read.form === null) {
      wayBox.dataset['open'] = '0';
      stepper.hidden = true;
      caption.textContent = '';
      return;
    }
    const entry = usable[wayIndex];
    if (entry === undefined) return;
    const size = room();
    drawn = drawWay(read.form, entry.way, size);
    if (drawn === null) return;
    wayBox.dataset['open'] = '1';
    svg.setAttribute('viewBox', `0 0 ${drawn.width} ${drawn.height}`);
    for (const piece of drawn.pieces) {
      const node = document.createElementNS(NS, piece.tag);
      for (const [name, value] of Object.entries(piece.attrs)) node.setAttribute(name, String(value));
      if (piece.text !== undefined) node.textContent = piece.text;
      node.dataset['step'] = String(piece.step);
      svg.append(node);
    }
    stepper.hidden = false;
    showStep(false);
  }

  function showStep(animate: boolean): void {
    if (drawn === null) return;
    const total = drawn.steps.length;
    step = Math.max(1, Math.min(total, step));
    for (const node of Array.from(svg.children)) {
      const at = Number((node as SVGElement).dataset['step']);
      const on = at <= step;
      node.classList.toggle('pw-off', !on);
      node.classList.toggle('pw-new', animate && at === step && !options.calm());
    }
    counter.textContent = `${step} of ${total}`;
    caption.textContent = drawn.steps[step - 1] ?? '';
    prev.disabled = step <= 1;
    next.disabled = step >= total;
    root.dataset['way'] = usable[wayIndex]?.way ?? '';
    root.dataset['step'] = String(step);
    root.dataset['steps'] = String(total);
  }

  function openWay(index: number): void {
    stopPlaying();
    wayIndex = index;
    step = index < 0 ? 0 : 1;
    wayChips.forEach((chip, i) => {
      chip.setAttribute('aria-pressed', String(i === index));
      chip.classList.toggle('is-on', i === index);
    });
    root.dataset['open'] = index < 0 ? '0' : '1';
    if (index < 0) {
      delete root.dataset['way'];
      delete root.dataset['step'];
      delete root.dataset['steps'];
    }
    // the picture takes its room once the layout has it
    requestAnimationFrame(() => {
      paintWay();
      if (index >= 0) showStep(true);
    });
    paintWay();
  }

  function goStep(to: number): void {
    stopPlaying();
    if (drawn === null) return;
    step = Math.max(1, Math.min(drawn.steps.length, to));
    showStep(true);
  }

  function stopPlaying(): void {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
    playing = false;
    showButton.disabled = false;
    showButton.textContent = 'Show me';
  }

  // ---- hints
  function light(): void {
    tokenNodes.forEach((node, index) => {
      const on = lit === 'know' ? (hints[0]?.lights.includes(index) ?? false) : lit === 'find' ? index === read.blank : false;
      node.classList.toggle('is-lit', on);
    });
    hintChips.forEach((chip) => {
      const on = (lit === 'know' && chip.dataset['hint'] === 'know') || (lit === 'find' && chip.dataset['hint'] === 'find');
      chip.setAttribute('aria-pressed', String(on));
      chip.classList.toggle('is-on', on);
    });
    root.dataset['lit'] = lit ?? '';
  }

  function say(words: string, tone: 'plain' | 'wrong' | 'right' = 'plain'): void {
    line = words;
    lineNode.textContent = words;
    lineNode.dataset['tone'] = tone;
  }

  function toggleHints(): void {
    hintsOpen = !hintsOpen;
    hintRow.hidden = !hintsOpen;
    hintButton.setAttribute('aria-expanded', String(hintsOpen));
    hintButton.classList.remove('is-ringed');
    if (!hintsOpen) {
      lit = null;
      light();
      if (verdict === 'open') say('');
    }
  }

  function takeHint(id: string): void {
    if (id === 'know' || id === 'find') {
      lit = lit === id ? null : id;
      light();
      const spoken = hints.find((hint) => hint.id === id);
      say(lit === null ? '' : (spoken?.line ?? ''));
      return;
    }
    lit = null;
    light();
    if (id === 'picture') {
      say(hints.find((hint) => hint.id === 'picture')?.line ?? '');
      if (wayIndex < 0 && usable.length > 0) openWay(0);
      return;
    }
    const at = shown.findIndex((entry) => entry.id === id);
    say(shown[at]?.line ?? '');
    hintChips.forEach((chip) => {
      const on = chip.dataset['hint'] === id;
      chip.setAttribute('aria-pressed', String(on));
      chip.classList.toggle('is-on', on);
    });
  }

  // ---- typing
  function openTyping(open: boolean): void {
    if (verdict === 'right') return;
    typing = open;
    input.hidden = !open;
    typeButton.setAttribute('aria-pressed', String(open));
    typeButton.textContent = open ? 'Use the pen' : 'Type it';
    if (open) input.focus({ preventScroll: true });
    else input.blur();
  }

  // ---- Check
  async function check(): Promise<void> {
    if (verdict === 'right' || reading) return;
    let given = input.value.trim();
    let written = false;
    // a new try: what the brain put in the blank last time is cleared
    const stale = blankNode?.querySelector<HTMLElement>('.pb__written');
    if (stale !== null && stale !== undefined) stale.textContent = '';
    blankNode?.classList.remove('is-try');
    if (given === '') {
      if (!penReady()) {
        say(tries.length > 0 ? 'Write your answer again in the box with the pen, then tap Check.' : 'Write your answer in the box with the pen, then tap Check.');
        return;
      }
      reading = true;
      checkButton.disabled = true;
      say('Reading…');
      const got = await penRead().catch(() => null);
      reading = false;
      checkButton.disabled = false;
      if (got === null) {
        say('I could not read that. Write it bigger, or tap Type it.');
        return;
      }
      given = got.trim();
      written = true;
      if (given === '') {
        say('I could not read that. Write it bigger, or tap Type it.');
        return;
      }
    }
    judge(given, written ? 'pen' : 'typed');
  }

  /** an answer is marked here, whoever gave it: the pen's reading, the typed field, or the brain putting what she said in the blank */
  function judge(given: string, how: 'pen' | 'typed' | 'said'): void {
    tries.push(given);
    const right = spec.answer.length === 0 ? false : problemAnswerRight(spec.answer, given);
    options.onTry?.(given, right);
    if (right) {
      verdict = 'right';
      stopPlaying();
      root.dataset['verdict'] = 'right';
      const written = blankNode?.querySelector<HTMLElement>('.pb__written');
      if (written !== null && written !== undefined) written.textContent = given;
      blankNode?.classList.add('is-right');
      input.hidden = true;
      typeButton.hidden = true;
      showButton.hidden = true;
      checkButton.hidden = true;
      hintButton.hidden = true;
      hintRow.hidden = true;
      lit = null;
      light();
      say(`Yes! ${given} is right.`, 'right');
      return;
    }
    verdict = 'wrong';
    root.dataset['verdict'] = 'wrong';
    input.value = '';
    const shown = blankNode?.querySelector<HTMLElement>('.pb__written');
    if (shown !== null && shown !== undefined) shown.textContent = how === 'said' ? given : '';
    blankNode?.classList.toggle('is-try', how === 'said');
    const lead = how === 'pen' ? `I read “${given}”. ` : how === 'said' ? `I put “${given}” in the box. ` : '';
    say(spec.answer.length === 0 ? `I cannot check this one${how === 'pen' ? `: I read “${given}”` : ''}.` : `${lead}Not quite: have another go.`, 'wrong');
    hintButton.classList.add('is-ringed');
    showButton.hidden = usable.length === 0;
  }

  // ---- Show me: plays a way through, stopping before the answer
  async function showMe(): Promise<void> {
    if (playing || usable.length === 0 || verdict === 'right') return;
    const index = wayIndex >= 0 ? wayIndex : 0;
    openWay(index);
    await new Promise<void>((done) => requestAnimationFrame(() => done()));
    if (drawn === null) return;
    playing = true;
    showButton.disabled = true;
    showButton.textContent = 'Showing…';
    const total = drawn.steps.length;
    step = 1;
    showStep(true);
    say('Watch the picture. The ? is still yours to find.');
    const advance = (): void => {
      if (!playing) return;
      if (step >= total) {
        stopPlaying();
        return;
      }
      step += 1;
      showStep(true);
      timer = window.setTimeout(advance, options.calm() ? 400 : 1300);
    };
    timer = window.setTimeout(advance, options.calm() ? 300 : 1100);
  }

  // a sum is set on one line, as large as the screen allows: the type shrinks until it fits, it never wraps
  function fitQuestion(): void {
    if (sum.dataset['fit'] !== '1') return;
    question.style.fontSize = '';
    let size = parseFloat(getComputedStyle(question).fontSize);
    for (let i = 0; i < 24 && question.clientWidth > 0 && sum.scrollWidth > question.clientWidth + 1 && size > 18; i += 1) {
      size *= 0.94;
      question.style.fontSize = `${size.toFixed(1)}px`;
    }
  }
  const fitObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => fitQuestion());
  fitObserver?.observe(question);
  requestAnimationFrame(fitQuestion);

  const applied = new Set<string>();
  light();
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
    if (wayIndex >= 0) {
      const keep = step;
      paintWay();
      step = keep;
      showStep(false);
    }
  });
  observer?.observe(wayBox);

  return {
    element: root,
    key,
    fill(key, text) {
      if (applied.has(key) || verdict === 'right') return;
      applied.add(key);
      stopPlaying();
      input.value = '';
      judge(text.trim(), 'said');
    },
    state: () => ({ verdict, tries: [...tries], way: wayIndex < 0 ? null : (usable[wayIndex]?.way ?? null), step: wayIndex < 0 ? 0 : step, steps: drawn?.steps.length ?? 0, lit, line, playing }),
    relayout() {
      fitQuestion();
      if (wayIndex >= 0) {
        const keep = step;
        paintWay();
        step = keep;
        showStep(false);
      }
    },
    dispose() {
      stopPlaying();
      observer?.disconnect();
      fitObserver?.disconnect();
      root.remove();
    },
  };
}
