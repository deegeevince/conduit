// Where the owner's own data lives: outside the repository, so that a worktree can be deleted, a branch switched or a checkout
// reinstalled without touching a conversation, a log, the audit trail or what the usage meter has counted.
//
// This module reads no environment of its own (callers hand it `Source`) and imports nothing from the rest of the server, so the tools
// (`pnpm sessions`, `capture`, `lessons`, `critic-usage`, `audit`) and `env.ts` can all use it.
//
//   <DATA_DIR>/logs/           session logs and the pictures saved beside them
//   <DATA_DIR>/uploads/        pictures the user gave, when they are kept
//   <DATA_DIR>/documents/      the catalogue's index (`index.json`): one entry a document, rebuilt from the session logs when it is missing or stale
//   <DATA_DIR>/voice/          voice notes for the moment they are read (deleted after, unless VOICE_KEEP=on); voice/work holds the helper's answers
//   <DATA_DIR>/audit.jsonl     every tool call, permission, setting change and connector use (`pnpm audit`)
//   <DATA_DIR>/usage.jsonl     every model call the server made: model, tokens, cost-equivalent, ms
//   <DATA_DIR>/cache/          the technique library's last good read, the dataset index, the photographs found for mock-ups (pictures/), the art sheets kept for the shelf (art/)
//   <DATA_DIR>/loop/queue/     findings waiting for the improvement loop, lessons usage, the steward's painter-bugs file
//   <DATA_DIR>/reports/        "Report a problem": one folder a report (report.json and its pictures), written by the page's own button, read by `pnpm reports`
//   <DATA_DIR>/state/          small switches that must outlive a restart (the kill switch)

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export type Source = Readonly<Record<string, string | undefined>>;

export interface DataPaths {
  readonly root: string;
  readonly logs: string;
  readonly uploads: string;
  readonly documents: string;
  readonly voice: string;
  readonly voiceCache: string;
  readonly audit: string;
  readonly usage: string;
  readonly cache: string;
  readonly picturesCache: string;
  /** finished drawings made or kept for the shelf (`art/seed` in the repository holds the seeds) */
  readonly artCache: string;
  readonly queue: string;
  readonly state: string;
  readonly reports: string;
}

/** `~` and `~/x` mean the owner's home folder. */
function expandHome(path: string): string {
  if (path === '~') return homedir();
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

/** The data folder: `DATA_DIR`, else `~/Library/Application Support/Conduit` (on a Mac; `$XDG_DATA_HOME/conduit` elsewhere). Always absolute. */
export function resolveDataDir(source: Source): string {
  const setting = source['DATA_DIR']?.trim();
  if (setting !== undefined && setting !== '') return resolve(expandHome(setting));
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Conduit');
  const xdg = source['XDG_DATA_HOME']?.trim();
  return join(xdg !== undefined && xdg !== '' ? xdg : join(homedir(), '.local', 'share'), 'conduit');
}

export function dataPaths(root: string): DataPaths {
  return {
    root,
    logs: join(root, 'logs'),
    uploads: join(root, 'uploads'),
    documents: join(root, 'documents'),
    voice: join(root, 'voice'),
    voiceCache: join(root, 'cache', 'voice'),
    audit: join(root, 'audit.jsonl'),
    usage: join(root, 'usage.jsonl'),
    cache: join(root, 'cache'),
    picturesCache: join(root, 'cache', 'pictures'),
    artCache: join(root, 'cache', 'art'),
    queue: join(root, 'loop', 'queue'),
    state: join(root, 'state'),
    reports: join(root, 'reports'),
  };
}

/** Makes the folders (owner only: the audit trail and the logs are the owner's alone). Never throws; the caller finds out when it writes. */
export function ensureDataDirs(paths: DataPaths): void {
  for (const dir of [paths.root, paths.logs, paths.uploads, paths.documents, paths.voice, paths.cache, paths.queue, paths.state]) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {
      // a folder that cannot be made is reported by whatever first writes into it
    }
  }
}

/** What the legacy copy found: for the boot log and for the migration marker. */
export interface MigrationReport {
  readonly from: string;
  readonly to: string;
  readonly copied: number;
  readonly skipped: number;
  readonly failed: number;
}

/** Copies `from` into `to`, file by file, never overwriting a file that is already there and never touching `from`. */
function copyTree(from: string, to: string, counts: { copied: number; skipped: number; failed: number }): void {
  let entries: string[];
  try {
    entries = readdirSync(from);
  } catch {
    counts.failed += 1;
    return;
  }
  mkdirSync(to, { recursive: true, mode: 0o700 });
  for (const name of entries) {
    const source = join(from, name);
    const target = join(to, name);
    try {
      const info = statSync(source);
      if (info.isDirectory()) copyTree(source, target, counts);
      else if (info.isFile()) {
        if (existsSync(target)) counts.skipped += 1;
        else {
          copyFileSync(source, target);
          counts.copied += 1;
        }
      }
    } catch {
      counts.failed += 1;
    }
  }
}

interface Legacy {
  readonly name: string;
  readonly from: string;
  readonly to: string;
}

/**
 * Where the data used to live: the repository's own `logs/` and `loop/queue/`. `extraRepos` are other checkouts the owner ran from (`MIGRATE_FROM`, a comma list): the server has run from several
 * worktrees, and the logs are wherever it was started.
 */
export function legacyPlaces(repoRoot: string, paths: DataPaths, extraRepos: readonly string[], source: Source): Legacy[] {
  const places: Legacy[] = [];
  for (const repo of [repoRoot, ...extraRepos]) {
    places.push(
      { name: `${repo}/logs`, from: join(repo, 'logs'), to: paths.logs },
      { name: `${repo}/loop/queue`, from: join(repo, 'loop', 'queue'), to: paths.queue },
    );
  }
  return places;
}

/**
 * First start with a data folder: copy what is in the old places. It is a copy, never a move: the originals are not deleted, renamed or
 * changed, and a file already in the data folder is never overwritten. Each old place is done once (`state/migrated.json` says which),
 * so a second start copies nothing and a log added to an old place later is not pulled in behind the owner's back.
 */
export function migrateLegacyData(repoRoot: string, paths: DataPaths, extraRepos: readonly string[], source: Source): MigrationReport[] {
  const marker = join(paths.state, 'migrated.json');
  let done: Record<string, { at: string; copied: number; skipped: number }> = {};
  try {
    done = JSON.parse(readFileSync(marker, 'utf8')) as typeof done;
  } catch {
    // none yet
  }
  const reports: MigrationReport[] = [];
  for (const place of legacyPlaces(repoRoot, paths, extraRepos, source)) {
    if (done[place.name] !== undefined || !existsSync(place.from)) continue;
    // A repository that is the data folder's own parent is not "legacy": never copy a folder onto itself.
    if (resolve(place.from) === resolve(place.to)) continue;
    const counts = { copied: 0, skipped: 0, failed: 0 };
    copyTree(place.from, place.to, counts);
    reports.push({ from: place.from, to: place.to, ...counts });
    if (counts.failed === 0) done[place.name] = { at: new Date().toISOString(), copied: counts.copied, skipped: counts.skipped };
  }
  if (reports.length > 0) {
    try {
      mkdirSync(paths.state, { recursive: true, mode: 0o700 });
      writeFileSync(marker, `${JSON.stringify(done, null, 2)}\n`, { mode: 0o600 });
    } catch {
      // the copy happened; at worst the next start walks the same folders and skips every file that is already there
    }
  }
  return reports;
}

/** The checkouts named by `MIGRATE_FROM`, absolute. */
export function extraRepos(source: Source): string[] {
  return (source['MIGRATE_FROM'] ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => resolve(expandHome(part)));
}

/**
 * The tools' way to name the data folder: `--data <dir>` (or its older spelling `--from <dir>`, which has the same layout: a folder with
 * `logs/` and `loop/queue/` in it), else `DATA_DIR`, else the default. Returns the environment with `DATA_DIR` set to what was chosen,
 * so every other reader (`resolveLogDir`, `resolveDataPaths`) agrees with it.
 */
export function withDataFlag(argv: readonly string[], source: Source): Source {
  for (const name of ['--data', '--from']) {
    const at = argv.indexOf(name);
    if (at < 0) continue;
    const value = argv[at + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a folder`);
    return { ...source, DATA_DIR: value };
  }
  return source;
}
