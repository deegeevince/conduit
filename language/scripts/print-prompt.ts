// Prints the brain's system prompt for a full-capability painter on the reference screen.
// Usage: pnpm prompt            the prompt an LLM brain is given
//        pnpm prompt relay      the same, plus the appendix a relay agent is given
//        pnpm prompt model      as it is when an image model is configured as well (nobody has one: it costs money)
//        pnpm prompt shipped    for the painter as it stands: what it paints, and no more
//        pnpm prompt v3         for a painter that speaks Series 3: no structures, controls or paint of its own
//        pnpm prompt flat       for a painter that can only set type
//        pnpm prompt count      prints what each costs and fails if the largest is over PROMPT_BUDGET
import { buildRelayAppendix, buildSystemPrompt, estimateTokens, FULL_CAPABILITIES, LEAD_WINDOW, NO_V4_CAPABILITIES, PROMPT_BUDGET } from '../src/index';
import type { Capabilities } from '../src/index';

const V3: Capabilities = { ...FULL_CAPABILITIES, ...NO_V4_CAPABILITIES };
const FLAT: Capabilities = { ...V3, depth: false, layers: ['mid'], camera: [], kinds: ['text'], ambient: [], fx: [], looks: ['paper'], sight: 'report' };
// What the painter really says it can do today (web/src/painter/index.ts): no `code` block, no decks, no uploads, no links yet. The brain must
// not be taught a word the painter cannot paint, so this is the variant that runs, and the check below holds it to that.
const SHIPPED: Capabilities = { ...FULL_CAPABILITIES, structures: FULL_CAPABILITIES.structures.filter((name) => name !== 'code'), decks: false, uploads: false, links: false };
const variants = {
  // What ships: a painter that does everything, the brain on the subscription, look and fix on, no image model.
  full: buildSystemPrompt({ capabilities: FULL_CAPABILITIES, services: { paint: false, sight: 'snapshot', review: true, critic: true, refine: true, uploads: true, art: true } }),
  model: buildSystemPrompt({ capabilities: FULL_CAPABILITIES, services: { paint: true, sight: 'snapshot', review: true, critic: true, refine: true, uploads: true, art: true } }),
  shipped: buildSystemPrompt({ capabilities: SHIPPED, services: { paint: false, sight: 'snapshot', review: true, critic: true, refine: true, uploads: false, art: true } }),
  v3: buildSystemPrompt({ capabilities: V3, services: { paint: false, sight: 'report', review: false } }),
  flat: buildSystemPrompt({ capabilities: FLAT, services: { paint: false, sight: 'report', review: false } }),
};

const which = process.argv[2];
if (which === 'count') {
  for (const [name, text] of Object.entries(variants)) process.stdout.write(`${name.padEnd(8)} ${String(text.length).padStart(6)} characters, about ${estimateTokens(text)} tokens\n`);
  // The budget is for what can run: no image model is configured anywhere (they cost money, and the owner has ruled them out),
  // so `model` is printed for the day one is, and whoever switches one on finds its tokens first.
  const used = Math.max(estimateTokens(variants.full), estimateTokens(variants.v3), estimateTokens(variants.flat), estimateTokens(variants.shipped));
  process.stdout.write(`budget   ${PROMPT_BUDGET.tokens} tokens: ${used <= PROMPT_BUDGET.tokens ? 'within' : 'OVER'} (${Math.round((used / PROMPT_BUDGET.tokens) * 100)}%, the largest of full, shipped, v3 and flat)\n`);
  // Every verb the prompt teaches is one the painter paints: a painter without the capability is never taught the verb.
  const taught: readonly [string, RegExp][] = [['a `code` block', /`code \[id\]/], ['a link (`say href=`)', /href=/], ['a deck', /`deck \|/], ['the user\'s pictures (`pic … from=`)', /from=u1/]];
  const leaks = taught.filter(([, pattern]) => pattern.test(variants.shipped)).map(([name]) => name);
  if (leaks.length > 0) process.stdout.write(`TAUGHT BUT NOT PAINTED: ${leaks.join(', ')}\n`);
  process.exitCode = used <= PROMPT_BUDGET.tokens && leaks.length === 0 ? 0 : 1;
} else {
  process.stdout.write(which === 'flat' ? variants.flat : which === 'shipped' ? variants.shipped : which === 'v3' ? variants.v3 : which === 'model' ? variants.model : variants.full);
  if (which === 'relay') process.stdout.write(`\n${buildRelayAppendix(LEAD_WINDOW)}`);
}
