// The structure bench. No browser: text is sized by a stand-in measurer
// (proportional or fixed pitch by the look's face), the looks are the real
// nine, the rooms the real safe frames at 1280x720 and 375x667.
//
//   pnpm --filter @conduit/language exec tsx ../web/src/painter/blocks/bench.ts [generated=3000] [--verbose]
//
// It lays out every structure in every worked example on disk (the technique
// seed, the demos, the prompt, the docs) in nine looks at both screens, then
// thousands of generated ones, and counts: overlapping text, connectors
// through nodes, crossed labels, time, stability under
// an appended node, and the same for callouts.

import { EMPTY_STAGE, LineNormalizer, LineReader, PROMPT_EXAMPLE_STRUCTURE, PROMPT_EXAMPLES, SIZE_SCALE, TurnScore } from '@conduit/language';
import type { ElementSpan, Point, Polyline, Size } from '@conduit/language';
import type { BlockLook, CalloutInput, MeasuredText, StructureInput, StructureLayout, TextMeasure } from '../../contracts/blocks';
import type { LookSpec } from '../../contracts/look';
import type { Box } from '../../contracts/space';
import { LOOKS } from '../../looks';
import { bodySize, cellOf, safeFrame } from '../layout/metrics';
import { auditCallouts, auditStructure } from './audit';
import { layoutCallouts, layoutStructure } from './index';

// The web package's types carry no Node; the bench takes what it needs from the runtime.
declare const process: { exit(c: number): never; argv: string[]; stdout: { write(s: string): void }; exitCode?: number; getBuiltinModule(name: string): unknown };
const fs = process.getBuiltinModule('node:fs') as {
  readdirSync(p: string): string[];
  readFileSync(p: string, enc: 'utf8'): string;
  statSync(p: string): { isDirectory(): boolean };
};
const join = (a: string, b: string): string => `${a.replace(/\/$/, '')}/${b}`;
const { readdirSync, readFileSync, statSync } = fs;

// ---------------------------------------------------------------- pipeline

function elementsOf(source: string): readonly ElementSpan[] {
  const score = new TurnScore(EMPTY_STAGE);
  const reader = new LineReader();
  let seq = 0;
  let auto = 0;
  const normalizer = new LineNormalizer(() => `x${(auto += 1)}`);
  for (const raw of source.split('\n')) {
    const result = reader.read(raw);
    if (result.kind !== 'line') continue;
    const normalized = normalizer.normalize(result.line);
    if (normalized.line === null) continue;
    seq += 1;
    score.push(normalized.line, seq, 0);
  }
  return score.schedule.elements;
}

interface Parsed {
  readonly structure: ElementSpan;
  readonly nodes: ElementSpan[];
  readonly links: ElementSpan[];
}

function structuresOf(source: string): Parsed[] {
  const elements = elementsOf(source);
  return elements
    .filter((e) => e.figure?.kind === 'structure')
    .map((s) => ({
      structure: s,
      nodes: elements.filter((e) => e.parent === s.key && e.figure?.kind === 'node'),
      links: elements.filter((e) => e.parent === s.key && e.figure?.kind === 'link'),
    }));
}

// ---------------------------------------------------------------- stand-in text and looks

function measurerFor(look: LookSpec, viewport: { width: number; height: number; dpr: number }): TextMeasure {
  const fixed = look.type.pitch === 'fixed';
  return (text, spec, maxWidth): MeasuredText => {
    const cell = cellOf(spec.size, viewport, look);
    const size = spec.shrink;
    const advance = fixed ? cell.width * size : look.type.advance * cell.fontSize * size;
    const widthOf = (s: string): number => {
      if (fixed) return s.length * advance;
      let w = 0;
      for (const ch of s) w += advance * (/[il.,'|:;!]/.test(ch) ? 0.55 : /[mwMW@]/.test(ch) ? 1.4 : /[A-Z0-9]/.test(ch) ? 1.15 : ch === ' ' ? 0.7 : 1);
      return w;
    };
    const lineHeight = cell.height * size;
    const lines: { text: string; width: number }[] = [];
    for (const para of text.split('\n')) {
      let cur = '';
      for (const word of para.split(/\s+/).filter((x) => x !== '')) {
        const next = cur === '' ? word : `${cur} ${word}`;
        if (cur !== '' && widthOf(next) > maxWidth) {
          lines.push({ text: cur, width: widthOf(cur) });
          cur = word;
        } else cur = next;
      }
      lines.push({ text: cur, width: widthOf(cur) });
    }
    return { width: Math.max(...lines.map((l) => l.width)), height: lines.length * lineHeight, lineHeight, lines };
  };
}

interface Screen {
  readonly name: string;
  readonly width: number;
  readonly height: number;
}
const SCREENS: Screen[] = [
  { name: '1280x720', width: 1280, height: 720 },
  { name: '375x667', width: 375, height: 667 },
];

interface Setup {
  readonly look: LookSpec;
  readonly screen: Screen;
  readonly measure: TextMeasure;
  readonly blockLook: BlockLook;
  readonly room: Box;
  readonly canvas: StructureInput['canvas'];
}

// `--room=0.55`: the block is given that share of the safe frame's height, as when words and choices share the column with it
const ROOM_SHARE = Number((process.argv.find((a) => a.startsWith('--room=')) ?? '--room=1').slice(7));
const shorter = (b: Box): Box => ({ ...b, height: b.height * ROOM_SHARE });

function setupFor(look: LookSpec, screen: Screen): Setup {
  const viewport = { width: screen.width, height: screen.height, dpr: 1 };
  const m = cellOf('m' as Size, viewport, look);
  const unit = Math.min(screen.width / 160, screen.height / 90);
  const fixed = look.type.snapToCells;
  void bodySize;
  void SIZE_SCALE;
  return {
    look,
    screen,
    measure: measurerFor(look, viewport),
    blockLook: {
      body: m.height,
      minShrink: 0.7,
      stroke: Math.max(1.5, Math.min(4, look.stroke.thick * unit * 0.4)),
      radius: fixed || look.stroke.character === 'pixel' ? 0 : 4,
      grid: fixed ? { cell: { width: m.width, height: m.height } } : null,
    },
    room: shorter(safeFrame(viewport, look)),
    canvas: { origin: { x: -80 * unit, y: -45 * unit }, unit },
  };
}

// `--real`: the words are set by the painter's own measurer (its advance tables), not the stand-in; run it with
//   npx tsx --import ../web/src/bench/node-register.mjs ../web/src/painter/blocks/bench.ts --real
const realMeasurer = process.argv.includes('--real') ? (await import('../structures')).measurerFor : null;

function inputFor(p: Parsed, s: Setup, room: Box = s.room): StructureInput {
  const measure = realMeasurer === null ? s.measure : realMeasurer(s.look, { width: s.screen.width, height: s.screen.height, dpr: 1 }, p.structure.style);
  return { structure: p.structure, nodes: p.nodes, links: p.links, room, canvas: s.canvas, measure, look: s.blockLook, scope: {}, obstacles: [] };
}

// ---------------------------------------------------------------- scripts on disk

function collectScripts(root: string): { source: string; label: string }[] {
  const found: { source: string; label: string }[] = [];
  const skip = new Set(['node_modules', '.git', '.claude', 'dist']);
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (skip.has(name)) continue;
      const path = join(dir, name);
      const st = statSync(path);
      if (st.isDirectory()) walk(path);
      else if (name.endsWith('.series')) found.push({ source: readFileSync(path, 'utf8'), label: path });
      else if (name.endsWith('.md') || name.endsWith('.json')) {
        const text = readFileSync(path, 'utf8');
        for (const m of text.matchAll(/```series\n([\s\S]*?)```/g)) found.push({ source: m[1] as string, label: `${path}#${m.index}` });
      }
    }
  };
  walk(root);
  for (const e of [...PROMPT_EXAMPLES, PROMPT_EXAMPLE_STRUCTURE]) found.push({ source: e.lines.join('\n'), label: `prompt:${e.title.slice(0, 30)}` });
  return found;
}

// ---------------------------------------------------------------- generators

function rngOf(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = 'water soil check dry heat press wait mix send read plan open close store ship render queue cache index merge branch commit review deploy rollback signal sensor motor valve pump filter cool warm thaw freeze approve reject escalate notify archive'.split(' ');
const LONG = ['Authenticate against the identity provider', 'Is the request signed and unexpired?', 'Retry with exponential backoff', 'Write', 'Done', 'A very long unbroken identifier like supercalifragilisticexpialidocious'];

let stress = false;

interface Gen {
  readonly kind: string;
  readonly source: string;
  readonly lastId: string;
}

function generate(kind: string, rng: () => number, big = false): Gen {
  const pick = <T,>(a: readonly T[]): T => a[Math.floor(rng() * a.length)] as T;
  const words = (lo: number, hi: number): string => {
    if (rng() < 0.1) return pick(LONG);
    const n = lo + Math.floor(rng() * (hi - lo + 1));
    return Array.from({ length: n }, () => pick(WORDS)).join(' ');
  };
  const lines: string[] = ['scene caption'];
  let lastId = 'n0';
  if (kind === 'flow' || kind === 'tree') {
    const n = big ? 30 + Math.floor(rng() * 11) : 3 + Math.floor(rng() * (stress ? 12 : kind === 'flow' ? 7 : 10));
    const grow = pick(['', ' down', ' right']);
    lines.push(`${kind}${grow}${rng() < 0.3 ? ' | A title' : ''}`);
    const children = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i += 1) {
      const id = `n${i}`;
      lastId = id;
      let from = '';
      if (i > 0) {
        const p = rng() < 0.6 ? i - 1 : Math.floor(rng() * i);
        children[p] = (children[p] as number) + 1;
        from = ` from=n${p}${kind === 'flow' && rng() < 0.4 ? `:${pick(['yes', 'no', 'maybe', 'retry'])}` : ''}`;
      }
      const shape = kind === 'flow' ? pick(['', '', 'ask', 'end']) : '';
      lines.push(`node ${id}${shape ? ` ${shape}` : ''}${from}${rng() < 0.1 ? ' fill=accent' : ''} | ${words(1, 6)}`);
    }
    if (kind === 'flow') {
      const extra = Math.floor(rng() * 3);
      for (let k = 0; k < extra && n > 3; k += 1) {
        const a = Math.floor(rng() * n);
        const b = Math.floor(rng() * n);
        if (a !== b) lines.push(`link n${a} n${b}${rng() < 0.5 ? ` | ${pick(['again', 'else', 'loop'])}` : ''}`);
      }
    }
  } else if (kind === 'cycle') {
    const n = 3 + Math.floor(rng() * 10);
    lines.push(`cycle${rng() < 0.4 ? ' | Title of the ring' : ''}`);
    for (let i = 0; i < n; i += 1) {
      lastId = `n${i}`;
      lines.push(`node n${i} | ${words(1, 4)}`);
    }
  } else if (kind === 'timeline') {
    const n = 3 + Math.floor(rng() * (stress ? 10 : 6));
    const base = pick([1400, 1850, 1900, 1950, 2000]);
    const span = pick([20, 80, 160, 400]);
    const years = Array.from({ length: n }, () => base + Math.floor(rng() * span)).sort((a, b) => a - b);
    lines.push(`timeline${rng() < 0.4 ? ' | History' : ''}`);
    years.forEach((y, i) => {
      lastId = `n${i}`;
      const second = rng() < 0.2 ? ` ${y + 1 + Math.floor(rng() * 10)}` : '';
      lines.push(`node n${i} ${y}${second} | ${words(2, 6)}`);
    });
  } else if (kind === 'map') {
    const n = 3 + Math.floor(rng() * (stress ? 8 : 6));
    lines.push(`map${rng() < 0.5 ? ' route' : ''}${rng() < 0.3 ? ' | A route' : ''}`);
    for (let i = 0; i < n; i += 1) {
      lastId = `n${i}`;
      lines.push(`node n${i} ${20 + Math.floor(rng() * 120)},${12 + Math.floor(rng() * 66)} | ${words(1, 3)}`);
    }
  } else {
    const rows = 2 + Math.floor(rng() * (stress ? 13 : 9));
    const cols = 2 + Math.floor(rng() * 4);
    const bars = cols >= 2 && rng() < 0.4;
    lines.push(`table${bars ? ' bars' : ''}${rng() < 0.4 ? ' | A table' : ''}`);
    lines.push(`| ${Array.from({ length: cols }, (_, c) => (c === 0 ? 'Name' : pick(['Cost', 'Mass kg', 'Share', 'Speed']))).join(' | ')}`);
    for (let r = 0; r < rows; r += 1) {
      const cells = Array.from({ length: cols }, (_, c) => {
        if (c === 0) return `${rng() < 0.15 ? '*' : ''}${words(1, 3)}${rng() < 0.15 ? '*' : ''}`;
        return c === 1 || rng() < 0.6 ? pick([`${Math.floor(rng() * 5000)}`, `${(rng() * 100).toFixed(1)}%`, `$${(rng() * 9).toFixed(2)}M`, `${(rng() * 12).toFixed(3)}`]) : words(1, 4);
      });
      lines.push(`| ${cells.join(' | ')}`);
    }
  }
  return { kind, source: lines.join('\n'), lastId };
}

// ---------------------------------------------------------------- stats

interface Tally {
  layouts: number;
  overlappingText: number;
  throughNodes: number;
  crossed: number;
  outside: number;
  crowded: number;
  silent: number;
  dirty: string[];
}
const tally = (): Tally => ({ layouts: 0, overlappingText: 0, throughNodes: 0, crossed: 0, outside: 0, crowded: 0, silent: 0, dirty: [] });

function measure(t: Tally, layout: StructureLayout, input: StructureInput, label: string): void {
  const a = auditStructure(layout, input);
  t.layouts += 1;
  t.overlappingText += a.overlappingText;
  t.throughNodes += a.connectorsThroughNodes;
  t.crossed += a.crossedLabels;
  t.outside += a.outside;
  if (layout.notes.some((n) => n.note === 'crowded')) t.crowded += 1;
  if (a.overlappingText + a.connectorsThroughNodes + a.crossedLabels > 0 && !layout.notes.some((n) => n.note === 'crowded' || n.note === 'collides' || n.note === 'crossed')) t.silent += 1;
  const strict = process.argv.includes('--outside');
  const quiet = process.argv.includes('--silent');
  const bad = a.overlappingText + a.connectorsThroughNodes + a.crossedLabels + (strict ? a.outside : 0) > 0;
  const told = layout.notes.some((n) => n.note === 'crowded' || n.note === 'collides' || n.note === 'crossed');
  if (bad && (!quiet || !told) && t.dirty.length < 8) t.dirty.push(`${label}: text ${a.overlappingText}, through ${a.connectorsThroughNodes}, crossed ${a.crossedLabels}, outside ${a.outside}, shrink ${layout.shrink.toFixed(2)}, ${layout.notes.map((n) => n.note).join('/')}`);
}

function report(title: string, tallies: Map<string, Tally>): [number, number, number] {
  let o = 0;
  let c = 0;
  let x = 0;
  process.stdout.write(`\n${title}\n`);
  for (const [kind, t] of tallies) {
    process.stdout.write(
      `  ${kind.padEnd(9)} layouts ${String(t.layouts).padStart(6)}  overlap ${String(t.overlappingText).padStart(4)}  through ${String(t.throughNodes).padStart(4)}  crossed ${String(t.crossed).padStart(4)}  outside ${String(t.outside).padStart(4)}  crowded ${String(t.crowded).padStart(4)}  SILENT ${String(t.silent).padStart(3)}\n`,
    );
    for (const d of t.dirty) process.stdout.write(`      ${d}\n`);
    o += t.overlappingText;
    c += t.throughNodes;
    x += t.crossed;
  }
  return [o, c, x];
}

const verbose = process.argv.includes('--verbose');
stress = process.argv.includes('--stress');
if (process.argv.includes('--dump')) {
  const script = process.argv[process.argv.indexOf('--dump') + 1] ?? '';
  const src = script.replace(/;/g, '\n');
  const lookName = (process.argv[process.argv.indexOf('--dump') + 2] ?? 'paper') as keyof typeof LOOKS;
  // `--screen=WxH` sets the size the dump is laid out at (else the screen numbered after the look)
  const sized = /^--screen=(\d+)x(\d+)$/.exec(process.argv.find((a) => a.startsWith('--screen=')) ?? '');
  const s0 = setupFor(LOOKS[lookName], sized === null ? (SCREENS[Number(process.argv[process.argv.indexOf('--dump') + 3] ?? 0)] as Screen) : { name: sized[0].slice(9), width: Number(sized[1]), height: Number(sized[2]) });
  const p0 = structuresOf(src)[0] as Parsed;
  const input = inputFor(p0, s0);
  const lay = layoutStructure(input);
  process.stdout.write(`room ${JSON.stringify(input.room)} shrink ${lay.shrink} notes ${JSON.stringify(lay.notes)}\n`);
  for (const [k, b] of lay.boxes) process.stdout.write(`box ${k} ${JSON.stringify(b)}\n`);
  for (const part of lay.parts) process.stdout.write(`${part.kind} ${part.owner} ${part.part} ${part.role} ${part.kind === 'text' ? JSON.stringify(part.box) + part.text : JSON.stringify(part.outline[0]?.points.slice(0, 3))}\n`);
  process.stdout.write(JSON.stringify(auditStructure(lay, input)) + '\n');
  const out = process.argv.find((a) => a.startsWith('--svg='));
  if (out) {
    const w = s0.screen.width;
    const h = s0.screen.height;
    const pts = (pl: Polyline): string => pl.points.map((p) => `${(p.x + w / 2).toFixed(1)},${(p.y + h / 2).toFixed(1)}`).join(' ');
    const el: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" style="background:#fff"><rect x="${input.room.x + w / 2}" y="${input.room.y + h / 2}" width="${input.room.width}" height="${input.room.height}" fill="none" stroke="#ddd"/>`];
    for (const part of lay.parts) {
      if (part.kind === 'shape') for (const pl of part.outline) el.push(`<${pl.closed ? 'polygon' : 'polyline'} points="${pts(pl)}" fill="${part.role === 'head' || part.role === 'marker' ? '#c33' : part.role === 'fill' ? '#fff' : part.role === 'bar' ? '#69c' : 'none'}" stroke="${part.role === 'grid' ? '#bbb' : part.role === 'line' ? '#777' : '#000'}" stroke-width="1.2"/>`);
      else {
        const b = part.box;
        el.push(`<rect x="${b.x + w / 2}" y="${b.y + h / 2}" width="${b.width}" height="${b.height}" fill="${part.plate ? '#fff' : 'none'}" stroke="#fc8" stroke-width="0.5"/><text x="${b.x + w / 2 + (part.align === 'center' ? b.width / 2 : part.align === 'right' ? b.width : 0)}" y="${b.y + h / 2 + b.height / Math.max(1, part.text.split(' ').length > 2 ? 2 : 1) * 0.5 + 4}" font-size="${Math.min(16, b.height / Math.max(1, Math.round(b.height / 20)) * 0.7)}" font-family="sans-serif" text-anchor="${part.align === 'center' ? 'middle' : part.align === 'right' ? 'end' : 'start'}" fill="${part.role === 'tick' || part.role === 'label' ? '#666' : '#000'}">${part.text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>`);
      }
    }
    el.push('</svg>');
    (process.getBuiltinModule('node:fs') as { writeFileSync(p: string, d: string): void }).writeFileSync(out.slice(6), el.join('\n'));
  }
  process.exit(0);
}
const count = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 3000);
const root = new URL('../../../../', import.meta.url).pathname;
const lookList = Object.entries(LOOKS);
const setups = lookList.flatMap(([, look]) => SCREENS.map((s) => setupFor(look, s)));

// 1. every structure on disk
const disk = new Map<string, Tally>();
let scripts = 0;
let structures = 0;
for (const sc of collectScripts(root)) {
  const parsed = structuresOf(sc.source);
  if (parsed.length === 0) continue;
  scripts += 1;
  for (const p of parsed) {
    const kind = p.structure.figure?.kind === 'structure' ? p.structure.figure.structure : '?';
    if (kind === 'chart') continue;
    structures += 1;
    const t = disk.get(kind) ?? tally();
    disk.set(kind, t);
    for (const s of setups) {
      const input = inputFor(p, s);
      measure(t, layoutStructure(input), input, `${sc.label.replace(root, '')} [${kind}] ${s.look.id} ${s.screen.name}`);
    }
  }
}
process.stdout.write(`on disk: ${scripts} scripts, ${structures} structures, ${setups.length} look/screen pairs each\n`);
const [o1, c1, x1] = report('on disk', disk);

// 2. generated
const generated = new Map<string, Tally>();
const kinds = ['flow', 'tree', 'cycle', 'timeline', 'map', 'table'];
const rng = rngOf(20260314);
const times = new Map<string, number[]>();
for (let i = 0; i < count; i += 1) {
  const kind = kinds[i % kinds.length] as string;
  const gen = generate(kind, rng);
  const parsed = structuresOf(gen.source)[0];
  if (!parsed) continue;
  const s = setups[Math.floor(rng() * setups.length)] as Setup;
  const input = inputFor(parsed, s);
  const t0 = performance.now();
  const layout = layoutStructure(input);
  (times.get(kind) ?? times.set(kind, []).get(kind))?.push(performance.now() - t0);
  const t = generated.get(kind) ?? tally();
  generated.set(kind, t);
  measure(t, layout, input, `#${i} ${s.look.id} ${s.screen.name}\n${verbose ? gen.source : ''}`);
}
const [o2, c2, x2] = report(`generated (${count})`, generated);
process.stdout.write('\ntime per layout, ms (median / worst):\n');
for (const [k, v] of times) {
  v.sort((a, b) => a - b);
  process.stdout.write(`  ${k.padEnd(9)} ${(v[Math.floor(v.length / 2)] ?? 0).toFixed(2)} / ${(v[v.length - 1] ?? 0).toFixed(2)}\n`);
}

// 3. a 40-node flow
{
  const paper = setupFor(LOOKS.paper, SCREENS[0] as Screen);
  const loose = { ...paper.room, width: paper.room.width * 3, height: paper.room.height * 3 };
  const r2 = rngOf(7);
  const results: { fitted: number[]; loose: number[] } = { fitted: [], loose: [] };
  for (let i = 0; i < 40; i += 1) {
    const p = structuresOf(generate('flow', r2, true).source)[0] as Parsed;
    for (const [room, bucket] of [[paper.room, results.fitted], [loose, results.loose]] as const) {
      const input = inputFor(p, paper, room);
      const t0 = performance.now();
      layoutStructure(input);
      bucket.push(performance.now() - t0);
    }
  }
  const med = (a: number[]): number => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] as number;
  process.stdout.write(`\n40-node flows: fitted to a 1280x720 room median ${med(results.fitted).toFixed(2)} ms (worst ${Math.max(...results.fitted).toFixed(2)}); loose room median ${med(results.loose).toFixed(2)} ms (worst ${Math.max(...results.loose).toFixed(2)})\n`);
}

// 4. stability: append one node to a shown layout
{
  const rs = rngOf(99);
  const worst: Record<string, { max: number; unit: number }> = {};
  for (const kind of ['flow', 'tree']) {
    let max = 0;
    let n = 0;
    let over = 0;
    for (let i = 0; i < 300; i += 1) {
      const gen = generate(kind, rs);
      const extended = `${gen.source}\nnode zz from=${gen.lastId} | Another one`;
      const a = structuresOf(gen.source)[0];
      const b = structuresOf(extended)[0];
      if (!a || !b) continue;
      const s = setupFor(LOOKS.paper, { name: 'roomy', width: 6000, height: 4000 });
      const la = layoutStructure(inputFor(a, s));
      const lb = layoutStructure(inputFor(b, s));
      if (la.shrink !== 1 || lb.shrink !== 1) continue;
      let m = 0;
      for (const node of a.nodes) {
        const x = la.boxes.get(node.key);
        const y = lb.boxes.get(node.key);
        if (x && y) m = Math.max(m, Math.hypot(x.x - y.x, x.y - y.y));
      }
      n += 1;
      if (m > max && process.argv.includes('--stab')) process.stdout.write(`--- ${m.toFixed(0)}\n${extended}\n${a.nodes.map((nd) => { const x = la.boxes.get(nd.key); const y = lb.boxes.get(nd.key); return x && y ? `${nd.id} ${x.x.toFixed(0)},${x.y.toFixed(0)} -> ${y.x.toFixed(0)},${y.y.toFixed(0)}` : ''; }).join('\n')}\n`);
      max = Math.max(max, m);
      if (m > s.blockLook.body * 2.4 * 1.0001) over += 1;
    }
    worst[kind] = { max, unit: setupFor(LOOKS.paper, { name: 'roomy', width: 6000, height: 4000 }).blockLook.body };
    process.stdout.write(`stability ${kind}: ${n} cases, largest move ${max.toFixed(1)} px (${(max / (worst[kind] as { unit: number }).unit).toFixed(1)} body lines), ${over} moved more than a nominal rank gap (2.4 body lines)\n`);
  }
}

// 5. callouts
{
  const rc = rngOf(31337);
  let o = 0;
  let onStroke = 0;
  let cross = 0;
  let through = 0;
  let strokeCross = 0;
  let n = 0;
  const times2: number[] = [];
  for (let i = 0; i < Math.max(500, count); i += 1) {
    const s = setups[Math.floor(rc() * setups.length)] as Setup;
    const room = s.room;
    const fw = room.width * (0.3 + rc() * 0.35);
    const fh = room.height * (0.3 + rc() * 0.4);
    const fig: Box = { x: room.x + (room.width - fw) / 2 + (rc() - 0.5) * room.width * 0.1, y: room.y + (room.height - fh) / 2, width: fw, height: fh };
    const strokes: Polyline[] = [];
    const targets: (Box | Point)[] = [];
    const parts = 2 + Math.floor(rc() * 5);
    const taken: Box[] = [];
    for (let k = 0; k < parts; k += 1) {
      let b: Box = fig;
      for (let tries = 0; tries < 30; tries += 1) {
        const w = fig.width * (0.12 + rc() * 0.25);
        const h = fig.height * (0.12 + rc() * 0.25);
        b = { x: fig.x + rc() * (fig.width - w), y: fig.y + rc() * (fig.height - h), width: w, height: h };
        if (!taken.some((t) => b.x < t.x + t.width + 6 && t.x < b.x + b.width + 6 && b.y < t.y + t.height + 6 && t.y < b.y + b.height + 6)) break;
      }
      taken.push(b);
      strokes.push({ points: [{ x: b.x, y: b.y }, { x: b.x + b.width, y: b.y }, { x: b.x + b.width, y: b.y + b.height }, { x: b.x, y: b.y + b.height }], closed: true });
      targets.push(rc() < 0.3 ? { x: b.x + rc() * b.width, y: rc() < 0.5 ? b.y : b.y + b.height } : b);
    }
    const labels = targets.map((target, k) => {
      const w = Math.min(room.width * 0.28, s.blockLook.body * (2.5 + rc() * 4) * (s.look.type.pitch === 'fixed' ? 0.7 : 1));
      return { key: `l${k}`, size: { width: w, height: s.blockLook.body * (1 + Math.floor(rc() * (w > room.width * 0.2 ? 1 : 2))) }, target, side: 'auto' as const };
    });
    const input: CalloutInput = { labels, figure: fig, room, obstacles: [], strokes, look: s.blockLook };
    const t0 = performance.now();
    const out = layoutCallouts(input);
    times2.push(performance.now() - t0);
    const a = auditCallouts(out, input);
    if (process.argv.includes('--co') && a.overlappingLabels + a.leadersThroughLabels > 0 && n < 400 && n % 40 === 0) process.stdout.write(`co ${s.look.id} ${s.screen.name} fig ${JSON.stringify(fig)} ${JSON.stringify(a)}\n  ${labels.map((l) => `${l.key} ${l.size.width.toFixed(0)}x${l.size.height.toFixed(0)} -> ${JSON.stringify(out.boxes.get(l.key))}`).join('\n  ')}\n`);
    n += 1;
    o += a.overlappingLabels;
    onStroke += a.labelsOnStrokes;
    cross += a.leadersCrossing;
    through += a.leadersThroughLabels;
    strokeCross += a.leadersCrossingStrokes;
  }
  times2.sort((a, b) => a - b);
  process.stdout.write(`\ncallouts: ${n} drawings, labels overlapping ${o}, labels on strokes ${onStroke}, leaders crossing ${cross}, leaders through labels ${through}, leaders crossing a stroke ${strokeCross} (a leader that must cross to reach its part is told as crossed), median ${times2[Math.floor(times2.length / 2)]?.toFixed(2)} ms\n`);
}

process.stdout.write(`\nrow 4 (structures): overlapping text ${o1 + o2}, connectors through nodes ${c1 + c2}, crossed labels ${x1 + x2}\n`);
process.exitCode = o1 + o2 + c1 + c2 + x1 + x2 === 0 ? 0 : 1;
