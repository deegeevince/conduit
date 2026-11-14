// The real answers to the runner's questions: the owner's scores, the battery's prompts, the package manager.

import { cp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { agreementOf } from '@conduit/language';
import type { ExploreBattery, TasteSheet } from '@conduit/language';
import { resolveDataPaths } from '../env';
import { RUNNER_COMMANDS, claudeAgents } from './agents';
import { phrasesOf } from './guard';
import { exploreMeasurer } from './measure';
import { exec } from './proc';
import type { Deps } from './runner';

async function jsonFiles(folder: string): Promise<string[]> {
  return (await readdir(folder).catch((): string[] => [])).filter((name) => name.endsWith('.json')).map((name) => join(folder, name));
}

/** The owner's sheets whose judge is the judge in use: agreement is about that judge and no other. */
export async function tasteFor(repo: string, rubric: string) {
  const sheets: TasteSheet[] = [];
  for (const file of await jsonFiles(join(repo, 'explore', 'taste'))) {
    try {
      const sheet = JSON.parse(await readFile(file, 'utf8')) as TasteSheet;
      if (sheet.rubric === rubric) sheets.push(sheet);
    } catch {
      // a sheet that is not readable is not evidence
    }
  }
  return agreementOf(sheets);
}

/** Every prompt of every battery the runner may read, the held-out ones included: they are only ever turned into phrases to look for in a diff. */
export async function promptsOf(repo: string, sealedDir: string | null): Promise<string[]> {
  const files = [...(await jsonFiles(join(repo, 'explore'))), ...(await jsonFiles(join(repo, 'explore', 'sealed'))), ...(sealedDir === null ? [] : await jsonFiles(sealedDir))];
  const out: string[] = [];
  for (const file of files) {
    try {
      const battery = JSON.parse(await readFile(file, 'utf8')) as ExploreBattery;
      for (const prompt of battery.prompts ?? []) out.push(prompt.prompt);
      for (const item of battery.cases ?? []) for (const turn of item.turns) if ('say' in turn && typeof turn.say === 'string') out.push(turn.say);
    } catch {
      // not a battery
    }
  }
  return out;
}

/** The held-out folder from the environment: absolute, outside the repository, or nothing. */
export function sealedDirOf(repo: string): string | null {
  const text = process.env['BATTERY_SEALED_DIR']?.trim();
  if (text === undefined || text === '') return null;
  const path = resolve(repo, text);
  return path.startsWith(repo) ? null : path;
}

/**
 * The findings the critic of real turns queued (D5), as evidence for the loop's critic: what was asked, how it scored, what was wrong, what
 * would help. The session log's name and the stage snapshot are left out. Returns the line count.
 */
export async function copyFindings(queueDir: string, folder: string, keep = 80): Promise<number> {
  const text = await readFile(join(queueDir, 'findings.jsonl'), 'utf8').catch(() => '');
  const rows: string[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const entry = JSON.parse(line) as { at?: unknown; turn?: unknown; asked?: unknown; finding?: { coherence?: unknown; readable?: unknown; asked?: unknown; problems?: unknown; suggestions?: unknown } };
      const found = entry.finding;
      if (found === undefined) continue;
      rows.push(JSON.stringify({ at: entry.at, turn: entry.turn, asked: entry.asked, coherence: found.coherence, readable: found.readable, drewWhatWasAsked: found.asked, problems: found.problems, suggestions: found.suggestions }));
    } catch {
      // a half-written line is not evidence
    }
  }
  if (rows.length === 0) return 0;
  await writeFile(join(folder, 'findings.jsonl'), `${rows.slice(-keep).join('\n')}\n`);
  return Math.min(rows.length, keep);
}

export function realDeps(repo: string, log: (line: string) => void): Deps {
  const sealedDir = sealedDirOf(repo);
  return {
    repo,
    agents: claudeAgents(process.env['CLAUDE_BIN'] ?? 'claude'),
    measurer: exploreMeasurer(),
    sealedDir,
    prepare: async (tree) => {
      await exec({ bin: 'pnpm', args: ['install', '--offline', '--frozen-lockfile'], cwd: tree, timeoutMs: 300_000 });
    },
    // Run by the runner, in a detached copy of the candidate whose package.json, tsconfigs and scripts are the base commit's (git.ts puts them back).
    // Code the builder wrote runs here (a prompt, a painter module), so what it could reach is as little as can be: no sealed set in the tree, none named in the environment.
    checks: async (tree) => {
      const failures: string[] = [];
      const bare = { BATTERY_SEALED_DIR: '', LIBRARY_OVERLAY: '' };
      for (const command of RUNNER_COMMANDS) {
        const run = await exec({ bin: 'pnpm', args: command, cwd: tree, env: bare, timeoutMs: command[0] === 'typecheck' ? 600_000 : 180_000 });
        if (run.code !== 0) failures.push(`${command[0] === 'prompt' ? 'the prompt budget' : (command[0] as string)}: ${(run.stdout + run.stderr).trim().slice(-300)}`);
      }
      return failures;
    },
    taste: (rubric) => tasteFor(repo, rubric),
    phrases: async () => phrasesOf(await promptsOf(repo, sealedDir)),
    briefing: async (folder, baseline, tree) => {
      const names: string[] = [];
      await writeFile(join(folder, 'tune-summary.json'), JSON.stringify(baseline, null, 2));
      names.push('tune-summary.json');
      const index = await exec({ bin: 'ls', args: ['-1', 'techniques/seed', 'techniques/overlay'], cwd: tree });
      await writeFile(join(folder, 'techniques.txt'), index.stdout);
      names.push('techniques.txt');
      await cp(join(tree, 'docs', 'language.md'), join(folder, 'language.md')).then(() => names.push('language.md')).catch(() => undefined);
      // only the tune run's own folder: the held-out runs live beside it and are never copied
      await cp(join(tree, 'explore', 'runs', baseline.run), join(folder, 'tune-run'), { recursive: true }).then(() => names.push('tune-run/')).catch(() => undefined);
      if ((await copyFindings(resolveDataPaths(process.env).queue, folder)) > 0) names.push('findings.jsonl');
      return names;
    },
    log,
  };
}
