// The only place `git` is run. Worktrees, branches, diffs and the merge of an approved experiment.
// Every function takes the repository it works in; nothing here reads a model's words.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FileChange } from './export';
import { exec } from './proc';

export class GitError extends Error {}

async function git(cwd: string, args: readonly string[], allowFail = false): Promise<string> {
  const run = await exec({ bin: 'git', args, cwd, timeoutMs: 120_000 });
  if (run.code !== 0 && !allowFail) throw new GitError(`git ${args.join(' ')} (in ${cwd}): ${run.stderr.trim() || `exit ${String(run.code)}`}`);
  return run.stdout;
}

export interface Tree {
  readonly path: string;
  /** the commit the tree is checked out at. A tree is always DETACHED: it has no branch, so there is none for a clean-up to delete. */
  readonly base: string;
}

export async function currentBranch(repo: string): Promise<string> {
  return (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
}

export async function head(repo: string, ref = 'HEAD'): Promise<string> {
  return (await git(repo, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
}

/** The one prefix of every branch this loop makes, and so the only branches it may delete. */
export const LOOP_BRANCH_PREFIX = 'loop/';

/**
 * A commit holding the base's files with `changes` laid over them, made with git's plumbing and no checkout (so no hook, no filter and no
 * configuration of any tree is ever run), and a new branch `branch` pointing at it. The branch must be one of ours and must not exist.
 */
export async function commitChanges(repo: string, base: string, branch: string, work: string, changes: readonly FileChange[], message: string): Promise<string> {
  if (!branch.startsWith(LOOP_BRANCH_PREFIX)) throw new GitError(`refusing to make a branch outside ${LOOP_BRANCH_PREFIX}: ${branch}`);
  const indexDir = await mkdtemp(join(tmpdir(), 'conduit-index-'));
  const env = { GIT_INDEX_FILE: join(indexDir, 'index') };
  const identity = { GIT_AUTHOR_NAME: 'conduit-loop', GIT_AUTHOR_EMAIL: 'loop@conduit.invalid', GIT_COMMITTER_NAME: 'conduit-loop', GIT_COMMITTER_EMAIL: 'loop@conduit.invalid' };
  const plumb = async (args: readonly string[], extra: Readonly<Record<string, string>> = {}): Promise<string> => {
    const run = await exec({ bin: 'git', args, cwd: repo, env: { ...env, ...extra }, timeoutMs: 120_000 });
    if (run.code !== 0) throw new GitError(`git ${args.join(' ')}: ${run.stderr.trim() || `exit ${String(run.code)}`}`);
    return run.stdout.trim();
  };
  try {
    await plumb(['read-tree', base]);
    for (const change of changes) {
      if (change.status === 'deleted') {
        await plumb(['update-index', '--force-remove', '--', change.file]);
        continue;
      }
      const blob = await plumb(['hash-object', '-w', '--no-filters', '--', join(work, change.file)]);
      await plumb(['update-index', '--add', '--cacheinfo', `${change.executable ? '100755' : '100644'},${blob},${change.file}`]);
    }
    const tree = await plumb(['write-tree']);
    const commit = await plumb(['commit-tree', tree, '-p', base, '-m', message], identity);
    await plumb(['update-ref', `refs/heads/${branch}`, commit, '0000000000000000000000000000000000000000']);
    return commit;
  } finally {
    await rm(indexDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Every tracked path of a commit. */
async function trackedAt(repo: string, ref: string): Promise<string[]> {
  return (await git(repo, ['ls-tree', '-r', '--name-only', '-z', ref])).split('\0').filter((name) => name !== '');
}

/**
 * A DETACHED worktree of `commit` to be measured (or checked), with every path `isHarness` names put back as the BASE commit has it and
 * every such path the candidate added taken out. Whatever the builder did to the harness, the measurement is made by the base's.
 */
export async function measuringTree(repo: string, folder: string, commit: string, base: string, isHarness: (file: string) => boolean): Promise<Tree> {
  await mkdir(dirname(folder), { recursive: true });
  await git(repo, ['worktree', 'add', '--detach', folder, commit]);
  if (commit !== base) {
    const restore = (await trackedAt(repo, base)).filter(isHarness);
    for (let at = 0; at < restore.length; at += 200) await git(folder, ['checkout', base, '--', ...restore.slice(at, at + 200)]);
    const added = (await git(repo, ['diff', '--name-only', '-z', '--diff-filter=A', base, commit])).split('\0').filter((name) => name !== '' && isHarness(name));
    for (const file of added) {
      await git(folder, ['rm', '-q', '-f', '--', file], true);
      await rm(join(folder, file), { force: true });
    }
  }
  return { path: folder, base: await head(folder) };
}

/** Removes a worktree. It has no branch to remove, and this never touches one. Never throws: it runs in `finally`. */
export async function dropTree(repo: string, path: string): Promise<void> {
  await git(repo, ['worktree', 'remove', '--force', path], true);
  await rm(path, { recursive: true, force: true }).catch(() => undefined);
  await git(repo, ['worktree', 'prune'], true);
}

/** Deletes a branch this loop made. Anything else (a base, a branch the owner has) is refused here, whoever asks. Never throws. */
export async function dropBranch(repo: string, branch: string, made: ReadonlySet<string>): Promise<boolean> {
  if (!branch.startsWith(LOOP_BRANCH_PREFIX) || !made.has(branch)) return false;
  await git(repo, ['branch', '-D', '--', branch], true);
  return true;
}

/** What a branch changed against a commit, as a patch. */
export async function patchBetween(repo: string, base: string, commit: string): Promise<string> {
  return git(repo, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', base, commit]);
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

/** A branch at `from`, for a scratch repository: what a stand-in run is based on while another branch is checked out. */
export async function branchAt(repo: string, branch: string, from: string): Promise<void> {
  await git(repo, ['branch', branch, from]);
}
