// What each agent is told, and how the critic's and the reviewer's answers are read back.
// The briefs say what is wanted; what is allowed is enforced by code (agents.ts, guard.ts), not by these words.

import { EXPERIMENT_ORDER } from './types';
import type { ExperimentKind, Proposal } from './types';
import type { ExploreFamily } from '@conduit/language';

const FAMILIES: readonly ExploreFamily[] = ['diagram', 'chart', 'explorable', 'mechanism', 'scene', 'type', 'plain', 'pixels', 'paint', 'motion', 'open'];

export function criticPrompt(experiments: number, files: readonly string[]): string {
  return `You are the critic of an improvement loop for Conduit, a product that lets a language model answer by drawing on an animated stage.
Your working folder holds the briefing: ${files.join(', ')}. Read them. They hold the TUNE set's judgements (scores, the judge's complaints, the painter's geometry counts), the technique index, and the language reference. When it is listed, findings.jsonl holds what a second judge found in real turns the owner had (one JSON line each: what was asked, the score, the problems, the suggestions): evidence from real use, to weigh beside the tune set, never to be quoted back. You are never shown the held-out set; do not ask for it or guess at it.

Find what is missing, not what is wrong in one answer: a kind of answer that is drawn badly because the model was never taught how, a building block the painter lacks, a look that cannot say what is asked, a wording of the prompt that misleads. Propose at most ${experiments} experiments, cheapest to build and to undo first, in this order of kinds: ${EXPERIMENT_ORDER.join(', ')}.

Rules for a proposal: it names a kind of answer, never a prompt from the briefing; it must not quote the tune prompts (a change that quotes them is refused); it aims at the families listed in its "aims" and you say which tune answers show the need. Prefer one change that helps many prompts to many changes.

Answer with one JSON array in a \`\`\`json block and nothing after it. Each item:
{"kind": ${EXPERIMENT_ORDER.map((kind) => `"${kind}"`).join(' | ')}, "title": "...", "hypothesis": "two or three sentences: what is missing and why this supplies it", "aims": [families from: ${FAMILIES.join(', ')}], "evidence": ["file stems of the tune answers"], "brief": "what to build, for a builder who has not seen the briefing"}`;
}

export function builderPrompt(proposal: Proposal, refusal: readonly string[]): string {
  const where =
    proposal.kind === 'technique'
      ? 'A technique is a markdown file in techniques/overlay/ (read one in techniques/seed/ for the form). The steward moves it into techniques/seed/ if it is kept.'
      : proposal.kind === 'prompt'
        ? 'Change only language/src/prompt.ts, and keep `pnpm prompt count` within its budget.'
        : proposal.kind === 'style'
          ? 'Change only what a look or the styles decide (web/src/looks, web/src/styles, web/src/render).'
          : 'Add or change a building block in the painter or the language.';
  return `You are the builder of one experiment of an improvement loop. Your working folder is a plain export of the repository (no git, no node_modules); nothing outside it can be read. Do exactly this and nothing else.

Experiment: ${proposal.title} (${proposal.kind})
Why: ${proposal.hypothesis}
What to build: ${proposal.brief}

${where}

Hard rules, enforced by code after you finish (a diff that breaks one is thrown away unmeasured):
- Do not touch explore/, loop/, server/src/loop/, the battery or taste tools, language/src/{explore,taste,review}.ts, package.json, lockfiles, .env or .claude/. You cannot edit them, and trying wastes your turn.
- Do not copy any prompt from a battery into source. Teach the kind of answer, not the question.
- Stay inside what a ${proposal.kind} experiment changes.
- Strict TypeScript, no new dependency. You have no shell and cannot run anything: the runner runs \`pnpm typecheck\`, \`pnpm timeline\` and \`pnpm prompt count\` on what you wrote and tells you if one fails, so write carefully and read what you wrote back.
- Your folder is a plain export of the repository: there is no git in it. Leave the files changed there.
${refusal.length === 0 ? '' : `\nYour last attempt was refused for this, so do not repeat it:\n${refusal.map((reason) => `- ${reason}`).join('\n')}\n`}
When done, reply with two sentences: what you changed and what you did not.`;
}

export function reviewerPrompt(proposal: Proposal): string {
  return `You are the reviewer of an improvement loop for Conduit. Your working folder holds diff.patch (what a builder changed), numbers.md (held-out scores on the baseline and on the candidate, and the rule's reasons), and proposal.md.
Read them cold. The numbers say the change helped. Your only job is to look for a gain that is the TEST being gamed rather than the answers being better: text that mirrors a battery prompt or its expected checks, branching on a prompt's wording, a technique that is the answer to one question, a change that tells the judge what to think, a change that makes the painter report fewer problems instead of drawing fewer, a cost moved somewhere the numbers do not look (tokens, time, the prompt's size, another family).
Also say if the change is not worth keeping for its weight in code even though it scored.
Answer with one JSON object in a \`\`\`json block and nothing after it: {"approve": true|false, "why": "plain words: what you checked and what you found"}. Approve only if you looked at the diff line by line and found nothing. Experiment: ${proposal.title}.`;
}

function jsonBlock(text: string): unknown {
  const fenced = /```json\s*([\s\S]*?)```/.exec(text);
  const raw = fenced?.[1] ?? text.slice(Math.max(0, text.search(/[[{]/)));
  try {
    return JSON.parse(raw);
  } catch {
    const end = Math.max(raw.lastIndexOf(']'), raw.lastIndexOf('}'));
    try {
      return end < 0 ? null : JSON.parse(raw.slice(0, end + 1));
    } catch {
      return null;
    }
  }
}

/** Reads the critic's answer. Anything malformed is dropped with its reason, never repaired into something the critic did not say. */
export function readProposals(text: string, stamp: string, max: number, forbidden: readonly string[]): { readonly proposals: Proposal[]; readonly dropped: string[] } {
  const parsed = jsonBlock(text);
  const dropped: string[] = [];
  if (!Array.isArray(parsed)) return { proposals: [], dropped: ['the critic did not answer with a JSON array'] };
  const proposals: Proposal[] = [];
  for (const [index, item] of parsed.entries()) {
    const row = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    const kind = row['kind'];
    const aims = Array.isArray(row['aims']) ? row['aims'].filter((aim): aim is ExploreFamily => FAMILIES.includes(aim as ExploreFamily)) : [];
    const title = row['title'];
    const hypothesis = row['hypothesis'];
    const brief = row['brief'];
    if (!EXPERIMENT_ORDER.includes(kind as ExperimentKind) || typeof title !== 'string' || typeof hypothesis !== 'string' || typeof brief !== 'string' || aims.length === 0) {
      dropped.push(`proposal ${index + 1} is missing a kind, title, hypothesis, brief or a known family to aim at`);
      continue;
    }
    const lower = `${title} ${hypothesis} ${brief}`.toLowerCase().replace(/\s+/g, ' ');
    if (forbidden.some((phrase) => lower.includes(phrase.toLowerCase()))) {
      dropped.push(`proposal ${index + 1} ("${title}") quotes a battery prompt`);
      continue;
    }
    proposals.push({
      id: `${stamp}-${proposals.length + 1}`,
      kind: kind as ExperimentKind,
      title,
      hypothesis,
      aims,
      evidence: Array.isArray(row['evidence']) ? row['evidence'].filter((entry): entry is string => typeof entry === 'string') : [],
      brief,
    });
  }
  proposals.sort((a, b) => EXPERIMENT_ORDER.indexOf(a.kind) - EXPERIMENT_ORDER.indexOf(b.kind));
  return { proposals: proposals.slice(0, max), dropped };
}

export function readVerdict(text: string): { readonly approve: boolean; readonly why: string } {
  const parsed = jsonBlock(text) as { approve?: unknown; why?: unknown } | null;
  // a reviewer that did not answer in the form is not an approval
  if (parsed === null || typeof parsed !== 'object' || typeof parsed.approve !== 'boolean') return { approve: false, why: 'the reviewer did not answer in the form asked for; treated as an objection' };
  return { approve: parsed.approve, why: typeof parsed.why === 'string' ? parsed.why : '' };
}
