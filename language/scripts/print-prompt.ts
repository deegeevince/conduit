// Prints the brain's system prompt for a full-capability painter on the reference screen.
// Usage: pnpm prompt            the prompt an LLM brain is given
//        pnpm prompt relay      the same, plus the appendix a relay agent is given
//        pnpm prompt nopaint    as it is when no image model is configured (the default installation)
//        pnpm prompt hero       the diagram variant in which the drawing carries the answer (PROMPT_VARIANT=hero)
//        pnpm prompt flat       for a painter that can only set type
//        pnpm prompt count      prints what each variant costs and fails if the full one is over PROMPT_BUDGET
import { buildRelayAppendix, buildSystemPrompt, estimateTokens, FULL_CAPABILITIES, LEAD_WINDOW, PROMPT_BUDGET } from '../src/index';
import type { Capabilities } from '../src/index';

const FLAT: Capabilities = { ...FULL_CAPABILITIES, depth: false, layers: ['mid'], camera: [], kinds: ['text'], ambient: [], fx: [], looks: ['paper'], sight: 'report' };
const variants = {
  full: buildSystemPrompt({ capabilities: FULL_CAPABILITIES, services: { paint: true, sight: 'snapshot' } }),
  hero: buildSystemPrompt({ capabilities: FULL_CAPABILITIES, services: { paint: true, sight: 'snapshot' }, variant: 'hero' }),
  nopaint: buildSystemPrompt({ capabilities: FULL_CAPABILITIES, services: { paint: false, sight: 'report' } }),
  flat: buildSystemPrompt({ capabilities: FLAT, services: { paint: false, sight: 'report' } }),
};

const which = process.argv[2];
if (which === 'count') {
  for (const [name, text] of Object.entries(variants)) process.stdout.write(`${name.padEnd(8)} ${String(text.length).padStart(6)} characters, about ${estimateTokens(text)} tokens\n`);
  const used = Math.max(estimateTokens(variants.full), estimateTokens(variants.hero));
  process.stdout.write(`budget   ${PROMPT_BUDGET.tokens} tokens: ${used <= PROMPT_BUDGET.tokens ? 'within' : 'OVER'} (${Math.round((used / PROMPT_BUDGET.tokens) * 100)}%, the larger of full and hero)\n`);
  process.exitCode = used <= PROMPT_BUDGET.tokens ? 0 : 1;
} else {
  process.stdout.write(which === 'flat' ? variants.flat : which === 'nopaint' ? variants.nopaint : which === 'hero' ? variants.hero : variants.full);
  if (which === 'relay') process.stdout.write(`\n${buildRelayAppendix(LEAD_WINDOW)}`);
}
