// The owner's skill library, read only (PLAN-skills section 1). A skill is a folder holding a `SKILL.md`. This file finds them and keeps a small
// list in memory: nothing is written, nothing is run, and the text of a skill is never kept here (`text.ts` reads it fresh when it is used).
//
// Sources, in order; the first holder of a name wins and a later one is listed once, as "shadowed":
//   user    <root>/<name>/SKILL.md               a symlinked skill folder is followed once and its real path recorded
//   synced  <root>/<account>/<name>/SKILL.md     with a `manifest.json` per account; the same name and hash across accounts is one entry,
//                                                  otherwise the newest `updatedAt` wins
// `plugins/marketplaces` is never read: no source names it. The one key read of the owner's settings is `skillOverrides`.

import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import type { SkillSource, SkillState, SkillSummary } from '@conduit/language';
import type { Logger } from '../log';

export const SKILL_LIMITS = { skills: 200, description: 1_024, brief: 90, file: 64 * 1024, folderEntries: 400 } as const;
/** the list is looked at again at most this often, by a look at the folders */
const REFRESH_MS = 60_000;

export interface SkillRoot {
  readonly source: SkillSource;
  readonly dir: string;
}

export interface SkillSettings {
  readonly roots: readonly SkillRoot[];
  /** the file whose `skillOverrides` key is read; null: none is read */
  readonly settingsFile: string | null;
}

/** What `SKILL_ROOTS` and `SKILL_SETTINGS` say; unset means the owner's own folders. Entries are `path` (a user folder), `user=path` or `synced=path`, separated by commas. */
export function skillSettingsFrom(roots: string | undefined, settings: string | undefined, home: string = homedir()): SkillSettings {
  if (roots === undefined || roots.trim() === '') {
    return { roots: [{ source: 'user', dir: join(home, '.claude', 'skills') }, { source: 'synced', dir: join(home, '.claude', 'skills', 'synced') }], settingsFile: settings ?? join(home, '.claude', 'settings.json') };
  }
  const list: SkillRoot[] = [];
  for (const item of roots.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')) {
    const at = item.indexOf('=');
    const named = at > 0 ? item.slice(0, at).trim() : '';
    if (named === 'user' || named === 'synced') list.push({ source: named, dir: item.slice(at + 1).trim() });
    else list.push({ source: 'user', dir: item });
  }
  // With the folders named, nothing of the owner's is read unless a settings file is named too.
  return { roots: list, settingsFile: settings ?? null };
}

/** The few keys of a frontmatter block that matter. Not a YAML parser: `key: value`, quoted values, and `>` or `|` blocks; anything else is skipped. */
export function readFrontmatter(text: string): { readonly keys: Readonly<Record<string, string>>; readonly body: string } {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { keys: {}, body: lines.join('\n') };
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (close < 0) return { keys: {}, body: lines.join('\n') };
  const keys: Record<string, string> = {};
  for (let at = 1; at < close; at += 1) {
    const line = lines[at] ?? '';
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (match === null) continue;
    const name = (match[1] ?? '').toLowerCase();
    let value = (match[2] ?? '').trim();
    if (/^[>|][+-]?$/.test(value)) {
      const folded = value.startsWith('>');
      const block: string[] = [];
      while (at + 1 < close && (/^\s+\S/.test(lines[at + 1] ?? '') || (lines[at + 1] ?? '').trim() === '')) {
        at += 1;
        block.push((lines[at] ?? '').trim());
      }
      value = block.join(folded ? ' ' : '\n').trim();
    } else if (/^(["'])[\s\S]*\1$/.test(value) && value.length >= 2) {
      value = value.slice(1, -1);
    }
    keys[name] = value.replace(/\s+/g, ' ').trim();
  }
  return { keys, body: lines.slice(close + 1).join('\n') };
}

/** At most `max` characters, cut at a word. */
export function briefOf(description: string, max: number = SKILL_LIMITS.brief): string {
  const flat = description.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}

/** A rough count of tokens at the prompt's own rate (2.36 characters a token). */
export function tokensOf(chars: number): number {
  return Math.ceil(chars / 2.36);
}

/** What a skill's own folder holds, apart from `SKILL.md`: reference files and scripts, by name and size. Nothing is opened but to hash a script. */
export interface SkillFiles {
  readonly references: readonly { readonly name: string; readonly size: number }[];
  readonly scripts: readonly { readonly name: string; readonly size: number; readonly hash: string }[];
}

/** The full record the server keeps; `SkillSummary` (what the page sees) is made from it, and never carries the real path. */
export interface SkillEntry extends SkillSummary {
  /** the real path of the skill's folder after the one symlink was followed */
  readonly dir: string;
  /** the folder the skill was found under, which its real path must stay inside */
  readonly root: string;
  readonly hash: string;
  readonly files: SkillFiles;
  readonly updatedAt: string | null;
}

export interface SkillCatalogue {
  /** the list as built; a rebuild starts in the background when it is old, and `force` waits for a fresh one */
  list(force?: boolean): Promise<readonly SkillEntry[]>;
  /** what a person typed or tapped (`user:pdf`, or a bare name) to the one active entry, or null */
  find(ref: string): SkillEntry | null;
  /** built at boot, in the background */
  warm(): void;
}

const SCRIPT_ENDING = /\.(?:py|js|mjs|cjs|ts|sh|bash|zsh|rb|pl)$/i;
const TEXT_ENDING = /\.(?:md|txt|json|csv|ya?ml)$/i;
const SHELLISH = /(?:^|\n)\s*(?:```(?:bash|sh|shell|zsh)|\$ (?:[a-z]+)|(?:pip3?|npm|npx|pnpm|brew|python3?|node)\s+(?:install|run|-m|\S+\.(?:py|js)))/i;
const OTHER_APP = /mcp__[A-Za-z]|\b(?:computer[- ]use|browser pane|in-app browser|desktop app)\b/i;

async function look(path: string): Promise<{ readonly size: number; readonly dir: boolean } | null> {
  try {
    const info = await stat(path);
    return { size: info.size, dir: info.isDirectory() };
  } catch {
    return null;
  }
}

/** The files inside a skill's folder, by name; a link that leaves the folder is not followed, and a folder is looked into one level deep. */
async function filesOf(dir: string): Promise<SkillFiles> {
  const references: { name: string; size: number }[] = [];
  const scripts: { name: string; size: number; hash: string }[] = [];
  const walk = async (folder: string, prefix: string, depth: number): Promise<void> => {
    let names: string[];
    try {
      names = (await readdir(folder)).sort().slice(0, SKILL_LIMITS.folderEntries);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith('.') || (depth === 0 && name === 'SKILL.md')) continue;
      const inside = join(folder, name);
      let real: string;
      try {
        real = await realpath(inside);
      } catch {
        continue;
      }
      if (real !== dir && !real.startsWith(dir + sep)) continue;
      const info = await look(real);
      if (info === null) continue;
      if (info.dir) {
        if (depth < 2) await walk(inside, `${prefix}${name}/`, depth + 1);
      } else if (SCRIPT_ENDING.test(name)) {
        let hash = '';
        try {
          hash = createHash('sha256').update(await readFile(real)).digest('hex').slice(0, 16);
        } catch {
          continue;
        }
        scripts.push({ name: `${prefix}${name}`, size: info.size, hash });
      } else if (TEXT_ENDING.test(name)) {
        references.push({ name: `${prefix}${name}`, size: info.size });
      }
    }
  };
  await walk(dir, '', 0);
  return { references, scripts };
}

interface Found {
  readonly entry: SkillEntry;
  readonly rank: number;
}

/** One skill folder to an entry, or an "unreadable" entry with a sentence. Never throws. */
async function entryOf(root: SkillRoot, folder: string, folderName: string, manifestUpdated: string | null, overrides: Readonly<Record<string, string>>): Promise<SkillEntry | null> {
  let dir: string;
  try {
    dir = await realpath(folder);
  } catch {
    return null;
  }
  const info = await look(dir);
  if (info === null || !info.dir) return null;
  const file = join(dir, 'SKILL.md');
  const fileInfo = await look(file);
  if (fileInfo === null || fileInfo.dir) return null;
  const base = { source: root.source, dir, root: root.dir, updatedAt: manifestUpdated } as const;
  const sentence = (name: string, why: string): SkillEntry => ({ ...base, id: `${root.source}:${name}`, name, description: '', brief: '', size: fileInfo.size, tokens: 0, state: 'unreadable', note: why, hasScripts: false, knowHowOnly: false, needsApp: false, hash: '', files: { references: [], scripts: [] } });
  if (fileInfo.size > SKILL_LIMITS.file) return sentence(folderName, `its SKILL.md is ${Math.round(fileInfo.size / 1024)} KB, more than the ${SKILL_LIMITS.file / 1024} KB that is read`);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return sentence(folderName, 'its SKILL.md could not be read');
  }
  const { keys, body } = readFrontmatter(text);
  const name = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/.test(keys['name'] ?? '') ? (keys['name'] as string) : folderName;
  const description = (keys['description'] ?? '').slice(0, SKILL_LIMITS.description);
  const files = await filesOf(dir);
  const hash = createHash('sha256').update(text).update(JSON.stringify(files)).digest('hex').slice(0, 16);
  const head = `${description}\n${body.slice(0, 4_000)}`;
  const off = overrides[name] === 'off' || overrides[folderName] === 'off';
  const state: SkillState = off ? 'off-claude' : 'on';
  return {
    ...base,
    id: `${root.source}:${name}`,
    name,
    description,
    brief: briefOf(description),
    size: fileInfo.size,
    tokens: tokensOf(text.length),
    state,
    ...(off ? { note: 'switched off in Claude Code, so off here too' } : {}),
    hasScripts: files.scripts.length > 0,
    knowHowOnly: SHELLISH.test(body),
    needsApp: OTHER_APP.test(head),
    hash,
    files,
  };
}

async function overridesOf(file: string | null): Promise<Readonly<Record<string, string>>> {
  if (file === null) return {};
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    const value = typeof parsed === 'object' && parsed !== null ? (parsed as { skillOverrides?: unknown }).skillOverrides : undefined;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((pair): pair is [string, string] => typeof pair[1] === 'string'));
  } catch {
    return {};
  }
}

async function scan(settings: SkillSettings): Promise<SkillEntry[]> {
  const overrides = await overridesOf(settings.settingsFile);
  const found: Found[] = [];
  for (const [rank, root] of settings.roots.entries()) {
    let names: string[];
    try {
      names = (await readdir(root.dir)).sort().slice(0, SKILL_LIMITS.folderEntries);
    } catch {
      continue;
    }
    if (root.source === 'user') {
      for (const name of names) {
        if (name.startsWith('.')) continue;
        const entry = await entryOf(root, join(root.dir, name), name, null, overrides);
        if (entry !== null) found.push({ entry, rank });
      }
      continue;
    }
    // synced: one folder per account, each with a manifest of what it holds; a manifest that cannot be read is not fatal
    for (const account of names) {
      if (account.startsWith('.')) continue;
      const accountDir = join(root.dir, account);
      if (!(await look(accountDir))?.dir) continue;
      const updated = new Map<string, string>();
      try {
        const manifest: unknown = JSON.parse(await readFile(join(accountDir, 'manifest.json'), 'utf8'));
        const list = typeof manifest === 'object' && manifest !== null ? (manifest as { skills?: unknown }).skills : undefined;
        if (Array.isArray(list)) {
          for (const item of list) {
            if (typeof item !== 'object' || item === null) continue;
            const { skillId, name, updatedAt } = item as { skillId?: unknown; name?: unknown; updatedAt?: unknown };
            if (typeof updatedAt !== 'string') continue;
            if (typeof skillId === 'string') updated.set(skillId, updatedAt);
            if (typeof name === 'string') updated.set(name, updatedAt);
          }
        }
      } catch {
        // no manifest: the skills are still read, with no date
      }
      for (const name of (await readdir(accountDir).catch(() => [] as string[])).sort().slice(0, SKILL_LIMITS.folderEntries)) {
        if (name.startsWith('.') || name === 'manifest.json') continue;
        const entry = await entryOf(root, join(accountDir, name), name, updated.get(name) ?? null, overrides);
        if (entry !== null) found.push({ entry, rank });
      }
    }
  }
  return settle(found).slice(0, SKILL_LIMITS.skills);
}

/** The first holder of a name wins; within the synced source the same hash is one entry and otherwise the newest date wins. A loser is listed once, as shadowed. */
function settle(found: readonly Found[]): SkillEntry[] {
  const byName = new Map<string, Found[]>();
  for (const item of found) {
    const key = item.entry.name.toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), item]);
  }
  const out: SkillEntry[] = [];
  for (const group of byName.values()) {
    const ordered = [...group].sort((a, b) => a.rank - b.rank || (b.entry.updatedAt ?? '').localeCompare(a.entry.updatedAt ?? ''));
    const winner = ordered[0] as Found;
    out.push(winner.entry);
    const seen = new Set<string>([`${winner.entry.source}:${winner.entry.hash}`]);
    for (const loser of ordered.slice(1)) {
      // the same words in another account of the same source are one skill, not two
      const key = `${loser.entry.source}:${loser.entry.hash}`;
      if (seen.has(key) || (loser.entry.hash === winner.entry.hash && loser.entry.hash !== '')) continue;
      seen.add(key);
      out.push({ ...loser.entry, id: `${loser.entry.id}#${loser.entry.hash.slice(0, 6)}`, state: 'shadowed', note: `another skill of this name comes first (${winner.entry.source})` });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** The summary a page sees: no real path, no hash of files, no folder. */
export function summaryOf(entry: SkillEntry): SkillSummary {
  const { id, name, source, description, brief, size, tokens, state, note, hasScripts, knowHowOnly, needsApp } = entry;
  return { id, name, source, description, brief, size, tokens, state, ...(note === undefined ? {} : { note }), hasScripts, knowHowOnly, needsApp };
}

export function createSkillCatalogue(settings: SkillSettings, log: Logger, now: () => number = Date.now): SkillCatalogue {
  let entries: readonly SkillEntry[] = [];
  let builtAt = 0;
  let building: Promise<readonly SkillEntry[]> | null = null;
  const build = (): Promise<readonly SkillEntry[]> => {
    building ??= scan(settings)
      .then((next) => {
        entries = next;
        builtAt = now();
        log.info('skills.listed', { count: next.length, off: next.filter((entry) => entry.state === 'off-claude').length });
        return next;
      })
      .catch((cause: unknown) => {
        log.warn('skills.scan_failed', { error: cause instanceof Error ? cause.message : String(cause) });
        return entries;
      })
      .finally(() => {
        building = null;
      });
    return building;
  };
  return {
    async list(force = false) {
      if (builtAt === 0 || force) return build();
      if (now() - builtAt > REFRESH_MS) void build();
      return entries;
    },
    find(ref) {
      const wanted = ref.trim().toLowerCase();
      if (wanted === '') return null;
      const active = entries.filter((entry) => entry.state !== 'shadowed');
      return active.find((entry) => entry.id.toLowerCase() === wanted) ?? active.find((entry) => entry.name.toLowerCase() === wanted) ?? null;
    },
    warm() {
      void build();
    },
  };
}
