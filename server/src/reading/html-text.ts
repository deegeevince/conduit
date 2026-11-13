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

/** Cuts at a line end near `max` so the text does not stop mid-sentence. */
export function clampText(text: string, max: number): { readonly text: string; readonly truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const cut = text.lastIndexOf('\n', max);
  return { text: text.slice(0, cut > max * 0.8 ? cut : max).trimEnd(), truncated: true };
}
