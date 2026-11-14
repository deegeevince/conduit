// A live app's place on the stage. The app itself runs in a sandboxed frame the app shell lays over the stage (web/src/app/live-app.ts);
// this is what the renderer draws in the same room: a frame, the title, how many lines of the document have arrived (the brain writes it
// line by line, so the room fills with a skeleton of what is being written), and the word `live app` once it is whole. It is what a snapshot,
// an export and the critic's picture show until the app has a picture of itself, and what is under the frame while it loads.
//
// Pure, like every engine: the same input gives the same layout, in a browser or under `tsx`.

import type { BlockPart, StructureInput, StructureLayout } from '../../contracts/blocks';
import { box, closedLine, rectOutline } from './geom';
import { Env } from './kit';

/** The most lines of skeleton drawn: a document of three hundred lines is not three hundred bars. */
const SKELETON_LINES = 22;

export function layoutApp(input: StructureInput): StructureLayout {
  const structure = input.structure;
  const figure = structure.figure;
  const key = structure.key;
  const rows = figure?.kind === 'structure' ? figure.rows : [];
  const whole = figure?.kind === 'structure' && (figure.sealed ?? null) !== null;
  const env = new Env(input, 1, 1, input.look.stroke);
  const room = input.room;
  const body = env.body;
  const small = env.small();
  const parts: BlockPart[] = [];
  const pad = env.up(body * 0.8, 'x');

  const title = structure.text.trim();
  const status = rows.length === 0 ? 'live app' : whole || structure.carried ? `live app, ${rows.length} lines` : `writing, ${rows.length} lines`;
  const statusM = input.measure(status, small, room.width);
  const titleSpec = { ...env.spec, size: 'm' as const };
  const titleM = title === '' ? null : input.measure(title, titleSpec, Math.max(body * 4, room.width - statusM.width - pad * 3));
  const headH = env.up(Math.max(titleM?.height ?? 0, statusM.height) + body * 0.8, 'y');

  if (titleM !== null) parts.push({ kind: 'text', owner: key, part: 'title', text: title, emphasis: [], box: box(room.x + pad, room.y + body * 0.4, titleM.width, titleM.height), spec: titleSpec, align: 'left', role: 'title', plate: false });
  parts.push({ kind: 'text', owner: key, part: 'meta', text: status, emphasis: [], box: box(room.x + room.width - pad - statusM.width, room.y + body * 0.4, statusM.width, statusM.height), spec: small, align: 'right', role: 'value', plate: false });
  parts.push({ kind: 'shape', owner: key, part: 'rule', outline: [{ closed: false, points: [{ x: room.x, y: room.y + headH }, { x: room.x + room.width, y: room.y + headH }] }], role: 'grid' });

  // the document as it arrives: one bar a line, as long as the line, as far in as its indentation
  const top = room.y + headH + body * 0.6;
  const height = Math.max(0, room.height - headH - body * 1.2);
  const lineH = Math.max(3, Math.min(body * 0.9, height / Math.max(8, Math.min(SKELETON_LINES, rows.length || 8))));
  const fit = Math.max(1, Math.floor(height / (lineH * 1.7)));
  const first = Math.max(0, rows.length - Math.min(SKELETON_LINES, fit));
  const across = Math.max(0, room.width - pad * 2);
  for (let index = first; index < rows.length; index += 1) {
    const line = rows[index]?.cells[0] ?? '';
    const text = line.trimStart();
    if (text === '') continue;
    const indent = Math.min(8, (line.length - text.length) / 2);
    const x = room.x + pad + Math.min(across * 0.3, indent * body * 0.7);
    const w = Math.max(body * 0.8, Math.min(across - (x - room.x - pad), (Math.min(text.length, 70) / 70) * across * 0.9));
    const y = top + (index - first) * lineH * 1.7;
    if (y + lineH > room.y + room.height - body * 0.4) break;
    parts.push({ kind: 'shape', owner: key, part: `l:${index}`, outline: [closedLine(rectOutline(box(x, y, w, lineH)).points)], role: 'fill', row: index });
  }
  parts.push({ kind: 'shape', owner: key, part: 'frame', outline: [closedLine(rectOutline(room).points)], role: 'frame' });

  const tooSmall = room.width < body * 8 || room.height < body * 6;
  return { boxes: new Map([[key, room]]), parts, routes: new Map(), notes: tooSmall ? [{ key, note: 'crowded' }] : [], shrink: 1 };
}
