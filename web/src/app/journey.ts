// A journey plays a scripted walk through one live conversation on the real page: it types into the real box, taps and drags with pointer
// events at the places a hand would, and waits for the real brain between steps. Nothing is replayed. `window.__journey` says where it is and,
// for each step, when things happened (the page's clock and `performance.now()`), for a film editor that cuts the waits and places captions.

import { alternativesOf, parseJourney, seeded } from './journey-script';
import { likeness, norm } from './journey-words';
import type { FocusBox, FocusSample, JourneyState, JourneyStep, Stamp, StepTiming } from './journey-script';
import type { StageApp } from './stage-app';
import type { ControlView, StageElementView } from '../contracts/painter';

declare global {
  interface Window {
    __journey?: JourneyState;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const stamp = (): Stamp => ({ at: Date.now(), perf: performance.now() });
const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** a tap target that never shows, a rest that never comes: how long each is waited for */
const TAP_WAIT_MS = ((): number => {
  // `?journeywait=<seconds>` shortens it, for a check that a missing target stops the journey
  const given = Number(new URLSearchParams(window.location.search).get('journeywait'));
  return given > 0 && given < 60 ? given * 1000 : 60_000;
})();
const OPTIONAL_WAIT_MS = 4_000;
const REST_CAP_MS = 300_000;
const TURN_OPEN_MS = 45_000;
/** how long the stage must have been still for `rest` */
const STILL_MS = 900;
const CHARS_PER_SECOND = 12;

class Stop extends Error {}

export interface JourneyOptions {
  readonly app: StageApp;
  readonly stage: HTMLElement;
  readonly name: string;
  readonly source: string;
}

interface Target {
  readonly id: string;
  readonly label: string;
  readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly tappable: boolean;
  readonly key: string;
}

export function startJourney(options: JourneyOptions): JourneyState {
  const { app, stage, name } = options;
  const parsed = parseJourney(options.source);
  const state: JourneyState = {
    name,
    status: 'loading',
    message: null,
    started: null,
    finished: null,
    steps: 'steps' in parsed ? parsed.steps.map((step) => blank(step)) : [],
    model: null,
    follow: { samples: 0, misses: 0, longestMissMs: 0 },
    focus: [],
  };
  window.__journey = state;
  if ('error' in parsed) {
    state.status = 'stopped';
    state.message = `The journey file could not be read: ${parsed.error}`;
    return state;
  }
  const steps = parsed.steps;
  const random = seeded(20_26);
  const cursor = makeCursor();

  const fail = (why: string): never => {
    throw new Stop(why);
  };

  const stageBox = (): DOMRect => stage.getBoundingClientRect();
  const globalOf = (box: Target['box']): { x: number; y: number } => {
    const at = stageBox();
    return { x: at.left + box.x + box.width / 2, y: at.top + box.y + box.height / 2 };
  };

  // ---- pointer events, at a screen point, the way a mouse (and so a finger tap) makes them
  const pointer = (type: 'pointerdown' | 'pointermove' | 'pointerup', x: number, y: number, down: boolean, onto?: Element): void => {
    const target = onto ?? document.elementFromPoint(x, y) ?? stage;
    target.dispatchEvent(
      new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: type === 'pointermove' ? -1 : 0, buttons: down ? 1 : 0, pressure: down ? 0.5 : 0 }),
    );
  };

  /** the cursor travels to a point in `ms`, the pointer moving under it as it goes */
  const travel = async (x: number, y: number, ms: number, down = false): Promise<void> => {
    const from = cursor.at();
    const began = performance.now();
    for (;;) {
      const t = Math.min(1, (performance.now() - began) / Math.max(1, ms));
      const k = ease(t);
      const px = from.x + (x - from.x) * k;
      const py = from.y + (y - from.y) * k;
      cursor.place(px, py);
      pointer('pointermove', px, py, down);
      if (t >= 1) return;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  };

  const press = async (x: number, y: number, label: string, step: StepTiming | null, focus?: { readonly id: string; readonly box: FocusBox }): Promise<void> => {
    const onto = document.elementFromPoint(x, y) ?? stage;
    if (step !== null) {
      step.tapAt = stamp();
      step.tapped = label;
    }
    if (focus !== undefined) doing('tap', focus.id, () => focus.box);
    cursor.press(true);
    pointer('pointerdown', x, y, true, onto);
    await sleep(110);
    pointer('pointerup', x, y, false, onto);
    cursor.press(false);
    if (focus !== undefined) lingerThen(900);
    // what a browser adds after a button's pointer goes up
    const button = onto.closest('button');
    if (button !== null) button.click();
    else onto.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0 }));
  };

  // ---- what is on stage
  const targets = (): Target[] => {
    const snap = app.painter.snapshot();
    const out: Target[] = [];
    const at = stageBox();
    const inside = (b: Target['box']): boolean => b.width > 2 && b.height > 2 && b.x + b.width > 0 && b.y + b.height > 0 && b.x < at.width && b.y < at.height;
    for (const element of snap.elements as readonly StageElementView[]) {
      if (element.phase !== 'on' || element.opacity < 0.9 || element.text === '' || !inside(element.box)) continue;
      out.push({ id: element.id, label: element.text, box: element.box, tappable: element.tappable, key: element.key });
    }
    for (const control of snap.controls as readonly ControlView[]) {
      if (!control.enabled) continue;
      if (control.control === 'button' && control.label !== '' && inside(control.box)) out.push({ id: control.id, label: control.label, box: control.box, tappable: true, key: control.key });
      control.options.forEach((option, index) => {
        const part = control.parts.find((candidate) => candidate.part === `option:${index}`);
        if (part !== undefined && inside(part.box)) out.push({ id: control.id, label: option, box: part.box, tappable: true, key: `${control.key}/${index}` });
      });
    }
    return out;
  };

  const rank = (label: string, wanted: string): number => {
    const have = norm(label);
    if (have === wanted) return 0;
    if (have.startsWith(wanted)) return 1;
    return have.includes(wanted) ? 2 : -1;
  };

  const findTarget = (wanted: string): Target | null => {
    const word = norm(wanted);
    let best: { target: Target; score: number } | null = null;
    for (const target of targets()) {
      const kind = rank(target.label, word);
      if (kind < 0) continue;
      // a tappable thing before a plain label; an exact label before a longer one; the smaller box (the part, not the card around it) last
      const score = (target.tappable ? 0 : 100) + kind * 10 + Math.min(9, (target.box.width * target.box.height) / 1e5);
      if (best === null || score < best.score) best = { target, score };
    }
    return best?.target ?? null;
  };

  // ---- labels: what a tap can ask about (fb-055). A label is the brain's words set against a part (`say callout near=x`, a figure part's `label=`), and the text layer
  // carries it as `.stage__text-block--ask`. `tap | Brakes` finds the closest of them by what the words say: "Brakes" finds "brake disc", "brakes" and "Brake".
  /** the labels on stage now: each is the first line of its words, in stage pixels (the text layer is only there while the stage is at rest) */
  const labels = (): Target[] => {
    const at = stageBox();
    const seen = new Set<string>();
    const out: Target[] = [];
    for (const holder of document.querySelectorAll<HTMLElement>('.stage__text-block--ask')) {
      const group = holder.dataset['askGroup'] ?? holder.dataset['key'] ?? '';
      const label = holder.dataset['ask'] ?? '';
      const line = holder.querySelector<HTMLElement>('.stage__text-line');
      if (label === '' || seen.has(group) || line === null || holder.closest('[data-moving]') !== null) continue;
      const rect = line.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2 || rect.right < at.left || rect.bottom < at.top || rect.left > at.right || rect.top > at.bottom) continue;
      seen.add(group);
      out.push({ id: holder.dataset['askId'] ?? group, label, box: { x: rect.left - at.left, y: rect.top - at.top, width: rect.width, height: rect.height }, tappable: true, key: holder.dataset['key'] ?? group });
    }
    return out;
  };

  const findLabel = (wanted: string): Target | null => {
    let best: { target: Target; score: number } | null = null;
    for (const target of labels()) {
      const score = likeness(target.label, wanted);
      if (score >= 0 && (best === null || score < best.score)) best = { target, score };
    }
    return best?.target ?? null;
  };

  /** what `tap | <words>` taps: a choice or a control that says exactly that; else the closest label by its words; else a choice or control that has them (`findTarget`).
   *  Words that cannot be tapped (a figure's description, a line of speech that names the part) are no target: a tap there does nothing, so the step is skipped or stops instead. */
  const findTap = (wanted: string): Target | null => {
    const exact = findTarget(wanted);
    if (exact !== null && exact.tappable && norm(exact.label) === norm(wanted)) return exact;
    return findLabel(wanted) ?? (exact !== null && exact.tappable ? exact : null);
  };

  /** what a tap that lists alternatives taps: the first of them, in the order written, that is a real choice, control or label on stage; and which it was */
  const findAmong = (wanted: string): { readonly target: Target; readonly used: string } | null => {
    for (const alternative of alternativesOf(wanted)) {
      const target = findTap(alternative);
      if (target !== null) return { target, used: alternative };
    }
    return null;
  };

  /** the target, once it has stopped moving and is on stage; null if it does not come in `waitMs` */
  const settled = async (find: () => Target | null, waitMs: number): Promise<Target | null> => {
    const until = performance.now() + waitMs;
    let last: Target | null = null;
    while (performance.now() < until) {
      const now = find();
      if (now !== null && last !== null && now.key === last.key && Math.abs(now.box.x - last.box.x) < 1 && Math.abs(now.box.y - last.box.y) < 1) return now;
      last = now;
      await sleep(140);
    }
    return null;
  };

  // ---- the language pane's follow: is the line being drawn in view?
  let outSince = -1;
  const sampleFollow = (): void => {
    const row = document.querySelector<HTMLElement>('.lang__row.is-now');
    const list = document.querySelector<HTMLElement>('.lang__body');
    if (row === null || list === null) {
      outSince = -1;
      return;
    }
    const a = row.getBoundingClientRect();
    const b = list.getBoundingClientRect();
    state.follow.samples += 1;
    if (a.top >= b.top - 1 && a.bottom <= b.bottom + 1) {
      outSince = -1;
      return;
    }
    state.follow.misses += 1;
    const now = performance.now();
    if (outSince < 0) outSince = now;
    state.follow.longestMissMs = Math.max(state.follow.longestMissMs, Math.round(now - outSince + 100));
  };
  const sampler = window.setInterval(sampleFollow, 100);

  /** the step whose turn is open: when its first line came and when the stage had played it out */
  let watched: StepTiming | null = null;
  const watch = (): void => {
    if (watched === null || watched.turn === null) return;
    if (watched.firstLine === null) {
      if (app.lang.entriesOf(watched.turn).length > 0) watched.firstLine = stamp();
    } else if (watched.turnEnded === null && app.painter.snapshot().turn === null) watched.turnEnded = stamp();
  };
  const watcher = window.setInterval(watch, 25);

  /** what the hand is doing now, for the focus track: its kind, what it is on, and where that is on screen (viewport pixels) while it lasts */
  let activity: { readonly kind: 'type' | 'tap' | 'drag'; readonly id: string; readonly box: () => FocusBox | null; until: number } | null = null;
  const doing = (kind: 'type' | 'tap' | 'drag', id: string, box: () => FocusBox | null, until = Infinity): void => {
    activity = { kind, id, box, until };
  };
  const lingerThen = (ms: number): void => {
    if (activity !== null) activity.until = performance.now() + ms;
  };

  // ---- the focus track: the element being performed (the one the panel's lit row made) and that row, in viewport pixels
  const boxOf = (rect: DOMRect): FocusBox => ({ x: Math.round(rect.left * 10) / 10, y: Math.round(rect.top * 10) / 10, w: Math.round(rect.width * 10) / 10, h: Math.round(rect.height * 10) / 10 });
  const viewportBox = (box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }): FocusBox => {
    const at = stageBox();
    return { x: Math.round((at.left + box.x) * 10) / 10, y: Math.round((at.top + box.y) * 10) / 10, w: Math.round(box.width * 10) / 10, h: Math.round(box.height * 10) / 10 };
  };
  const union = (boxes: readonly FocusBox[]): FocusBox | null => {
    if (boxes.length === 0) return null;
    const x0 = Math.min(...boxes.map((b) => b.x));
    const y0 = Math.min(...boxes.map((b) => b.y));
    const x1 = Math.max(...boxes.map((b) => b.x + b.w));
    const y1 = Math.max(...boxes.map((b) => b.y + b.h));
    return { x: Math.round(x0 * 10) / 10, y: Math.round(y0 * 10) / 10, w: Math.round((x1 - x0) * 10) / 10, h: Math.round((y1 - y0) * 10) / 10 };
  };
  let lastKey = '';
  let lastSampleAt = -1e9;
  let focusFrame = 0;
  const sampleFocus = (): void => {
    focusFrame = requestAnimationFrame(sampleFocus);
    const now = performance.now();
    if (activity !== null && activity.until < now) activity = null;
    const row = document.querySelector<HTMLElement>('.lang__row.is-now') ?? document.querySelector<HTMLElement>('.lang__row.is-moving--lead');
    const rowBox = row === null ? null : boxOf(row.getBoundingClientRect());
    let kind: FocusSample['kind'] = 'idle';
    let id: string | null = null;
    let element: FocusBox | null = null;
    if (activity !== null) {
      kind = activity.kind;
      id = activity.id;
      element = activity.box();
    } else if (row !== null) {
      kind = 'draw';
      id = row.dataset['id'] ?? null;
      if (id !== null) {
        const view = app.painter.snapshot().elements.find((candidate) => candidate.id === id && candidate.phase !== 'struck' && candidate.box.width > 0 && candidate.box.height > 0);
        if (view !== undefined) element = viewportBox(view.box);
      }
    }
    const key = JSON.stringify([kind, id, element, rowBox]);
    if (key === lastKey && (kind === 'idle' || now - lastSampleAt < 50)) return;
    lastKey = key;
    lastSampleAt = now;
    state.focus.push({ at: Date.now(), perf: now, kind, id, element, row: rowBox });
  };
  focusFrame = requestAnimationFrame(sampleFocus);

  const noteModel = (): void => {
    const fact = app.facts.model();
    if (fact !== null) state.model = { model: fact.model, effort: fact.effort };
  };

  // ---- the steps
  const input = (): HTMLTextAreaElement => {
    const found = document.querySelector<HTMLTextAreaElement>('.prompt__input');
    return found ?? fail('The page has no input box.');
  };

  const doType = async (step: JourneyStep, timing: StepTiming): Promise<void> => {
    const box = input();
    const at = box.getBoundingClientRect();
    await travel(at.left + Math.min(at.width / 2, 260), at.top + at.height / 2, 700);
    await press(at.left + Math.min(at.width / 2, 260), at.top + at.height / 2, 'the input box', null);
    box.focus();
    await sleep(250);
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (set === undefined) return fail('The input box cannot be written.');
    const before = app.lang.turn;
    let due = performance.now();
    const bar = box.closest<HTMLElement>('.prompt') ?? box;
    doing('type', 'input', () => boxOf(bar.getBoundingClientRect()));
    timing.typingStart = stamp();
    for (const character of step.text) {
      const wait = due - performance.now();
      if (wait > 0) await sleep(wait);
      box.dispatchEvent(new KeyboardEvent('keydown', { key: character, bubbles: true, cancelable: true }));
      set.call(box, box.value + character);
      box.dispatchEvent(new InputEvent('input', { data: character, inputType: 'insertText', bubbles: true }));
      box.dispatchEvent(new KeyboardEvent('keyup', { key: character, bubbles: true, cancelable: true }));
      due += (1000 / CHARS_PER_SECOND) * (0.75 + random() * 0.5);
    }
    timing.typingEnd = stamp();
    await sleep(420);
    timing.sent = stamp();
    lingerThen(400);
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    await opened(before, TURN_OPEN_MS, timing, true);
  };

  /** waits for a turn of the page to open after `before`; the id goes in the timing */
  const opened = async (before: string | null, waitMs: number, timing: StepTiming, required: boolean): Promise<void> => {
    const until = performance.now() + waitMs;
    while (performance.now() < until) {
      const turn = app.lang.turn;
      if (turn !== null && turn !== before) {
        timing.turn = turn;
        watched = timing;
        return;
      }
      await sleep(30);
    }
    if (required) fail(`step ${timing.n}: no turn opened within ${Math.round(waitMs / 1000)} s of sending "${timing.text}"`);
  };

  const doTap = async (step: JourneyStep, timing: StepTiming): Promise<boolean> => {
    const picked: { used: string | null } = { used: null };
    const target = await settled(() => {
      const found = findAmong(step.text);
      picked.used = found?.used ?? null;
      return found?.target ?? null;
    }, step.optional ? OPTIONAL_WAIT_MS : TAP_WAIT_MS);
    if (target === null) {
      if (step.optional) return false;
      return fail(`step ${step.n} (line ${step.line}): "${step.text}" never appeared on stage within ${Math.round(TAP_WAIT_MS / 1000)} s, so the journey stopped there`);
    }
    timing.used = picked.used;
    const before = app.lang.turn;
    const to = globalOf(target.box);
    await travel(to.x, to.y, 650);
    await sleep(160);
    await press(to.x, to.y, target.label, timing, { id: target.id, box: viewportBox(target.box) });
    await opened(before, 6000, timing, false);
    return true;
  };

  const chip = (): HTMLButtonElement | null => {
    const found = document.querySelector<HTMLButtonElement>('[data-undo-chip]');
    return found !== null && !found.hidden ? found : null;
  };

  const doUndo = async (step: JourneyStep, timing: StepTiming): Promise<boolean> => {
    const until = performance.now() + (step.optional ? OPTIONAL_WAIT_MS : 15_000);
    while (chip() === null && performance.now() < until) await sleep(100);
    const button = chip();
    if (button === null) {
      if (step.optional) return false;
      return fail(`step ${step.n} (line ${step.line}): the Undo chip never showed`);
    }
    const before = app.lang.turn;
    const at = button.getBoundingClientRect();
    await travel(at.left + at.width / 2, at.top + at.height / 2, 650);
    await sleep(160);
    await press(at.left + at.width / 2, at.top + at.height / 2, 'Undo', timing, { id: 'undo', box: boxOf(at) });
    await opened(before, 10_000, timing, true);
    return true;
  };

  const doBack = async (step: JourneyStep, timing: StepTiming): Promise<boolean> => {
    // a Back choice the brain drew, when there is one: it is the answer's own way back
    const target = await settled(() => findTarget('back'), 2500);
    if (target !== null) {
      const before = app.lang.turn;
      const to = globalOf(target.box);
      await travel(to.x, to.y, 650);
      await sleep(160);
      await press(to.x, to.y, target.label, timing, { id: target.id, box: viewportBox(target.box) });
      await opened(before, 6000, timing, false);
      return true;
    }
    return doUndo(step, timing);
  };

  /** the words and the places of what is on stage, as they stand: what a slider's binds move or rewrite (before and after a drag) */
  const readout = (): string[] =>
    app.painter
      .snapshot()
      .elements.filter((element) => element.phase !== 'struck' && element.kind !== 'control' && element.kind !== 'group')
      .map((element) => (element.kind === 'text' ? `${element.id}: ${element.text}` : `${element.id} at ${Math.round(element.box.x)},${Math.round(element.box.y)} ${Math.round(element.box.width)}x${Math.round(element.box.height)}`))
      .slice(0, 14);

  const sliders = (): ControlView[] => app.painter.snapshot().controls.filter((control) => control.control === 'slider' && control.enabled);

  const findSlider = (wanted: string): ControlView | null => {
    const all = sliders();
    const word = norm(wanted);
    const byId = all.find((control) => norm(control.id) === word);
    if (byId !== undefined) return byId;
    const byLabel = all.filter((control) => norm(control.label).includes(word) || norm(control.id).includes(word));
    if (byLabel.length >= 1) return byLabel[0] ?? null;
    return all.length === 1 ? (all[0] ?? null) : null;
  };

  const doDrag = async (step: JourneyStep, timing: StepTiming): Promise<boolean> => {
    const found = await settled(() => {
      const control = findSlider(step.target);
      const knob = control?.parts.find((part) => part.part === 'knob')?.box ?? control?.parts.find((part) => part.part === 'track')?.box;
      return control === null || control === undefined || knob === undefined ? null : { id: control.id, label: control.id, box: knob, tappable: true, key: control.key };
    }, step.optional ? OPTIONAL_WAIT_MS : TAP_WAIT_MS);
    if (found === null) {
      if (step.optional) return false;
      return fail(`step ${step.n} (line ${step.line}): no slider matching "${step.target}" appeared on stage within ${Math.round(TAP_WAIT_MS / 1000)} s, so the journey stopped there`);
    }
    const control = sliders().find((candidate) => candidate.key === found.key);
    if (control === undefined) return fail(`step ${step.n}: the slider went away`);
    const clamp = (value: number): number => Math.min(control.max, Math.max(control.min, value));
    const pick = (value: number | 'min' | 'max'): number => (value === 'min' ? control.min : value === 'max' ? control.max : clamp(value));
    const from = pick(step.from);
    const to = pick(step.to);
    const track = control.parts.find((part) => part.part === 'track')?.box ?? control.box;
    const perUnit = track.width / Math.max(1e-9, control.max - control.min);
    const valueNow = (): number => {
      const view = sliders().find((candidate) => candidate.key === control.key);
      return typeof view?.value === 'number' ? view.value : Number(view?.value ?? from);
    };
    // the knob is taken where it is; a slider that is not yet at `from` is first set there by hand, slowly, as a person would
    const start = globalOf(found.box);
    const y = start.y;
    await travel(start.x, y, 650);
    await sleep(200);
    timing.dragStart = stamp();
    const changes = (): FocusBox | null => {
      const snap = app.painter.snapshot();
      const ids = new Set<string>([...app.hook.bindings().map((binding) => binding.id), ...(snap.motions ?? []).map((motion) => motion.id)]);
      const boxes: FocusBox[] = [];
      const view = snap.controls.find((candidate) => candidate.key === control.key);
      if (view !== undefined) boxes.push(viewportBox(view.box));
      for (const chart of snap.charts) boxes.push(viewportBox(chart.box));
      for (const element of snap.elements) if (ids.has(element.id) && element.phase !== 'struck' && element.box.width > 0 && element.box.height > 0 && element.id !== control.id) boxes.push(viewportBox(element.box));
      return union(boxes);
    };
    doing('drag', control.id, changes);
    const before = readout();
    cursor.press(true);
    pointer('pointerdown', start.x, y, true);
    const total = Math.max(0.3, step.seconds) * 1000;
    let x = start.x;
    const begin = performance.now();
    // the value follows the easing from `from` to `to`; the hand corrects for what the control reports, so the knob and the numbers agree
    const wanted = (k: number): number => from + (to - from) * k;
    for (;;) {
      const t = Math.min(1, (performance.now() - begin) / total);
      const target = wanted(ease(t));
      x += (target - valueNow()) * perUnit * 0.7;
      cursor.place(x, y);
      pointer('pointermove', x, y, true, stage);
      if (t >= 1) break;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    // settle on the last value
    for (let i = 0; i < 12 && Math.abs(valueNow() - to) > Math.max(1e-6, (control.step ?? 0) / 2, (control.max - control.min) * 0.002); i += 1) {
      x += (to - valueNow()) * perUnit * 0.8;
      cursor.place(x, y);
      pointer('pointermove', x, y, true, stage);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    await sleep(180);
    pointer('pointerup', x, y, false, stage);
    cursor.press(false);
    timing.dragEnd = stamp();
    lingerThen(1000);
    await sleep(350);
    timing.drag = { control: control.id, from, to, reached: valueNow(), readout: { before, after: readout() } };
    return true;
  };

  /** the turn has ended, the stage is still and any critic or repair is done or skipped; the stamps go in `timing` */
  const doRest = async (timing: StepTiming): Promise<void> => {
    const began = performance.now();
    let still = -1;
    for (;;) {
      if (performance.now() - began > REST_CAP_MS) fail(`step ${timing.n}: the stage did not come to rest within ${REST_CAP_MS / 1000} s`);
      const snap = app.painter.snapshot();
      const mending = app.facts.mending();
      const calm = snap.turn === null && snap.clock === 'idle' && !app.status().busy && !snap.anticipating && !mending.pending && !mending.working && !mending.tidying;
      if (calm) {
        if (still < 0) still = performance.now();
        if (performance.now() - still >= STILL_MS) break;
      } else still = -1;
      await sleep(50);
    }
    noteModel();
    timing.rest = stamp();
  };

  const run = async (): Promise<void> => {
    await app.hook.ready;
    await sleep(900);
    state.status = 'running';
    state.started = stamp();
    for (const step of steps) {
      const timing = state.steps[step.n - 1] as StepTiming;
      timing.status = 'running';
      timing.begin = stamp();
      let did = true;
      switch (step.op) {
        case 'type':
          await doType(step, timing);
          break;
        case 'tap':
          did = await doTap(step, timing);
          break;
        case 'drag':
          did = await doDrag(step, timing);
          break;
        case 'undo':
          did = await doUndo(step, timing);
          break;
        case 'back':
          did = await doBack(step, timing);
          break;
        case 'hold':
          await sleep(step.seconds * 1000);
          break;
        case 'rest':
          await doRest(timing);
          break;
      }
      timing.end = stamp();
      timing.status = did ? 'done' : 'skipped';
      if (!did) timing.note = `${step.op}${step.optional ? '?' : ''} skipped: nothing to ${step.op === 'drag' ? 'drag' : 'tap'} appeared in ${OPTIONAL_WAIT_MS / 1000} s`;
    }
    noteModel();
    state.finished = stamp();
    state.status = 'done';
  };

  const finish = (): void => {
    window.clearInterval(sampler);
    window.clearInterval(watcher);
    cancelAnimationFrame(focusFrame);
    cursor.hide();
  };
  run().then(finish, (cause: unknown) => {
    const running = state.steps.find((step) => step.status === 'running');
    if (running !== undefined) running.status = 'stopped';
    state.status = 'stopped';
    state.message = cause instanceof Error ? cause.message : String(cause);
    state.finished = stamp();
    noteModel();
    console.error(`journey stopped: ${state.message}`);
    finish();
  });
  return state;
}

function blank(step: JourneyStep): StepTiming {
  return {
    n: step.n,
    line: step.line,
    op: step.op,
    optional: step.optional,
    name: step.name,
    text: step.op === 'drag' ? step.target : step.text,
    status: 'pending',
    note: null,
    begin: null,
    end: null,
    turn: null,
    typingStart: null,
    typingEnd: null,
    sent: null,
    firstLine: null,
    turnEnded: null,
    rest: null,
    tapAt: null,
    tapped: null,
    used: null,
    dragStart: null,
    dragEnd: null,
    drag: null,
  };
}

/** A small arrow where the pointer is, so a recording shows the hand: the page's own pointer is not drawn by a screen capture. */
function makeCursor(): { place(x: number, y: number): void; at(): { x: number; y: number }; press(on: boolean): void; hide(): void } {
  const el = document.createElement('div');
  el.setAttribute('aria-hidden', 'true');
  el.dataset['journeyCursor'] = '';
  el.style.cssText = 'position:fixed;left:0;top:0;width:28px;height:28px;z-index:2147483000;pointer-events:none;will-change:transform;transition:opacity .25s';
  el.innerHTML =
    '<svg viewBox="0 0 28 28" width="28" height="28"><circle class="ring" cx="5" cy="5" r="4" fill="none" stroke="#fff" stroke-width="1.5" opacity="0"/>' +
    '<path d="M4 2 L4 22 L9.5 17 L13.5 26 L17 24.5 L13 15.5 L21 15.5 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  document.body.append(el);
  const ring = el.querySelector<SVGElement>('.ring');
  let x = window.innerWidth * 0.62;
  let y = window.innerHeight * 0.55;
  const draw = (): void => {
    el.style.transform = `translate(${x}px, ${y}px)`;
  };
  draw();
  return {
    place(nx, ny) {
      x = nx;
      y = ny;
      draw();
    },
    at: () => ({ x, y }),
    press(on) {
      el.style.transform = `translate(${x}px, ${y}px) scale(${on ? 0.88 : 1})`;
      ring?.setAttribute('opacity', on ? '0.9' : '0');
      ring?.setAttribute('r', on ? '9' : '4');
    },
    hide() {
      el.style.opacity = '0';
    },
  };
}
