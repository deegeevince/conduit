// `pnpm demo-checks`: the painter-side checks of the demos (web/src/painter/demo-checks.ts: what each drawing does on its canvas, fb-002), run under `tsx` with no browser. This file reads the
// demos' sources and hands them over; the web module is imported by a path computed here, so the language package's own type-check does not take the painter in.
import { allDemos } from './demo-lib';

const module = (await import(new URL('../../web/src/painter/demo-checks.ts', import.meta.url).href)) as { demoChecks: (demos: readonly { name: string; source: string }[], out: (text: string) => void) => boolean };
process.exitCode = module.demoChecks(allDemos(), (text) => void process.stdout.write(text)) ? 0 : 1;
