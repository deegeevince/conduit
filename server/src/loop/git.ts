// The only place `git` is run. Worktrees, branches, diffs and the merge of an approved experiment.
// Every function takes the repository it works in; nothing here reads a model's words.

import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { exec } from './proc';

export class GitError extends Error {}

async function git(cwd: string, args: readonly string[], allowFail = false): Promise<string> {
  const run = await exec({ bin: 'git', args, cwd, timeoutMs: 120_000 });
  if (run.code !== 0 && !allowFail) throw new GitError(`git ${args.join(' ')} (in ${cwd}): ${run.stderr.trim() || `exit ${String(run.code)}`}`);
  return run.stdout;
}

export interface Tree {
  readonly path: string;
  readonly branch: string;
  /** the commit it was made from: every diff is against this */
  readonly base: string;
}

export async function currentBranch(repo: string): Promise<string> {
  return (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
}

export async function head(repo: string, ref = 'HEAD'): Promise<string> {
  return (await git(repo, ['rev-parse', ref])).trim();
}

/**
 * A worktree on a new branch, made from `from`. `without` paths are removed from the checkout and marked so that
 * git does not read their absence as a change: a builder's tree has no sealed file in it to read or to touch.
 */
export async function makeTree(repo: string, folder: string, branch: string, from: string, without: readonly string[] = []): Promise<Tree> {
  await mkdir(dirname(folder), { recursive: true });
  await git(repo, ['worktree', 'add', '-b', branch, folder, from]);
  const base = await head(folder);
  for (const path of without) {
    const tracked = (await git(folder, ['ls-files', '--', path])).split('\n').filter((line) => line !== '');
    if (tracked.length > 0) await git(folder, ['update-index', '--skip-worktree', '--', ...tracked]);
    await rm(join(folder, path), { recursive: true, force: true });
  }
  return { path: folder, branch, base };
}

/** The same branch checked out again to be measured, with `bring` copied in from `source` (the measurer may read what the builder may not). */
export async function measuringTree(repo: string, folder: string, ref: string, source: string, bring: readonly string[]): Promise<Tree> {
  await mkdir(dirname(folder), { recursive: true });
  await git(repo, ['worktree', 'add', '--detach', folder, ref]);
  for (const path of bring) await cp(join(source, path), join(folder, path), { recursive: true }).catch(() => undefined);
  return { path: folder, branch: ref, base: await head(folder) };
}

/** Removes a worktree and, when it was ours to make, its branch. Never throws: it runs in `finally`. */
export async function dropTree(repo: string, tree: { readonly path: string; readonly branch?: string }, deleteBranch: boolean): Promise<void> {
  await git(repo, ['worktree', 'remove', '--force', tree.path], true);
  await rm(tree.path, { recursive: true, force: true }).catch(() => undefined);
  await git(repo, ['worktree', 'prune'], true);
  if (deleteBranch && tree.branch !== undefined) await git(repo, ['branch', '-D', tree.branch], true);
}

export interface Change {
  readonly file: string;
  readonly added: number;
  readonly removed: number;
}

/** Everything the build changed, against the commit the tree was made from, new files included. */
export async function changesIn(tree: Tree): Promise<{ readonly files: readonly Change[]; readonly addedText: string }> {
  await git(tree.path, ['add', '-A']);
  const numstat = await git(tree.path, ['diff', '--cached', '--numstat', '--no-renames', tree.base]);
  const files = numstat
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const [added = '0', removed = '0', ...name] = line.split('\t');
      return { file: name.join('\t'), added: added === '-' ? 0 : Number(added), removed: removed === '-' ? 0 : Number(removed) };
    });
  const patch = await git(tree.path, ['diff', '--cached', '--no-renames', '-U0', tree.base]);
  const addedText = patch
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n');
  return { files, addedText };
}

export async function patchOf(tree: Tree): Promise<string> {
  await git(tree.path, ['add', '-A']);
  return git(tree.path, ['diff', '--cached', '--no-renames', tree.base]);
}

/** Commits what the build left, so the branch can be measured and, if approved, merged. */
export async function commitAll(tree: Tree, message: string): Promise<string> {
  await git(tree.path, ['add', '-A']);
  await git(tree.path, ['-c', 'user.name=conduit-loop', '-c', 'user.email=loop@conduit.invalid', 'commit', '--allow-empty', '-m', message]);
  return head(tree.path);
}

export async function branchExists(repo: string, branch: string): Promise<boolean> {
  return (await git(repo, ['branch', '--list', branch])).trim() !== '';
}

/** The worktrees this repository knows, as paths. The loop's own are under `loop/runs/`. */
export async function worktrees(repo: string): Promise<string[]> {
  return (await git(repo, ['worktree', 'list', '--porcelain']))
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
}

/** Merges an approved experiment branch into the branch the repository is on. Fast-forward refused: the merge is a commit that names the experiment. */
export async function mergeBranch(repo: string, branch: string, message: string): Promise<string> {
  await git(repo, ['-c', 'user.name=conduit-steward', '-c', 'user.email=steward@conduit.invalid', 'merge', '--no-ff', '-m', message, branch]);
  return head(repo);
}

/** Whether the working tree of the repository has uncommitted changes under `paths` (a merge must not run over them). */
export async function isDirty(repo: string, paths: readonly string[]): Promise<boolean> {
  return (await git(repo, ['status', '--porcelain', '--', ...paths])).trim() !== '';
}

/** A scratch repository holding `files`, committed on `main`: what the stand-in run works on. */
export async function initScratch(folder: string, files: Readonly<Record<string, string>>): Promise<void> {
  await mkdir(folder, { recursive: true });
  await git(folder, ['init', '-q', '-b', 'main']);
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(folder, name)), { recursive: true });
    await writeFile(join(folder, name), text);
  }
  await git(folder, ['add', '-A']);
  await git(folder, ['-c', 'user.name=stand-in', '-c', 'user.email=stand-in@conduit.invalid', 'commit', '-q', '-m', 'scratch']);
}

export async function branches(repo: string): Promise<string[]> {
  return (await git(repo, ['branch', '--format=%(refname:short)'])).split('\n').filter((line) => line !== '');
}

export async function checkout(repo: string, branch: string): Promise<void> {
  await git(repo, ['checkout', '-q', branch]);
}

/** Files a branch changed against another, for what an approval will push. */
export async function filesBetween(repo: string, from: string, to: string): Promise<string[]> {
  return (await git(repo, ['diff', '--name-only', `${from}...${to}`])).split('\n').filter((line) => line !== '');
}

export async function deleteBranch(repo: string, branch: string): Promise<void> {
  await git(repo, ['branch', '-D', branch], true);
}
