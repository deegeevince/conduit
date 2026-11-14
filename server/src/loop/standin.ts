// Stand-ins: an agent that is scripted and a battery that is arithmetic, so the whole loop (worktrees, guard,
// refusal, rebuild, measuring, deciding, both records, the clean-up) can be shown without a model and without money.
// Nothing here is used by a real run.

import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Agents } from './agents';
import type { Measurer } from './measure';
import type { Deps } from './runner';
import type { ExploreFamily } from '@conduit/language';
import type { FamilyScore, Measure, PromptRow } from './types';

const row = (coherence: number): FamilyScore => ({ n: 6, judged: 6, coherence, correct: 0.6, readable: 0.8, asked: 0.9, collisions: 0.2, tokens: 900, firstLineMs: 2300, own: null });

/** A small deterministic wobble for one prompt in one round, so that the pairing has something to pair. */
function wobble(label: string, id: string): number {
  let hash = 7;
  for (const char of `${label}/${id}`) hash = (hash * 31 + char.charCodeAt(0)) % 9973;
  return ((hash % 100) / 100 - 0.5) * 0.1;
}

/** Builds a technique when the brief says so, but the first time it is asked it also edits the battery, as a cheating builder would. */
export function standInAgents(reviewer: 'approves' | 'objects' = 'approves'): Agents & { readonly calls: string[] } {
  const calls: string[] = [];
  let builds = 0;
  return {
    calls,
    async run(call) {
      calls.push(call.kind);
      if (call.kind === 'critic') {
        const items = [
          { kind: 'technique', title: 'Layered flow technique', hypothesis: 'Flows are drawn as loose boxes; a technique that names the structure would fix it.', aims: ['diagram'], evidence: ['flow_s1'], brief: 'Write a technique for answers that are a process with steps.' },
          { kind: 'style', title: 'Second experiment', hypothesis: 'Another idea, which the budget may not reach.', aims: ['scene'], evidence: [], brief: 'Change a look.' },
        ];
        return { text: `\`\`\`json\n${JSON.stringify(items)}\n\`\`\``, usd: 0.4, failed: null };
      }
      if (call.kind === 'builder') {
        builds += 1;
        if (builds === 1) {
          await mkdir(join(call.cwd, 'explore'), { recursive: true });
          await writeFile(join(call.cwd, 'explore', 'battery.json'), '{"version":1,"prompts":[]}\n');
        }
        await mkdir(join(call.cwd, 'techniques', 'overlay'), { recursive: true });
        await writeFile(join(call.cwd, 'techniques', 'overlay', `flow-${builds}.md`), '# Layered flow\n\nWhen the answer is a process, name a flow and give each step a line.\n');
        return { text: 'Added a technique file.', usd: 0.6, failed: null };
      }
      if (reviewer === 'objects') return { text: '```json\n{"approve": false, "why": "The technique is the answer to one question, not a kind of answer."}\n```', usd: 0.3, failed: null };
      return { text: '```json\n{"approve": true, "why": "I read the diff: one new technique file in plain words, no prompt text, no branching on a wording."}\n```', usd: 0.3, failed: null };
    },
  };
}

/** A battery that is arithmetic: the candidate's diagram rises when it holds an overlay technique. Deterministic. */
export function standInMeasurer(): Measurer {
  return {
    async estimate() {
      return 0.2;
    },
    async measure(tree, options): Promise<Measure> {
      const overlay = (await readdir(join(tree, 'techniques', 'overlay')).catch((): string[] => [])).length > 0;
      const level = { diagram: overlay ? 3.1 : 2.4, scene: 3.3, plain: 4.1 };
      const families: Partial<Record<ExploreFamily, FamilyScore>> = {};
      const prompts: PromptRow[] = [];
      for (const family of ['diagram', 'scene', 'plain'] as const) {
        families[family] = row(level[family]);
        for (let i = 1; i <= 6; i++) prompts.push({ id: `${family}-${i}`, family, coherence: level[family] + wobble(options.label, `${family}-${i}`) });
      }
      return { run: options.label, pool: options.pool, rubric: 'stand-in-rubric', samples: options.samples, usd: 0.2, families, prompts };
    },
  };
}

export function standInDeps(repo: string, log: (line: string) => void, agents: Agents, calibrated = true): Deps {
  return {
    repo,
    agents,
    measurer: standInMeasurer(),
    prepare: async () => undefined,
    checks: async () => [],
    sealedDir: null,
    taste: async () => (calibrated ? { n: 20, cut: 4, agreement: 0.8, kappa: 0.5, missed: [], byFamily: {} } : null),
    phrases: async () => ['a distinctive held out prompt sentence'],
    briefing: async (folder) => {
      await writeFile(join(folder, 'tune-summary.json'), '{}');
      return ['tune-summary.json'];
    },
    log,
  };
}
