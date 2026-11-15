// The technique library, as the server sees it.
//
// A technique is a recipe that judged well on a kind of answer: when to use
// it, a short worked example in Series, what failed before. Techniques live in
// Remote, on the Series account, one block each, linked from the Conduit root
// block. They are written by reviews and by the improvement loop, and handed
// to the brain a few at a time, in the turn's brief.
//
// Never in the system prompt. That is fixed for a conversation, so the warm
// process and the provider's prompt cache hold, and it is at its size limit.
//
// THE TURN NEVER WAITS FOR REMOTE. Choosing techniques for a turn is a
// function over an index held in memory: no network, no file, no model, well
// under a millisecond. The index is filled from three sources, best first:
//   1. Remote (the truth), read in the background at boot and every
//      `refreshMs`, in one call for the index and one per changed technique;
//   2. the file cache of the last good read (`<cacheDir>/*.json`), so a
//      restart with Remote unreachable serves what it last knew;
//   3. the seed in the repository (`techniques/seed/*.md`), so a fresh
//      checkout with no network and no login still hands over good recipes.
// A failed or slow refresh changes nothing a turn can see; it is logged once.
//
// This module is the domain: the types, the port, and the two pure functions
// (reading a technique's body, choosing techniques for a message). Adapters
// are under `server/src/library/`.

import { parseScript, TECHNIQUE_LIMITS } from '@conduit/language';
import type { TechniqueCard, TurnInput } from '@conduit/language';

/** Where a technique in the index came from. */
export type TechniqueSource = 'remote' | 'cache' | 'seed' | 'overlay';

/** One technique, as the library holds it. */
export interface Technique {
  /** the Remote block id; for a seed that has no block yet, `seed:<file name>` */
  readonly id: string;
  readonly title: string;
  /** the block's summary: says when it applies. Read without fetching the body, so it carries the words a message is matched on. */
  readonly summary: string;
  /** the link's reason from the root block: begins "only if …" */
  readonly reason: string;
  /** the block's fingerprint when it was read; what a write must send back */
  readonly fingerprint: string | null;
  readonly source: TechniqueSource;
  readonly body: TechniqueBody;
}

/**
 * A technique's body, read from its markdown. The layout is fixed so that a
 * program can read it and a person can write it:
 *
 *   <one line: what it is for>
 *
 *   **Use it when** <a sentence or dot points>
 *
 *   **Not when** <a sentence or dot points>
 *
 *   **Example**
 *   ```series
 *   <lines of Series; every one must parse>
 *   ```
 *
 *   **What failed** <what was tried and why it did not work>
 *
 *   **Score** <the number the last run produced, and on how many answers>
 *
 * Only `purpose`, `when`, `notWhen` and `example` are ever handed to the brain.
 */
export interface TechniqueBody {
  readonly purpose: string;
  readonly when: string;
  readonly notWhen: string;
  readonly example: readonly string[];
  readonly failed: string;
  readonly score: string;
  /** set when this technique has become part of the language or the painter: the block says so, and it is no longer handed over */
  readonly graduated: boolean;
}

const SECTION = /^\*\*(Use it when|Not when|Example|What failed|Score)\*\*\s*/i;

/** Reads a technique's body. Forgiving: a missing section is empty, never an error; `lintTechnique` is what refuses a bad one before it is written. */
export function parseTechniqueBody(markdown: string): TechniqueBody {
  const fields: Record<string, string[]> = { purpose: [], 'use it when': [], 'not when': [], example: [], 'what failed': [], score: [] };
  let current = 'purpose';
  let fenced = false;
  for (const raw of markdown.split('\n')) {
    const line = raw.trimEnd();
    if (line.trim().startsWith('```')) {
      fenced = !fenced;
      continue;
    }
    const heading = fenced ? null : SECTION.exec(line.trim());
    if (heading !== null) {
      current = (heading[1] ?? '').toLowerCase();
      const rest = line.trim().slice(heading[0].length).trim();
      if (rest !== '') fields[current]?.push(rest);
      continue;
    }
    if (current === 'example' && !fenced) continue;
    fields[current]?.push(current === 'example' ? line : line.trim());
  }
  const text = (name: string): string => (fields[name] ?? []).filter((line) => line !== '').join(' ').trim();
  const purpose = text('purpose');
  return {
    purpose,
    when: text('use it when'),
    notWhen: text('not when'),
    example: (fields['example'] ?? []).filter((line) => line.trim() !== ''),
    failed: text('what failed'),
    score: text('score'),
    graduated: /\b(?:is|now) part of (?:series|the language|the painter)\b/i.test(markdown),
  };
}

/** The title prefix of a technique that has been drafted from evidence and not yet measured. The brain's library never loads one: promotion (a retitle) is the improvement loop's and the steward's. */
export const PROPOSED_PREFIX = 'Proposed technique:';

export function isProposedTitle(title: string): boolean {
  return title.trim().toLowerCase().startsWith(PROPOSED_PREFIX.toLowerCase());
}

/** Why a technique may not be written to the library, one sentence each. Empty means it may. */
export function lintTechnique(title: string, summary: string, reason: string, markdown: string): string[] {
  const problems: string[] = [];
  const body = parseTechniqueBody(markdown);
  if (title.trim() === '') problems.push('it has no title');
  if (summary.trim().length < 24) problems.push('its summary does not say when it applies');
  if (!/^only if\b/i.test(reason.trim())) problems.push('its link reason does not begin "only if"');
  if (body.purpose === '') problems.push('its first line does not say what it is for');
  if (body.when === '') problems.push('it does not say when to use it');
  if (body.example.length === 0) problems.push('it has no example');
  if (body.example.length > 24) problems.push(`its example is ${body.example.length} lines; a recipe is 24 at most`);
  const parsed = parseScript(body.example.join('\n'));
  for (const reject of parsed.rejects) problems.push(`line ${reject.lineNumber} of its example does not parse: ${reject.raw.trim()}`);
  // The tree's rules for a block: present tense, no history, no dates, no change numbers.
  if (/\b(?:20\d\d-\d\d-\d\d|\d{1,2} (?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* 20\d\d)\b/i.test(markdown)) problems.push('it carries a date');
  if (/\b(?:PR|pull request|commit|issue) ?#?\d+/i.test(markdown) || /#\d{2,}/.test(markdown)) problems.push('it names a change by number');
  if (/\b(?:previously|used to|no longer|was changed|we changed|as of|formerly)\b/i.test(markdown)) problems.push('it tells history; say what is true now');
  if (/\b(?:sk-[a-z0-9]{8,}|api[_ -]?key|password|secret)\b/i.test(markdown)) problems.push('it may hold a secret');
  return problems;
}

/**
 * Query expansion: ways a person asks for a kind of answer that the techniques'
 * own summaries do not use. A cue is a pattern in the message; when it fires,
 * the words that the matching techniques are written in are added to what the
 * message said. They are cues about the shape of a request ("let me ...", "a
 * chart", "draw how ...") and never about a subject, so a new technique is
 * reached by them only if it is written in these words.
 */
const CUES: readonly (readonly [RegExp, readonly string[]])[] = [
  [/\b(?:charts?|graphs?|plot|histogram|distributions?|trend|curve|over time|since \d{4})\b/i, ['chart', 'number']],
  [/\b(?:homework|work ?sheets?|my (?:kid|child|son|daughter|boy|girl)|\d{1,2}[- ]?(?:year|yr)s?[- ]?olds?|sums?|times tables?|number bonds?|working[- ]?outs?|(?:show|work) (?:the |it |this |that )?(?:working|out)|lessons?|tutor\w*|practi[cs]e (?:sheet|questions))\b/i, ['homework', 'worksheet', 'child']],
  // the person wants to do the work or make the choice themselves: something to work out on the stage, checked on a press
  [/\b(?:make me|let me (?:guess|try|work|have a go|place|predict|think)|i(?:'ll| will) (?:have a go|try|guess)|quiz me|test me|fill in|what comes next|which (?:of these )?(?:one )?(?:suits|is better for) me|each step)\b/i, ['blank', 'quiz', 'guess']],
  [/\b(?:let me|slider|calculator|converter|play with|interactive|switch between|toggle|drag)\b/i, ['drag', 'interactive', 'explore']],
  [/\bdraw (?:me )?how\b|\bhow (?:does )?(?:a|an|the)\b[^?.]*\b(?:work|happen|pump|beat|move|flow|circulate|digest|breathe|turn|spin|rise|fall)s?\b|\bcross[- ]section\b|\banatomy\b/i, ['mechanism', 'machine', 'part']],
];

/**
 * A word used in another sense is not a subject: "the map function" is code,
 * "the word chart" is a word. The noun that follows (or the "word"/"term" that
 * precedes) says so, and the word is taken out of what the message is matched on.
 */
const OTHER_SENSE_AFTER = /\b([a-z][a-z-]+)\s+(?:function|functions|method|methods|operator|operators|keyword|keywords|statement|statements|command|syntax|data type|object|class|variable|parameter|argument|prop|hook|pattern)\b/gi;
const OTHER_SENSE_BEFORE = /\b(?:the |a )?((?:word|term|phrase|name|verb|noun|keyword|function|method|operator)s?) ["'`]?([a-z][a-z-]+)["'`]?/gi;

/** Words the message uses in a sense that is not a thing to draw. */
export function wordsInOtherSense(said: string): ReadonlySet<string> {
  const out = new Set<string>();
  for (const pattern of [OTHER_SENSE_AFTER, OTHER_SENSE_BEFORE]) {
    pattern.lastIndex = 0;
    for (const found of said.matchAll(pattern)) {
      if (pattern === OTHER_SENSE_BEFORE && found[1] !== undefined) out.add(stem(found[1]));
      const word = pattern === OTHER_SENSE_BEFORE ? found[2] : found[1];
      if (word !== undefined && !['the', 'a', 'an', 'this', 'that', 'each', 'every', 'one', 'my', 'your'].includes(word.toLowerCase())) out.add(stem(word));
    }
  }
  return out;
}

/** A question about a meaning or a usage, with nothing in it that asks to see something: what a plain answer is. */
const CONCEPT_ASK = /^\s*(?:please\s+)?(?:explain|what(?:'s| is| are| does)|define|describe|tell me (?:about|what)|meaning of|how (?:do|does|can|should) (?:i|you|we) (?:use|write|call|read|pronounce))\b/i;
const ASKS_TO_SEE = /\b(?:draw|diagram|picture|illustrate|visuali[sz]e|sketch|paint|animate|chart|graph|plot|show me|cross[- ]section|map of|timeline of|flowchart|flow chart|step by step|walk me through|how does (?:a|an|the)\b[^?.]*\bwork)\b/i;

/** What a message is matched on. */
export interface TechniqueQuery {
  readonly input: TurnInput;
  /** the turn has a document: techniques for answering from one are in play */
  readonly documents: boolean;
}

export interface TechniqueHit {
  readonly technique: Technique;
  /** higher is a better fit; comparable only within one query */
  readonly score: number;
  /** the words that matched, for the session log and for `pnpm library match` */
  readonly matched: readonly string[];
}

const STOP = new Set(
  'a an and are as at be but by can do for from has have how i if in into is it its me my of on or so that the their them then there this to up was we what when where which who why will with you your show draw make tell give explain please like about out over than too very just only use used using does not one two thing things way ways go goes going get gets keep keeps last top point need want take takes good better best some any all more most much many'.split(
    ' ',
  ),
);

/** A word reduced to what it shares with its relatives: lower case, plural and common endings off. Crude on purpose: fast, and wrong the same way on both sides of a match. */
function stem(word: string): string {
  let out = word.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (out.length > 5 && out.endsWith('ing')) out = out.slice(0, -3);
  else if (out.length > 4 && out.endsWith('ies')) out = `${out.slice(0, -3)}y`;
  else if (out.length > 4 && out.endsWith('ed')) out = out.slice(0, -2);
  else if (out.length > 3 && out.endsWith('es')) out = out.slice(0, -2);
  else if (out.length > 3 && out.endsWith('s') && !out.endsWith('ss')) out = out.slice(0, -1);
  return out;
}

function wordsOf(text: string): string[] {
  return text
    .split(/[^A-Za-z0-9]+/)
    .map(stem)
    .filter((word) => word.length > 1 && !STOP.has(word));
}

/**
 * What a technique is matched on, built once when the index is filled: its
 * summary and its link reason, which are written to say when it applies, and
 * its title. Not its body: the prose of "use it when" is full of ordinary
 * words, and a recipe handed over because a question happened to say "water"
 * or "last" does harm.
 */
export interface TechniqueTerms {
  readonly technique: Technique;
  readonly weights: ReadonlyMap<string, number>;
  /** the words of its title: what it is. One of these is enough to match on; any other word needs company. */
  readonly named: ReadonlySet<string>;
  /** words that rule it out, from "Not when" */
  readonly against: ReadonlySet<string>;
}

export function termsOf(technique: Technique): TechniqueTerms {
  const weights = new Map<string, number>();
  const add = (text: string, weight: number): void => {
    for (const word of wordsOf(text)) weights.set(word, Math.max(weights.get(word) ?? 0, weight));
  };
  add(technique.title, 1);
  add(technique.summary, 1);
  add(technique.reason, 1.5);
  const for_ = new Set(weights.keys());
  const against = new Set(wordsOf(technique.body.notWhen).filter((word) => !for_.has(word)));
  return { technique, weights, named: new Set(wordsOf(technique.title)), against };
}

/** The least a technique must score to be handed over. */
export const MATCH_FLOOR = 2.2;
/** A second or third technique is handed over only when it scores at least this share of the best one. */
export const MATCH_NEAR = 0.6;

/**
 * The few techniques that fit a message, best first. Pure and fast: a few
 * dozen techniques and a sentence are matched in microseconds, with no
 * network, file or model on the path.
 *
 * A word counts for more the fewer techniques use it, so "diagram" (which
 * most name) says little and "timeline" says a lot. Precision matters more
 * than reach: a recipe that does not fit is worse than none, because a model
 * copies what it is shown. So a technique must clear a floor, must match on
 * two words or on one word of its own title, and must come close to the best.
 */
export function selectTechniques(index: readonly TechniqueTerms[], query: TechniqueQuery, limit: number = TECHNIQUE_LIMITS.cards): TechniqueHit[] {
  const said = query.input.kind === 'prompt' || query.input.kind === 'tap' || query.input.kind === 'act' ? query.input.text : '';
  const other = wordsInOtherSense(said);
  const words = new Set(wordsOf(said).filter((word) => !other.has(word)));
  // An ask for a meaning or a usage, with nothing that asks to see: one word of a recipe's name is not enough to hand it over.
  const seeable = said.split(/\s+/).filter((word) => !other.has(stem(word))).join(' ');
  const conceptual = CONCEPT_ASK.test(said) && !ASKS_TO_SEE.test(seeable);
  for (const [cue, anchors] of CUES) if (!conceptual && cue.test(said)) for (const anchor of anchors) words.add(anchor);
  if (query.documents) for (const word of ['document', 'paper', 'report', 'article']) words.add(word);
  if (words.size === 0 || index.length === 0) return [];
  const spread = new Map<string, number>();
  for (const entry of index) for (const word of entry.weights.keys()) spread.set(word, (spread.get(word) ?? 0) + 1);
  const hits: TechniqueHit[] = [];
  for (const entry of index) {
    if (entry.technique.body.graduated || entry.technique.body.example.length === 0) continue;
    let score = 0;
    let named = false;
    const matched: string[] = [];
    for (const word of words) {
      const weight = entry.weights.get(word);
      if (weight !== undefined) {
        score += weight * Math.log(1 + index.length / (spread.get(word) ?? 1));
        matched.push(word);
        if (entry.named.has(word)) named = true;
      }
      if (entry.against.has(word)) score -= 1;
    }
    if (score >= MATCH_FLOOR && (matched.length >= 2 || (named && !conceptual))) hits.push({ technique: entry.technique, score, matched });
  }
  hits.sort((a, b) => b.score - a.score || a.technique.title.localeCompare(b.technique.title));
  const best = hits[0]?.score ?? 0;
  return hits.filter((hit) => hit.score >= best * MATCH_NEAR).slice(0, limit);
}

/** A technique as the brain is handed it. */
export function cardOf(technique: Technique): TechniqueCard {
  const { body } = technique;
  const not = body.notWhen === '' ? '' : ` Not when ${body.notWhen.replace(/^not when\s*/i, '')}`;
  return { id: technique.id, title: technique.title, when: `${body.when === '' ? body.purpose : body.when}${not}`.trim(), example: body.example };
}

/** How the last refresh went, for `pnpm library status` and the boot log. */
export interface LibraryStatus {
  readonly techniques: number;
  readonly bySource: Readonly<Record<TechniqueSource, number>>;
  /** ISO time of the last read of Remote that succeeded; null when none has */
  readonly refreshedAt: string | null;
  /** why the last read failed, in a sentence; null when it did not */
  readonly failure: string | null;
}

/**
 * The port. `cardsFor` is what a turn calls, and it never waits: it answers
 * from memory, whatever state the sources are in. `refresh` is what the
 * background calls; nothing in a turn awaits it.
 */
export interface TechniqueLibrary {
  cardsFor(query: TechniqueQuery): readonly TechniqueCard[];
  /** the same choice with its scores, for the log and the tools */
  match(query: TechniqueQuery): readonly TechniqueHit[];
  refresh(signal: AbortSignal): Promise<LibraryStatus>;
  status(): LibraryStatus;
  close(): void;
}

export type LibrarySettings =
  /** no techniques are handed over */
  | { readonly kind: 'none' }
  /** the seed in the repository only: no network, no login */
  | { readonly kind: 'seed'; readonly seedDir: string; readonly overlayDir: string | null }
  | {
      readonly kind: 'remote';
      readonly bin: string;
      /** the account the library lives on: `series@example.invalid` */
      readonly actor: string;
      readonly env: 'prod' | 'local';
      /** the Conduit root block every technique hangs off */
      readonly root: string;
      readonly seedDir: string;
      readonly cacheDir: string;
      /** techniques laid over the library for one experiment: the improvement loop's candidates, never written to Remote until kept and approved */
      readonly overlayDir: string | null;
      readonly refreshMs: number;
      /** one call to Remote may take this long before it is given up on */
      readonly timeoutMs: number;
    };

/**
 * A technique to write, and where. The write path is not the read path: it
 * is used by the tools (`pnpm library`) and the improvement loop, never by a
 * turn. Every write follows the tree's rules: read the block again first,
 * send the fingerprint from that read, re-apply on a conflict, and never
 * write what `lintTechnique` refuses.
 */
export interface TechniqueDraft {
  /** the block to rewrite; null to create one and link it from the root */
  readonly id: string | null;
  readonly title: string;
  readonly summary: string;
  /** required for a new block; begins "only if" */
  readonly reason: string;
  readonly markdown: string;
}

export type WriteResult =
  | { readonly outcome: 'written'; readonly id: string; readonly fingerprint: string }
  /** the block changed since it was read: `current` is what is there now; re-apply the change to it and write again */
  | { readonly outcome: 'conflict'; readonly id: string; readonly current: string; readonly fingerprint: string }
  | { readonly outcome: 'refused'; readonly problems: readonly string[] };

export interface TechniqueWriter {
  /** the block as it is now, with the fingerprint a write must carry */
  read(id: string, signal: AbortSignal): Promise<{ readonly markdown: string; readonly fingerprint: string; readonly title: string; readonly summary: string } | null>;
  write(draft: TechniqueDraft, baseFingerprint: string | null, signal: AbortSignal): Promise<WriteResult>;
}
