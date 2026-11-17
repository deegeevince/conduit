// The film's session surround with no browser: the made-up session (`film-session.ts`) laid out as a reel, cut, and read back as data at many moments.
// Prints JSON for `server/src/tools/film-check.ts` to judge.
//
//   tsx --import ./src/bench/node-register.mjs src/bench/film-bench.ts        (from language/, as `pnpm check --only film` does)

import { paletteOf } from '../app/lang-style';
import { cutFilm, cutsOf, CUTS } from '../export/cuts';
import { contrastRatio } from '../looks/colour-math';
import { createFilm, lineSpans } from '../painter/film';
import { DRAG, leadOf, TYPING } from '../painter/reel';
import { buildSession } from './film-session';
import type { SessionRequest } from './film-session';

/** The captions a session of the made-up turns is given, and the tag: what a reel would say of its pages. */
const CAPTIONS = {
  t1: { name: 'Type a question', caption: 'Write what you want to know. The answer is drawn in front of you.' },
  t3: { name: 'Tap an answer', caption: 'Tap a choice on the canvas and it becomes your next question.' },
} as const;
const TAG = 'Scripted tour, no model';
/** a moment (uncut film seconds) in the first turn, after its first line has come and before it ends */
const WHOLE = 30;

const SCREENS = [
  { name: '1280x720', width: 1280, height: 720 },
  { name: '390x844', width: 390, height: 844 },
] as const;

async function main(): Promise<void> {
  const fs: { readFileSync(path: URL, encoding: string): string } = await import(/* @vite-ignore */ 'node:fs' as string);
  const explorable = fs.readFileSync(new URL('../../../language/demos/explorable.series', import.meta.url), 'utf8');
  const out: unknown[] = [];
  for (const screen of SCREENS) {
    // the viewer left the slider at 70 before asking for the film: the film must not show it
    const session = buildSession(screen.width, screen.height, explorable, { height: 70 });
    const { film, reel, recordings, layout } = session;
    const cuts = cutsOf(film.activity ?? [], film.duration, CUTS.threshold, CUTS.keep);
    const cutting = cutFilm(film, cuts, CUTS);
    const cut = cutting.film;
    // what the quiet stretches are, worked out here from the recordings and not from the film's own activity: the typing ends, then the model's first line starts
    const gaps = reel.parts
      .filter((part) => !part.card)
      .map((part) => {
        const recording = recordings.find((candidate) => candidate.turn === part.turn);
        const spans = recording === undefined ? [] : [...lineSpans(recording).values()];
        const first = Math.min(...spans.map((span) => span.start));
        const typingEnds = (part.lead?.from ?? part.from) + (recording === undefined ? 0 : leadOf(recording));
        return { turn: part.turn, quietFrom: typingEnds, quietTo: part.from + first };
      });
    const samples: unknown[] = [];
    for (let at = 0; at < cut.duration; at += 0.1) {
      samples.push({ at: Math.round(at * 1000) / 1000, real: Math.round(cutting.real(at) * 1000) / 1000, scene: cut.surround?.describe?.(at) });
    }
    const heightAt = (at: number): number | string | boolean | null => reel.controlsAt?.(at)?.find((control) => control.id === 'height')?.value ?? null;
    let first = 0;
    for (let at = 0; at < reel.duration; at += 0.05) {
      if ((reel.controlsAt?.(at) ?? []).some((control) => control.id === 'height')) {
        first = at;
        break;
      }
    }
    // follow: every line that takes more than 0.7 s to draw and has an element, probed 0.6 s in (the ease is over), against the framing and the painter's box of that element then
    const probes: unknown[] = [];
    for (const part of reel.parts) {
      const recording = recordings.find((candidate) => candidate.turn === part.turn);
      if (recording === undefined) continue;
      const spans = lineSpans(recording);
      for (const { seq, line } of recording.lines) {
        const span = spans.get(seq);
        if (span === undefined || !('id' in line) || typeof line.id !== 'string' || span.end - span.start < 0.7 || line.verb === 'scene') continue;
        const real = part.from + span.start + 0.6;
        const box = reel.boxOf?.(line.id, real) ?? null;
        if (box === null) continue;
        probes.push({ id: line.id, verb: line.verb, real, framing: film.framing?.(real), box, stage: { width: layout.stage.width, height: layout.stage.height } });
      }
    }
    const t2 = reel.parts.find((part) => part.turn === 't2');
    out.push({
      screen: screen.name,
      layout: session.layout,
      typing: TYPING,
      realDuration: film.duration,
      filmDuration: cut.duration,
      cutList: cutting.list,
      gaps,
      notes: session.notes,
      follow: { probes, rest: { real: reel.duration, framing: film.framing?.(reel.duration) }, waiting: { real: 10, framing: film.framing?.(10) } },
      parts: reel.parts,
      samples,
      // what the slider holds when it first comes on stage (the viewer had left it at 70), just before the act turn begins, and a second into it
      height: { first: { at: first, value: heightAt(first) }, beforeAct: { at: (t2?.lead?.from ?? 0) - 0.05, value: heightAt((t2?.lead?.from ?? 0) - 0.05) }, inAct: { at: (t2?.from ?? 0) + 1, value: heightAt((t2?.from ?? 0) + 1) } },
    });
  }
  console.log(JSON.stringify(out.map((run, index) => ({ ...(run as object), ...(index === 0 ? { options: options(explorable) } : {}) }))));
}

/** The seconds a film has from `from` to `to` sampled every `step` (the end not included). */
function times(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let at = from; at < to - 1e-9; at += step) out.push(Math.round(at * 1000) / 1000);
  return out;
}

const run = (explorable: string, request: SessionRequest, look?: string, screen: { width: number; height: number } = SCREENS[0]) => buildSession(screen.width, screen.height, explorable, undefined, request, look);

/** What each export option does to the made-up session, as data: the film of the request, sampled. */
function options(explorable: string): unknown {
  // cards: a title card per turn of a conversation, unless the request says not
  const cardsOf = (request: SessionRequest): unknown => {
    const session = run(explorable, request);
    const parts = session.reel.parts;
    const seen = times(0, session.reel.duration, 0.25).filter((at) => session.reel.frameAt(at).elements.some((element) => element.id === 'c1' && element.opacity > 0.5)).length;
    return { turns: session.recordings.length, parts: parts.length, cardParts: parts.filter((part) => part.card).length, duration: session.reel.duration, cardFrames: seen };
  };
  const cards = { off: cardsOf({ cards: false }), default: cardsOf({}), on: cardsOf({ cards: true }) };

  // surround: the pane and the input box, each in or out, at a wide and a tall picture
  const surround = SCREENS.flatMap((screen) =>
    [true, false].flatMap((pane) =>
      [true, false].map((prompt) => {
        const session = run(explorable, { cards: false, surround: { pane, prompt } }, undefined, screen);
        const surroundOf = session.film.surround;
        // typing is under way at 2 s; the pane has its first rows once the model's first line has come
        const rowsAt = times(0, session.film.duration, 0.1).find((at) => (surroundOf?.describe?.(at).rows.length ?? 0) >= 3) ?? -1;
        return { screen: screen.name, pane, prompt, layout: session.layout, width: screen.width, height: screen.height, typing: surroundOf?.describe?.(2), rowsAt, rows: rowsAt < 0 ? null : surroundOf?.describe?.(rowsAt), stageOfFilm: surroundOf?.stage };
      }),
    ),
  );

  // captions and the tag: over the made-up turns, in the paper look and the night look, at a wide and a tall picture
  const labelled = (look: string, screen: { width: number; height: number }): unknown => {
    const session = run(explorable, { cards: false, captions: CAPTIONS, tag: TAG }, look, screen);
    const surroundOf = session.film.surround;
    const samples = times(0, session.film.duration, 0.05).map((at) => {
      const scene = surroundOf?.describe?.(at);
      return { at, caption: scene?.caption === undefined || scene.caption === null ? null : { name: scene.caption.name, caption: scene.caption.caption, alpha: scene.caption.alpha, box: scene.caption.box }, tag: scene?.tag === undefined || scene.tag === null ? null : { text: scene.tag.text, box: scene.tag.box } };
    });
    // the colours at a moment the first caption is whole and the first answer has changed the look (it comes with the model's first line, after the wait)
    const whole = surroundOf?.describe?.(WHOLE);
    const roles = session.film.frameAt(WHOLE).spec.roles;
    const palette = paletteOf({ ground: roles.ground, ink: roles.ink, dim: roles.dim, accent: roles.accent });
    const caption = whole?.caption;
    const tag = whole?.tag;
    return {
      look,
      screen: screen.width,
      stage: session.layout.stage,
      width: screen.width,
      height: screen.height,
      turns: session.reel.parts.filter((part) => !part.card).map((part) => ({ turn: part.turn, from: part.lead?.from ?? part.from, to: part.to, duration: session.film.duration })),
      duration: session.film.duration,
      samples,
      colours: caption === undefined || caption === null || tag === undefined || tag === null ? null : { ground: caption.ground, ink: caption.ink, quiet: caption.quiet, tagInk: tag.ink, tagGround: tag.ground, roleGround: roles.ground, paletteGround: palette.ground, name: contrastRatio(caption.ink, caption.ground), words: contrastRatio(caption.quiet, caption.ground), tag: contrastRatio(tag.ink, tag.ground) },
    };
  };
  const reelSize = { width: 1920, height: 1080 };
  const labels = [labelled('paper', SCREENS[0]), labelled('night', SCREENS[0]), labelled('paper', SCREENS[1]), labelled('night', SCREENS[1]), labelled('paper', reelSize), labelled('night', reelSize)];
  // with nothing asked: no caption and no tag in any frame
  const quiet = run(explorable, { cards: false });
  const none = times(0, quiet.film.duration, 0.1).filter((at) => {
    const scene = quiet.film.surround?.describe?.(at);
    return (scene?.caption ?? null) !== null || (scene?.tag ?? null) !== null;
  }).length;

  // drag: the turn that carries a slider the viewer moved (an act), with and without the drag
  const dragOf = (drag: boolean): unknown => {
    const session = run(explorable, { cards: false, ...(drag ? { drag: true } : {}) });
    const reel = session.reel;
    const part = reel.parts.find((candidate) => candidate.turn === 't2' && !candidate.card);
    const lead = part?.lead;
    if (part === undefined || lead === undefined) return null;
    const at = (t: number): { at: number; value: unknown; sun: { x: number; y: number } | null; shadow: number | null } => {
      const sun = reel.boxOf?.('sun', t) ?? null;
      const shadow = reel.boxOf?.('shadow', t) ?? null;
      return { at: Math.round(t * 1000) / 1000, value: reel.controlsAt?.(t)?.find((control) => control.id === 'height')?.value ?? null, sun: sun === null ? null : { x: sun.x + sun.width / 2, y: sun.y + sun.height / 2 }, shadow: shadow === null ? null : shadow.width };
    };
    const cutting = cutFilm(session.film, cutsOf(session.film.activity ?? [], session.film.duration, CUTS.threshold, CUTS.keep), CUTS);
    // the first turn's own film with the slider held at 60, as the static controls path makes it: where the picture must be once the drag is over
    const first = session.recordings[0];
    const held = first === undefined ? null : createFilm(first, { apps: false, viewport: { width: session.layout.stage.width, height: session.layout.stage.height, dpr: 1 }, reducedMotion: false, arrival: 'at-once', controls: { height: 60 } });
    const heldSun = held?.boxOf?.('sun', (held?.duration ?? 0) + 1) ?? null;
    const heldShadow = held?.boxOf?.('shadow', (held?.duration ?? 0) + 1) ?? null;
    const ripple = times(lead.from, part.from, 0.05).find((t) => session.film.surround?.describe?.(t).ripple !== null);
    return {
      drag,
      duration: reel.duration,
      lead,
      turnFrom: part.from,
      cutFrom: cutting.cut(lead.from),
      samples: times(lead.from, part.from + 0.5, 0.05).map(at),
      rippleAt: ripple ?? null,
      control: reel.boxOf?.('height', part.from + 0.2) ?? null,
      sunBox: reel.boxOf?.('sun', lead.from) ?? null,
      held60: { sun: heldSun === null ? null : { x: heldSun.x + heldSun.width / 2, y: heldSun.y + heldSun.height / 2 }, shadow: heldShadow === null ? null : heldShadow.width },
      stage: session.layout.stage,
    };
  };
  const drag = { on: dragOf(true), off: dragOf(false), seconds: DRAG.seconds };
  return { cards, surround, labels, unlabelled: none, drag };
}

void main();
