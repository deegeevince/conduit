// One answer of one run: stills, Play, numbers, checks, words, script, baseline, Save film.

import type { ExploreJudgement, ExploreResult } from '@conduit/language';
import { EMPTY_STAGE, parseLine } from '@conduit/language';
import type { Film, Recording } from '../contracts/film';
import type { Exporter } from '../contracts/export';
import type { Renderer } from '../contracts/renderer';
import type { Line } from '@conduit/language';
import { createFilm } from '../painter/film';
import { verdictsOf, wordsOf } from './checks';
import { count, dollars, h, seconds } from './dom';
import { mountLive } from './live';
import type { LiveStage } from './live';
import type { StillMaker } from './stills';
import { STILLS } from './stills';

export const STAGE_WIDTH = 640;
export const STAGE_HEIGHT = 360;

/** What every card shares: one strip renderer, one live stage, one exporter. */
export interface Services {
  readonly stills: StillMaker;
  readonly exporter: () => Exporter;
  readonly makeRenderer: () => Renderer;
  /** stops whatever is playing and says which card is now allowed to; the claim is what the card gives back when it lets go */
  readonly claimStage: (release: () => void) => StageClaim;
  /** lets go of a claim. A claim that has already been replaced by another card's is ignored: it must not forget the new one. */
  readonly releaseStage: (claim: StageClaim) => void;
}

export interface StageClaim {
  readonly release: () => void;
}

export interface Card {
  readonly element: HTMLElement;
  /** Fills the card with a result; null says this run has no answer for the prompt. */
  show(result: ExploreResult | null): void;
  /** Called when the card scrolls near: makes its stills. */
  wake(): void;
}

export function recordingOf(result: ExploreResult): Recording {
  const lines: { seq: number; line: Line }[] = [];
  for (const entry of result.lines) {
    const parsed = parseLine(entry.text);
    if (parsed.kind === 'line') lines.push({ seq: entry.seq, line: parsed.line });
  }
  return { turn: result.prompt.id, base: result.base ?? EMPTY_STAGE, lines, paintings: {} };
}

function filmOf(result: ExploreResult, width: number, height: number): Film {
  return createFilm(recordingOf(result), { viewport: { width, height, dpr: 1 }, reducedMotion: false, arrival: 'at-once' });
}

function fact(label: string, value: string): HTMLElement {
  return h('div', { class: 'fact' }, h('dt', { text: label }), h('dd', { text: value }));
}

/** What the judge saw and said: the last picture it was shown, its score and its reasons. */
/** What the painter measured, and what working the answer's controls and charts came to: counts, not opinions. */
function measuresBlockOf(answer: ExploreResult): HTMLElement | null {
  const { geometry, drive, checks } = answer;
  const rows: HTMLElement[] = [];
  if (geometry !== undefined) {
    rows.push(fact('overlapping text', String(geometry.textOverlaps)), fact('connectors through nodes', String(geometry.linksThroughNodes)), fact('labels crossed', String(geometry.crossedLabels)), fact('clipped', String(geometry.clipped)));
  }
  if (checks.structures !== undefined && Object.keys(checks.structures).length > 0) {
    rows.push(fact('structures', Object.entries(checks.structures).map(([kind, n]) => `${n} ${kind}`).join(', ')), fact('placed by hand', String(checks.placedByHand ?? 0)));
  }
  for (const control of drive?.controls ?? []) {
    const changed = control.changed === null ? '' : `, picture changes ${(control.changed * 100).toFixed(1)}%`;
    rows.push(fact(`${control.kind} ${control.id}`, `${control.bound ? 'bound' : 'not bound'}, ${control.reported ? 'event heard' : 'no event'}${changed}${control.answered === null ? '' : control.answered ? ', answered' : ', not answered'}`));
  }
  for (const chart of drive?.charts ?? []) rows.push(fact(`chart ${chart.id}`, `crosshair ${chart.crosshair ? 'ok' : 'FAILED'}, zoom ${chart.zoomed ? 'ok' : 'FAILED'}, ${chart.silent ? 'silent' : 'OPENED A TURN'}`));
  return rows.length === 0 ? null : h('div', { class: 'facts measures' }, ...rows);
}

/** Look and fix: the draft's picture beside the answer as it ended, with the judge's two scores. */
function reviewBlockOf(answer: ExploreResult): HTMLElement | null {
  const review = answer.review;
  if (review === undefined) return null;
  const finalStill = answer.judge?.stills[answer.judge.stills.length - 1];
  const picture = (src: string | undefined, caption: string): HTMLElement =>
    h('figure', { class: 'review-pic' }, src === undefined ? h('p', { class: 'note', text: 'no picture' }) : h('img', { attrs: { src, alt: caption } }), h('figcaption', { text: caption }));
  const draft = review.draftStills?.[review.draftStills.length - 1];
  return h(
    'div',
    { class: 'review' },
    h('p', { class: 'note', text: `Look and fix: ${review.result}${review.why === null ? '' : ` (${review.why})`}; first line of the fix ${review.firstLineMs === null ? 'none' : seconds(review.firstLineMs)}, added wait ${seconds(review.addedWaitMs)}` }),
    h('div', { class: 'review-pair' }, picture(draft, `Draft${review.before === null ? '' : `: coherence ${review.before}`}`), picture(finalStill, `After the look${review.after === null ? '' : `: coherence ${review.after}`}`)),
  );
}

function judgeBlockOf(judge: ExploreJudgement | null): HTMLElement | null {
  if (judge === null) return null;
  if (judge.failure !== null) return h('p', { class: 'note bad', text: `No judge's verdict: ${judge.failure}` });
  const problems = [
    judge.asked ? null : 'does not show what was asked',
    judge.textProblem === null ? null : `text: ${judge.textProblem}`,
    judge.wrongLabel === null ? null : `label: ${judge.wrongLabel}`,
    judge.correct ? null : `wrong: ${judge.mistake ?? 'not correct'}`,
  ].filter((item): item is string => item !== null);
  const last = judge.stills[judge.stills.length - 1];
  return h(
    'div',
    { class: 'judge' },
    last === undefined ? null : h('img', { class: 'judged-still', attrs: { src: last, alt: 'The final still the judge was shown', width: '240', height: '135', loading: 'lazy' } }),
    h(
      'div',
      { class: 'judge-text' },
      h('p', { class: judge.coherence >= 4 ? 'score good' : 'score poor', text: `Judge (${judge.model}): coherence ${judge.coherence} of 5` }),
      h('p', { text: judge.why }),
      ...(problems.length === 0 ? [h('p', { class: 'note', text: 'Nothing wrong found.' })] : [h('ul', { class: 'problems' }, ...problems.map((text) => h('li', { text })))]),
    ),
  );
}

/** For a turn of a scripted conversation: what the viewer did, and whether the brain stayed warm. */
function turnBlockOf(answer: ExploreResult): HTMLElement | null {
  const turn = answer.turn;
  if (turn === undefined) return null;
  const parts = [
    `Turn ${turn.index}: ${turn.kind}`,
    turn.form === null ? null : `brief ${turn.form}`,
    turn.cacheReadShare === null ? null : `${Math.round(turn.cacheReadShare * 100)}% from cache`,
    turn.withSnapshot ? 'with the picture' : null,
    turn.changed,
    turn.interruptedAtMs === null ? null : `cut off at ${(turn.interruptedAtMs / 1000).toFixed(1)} s`,
  ].filter((item): item is string => item !== null);
  return h('p', { class: 'turn-head' }, h('strong', { text: parts.join(' · ') }), h('span', { class: 'said', text: ` "${turn.said}"` }));
}

function download(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = h('a', { attrs: { href: url, download: fileName } });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function createCard(label: string, services: Services): Card {
  const element = h('article', { class: 'card', attrs: { 'aria-busy': 'true' } });
  element.append(h('p', { class: 'note', text: `${label}: loading` }));
  let result: ExploreResult | null = null;
  let film: Film | null = null;
  let strip: HTMLElement | null = null;
  let woken = false;
  let stillsStarted = false;

  const stillsInto = (target: HTMLElement): void => {
    if (result === null || stillsStarted) return;
    stillsStarted = true;
    const answer = result;
    target.replaceChildren(h('p', { class: 'note', text: 'making stills' }));
    try {
      film ??= filmOf(answer, STAGE_WIDTH, STAGE_HEIGHT);
      const made = film;
      if (made.duration <= 0) {
        target.replaceChildren(h('p', { class: 'note', text: 'Nothing was put on stage.' }));
        return;
      }
      void services.stills
        .make(made)
        .then((urls) => {
          if (urls === null) {
            target.replaceChildren(h('p', { class: 'note', text: 'This browser cannot capture stills (it needs WebGL). Play still works.' }));
            return;
          }
          target.replaceChildren(
            ...urls.map((url, index) =>
              h('img', {
                class: 'still',
                attrs: { src: url, alt: `Frame ${index + 1} of ${STILLS}, at ${((made.duration * (index + 1)) / STILLS).toFixed(1)} seconds`, width: '480', height: '270', loading: 'lazy' },
              }),
            ),
          );
        })
        .catch((error: unknown) => {
          target.replaceChildren(h('p', { class: 'note bad', text: `Stills failed: ${error instanceof Error ? error.message : String(error)}` }));
        });
    } catch (error) {
      target.replaceChildren(h('p', { class: 'note bad', text: `Could not lay the answer out: ${error instanceof Error ? error.message : String(error)}` }));
    }
  };

  const build = (answer: ExploreResult): void => {
    result = answer;
    film = null;
    stillsStarted = false;
    const checks = answer.checks;
    const usage = answer.usage;

    const stage = h('div', { class: 'stage', attrs: { hidden: '' } });
    const stageHost = h('div', { class: 'stage-host' });
    stage.append(stageHost);
    strip = h('div', { class: 'strip' });
    const bar = h('div', { class: 'bar', attrs: { hidden: '' } });
    const scrub = h('input', { class: 'scrub', attrs: { type: 'range', min: '0', max: '1000', value: '0', 'aria-label': 'Playhead' } });
    const toggle = h('button', { class: 'button', text: 'Pause', attrs: { type: 'button' } });
    const clock = h('span', { class: 'clock', text: '0.0 s' });
    bar.append(toggle, scrub, clock);

    let live: LiveStage | null = null;
    let resizer: ResizeObserver | null = null;
    let claim: StageClaim | null = null;
    /** counts mounts: a mount that finishes after the card was closed (or replaced) is disposed instead of kept */
    let mountSerial = 0;
    let mounting = false;
    const stopLive = (): void => {
      mountSerial += 1;
      mounting = false;
      resizer?.disconnect();
      resizer = null;
      live?.dispose();
      live = null;
      stage.hidden = true;
      bar.hidden = true;
      strip?.removeAttribute('hidden');
      play.textContent = 'Play';
    };
    const letGo = (): void => {
      stopLive();
      if (claim !== null) services.releaseStage(claim);
      claim = null;
    };

    const play = h('button', { class: 'button primary', text: 'Play', attrs: { type: 'button' } });
    play.addEventListener('click', () => {
      // A second click while the stage is still mounting closes it; it must not start a second WebGL context and frame loop.
      if (live !== null || mounting) {
        letGo();
        return;
      }
      claim = services.claimStage(stopLive);
      try {
        film ??= filmOf(answer, STAGE_WIDTH, STAGE_HEIGHT);
      } catch (error) {
        strip?.replaceChildren(h('p', { class: 'note bad', text: `Could not play: ${error instanceof Error ? error.message : String(error)}` }));
        letGo();
        return;
      }
      const playing = film;
      const serial = (mountSerial += 1);
      mounting = true;
      stage.hidden = false;
      bar.hidden = false;
      strip?.setAttribute('hidden', '');
      play.textContent = 'Close';
      const fit = (): void => {
        const scale = stage.clientWidth / STAGE_WIDTH;
        stageHost.style.transform = `scale(${scale})`;
        stage.style.height = `${STAGE_HEIGHT * scale}px`;
      };
      fit();
      resizer = new ResizeObserver(fit);
      resizer.observe(stage);
      void mountLive(stageHost, playing, services.makeRenderer(), {
        onTick(time, running) {
          scrub.value = String(playing.duration > 0 ? Math.round((time / playing.duration) * 1000) : 0);
          clock.textContent = `${time.toFixed(1)} / ${playing.duration.toFixed(1)} s`;
          toggle.textContent = running ? 'Pause' : time >= playing.duration ? 'Replay' : 'Resume';
        },
      })
        .then((stageController) => {
          if (serial !== mountSerial) {
            stageController.dispose();
            return;
          }
          mounting = false;
          live = stageController;
        })
        .catch((error: unknown) => {
          if (serial !== mountSerial) return;
          letGo();
          strip?.replaceChildren(h('p', { class: 'note bad', text: `The live stage could not start: ${error instanceof Error ? error.message : String(error)}` }));
        });
    });
    toggle.addEventListener('click', () => live?.toggle());
    scrub.addEventListener('input', () => live !== null && film !== null && live.seek((Number(scrub.value) / 1000) * film.duration));

    const exportState = h('span', { class: 'export-state', attrs: { role: 'status' } });
    const save = h('button', { class: 'button', text: 'Save film', attrs: { type: 'button' } });
    let cancel: (() => void) | null = null;
    save.addEventListener('click', () => {
      if (cancel !== null) {
        cancel();
        return;
      }
      letGo();
      const exporter = services.exporter();
      void exporter.formats().then((formats) => {
        const format = formats.video[0];
        if (format === undefined && !formats.frames) {
          exportState.textContent = 'This browser can encode neither video nor stills.';
          return;
        }
        let job;
        try {
          const hd = filmOf(answer, 1280, 720);
          job = exporter.start(hd, format === undefined ? { kind: 'frames', width: 1280, height: 720, fps: 15 } : { kind: 'video', format, width: 1280, height: 720, fps: 30 });
        } catch (error) {
          exportState.textContent = error instanceof Error ? error.message : String(error);
          return;
        }
        save.textContent = 'Cancel';
        cancel = () => job.cancel();
        const stopListening = job.onProgress((progress) => {
          exportState.textContent = `${Math.round(progress.done * 100)}% (${progress.frame} of ${progress.frames})`;
        });
        job.done
          .then((file) => {
            download(file.blob, `${answer.prompt.id}-${file.fileName}`);
            exportState.textContent = `Saved ${file.fileName}`;
          })
          .catch((error: unknown) => {
            exportState.textContent = error instanceof DOMException && error.name === 'AbortError' ? 'Cancelled' : `Failed: ${error instanceof Error ? error.message : String(error)}`;
          })
          .finally(() => {
            stopListening();
            cancel = null;
            save.textContent = 'Save film';
          });
      });
    });

    const kinds = Object.entries(checks.kinds)
      .filter(([, amount]) => (amount ?? 0) > 0)
      .map(([kind, amount]) => `${kind} ${amount}`)
      .join(', ');
    const facts = h(
      'dl',
      { class: 'facts' },
      fact('first word', seconds(answer.firstTextMs ?? null)),
      fact('first visible', seconds(answer.firstVisibleMs)),
      fact('last word', seconds(answer.totalMs)),
      fact('viewer waits', seconds(answer.viewerWaitMs ?? null)),
      fact('output tokens', usage === null ? 'unknown' : `${count(usage.outputTokens)}${usage.thinkingTokens === null ? '' : ` (${count(usage.thinkingTokens)} thinking)`}`),
      fact('dollars', dollars(usage?.costUsd ?? null)),
      fact('plays for', `${checks.playSeconds.toFixed(1)} s`),
      fact('words', String(checks.words)),
      fact('scenes, camera', `${checks.scenes}, ${checks.cameraMoves}`),
      fact('layers besides mid', String(checks.depthLayers)),
      fact('drawn', kinds === '' ? 'nothing' : kinds),
    );

    const verdicts = h(
      'ul',
      { class: 'verdicts' },
      ...(answer.verdicts ?? verdictsOf(answer)).map((verdict) =>
        h('li', { class: verdict.ok ? 'verdict ok' : 'verdict fail', attrs: { title: verdict.detail } }, h('span', { class: 'mark', text: verdict.ok ? 'ok' : 'fail', attrs: { 'aria-hidden': 'true' } }), ` ${verdict.label}`, h('span', { class: 'visually-hidden', text: verdict.ok ? ' passed' : ' failed' }), h('span', { class: 'detail', text: ` ${verdict.detail}` })),
      ),
    );

    const judgeBlock = judgeBlockOf(answer.judge ?? null);
    const measuresBlock = measuresBlockOf(answer);
    const reviewBlock = reviewBlockOf(answer);
    const turnBlock = turnBlockOf(answer);
    const words = wordsOf(answer);
    const wordsBlock = h('div', { class: 'words' }, ...(words.length === 0 ? [h('p', { class: 'note', text: 'No words were shown.' })] : words.map((text) => h('p', { text }))));

    const scriptText = answer.lines.map((line) => line.text).join('\n');
    const copy = h('button', { class: 'button', text: 'Copy', attrs: { type: 'button' } });
    copy.addEventListener('click', () => {
      void navigator.clipboard.writeText(scriptText).then(
        () => {
          copy.textContent = 'Copied';
          setTimeout(() => (copy.textContent = 'Copy'), 1500);
        },
        () => {
          copy.textContent = 'Copy failed';
        },
      );
    });
    const script = h('details', { class: 'script' }, h('summary', { text: `Script (${answer.lines.length} lines${answer.rejects.length > 0 ? `, ${answer.rejects.length} rejected` : ''})` }), copy, h('pre', { text: scriptText }));
    if (answer.rejects.length > 0) {
      script.append(
        h('p', { class: 'note bad', text: 'Rejected lines' }),
        h('pre', { text: answer.rejects.map((reject) => `${reject.raw}\n  ${reject.issues.map((issue) => issue.message).join('; ')}`).join('\n') }),
      );
    }

    const baseline =
      answer.baseline === null
        ? null
        : h(
            'details',
            { class: 'baseline' },
            h('summary', { text: `Plain answer: ${answer.baseline.words} words, ${seconds(answer.baseline.totalMs)}, ${dollars(answer.baseline.usage.costUsd)}, ${count(answer.baseline.usage.outputTokens)} tokens` }),
            h('p', { class: 'plain', text: answer.baseline.text }),
          );

    element.replaceChildren(
      h('div', { class: 'card-head' }, h('span', { class: 'run-label', text: label }), h('span', { class: `end ${answer.end === 'done' || answer.turn?.interruptedAtMs != null ? '' : 'bad'}`, text: answer.turn?.interruptedAtMs != null ? 'cut off' : answer.end })),
      ...(turnBlock === null ? [] : [turnBlock]),
      stage,
      strip,
      bar,
      h('div', { class: 'actions' }, play, save, exportState),
      facts,
      ...(judgeBlock === null ? [] : [judgeBlock]),
      ...(reviewBlock === null ? [] : [reviewBlock]),
      ...(measuresBlock === null ? [] : [measuresBlock]),
      verdicts,
      wordsBlock,
      script,
      ...(baseline === null ? [] : [baseline]),
    );
    element.setAttribute('aria-busy', 'false');
    if (woken && strip !== null) stillsInto(strip);
  };

  return {
    element,
    show(next) {
      if (next === null) {
        result = null;
        element.setAttribute('aria-busy', 'false');
        element.replaceChildren(h('p', { class: 'note', text: `${label}: this run has no answer for this prompt.` }));
        return;
      }
      build(next);
    },
    wake() {
      woken = true;
      if (strip !== null) stillsInto(strip);
    },
  };
}
