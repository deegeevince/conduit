// pnpm tsx src/tools/lens-bench.ts --url <server> [--throttle 4] [--out <dir>]: what the lens costs a frame (12 ms at the 95th percentile on a phone).
//
// Opens `/?lens=1` on a phone-sized screen (390x844, two pixels to the point, touch) with the CPU slowed, plays a long answer, and drives the lens with real
// fingers and a wheel over DevTools: a pinch out and in, a two-finger pan, a one-finger pan, a ctrl+wheel sweep. The page's lens loop records the milliseconds each
// frame took on the page's thread (`window.__lensTrace`) and the gap between frames. Prints the 50th, 95th and 99th percentile of each and exits 1 over budget.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sleep } from './explore-browser';
import { Conversation, Tab } from './smoke';
import type { Options } from './smoke';

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] !== undefined ? (args[at + 1] as string) : fallback;
};
const BUDGET_MS = 12;

const percentile = (values: readonly number[], q: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] as number) * 100) / 100;
};

async function main(): Promise<void> {
  const url = flag('url', '');
  if (!url.startsWith('http')) {
    process.stderr.write('usage: tsx lens-bench.ts --url http://127.0.0.1:<port> [--throttle 4] [--out <dir>] [--screen 390x844]\n');
    process.exit(2);
  }
  const [width, height] = flag('screen', '390x844').split('x').map(Number) as [number, number];
  const throttle = Number(flag('throttle', '4'));
  const out = flag('out', '/tmp/conduit-lens-bench');
  await mkdir(out, { recursive: true });
  const tab = await Tab.open(width, height, { dpr: 2, touch: true });
  const rows: string[] = [];
  let over = false;
  try {
    const options: Options = { url, screens: [], out, turns: new Set(), timeoutMs: 90_000, parallel: false, demo: false, quiet: true, page: 'lens=1', say: null, chat: 'off' };
    const conv = new Conversation(tab, options, { name: `${width}x${height}`, width, height }, out);
    await tab.send('DOM.enable');
    await conv.start();
    await tab.eval(`Promise.resolve(window.__stage.demo('explorable'))`);
    await conv.rest(true);
    await tab.send('Emulation.setCPUThrottlingRate', { rate: throttle });
    const rect = await tab.eval<{ x: number; y: number }>(`(() => { const r = document.getElementById('stage').getBoundingClientRect(); return { x: r.left, y: r.top }; })()`);
    const cx = rect.x + width / 2;
    const cy = rect.y + 300;
    const points = (d: number, dx = 0, dy = 0) => [
      { x: cx - d / 2 + dx, y: cy + dy, id: 1 },
      { x: cx + d / 2 + dx, y: cy + dy, id: 2 },
    ];
    const measure = async (name: string, drive: () => Promise<void>): Promise<void> => {
      await tab.eval(`window.__lensTrace = { cost: [], gap: [], last: 0 }`);
      await drive();
      await sleep(1600);
      const t = await tab.eval<{ cost: number[]; gap: number[] }>(`(() => { const t = window.__lensTrace; delete window.__lensTrace; return t; })()`);
      const p95 = percentile(t.cost, 0.95);
      if (p95 > BUDGET_MS) over = true;
      rows.push(`${name.padEnd(28)} frames ${String(t.cost.length).padStart(4)}  cost ms p50 ${percentile(t.cost, 0.5)}  p95 ${p95}  p99 ${percentile(t.cost, 0.99)}  max ${percentile(t.cost, 1)}   gap ms p50 ${percentile(t.gap, 0.5)}  p95 ${percentile(t.gap, 0.95)}  ${p95 > BUDGET_MS ? 'OVER' : 'ok'}`);
    };
    await measure('pinch out (1x to 3x)', async () => {
      await tab.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(80) });
      for (let i = 1; i <= 60; i += 1) {
        await tab.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(80 + i * 4) });
        await sleep(16);
      }
      await tab.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    });
    await measure('two-finger pan', async () => {
      await tab.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(200) });
      for (let i = 1; i <= 60; i += 1) {
        await tab.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(200, -i * 3, i * 3) });
        await sleep(16);
      }
      await tab.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    });
    await measure('one-finger pan', async () => {
      await tab.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx, y: cy + 200, id: 1 }] });
      for (let i = 1; i <= 50; i += 1) {
        await tab.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx + i * 2, y: cy + 200 - i * 3, id: 1 }] });
        await sleep(16);
      }
      await tab.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    });
    await measure('ctrl+wheel sweep', async () => {
      for (let i = 0; i < 24; i += 1) {
        await tab.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: i < 12 ? 60 : -60, modifiers: 2 });
        await sleep(16);
      }
    });
    await measure('pinch in (back to 1x)', async () => {
      await tab.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(320) });
      for (let i = 1; i <= 60; i += 1) {
        await tab.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(320 - i * 4) });
        await sleep(16);
      }
      await tab.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    });
    await tab.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  } finally {
    await tab.close();
  }
  const text = `lens frame cost on ${width}x${height} (dpr 2, CPU x${throttle}), budget ${BUDGET_MS} ms at p95\n${rows.join('\n')}\n`;
  process.stdout.write(text);
  await writeFile(join(out, 'lens-bench.txt'), text);
  process.exit(over ? 1 : 0);
}

main().catch((error: unknown) => {
  process.stderr.write(`lens-bench: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(2);
});
