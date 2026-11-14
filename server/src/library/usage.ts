// How the library is used: how often each technique was handed over, and how
// the answers it rode in judged. Read from two places and nothing else: the
// session logs (the brief of every real turn carries the technique block, so
// its titles are counted from there) and the battery runs (each answer lists
// the technique ids its brief carried and the judge's coherence score).
//
// The graduation flag is a prompt to a person, not a decision: a technique
// that is handed over often, scores well when it is, and has done so across
// several runs is a candidate to become part of the language or the painter,
// where it costs the brief nothing. A technique that is handed over often and
// does not lift the score is flagged the other way.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExploreIndexEntry, ExploreResult, ExploreRun } from '@conduit/language';
import type { Technique } from '../domain/techniques';

export interface UsageRow {
  readonly title: string;
  /** turns of real sessions whose brief carried it */
  readonly turns: number;
  /** battery answers whose brief carried it */
  readonly answers: number;
  readonly runs: number;
  /** mean judge coherence (1 to 5) of those answers; null when none was judged */
  readonly meanCoherence: number | null;
  /** mean coherence of the answers in the same runs that did not carry it */
  readonly without: number | null;
  readonly flag: 'graduate' | 'no lift' | null;
}

export const GRADUATE = { answers: 12, runs: 2, coherence: 4 } as const;

function listDir(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function collectUsage(techniques: readonly Technique[], logDir: string | null, exploreDir: string): UsageRow[] {
  const byTitle = new Map<string, Technique>();
  const titleOfId = new Map<string, string>();
  for (const technique of techniques) {
    byTitle.set(technique.title, technique);
    titleOfId.set(technique.id, technique.title);
  }
  const turns = new Map<string, number>();
  if (logDir !== null) {
    for (const name of listDir(logDir)) {
      if (!name.endsWith('.jsonl')) continue;
      for (const raw of readFileSync(join(logDir, name), 'utf8').split('\n')) {
        if (!raw.includes('TECHNIQUES THAT FIT')) continue;
        try {
          const record = JSON.parse(raw) as { type?: string; text?: string };
          if (record.type !== 'brief' || typeof record.text !== 'string') continue;
          const block = record.text.slice(record.text.indexOf('TECHNIQUES THAT FIT'));
          for (const title of byTitle.keys()) if (block.includes(`\n- ${title}. `)) turns.set(title, (turns.get(title) ?? 0) + 1);
        } catch {
          // a torn line at the end of a live log
        }
      }
    }
  }
  const scores = new Map<string, number[]>();
  const answersOf = new Map<string, number>();
  const runsOf = new Map<string, Set<string>>();
  const withoutOf = new Map<string, number[]>();
  const runsDir = join(exploreDir, 'runs');
  for (const run of listDir(runsDir)) {
    let index: ExploreRun;
    try {
      index = JSON.parse(readFileSync(join(runsDir, run, 'index.json'), 'utf8')) as ExploreRun;
    } catch {
      continue;
    }
    const inRun: { titles: Set<string>; score: number | null }[] = [];
    for (const entry of index.prompts as readonly ExploreIndexEntry[]) {
      if (entry.kind === 'case') continue;
      let result: ExploreResult;
      try {
        result = JSON.parse(readFileSync(join(runsDir, run, `${entry.id}.json`), 'utf8')) as ExploreResult;
      } catch {
        continue;
      }
      const titles = new Set<string>();
      for (const id of result.techniques ?? []) {
        const title = titleOfId.get(id);
        if (title !== undefined) titles.add(title);
      }
      const judged = result.judge ?? null;
      inRun.push({ titles, score: judged !== null && judged.failure === null ? judged.coherence : null });
    }
    for (const title of byTitle.keys()) {
      if (!inRun.some((answer) => answer.titles.has(title))) continue;
      const set = runsOf.get(title) ?? new Set<string>();
      set.add(run);
      runsOf.set(title, set);
      for (const answer of inRun) {
        if (answer.titles.has(title)) {
          answersOf.set(title, (answersOf.get(title) ?? 0) + 1);
          if (answer.score !== null) scores.set(title, [...(scores.get(title) ?? []), answer.score]);
        } else if (answer.score !== null) withoutOf.set(title, [...(withoutOf.get(title) ?? []), answer.score]);
      }
    }
  }
  return [...byTitle.keys()].sort().map((title) => {
    const scored = scores.get(title) ?? [];
    const runs = runsOf.get(title)?.size ?? 0;
    const answers = answersOf.get(title) ?? 0;
    const handed = mean(scored);
    const without = mean(withoutOf.get(title) ?? []);
    let flag: UsageRow['flag'] = null;
    if (handed !== null && scored.length >= GRADUATE.answers && runs >= GRADUATE.runs) {
      if (handed >= GRADUATE.coherence) flag = 'graduate';
      else if (without !== null && handed <= without) flag = 'no lift';
    }
    return { title, turns: turns.get(title) ?? 0, answers, runs, meanCoherence: handed, without, flag };
  });
}
