// The real answers to the runner's questions: the owner's scores, the battery's prompts, the package manager.

import { cp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { agreementOf } from '@conduit/language';
import type { ExploreBattery, TasteSheet } from '@conduit/language';
import { claudeAgents } from './agents';
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

export async function promptsOf(repo: string): Promise<string[]> {
  const files = [join(repo, 'explore', 'battery.json'), ...(await jsonFiles(join(repo, 'explore', 'sealed')))];
  const out: string[] = [];
  for (const file of files) {
    try {
      const battery = JSON.parse(await readFile(file, 'utf8')) as ExploreBattery;
      for (const prompt of battery.prompts) out.push(prompt.prompt);
      for (const item of battery.cases ?? []) for (const turn of item.turns) if ('say' in turn && typeof turn.say === 'string') out.push(turn.say);
    } catch {
      // not a battery
    }
  }
  return out;
}

export function realDeps(repo: string, log: (line: string) => void): Deps {
  return {
    repo,
    agents: claudeAgents(process.env['CLAUDE_BIN'] ?? 'claude'),
    measurer: exploreMeasurer(),
    prepare: async (tree) => {
      await exec({ bin: 'pnpm', args: ['install', '--offline', '--frozen-lockfile'], cwd: tree, timeoutMs: 300_000 });
    },
    checks: async (tree) => {
      const failures: string[] = [];
      const typecheck = await exec({ bin: 'pnpm', args: ['typecheck'], cwd: tree, timeoutMs: 600_000 });
      if (typecheck.code !== 0) failures.push(`typecheck: ${(typecheck.stdout + typecheck.stderr).trim().slice(-300)}`);
      const prompt = await exec({ bin: 'pnpm', args: ['prompt', 'count'], cwd: tree, timeoutMs: 120_000 });
      if (prompt.code !== 0) failures.push(`the prompt budget: ${(prompt.stdout + prompt.stderr).trim().slice(-300)}`);
      return failures;
    },
    taste: (rubric) => tasteFor(repo, rubric),
    phrases: async () => phrasesOf(await promptsOf(repo)),
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
      return names;
    },
    log,
  };
}
