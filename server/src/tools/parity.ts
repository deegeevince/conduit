// pnpm parity: the engine measures the same on the page and on the server, proved in a real headless Chrome.
//
//   pnpm parity [--url http://127.0.0.1:<port>] [--port 4932] [--screens 390x844,1280x720,1920x833] [--looks all] [--only <case,case>] [--quiet]
//
// Without --url it starts the server itself (production mode, the built web app, ENGINE_DEV=1, a throwaway data folder). With --url the
// server there must run with ENGINE_DEV=1 and have the built web app. The page (web/bench-parity.html) runs `measureStage` on each case,
// posts the same inputs to POST /api/engine/measure and compares: every box within 0.01 unit, the digest equal. It also probes the 13 font
// files against the advance tables (within 0.5%), plants one wrong advance and expects it to be found, and times `measureStage`.
// Exits non-zero when anything fails.

import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEMOS, LOOK_IDS } from '@conduit/language';
import type { StageBase } from '@conduit/language';
import { spawnTracked } from '../brains/claude-cli/process';
import type { SessionRecord } from '../domain/session-log';
import { Cdp, CHROME_CANDIDATES, stop, waitFor } from './explore-browser';
import { GOLDEN_TURNS } from './golden-turns';

const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
const SCREENS = ['390x844', '1280x720', '1920x833'];
const TIMING_RUNS = 100;
const TIMING_P95_MS = 30;
const PROBE_TOLERANCE = 0.005;

interface EngineCase {
  readonly id: string;
  readonly base: StageBase | null;
  readonly opened: string;
  readonly lines: readonly { readonly seq: number; readonly text: string; readonly floor: number }[];
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The cases

type Of<T extends SessionRecord['type']> = Extract<SessionRecord, { type: T }>;

async function goldenCases(): Promise<EngineCase[]> {
  const cases: EngineCase[] = [];
  const logs = new Map<string, SessionRecord[]>();
  for (const golden of GOLDEN_TURNS) {
    if (!logs.has(golden.log)) {
      const records: SessionRecord[] = [];
      for (const raw of (await readFile(join(repoRoot, 'server', 'golden', 'logs', golden.log), 'utf8')).split('\n')) {
        try {
          const record = JSON.parse(raw) as SessionRecord;
          if (typeof record.type === 'string') records.push(record);
        } catch {
          // a blank line or one cut short
        }
      }
      logs.set(golden.log, records);
    }
    const records = logs.get(golden.log) ?? [];
    const opens = records.filter((record): record is Of<'turn'> => record.type === 'turn');
    const index = opens.findIndex((open) => open.turn === golden.turn);
    const open = opens[index];
    if (open === undefined) throw new Error(`golden turn ${golden.id}: no ${golden.turn} in ${golden.log}`);
    // the stage the nearest earlier turn that reported left behind
    let base: StageBase | null = null;
    for (let i = index - 1; i >= 0 && base === null; i -= 1) {
      const report = records.find((record): record is Of<'report'> => record.type === 'report' && record.turn === opens[i]?.turn);
      if (report !== undefined) base = report.report.stage;
    }
    const mine = records.filter((record) => 'turn' in record && record.turn === open.turn);
    const lines = mine.filter((record): record is Of<'line'> => record.type === 'line' && (record.pass ?? 1) <= 1);
    const started = mine.find((record): record is Of<'started'> => record.type === 'started');
    const shownAt = started?.at ?? lines[0]?.at ?? open.at;
    cases.push({
      id: `golden:${golden.id}`,
      base,
      opened: open.input.kind,
      lines: lines.map((line) => ({ seq: line.seq, text: line.text, floor: Math.max(0, Math.min((line.at - shownAt) / 1000, line.start)) })),
    });
  }
  return cases;
}

async function demoCases(): Promise<EngineCase[]> {
  const dir = join(repoRoot, 'language', 'demos');
  const names = new Set(await readdir(dir));
  const cases: EngineCase[] = [];
  for (const demo of DEMOS) {
    const file = `${demo.name}.series`;
    if (!names.has(file)) continue;
    const text = await readFile(join(dir, file), 'utf8');
    cases.push({ id: `demo:${demo.name}`, base: null, opened: 'demo', lines: text.split('\n').map((line, i) => ({ seq: i + 1, text: line, floor: 0 })) });
  }
  return cases;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The browser

class Page {
  private constructor(
    private readonly browser: Cdp,
    private readonly sessionId: string,
    private readonly child: ChildProcess,
    private readonly profile: string,
  ) {}

  static async open(): Promise<Page> {
    const chrome = CHROME_CANDIDATES.find((path) => existsSync(path));
    if (chrome === undefined) throw new Error('no Chrome found: set CHROME_BIN to a Chrome or Chromium executable');
    const profile = await mkdtemp(join(tmpdir(), 'conduit-parity-'));
    const child = spawnTracked(chrome, ['--headless=new', '--use-angle=metal', '--ignore-gpu-blocklist', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1280,720', 'about:blank'], undefined, { quiet: true });
    try {
      const endpoint = await waitFor('Chrome', 20_000, async () => {
        const [port, path] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n');
        return port !== undefined && path !== undefined ? `ws://127.0.0.1:${port}${path}` : null;
      });
      const browser = await Cdp.open(endpoint);
      const { targetId } = await browser.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await browser.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
      await browser.send('Page.enable', {}, sessionId);
      return new Page(browser, sessionId, child, profile);
    } catch (error) {
      await stop(child);
      await rm(profile, { recursive: true, force: true });
      throw error;
    }
  }

  async go(url: string): Promise<void> {
    await this.browser.send('Page.navigate', { url }, this.sessionId);
    await waitFor('the parity page', 60_000, async () => ((await this.eval<boolean>('Boolean(window.__parity && window.__parity.ready)').catch(() => false)) ? true : null));
  }

  async eval<T>(expression: string): Promise<T> {
    const out = await this.browser.send<{ result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, this.sessionId);
    if (out.exceptionDetails !== undefined) throw new Error(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text);
    return out.result.value as T;
  }

  call<T>(fn: string, ...args: unknown[]): Promise<T> {
    return this.eval<T>(`window.__parity.${fn}(${args.map((arg) => JSON.stringify(arg)).join(',')})`);
  }

  async close(): Promise<void> {
    this.browser.close();
    await stop(this.child);
    await rm(this.profile, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The run

interface Compared {
  readonly id: string;
  readonly look: string;
  readonly screen: string;
  readonly boxes: number;
  readonly serverBoxes: number;
  readonly maxDelta: number;
  readonly withinTolerance: boolean;
  readonly digestEqual: boolean;
  readonly sightEqual: boolean;
  readonly contentEqual: boolean;
  readonly faults: readonly string[];
  readonly versionEqual: boolean;
  readonly pageMs: number;
  readonly serverMs: number;
}

interface ProbeRow {
  readonly font: string;
  readonly face: string;
  readonly weight: string;
  readonly loaded: number;
  readonly table: number;
  readonly error: number;
}

function option(name: string): string | null {
  const argv = process.argv.slice(2);
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? null : (argv[at + 1] ?? null);
}

const percentile = (values: readonly number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0;
};

async function main(): Promise<number> {
  const quiet = process.argv.includes('--quiet');
  const say = (text: string): void => void process.stdout.write(`${text}\n`);
  const screens = (option('screens') ?? SCREENS.join(',')).split(',').map((name) => {
    const [width, height] = name.split('x').map(Number);
    if (width === undefined || height === undefined || !(width > 0) || !(height > 0)) throw new Error(`--screens: ${name} is not WxH`);
    return { name, width, height };
  });
  const looks = option('looks') === null || option('looks') === 'all' ? [...LOOK_IDS] : (option('looks') ?? '').split(',');
  const only = option('only')?.split(',') ?? null;
  const cases = [...(await goldenCases()), ...(await demoCases())].filter((item) => only === null || only.some((name) => item.id.includes(name)));

  let url = option('url');
  let server: ChildProcess | null = null;
  let data: string | null = null;
  const page = await (async () => {
    if (url === null) {
      const port = Number(option('port') ?? 4932);
      if (!(port >= 4930 && port <= 4939)) throw new Error('--port must be in 4930-4939');
      if (!existsSync(join(repoRoot, 'web', 'dist', 'bench-parity.html'))) throw new Error('web/dist/bench-parity.html is missing: run "pnpm build" first');
      data = await mkdtemp(join(tmpdir(), 'conduit-parity-data-'));
      server = spawnTracked('pnpm', ['--filter', '@conduit/server', 'exec', 'tsx', 'src/main.ts'], undefined, {
        cwd: repoRoot,
        env: { NODE_ENV: 'production', PORT: String(port), DATA_DIR: data, BRAIN: 'replay', IMAGE_MODEL: 'none', ENGINE_DEV: '1' },
        quiet: true,
      });
      url = `http://127.0.0.1:${port}`;
      await waitFor('the server', 60_000, async () => ((await fetch(`${url}/api/health`)).ok ? true : null));
    }
    return Page.open();
  })();

  let failed = 0;
  try {
    await page.go(`${url}/bench-parity.html`);
    await page.call('setCases', cases);
    say(`engine ${await page.eval<string>('window.__parity.version')}; ${cases.length} cases x ${looks.length} looks x ${screens.length} screens`);

    // Boxes
    const table = new Map<string, { runs: number; boxes: number; within: number; digests: number; sights: number; contents: number; delta: number; faults: number; versions: number }>();
    const trouble: string[] = [];
    for (const item of cases) {
      for (const screen of screens) {
        const row = { runs: 0, boxes: 0, within: 0, digests: 0, sights: 0, contents: 0, delta: 0, faults: 0, versions: 0 };
        for (const look of looks) {
          const result = await page.call<Compared>('run', item.id, { width: screen.width, height: screen.height }, look);
          row.runs += 1;
          row.boxes += result.boxes;
          if (result.withinTolerance) row.within += 1;
          if (result.digestEqual) row.digests += 1;
          if (result.sightEqual) row.sights += 1;
          if (result.contentEqual) row.contents += 1;
          if (result.versionEqual) row.versions += 1;
          row.delta = Math.max(row.delta, result.maxDelta);
          row.faults += result.faults.length;
          if (!result.withinTolerance || !result.digestEqual || result.faults.length > 0) trouble.push(`${item.id} ${screen.name} ${look}: boxes ${result.boxes}/${result.serverBoxes}, max delta ${result.maxDelta}, digest ${result.digestEqual ? 'equal' : 'DIFFERENT'}${result.faults.length > 0 ? `, faults: ${result.faults.join(' | ')}` : ''}`);
        }
        table.set(`${item.id}|${screen.name}`, row);
        if (!quiet) say(`  ${item.id.padEnd(28)} ${screen.name.padEnd(9)} looks ${row.within}/${row.runs} within 0.01, digests ${row.digests}/${row.runs}, sight ${row.sights}/${row.runs}, content ${row.contents}/${row.runs}, max delta ${row.delta.toExponential(1)}, ${row.boxes} boxes${row.faults > 0 ? `, ${row.faults} faults` : ''}`);
      }
    }
    const rows = [...table.values()];
    const total = (pick: (row: (typeof rows)[number]) => number): number => rows.reduce((sum, row) => sum + pick(row), 0);
    const runs = total((row) => row.runs);
    say(`boxes: ${total((row) => row.within)}/${runs} within 0.01; digests ${total((row) => row.digests)}/${runs} equal; sight ${total((row) => row.sights)}/${runs}; content ${total((row) => row.contents)}/${runs}; version ${total((row) => row.versions)}/${runs}; faults ${total((row) => row.faults)}`);
    if (total((row) => row.within) !== runs || total((row) => row.digests) !== runs || total((row) => row.faults) > 0) {
      failed += 1;
      for (const line of trouble.slice(0, 30)) say(`  FAIL ${line}`);
    }

    // Glyph probe
    const probe = await page.call<ProbeRow[]>('probe');
    const worst = probe.reduce((most, row) => Math.max(most, row.error), 0);
    const bad = probe.filter((row) => row.error > PROBE_TOLERANCE);
    say(`glyph probe: ${probe.length - bad.length}/${probe.length} font files within ${PROBE_TOLERANCE * 100}%; worst ${(worst * 100).toFixed(3)}%`);
    if (!quiet || bad.length > 0) for (const row of probe) say(`  ${row.error > PROBE_TOLERANCE ? 'FAIL' : 'ok  '} ${row.font.padEnd(20)} ${row.face}/${row.weight}  browser ${row.loaded.toFixed(3)} em, table ${row.table.toFixed(3)} em, ${(row.error * 100).toFixed(3)}%`);
    if (probe.length !== 13 || bad.length > 0) failed += 1;

    // A planted fault
    let plantedFound = false;
    let plantedLine = '';
    for (const look of looks) {
      const result = await page.call<{ found: boolean; differing: number; of: number }>('planted', cases.map((item) => item.id), { width: 390, height: 844 }, look);
      if (result.found) {
        plantedFound = true;
        plantedLine = `found in look ${look} (${result.differing}/${result.of} cases differ)`;
        break;
      }
    }
    say(`planted fault (one advance, one side): ${plantedFound ? plantedLine : 'NOT FOUND'}`);
    if (!plantedFound) failed += 1;

    // Timing: golden's largest turn
    const largest = cases.filter((item) => item.id.startsWith('golden:')).sort((a, b) => b.lines.length - a.lines.length)[0];
    if (largest !== undefined) {
      const times = await page.call<number[]>('timing', largest.id, { width: 1280, height: 720 }, 'paper', TIMING_RUNS);
      const p95 = percentile(times, 0.95);
      say(`timing: measureStage on ${largest.id} (${largest.lines.length} lines), ${times.length} runs after a warm-up: median ${percentile(times, 0.5).toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, max ${Math.max(...times).toFixed(1)} ms (limit ${TIMING_P95_MS} ms) ${p95 < TIMING_P95_MS ? 'ok' : 'FAIL'}`);
      if (p95 >= TIMING_P95_MS) failed += 1;
    }
  } finally {
    await page.close();
    if (server !== null) await stop(server);
    if (data !== null) await rm(data, { recursive: true, force: true });
  }
  say(failed === 0 ? 'parity: PASS' : `parity: FAIL (${failed} section${failed === 1 ? '' : 's'})`);
  return failed === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`parity: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  },
);
