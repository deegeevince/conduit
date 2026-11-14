// The two records. `loop/ledger.jsonl` is one line a fact, for machines; `loop/CHANGELOG.md` is the same facts in
// words, newest first, for people. Both are only ever appended to: a verdict is a new line and a new entry that
// names the experiment, never an edit of the old one. Every experiment is written, kept or not, refused or failed.

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExperimentRecord, Measure, Verdict } from './types';

export type LedgerLine =
  | ({ readonly kind: 'experiment' } & ExperimentRecord)
  | { readonly kind: 'verdict'; readonly id: string; readonly at: string; readonly by: 'steward'; readonly approve: boolean; readonly why: string; readonly merged: string | null }
  | { readonly kind: 'run'; readonly at: string; readonly spent: number; readonly budget: number; readonly stoppedBecause: string; readonly experiments: number };

const MARK = '<!-- entries -->';

const HEAD = `# Experiments

Every experiment the improvement loop runs is recorded here, kept or not, newest first. The loop appends; nobody edits an entry. The machine-readable record of the same experiments is \`loop/ledger.jsonl\`.

An entry says what was proposed and why, what was built, what the held-out set scored before and after, what was decided and by which rule, what the reviewer and the steward said, and what it cost.

${MARK}
`;

export async function readLedger(loopDir: string): Promise<LedgerLine[]> {
  const text = await readFile(join(loopDir, 'ledger.jsonl'), 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as LedgerLine);
}

export async function appendLedger(loopDir: string, line: LedgerLine): Promise<void> {
  await mkdir(loopDir, { recursive: true });
  await appendFile(join(loopDir, 'ledger.jsonl'), `${JSON.stringify(line)}\n`);
}

/** Puts an entry at the top of the changelog, under the preamble. A changelog from before the marker is brought to it once, keeping its words. */
export async function appendChangelog(loopDir: string, entry: string): Promise<void> {
  await mkdir(loopDir, { recursive: true });
  const path = join(loopDir, 'CHANGELOG.md');
  let text = await readFile(path, 'utf8').catch(() => HEAD);
  if (!text.includes(MARK)) text = `${text.replace(/\n*Nothing has been run yet\.\s*$/, '\n')}\n${MARK}\n`;
  const at = text.indexOf(MARK) + MARK.length;
  await writeFile(path, `${text.slice(0, at)}\n\n${entry.trim()}\n${text.slice(at)}`);
}

function numbers(measure: Measure | null): string {
  if (measure === null) return 'not measured';
  return Object.entries(measure.families)
    .map(([family, row]) => `${family} ${row.coherence.toFixed(2)} (n=${row.n}, correct ${Math.round(row.correct * 100)}%)`)
    .join('; ');
}

export function entryFor(record: ExperimentRecord): string {
  const p = record.proposal;
  const lines = [
    `## ${record.started.slice(0, 10)} ${record.id}: ${p.title} (${record.outcome})`,
    '',
    `Kind: ${p.kind}. Aimed at: ${p.aims.join(', ')}. Branch: \`${record.branch}\`.`,
    '',
    `Why: ${p.hypothesis}`,
    '',
    `Built: ${record.diff.length === 0 ? 'nothing' : record.diff.map((change) => `${change.file} (+${change.added} -${change.removed})`).join(', ')}.`,
  ];
  if (record.refused.length > 0) lines.push('', `Refused before it was measured: ${record.refused.join('; ')}.`);
  if (record.before !== null || record.after !== null) {
    lines.push('', `Held-out, baseline: ${numbers(record.before)}.`, `Held-out, candidate: ${numbers(record.after)}.`);
  }
  if (record.decision !== null) lines.push('', `Decision: ${record.decision.keep ? 'kept' : 'discarded'}. ${record.decision.reasons.join('; ')}.`);
  for (const verdict of record.verdicts) lines.push('', `${verdict.by === 'reviewer' ? 'Reviewer' : 'Steward'} ${verdict.approve ? 'found nothing wrong' : 'objected'}: ${verdict.why}`);
  lines.push('', record.taste === null ? 'Taste: no sheet of the owner\'s scores yet, so the judge\'s steering is unchecked.' : `Taste: the judge agreed with the owner ${Math.round(record.taste.agreement * 100)}% (kappa ${record.taste.kappa.toFixed(2)}).`);
  lines.push('', `Cost: $${record.usd.toFixed(2)}.`);
  return lines.join('\n');
}

export function verdictEntry(id: string, verdict: Verdict, merged: string | null): string {
  return [`## ${new Date().toISOString().slice(0, 10)} ${id}: steward ${verdict.approve ? 'approved' : 'refused'}`, '', verdict.why, '', merged === null ? 'Nothing was merged.' : `Merged into the integration branch as ${merged}.`].join('\n');
}

export async function record(loopDir: string, entry: ExperimentRecord): Promise<void> {
  await appendLedger(loopDir, { kind: 'experiment', ...entry });
  await appendChangelog(loopDir, entryFor(entry));
}
