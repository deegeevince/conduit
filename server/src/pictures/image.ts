// Knowing a picture by its bytes, and making it safe: identify, measure, re-encode, strip.

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PICTURE_LIMITS } from '../domain/pictures';

export type Sniffed = { readonly format: 'jpeg' | 'png' | 'webp'; readonly width: number; readonly height: number; readonly orientation: number };

const u16 = (b: Uint8Array, at: number): number => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
const u32 = (b: Uint8Array, at: number): number => ((b[at] ?? 0) * 2 ** 24) + (((b[at + 1] ?? 0) << 16) | ((b[at + 2] ?? 0) << 8) | (b[at + 3] ?? 0));
const le24 = (b: Uint8Array, at: number): number => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16);
const ascii = (b: Uint8Array, at: number, n: number): string => String.fromCharCode(...b.subarray(at, at + n));

/** EXIF orientation (1 to 8) from a JPEG's APP1, 1 when absent. */
function exifOrientation(b: Uint8Array): number {
  let at = 2;
  while (at + 4 < b.length) {
    if (b[at] !== 0xff) return 1;
    const marker = b[at + 1] ?? 0;
    if (marker === 0xda || marker === 0xd9) return 1;
    const length = u16(b, at + 2);
    if (marker === 0xe1 && ascii(b, at + 4, 6) === 'Exif\0\0') {
      const base = at + 10;
      const little = ascii(b, base, 2) === 'II';
      const r16 = (o: number): number => (little ? (b[base + o] ?? 0) | ((b[base + o + 1] ?? 0) << 8) : u16(b, base + o));
      const r32 = (o: number): number => (little ? (r16(o) | (r16(o + 2) << 16)) >>> 0 : u32(b, base + o));
      const entries = r16(r32(4));
      for (let i = 0; i < Math.min(entries, 64); i++) {
        const entry = r32(4) + 2 + i * 12;
        if (r16(entry) === 0x0112) {
          const value = r16(entry + 8);
          return value >= 1 && value <= 8 ? value : 1;
        }
      }
      return 1;
    }
    at += 2 + length;
  }
  return 1;
}

/** What the bytes are, by their content and not by what anyone said they were; null for anything else (svg, gif, html, ...). */
export function sniff(b: Uint8Array): Sniffed | null {
  if (b.length < 32) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let at = 2;
    while (at + 9 < b.length) {
      if (b[at] !== 0xff) {
        at += 1;
        continue;
      }
      const marker = b[at + 1] ?? 0;
      if (marker === 0xff) {
        at += 1;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        at += 2;
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const height = u16(b, at + 5);
        const width = u16(b, at + 7);
        return width > 0 && height > 0 ? { format: 'jpeg', width, height, orientation: exifOrientation(b) } : null;
      }
      at += 2 + u16(b, at + 2);
    }
    return null;
  }
  if (ascii(b, 1, 3) === 'PNG' && b[0] === 0x89 && ascii(b, 12, 4) === 'IHDR') {
    const width = u32(b, 16);
    const height = u32(b, 20);
    return width > 0 && height > 0 ? { format: 'png', width, height, orientation: 1 } : null;
  }
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
    const kind = ascii(b, 12, 4);
    let width = 0;
    let height = 0;
    if (kind === 'VP8X') {
      width = le24(b, 24) + 1;
      height = le24(b, 27) + 1;
    } else if (kind === 'VP8L') {
      const bits = (b[21] ?? 0) | ((b[22] ?? 0) << 8) | ((b[23] ?? 0) << 16) | ((b[24] ?? 0) << 24);
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
    } else if (kind === 'VP8 ') {
      width = ((b[26] ?? 0) | ((b[27] ?? 0) << 8)) & 0x3fff;
      height = ((b[28] ?? 0) | ((b[29] ?? 0) << 8)) & 0x3fff;
    }
    return width > 0 && height > 0 ? { format: 'webp', width, height, orientation: 1 } : null;
  }
  return null;
}

/**
 * Drops every metadata segment of a JPEG: EXIF, XMP, IPTC, comments, thumbnails, maker notes. What stays is what is
 * needed to draw it: JFIF, the ICC colour profile, the tables, the frame and the scan.
 */
export function stripJpeg(b: Uint8Array): Uint8Array {
  const out: Uint8Array[] = [b.subarray(0, 2)];
  let at = 2;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) throw new Error('jpeg: marker expected');
    const marker = b[at + 1] ?? 0;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0xd9) {
      out.push(b.subarray(at));
      return concat(out);
    }
    const length = u16(b, at + 2);
    const segment = b.subarray(at, at + 2 + length);
    if (marker === 0xda) {
      out.push(b.subarray(at));
      return concat(out);
    }
    const keep = !(marker >= 0xe0 && marker <= 0xef) && marker !== 0xfe ? true : (marker === 0xe0 && ascii(b, at + 4, 5) === 'JFIF\0') || (marker === 0xe2 && ascii(b, at + 4, 12) === 'ICC_PROFILE\0');
    if (keep) out.push(segment);
    at += 2 + length;
  }
  throw new Error('jpeg: no scan');
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function run(bin: string, args: readonly string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(bin, [...args], { timeout: timeoutMs, maxBuffer: 1 << 20 }, (error) => (error ? reject(error) : resolve()));
  });
}

/** Re-encodes and crops. A port, because the decoder is the machine's own; `sips` is macOS's. */
export interface Reencoder {
  readonly id: string;
  /** `bytes` are already sniffed and within the pixel limit; the result is a metadata-free JPEG no larger than `maxSide`, cropped to `aspect` when given. */
  reencode(bytes: Uint8Array, sniffed: Sniffed, aspect: number | null): Promise<Uint8Array>;
}

const ROTATE: Readonly<Record<number, number>> = { 3: 180, 6: 90, 8: 270 };

/** True for a HEIC or HEIF file (what an iPhone's camera makes): an ISO base media `ftyp` box whose brand is one of the HEIF family. */
export function isHeic(b: Uint8Array): boolean {
  if (b.length < 32 || ascii(b, 4, 4) !== 'ftyp') return false;
  const brands = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1']);
  const end = Math.min(b.length, 8 + u32(b, 0), 64);
  for (let at = 8; at + 4 <= end; at += 4) if (brands.has(ascii(b, at, 4))) return true;
  return false;
}

/** HEIC to a JPEG, by the machine's own decoder (`sips`). The result may still carry metadata; `Reencoder.reencode` strips it. */
export async function heicToJpeg(bytes: Uint8Array): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), 'conduit-heic-'));
  try {
    await writeFile(join(dir, 'in.heic'), bytes);
    await run('/usr/bin/sips', ['-s', 'format', 'jpeg', join(dir, 'in.heic'), '--out', join(dir, 'out.jpg')], 30_000);
    return new Uint8Array(await readFile(join(dir, 'out.jpg')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** macOS's `sips`: decode, rotate upright, shrink, re-encode as JPEG, crop to the box. Files live in a fresh temp directory and are removed. */
export function sipsReencoderFor(settings: { readonly maxSide: number; readonly quality: number }): Reencoder {
  return {
    id: 'sips',
    async reencode(bytes, sniffed, aspect) {
      const dir = await mkdtemp(join(tmpdir(), 'conduit-picture-'));
      try {
        const input = join(dir, `in.${sniffed.format === 'jpeg' ? 'jpg' : sniffed.format}`);
        const mid = join(dir, 'mid.jpg');
        const out = join(dir, 'out.jpg');
        await writeFile(input, bytes);
        const args = ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(settings.quality)];
        const turn = ROTATE[sniffed.orientation];
        if (turn !== undefined) args.push('-r', String(turn));
        if (Math.max(sniffed.width, sniffed.height) > settings.maxSide) args.push('-Z', String(settings.maxSide));
        await run('/usr/bin/sips', [...args, input, '--out', mid], 30_000);
        const shrunk = sniff(new Uint8Array(await readFile(mid)));
        if (shrunk === null || shrunk.format !== 'jpeg') throw new Error('sips made no jpeg');
        let final = mid;
        if (aspect !== null && Number.isFinite(aspect) && aspect > 0) {
          const have = shrunk.width / shrunk.height;
          if (Math.abs(Math.log(have / aspect)) > 0.05) {
            const width = have > aspect ? Math.round(shrunk.height * aspect) : shrunk.width;
            const height = have > aspect ? shrunk.height : Math.round(shrunk.width / aspect);
            await run('/usr/bin/sips', ['-c', String(Math.max(1, height)), String(Math.max(1, width)), mid, '--out', out], 30_000);
            final = out;
          }
        }
        const done = new Uint8Array(await readFile(final));
        const check = sniff(done);
        if (check === null || check.format !== 'jpeg') throw new Error('output is not a jpeg');
        return stripJpeg(done);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

export const sipsReencoder: Reencoder = sipsReencoderFor({ maxSide: PICTURE_LIMITS.maxSide, quality: PICTURE_LIMITS.jpegQuality });

/**
 * Crops an upright JPEG to a rectangle given as fractions of its width and height (`x`, `y` from the top left), by `sips`, and strips
 * the result again. The caller has checked the rectangle.
 */
export async function cropJpeg(bytes: Uint8Array, crop: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }): Promise<Uint8Array> {
  const seen = sniff(bytes);
  if (seen === null || seen.format !== 'jpeg') throw new Error('crop: not a jpeg');
  const left = Math.min(seen.width - 1, Math.max(0, Math.round(crop.x * seen.width)));
  const top = Math.min(seen.height - 1, Math.max(0, Math.round(crop.y * seen.height)));
  const width = Math.max(1, Math.min(seen.width - left, Math.round(crop.w * seen.width)));
  const height = Math.max(1, Math.min(seen.height - top, Math.round(crop.h * seen.height)));
  const dir = await mkdtemp(join(tmpdir(), 'conduit-crop-'));
  try {
    await writeFile(join(dir, 'in.jpg'), bytes);
    await run('/usr/bin/sips', ['-c', String(height), String(width), '--cropOffset', String(top), String(left), join(dir, 'in.jpg'), '--out', join(dir, 'out.jpg')], 30_000);
    const done = new Uint8Array(await readFile(join(dir, 'out.jpg')));
    const check = sniff(done);
    if (check === null || check.format !== 'jpeg') throw new Error('crop: output is not a jpeg');
    return stripJpeg(done);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** For machines with no decoder: nothing is stored, because a file that was not re-encoded is not safe to keep. */
export const NO_REENCODER: Reencoder = { id: 'none', reencode: () => Promise.reject(new Error('no image re-encoder on this machine')) };
