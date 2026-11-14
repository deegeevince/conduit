// The only module through which the library touches the file system: the seed
// techniques in the repository, an experiment's overlay, and the cache of the
// last good read of Remote.
//
// A seed or overlay file is markdown a person can write:
//
//   # <title>
//
//   summary: <one or two sentences that say when it applies; this is what a message is matched on>
//   reason: only if <when the link from the root is worth following>
//
//   <the body, laid out as `TechniqueBody` describes>

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTechniqueBody } from '../domain/techniques';
import type { Technique, TechniqueSource } from '../domain/techniques';

/** Reads one seed or overlay file. Null when it has no title: such a file is not a technique. */
export function readTechniqueFile(text: string, name: string, source: TechniqueSource): Technique | null {
  const lines = text.split('\n');
  const titleAt = lines.findIndex((line) => line.startsWith('# '));
  if (titleAt < 0) return null;
  const title = (lines[titleAt] ?? '').slice(2).trim();
  let summary = '';
  let reason = '';
  const body: string[] = [];
  for (const line of lines.slice(titleAt + 1)) {
    if (body.length === 0 && /^summary:/i.test(line)) summary = line.replace(/^summary:/i, '').trim();
    else if (body.length === 0 && /^reason:/i.test(line)) reason = line.replace(/^reason:/i, '').trim();
    else if (body.length > 0 || line.trim() !== '') body.push(line);
  }
  return { id: `${source}:${name}`, title, summary, reason, fingerprint: null, source, body: parseTechniqueBody(body.join('\n')) };
}

/** Every technique file in a folder, in name order. A folder that is not there holds none. */
export function readTechniqueDir(dir: string | null, source: TechniqueSource): Technique[] {
  if (dir === null || !existsSync(dir)) return [];
  const out: Technique[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.md')) continue;
    const technique = readTechniqueFile(readFileSync(join(dir, name), 'utf8'), name.replace(/\.md$/, ''), source);
    if (technique !== null) out.push(technique);
  }
  return out;
}

const CACHE_VERSION = 1;
const safeName = (id: string): string => id.replace(/[^A-Za-z0-9-]/g, '_');

/**
 * The last good read of Remote, one JSON file per technique, so that a
 * restart with Remote unreachable serves what it last knew. Reading is
 * forgiving to the last file: a missing folder, a half-written file, a file
 * of another version or one that is not a technique is skipped, never an
 * error, because the seed is always under it.
 */
export function readCache(dir: string): Technique[] {
  if (!existsSync(dir)) return [];
  const out: Technique[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      const technique = isCacheEntry(parsed) ? parsed.technique : null;
      if (technique !== null) out.push({ ...technique, source: 'cache' });
    } catch {
      // a torn or foreign file: the next refresh rewrites it
    }
  }
  return out;
}

function isCacheEntry(value: unknown): value is { v: number; technique: Technique } {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as { v?: unknown; technique?: unknown };
  if (entry.v !== CACHE_VERSION || typeof entry.technique !== 'object' || entry.technique === null) return false;
  const t = entry.technique as Partial<Technique>;
  const body = t.body as Partial<Technique['body']> | undefined;
  return typeof t.id === 'string' && typeof t.title === 'string' && typeof t.summary === 'string' && typeof t.reason === 'string' && body !== undefined && Array.isArray(body.example) && typeof body.purpose === 'string';
}

/**
 * Keeps what a refresh read. Never awaited by a turn; the caller logs a
 * failure and forgets it. A file is written to a temporary name and renamed,
 * so a reader (this process after a crash, or another one on the same folder)
 * never sees half a file, and only files whose content changed are touched.
 * A read of nothing prunes nothing: an empty index is more likely a fault
 * than a library that was emptied, and the cache is the thing that outlives
 * faults.
 */
export function writeCache(dir: string, techniques: readonly Technique[]): void {
  if (techniques.length === 0) return;
  mkdirSync(dir, { recursive: true });
  const keep = new Set<string>();
  for (const technique of techniques) {
    if (technique.source === 'seed' || technique.source === 'overlay') continue;
    const name = `${safeName(technique.id)}.json`;
    keep.add(name);
    const text = `${JSON.stringify({ v: CACHE_VERSION, technique: { ...technique, source: 'cache' } })}\n`;
    const path = join(dir, name);
    if (existsSync(path) && readFileSync(path, 'utf8') === text) continue;
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, text);
    renameSync(temporary, path);
  }
  for (const name of readdirSync(dir)) {
    if (name.endsWith('.json') && !keep.has(name)) rmSync(join(dir, name), { force: true });
    else if (name.endsWith('.tmp') && Date.now() - statSync(join(dir, name)).mtimeMs > 60_000) rmSync(join(dir, name), { force: true });
  }
}

/** A technique file as the writer needs it: the three header fields and the body, as markdown to store. Null when the file has no title. */
export function splitTechniqueFile(text: string): { title: string; summary: string; reason: string; markdown: string } | null {
  const lines = text.split('\n');
  const titleAt = lines.findIndex((line) => line.startsWith('# '));
  if (titleAt < 0) return null;
  let summary = '';
  let reason = '';
  const body: string[] = [];
  for (const line of lines.slice(titleAt + 1)) {
    if (body.length === 0 && /^summary:/i.test(line)) summary = line.replace(/^summary:/i, '').trim();
    else if (body.length === 0 && /^reason:/i.test(line)) reason = line.replace(/^reason:/i, '').trim();
    else if (body.length > 0 || line.trim() !== '') body.push(line);
  }
  return { title: (lines[titleAt] ?? '').slice(2).trim(), summary, reason, markdown: body.join('\n').trim() };
}
