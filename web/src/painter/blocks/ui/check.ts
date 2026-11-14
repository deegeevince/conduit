// Run under tsx (see web/src/bench/node-register.mjs): lays out F0's fixtures in both looks with the painter's own
// measurer and prints what the lint says and how long it took. No browser. The real judge of the solver is the bench page's oracle.
//
//   pnpm --filter @conduit/language exec tsx --import ../web/src/bench/node-register.mjs ../web/src/painter/blocks/ui/check.ts

import { STUDIO_TOKENS } from '../../../looks/studio';
import { WIREFRAME_TOKENS } from '../../../looks/wireframe';
import { FIXTURES } from './fixtures';
import { interfaceLines, parseInterface } from './lang';
import { layoutLines } from './screen';
import { paintersMeasure } from './measure';

const measure = paintersMeasure();
let blocking = 0;
for (const [name, fixture] of Object.entries(FIXTURES)) {
  for (const tokens of [WIREFRAME_TOKENS, STUDIO_TOKENS]) {
    const t0 = performance.now();
    const { screens, doc } = layoutLines(fixture.lines, tokens, measure);
    const ms = performance.now() - t0;
    const notes = screens.flatMap((s) => s.notes);
    const parts = screens.reduce((n, s) => n + s.parts.length, 0);
    console.log(`${name.padEnd(9)} ${tokens.id.padEnd(9)} ${screens.length} screens ${String(parts).padStart(4)} shapes ${ms.toFixed(1)} ms  parse notes ${doc.notes.length}  lint ${notes.length}`);
    for (const n of doc.notes) console.log(`   parse line ${n.line + 1}: ${n.message}`);
    for (const n of notes) console.log(`   ${n.kind.padEnd(12)} ${n.screen}/${n.id}: ${n.message}`);
    blocking += notes.length;
  }
  // every line stands alone: written out with ids and parents, read back, the same tree
  const doc = parseInterface(fixture.lines);
  const again = parseInterface(interfaceLines(doc));
  const bare = (v: unknown): string => JSON.stringify(v, (key, value: unknown) => (key === 'line' ? undefined : value));
  const same = bare(doc.screens) === bare(again.screens);
  console.log(`   round trip through lines that stand alone: ${same ? 'same tree' : 'DIFFERENT'}`);
  if (!same) blocking += 1;
}
console.log(blocking === 0 ? 'clean' : `${blocking} things to look at`);
