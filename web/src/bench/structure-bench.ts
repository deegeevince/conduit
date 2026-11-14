// Run under tsx (see node-register.mjs): plays a small flow through the timeline with a stand-in engine and checks the mechanics the
// painter owns: epochs from arrivals, entrances, easing between layouts, parts keyed stably. The real engines are package D's.
import { EMPTY_STAGE, parseLine, TurnScore } from '@conduit/language';
import type { Line } from '@conduit/language';
import type { BlockPart, StructureEngine } from '../contracts/blocks';
import { LOOKS } from '../looks';
import { buildTimeline } from '../painter/timeline';

const engine: StructureEngine = ({ nodes, links, room, measure, look }) => {
  const boxes = new Map<string, { x: number; y: number; width: number; height: number }>();
  const parts: BlockPart[] = [];
  const w = Math.min(120, room.width / Math.max(1, nodes.length) - 20);
  nodes.forEach((node, i) => {
    const text = measure(node.text, { size: 'm', weight: 'normal', face: null, letterCase: 'asis', shrink: 1 }, w);
    const box = { x: room.x + i * (w + 20), y: room.y + room.height / 2 - 20, width: w, height: 40 };
    boxes.set(node.key, box);
    const r = [{ closed: true, points: [{ x: box.x, y: box.y }, { x: box.x + w, y: box.y }, { x: box.x + w, y: box.y + 40 }, { x: box.x, y: box.y + 40 }] }];
    parts.push({ kind: 'shape', owner: node.key, part: 'box', outline: r, role: 'frame' });
    parts.push({ kind: 'text', owner: node.key, part: 'words', text: node.text, emphasis: [], box: { ...box, height: Math.max(text.height, 20) }, spec: { size: 'm', weight: 'normal', face: null, letterCase: 'asis', shrink: 1 }, align: 'center', role: 'words', plate: false });
  });
  for (const link of links) {
    const f = link.figure?.kind === 'link' ? link.figure : null;
    const a = f === null ? undefined : boxes.get(f.from);
    const b = f === null ? undefined : boxes.get(f.to);
    if (a === undefined || b === undefined) continue;
    parts.push({ kind: 'shape', owner: link.key, part: 'line', outline: [{ closed: false, points: [{ x: a.x + a.width, y: a.y + 20 }, { x: b.x, y: b.y + 20 }] }], role: 'line' });
  }
  void look;
  return { boxes, parts, routes: new Map(), notes: [], shrink: 1 };
};

const lines = ['flow f1', 'node a in=f1 | Ask', 'node b in=f1 from=a | Think', 'node c in=f1 from=b | Answer'];
const score = new TurnScore(EMPTY_STAGE);
const arrivals = new Map<string, number>();
let schedule = score.schedule;
let seq = 1;
for (const [i, raw] of lines.entries()) {
  const parsed = parseLine(raw);
  if (parsed.kind !== 'line') throw new Error(`not a line: ${raw}`);
  const at = i * 1.0;
  const result = score.push(parsed.line as Line, seq++, at);
  schedule = result.schedule;
  for (const e of schedule.elements) if (!arrivals.has(e.key)) arrivals.set(e.key, at);
}
const tl = buildTimeline(schedule, EMPTY_STAGE, { viewport: { width: 1280, height: 720, dpr: 1 }, reducedMotion: false, lockLook: 'paper' in LOOKS ? 'paper' : null, paintings: new Map(), arrivals, engine });
const check = (cond: boolean, what: string): void => {
  console.log(cond ? 'ok  ' : 'FAIL', what);
  if (!cond) throw new Error(what);
};
const at = (t: number) => tl.frameAt({ time: t, ambient: t, wallTime: 0, clock: 'idle' });
const early = at(0.2);
const late = at(8);
check(late.elements.filter((e) => e.key.startsWith('a@') || e.key.startsWith('b@') || e.key.startsWith('c@')).length === 3, 'three nodes set their words');
check(late.figures.some((f) => f.key.includes('/line')), 'a link is drawn');
const keyA = late.elements.find((e) => e.id === 'a')?.key ?? '';
const xs = [0.2, 1.2, 2.2, 3.5, 8].map((t) => at(t).elements.find((e) => e.key === keyA)?.x);
console.log('node a x over time (eases as arrivals add epochs):', xs.map((x) => x?.toFixed(1)));
check(early.elements.filter((e) => e.id === 'c').length === 0, 'a node not yet entered is not drawn though its layout is known');
console.log('views', tl.viewsAt({ time: 8, ambient: 8, wallTime: 0, clock: 'idle' }).filter((v) => v.kind === 'node').map((v) => `${v.id}:${v.box.x.toFixed(0)}`).join(' '));
