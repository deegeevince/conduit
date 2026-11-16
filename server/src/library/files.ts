// The only module through which the library touches the file system: the seed
// techniques in the repository and an experiment's overlay.
//
// A seed or overlay file is markdown a person can write:
//
//   # <title>
//
//   summary: <one or two sentences that say when it applies; this is what a message is matched on>
//   reason: only if <when the link from the root is worth following>
//
//   <the body, laid out as `TechniqueBody` describes>

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  return { id: `${source}:${name}`, title, summary, reason, source, body: parseTechniqueBody(body.join('\n')) };
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

/** A technique file split into its three header fields and its body, as markdown. Null when the file has no title. */
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

/**
 * Writes a proposed technique into `dir` as a file a person can read and move into the seed. Never overwrites: a proposal that is
 * already there (the same title) is left as it is and reported as such.
 */
export function writeProposedFile(dir: string, draft: { title: string; summary: string; reason: string; markdown: string }): { path: string; written: boolean } {
  const stem = draft.title.replace(/^proposed technique:\s*/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'proposal';
  const path = join(dir, `${stem}.md`);
  if (existsSync(path)) return { path, written: false };
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `# ${draft.title}\n\nsummary: ${draft.summary}\nreason: ${draft.reason}\n\n${draft.markdown.trim()}\n`);
  return { path, written: true };
}
