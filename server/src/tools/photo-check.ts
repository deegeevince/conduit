// pnpm photo-check: the free check of labelling a photo. No model, no account.
//
//   pnpm photo-check [--out <dir>]
//
// A generated test pattern stands in for a photo (a wide one, then a tall one), and `say callout at=x,y in=<pic>` lines name spots on it as a
// percent of its width and height. Each is performed through the app's own timeline (pnpm capture --spots) and the end of each leader is measured
// against its spot; every one must end within 1% of the photo's width of it. Nothing here is part of the server.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

const here = import.meta.dirname;

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A PNG of a grid with a line at each tenth, so a leader that ends off its spot is seen to. */
function testPattern(width: number, height: number): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      const grid = x % (width / 10) < 1 || y % (height / 10) < 1;
      row[1 + x * 3] = grid ? 60 : 200 + ((x * 3) % 40);
      row[2 + x * 3] = grid ? 60 : 210;
      row[3 + x * 3] = grid ? 120 : 200 + ((y * 3) % 40);
    }
    rows.push(row);
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

const SPOTS: readonly (readonly [number, number, string])[] = [
  [8, 10, 'top left'],
  [92, 12, 'top right'],
  [50, 50, 'middle'],
  [20, 78, 'low left'],
  [81, 90, 'bottom right'],
  [50, 8, 'top middle'],
  [3, 50, 'left edge'],
  [97, 55, 'right edge'],
];

function log(session: string, shape: readonly [number, number]): string {
  const lines = ['scene layout=figure canvas=wide', 'pic p1 from=u1', ...SPOTS.map(([x, y, words], index) => `say c${index + 1} callout at=${x},${y} in=p1 | ${words}`)];
  const records = [
    { type: 'turn', at: 0, turn: 't1', input: { kind: 'prompt', text: `label the ${shape[0]} by ${shape[1]} test pattern`, images: ['u1'] }, brain: 'replay' },
    ...lines.map((text, index) => ({ type: 'line', at: 1000 + index * 400, turn: 't1', seq: index + 1, text, start: index * 0.4, issues: [], pass: 1 })),
    { type: 'end', at: 20000, turn: 't1', reason: 'done', message: null, lines: lines.length },
  ];
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n';
}

const argv = process.argv.slice(2);
const out = argv.includes('--out') ? resolve(argv[argv.indexOf('--out') + 1] ?? '.') : null;
const work = mkdtempSync(join(tmpdir(), 'conduit-photo-check-'));
let failed = false;
try {
  for (const shape of [[900, 600], [480, 640]] as const) {
    const data = join(work, `data-${shape[0]}`);
    mkdirSync(join(data, 'uploads', '20260101T000000Z-photo'), { recursive: true });
    writeFileSync(join(data, 'uploads', '20260101T000000Z-photo', 'u1.png'), testPattern(shape[0], shape[1]));
    const file = join(work, `photo-${shape[0]}x${shape[1]}.jsonl`);
    writeFileSync(file, log('photo', shape));
    const run = spawnSync('pnpm', ['-s', 'capture', file, 't1', '--no-video', '--spots', '--data', data, '--out', out ?? work], { cwd: resolve(here, '..', '..', '..'), encoding: 'utf8', env: process.env });
    const lines = `${run.stdout}${run.stderr}`.split('\n').filter((line) => line.includes('spot ') || line.includes('capture:'));
    process.stdout.write(`${shape[0]}x${shape[1]} photo\n${lines.join('\n')}\n`);
    if (run.status !== 0 || lines.filter((line) => line.includes('spot ')).length !== SPOTS.length) failed = true;
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
process.stdout.write(failed ? 'photo-check: FAILED (a leader ends more than 1% of the photo off its spot, or has none)\n' : 'photo-check: every leader ends within 1% of its spot\n');
process.exitCode = failed ? 1 : 0;
