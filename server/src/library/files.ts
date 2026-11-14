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

import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

/** STUB (PLAN-v2.md, package S2): the last good read of Remote, kept as one JSON file per technique so that a restart with Remote unreachable serves what it last knew. */
export function readCache(dir: string): Technique[] {
  void dir;
  return [];
}

/** STUB (package S2): writes what a refresh read. Never awaited by a turn; a failure is logged and forgotten. */
export function writeCache(dir: string, techniques: readonly Technique[]): void {
  void dir;
  void techniques;
}
