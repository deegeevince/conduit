// "Report a problem": what the page saved when the owner pressed the button in the [+] menu. No model is called.
//
//   POST /api/reports   JSON `{ session, turn, note, context, events, images: { stage?, ink?, screen? } }`, the pictures as PNG data URLs.
//                       Kept as `<DATA_DIR>/reports/<UTC time>-<session>/` with `report.json` (note, context, events) and `stage.png`, `ink.png`,
//                       `screen.png`. 201 `{ id }`; 413 over `REPORT_LIMITS.bytes`; 400 for what is not a report. It sits behind the same owner
//                       identity check as every `/api` route. The folder never leaves the data folder: `pnpm reports` reads it.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { errors } from '../errors';
import type { HttpDeps } from './deps';
import { jsonBody } from './json';

export const REPORT_LIMITS = {
  /** the whole request: three screen-sized PNGs and the events */
  bytes: 12 * 1024 * 1024,
  noteChars: 4000,
  events: 1000,
} as const;

const PICTURES = ['stage', 'ink', 'screen'] as const;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

const object = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

export function registerReportRoutes(app: Hono, deps: HttpDeps): void {
  app.post('/api/reports', async (c) => {
    const body = object(await jsonBody(c));
    const session = typeof body['session'] === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(body['session']) ? body['session'] : 'none';
    const turn = typeof body['turn'] === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(body['turn']) ? body['turn'] : null;
    const note = typeof body['note'] === 'string' ? body['note'].slice(0, REPORT_LIMITS.noteChars) : '';
    if (!Array.isArray(body['events'])) throw errors.badRequest('a report lists its events');
    const events = (body['events'] as unknown[]).slice(-REPORT_LIMITS.events);
    const images = object(body['images']);
    const pictures: { name: string; bytes: Buffer }[] = [];
    for (const name of PICTURES) {
      const url = images[name];
      if (url === undefined) continue;
      const match = typeof url === 'string' ? /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(url) : null;
      const bytes = match === null ? null : Buffer.from(match[1] ?? '', 'base64');
      if (bytes === null || bytes.length < 8 || !bytes.subarray(0, 4).equals(PNG)) throw errors.badRequest(`${name} is not a PNG data URL`);
      pictures.push({ name: `${name}.png`, bytes });
    }
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const base = `${stamp}-${session}`;
    await mkdir(deps.env.data.reports, { recursive: true, mode: 0o700 });
    let id = base;
    for (let n = 2; ; n += 1) {
      try {
        await mkdir(join(deps.env.data.reports, id), { mode: 0o700 });
        break;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'EEXIST' || n > 50) throw cause;
        id = `${base}-${n}`;
      }
    }
    const dir = join(deps.env.data.reports, id);
    await Promise.all(pictures.map((picture) => writeFile(join(dir, picture.name), picture.bytes, { mode: 0o600 })));
    const report = { id, received: new Date().toISOString(), session, turn, note, context: object(body['context']), events, pictures: pictures.map((picture) => picture.name) };
    await writeFile(join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    deps.log.info('report.saved', { id, session, events: events.length, pictures: pictures.length });
    return c.json({ id }, 201);
  });
}
