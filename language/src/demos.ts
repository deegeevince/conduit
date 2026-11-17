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
    name: 'scripts',
    title: 'Scripts',
    summary: 'Every language the stage can write: Polish, Vietnamese, Greek, Russian, Arabic, Hebrew, Hindi, Thai and Chinese, one line each, and a line mixing English with Arabic.',
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
    summary: 'A live app beside the canvas: a Galton board. One HTML document in a locked sandbox drops a ball every 0.3 s, works out every bounce sixty times a second and builds a bell curve in its bins. It opens with fifty balls landed, keeps its count across a reload, and a tap drops a ball. The title and the label are drawn by the canvas.',
  },
  {
    name: 'deck',
    title: 'Deck',
    summary: 'A talk of three slides: `deck` makes each scene a slide, and the stage stops at the end of each for the viewer to step on.',
  },
  {
    name: 'problem',
    title: 'Problem',
    summary: 'A maths question to work out: the brain says the question and its answer in one line, and the stage draws the whole workspace (the question large, a blank for the pen, hints, pictures from its numbers) and checks the answer.',
  },
  {
    name: 'maths',
    title: 'Maths',
    summary: 'Written methods laid out as on paper, one block per method: a column sum of six 12s, subtraction by exchange, short multiplication, expanded form, a part-whole bond, a decimal sum, a worked sum that steps, and the four pictures (a bar, groups, an array and a number line). The painter works every digit and the answer is never drawn.',
  },
  {
    name: 'richness',
    title: 'Richness',
    summary: 'A brush for each stroke character, a texture for each fill, a soft edge, a gradient and a painting the renderer makes itself.',
  },
  {
    name: 'toolkit',
    title: 'Toolkit',
    summary: 'A painter\'s tools on lines the brain draws: dashes along a stroke, pressure, a graded colour, packed strokes that each taper alone, and gradients, glazes and clips.',
  },
  {
    name: 'art',
    title: 'Art',
    summary: 'Finished drawings from the shelf: a fox and a child by name, a mirrored fox, a label on a part, a move of the whole figure, and a quiet placeholder where the shelf has nothing yet.',
  },
  {
    name: 'explorable',
    title: 'Explorable',
    summary: 'A picture with a slider and a pick bound to it, and a button that asks the brain.',
  },
  {
    name: 'iterate',
    title: 'Iterate',
    summary: 'A drawing kept and improved in place: a sail, a bigger sail, a new colour and a flag, then the whole boat moving as one group; each change says only what changes.',
  },
  {
    name: 'controls',
    title: 'Controls',
    summary: 'A toggle, a pick and a field handed to the person, bound to a lamp: they answer at once with no round trip, and the name typed in is the lamp\'s label.',
  },
  {
    name: 'charts',
    title: 'Charts',
    summary: 'A line, columns, candles and an indexed comparison: rows in, an instrument with a crosshair out.',
  },
] as const satisfies readonly DemoInfo[];

/**
 * Demos of what the painter does not do yet (part two of v2.1): parsed and checked by `pnpm timeline`, still playable by name (the tour plays them), but not
 * offered in the gallery or the demo list until `deck` is whole. `code` left this list when the painter began to draw it (PC10: `painter/blocks/code.ts`).
 * `deck` has not: the words and blocks of its slides are painted, but the stop at the end of each slide and the stepping on (`DECKS_READY`, `Painter.slide`) are not
 * built, so it plays its slides one after another. Not offered is not unjudged: `pnpm check` plays every demo here too and judges what is on stage, as it does every other.
 */
export const DEMOS_NOT_PAINTED: readonly string[] = ['deck'];

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
