const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', hellip: '...', lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', copy: '(c)', times: 'x', middot: '.', bull: '-', laquo: '"', raquo: '"', eacute: 'e', minus: '-',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

const DROPPED = ['script', 'style', 'noscript', 'svg', 'template', 'iframe', 'canvas', 'nav', 'footer', 'aside', 'form', 'select', 'button'];

function titleOf(html: string): string | null {
  const meta = /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i.exec(html) ?? /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title["']/i.exec(html);
  const tag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const raw = tag?.[1] ?? meta?.[1];
  const title = raw === undefined ? '' : decodeEntities(raw).replace(/\s+/g, ' ').trim();
  return title === '' ? null : title.slice(0, 200);
}

function mainPart(html: string): string {
  for (const tag of ['main', 'article']) {
    const open = new RegExp(`<${tag}[\\s>]`, 'i').exec(html);
    const close = html.toLowerCase().lastIndexOf(`</${tag}>`);
    if (open !== null && close > open.index && close - open.index > 1500) return html.slice(open.index, close);
  }
  return html;
}

const MAX_TABLE_ROWS = 200;
const MAX_TABLE_COLUMNS = 12;

/** The text of one cell: tags off, spaces collapsed, a bar escaped so it cannot split the cell. Entities are left for the page's one decoding pass. */
function cellText(html: string): string {
  return html.replace(/<(br|\/p|\/div|\/li)[^>]*>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().replace(/\|/g, '/');
}

/**
 * A data table as a Markdown table, header first, so that the figures in it
 * stay in their rows and columns and can be charted. A table that is page
 * layout (one column, a table inside it, or nothing but empty cells) is
 * flattened into its words instead.
 */
function markdownTable(inner: string): string | null {
  if (/<table[\s>]/i.test(inner)) return null;
  const rows: string[][] = [];
  for (const row of inner.split(/<tr[\s>]/i).slice(1)) {
    const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)(?=<\/t[dh]>|<t[dh][\s>]|<\/tr>|$)/gi)].map((cell) => cellText(cell[1] ?? ''));
    if (cells.some((cell) => cell !== '')) rows.push(cells);
    if (rows.length >= MAX_TABLE_ROWS) break;
  }
  const width = Math.min(MAX_TABLE_COLUMNS, Math.max(0, ...rows.map((row) => row.length)));
  if (rows.length < 2 || width < 2) return null;
  const line = (row: readonly string[]): string => `| ${Array.from({ length: width }, (_, at) => row[at] ?? '').join(' | ')} |`;
  return `\n\n${[line(rows[0] ?? []), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)].join('\n')}\n\n`;
}

const isItem = (line: string): boolean => line.startsWith('- ') && line.length < 45;

/** Long runs of short bullets with no sentences in them are menus, language lists and tag clouds, not the page. */
function withoutLinkFarms(lines: readonly string[]): string[] {
  const out: string[] = [];
  let at = 0;
  while (at < lines.length) {
    let end = at;
    while (end < lines.length && (isItem(lines[end] ?? '') || ((lines[end] ?? '') === '' && isItem(lines[end + 1] ?? '')))) end += 1;
    if (end - at >= 8) {
      at = end;
      continue;
    }
    out.push(lines[at] ?? '');
    at += 1;
  }
  return out.filter((line) => line !== '-' && line !== '|');
}

/** Headings and paragraphs of a page, as plain text with `#` headings: scripts, styles and page furniture dropped. */
export function textOfHtml(html: string): { readonly title: string | null; readonly text: string } {
  const title = titleOf(html);
  let body = html.replace(/<!--[\s\S]*?-->/g, ' ');
  body = body.replace(/<head[\s>][\s\S]*?<\/head>/i, ' ');
  for (const tag of DROPPED) body = body.replace(new RegExp(`<${tag}[\\s>][\\s\\S]*?</${tag}>`, 'gi'), ' ');
  body = mainPart(body);
  body = body.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (whole, inner: string) => markdownTable(inner) ?? whole);
  body = body
    .replace(/<h([1-6])[^>]*>/gi, (_, level: string) => `\n\n${'#'.repeat(Number(level))} `)
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<(br|hr)[^>]*>/gi, '\n')
    .replace(/<\/?(p|div|section|article|main|header|ul|ol|table|tr|blockquote|pre|figure|figcaption|dl|dt|dd)[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  const lines = decodeEntities(body)
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim());
  const kept: string[] = [];
  for (const line of withoutLinkFarms(lines)) {
    if (line === '' && kept.at(-1) === '') continue;
    if (line !== '' && line === kept.at(-1)) continue;
    kept.push(line);
  }
  return { title, text: kept.join('\n').trim() };
}

/**
 * Cuts at the end of a paragraph (or, failing that, a line) near `max`, so
 * the text does not stop mid-sentence or in the middle of a table, and says
 * where it stopped, in the text itself, so a reader of it cannot take it for
 * the whole.
 */
export function clampText(text: string, max: number): { readonly text: string; readonly truncated: boolean; readonly kept: number; readonly total: number } {
  if (text.length <= max) return { text, truncated: false, kept: text.length, total: text.length };
  const paragraph = text.lastIndexOf('\n\n', max);
  const line = text.lastIndexOf('\n', max);
  const cut = paragraph > max * 0.8 ? paragraph : line > max * 0.8 ? line : max;
  const kept = text.slice(0, cut).trimEnd();
  const missing = text.length - kept.length;
  return { text: `${kept}\n\n[The text is cut here: ${missing} more characters follow and are not shown, of ${text.length} in all.]`, truncated: true, kept: kept.length, total: text.length };
}
