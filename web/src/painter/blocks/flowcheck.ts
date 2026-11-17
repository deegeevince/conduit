// `pnpm flows`: the flowchart case that went wrong, held to what it must be. A car's parts (written the way the brain wrote them: a chain by
// `from=`, the rest joined by `link` lines, one of them dashed, one plain, one a note) is laid out at the sizes people use, with the painter's own
// type, and held to:
//
//   lanes     no two connectors lie along one another (a segment of one on, or a hair from, a segment of another), except the short runs
//             that leave or enter one node, which are spread along its side
//   labels    every connector's words stand beside its own line (within `LABEL_NEAR` of it), not on another's, and are the words it was given
//   detour    no route is longer than `DETOUR` times the right-angled way between the boxes it joins (plus a little for the arrowheads)
//   beside    a part joined only by a `link` stands near the part it joins (the computer by the engine)
//   dashed    the dashed link is drawn in dashes, the plain one without a head
//   ports     no side of a node has ends nearer than an arrowhead's width
//
//   pnpm flows [--verbose] [--svg=<dir>]

import { EMPTY_STAGE, LineNormalizer, LineReader, TurnScore } from '@conduit/language';
import type { ElementSpan, Point, Polyline } from '@conduit/language';
import type { BlockLook, StructureInput, StructureLayout } from '../../contracts/blocks';
import type { Box } from '../../contracts/space';
import { LOOKS } from '../../looks';
import { cellOf, safeFrame } from '../layout/metrics';
import { measurerFor } from '../structures';
import { layoutStructure } from './index';

declare const process: { argv: string[]; exitCode?: number; stdout: { write(s: string): void } };

/** a label's box stands within this many body heights of its own line */
const LABEL_NEAR = 1.6;
/** the longest a route may be, in the right-angled distance between the boxes it joins */
const DETOUR = 3;

export const CAR: readonly string[] = [
  "flow x51 right | How a car's core parts connect",
  'node tank in=x51 | Fuel tank',
  'node pump in=x51 from=tank | Fuel pump',
  'node engine in=x51 from=pump:fuel | Engine',
  'node rad in=x51 | Radiator',
  'node exh in=x51 from=engine:burnt gas | Exhaust',
  'node gear in=x51 from=engine:turning | Gearbox and clutch',
  'node shaft in=x51 from=gear | Driveshaft and differential',
  'node wheels in=x51 end from=shaft | Wheels',
  'node battery in=x51 | Battery',
  'node starter in=x51 from=battery | Starter motor',
  'node alt in=x51 from=engine:belt | Alternator',
  'node ecu in=x51 note | ECU computer',
  'node pedal in=x51 | Brake pedal',
  'node brakes in=x51 from=pedal:fluid | Calipers and discs',
  'node steer in=x51 | Steering wheel and rack',
  'node susp in=x51 | Springs and dampers',
  'link rad engine both | coolant',
  'link starter engine | cranks it',
  'link alt battery | charges',
  'link ecu engine dashed | times fuel and spark',
  'link brakes wheels | slow',
  'link steer wheels | turn the front',
  'link susp wheels plain | hold up',
];

function elementsOf(lines: readonly string[]): readonly ElementSpan[] {
  const score = new TurnScore(EMPTY_STAGE);
  const reader = new LineReader();
  const normalizer = new LineNormalizer(() => `x${100 + score.schedule.elements.length}`);
  let seq = 0;
  for (const raw of lines) {
    const result = reader.read(raw);
    if (result.kind !== 'line') continue;
    const normalized = normalizer.normalize(result.line);
    if (normalized.line === null) continue;
    seq += 1;
    score.push(normalized.line, seq, 0);
  }
  return score.schedule.elements;
}

interface Run {
  readonly label: string;
  readonly layout: StructureLayout;
  readonly input: StructureInput;
  readonly body: number;
  readonly head: number;
}

function run(lines: readonly string[], look: keyof typeof LOOKS, width: number, height: number, share: number): Run {
  const elements = elementsOf(lines);
  const structure = elements.find((e) => e.figure?.kind === 'structure') as ElementSpan;
  const nodes = elements.filter((e) => e.parent === structure.key && e.figure?.kind === 'node');
  const links = elements.filter((e) => e.parent === structure.key && e.figure?.kind === 'link');
  const spec = LOOKS[look];
  const viewport = { width, height, dpr: 1 };
  const m = cellOf('m', viewport, spec);
  const unit = Math.min(width / 160, height / 90);
  const fixed = spec.type.snapToCells;
  const blockLook: BlockLook = {
    body: m.height,
    minShrink: 0.7,
    stroke: Math.max(1.5, Math.min(4, spec.stroke.thick * unit * 0.4)),
    radius: fixed || spec.stroke.character === 'pixel' ? 0 : 4,
    grid: fixed ? { cell: { width: m.width, height: m.height } } : null,
  };
  const frame = safeFrame(viewport, spec);
  const room: Box = { ...frame, height: frame.height * share };
  const input: StructureInput = { structure, nodes, links, room, canvas: { origin: { x: -80 * unit, y: -45 * unit }, unit }, measure: measurerFor(spec, viewport, structure.style), look: blockLook, scope: {}, obstacles: [] };
  const layout = layoutStructure(input);
  return { label: `${look} ${width}x${height}`, layout, input, body: m.height * layout.shrink, head: blockLook.stroke * 4 };
}

// ------------------------------------------------------------------------------------------------ geometry

const segs = (pts: readonly Point[]): { a: Point; b: Point; end: boolean }[] => pts.slice(0, -1).map((a, i) => ({ a, b: pts[i + 1] as Point, end: i === 0 || i + 2 === pts.length }));
const lengthOf = (pts: readonly Point[]): number => segs(pts).reduce((t, s) => t + Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y), 0);

function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = dx === 0 && dy === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** the least distance from a box to a polyline (0 when the line goes through it) */
function distBoxToLine(box: Box, pts: readonly Point[]): number {
  let best = Infinity;
  for (const { a, b } of segs(pts)) {
    const near = (p: Point): number => Math.max(box.x - p.x, 0, p.x - (box.x + box.width)) ** 2 + Math.max(box.y - p.y, 0, p.y - (box.y + box.height)) ** 2;
    // sample the segment: boxes and segments here are small
    const n = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 2));
    for (let i = 0; i <= n; i += 1) best = Math.min(best, Math.sqrt(near({ x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n })));
  }
  void distToSegment;
  return best;
}

const gapBetween = (a: Box, b: Box): number => Math.hypot(Math.max(a.x - (b.x + b.width), 0, b.x - (a.x + a.width)), Math.max(a.y - (b.y + b.height), 0, b.y - (a.y + a.height)));

// ------------------------------------------------------------------------------------------------ the checks

function check(r: Run): string[] {
  const bad: string[] = [];
  const { layout, input } = r;
  const keys = [...layout.routes.keys()];
  const ownerOf = new Map<string, { from: string; to: string }>();
  for (const l of input.links) if (l.figure?.kind === 'link') ownerOf.set(l.key, { from: l.figure.from, to: l.figure.to });
  const idOf = (key: string): string => input.nodes.find((n) => n.key === key)?.id ?? key;
  const nameOf = (key: string): string => {
    const o = ownerOf.get(key);
    return o === undefined ? key : `${idOf(o.from)}>${idOf(o.to)}`;
  };
  const boxes = layout.boxes;

  // lanes
  const lane = Math.max(2, r.body * 0.12);
  for (let i = 0; i < keys.length; i += 1)
    for (let j = i + 1; j < keys.length; j += 1) {
      const p = (layout.routes.get(keys[i] as string) as Polyline).points;
      const q = (layout.routes.get(keys[j] as string) as Polyline).points;
      for (const s of segs(p))
        for (const t of segs(q)) {
          const hs = Math.abs(s.a.y - s.b.y) < 0.5;
          const ht = Math.abs(t.a.y - t.b.y) < 0.5;
          if (hs !== ht) continue;
          const [d, o] = hs ? [Math.abs(s.a.y - t.a.y), Math.min(Math.max(s.a.x, s.b.x), Math.max(t.a.x, t.b.x)) - Math.max(Math.min(s.a.x, s.b.x), Math.min(t.a.x, t.b.x))] : [Math.abs(s.a.x - t.a.x), Math.min(Math.max(s.a.y, s.b.y), Math.max(t.a.y, t.b.y)) - Math.max(Math.min(s.a.y, s.b.y), Math.min(t.a.y, t.b.y))];
          if (d < lane && o > 2 && !(s.end && t.end)) bad.push(`lanes: ${nameOf(keys[i] as string)} and ${nameOf(keys[j] as string)} lie along one another (${o.toFixed(0)} long, ${d.toFixed(1)} apart)`);
        }
    }

  // labels, detours
  const labels = layout.parts.flatMap((p) => (p.kind === 'text' && p.role === 'label' ? [p] : []));
  const given = new Map(input.links.map((l) => [l.key, l.text]));
  for (const key of keys) {
    const route = (layout.routes.get(key) as Polyline).points;
    const o = ownerOf.get(key);
    if (o === undefined) continue;
    const a = boxes.get(o.from);
    const b = boxes.get(o.to);
    if (a === undefined || b === undefined) continue;
    const straight = Math.abs(a.x + a.width / 2 - (b.x + b.width / 2)) + Math.abs(a.y + a.height / 2 - (b.y + b.height / 2));
    if (lengthOf(route) > DETOUR * straight + 6 * r.head) bad.push(`detour: ${nameOf(key)} runs ${lengthOf(route).toFixed(0)} for a straight ${straight.toFixed(0)}`);
    const mine = labels.find((l) => l.owner === key);
    const words = given.get(key) ?? '';
    if (words.trim() === '') continue;
    if (mine === undefined) {
      bad.push(`labels: ${nameOf(key)} lost its words "${words}"`);
      continue;
    }
    const own = distBoxToLine(mine.box, route);
    if (own > LABEL_NEAR * r.body) bad.push(`labels: "${mine.text}" stands ${own.toFixed(0)} from its own line (${nameOf(key)})`);
    for (const other of keys) {
      if (other === key) continue;
      const d = distBoxToLine(mine.box, (layout.routes.get(other) as Polyline).points);
      if (d < 0.5 && own >= 0.5) bad.push(`labels: "${mine.text}" stands on the line of ${nameOf(other)}`);
    }
  }

  // ports: the ends on one side of a node
  for (const n of input.nodes) {
    const b = boxes.get(n.key);
    if (b === undefined) continue;
    const onSide: number[][] = [[], [], [], []];
    for (const key of keys) {
      const pts = (layout.routes.get(key) as Polyline).points;
      for (const p of [pts[0] as Point, pts[pts.length - 1] as Point]) {
        if (p.x < b.x - 1.5 || p.x > b.x + b.width + 1.5 || p.y < b.y - 1.5 || p.y > b.y + b.height + 1.5) continue;
        if (Math.abs(p.x - b.x) < 1.5) onSide[0]?.push(p.y);
        else if (Math.abs(p.x - (b.x + b.width)) < 1.5) onSide[1]?.push(p.y);
        else if (Math.abs(p.y - b.y) < 1.5) onSide[2]?.push(p.x);
        else if (Math.abs(p.y - (b.y + b.height)) < 1.5) onSide[3]?.push(p.x);
      }
    }
    for (const list of onSide) {
      list.sort((x, y) => x - y);
      for (let i = 0; i + 1 < list.length; i += 1) if ((list[i + 1] as number) - (list[i] as number) < r.head * 0.7 && (list[i + 1] as number) !== (list[i] as number)) bad.push(`ports: ${n.id} has two ends ${((list[i + 1] as number) - (list[i] as number)).toFixed(1)} apart on one side`);
    }
  }

  // beside: the computer by the engine
  const ecu = input.nodes.find((n) => n.id === 'ecu');
  const engine = input.nodes.find((n) => n.id === 'engine');
  if (ecu !== undefined && engine !== undefined) {
    const a = boxes.get(ecu.key);
    const b = boxes.get(engine.key);
    if (a !== undefined && b !== undefined && gapBetween(a, b) > 1.5 * Math.max(a.width, b.width)) bad.push(`beside: the ECU stands ${gapBetween(a, b).toFixed(0)} from the engine`);
  }

  // dashed, plain
  const dashedKey = input.links.find((l) => l.figure?.kind === 'link' && l.figure.dashed)?.key;
  const plainKey = input.links.find((l) => l.figure?.kind === 'link' && l.figure.ends === 'plain')?.key;
  const drawn = (key: string): { lines: number; heads: number } => ({ lines: layout.parts.filter((p) => p.kind === 'shape' && p.owner === key && p.role === 'line').reduce((t, p) => t + (p.kind === 'shape' ? p.outline.length : 0), 0), heads: layout.parts.filter((p) => p.kind === 'shape' && p.owner === key && p.role === 'head').length });
  if (dashedKey !== undefined && drawn(dashedKey).lines < 3) bad.push('dashed: the dashed link is not drawn in dashes');
  if (plainKey !== undefined && drawn(plainKey).heads > 0) bad.push('dashed: the plain link has an arrowhead');
  // words: `from=engine:burnt gas` keeps both words
  if (!input.links.some((l) => l.text === 'burnt gas')) bad.push('words: "burnt gas" was cut to one word');
  return bad;
}

const verbose = process.argv.includes('--verbose');
const SIZES: readonly [keyof typeof LOOKS, number, number, number][] = [
  ['paper', 1280, 720, 0.8],
  ['paper', 1280, 800, 0.8],
  ['paper', 1344, 866, 0.75],
  ['paper', 1920, 866, 0.75],
  ['chalk', 1280, 720, 0.8],
];
let failed = 0;
for (const [look, w, h, share] of SIZES) {
  const r = run(CAR, look, w, h, share);
  const bad = check(r);
  failed += bad.length;
  process.stdout.write(`${bad.length === 0 ? 'ok  ' : 'FAIL'} car flow, ${r.label} (shrink ${r.layout.shrink.toFixed(2)})${bad.length === 0 ? '' : `\n      ${bad.join('\n      ')}`}\n`);
  void verbose;
}
if (failed > 0) {
  process.stdout.write(`FLOWS FAILED: ${failed}\n`);
  process.exitCode = 1;
}
