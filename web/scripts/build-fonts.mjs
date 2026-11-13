// Builds every font file the app ships and the advance tables the painter measures with.
//
// For each face: the @fontsource file with its layout tables removed (see
// strip-font-tables.mjs), and for the proportional ones a generated module
// `src/fonts/metrics/<face>-<weight>.ts` holding the advance of every character
// of GLYPHS from the font's own cmap and hmtx. A face that lacks a character of
// GLYPHS fails the build: the text renderer would fetch a fallback font from a
// CDN for it.
//
// Run: pnpm --filter @conduit/web fonts      (output is byte-identical every time)

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTables } from './strip-font-tables.mjs';
import { GLYPHS } from '../src/fonts/glyphs.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = (pkg, file) => join(root, 'node_modules', '@fontsource', pkg, 'files', file);
const fonts = (...parts) => join(root, 'src', 'fonts', ...parts);

/**
 * `metrics`: the module name to generate (proportional faces and the mono one,
 * whose table proves it is fixed pitch), or null for faces that are measured
 * as `characters x advance`.
 */
const JOBS = [
  { pkg: 'vt323', from: source('vt323', 'vt323-latin-400-normal.woff'), to: fonts('vt323', 'vt323-fixed.ttf'), metrics: null },
  { pkg: 'doto', from: source('doto', 'doto-latin-700-normal.woff'), to: fonts('doto', 'doto-700-fixed.ttf'), metrics: null },
  { pkg: 'doto', from: source('doto', 'doto-latin-900-normal.woff'), to: fonts('doto', 'doto-900-fixed.ttf'), metrics: null },
  { pkg: 'bedstead', from: fonts('bedstead', 'bedstead.otf'), to: fonts('bedstead', 'bedstead-fixed.otf'), metrics: null },
  { pkg: 'source-serif-4', from: source('source-serif-4', 'source-serif-4-latin-400-normal.woff'), to: fonts('source-serif-4', 'source-serif-4-400-fixed.ttf'), metrics: 'serif-400' },
  { pkg: 'source-serif-4', from: source('source-serif-4', 'source-serif-4-latin-700-normal.woff'), to: fonts('source-serif-4', 'source-serif-4-700-fixed.ttf'), metrics: 'serif-700' },
  { pkg: 'inter', from: source('inter', 'inter-latin-400-normal.woff'), to: fonts('inter', 'inter-400-fixed.ttf'), metrics: 'sans-400' },
  { pkg: 'inter', from: source('inter', 'inter-latin-700-normal.woff'), to: fonts('inter', 'inter-700-fixed.ttf'), metrics: 'sans-700' },
  { pkg: 'caveat', from: source('caveat', 'caveat-latin-500-normal.woff'), to: fonts('caveat', 'caveat-500-fixed.ttf'), metrics: 'hand-500' },
  { pkg: 'caveat', from: source('caveat', 'caveat-latin-700-normal.woff'), to: fonts('caveat', 'caveat-700-fixed.ttf'), metrics: 'hand-700' },
  { pkg: 'archivo-black', from: source('archivo-black', 'archivo-black-latin-400-normal.woff'), to: fonts('archivo-black', 'archivo-black-400-fixed.ttf'), metrics: 'display-400' },
  { pkg: 'jetbrains-mono', from: source('jetbrains-mono', 'jetbrains-mono-latin-400-normal.woff'), to: fonts('jetbrains-mono', 'jetbrains-mono-400-fixed.ttf'), metrics: 'mono-400' },
  { pkg: 'jetbrains-mono', from: source('jetbrains-mono', 'jetbrains-mono-latin-700-normal.woff'), to: fonts('jetbrains-mono', 'jetbrains-mono-700-fixed.ttf'), metrics: 'mono-700' },
];

const LICENCES = {
  'source-serif-4': ['Source Serif 4', 'Copyright 2014 Adobe (http://www.adobe.com/), with Reserved Font Name "Source"'],
  inter: ['Inter', 'Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)'],
  caveat: ['Caveat', 'Copyright 2014 The Caveat Project Authors (https://github.com/googlefonts/caveat)'],
  'archivo-black': ['Archivo Black', 'Copyright 2017 The Archivo Black Project Authors (https://github.com/Omnibus-Type/ArchivoBlack)'],
  'jetbrains-mono': ['JetBrains Mono', 'Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)'],
};

function tablesOf(buffer) {
  const count = buffer.readUInt16BE(4);
  const tables = new Map();
  for (let i = 0; i < count; i += 1) {
    const record = 12 + i * 16;
    const offset = buffer.readUInt32BE(record + 8);
    const length = buffer.readUInt32BE(record + 12);
    tables.set(buffer.toString('latin1', record, record + 4), buffer.subarray(offset, offset + length));
  }
  return tables;
}

/** Map of code point to glyph index from the best Unicode subtable (format 12, else 4). */
function readCmap(cmap) {
  const count = cmap.readUInt16BE(2);
  let best = null;
  for (let i = 0; i < count; i += 1) {
    const platform = cmap.readUInt16BE(4 + i * 8);
    const encoding = cmap.readUInt16BE(6 + i * 8);
    const offset = cmap.readUInt32BE(8 + i * 8);
    const format = cmap.readUInt16BE(offset);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode || (format !== 4 && format !== 12)) continue;
    if (best === null || format > best.format) best = { offset, format };
  }
  if (best === null) throw new Error('no usable Unicode cmap');
  const glyphs = new Map();
  const at = best.offset;
  if (best.format === 12) {
    const groups = cmap.readUInt32BE(at + 12);
    for (let g = 0; g < groups; g += 1) {
      const base = at + 16 + g * 12;
      const first = cmap.readUInt32BE(base);
      const last = cmap.readUInt32BE(base + 4);
      const start = cmap.readUInt32BE(base + 8);
      for (let code = first; code <= last; code += 1) glyphs.set(code, start + code - first);
    }
    return glyphs;
  }
  const segments = cmap.readUInt16BE(at + 6) / 2;
  const ends = at + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const ranges = deltas + segments * 2;
  for (let s = 0; s < segments; s += 1) {
    const end = cmap.readUInt16BE(ends + s * 2);
    const start = cmap.readUInt16BE(starts + s * 2);
    const delta = cmap.readInt16BE(deltas + s * 2);
    const rangeOffset = cmap.readUInt16BE(ranges + s * 2);
    for (let code = start; code <= end && code !== 0xffff; code += 1) {
      let glyph;
      if (rangeOffset === 0) glyph = (code + delta) & 0xffff;
      else {
        const index = cmap.readUInt16BE(ranges + s * 2 + rangeOffset + (code - start) * 2);
        glyph = index === 0 ? 0 : (index + delta) & 0xffff;
      }
      if (glyph !== 0) glyphs.set(code, glyph);
    }
  }
  return glyphs;
}

function readMetrics(font, label) {
  const tables = tablesOf(font);
  const need = (tag) => {
    const table = tables.get(tag);
    if (table === undefined) throw new Error(`${label}: no ${tag} table`);
    return table;
  };
  const head = need('head');
  const hhea = need('hhea');
  const hmtx = need('hmtx');
  const upm = head.readUInt16BE(18);
  const hMetrics = hhea.readUInt16BE(34);
  const advanceOf = (glyph) => hmtx.readUInt16BE(Math.min(glyph, hMetrics - 1) * 4);
  const cmap = readCmap(need('cmap'));

  const advance = {};
  const missing = [];
  for (const char of GLYPHS) {
    const glyph = cmap.get(char.codePointAt(0));
    if (glyph === undefined) {
      missing.push(char);
      continue;
    }
    advance[char] = Number((advanceOf(glyph) / upm).toFixed(6));
  }
  if (missing.length > 0) throw new Error(`${label} has no glyph for ${JSON.stringify(missing.join(''))}: remove them from GLYPHS and give foldText a spelling for each`);

  const os2 = tables.get('OS/2');
  let xHeight = os2 !== undefined && os2.readUInt16BE(0) >= 2 ? os2.readInt16BE(86) / upm : 0;
  if (xHeight <= 0) xHeight = xGlyphHeight(tables, cmap, upm, label);
  return {
    advance,
    fallback: advance['?'],
    ascent: Number((hhea.readInt16BE(4) / upm).toFixed(6)),
    descent: Number((-hhea.readInt16BE(6) / upm).toFixed(6)),
    xHeight: Number(xHeight.toFixed(6)),
  };
}

/** The height of a lowercase x from the glyf outline, for a font whose OS/2 does not say. */
function xGlyphHeight(tables, cmap, upm, label) {
  const loca = tables.get('loca');
  const glyf = tables.get('glyf');
  const head = tables.get('head');
  const glyph = cmap.get('x'.codePointAt(0));
  if (loca === undefined || glyf === undefined || head === undefined || glyph === undefined) throw new Error(`${label}: cannot find an x-height`);
  const long = head.readInt16BE(50) === 1;
  const at = (i) => (long ? loca.readUInt32BE(i * 4) : loca.readUInt16BE(i * 2) * 2);
  return glyf.readInt16BE(at(glyph) + 8) / upm;
}

function metricsModule(label, from, m) {
  const rows = Object.entries(m.advance).map(([char, value]) => `    ${JSON.stringify(char)}: ${value},`);
  return [
    `// Generated by \`pnpm --filter @conduit/web fonts\` from ${from}. Never edited by hand.`,
    "import type { FaceMetrics } from '../faces';",
    '',
    `export const ${label}: FaceMetrics = {`,
    '  advance: {',
    ...rows,
    '  },',
    `  fallback: ${m.fallback},`,
    `  ascent: ${m.ascent},`,
    `  descent: ${m.descent},`,
    `  xHeight: ${m.xHeight},`,
    '};',
    '',
  ].join('\n');
}

mkdirSync(fonts('metrics'), { recursive: true });
for (const job of JOBS) {
  const { output, tags } = stripTables(readFileSync(job.from));
  mkdirSync(dirname(job.to), { recursive: true });
  writeFileSync(job.to, output);
  process.stdout.write(`${job.to.slice(root.length + 1)}: kept ${tags.join(' ')} (${output.length} bytes)\n`);
  if (job.metrics !== null) {
    const name = job.metrics.replace('-', '_').toUpperCase();
    const label = `${job.to.slice(root.length + 1)}`;
    writeFileSync(fonts('metrics', `${job.metrics}.ts`), metricsModule(name, label, readMetrics(output, label)));
  }
}

for (const [pkg, [family, copyright]] of Object.entries(LICENCES)) {
  const licence = join(root, 'node_modules', '@fontsource', pkg, 'LICENSE');
  if (!existsSync(licence)) throw new Error(`no licence for ${pkg}`);
  copyFileSync(licence, fonts(pkg, 'OFL.txt'));
  const files = JOBS.filter((job) => job.pkg === pkg).map((job) => job.to.split('/').pop());
  writeFileSync(
    fonts(pkg, 'NOTICE.txt'),
    `${family}, ${copyright}\nSIL Open Font License 1.1; the full text is in OFL.txt.\n\n${files.join(', ')} ${files.length === 1 ? 'is' : 'are'} the Latin subset from the @fontsource/${pkg} package with\nthe GPOS, GSUB, GDEF and kern tables removed, made by \`pnpm --filter @conduit/web fonts\`.\nThe glyphs are unchanged.\n`,
  );
}
