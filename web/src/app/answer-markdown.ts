// "Copy answer": what is on the stage, as Markdown. Headings are headings, a table is a table, code is fenced, a list is a list; a choice is left out
// (it is a question put to the reader, not a part of the answer) and so is anything that is only there to be touched. Pure: the text layer's spans in,
// text out. The words come from the same spans the layer lays over the picture, so what is copied is what was drawn.

import { ownerKeyOf } from '../contracts/text-layer';
import type { TextSpanView } from '../contracts/text-layer';

const BULLET = /^\s*([-*•–—▪◦·])\s+(.*)$/;
const NUMBERED = /^\s*(\d{1,3})[.)]\s+(.*)$/;

/** a cell of a table: one line, with the bar that would end it written out */
const cellOf = (text: string): string => text.replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim();

function tableOf(cells: readonly TextSpanView[], labels: readonly TextSpanView[]): string {
  const rows = new Map<number, Map<number, string>>();
  for (const cell of cells) {
    const at = cell.within;
    if (at === null) continue;
    const row = rows.get(at.row) ?? new Map<number, string>();
    row.set(at.column, cell.text);
    rows.set(at.row, row);
  }
  const order = [...rows.keys()].sort((a, b) => a - b);
  if (labels.length > 0) {
    // narrow rooms set a table as records: the first column names the record, the others carry their column's name beside the value
    const named = new Map<string, string>();
    for (const label of labels) if (label.within !== null) named.set(`${label.within.row}:${label.within.column}`, label.text);
    return order
      .map((r) => {
        const row = rows.get(r) as Map<number, string>;
        const first = row.get(0);
        const rest = [...row.keys()]
          .filter((c) => c !== 0)
          .sort((a, b) => a - b)
          .map((c) => `${named.get(`${r}:${c}`) ?? ''}${named.has(`${r}:${c}`) ? ': ' : ''}${row.get(c)}`);
        return `- ${first === undefined ? '' : `**${first}**${rest.length > 0 ? ' - ' : ''}`}${rest.join('; ')}`;
      })
      .join('\n');
  }
  const width = Math.max(1, ...order.map((r) => Math.max(...[...(rows.get(r) as Map<number, string>).keys()].map((c) => c + 1))));
  const line = (r: number): string => `| ${Array.from({ length: width }, (_, c) => cellOf((rows.get(r) as Map<number, string>).get(c) ?? '')).join(' | ')} |`;
  const [head, ...body] = order;
  if (head === undefined) return '';
  return [line(head), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...body.map(line)].join('\n');
}

/** A chart's rows are a table too, its first row the header only when it is not a number. */
function chartTableOf(cells: readonly TextSpanView[]): string {
  const first = cells.filter((cell) => cell.within?.row === 0);
  const numeric = (text: string): boolean => /^[\s$£€+-]*[\d.,]+\s*[%a-zA-Z]{0,3}$/.test(text);
  const hasHeader = first.length > 1 && !numeric(first[first.length - 1]?.text ?? '');
  if (hasHeader) return tableOf(cells, []);
  const shifted = cells.map((cell) => ({ ...cell, within: cell.within === null ? null : { ...cell.within, row: cell.within.row + 1 } }));
  const width = Math.max(1, ...cells.map((cell) => (cell.within?.column ?? 0) + 1));
  const blank: TextSpanView[] = Array.from({ length: width }, (_, column) => ({ ...(cells[0] as TextSpanView), text: '', within: { key: cells[0]?.within?.key ?? '', row: 0, column } }));
  return tableOf([...blank, ...shifted], []);
}

/** What a span belongs to when it is part of a structure: the structure itself, whoever owns the part. */
const groupOf = (span: TextSpanView): string => span.within?.key ?? ownerKeyOf(span.key);

/** The stage's words as Markdown. Empty when there are none. */
export function answerMarkdown(spans: readonly TextSpanView[]): string {
  const blocks: string[] = [];
  let list: string[] = [];
  const flush = (): void => {
    if (list.length > 0) blocks.push(list.join('\n'));
    list = [];
  };
  const taken = new Set<TextSpanView>();
  for (const span of spans) {
    if (taken.has(span) || span.role === 'choice') continue;
    if (span.role === 'heading') {
      flush();
      blocks.push(`${'#'.repeat(Math.min(6, Math.max(1, span.level)))} ${span.text}`);
      continue;
    }
    if (span.structure !== null) {
      // everything one structure owns, together, wherever in the order its parts fall
      flush();
      const id = groupOf(span);
      const group = spans.filter((other) => !taken.has(other) && other.structure !== null && groupOf(other) === id && other.role !== 'choice' && other.role !== 'heading');
      for (const other of group) taken.add(other);
      if (span.structure === 'table' || span.structure === 'chart') {
        const cells = group.filter((s) => s.role === 'cell');
        const labels = group.filter((s) => s.role === 'label' && s.within !== null && s.within.row >= 0);
        const text = span.structure === 'chart' ? chartTableOf(cells) : tableOf(cells, labels);
        if (text !== '') blocks.push(text);
      } else if (span.structure === 'code') {
        const lang = group.find((s) => s.lang !== null)?.lang ?? '';
        blocks.push(`\`\`\`${lang}\n${group.map((s) => s.text).join('\n')}\n\`\`\``);
      } else if (span.structure === 'screen') {
        const words = group.map((s) => s.text);
        if (words.length > 0) blocks.push(`> Mock-up:\n${words.map((word) => `> - ${word}`).join('\n')}`);
      } else {
        // a diagram: its parts, in the order they were written, as a list, and then what labels its links
        const parts = group.filter((s) => s.role === 'node').map((s) => `- ${s.text}`);
        if (parts.length > 0) blocks.push(parts.join('\n'));
        const links = group.filter((s) => s.role !== 'node' && s.role !== 'cell').map((s) => s.text);
        if (links.length > 0) blocks.push(`Links: ${links.join(', ')}`);
      }
      continue;
    }
    if (span.role === 'control') continue;
    const bullet = BULLET.exec(span.text);
    const numbered = NUMBERED.exec(span.text);
    if (bullet !== null || numbered !== null) list.push(bullet !== null ? `- ${bullet[2]}` : `${numbered?.[1]}. ${numbered?.[2]}`);
    else {
      flush();
      blocks.push(span.text);
    }
  }
  flush();
  return `${blocks.join('\n\n')}${blocks.length > 0 ? '\n' : ''}`;
}
