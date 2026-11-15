// What `pnpm library check` holds the library to (PLAN-v2.md, table row 22):
// a prompt of a family that has a technique is handed it in the top three; a
// plain prompt is handed none.
//
// The expectation comes from what the battery says about a prompt, not from
// what the library hands over, so that the measure cannot be met by editing
// it. For a prompt with a `family` (and `structure`) the rule is general and
// is the same for the tune set and the held-out set. A few tune prompts of the
// older, unlabelled kind are named one by one; none of the held-out set is.
// Techniques are named by their seed file's stem, which is the one name that
// is the same in the seed and in Remote.

import type { ExplorePrompt } from '@conduit/language';

export type Expectation =
  /** a plain answer: no technique may be handed */
  | { readonly kind: 'none' }
  /** one of these must be among the top three */
  | { readonly kind: 'one-of'; readonly stems: readonly string[] }
  /** no claim either way: the prompt is not counted */
  | { readonly kind: 'open' };

const CHARTS = ['chart-candles', 'chart-growth-indexed', 'chart-numbers', 'screen-dashboard'] as const;

const BY_STRUCTURE: Readonly<Record<string, readonly string[]>> = {
  flow: ['flow-decision', 'flow-process'],
  cycle: ['cycle-loop'],
  timeline: ['timeline-dates'],
  tree: ['tree-hierarchy'],
  table: ['table-comparison', 'table-bars-ranking'],
  map: ['map-pins'],
};

const BY_FAMILY: Readonly<Record<string, readonly string[]>> = {
  mechanism: ['mechanism-callouts'],
  chart: CHARTS,
  explorable: ['explorable-slider', 'walkthrough-steps'],
  paint: ['paint-over-sketch'],
};

/** The older tune prompts that carry no family, named one by one. */
const NAMED: Readonly<Record<string, readonly string[]>> = {
  'four-stroke': ['walkthrough-steps', 'mechanism-callouts'],
  'heat-pump': ['table-comparison'],
  population: CHARTS,
  'laid-off': ['hard-thing-few-words'],
  'logo-sting': ['stated-length'],
  'bakery-clip': ['stated-length'],
  'bike-ad': ['stated-length'],
  'podcast-title': ['stated-length'],
  story: ['memory-scene'],
  lighthouse: ['paint-over-sketch'],
  'silk-road': ['map-pins'],
  'apollo-timeline': ['timeline-dates'],
  'family-tree': ['tree-hierarchy'],
  'umbrella-flow': ['flow-decision'],
  pancakes: ['flow-process', 'walkthrough-steps'],
  'root-two': ['walkthrough-steps'],
  'water-cycle': ['cycle-loop'],
  'pets-table': ['table-comparison'],
  'bubble-sort': ['walkthrough-steps', 'table-bars-ranking'],
};

export function expectationOf(prompt: ExplorePrompt): Expectation {
  if (prompt.expects === 'plain') return { kind: 'none' };
  const stems = (prompt.structure !== undefined ? BY_STRUCTURE[prompt.structure] : undefined) ?? (prompt.family !== undefined ? BY_FAMILY[prompt.family] : undefined) ?? NAMED[prompt.id];
  return stems === undefined ? { kind: 'open' } : { kind: 'one-of', stems };
}
