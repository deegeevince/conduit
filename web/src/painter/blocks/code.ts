// Code: a listing taken exactly (PLAN-v3-core 2.3, PC10). Every row is one line of source as the brain wrote it, indentation and all; the panel is
// a tinted ground in a frame, set in a monospaced face (the look's own when it is a fixed-pitch machine), a title and the file or language above a
// hairline, and the rows below it, each word coloured by what the tokenizer takes it for (code-lex.ts: reserved words in the accent, strings and
// numbers in the alt, comments dim).
//
// A row is set as separate stretches of text, each at its own column: the painter's text setter folds indentation and runs of spaces, and a column
// is exact in a fixed-pitch face. The parts are named `l:<row>:<column>`; the text layer reads a row back from them, spaces and all.
//
// Nothing here scrolls. Where the room is too small for the longest line at the least size the look sets type at, the line is cut with an ellipsis; where
// it is too short for the rows, the rows that fit are drawn and the last line says how many more there are. Both are `crowded`.

import type { BlockPart, StructureInput, StructureLayout, TextSpec } from '../../contracts/blocks';
import type { Box } from '../../contracts/space';
import { lexCode } from './code-lex';
import type { Token } from './code-lex';
import { box, open, roundedRect } from './geom';
import type { Draft } from './kit';
import { Env, fit } from './kit';

/** Tabs are set to this many columns. */
const TAB = 4;

/** The name of a row's stretch of text, which the text layer reads a code line back from. */
export const codePart = (row: number, column: number): string => `l:${row}:${column}`;
export const CODE_PART = /^l:(\d+):(\d+)$/;

/** The rows of a code block as source: tabs set, the ends trimmed, nothing else touched. */
export function sourceOf(structure: StructureInput['structure'], count?: number): string[] {
  const figure = structure.figure;
  if (figure?.kind !== 'structure') return [];
  return (count === undefined ? figure.rows : figure.rows.slice(0, count)).map((row) => (row.cells[0] ?? '').replace(/\t/g, ' '.repeat(TAB)).replace(/\s+$/, ''));
}

interface Piece {
  readonly column: number;
  readonly text: string;
  readonly tone: Token['tone'];
}

/** A row's stretches of text, each a run of words one space apart in one tone, and none longer than a line of the face may be. */
function piecesOf(line: string, tokens: readonly Token[], longest: number): Piece[] {
  const out: Piece[] = [];
  for (const token of tokens) {
    const text = line.slice(token.from, token.to);
    for (const found of text.matchAll(/\S+(?: \S+)*/g)) {
      const word = found[0];
      for (let at = 0; at < word.length; at += longest) out.push({ column: token.from + (found.index ?? 0) + at, text: word.slice(at, at + longest), tone: token.tone });
    }
  }
  return out;
}

/**
 * What the stage plan reserves for a listing before the look's face is measured: a monospaced line is about 0.6 em across and 1.4 em tall, and the panel
 * is set at the least 0.7 of its natural size before a line is cut. `fontPx` is the em of the size a listing is set at, in the units of the plan.
 */
export function codeSizes(structure: StructureInput['structure'], fontPx: number): { readonly natural: { readonly width: number; readonly height: number }; readonly least: { readonly width: number; readonly height: number } } {
  const figure = structure.figure;
  const lines = sourceOf(structure);
  const columns = lines.reduce((most, line) => Math.max(most, line.length), 0);
  const headed = structure.text.trim() !== '' || (figure?.kind === 'structure' && (figure.file != null || figure.lang != null));
  const pad = fontPx * 1.2;
  const width = Math.min(1100, Math.max(280, columns * fontPx * 0.6 + pad * 2));
  const height = Math.min(1500, (headed ? fontPx * 2 : 0) + Math.max(1, lines.length) * fontPx * 1.4 + pad);
  return { natural: { width, height }, least: { width: Math.max(200, width * 0.7), height: Math.max(80, height * 0.7) } };
}

export function layoutCode(input: StructureInput): StructureLayout {
  return fit(input, input.look.stroke, (env) => buildCode(env));
}

function buildCode(env: Env): Draft {
  const input = env.input;
  const structure = input.structure;
  const key = structure.key;
  const figure = structure.figure?.kind === 'structure' ? structure.figure : null;
  const room = input.room;
  const body = env.body;
  const lines = sourceOf(structure);
  const lang = figure?.lang ?? null;
  const file = figure?.file ?? null;

  // the face: a monospaced one, unless the look is already a fixed-pitch machine on a grid of its own
  const face = env.grid === null ? ('mono' as const) : null;
  const size = structure.style.size === 'm' ? ('s' as const) : structure.style.size;
  const spec: TextSpec = { ...env.spec, size, weight: 'normal', face };
  const probe = input.measure('n'.repeat(400), spec, 1e9);
  const probed = probe.lines[0]?.text.length ?? 40;
  const cw = probe.width / Math.max(1, probed);
  const lineH = probe.lineHeight;
  // the most characters the setter puts on a line: a stretch of text is never longer, or it would be folded
  const longest = Math.max(8, Math.min(48, probed - 1));
  const pad = env.up(body * 0.7, 'x');
  const padY = env.up(body * 0.5, 'y');

  // the head: the title large, the file (or else the language) small at its right, a hairline under
  const title = structure.text.trim();
  const metaText = file ?? (lang === null ? '' : lang);
  const metaSpec: TextSpec = { ...spec, size: 'xs' };
  const metaM = metaText === '' ? null : input.measure(metaText, metaSpec, 1e9);
  const titleSpec: TextSpec = { ...env.spec, size: 'm', weight: 'bold' };
  const inner = Math.max(body * 6, room.width - 2 * pad);
  const titleM = title === '' ? null : input.measure(title, titleSpec, Math.max(body * 6, inner - (metaM === null ? 0 : metaM.width + body)));
  const together = titleM !== null && metaM !== null && titleM.width + metaM.width + body <= inner;
  const headTop = titleM === null ? 0 : titleM.height;
  const headH =
    titleM === null && metaM === null ? 0 : env.up(titleM !== null ? headTop + (metaM !== null && !together ? metaM.height : 0) + body * 0.5 : (metaM?.height ?? 0) + body * 0.4, 'y');

  // what the room can hold at the least size the look sets type at: past it, lines are cut and rows are left for "more"
  const least = env.shrink <= input.look.minShrink + 1e-6;
  const fitCols = Math.max(4, Math.floor((room.width - 2 * pad) / cw + 1e-6));
  const fitRows = Math.max(1, Math.floor((room.height - headH - 2 * padY) / lineH + 1e-6));
  const widest = lines.reduce((most, line) => Math.max(most, line.length), 0);
  const cutCols = least && widest > fitCols;
  const cutRows = least && lines.length > fitRows;
  const shown = cutRows ? Math.max(1, fitRows - 1) : lines.length;
  const cols = cutCols ? fitCols : widest;
  const rows = Math.max(1, shown + (cutRows ? 1 : 0));

  const headNeed = Math.max(titleM !== null && !together ? titleM.width : (titleM?.width ?? 0) + (together && metaM !== null ? metaM.width + body : 0), titleM === null ? (metaM?.width ?? 0) : 0);
  const width = env.up(Math.max(cols * cw, headNeed, body * 8) + 2 * pad, 'x');
  const height = env.up(headH + rows * lineH + 2 * padY, 'y');

  const finish = (rm: Box): ReturnType<Draft['finish']> => {
    const x0 = env.within(rm.x + Math.max(0, (rm.width - width) / 2), rm.x, rm.x + Math.max(0, rm.width - width), 'x');
    const y0 = env.snap(rm.y, 'y');
    const panel = box(x0, y0, width, height);
    const parts: BlockPart[] = [];
    const radius = input.look.radius;
    parts.push({ kind: 'shape', owner: key, part: 'panel', outline: [roundedRect(panel, radius)], role: 'fill' });
    parts.push({ kind: 'shape', owner: key, part: 'frame', outline: [roundedRect(panel, radius)], role: 'frame' });
    const left = x0 + pad;
    let top = y0 + padY;
    if (titleM !== null) parts.push({ kind: 'text', owner: key, part: 'title', text: title, emphasis: [], box: box(left, top, titleM.width, titleM.height), spec: titleSpec, align: 'left', role: 'title', plate: false });
    if (metaM !== null && metaText !== '') {
      const at = together ? box(x0 + width - pad - metaM.width, top + Math.max(0, (titleM?.height ?? 0) - metaM.height), metaM.width, metaM.height) : box(left, top + (titleM?.height ?? 0), metaM.width, metaM.height);
      parts.push({ kind: 'text', owner: key, part: 'meta', text: metaText, emphasis: [], box: at, spec: metaSpec, align: 'left', role: 'value', plate: false });
    }
    if (headH > 0) {
      const under = y0 + padY + headH - body * 0.2;
      parts.push({ kind: 'shape', owner: key, part: 'rule', outline: [open([{ x: x0, y: under }, { x: x0 + width, y: under }])], role: 'grid' });
    }
    top = y0 + padY + headH;

    const tokens = lexCode(lang, lines);
    const visible = lines.slice(0, shown);
    visible.forEach((line, index) => {
      const row = index;
      const y = top + index * lineH;
      let made = piecesOf(line, tokens[index] ?? [], longest);
      if (cutCols && line.length > cols) {
        // cut where the room ends, and say so: an ellipsis in the last column
        made = made.flatMap((piece) => {
          if (piece.column >= cols - 1) return [];
          return piece.column + piece.text.length > cols - 1 ? [{ ...piece, text: piece.text.slice(0, cols - 1 - piece.column) }] : [piece];
        });
        made.push({ column: cols - 1, text: '…', tone: 'comment' });
      }
      for (const piece of made) {
        const w = piece.text.length * cw;
        parts.push({
          kind: 'text',
          owner: key,
          part: codePart(row, piece.column),
          text: piece.text,
          emphasis: [],
          box: box(env.snap(left + piece.column * cw, 'x'), y, w + cw * 0.5, lineH),
          spec,
          align: 'left',
          role: 'code',
          tone: piece.tone,
          row,
          plate: false,
        });
      }
    });
    if (cutRows) {
      const more = lines.length - shown;
      const text = `… ${more} more line${more === 1 ? '' : 's'}`;
      parts.push({ kind: 'text', owner: key, part: 'more', text, emphasis: [], box: box(left, top + shown * lineH, (text.length + 1) * cw, lineH), spec, align: 'left', role: 'value', row: Math.min(lines.length - 1, shown), plate: false });
    }
    const boxes = new Map<string, Box>([[key, panel]]);
    return { parts, boxes, routes: new Map(), notes: cutCols || cutRows ? [{ key, note: 'crowded' as const }] : [] };
  };
  return { width, height, finish };
}
