// The page's own painter laying out written methods, with no browser and no model: the real painter on a renderer that records the last frame it was handed.
// Prints, per screen and per sum, the words and shapes of the block as painted (stage units), for `server/src/tools/math-check.ts` to judge.
//
//   tsx --import ./src/bench/node-register.mjs src/bench/math-bench.ts        (run from web/; `pnpm check --only maths` does it)

import { parseLine } from '@conduit/language';
import type { Line } from '@conduit/language';

interface Screen {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
}

const SCREENS: readonly Screen[] = [
  { name: '820x971', width: 820, height: 971, dpr: 2 },
  { name: '390x844', width: 390, height: 844, dpr: 3 },
  { name: '1280x720', width: 1280, height: 720, dpr: 1 },
];

/** every sum is played as a scene of its own; the same lines the demo writes */
const SUMS: readonly (readonly string[])[] = [
  ['math m1 column | 12+12+12+12+12+12'],
  ['math m2 column | 503 - 278'],
  ['math m3 times | 47 × 6'],
  ['math m4 split | 347'],
  ['math m5 bond | 10 = 4 + ?'],
  ['math m6 column | 3.4 + 12.75'],
  ['math m7 column worked | 346 + 285'],
  ['math m8 column | 12+12', 'fill m8 | 24'],
  ['math m9 bar | 3/4'],
  ['math m11 column | 12+12+12+12+12+12', 'type m11.ans-ones | 2', 'type m11.ans-tens | 7'],
  ['math m10 groups | 12 ÷ 3'],
];

async function play(screen: Screen, lines: readonly string[]): Promise<unknown> {
  const g = globalThis as unknown as Record<string, unknown>;
  let frame: ((now: number) => void) | null = null;
  g.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
  g.requestAnimationFrame = (callback: (now: number) => void) => {
    frame = callback;
    return 1;
  };
  g.cancelAnimationFrame = () => {
    frame = null;
  };
  const { createPainter } = await import('../painter');
  let last: { elements: unknown[]; figures: unknown[] } | null = null;
  const renderer = new Proxy(
    {},
    {
      get: (_target, key) =>
        key === 'isDrawable'
          ? () => true
          : key === 'capabilities'
            ? { depth: true, post: false, looks: [], kinds: ['text', 'shape', 'sprite', 'group', 'copy', 'picture', 'field'], fx: [], ambient: [], capture: false, media: [], textures: [], brushes: [], clip: true }
            : key === 'preload'
              ? () => Promise.resolve()
              : key === 'pick'
                ? () => null
                : key === 'rasterise'
                  ? () => Promise.resolve(null)
                  : key === 'render'
                    ? (f: { elements: unknown[]; figures: unknown[] }) => {
                        last = f;
                      }
                    : () => undefined,
    },
  );
  const painter = createPainter({ renderer: renderer as never, viewport: { width: screen.width, height: screen.height, dpr: screen.dpr }, lockLook: null, pointer: 'coarse', reducedMotion: false });
  let now = 1000;
  const tick = async (frames: number): Promise<void> => {
    for (let i = 0; i < frames; i += 1) {
      now += 100;
      (frame as ((now: number) => void) | null)?.(now);
      await Promise.resolve();
    }
  };
  painter.openTurn('t1', { kind: 'prompt', text: 'go' });
  let seq = 0;
  const typed: { key: string; part: string; text: string }[] = [];
  for (const text of ['scene layout=stack', ...lines]) {
    // `type m1.part | digits`: what a keyboard writes in a cell, once the page has come to rest (not a line of the language)
    const typing = /^type (\S+)\.(\S+) \| (\d+)$/.exec(text);
    if (typing !== null) {
      typed.push({ key: typing[1] as string, part: typing[2] as string, text: typing[3] as string });
      continue;
    }
    const parsed = parseLine(text);
    if (parsed.kind !== 'line') continue;
    seq += 1;
    painter.ingest('t1', seq, parsed.line as Line);
    await tick(2);
  }
  painter.notePass('t1', 1, 'drafted');
  await tick(2);
  painter.closeTurn('t1', 'done');
  await tick(80);
  for (const write of typed) {
    const block = painter.mathViews().find((view) => view.id === write.key);
    if (block !== undefined) painter.mathWrite(block.key, write.part, write.text, 'key');
    await tick(4);
  }
  const f = last as { elements: { key: string; x: number; y: number; width: number; height: number; runs: { text: string }[] }[]; figures: { key: string; outline: { points: { x: number; y: number }[] }[] }[] } | null;
  painter.dispose?.();
  return {
    elements: (f?.elements ?? []).map((e) => ({ key: e.key, x: e.x, y: e.y, width: e.width, height: e.height, text: e.runs.map((r) => r.text).join('') })),
    figures: (f?.figures ?? []).map((s) => {
      const pts = s.outline.flatMap((line) => line.points);
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      return { key: s.key, x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
    }),
  };
}

async function main(): Promise<void> {
  const out: unknown[] = [];
  for (const screen of SCREENS) for (const lines of SUMS) out.push({ screen, lines, painted: await play(screen, lines) });
  console.log(JSON.stringify(out));
}

void main();
