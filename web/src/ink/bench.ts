// The ink bench: a worksheet over an uploaded photo, with answer boxes and a scratch area, talking to a real server. It is how the worksheet mode is
// driven in a real browser (`web/bench-ink.html`); it is not part of the app. `window.__ink` is what a test driver reads.

import { FULL_CAPABILITIES, DEFAULT_LOOK, REFERENCE_SCREEN, API } from '@conduit/language';
import type { InkMarks, InkRegionDef, StageEvent } from '@conduit/language';
import { mountWorksheet } from './worksheet';
import type { Worksheet } from './worksheet';

const params = new URLSearchParams(location.search);
const sheetHost = document.getElementById('sheet')!;
const logEl = document.getElementById('log')!;
const input = document.getElementById('photo') as HTMLInputElement;
const log = (text: string): void => {
  logEl.textContent += `${text}\n`;
};

interface Bench {
  session: string | null;
  sheet: Worksheet | null;
  lines: string[];
  marks: InkMarks | null;
  ended: boolean;
  region: Array<{ stroke: string; region: string | null }>;
}
const bench: Bench = { session: null, sheet: null, lines: [], marks: null, ended: false, region: [] };
(window as unknown as { __ink: unknown }).__ink = bench;

async function session(): Promise<string> {
  if (bench.session !== null) return bench.session;
  const response = await fetch(API.sessions, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ screen: REFERENCE_SCREEN, capabilities: { ...FULL_CAPABILITIES, uploads: true }, look: DEFAULT_LOOK }) });
  const body = (await response.json()) as { session?: string; id?: string };
  const id = body.session ?? body.id;
  if (id === undefined) throw new Error('no session');
  bench.session = id;
  const stream = new EventSource(API.stream(id));
  for (const name of ['line', 'end', 'turn']) {
    stream.addEventListener(name, (e) => {
      const event = { type: name, ...JSON.parse((e as MessageEvent<string>).data) } as StageEvent;
      if (event.type === 'line') bench.lines.push(event.text);
      if (event.type === 'end') bench.ended = true;
    });
  }
  return id;
}

async function upload(blob: Blob): Promise<{ id: string; width: number; height: number }> {
  const id = await session();
  const response = await fetch(API.uploads(id), { method: 'POST', headers: { 'content-type': blob.type || 'application/octet-stream' }, body: blob });
  if (!response.ok) throw new Error(`upload refused (${response.status})`);
  return (await response.json()) as { id: string; width: number; height: number };
}

async function turn(words: string, marks: InkMarks): Promise<void> {
  const id = await session();
  bench.marks = marks;
  bench.ended = false;
  bench.lines = [];
  const response = await fetch(API.turns(id), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: { kind: 'prompt', text: words || 'Please look at my working.', marks } }) });
  log(`turn ${response.status}`);
  if (!response.ok) throw new Error(`the turn was refused: ${(await response.text()).slice(0, 300)}`);
}

async function open(file: Blob): Promise<void> {
  const kept = await upload(file);
  const space = { w: kept.width, h: kept.height };
  const q = (params.get('q') ?? '1') === '1';
  // the boxes are in the photo's own pixels (this fixture: 1200 x 1600)
  const k = space.w / 1200;
  const box = (x: number, y: number, w: number, h: number): { x: number; y: number; w: number; h: number } => ({ x: x * k, y: y * k, w: w * k, h: h * k });
  const regions: InkRegionDef[] = q
    ? [
        { id: 'q1-answer', kind: 'answer', label: 'Answer', box: box(395, 100, 175, 62) },
        { id: 'scratch', kind: 'scratch', label: 'Working out', box: box(640, 700, 500, 330) },
      ]
    : [];
  const sheet = mountWorksheet(sheetHost, {
    space,
    background: { src: API.upload(await session(), kept.id), id: kept.id, alt: 'The worksheet' },
    regions,
    on: { node: 'q1', ask: 'a1', label: 'question 1 of the worksheet: "50 less than 61 ="' },
    context: { x: 95 * k, y: 90 * k, w: 500 * k, h: 90 * k },
    bar: { sendLabel: 'Check my working', wordsPlaceholder: 'Say something (optional)' },
    port: { upload: async (png) => (await upload(png)).id, turn },
    onStroke: ({ stroke, region }) => {
      bench.region.push({ stroke: stroke.id, region });
      log(`stroke ${stroke.id} landed in ${region ?? 'no box'}`);
    },
  });
  bench.sheet = sheet;
  log(`sheet ${space.w}x${space.h} photo ${kept.id}`);
}

input.addEventListener('change', () => {
  const file = input.files?.[0];
  if (file !== undefined) void open(file).catch((cause: unknown) => log(String(cause)));
});
