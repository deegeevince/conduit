import type { DemoInfo } from './wire';

/** The fixture scripts in `language/demos/<name>.series`. The first one is what a first visit performs. */
export const DEMOS = [
  {
    name: 'overture',
    title: 'Overture',
    summary: 'The first-load welcome, about fifteen seconds: what Conduit is in three short lines (the answer arrives as a drawing you can tap, drag and talk back to, and it stays on the stage), then seven starters to tap across a lesson in maths, a how-it-works diagram, a dashboard, an app mock-up, a real web page, an instrument and an explorable.',
  },
  {
    name: 'sketchbook',
    title: 'Sketchbook',
    summary: 'The drawing vocabulary at work: labels, a morph, a group and its copy, travel along a curve, three looks.',
  },
  {
    name: 'plainly',
    title: 'Plainly',
    summary: 'A question of fact answered as plain prose at reading speed: the medium is a choice.',
  },
  {
    name: 'titles',
    title: 'Titles',
    summary: 'Type as the whole show: a title card, a stalled brain held in silence, a visible correction.',
  },
  {
    name: 'styles',
    title: 'Styles',
    summary: 'One short script with no look of its own, so the same lines can be compared in every look.',
  },
  {
    name: 'diagrams',
    title: 'Diagrams',
    summary: 'A flow, a tree, a cycle, a timeline and a table: the brain names the parts, the painter lays them out. A follow-up said again costs nothing; only the new step lands.',
  },
  {
    name: 'code',
    title: 'Code',
    summary: 'Source taken exactly: indentation kept, a bar inside a line only a character, a bare bar an empty line. Three listings in three languages.',
  },
  {
    name: 'tune',
    title: 'Tune',
    summary: 'Music as ABC notation in two voices: a piano roll with a playhead, played by the painter\'s own synthesiser once the block is closed.',
  },
  {
    name: 'app',
    title: 'App',
    summary: 'A live app: one HTML document that runs in a locked sandbox on the stage, keeps its state and tells the stage what the user did.',
  },
  {
    name: 'deck',
    title: 'Deck',
    summary: 'A talk of three slides: `deck` makes each scene a slide, and the stage stops at the end of each for the viewer to step on.',
  },
  {
    name: 'explorable',
    title: 'Explorable',
    summary: 'A picture with a slider, a toggle and a pick bound to it, and a button that asks the brain.',
  },
  {
    name: 'charts',
    title: 'Charts',
    summary: 'A line, columns, candles and an indexed comparison: rows in, an instrument with a crosshair out.',
  },
] as const satisfies readonly DemoInfo[];

/**
 * Demos of what the painter does not paint yet (part two of v2.1): parsed and checked by `pnpm timeline`, still playable by name, but not
 * offered in the gallery or the demo list until `code` and `deck` put something on stage (the v2.1 review: the `code` demo showed captions
 * about code on an empty stage).
 */
export const DEMOS_NOT_PAINTED: readonly string[] = ['code', 'deck'];

export type DemoName = (typeof DEMOS)[number]['name'];
export const FIRST_LOAD_DEMO: DemoName = 'overture';
export const GALLERY_DEMO: DemoName = 'styles';

/**
 * A fixture line starting with `#!` is an instruction to the replay brain,
 * not to the painter. To every other reader it is an ordinary comment.
 * `#! stall 3` holds the stream for three seconds, the way a real brain stalls.
 */
export type ReplayDirective = { readonly kind: 'stall'; readonly seconds: number };

export function parseReplayDirective(raw: string): ReplayDirective | null {
  const match = /^#!\s*stall\s+(\d+(?:\.\d+)?)\s*$/.exec(raw.trim());
  if (match === null || match[1] === undefined) return null;
  return { kind: 'stall', seconds: Number(match[1]) };
}
