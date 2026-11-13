// The review page of the evaluation harness. One row per prompt (or scripted conversation) of a run; in the row,
// one group per prompt variant, and in each group a card per sample, the first open and the rest folded. Above the
// rows, what the owner has to decide with: pass rates, the variants side by side, dollars and the viewer's wait,
// and the plain-answer comparison like for like.
//
// Per card: stills across the answer, Play, the numbers (first word, first visible, last word, the viewer's wait at
// reading speed, tokens, dollars), the judge's verdict with the picture it saw, every automatic check, the words
// shown, the script, the plain baseline, and Save film. A conversation shows one card per turn.

import { API, passRates } from '@conduit/language';
import type { ExploreCaseResult, ExploreIndexEntry, ExploreResult, ExploreRun, ExploreVariant } from '@conduit/language';
import { createCard } from './card';
import type { Card, Services, StageClaim } from './card';
import { drewSomething, failedCount } from './checks';
import { count, dollars, h, median, seconds } from './dom';
import { createStillMaker } from './stills';
import { createExporter } from '../export';
import type { Exporter } from '../contracts/export';
import type { Renderer } from '../contracts/renderer';
import { createPlainRenderer } from '../render/plain';
import { canUseThree, createThreeRenderer } from '../render/three';

const FETCH_AT_ONCE = 4;

const makeRenderer = (): Renderer => (canUseThree() ? createThreeRenderer() : createPlainRenderer());

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return (await response.json()) as T;
}

const labelOf = (run: ExploreRun): string => `${run.id}${run.model === null ? '' : ` (${run.model})`}`;
const keyOf = (entry: ExploreIndexEntry): string => entry.promptId ?? entry.id;
const isCase = (loaded: ExploreResult | ExploreCaseResult): loaded is ExploreCaseResult => 'turns' in loaded && 'case' in loaded;
const mean = (values: readonly number[]): number | null => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length);

type Loaded = ExploreResult | ExploreCaseResult;

interface Column {
  readonly run: ExploreRun;
  /** loaded files by entry id; null when one could not be read */
  readonly loaded: Map<string, Loaded | null>;
}

/** The answers of an entry: one for a prompt, one per turn for a conversation. */
function answersOf(loaded: Loaded | null | undefined): ExploreResult[] {
  if (loaded === null || loaded === undefined) return [];
  return isCase(loaded) ? [...loaded.turns] : [loaded];
}

export function startPage(): void {
  const app = document.getElementById('app');
  if (app === null) throw new Error('explore.html has no #app');

  const stills = createStillMaker(makeRenderer);
  let exporter: Exporter | null = null;
  let current: StageClaim | null = null;
  const services: Services = {
    stills,
    makeRenderer,
    exporter: () => (exporter ??= createExporter({ createRenderer: makeRenderer })),
    claimStage(release) {
      const previous = current;
      const claim: StageClaim = { release };
      current = claim;
      previous?.release();
      return claim;
    },
    releaseStage(claim) {
      // Only the card that holds the stage may let go of it: another card's claim must survive.
      if (current === claim) current = null;
    },
  };

  const heading = h('h1', { text: 'Exploration' });
  const status = h('p', { class: 'status', attrs: { role: 'status' } });
  const pickA = h('select', { attrs: { id: 'run-a' } });
  const pickB = h('select', { attrs: { id: 'run-b' } });
  const pickUse = h('select', { attrs: { id: 'use-case' } });
  const onlyFailed = h('input', { attrs: { type: 'checkbox', id: 'only-failed' } });
  const onlyHeldOut = h('input', { attrs: { type: 'checkbox', id: 'only-held-out' } });
  const totals = h('div', { class: 'totals' });
  const rows = h('div', { class: 'rows' });

  const controls = h(
    'div',
    { class: 'controls' },
    h('label', { attrs: { for: 'run-a' } }, 'Run ', pickA),
    h('label', { attrs: { for: 'run-b' } }, 'Compare with ', pickB),
    h('label', { attrs: { for: 'use-case' } }, 'Use case ', pickUse),
    h('label', { class: 'check', attrs: { for: 'only-failed' } }, onlyFailed, ' Only answers with a failed check'),
    h('label', { class: 'check', attrs: { for: 'only-held-out' } }, onlyHeldOut, ' Only held-out prompts'),
  );
  app.append(h('header', { class: 'top' }, heading, controls, totals, status), h('main', {}, rows));

  let runs: ExploreRun[] = [];
  let columns: Column[] = [];
  let generation = 0;
  const cardsByRow = new Map<string, Card[]>();
  const rowsByKey = new Map<string, HTMLElement>();

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const id = (entry.target as HTMLElement).dataset['prompt'];
        observer.unobserve(entry.target);
        for (const card of cardsByRow.get(id ?? '') ?? []) card.wake();
      }
    },
    { rootMargin: '400px 0px' },
  );

  const say = (text: string): void => {
    status.textContent = text;
  };

  function fillSelect(select: HTMLSelectElement, options: readonly { value: string; text: string }[], value: string): void {
    select.replaceChildren(...options.map((option) => h('option', { text: option.text, attrs: { value: option.value } })));
    select.value = value;
  }

  const verdictSetOf = (entry: ExploreIndexEntry): { label: string; ok: boolean }[] =>
    (entry.checked ?? []).map((label) => ({ label, ok: !(entry.failed ?? []).includes(label) }));

  /** Pass rates from the index alone, so a group of samples can say how it did before any file is read. */
  function chipsOf(entries: readonly ExploreIndexEntry[]): HTMLElement | null {
    const rates = passRates(entries.map((entry) => verdictSetOf(entry).map((v) => ({ ...v, detail: '' }))));
    if (rates.length === 0) return null;
    rates.sort((a, b) => a.passed / a.of - b.passed / b.of);
    return h('ul', { class: 'chips', attrs: { 'aria-label': 'Pass rate of each check' } }, ...rates.map((rate) => h('li', { class: rate.passed < rate.of ? 'chip weak' : 'chip', text: `${rate.label} ${rate.passed}/${rate.of}` })));
  }

  function renderTotals(): void {
    totals.replaceChildren(
      ...columns.map((column) => {
        const entries = column.run.prompts;
        const loaded = [...column.loaded.values()].filter((item): item is Loaded => item !== null);
        const firsts = loaded.flatMap((item) => answersOf(item).slice(0, 1));
        const all = loaded.flatMap(answersOf);
        const waiting = loaded.length < entries.length;
        const rates = passRates(entries.map((entry) => verdictSetOf(entry).map((v) => ({ ...v, detail: '' }))));
        const passed = rates.reduce((sum, rate) => sum + rate.passed, 0);
        const of = rates.reduce((sum, rate) => sum + rate.of, 0);
        const fact = (label: string, value: string): HTMLElement => h('div', { class: 'fact' }, h('dt', { text: label }), h('dd', { text: value }));
        const med = (pick: (r: ExploreResult) => number | null | undefined): number | null => median(firsts.flatMap((r) => pick(r) ?? []));
        const section = h(
          'section',
          { class: 'total' },
          h('h2', { text: labelOf(column.run) }),
          h(
            'dl',
            { class: 'facts' },
            fact('answers', `${entries.length}${column.run.samples === undefined ? '' : ` (${column.run.samples} samples each)`}, ${entries.filter((e) => e.heldOut === true).length} held out`),
            fact('checks passed', of === 0 ? 'none recorded' : `${passed} of ${of} (${Math.round((passed / of) * 100)}%)`),
            fact('median first word', seconds(med((r) => r.firstTextMs))),
            fact('median first visible', seconds(med((r) => r.firstVisibleMs))),
            fact('median last word', seconds(med((r) => r.totalMs))),
            fact('median viewer waits', seconds(med((r) => r.viewerWaitMs))),
            fact('median dollars per answer', dollars(median(firsts.flatMap((r) => r.usage?.costUsd ?? [])))),
            fact('spent', column.run.spentUsd == null ? 'unknown' : `${dollars(column.run.spentUsd)}${column.run.projection?.usd == null ? '' : ` (projected ${dollars(column.run.projection.usd)})`}`),
            fact('drew something', waiting ? 'counting' : `${firsts.filter(drewSomething).length} of ${firsts.length}`),
            fact('with a failed check', waiting ? 'counting' : String(all.filter((r) => failedCount(r) > 0).length)),
          ),
        );
        const variants = [...new Set(entries.flatMap((e) => (e.variant === undefined ? [] : [e.variant])))];
        if (variants.length > 1) section.append(variantTable(column, variants, waiting));
        const like = likeForLike(column, waiting);
        if (like !== null) section.append(like);
        return section;
      }),
    );
  }

  /** The decision: each prompt variant over the information prompts that ran under both. */
  function variantTable(column: Column, variants: readonly ExploreVariant[], waiting: boolean): HTMLElement {
    const infoKeys = new Set(
      column.run.prompts.filter((e) => e.kind !== 'case' && column.run.prompts.some((o) => keyOf(o) === keyOf(e) && o.variant !== e.variant)).map(keyOf),
    );
    const head = ['variant', 'answers', 'checks passed', 'judge coherence', 'judge: correct', 'median out tokens', 'median last word', 'median viewer waits', 'dollars per answer'];
    const body = variants.map((variant) => {
      const entries = column.run.prompts.filter((e) => e.variant === variant && infoKeys.has(keyOf(e)));
      const answers = entries.flatMap((e) => answersOf(column.loaded.get(e.id)));
      const rates = passRates(entries.map((e) => verdictSetOf(e).map((v) => ({ ...v, detail: '' }))));
      const passed = rates.reduce((sum, r) => sum + r.passed, 0);
      const of = rates.reduce((sum, r) => sum + r.of, 0);
      const judged = answers.flatMap((r) => (r.judge != null && r.judge.failure === null ? [r.judge] : []));
      const coherence = mean(judged.map((j) => j.coherence));
      return [
        variant,
        String(entries.length),
        of === 0 ? '-' : `${Math.round((passed / of) * 100)}%`,
        coherence === null ? '-' : coherence.toFixed(2),
        judged.length === 0 ? '-' : `${judged.filter((j) => j.correct).length} of ${judged.length}`,
        count(median(answers.flatMap((r) => r.usage?.outputTokens ?? []))),
        seconds(median(answers.map((r) => r.totalMs))),
        seconds(median(answers.flatMap((r) => r.viewerWaitMs ?? []))),
        dollars(mean(answers.flatMap((r) => r.usage?.costUsd ?? []))),
      ];
    });
    return h(
      'div',
      { class: 'variants' },
      h('h3', { text: `Prompt variants on the ${infoKeys.size} information prompts that ran under both${waiting ? ' (still reading files)' : ''}` }),
      h('table', {}, h('thead', {}, h('tr', {}, ...head.map((title) => h('th', { text: title, attrs: { scope: 'col' } })))), h('tbody', {}, ...body.map((row) => h('tr', {}, ...row.map((cell, at) => (at === 0 ? h('th', { text: cell, attrs: { scope: 'row' } }) : h('td', { text: cell }))))))),
    );
  }

  /** Against the plain answers, only over prompts that have one, with the mean of each prompt's samples. */
  function likeForLike(column: Column, waiting: boolean): HTMLElement | null {
    const byPrompt = new Map<string, ExploreResult[]>();
    for (const entry of column.run.prompts) {
      if (entry.kind === 'case') continue;
      const loaded = column.loaded.get(entry.id);
      if (loaded === null || loaded === undefined || isCase(loaded) || loaded.baseline === null) continue;
      byPrompt.set(keyOf(entry), [...(byPrompt.get(keyOf(entry)) ?? []), loaded]);
    }
    if (byPrompt.size === 0) return null;
    let tokens = 0;
    let baseTokens = 0;
    let cost = 0;
    let baseCost = 0;
    let wait = 0;
    let baseWait = 0;
    for (const answers of byPrompt.values()) {
      const base = answers[0]?.baseline;
      if (base == null) continue;
      tokens += mean(answers.flatMap((r) => r.usage?.outputTokens ?? [])) ?? 0;
      cost += mean(answers.flatMap((r) => r.usage?.costUsd ?? [])) ?? 0;
      wait += mean(answers.flatMap((r) => r.viewerWaitMs ?? [])) ?? 0;
      baseTokens += base.usage.outputTokens ?? 0;
      baseCost += base.usage.costUsd ?? 0;
      baseWait += base.totalMs;
    }
    return h(
      'p',
      { class: 'like' },
      `Against plain answers, like for like over ${byPrompt.size} prompts${waiting ? ' read so far' : ''}: ${count(Math.round(tokens))} tokens against ${count(baseTokens)}; ${dollars(cost)} against ${dollars(baseCost)}; the viewer waits ${seconds(wait)} in all against ${seconds(baseWait)} for the plain answers to finish.`,
    );
  }

  function applyFilters(): void {
    const use = pickUse.value;
    for (const [key, row] of rowsByKey) {
      const entries = columns.flatMap((column) => column.run.prompts.filter((e) => keyOf(e) === key));
      const useCase = entries[0]?.useCase;
      let show = use === '' || useCase === use;
      if (show && onlyHeldOut.checked) show = entries.some((e) => e.heldOut === true);
      if (show && onlyFailed.checked) show = entries.some((e) => (e.failed ?? []).length > 0 || (e.checked === undefined && columns.some((c) => answersOf(c.loaded.get(e.id)).some((r) => failedCount(r) > 0))));
      row.hidden = !show;
    }
  }

  function pushHash(): void {
    const a = pickA.value;
    const b = pickB.value;
    history.replaceState(null, '', `#run=${encodeURIComponent(a)}${b === '' ? '' : `&compare=${encodeURIComponent(b)}`}`);
  }

  /** A card for a scripted conversation: one card per turn, once the file is read. */
  function conversationCard(label: string): Card {
    const element = h('div', { class: 'conversation', attrs: { 'aria-busy': 'true' } }, h('p', { class: 'note', text: `${label}: loading` }));
    const cards: Card[] = [];
    let woken = false;
    return {
      element,
      show(result) {
        cards.length = 0;
        element.setAttribute('aria-busy', 'false');
        if (result === null) {
          element.replaceChildren(h('p', { class: 'note', text: `${label}: this run has no answer.` }));
          return;
        }
        // `show` is given an ExploreResult by the generic code; a conversation file is handed over under that type.
        const file = result as unknown as ExploreCaseResult;
        const turns = file.turns ?? [];
        const fix = file.fix ?? null;
        element.replaceChildren(
          h('p', { class: 'why', text: file.case?.why ?? '' }),
          ...(fix === null ? [] : [h('p', { class: 'note', text: `Looking at its own picture and fixing it: judge's coherence ${fix.before ?? '?'} before, ${fix.after ?? '?'} after${fix.improved === null ? '' : fix.improved ? ' (improved)' : ' (not improved)'}.` })]),
        );
        for (const turn of turns) {
          const card = createCard(`${label}, turn ${turn.turn?.index ?? cards.length + 1}`, services);
          card.show(turn);
          cards.push(card);
          element.append(card.element);
          if (woken) card.wake();
        }
      },
      wake() {
        woken = true;
        for (const card of cards) card.wake();
      },
    };
  }

  async function load(): Promise<void> {
    const mine = ++generation;
    stills.forget();
    current?.release();
    current = null;
    observer.disconnect();
    cardsByRow.clear();
    rowsByKey.clear();
    rows.replaceChildren();
    totals.replaceChildren();
    columns = [];

    const chosen = [pickA.value, pickB.value].filter((id) => id !== '');
    const picked = chosen.map((id) => runs.find((run) => run.id === id)).filter((run): run is ExploreRun => run !== undefined);
    if (picked.length === 0) return;
    pushHash();

    const settled = await Promise.all(
      picked.map(async (run) => {
        try {
          return await getJson<ExploreRun>(API.exploreRun(run.id));
        } catch {
          return run;
        }
      }),
    );
    if (mine !== generation) return;
    columns = settled.map((run) => ({ run, loaded: new Map() }));

    const useCases = new Map<string, string>();
    const order: string[] = [];
    for (const column of columns) {
      for (const entry of column.run.prompts) {
        if (!useCases.has(keyOf(entry))) {
          useCases.set(keyOf(entry), entry.useCase);
          order.push(keyOf(entry));
        }
      }
    }
    const kept = pickUse.value;
    const cases = [...new Set(useCases.values())];
    fillSelect(pickUse, [{ value: '', text: 'All' }, ...cases.map((c) => ({ value: c, text: c }))], cases.includes(kept) ? kept : '');

    const tasks: (() => Promise<void>)[] = [];
    for (const key of order) {
      const cards: Card[] = [];
      const cell = h('div', { class: columns.length > 1 ? 'cards two' : 'cards' });
      const anyEntry = columns.flatMap((c) => c.run.prompts).find((e) => keyOf(e) === key);
      const title = h(
        'div',
        { class: 'row-head' },
        h('span', { class: 'use-case', text: useCases.get(key) ?? '' }),
        h('span', { class: 'prompt-id', text: key }),
        anyEntry?.kind === 'case' ? h('span', { class: 'held-out', text: 'conversation' }) : null,
        anyEntry?.heldOut === true ? h('span', { class: 'held-out', text: 'held out' }) : null,
      );
      const promptText = h('p', { class: 'prompt-text', text: 'loading' });
      const row = h('section', { class: 'row', attrs: { 'aria-label': `${useCases.get(key) ?? key}` } }, title, promptText, cell);
      row.dataset['prompt'] = key;

      for (const column of columns) {
        const entries = column.run.prompts.filter((e) => keyOf(e) === key);
        const holder = h('div', { class: 'run-cell' });
        if (columns.length > 1) holder.append(h('h3', { class: 'run-label', text: labelOf(column.run) }));
        cell.append(holder);
        if (entries.length === 0) {
          holder.append(h('p', { class: 'note', text: `${labelOf(column.run)}: this run has no answer for this prompt.` }));
          continue;
        }
        const variantsHere = [...new Set(entries.map((e) => e.variant ?? ''))];
        for (const variant of variantsHere) {
          const group = entries.filter((e) => (e.variant ?? '') === variant).sort((a, b) => (a.sample ?? 0) - (b.sample ?? 0));
          const chips = chipsOf(group);
          const spent = mean(group.flatMap((e) => e.costUsd ?? []));
          const head = h(
            'div',
            { class: 'variant-head' },
            variant === '' ? null : h('strong', { text: variant }),
            h('span', { text: `${group.length} sample${group.length === 1 ? '' : 's'}${spent === null ? '' : `, ${dollars(spent)} each`}` }),
            chips,
          );
          const wrapper = h('div', { class: 'variant-group' }, head);
          const folded = h('details', { class: 'more-samples' }, h('summary', { text: `Samples 2 to ${group.length}` }));
          group.forEach((entry, at) => {
            const label = `${variant === '' ? '' : `${variant}, `}sample ${entry.sample ?? at + 1}`;
            const card = entry.kind === 'case' ? conversationCard(label) : createCard(label, services);
            cards.push(card);
            (at === 0 ? wrapper : folded).append(card.element);
            tasks.push(async () => {
              if (mine !== generation) return;
              let result: Loaded | null = null;
              try {
                result = await getJson<Loaded>(API.exploreResult(column.run.id, entry.id));
              } catch (error) {
                card.element.replaceChildren(h('p', { class: 'note bad', text: `Could not read this answer: ${error instanceof Error ? error.message : String(error)}` }));
                card.element.setAttribute('aria-busy', 'false');
                column.loaded.set(entry.id, null);
                return;
              }
              if (mine !== generation) return;
              column.loaded.set(entry.id, result);
              const first = answersOf(result)[0];
              if (first !== undefined && promptText.textContent === 'loading') promptText.textContent = isCase(result) ? result.case.turns.map((t) => (t.do === 'prompt' ? t.text : t.do === 'tap' ? '(taps a choice)' : `(${t.text ?? 'look at what you drew; fix it'})`)).join('  →  ') : first.prompt.prompt;
              card.show(result as ExploreResult);
              renderTotals();
              applyFilters();
            });
          });
          if (group.length > 1) wrapper.append(folded);
          holder.append(wrapper);
        }
      }
      if (promptText.textContent === 'loading') promptText.textContent = '';
      cardsByRow.set(key, cards);
      rowsByKey.set(key, row);
      rows.append(row);
      observer.observe(row);
    }
    renderTotals();
    applyFilters();
    say(`${order.length} prompts and conversations${columns.length > 1 ? `, ${columns.length} runs side by side` : ''}.`);

    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < tasks.length && mine === generation) {
        const task = tasks[next++];
        if (task !== undefined) await task();
      }
    };
    await Promise.all(Array.from({ length: FETCH_AT_ONCE }, worker));
    if (mine === generation) applyFilters();
  }

  function empty(message: string): void {
    controls.hidden = true;
    rows.replaceChildren(
      h(
        'section',
        { class: 'empty' },
        h('h2', { text: 'No runs yet' }),
        h('p', { text: message }),
        h('p', {}, 'Make one with ', h('code', { text: 'pnpm explore' }), ' (every prompt and conversation, three samples each, judged by a model that looks at the picture; ', h('code', { text: 'pnpm explore --dry-run' }), ' prints the cost first) or ', h('code', { text: 'pnpm explore --brain replay' }), ' (no model, to see this page work). Then reload.'),
      ),
    );
  }

  async function start(): Promise<void> {
    try {
      runs = await getJson<ExploreRun[]>(API.exploreRuns);
    } catch (error) {
      empty(`The server did not list any runs (${error instanceof Error ? error.message : String(error)}). It has to be running: this page reads run files from it and calls no brain.`);
      return;
    }
    if (runs.length === 0) {
      empty('The exploration battery has not been run on this machine.');
      return;
    }
    const options = runs.map((run) => ({ value: run.id, text: labelOf(run) }));
    const hash = new URLSearchParams(location.hash.slice(1));
    const wanted = hash.get('run');
    const compare = hash.get('compare');
    fillSelect(pickA, options, runs.some((run) => run.id === wanted) ? (wanted ?? '') : (runs[0]?.id ?? ''));
    fillSelect(pickB, [{ value: '', text: 'Nothing' }, ...options], runs.some((run) => run.id === compare) ? (compare ?? '') : '');
    fillSelect(pickUse, [{ value: '', text: 'All' }], '');
    pickA.addEventListener('change', () => void load());
    pickB.addEventListener('change', () => void load());
    pickUse.addEventListener('change', applyFilters);
    onlyFailed.addEventListener('change', applyFilters);
    onlyHeldOut.addEventListener('change', applyFilters);
    await load();
  }

  window.addEventListener('pagehide', () => {
    stills.dispose();
    exporter?.dispose();
  });

  void start();
}
