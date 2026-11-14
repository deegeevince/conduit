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
import { NAMED_COLOURS, contrast, readingPairs, themed } from './theme';

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
    // what the brain wrote cold is shown, and is not this check's to fail: sight's notes on it are the point
    if (fixture.by === 'hand') blocking += notes.length;
  }
  // every line stands alone: written out with ids and parents, read back, the same tree
  const doc = parseInterface(fixture.lines);
  const again = parseInterface(interfaceLines(doc));
  const bare = (v: unknown): string => JSON.stringify(v, (key, value: unknown) => (key === 'line' ? undefined : value));
  const same = bare(doc.screens) === bare(again.screens);
  console.log(`   round trip through lines that stand alone: ${same ? 'same tree' : 'DIFFERENT'}`);
  if (!same) blocking += 1;
}
// every colour word, in both themes, on the finished look: every pair a screen reads must be 4.5 or better (and a bare hex, and a word the kit does not know, still gives readable tokens)
let worst = { ratio: 99, what: '' };
let pairs = 0;
for (const accent of [...NAMED_COLOURS, '#ff00ff', '#00ff00', '#fff', '#123456', 'not-a-colour']) {
  for (const theme of ['dark', 'light'] as const) {
    const t = themed(STUDIO_TOKENS, { theme, accent });
    for (const pair of readingPairs(t.colour)) {
      pairs += 1;
      const r = contrast(pair.fg, pair.bg);
      if (r < worst.ratio) worst = { ratio: r, what: `${accent} ${theme}: ${pair.name}` };
      if (r < 4.5) {
        blocking += 1;
        console.log(`   contrast ${r.toFixed(2)} < 4.5: ${accent} ${theme}: ${pair.name} (${pair.fg} on ${pair.bg})`);
      }
    }
  }
}
console.log(`theme contrast: ${pairs} pairs over ${NAMED_COLOURS.length + 5} accents x 2 themes, least ${worst.ratio.toFixed(2)} (${worst.what})`);
console.log(blocking === 0 ? 'clean' : `${blocking} things to look at`);
