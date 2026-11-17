// What a demo promises and what its lines can keep, read from the schedule alone: no browser. Run by `pnpm timeline` (and `pnpm timeline demos`, which `pnpm check --only fb-028`
// runs).
//
//   fb-028  A chart that is not what was asked: a chart in a demo whose model carries a note (rows too few for candles, columns drawn as a line, uneven times) or a problem
//           is not the chart the demo says it shows. The demo's data is fixed, never left to the painter to make do.
//   fb-033  A promise the words make that the lines cannot keep: every control a demo hands over (slider, toggle, pick, field) is named by a `bind` or by `{id}` in some words,
//           so that using it changes something. A button is not one of these: it asks the brain.
//
// Not mechanical beyond that: "it is not close" (fb-036) and "one trip round" (fb-034) need a reader.
import { chartModelOf } from '../src/index';
import type { ElementSpan } from '../src/index';
import { allDemos, play } from './demo-lib';

const CONTROLS_NEEDING_USE = new Set(['slider', 'toggle', 'pick', 'input']);

/** `problem`: the blanks of a worked question are the learner's to fill and the stage checks them; nothing is bound to them on purpose. */
const NO_BINDINGS_NEEDED = new Set(['problem']);

export function demoRules(): boolean {
  let ok = true;
  let charts = 0;
  let controls = 0;
  const out = (text: string): void => void process.stdout.write(text);
  for (const demo of allDemos()) {
    const played = play(demo.source);
    const { schedule } = played;
    // fb-028
    for (const element of schedule.elements) {
      const figure = element.figure;
      if (figure?.kind !== 'structure' || figure.chart === null || figure.rows.length === 0) continue;
      charts += 1;
      const model = chartModelOf(figure.chart, figure.rows, {});
      for (const note of [...model.notes, ...model.problems]) {
        ok = false;
        out(`  DEMO RULE FAILED (fb-028) ${demo.name}: chart "${element.id}" is not the chart it says it is: ${note}\n`);
      }
    }
    // fb-033
    const texts = schedule.elements.map((element) => element.text).join('\n');
    const controlOf = (element: ElementSpan): string | null => (element.kind === 'control' && element.figure?.kind === 'control' && CONTROLS_NEEDING_USE.has(element.figure.control) ? element.id : null);
    const bound = new Set(schedule.elements.flatMap((element) => element.driven.map((change) => change.control)));
    const boundIds = new Set(schedule.elements.filter((element) => bound.has(element.key)).map((element) => element.id));
    for (const element of schedule.elements) {
      const id = controlOf(element);
      if (id === null || NO_BINDINGS_NEEDED.has(demo.name)) continue;
      controls += 1;
      const said = new RegExp(`\\{[^}]*\\b${id.replace(/[^\w]/g, '\\$&')}\\b[^}]*\\}`).test(texts);
      if (!boundIds.has(id) && !said) {
        ok = false;
        out(`  DEMO RULE FAILED (fb-033) ${demo.name}: the ${element.figure?.kind === 'control' ? element.figure.control : 'control'} "${id}" is handed over but nothing is bound to it and no words show it ({${id}}): using it changes nothing\n`);
      }
    }
  }
  out(`demo rules (fb-028, fb-033): ${charts} charts and ${controls} controls read, ${ok ? 'every chart is what it says and every control changes something' : 'see the lines above'}\n`);
  return ok;
}
