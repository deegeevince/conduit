// The access layer: a real, invisible form control laid exactly over every control on the stage, and a real, focusable
// region over every chart (DESIGN.md "The chrome").
//
// The painter draws the controls and the engine draws the charts; neither is a DOM widget. So that a keyboard reaches
// them in the order they were written, and a screen reader says what each one is, this layer keeps one native element
// per control (a button, a switch, a range, radios, a select, a text field) and one labelled group per chart. The
// elements are transparent, not hidden: they stay in the accessibility tree and take focus, and their focus ring (the
// chrome's 2 px outline in the stage's accent) is the only thing of them a sighted person sees. They take no pointer:
// the stage's own pointer path (painter.pointer) is how a pointer works a control, so the two never double up.

import type { ControlValue } from '@conduit/language';
import { formatNumber } from '@conduit/language';
import type { ChartProbe } from '../contracts/chart';
import type { ChartFrame } from '../contracts/frame';
import type { ControlView } from '../contracts/painter';

export type ChartAction = { readonly hover: number } | { readonly zoom: number } | { readonly pan: number } | { readonly reset: true };

export interface AccessHandlers {
  /** a control was worked from the keyboard or by assistive technology; `commit` false is a change in progress (a slider key is a commit; typing is not) */
  setControl(id: string, value: ControlValue | null, commit: boolean): void;
  /** a chart was worked from the keyboard; resolves with what it shows afterwards */
  chartAct(key: string, action: ChartAction): Promise<ChartProbe>;
}

export interface AccessLayer {
  /** the element the others sit in: over the stage, in front of the canvas, taking no pointer */
  readonly root: HTMLElement;
  /** the controls on stage now, in drawing order */
  controls(views: readonly ControlView[]): void;
  /** the charts on stage now */
  charts(frames: readonly ChartFrame[]): void;
  /** puts the keyboard on the real control behind a drawn one (a click on a drawn text field opens its keyboard) */
  focusControl(id: string): void;
  dispose(): void;
}

/** the widest a chart's table may be before it says so and shows a spread of rows */
const TABLE_ROWS = 60;

let counter = 0;

function make<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  return element;
}

interface Slot {
  readonly id: string;
  readonly holder: HTMLElement;
  readonly kind: string;
  /** a signature of everything that needs the element rebuilt rather than updated */
  readonly shape: string;
  update(view: ControlView): void;
  /** the element that takes focus */
  readonly focusable: () => HTMLElement | null;
}

function place(element: HTMLElement, box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }): void {
  const style = element.style;
  style.left = `${Math.round(box.x * 10) / 10}px`;
  style.top = `${Math.round(box.y * 10) / 10}px`;
  style.width = `${Math.max(1, Math.round(box.width * 10) / 10)}px`;
  style.height = `${Math.max(1, Math.round(box.height * 10) / 10)}px`;
}

function indexOfPick(view: ControlView): number {
  if (typeof view.value === 'number') return Math.min(Math.max(Math.round(view.value) - 1, 0), Math.max(0, view.options.length - 1));
  if (typeof view.value === 'string') return Math.max(0, view.options.indexOf(view.value));
  return 0;
}

/** Whether the user is in the middle of typing in this element: a value arriving from the painter must not overwrite it. */
function typing(element: HTMLElement): boolean {
  return document.activeElement === element;
}

export function createAccessLayer(stage: HTMLElement, handlers: AccessHandlers): AccessLayer {
  counter += 1;
  const base = `access-${counter}`;
  const root = make('div', 'access');
  root.setAttribute('data-access', '');
  const controlsHolder = make('div', 'access__controls');
  controlsHolder.setAttribute('role', 'group');
  controlsHolder.setAttribute('aria-label', 'Controls');
  const chartsHolder = make('div', 'access__charts');
  root.append(controlsHolder, chartsHolder);
  stage.append(root);

  const slots = new Map<string, Slot>();
  /** the controls as last handed in, so a chart's keyboard can find nothing stale */
  let live: readonly ControlView[] = [];

  // ---- controls ----

  function disabledOf(view: ControlView, holder: HTMLElement): void {
    if (view.enabled) holder.removeAttribute('aria-disabled');
    else holder.setAttribute('aria-disabled', 'true');
  }

  function build(view: ControlView): Slot {
    const holder = make('div', `access__control access__control--${view.control}`);
    holder.dataset['control'] = view.id;
    const ident = `${base}-${view.id.replace(/[^\w-]/g, '_')}`;
    const guard = (): boolean => holder.getAttribute('aria-disabled') !== 'true';
    const shape = `${view.control}|${view.form ?? ''}|${view.options.join('\u0001')}|${view.min}|${view.max}|${view.step ?? ''}`;
    let latest = view;
    let focusable: () => HTMLElement | null = () => null;
    let update: (next: ControlView) => void = () => undefined;

    switch (view.control) {
      case 'button': {
        const button = make('button', 'access__widget');
        button.type = 'button';
        button.addEventListener('click', () => {
          if (guard()) handlers.setControl(latest.id, null, true);
        });
        holder.append(button);
        focusable = () => button;
        update = (next) => {
          latest = next;
          button.textContent = next.label;
          button.setAttribute('aria-label', next.label);
        };
        break;
      }
      case 'toggle': {
        const button = make('button', 'access__widget');
        button.type = 'button';
        button.setAttribute('role', 'switch');
        button.addEventListener('click', () => {
          if (guard()) handlers.setControl(latest.id, latest.value !== true, true);
        });
        holder.append(button);
        focusable = () => button;
        update = (next) => {
          latest = next;
          button.textContent = next.label;
          button.setAttribute('aria-label', next.label);
          button.setAttribute('aria-checked', String(next.value === true));
        };
        break;
      }
      case 'slider': {
        const range = make('input', 'access__widget');
        range.type = 'range';
        range.min = String(view.min);
        range.max = String(view.max);
        range.step = view.step === null ? 'any' : String(view.step);
        // A drag in progress changes the picture at once and sends nothing; letting go, or a key, commits.
        range.addEventListener('input', () => {
          if (guard()) handlers.setControl(latest.id, Number(range.value), false);
        });
        range.addEventListener('change', () => {
          if (guard()) handlers.setControl(latest.id, Number(range.value), true);
        });
        holder.append(range);
        focusable = () => range;
        update = (next) => {
          latest = next;
          range.setAttribute('aria-label', next.label);
          if (typeof next.value === 'number' && Number(range.value) !== next.value) range.value = String(next.value);
          range.setAttribute('aria-valuetext', next.valueText);
        };
        break;
      }
      case 'input': {
        const field = make('input', 'access__widget');
        field.type = 'text';
        field.autocomplete = 'off';
        field.spellcheck = false;
        field.addEventListener('input', () => {
          if (guard()) handlers.setControl(latest.id, field.value, false);
        });
        field.addEventListener('change', () => {
          if (guard()) handlers.setControl(latest.id, field.value, true);
        });
        field.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' || event.isComposing || !guard()) return;
          event.preventDefault();
          handlers.setControl(latest.id, field.value, true);
        });
        holder.append(field);
        focusable = () => field;
        update = (next) => {
          latest = next;
          field.setAttribute('aria-label', next.label === '' ? 'Text' : next.label);
          field.placeholder = next.label;
          const text = typeof next.value === 'string' ? next.value : next.value === null ? '' : String(next.value);
          if (!typing(field) && field.value !== text) field.value = text;
        };
        break;
      }
      case 'pick': {
        const form = view.form ?? 'row';
        const choose = (index: number): void => {
          if (guard() && index >= 0 && index < latest.options.length) handlers.setControl(latest.id, index + 1, true);
        };
        if (form === 'menu') {
          const select = make('select', 'access__widget');
          view.options.forEach((option, index) => {
            const item = document.createElement('option');
            item.value = String(index + 1);
            item.textContent = option;
            select.append(item);
          });
          select.addEventListener('change', () => choose(Number(select.value) - 1));
          holder.append(select);
          focusable = () => select;
          update = (next) => {
            latest = next;
            select.setAttribute('aria-label', next.label === '' ? 'Choose one' : next.label);
            const wanted = String(indexOfPick(next) + 1);
            if (select.value !== wanted) select.value = wanted;
          };
        } else if (form === 'steps') {
          const group = make('div', 'access__widget access__steps');
          group.setAttribute('role', 'group');
          const back = make('button', 'access__step');
          back.type = 'button';
          back.textContent = 'Back';
          const next = make('button', 'access__step');
          next.type = 'button';
          next.textContent = 'Next';
          const where = make('p', 'visually-hidden');
          where.setAttribute('role', 'status');
          back.addEventListener('click', () => choose(indexOfPick(latest) - 1));
          next.addEventListener('click', () => choose(indexOfPick(latest) + 1));
          group.append(back, where, next);
          holder.append(group);
          focusable = () => back;
          update = (nextView) => {
            latest = nextView;
            const at = indexOfPick(nextView);
            group.setAttribute('aria-label', nextView.label === '' ? 'Steps' : nextView.label);
            where.textContent = `Step ${at + 1} of ${nextView.options.length}: ${nextView.options[at] ?? ''}`;
            back.setAttribute('aria-disabled', String(at <= 0));
            next.setAttribute('aria-disabled', String(at >= nextView.options.length - 1));
          };
        } else if (form === 'tabs') {
          const list = make('div', 'access__widget');
          list.setAttribute('role', 'tablist');
          const tabs = view.options.map((option, index) => {
            const tab = make('button', 'access__tab');
            tab.type = 'button';
            tab.setAttribute('role', 'tab');
            tab.textContent = option;
            tab.addEventListener('click', () => choose(index));
            return tab;
          });
          list.addEventListener('keydown', (event) => {
            const at = tabs.findIndex((tab) => tab === document.activeElement);
            if (at < 0) return;
            const move = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : event.key === 'Home' ? -at : event.key === 'End' ? tabs.length - 1 - at : 0;
            if (move === 0) return;
            event.preventDefault();
            const to = Math.min(tabs.length - 1, Math.max(0, at + move));
            tabs[to]?.focus();
            choose(to);
          });
          list.append(...tabs);
          holder.append(list);
          focusable = () => tabs.find((tab) => tab.tabIndex === 0) ?? tabs[0] ?? null;
          update = (nextView) => {
            latest = nextView;
            list.setAttribute('aria-label', nextView.label === '' ? 'Choose one' : nextView.label);
            const at = indexOfPick(nextView);
            tabs.forEach((tab, index) => {
              tab.setAttribute('aria-selected', String(index === at));
              tab.tabIndex = index === at ? 0 : -1;
            });
          };
        } else {
          const group = make('div', 'access__widget');
          group.setAttribute('role', 'radiogroup');
          const name = `${ident}-pick`;
          const radios = view.options.map((option, index) => {
            const label = make('label', 'access__option');
            const radio = make('input', 'access__radio');
            radio.type = 'radio';
            radio.name = name;
            radio.value = String(index + 1);
            radio.addEventListener('change', () => {
              if (radio.checked) choose(index);
            });
            label.append(radio, document.createTextNode(option));
            group.append(label);
            return radio;
          });
          holder.append(group);
          focusable = () => radios.find((radio) => radio.checked) ?? radios[0] ?? null;
          update = (nextView) => {
            latest = nextView;
            group.setAttribute('aria-label', nextView.label === '' ? 'Choose one' : nextView.label);
            const at = indexOfPick(nextView);
            radios.forEach((radio, index) => {
              if (radio.checked !== (index === at)) radio.checked = index === at;
            });
          };
        }
        break;
      }
    }
    update(view);
    disabledOf(view, holder);
    return { id: view.id, holder, kind: view.control, shape, update, focusable };
  }

  function syncControls(views: readonly ControlView[]): void {
    live = views;
    const wanted = new Set(views.map((view) => view.key));
    for (const [key, slot] of [...slots]) {
      if (wanted.has(key)) continue;
      // Taking the control away from under the keyboard must not leave focus on nothing: it goes to the stage.
      if (slot.holder.contains(document.activeElement)) stage.focus({ preventScroll: true });
      slot.holder.remove();
      slots.delete(key);
    }
    let previous: HTMLElement | null = null;
    for (const view of views) {
      let slot = slots.get(view.key);
      const shape = `${view.control}|${view.form ?? ''}|${view.options.join('\u0001')}|${view.min}|${view.max}|${view.step ?? ''}`;
      if (slot !== undefined && slot.shape !== shape) {
        const had = slot.holder.contains(document.activeElement);
        const next = build(view);
        slot.holder.replaceWith(next.holder);
        slots.set(view.key, next);
        slot = next;
        if (had) next.focusable()?.focus({ preventScroll: true });
      }
      if (slot === undefined) {
        slot = build(view);
        slots.set(view.key, slot);
        controlsHolder.insertBefore(slot.holder, previous === null ? controlsHolder.firstChild : previous.nextSibling);
      } else {
        slot.update(view);
        // keep drawing order without moving what already stands in it (moving a focused element drops focus)
        const expected: ChildNode | null = previous === null ? controlsHolder.firstChild : previous.nextSibling;
        if (expected !== slot.holder) {
          const focused = slot.holder.contains(document.activeElement) ? document.activeElement : null;
          controlsHolder.insertBefore(slot.holder, expected);
          if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
        }
      }
      place(slot.holder, view.box);
      disabledOf(view, slot.holder);
      previous = slot.holder;
    }
  }

  // ---- charts ----

  interface ChartRegion {
    readonly key: string;
    readonly region: HTMLElement;
    readonly summary: HTMLElement;
    readonly caption: HTMLElement;
    readonly table: HTMLTableElement;
    readonly reading: HTMLElement;
    /** where the keyboard's crosshair is, as a share of the chart's width */
    at: number;
    /** what the table was built from, so it is rebuilt only when the data changes */
    built: string;
  }
  const regions = new Map<string, ChartRegion>();
  const regionPoints = new Map<string, number>();

  function describe(frame: ChartFrame): { label: string; summary: string } {
    const { state } = frame;
    const model = state.model;
    const names = model.series.filter((series) => series.role !== 'volume').map((series) => series.name).filter((name) => name !== '');
    const kind = state.kind === 'columns' ? 'Column' : state.kind === 'ohlc' ? 'OHLC' : state.kind.charAt(0).toUpperCase() + state.kind.slice(1);
    const label = `${kind} chart${state.title !== '' ? `: ${state.title}` : ''}`;
    if (state.failed) return { label, summary: 'The data for this chart could not be had.' };
    if (state.waiting) return { label, summary: 'This chart is waiting for its data.' };
    const first = model.points[0];
    const last = model.points[model.points.length - 1];
    const parts = [`${model.points.length} point${model.points.length === 1 ? '' : 's'}`];
    if (first !== undefined && last !== undefined && model.points.length > 1) parts.push(`from ${first.label} to ${last.label}`);
    if (names.length > 0) parts.push(`series ${names.join(', ')}`);
    parts.push('Arrow keys move the crosshair, plus and minus zoom, Page Up and Page Down pan, zero resets the view');
    return { label, summary: `${parts.join('; ')}.` };
  }

  function fill(region: ChartRegion, frame: ChartFrame): void {
    const model = frame.state.model;
    const signature = `${model.points.length}|${model.series.map((series) => `${series.name}:${series.values.length}`).join(',')}|${frame.state.landed}|${frame.state.waiting}|${frame.state.failed}`;
    if (signature === region.built) return;
    region.built = signature;
    region.table.replaceChildren();
    if (frame.state.waiting || frame.state.failed || model.points.length === 0) return;
    const shown = Math.min(model.points.length, frame.state.landed > 0 ? frame.state.landed : model.points.length);
    const stride = Math.max(1, Math.ceil(shown / TABLE_ROWS));
    const head = document.createElement('tr');
    for (const title of ['', ...model.series.map((series) => (series.name === '' ? 'Value' : series.name))]) {
      const cell = document.createElement('th');
      cell.scope = 'col';
      cell.textContent = title;
      head.append(cell);
    }
    const thead = document.createElement('thead');
    thead.append(head);
    const body = document.createElement('tbody');
    for (let index = 0; index < shown; index += stride) {
      const point = model.points[index];
      if (point === undefined) continue;
      const row = document.createElement('tr');
      const rowHead = document.createElement('th');
      rowHead.scope = 'row';
      rowHead.textContent = point.label;
      row.append(rowHead);
      for (const series of model.series) {
        const value = series.values[index];
        const cell = document.createElement('td');
        cell.textContent = value === null || value === undefined ? '' : formatNumber(value, series.format);
        row.append(cell);
      }
      body.append(row);
    }
    region.caption.textContent = stride > 1 ? `Every ${stride === 2 ? 'second' : `${stride}th`} of ${shown} points` : '';
    region.table.replaceChildren(...(stride > 1 ? [region.caption] : []), thead, body);
  }

  async function keyOn(region: ChartRegion, event: KeyboardEvent): Promise<void> {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    let action: ChartAction | null = null;
    const points = Math.max(1, regionPoints.get(region.key) ?? 1);
    const step = Math.min(0.1, Math.max(0.01, 1 / points)) * (event.shiftKey ? 5 : 1);
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        region.at = Math.min(1, region.at + step);
        action = { hover: region.at };
        break;
      case 'ArrowLeft':
      case 'ArrowDown':
        region.at = Math.max(0, region.at - step);
        action = { hover: region.at };
        break;
      case 'Home':
        region.at = 0;
        action = { hover: 0 };
        break;
      case 'End':
        region.at = 1;
        action = { hover: 1 };
        break;
      case '+':
      case '=':
        action = { zoom: 1.25 };
        break;
      case '-':
      case '_':
        action = { zoom: 0.8 };
        break;
      case 'PageUp':
        action = { pan: -0.25 };
        break;
      case 'PageDown':
        action = { pan: 0.25 };
        break;
      case '0':
      case 'Escape':
        action = { reset: true };
        break;
      default:
        return;
    }
    event.preventDefault();
    try {
      const result = await handlers.chartAct(region.key, action);
      region.reading.textContent = readout(result, action);
    } catch {
      region.reading.textContent = 'This chart cannot be worked yet.';
    }
  }
  function readout(probe: ChartProbe, action: ChartAction): string {
    if ('zoom' in action || 'pan' in action || 'reset' in action) {
      const range = `Showing ${String(probe.from)} to ${String(probe.to)}, ${probe.points} points`;
      if (probe.crosshair === null) return range;
    }
    if (probe.crosshair === null) return 'Crosshair off the data';
    return `${probe.crosshair.label}: ${probe.crosshair.values.join(', ')}`;
  }

  function syncCharts(frames: readonly ChartFrame[]): void {
    const wanted = new Set(frames.map((frame) => frame.key));
    for (const [key, region] of [...regions]) {
      if (wanted.has(key)) continue;
      if (region.region.contains(document.activeElement)) stage.focus({ preventScroll: true });
      region.region.remove();
      regions.delete(key);
      regionPoints.delete(key);
    }
    for (const frame of frames) {
      let region = regions.get(frame.key);
      if (region === undefined) {
        const holder = make('div', 'access__chart');
        holder.tabIndex = 0;
        holder.setAttribute('role', 'group');
        holder.setAttribute('aria-roledescription', 'interactive chart');
        holder.dataset['chart'] = frame.id;
        const summary = make('p', 'visually-hidden');
        summary.id = `${base}-chart-${counter}-${regions.size}-${frame.key.replace(/[^\w-]/g, '_')}`;
        holder.setAttribute('aria-describedby', summary.id);
        const table = make('table', 'visually-hidden');
        const caption = document.createElement('caption');
        const reading = make('p', 'visually-hidden');
        reading.setAttribute('role', 'status');
        reading.setAttribute('aria-live', 'polite');
        holder.append(summary, table, reading);
        const made: ChartRegion = { key: frame.key, region: holder, summary, caption, table, reading, at: 0.5, built: '' };
        holder.addEventListener('keydown', (event) => void keyOn(made, event));
        chartsHolder.append(holder);
        regions.set(frame.key, made);
        region = made;
      }
      const text = describe(frame);
      region.region.setAttribute('aria-label', text.label);
      if (region.summary.textContent !== text.summary) region.summary.textContent = text.summary;
      regionPoints.set(frame.key, frame.state.model.points.length);
      fill(region, frame);
      place(region.region, frame.box);
      region.region.toggleAttribute('inert', frame.opacity < 0.05);
    }
  }

  return {
    root,
    controls: syncControls,
    charts: syncCharts,
    focusControl(id) {
      const view = live.find((candidate) => candidate.id === id);
      const slot = view === undefined ? undefined : slots.get(view.key);
      slot?.focusable()?.focus({ preventScroll: true });
    },
    dispose() {
      root.remove();
      slots.clear();
      regions.clear();
    },
  };
}
