// Pictures of the engines at work. Dev tool, no browser needed to make the SVG; the real measurer (the painter's own
// advance tables) sets the words, so a node is the size it will be in the app. Then, to turn them into JPEGs:
//
//   cd language && npx tsx --import ../web/src/bench/node-register.mjs ../web/src/painter/blocks/gallery.ts \
//       <script.series|-> <outdir> [look=paper] [screens=1280x720,375x667] [room=1] [name=shot]
//
// `-` reads the script from standard input. `room` is the share of the safe frame's height given to the block (the plan gives a
// block what the words and the choices leave). The Chrome that renders the SVGs is started by the caller (see PLAN-v2.1 section 5).

import { EMPTY_STAGE, LineNormalizer, LineReader, TurnScore } from '@conduit/language';
import type { ElementSpan, Polyline } from '@conduit/language';
import type { BlockPart, StructureInput } from '../../contracts/blocks';
import type { Box } from '../../contracts/space';
import { LOOKS } from '../../looks';
import { cellOf, safeFrame } from '../layout/metrics';
import { measurerFor } from '../structures';
import { auditStructure } from './audit';
import { layoutStructure } from './index';

declare const process: { argv: string[]; stdout: { write(s: string): void }; stdin: { fd: number }; getBuiltinModule(name: string): unknown };
const fs = process.getBuiltinModule('node:fs') as { readFileSync(p: string | number, enc: 'utf8'): string; writeFileSync(p: string, d: string): void; mkdirSync(p: string, o: { recursive: boolean }): void };

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

const args = process.argv.slice(2);
const [scriptArg = '-', outDir = '.'] = args;
const opt = (name: string, fallback: string): string => args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
const lookId = opt('look', 'paper') as keyof typeof LOOKS;
const screens = opt('screens', '1280x720,375x667').split(',');
const roomShare = Number(opt('room', '1'));
const name = opt('name', 'shot');
const source = fs.readFileSync(scriptArg === '-' ? 0 : scriptArg, 'utf8');
fs.mkdirSync(outDir, { recursive: true });

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

for (const screen of screens) {
  const [w, h] = screen.split('x').map(Number) as [number, number];
  const look = LOOKS[lookId];
  const viewport = { width: w, height: h, dpr: 1 };
  const elements = elementsOf(source);
  const structure = elements.find((e) => e.figure?.kind === 'structure' && e.figure.structure !== 'chart');
  if (structure === undefined) throw new Error('no structure in the script');
  const nodes = elements.filter((e) => e.parent === structure.key && e.figure?.kind === 'node');
  const links = elements.filter((e) => e.parent === structure.key && e.figure?.kind === 'link');
  const safe = safeFrame(viewport, look);
  const room: Box = { ...safe, height: safe.height * roomShare };
  const body = cellOf('m', viewport, look);
  const unit = Math.min(w / 160, h / 90);
  const fixed = look.type.snapToCells;
  const input: StructureInput = {
    structure,
    nodes,
    links,
    room,
    canvas: { origin: { x: -80 * unit, y: -45 * unit }, unit },
    measure: measurerFor(look, viewport, structure.style),
    look: { body: body.height, minShrink: 0.7, stroke: Math.max(1.5, Math.min(4, look.stroke.thick * unit * 0.4)), radius: fixed ? 0 : body.height * 0.2, grid: fixed ? { cell: { width: body.width, height: body.height } } : null },
    scope: {},
    obstacles: [],
  };
  const layout = layoutStructure(input);
  const audit = auditStructure(layout, input);
  const R = look.roles;
  const pts = (pl: Polyline): string => pl.points.map((p) => `${(p.x + w / 2).toFixed(1)},${(p.y + h / 2).toFixed(1)}`).join(' ');
  const family = look.type.pitch === 'fixed' ? 'ui-monospace, Menlo, monospace' : 'Georgia, serif';
  const svg: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="${R.ground}"/>`];
  svg.push(`<rect x="${room.x + w / 2}" y="${room.y + h / 2}" width="${room.width}" height="${room.height}" fill="none" stroke="${R.dim}" stroke-width="0.6" stroke-dasharray="3 5"/>`);
  const strokeW = Math.max(1.2, input.look.stroke * 0.6);
  const accentOwners = new Set(nodes.filter((n) => n.style.fill === 'accent').map((n) => n.key));
  for (const part of layout.parts as readonly BlockPart[]) {
    if (part.kind === 'shape') {
      for (const pl of part.outline) {
        const fill = part.role === 'head' ? R.ink : part.role === 'marker' ? R.accent : part.role === 'bar' ? R.accent : part.role === 'fill' ? (accentOwners.has(part.owner) ? R.accent : look.groundAlt ?? R.ground) : 'none';
        const stroke = part.role === 'fill' ? 'none' : part.role === 'grid' ? R.dim : R.ink;
        svg.push(`<${pl.closed ? 'polygon' : 'polyline'} points="${pts(pl)}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeW}" stroke-linejoin="round"/>`);
      }
    } else {
      const b = part.box;
      const cell = cellOf(part.spec.size, viewport, look);
      const m = input.measure(part.text, part.spec, b.width);
      // the real type never goes below the look's own least size: the line the measurer gives is the truth
      const fs2 = cell.fontSize * (m.lineHeight / cell.height);
      if (part.plate) svg.push(`<rect x="${b.x + w / 2 - 2}" y="${b.y + h / 2 - 1}" width="${b.width + 4}" height="${b.height + 2}" fill="${R.ground}"/>`);
      const colour = part.role === 'tick' || part.role === 'label' || part.role === 'value' ? R.dim : R.ink;
      const anchor = part.align === 'center' ? 'middle' : part.align === 'right' ? 'end' : 'start';
      const ax = part.align === 'center' ? b.x + b.width / 2 : part.align === 'right' ? b.x + b.width : b.x;
      m.lines.forEach((line, i) => {
        svg.push(`<text x="${(ax + w / 2).toFixed(1)}" y="${(b.y + h / 2 + (i + 0.78) * m.lineHeight).toFixed(1)}" font-size="${fs2.toFixed(1)}" font-family="${family}" font-weight="${part.role === 'title' ? 600 : 400}" text-anchor="${anchor}" fill="${colour}">${esc(line.text)}</text>`);
      });
    }
  }
  svg.push('</svg>');
  const file = `${outDir.replace(/\/$/, '')}/${name}-${screen}.svg`;
  fs.writeFileSync(file, svg.join('\n'));
  process.stdout.write(`${file}  look ${lookId}  shrink ${layout.shrink.toFixed(2)}  notes ${layout.notes.map((n) => n.note).join('/') || '-'}  overlap ${audit.overlappingText} through ${audit.connectorsThroughNodes} crossed ${audit.crossedLabels} outside ${audit.outside}\n`);
}
