// The film's session surround with no browser: the made-up session (`film-session.ts`) laid out as a reel, cut, and read back as data at many moments.
// Prints JSON for `server/src/tools/film-check.ts` to judge.
//
//   tsx --import ./src/bench/node-register.mjs src/bench/film-bench.ts        (from language/, as `pnpm check --only film` does)

import { cutFilm, cutsOf, CUTS } from '../export/cuts';
import { lineSpans } from '../painter/film';
import { leadOf, TYPING } from '../painter/reel';
import { buildSession } from './film-session';

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
  console.log(JSON.stringify(out));
}

void main();
