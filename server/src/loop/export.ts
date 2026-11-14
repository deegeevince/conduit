// What the builder works in, and how its work is read back. The builder is given a plain folder: the base commit's files, exported
// (`git archive`), with no `.git` in it, outside the repository, and without the sealed paths. A model that can edit files in a
// folder with a `.git` in it can write a hook that the next `git commit` runs; a folder with none has nothing to run. The folder is
// compared with a second, untouched export of the same commit, by this module, so that no git configuration the builder could have
// written is ever read.

import { lstat, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exec } from './proc';

export interface Export {
  /** what the builder edits */
  readonly work: string;
  /** the same commit, never given to the builder: what `work` is compared with */
  readonly pristine: string;
  /** the parent of both: removed with them */
  readonly root: string;
}

export interface FileChange {
  readonly file: string;
  readonly status: 'added' | 'modified' | 'deleted';
  readonly added: number;
  readonly removed: number;
  readonly executable: boolean;
}

/** `git archive` of `ref` into a folder, leaving out `without`. Nothing outside the archive is read. */
async function extract(repo: string, ref: string, folder: string, without: readonly string[], scratch: string): Promise<void> {
  const tar = join(scratch, `${folder.split('/').pop() ?? 'tree'}.tar`);
  const made = await exec({ bin: 'git', args: ['archive', '--format=tar', '-o', tar, ref], cwd: repo, timeoutMs: 120_000 });
  if (made.code !== 0) throw new Error(`git archive ${ref}: ${made.stderr.trim()}`);
  await mkdir(folder, { recursive: true });
  const opened = await exec({ bin: 'tar', args: ['-xf', tar, '-C', folder], cwd: scratch, timeoutMs: 120_000 });
  if (opened.code !== 0) throw new Error(`tar: ${opened.stderr.trim()}`);
  await rm(tar, { force: true });
  for (const path of without) await rm(join(folder, path), { recursive: true, force: true });
}

/** A folder outside the repository (and outside any other), holding the commit's files minus `without`, twice. */
export async function exportTree(repo: string, ref: string, without: readonly string[]): Promise<Export> {
  const root = await mkdtemp(join(tmpdir(), 'conduit-build-'));
  // the CLI treats a `.claude` folder as tool configuration and will not let a builder write in it: a folder under one would be a build that cannot build
  if (root.includes('/.claude/')) {
    await rm(root, { recursive: true, force: true });
    throw new Error(`the temporary folder ${root} is inside a .claude folder; set TMPDIR to somewhere else`);
  }
  const work = join(root, 'tree');
  const pristine = join(root, 'base');
  try {
    await extract(repo, ref, work, without, root);
    await extract(repo, ref, pristine, without, root);
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return { work, pristine, root };
}

export async function dropExport(made: Export): Promise<void> {
  await rm(made.root, { recursive: true, force: true }).catch(() => undefined);
}

/** Every regular file under a folder, as relative paths; anything else (a link, a device) is reported apart: a builder that makes one is refused. */
async function walk(folder: string, prefix = ''): Promise<{ files: Map<string, boolean>; odd: string[] }> {
  const files = new Map<string, boolean>();
  const odd: string[] = [];
  for (const entry of await readdir(join(folder, prefix), { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      const inner = await walk(folder, relative);
      for (const [name, executable] of inner.files) files.set(name, executable);
      odd.push(...inner.odd);
    } else if (entry.isFile()) {
      files.set(relative, ((await lstat(join(folder, relative))).mode & 0o111) !== 0);
    } else odd.push(relative);
  }
  return { files, odd };
}

/** Lines added and removed in one file, and the text added, from a diff run outside any repository with no configuration read. */
async function lineDiff(pristine: string, work: string, file: string, status: FileChange['status']): Promise<{ added: number; removed: number; text: string }> {
  const left = status === 'added' ? '/dev/null' : join(pristine, file);
  const right = status === 'deleted' ? '/dev/null' : join(work, file);
  const run = await exec({
    bin: 'git',
    args: ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '-U0', '--', left, right],
    cwd: tmpdir(),
    env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    timeoutMs: 60_000,
  });
  let added = 0;
  let removed = 0;
  const text: string[] = [];
  for (const line of run.stdout.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) {
      added += 1;
      text.push(line.slice(1));
    } else if (line.startsWith('-')) removed += 1;
  }
  return { added, removed, text: text.join('\n') };
}

export interface Changes {
  readonly files: readonly FileChange[];
  /** everything the build added, as one text: what is searched for battery phrases */
  readonly addedText: string;
  /** what is in the folder that is not a regular file */
  readonly odd: readonly string[];
}

/** What the builder changed: new, edited and deleted files, compared byte for byte with the untouched export. */
export async function changesOf(made: Export): Promise<Changes> {
  const [was, is] = await Promise.all([walk(made.pristine), walk(made.work)]);
  const files: FileChange[] = [];
  const texts: string[] = [];
  const names = new Set([...was.files.keys(), ...is.files.keys()]);
  for (const file of [...names].sort()) {
    const before = was.files.has(file);
    const after = is.files.has(file);
    const kind: FileChange['status'] = !before ? 'added' : !after ? 'deleted' : 'modified';
    if (kind === 'modified') {
      const same = Buffer.compare(await readFile(join(made.pristine, file)), await readFile(join(made.work, file))) === 0;
      if (same && was.files.get(file) === is.files.get(file)) continue;
    }
    const counted = await lineDiff(made.pristine, made.work, file, kind);
    texts.push(counted.text);
    files.push({ file, status: kind, added: counted.added, removed: counted.removed, executable: is.files.get(file) === true });
  }
  return { files, addedText: texts.join('\n'), odd: is.odd };
}
