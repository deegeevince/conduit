// Rebuilds an OpenType font without its layout tables (GPOS, GSUB, GDEF, kern).
//
// Why: the WebGL text renderer applies every GPOS positioning lookup it finds,
// whatever feature it belongs to. Bedstead carries proportional-spacing
// adjustments there, which silently turn a fixed-pitch face into a
// proportional one and break the character grid every look is laid out on.
//
// The same lookups carry the fi/fl/ff ligatures in VT323, which merge two
// cells into one.
//
// Reads .otf, .ttf or .woff; always writes a plain .otf/.ttf.
// Usage: node scripts/strip-font-tables.mjs <in> <out>     (pnpm --filter @conduit/web fonts runs it for every face)

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';

/** `kern` is the old spelling of pair kerning: the same break of the character grid, in a table of its own. */
const DROP = new Set(['GPOS', 'GSUB', 'GDEF', 'kern']);

function checksum(buffer) {
  let sum = 0;
  const padded = Buffer.concat([buffer, Buffer.alloc((4 - (buffer.length % 4)) % 4)]);
  for (let i = 0; i < padded.length; i += 4) sum = (sum + padded.readUInt32BE(i)) >>> 0;
  return sum;
}

/** Rebuilds a .otf, .ttf or .woff without its layout tables. Pure and deterministic: the same bytes in give the same bytes out. */
export function stripTables(input) {
  const isWoff = input.toString('latin1', 0, 4) === 'wOFF';
  /** the sfnt version tag: 'OTTO' for CFF outlines, 0x00010000 for TrueType */
  const flavour = isWoff ? input.subarray(4, 8) : input.subarray(0, 4);
  const tableCount = input.readUInt16BE(isWoff ? 12 : 4);
  const kept = [];
  for (let i = 0; i < tableCount; i += 1) {
    const record = isWoff ? 44 + i * 20 : 12 + i * 16;
    const tag = input.toString('latin1', record, record + 4);
    if (DROP.has(tag)) continue;
    if (isWoff) {
      const offset = input.readUInt32BE(record + 4);
      const compressed = input.readUInt32BE(record + 8);
      const original = input.readUInt32BE(record + 12);
      const slice = input.subarray(offset, offset + compressed);
      kept.push({ tag, data: Buffer.from(compressed === original ? slice : inflateSync(slice)) });
    } else {
      const offset = input.readUInt32BE(record + 8);
      const length = input.readUInt32BE(record + 12);
      kept.push({ tag, data: Buffer.from(input.subarray(offset, offset + length)) });
    }
  }

  const head = kept.find((table) => table.tag === 'head');
  if (head === undefined) throw new Error('not a font: no head table');
  head.data.writeUInt32BE(0, 8);

  const entrySelector = Math.floor(Math.log2(kept.length));
  const searchRange = 2 ** entrySelector * 16;
  const header = Buffer.alloc(12 + kept.length * 16);
  flavour.copy(header, 0, 0, 4);
  header.writeUInt16BE(kept.length, 4);
  header.writeUInt16BE(searchRange, 6);
  header.writeUInt16BE(entrySelector, 8);
  header.writeUInt16BE(kept.length * 16 - searchRange, 10);

  let offset = header.length;
  const bodies = [];
  let headOffset = 0;
  kept.forEach((table, index) => {
    const record = 12 + index * 16;
    header.write(table.tag, record, 'latin1');
    header.writeUInt32BE(checksum(table.data), record + 4);
    header.writeUInt32BE(offset, record + 8);
    header.writeUInt32BE(table.data.length, record + 12);
    if (table.tag === 'head') headOffset = offset;
    const padded = Buffer.concat([table.data, Buffer.alloc((4 - (table.data.length % 4)) % 4)]);
    bodies.push(padded);
    offset += padded.length;
  });

  const output = Buffer.concat([header, ...bodies]);
  output.writeUInt32BE((0xb1b0afba - checksum(output)) >>> 0, headOffset + 8);
  return { output, tags: kept.map((table) => table.tag.trim()) };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , inputPath, outputPath] = process.argv;
  if (inputPath === undefined || outputPath === undefined) {
    process.stderr.write('usage: node scripts/strip-font-tables.mjs <in> <out>     (pnpm --filter @conduit/web fonts runs build-fonts.mjs, which does this for every face)\n');
    process.exit(1);
  }
  const { output, tags } = stripTables(readFileSync(inputPath));
  writeFileSync(outputPath, output);
  process.stdout.write(`${outputPath}: kept ${tags.join(' ')} (${output.length} bytes)\n`);
}
