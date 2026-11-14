// Attention into the improvement loop (SA10). Not part of the server. Reads session logs; changes nothing it reads.
//
//   pnpm attention                         read <DATA_DIR>/logs, print the report, write <DATA_DIR>/lessons/proposed-<time>.json
//   --data <dir>                           the data folder (default: DATA_DIR, else the owner's); only `logs/` is read, only `lessons/` is written
//   --out <dir>                            write the proposal file here instead of <data>/lessons
//   --no-file                              print only
//   --json                                 print the proposal file's JSON instead of the report
//   --to-remote <file> [--only L1,L2]     the owner's approval step for technique-card lessons: plan the `Proposed technique:` blocks
//                                          the lessons loop already writes. A dry run, printing the exact Remote commands.
//      --write                             run them. Only the steward's session may (REMOTE_AGENT=conduit-steward, REMOTE_SESSION_ID set).
//   --to-queue <file> [--only L1,L2]       append approved painter and kit lessons to loop/queue/painter-bugs.md (the steward's ticket list)
//
// Per turn it joins the `attention` record (shown, pulled, ignore, open, cleared) with that turn's critic finding (gate, owner, evidence,
// repeats), its sight and its observations. Then: what the brain saw and left; "ignored and it mattered"; the failures that repeat per gate
// and owner; and lessons PROPOSED from them. A lesson is a short rule, with its evidence, and a place it would go. Nothing is applied.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataPaths, resolveDataDir, withDataFlag } from '../data-dir';
import { PROPOSED_PREFIX, lintTechnique } from '../domain/techniques';
import type { Technique } from '../domain/techniques';
import { readTechniqueDir } from '../library/files';
import { createRemoteWriter, STEWARD, stewardIdentity } from '../library/remote/remote-cli';
import type { RemoteSettings } from '../library/remote/remote-cli';
import { CONDUIT_ROOT_BLOCK } from '../env';
import { createLogger } from '../log';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const out = (text: string): void => void process.stdout.write(`${text}\n`);
const fail = (text: string): never => {
  process.stderr.write(`attention: ${text}\n`);
  return process.exit(2);
};

// ---------- the join ----------

interface Problem {
  readonly what: string;
  readonly evidence: string;
  readonly weight: string;
  /** the critic's gate, or one read from the words when the finding came before gates (`inferred`) */
  readonly gate: string | null;
  readonly owner: string | null;
  readonly inferred: boolean;
}
interface Finding {
  readonly pass: number;
  readonly coherence: number | null;
  readonly problems: readonly Problem[];
  readonly repeats: readonly { gate: string; count: number; turns: readonly string[] }[];
}
interface Held {
  readonly rev: readonly number[];
  readonly shown: readonly string[];
  readonly pulled: readonly { tool: string; kind: string; n: number }[];
  readonly watch: readonly string[];
  readonly ignore: readonly string[];
  readonly refusedIgnore: readonly string[];
  readonly cleared: readonly string[];
  readonly open: readonly string[];
  readonly urgent: number;
  readonly calls: number;
}
interface Turn {
  readonly log: string;
  readonly id: string;
  asked: string;
  held: Held | null;
  finding: Finding | null;
  /** every observation the log stored for the turn, as `kind|on|rule` with its words */
  obs: { fingerprint: string; kind: string; on: string | null; note: string }[];
  /** the notes the page saw on the turn's resting stage */
  sight: { id: string; notes: string[]; resting: boolean }[];
  /** element id -> the words it showed */
  words: Map<string, string>;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strs = (v: unknown): string[] => (Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === 'string') : []);
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});

/** Which family of failure a critic problem is, from its words. A problem may be in two. */
const FAMILIES: readonly { readonly id: string; readonly label: string; readonly gate: string; readonly re: RegExp }[] = [
  { id: 'tiny-text', label: 'tiny or faint text', gate: 'readable', re: /\b(tiny|too small|small (?:and|grey|gray|dim|text|two)|illegible|hard to read|low[- ]contrast|faint|dim (?:grey|gray|text)|can(?:no|')t be read|cannot be read|thumbnail)\b/i },
  { id: 'callout-side', label: 'a callout or label on the wrong side, or pointing at the wrong thing', gate: 'composition', re: /\b(callouts?|leader|label[s]? (?:point|sits? inside|is (?:placed|drawn) on)|point(?:s|ing)? at the wrong|wrong (?:side|part|shape)|other side|opposite side|on the wrong|truncated with an ellipsis|label[s]? (?:is|are) (?:cut|crossed|truncated)|crossed by (?:the|a) (?:chart )?line)\b/i },
  { id: 'overlap', label: 'text sitting on top of other text or drawings', gate: 'no-overlap', re: /\b(overlap|sits? on top|on top of|collid|run(?:s)? into|cutting through|covers?|hiding|hides|clipped|crossed)\b/i },
  { id: 'coordinate-placement', label: 'hand-placed positions that scatter, float or leave the stage empty', gate: 'composition', re: /\b(scattered|float(?:s|ing)?|tucked|off[- ]centre|off[- ]center|offset|misaligned|not aligned|(?:different|own) axis|align (?:the|them|it)|empty (?:margin|stage|space)|mostly (?:empty|blank)|scale (?:it|them|the \w+) up|out of place|leaving wide|small band|corner while)\b/i },
  { id: 'subject-missing', label: 'the subject or a thing the caption names is not drawn', gate: 'answers-ask', re: /\b(not drawn|never appears?|is(?:n't| not) (?:shown|drawn)|nowhere on the stage|no .{0,30} (?:drawn|appears?)|missing)\b/i },
];

const familiesOf = (p: Pick<Problem, 'what' | 'evidence'>): string[] => FAMILIES.filter((f) => f.re.test(`${p.what} ${p.evidence}`)).map((f) => f.id);
const gateFromWords = (p: Pick<Problem, 'what' | 'evidence'>): string | null => {
  const f = FAMILIES.find((one) => one.re.test(`${p.what} ${p.evidence}`));
  return f === undefined ? null : f.gate;
};

function findingFrom(raw: unknown): Finding | null {
  const f = obj(raw);
  if (!Array.isArray(f['problems'])) return null;
  const problems: Problem[] = [];
  for (const entry of f['problems'] as unknown[]) {
    const p = obj(entry);
    if (str(p['what']) === '') continue;
    const base = { what: str(p['what']), evidence: str(p['evidence']) };
    const gate = str(p['gate']) || null;
    problems.push({ ...base, weight: str(p['weight']) || 'hurts', gate: gate ?? gateFromWords(base), owner: str(p['owner']) || null, inferred: gate === null });
  }
  const repeats = (Array.isArray(f['repeats']) ? (f['repeats'] as unknown[]) : []).map((r) => ({ gate: str(obj(r)['gate']), count: Number(obj(r)['count']) || 0, turns: strs(obj(r)['turns']) }));
  return { pass: typeof f['pass'] === 'number' ? f['pass'] : 1, coherence: typeof f['coherence'] === 'number' ? f['coherence'] : null, problems, repeats };
}

/** v3. What became of the repairs the server tried after the critic judged an answer broken (`repair` records), by gate. */
export interface RepairTally {
  readonly tried: number;
  readonly kept: number;
  readonly refused: number;
  readonly other: number;
  readonly byGate: ReadonlyMap<string, { tried: number; kept: number; refused: number }>;
  /** the critic's own score before and after, for the repairs it judged again */
  readonly judged: readonly { readonly before: number; readonly after: number }[];
}

function readRepairs(logsDir: string): RepairTally {
  const byGate = new Map<string, { tried: number; kept: number; refused: number }>();
  const judged: { before: number; after: number }[] = [];
  let tried = 0;
  let kept = 0;
  let refused = 0;
  let other = 0;
  if (existsSync(logsDir)) {
    for (const name of readdirSync(logsDir).filter((n) => n.endsWith('.jsonl')).sort()) {
      for (const line of readFileSync(join(logsDir, name), 'utf8').split('\n')) {
        if (!line.includes('"repair')) continue;
        let row: Record<string, unknown>;
        try {
          row = obj(JSON.parse(line));
        } catch {
          continue;
        }
        const type = str(row['type']);
        if (type === 'repair-judged') {
          judged.push({ before: Number(row['coherenceBefore']) || 0, after: Number(row['coherenceAfter']) || 0 });
          continue;
        }
        const state = str(row['state']);
        // a repair is tried once the brain has been asked: a limit that held it back (skipped) or a new turn that cancelled it are not
        if (type !== 'repair' || state === 'skipped') continue;
        tried += 1;
        if (state === 'kept') kept += 1;
        else if (state === 'refused') refused += 1;
        else other += 1;
        for (const gate of strs(row['gates'])) {
          const slot = byGate.get(gate) ?? { tried: 0, kept: 0, refused: 0 };
          slot.tried += 1;
          if (state === 'kept') slot.kept += 1;
          else if (state === 'refused') slot.refused += 1;
          byGate.set(gate, slot);
        }
      }
    }
  }
  return { tried, kept, refused, other, byGate, judged };
}

function readLogs(logsDir: string): Turn[] {
  const turns: Turn[] = [];
  if (!existsSync(logsDir)) return turns;
  for (const name of readdirSync(logsDir).filter((n) => n.endsWith('.jsonl')).sort()) {
    const latest = new Map<string, Turn>();
    const at = (id: string): Turn | null => latest.get(id) ?? null;
    for (const line of readFileSync(join(logsDir, name), 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      let row: Record<string, unknown>;
      try {
        row = obj(JSON.parse(line));
      } catch {
        continue;
      }
      const type = str(row['type']);
      const id = str(row['turn']);
      if (type === 'turn') {
        const turn: Turn = { log: name, id, asked: str(obj(row['input'])['text']), held: null, finding: null, obs: [], sight: [], words: new Map() };
        latest.set(id, turn);
        turns.push(turn);
        continue;
      }
      const turn = at(id);
      if (turn === null) continue;
      if (type === 'attention') {
        const digest = obj(row['digest']);
        turn.held = {
          rev: Array.isArray(row['rev']) ? (row['rev'] as number[]) : [],
          shown: strs(row['shown']),
          pulled: (Array.isArray(row['pulled']) ? (row['pulled'] as unknown[]) : []).map((p) => ({ tool: str(obj(p)['tool']), kind: str(obj(p)['kind']), n: Number(obj(p)['n']) || 0 })),
          watch: strs(row['watch']),
          ignore: strs(row['ignore']),
          refusedIgnore: strs(row['refusedIgnore']),
          cleared: strs(row['cleared']),
          open: strs(row['open']),
          urgent: Number(digest['urgent']) || 0,
          calls: Number(row['calls']) || 0,
        };
      } else if (type === 'critic') {
        const found = findingFrom(row['finding']);
        if (found !== null && (turn.finding === null || found.pass >= turn.finding.pass)) turn.finding = found;
      } else if (type === 'obs') {
        const o = obj(row['obs']);
        turn.obs.push({ fingerprint: str(o['fingerprint']), kind: str(o['kind']), on: str(o['on']) || null, note: str(o['note']) });
      } else if (type === 'report') {
        const report = obj(row['report']);
        const sight = obj(report['sight']);
        turn.sight = (Array.isArray(sight['items']) ? (sight['items'] as unknown[]) : []).map((i) => ({ id: str(obj(i)['id']), notes: strs(obj(i)['notes']), resting: obj(i)['resting'] !== false }));
        for (const item of Array.isArray(report['shown']) ? (report['shown'] as unknown[]) : []) {
          const one = obj(item);
          if (str(one['id']) !== '' && str(one['text']) !== '') turn.words.set(str(one['id']), str(one['text']));
        }
      }
    }
  }
  return turns;
}

// ---------- what the brain did with what it was shown ----------

const parts = (fingerprint: string): { kind: string; on: string | null; rule: string } => {
  const [kind = '', on = '', ...rule] = fingerprint.split('|');
  return { kind, on: on === '' ? null : on, rule: rule.join('|') };
};

/** The gate classes a kind of observation would show up as in the critic's rubric. */
const GATES_OF_KIND: Readonly<Record<string, readonly string[]>> = {
  apart: ['no-overlap', 'composition'],
  inside: ['on-stage', 'composition'],
  present: ['on-stage', 'answers-ask'],
  legible: ['readable', 'polish'],
  fit: ['readable', 'polish', 'composition'],
  reachable: ['readable', 'on-stage'],
  steady: ['polish'],
  spoiler: ['answers-ask'],
  shell: ['on-stage'],
  refusal: ['on-stage'],
  fault: ['on-stage'],
};

type Fate = 'acted-on' | 'looked-at' | 'ignored' | 'shown-not-pulled' | 'never-shown';
interface Left {
  readonly turn: Turn;
  readonly fingerprint: string;
  readonly kind: string;
  readonly on: string | null;
  readonly rule: string;
  readonly fate: Fate;
}

function fates(turn: Turn): Left[] {
  const h = turn.held;
  if (h === null) return [];
  const pulledAll = h.pulled.some((p) => p.kind === 'all');
  const rows: Left[] = [];
  for (const fingerprint of h.open) {
    const { kind, on, rule } = parts(fingerprint);
    const cleared = h.cleared.includes(fingerprint);
    const pulled = pulledAll || h.pulled.some((p) => p.kind === kind);
    const fate: Fate = cleared ? 'acted-on' : h.ignore.includes(kind) ? 'ignored' : pulled ? 'looked-at' : h.shown.includes(fingerprint) ? 'shown-not-pulled' : 'never-shown';
    rows.push({ turn, fingerprint, kind, on, rule, fate });
  }
  return rows;
}

interface Matched {
  readonly left: Left;
  readonly problem: Problem;
  readonly by: 'element' | 'gate';
}

function matches(turn: Turn, left: Left): Matched | null {
  const finding = turn.finding;
  if (finding === null) return null;
  const quote = left.on === null ? null : turn.words.get(left.on)?.toLowerCase().slice(0, 24) ?? null;
  const element = left.on === null ? null : new RegExp(`(?:^|[^A-Za-z0-9_])${left.on.replace(/[^A-Za-z0-9_]/g, '\\$&')}(?:$|[^A-Za-z0-9_])`);
  for (const problem of finding.problems) {
    const text = `${problem.what} ${problem.evidence}`;
    if ((element !== null && element.test(text)) || (quote !== null && quote.length >= 5 && text.toLowerCase().includes(quote))) return { left, problem, by: 'element' };
  }
  const gates = GATES_OF_KIND[left.kind] ?? [];
  const problem = finding.problems.find((p) => p.gate !== null && gates.includes(p.gate));
  return problem === undefined ? null : { left, problem, by: 'gate' };
}

// ---------- lessons ----------

type Target =
  | { readonly kind: 'technique'; readonly card: string; readonly file: string }
  | { readonly kind: 'prompt'; readonly where: string }
  | { readonly kind: 'painter-ticket'; readonly where: string }
  | { readonly kind: 'kit-ticket'; readonly where: string };

interface Evidence {
  readonly session: string;
  readonly turn: string;
  readonly element: string | null;
  readonly gate: string | null;
  readonly owner: string | null;
  readonly said: string;
}
interface Lesson {
  id: string;
  family: string;
  title: string;
  rule: string;
  owner: string;
  target: Target;
  counts: { turns: number; sessions: number; problems: number; ignoredAndMattered: number; ownerSplit: Record<string, number> };
  evidence: Evidence[];
}

const RULES: Readonly<Record<string, { readonly rule: string; readonly ignoredRule: string }>> = {
  'tiny-text': {
    rule: 'Text the person must read is body size or larger and bright against its ground: a caption, caveat or footnote is never a small dim grey line, and a table is sized to be read, not to fit.',
    ignoredRule: 'When the digest lists text as "too small to make out" or "hard to read", pull it (canvas_observe legible) and raise the size and contrast before the turn ends; legible text is on the floor and cannot be ignored.',
  },
  'callout-side': {
    rule: 'A callout sits on the free side of the thing it names, with its leader ending on that part; on a shape that has a clear side use `beside=` or `below=` rather than a position that crosses the line or lands inside the body.',
    ignoredRule: 'When the digest lists a leader on the wrong part, a tangled leader or a label that spills, pull `apart` and `inside` and move the label to the open side before the turn ends.',
  },
  overlap: {
    rule: 'Two things that carry words never share a box: put a note, legend or chip row in a free band (below or beside) and leave a gap, rather than on top of the drawing it explains.',
    ignoredRule: 'When the digest says an element sits on top of text or its words run into other words, pull `apart`, move one of the two, and look again; do not put `apart` in ignore.',
  },
  'coordinate-placement': {
    rule: 'Place by relation (`below=`, `beside=`, a layout slot) and not by a coordinate pair written once; a coordinate-placed piece floats, scatters across axes or leaves the stage mostly empty. Fill the width the stage gives and align related pieces on one axis.',
    ignoredRule: 'When the digest says the picture is sparse or an element rests off its place, pull `fit` and re-place by relation before the turn ends.',
  },
  'subject-missing': {
    rule: 'Draw every thing the caption or the question names before writing words about it; a caption that refers to screens or a subject that is not on stage is a failed answer.',
    ignoredRule: 'When a line the answer rests on is reported not on stage at rest, pull `present` and draw it.',
  },
};

/** What a painter or kit ticket says: the symptom to reproduce, not a rule for the brain. */
const TICKETS: Readonly<Record<string, string>> = {
  'tiny-text': 'Text the brain wrote at ordinary sizes comes out tiny, faint or low-contrast (captions, footnotes, table headers, bar labels). Check the size floor and the contrast the painter gives small and dim text, and what the layout shrinks to fit.',
  'callout-side': 'Callouts and labels land inside the shape, cross the chart line, are cut with an ellipsis or point at the wrong part. Check where the layout puts a label relative to its subject and where the leader ends.',
  overlap: 'Text drawn over text or over a drawing, and text clipped at the stage edge, with Series that placed nothing on top. Check the layout engine on notes, legends and chip rows.',
  'coordinate-placement': 'Pieces that were placed by position come out floating, scattered across axes, shrunk to the top or leaving a large band empty. Check how coordinate placement and the fit-to-stage scale resolve.',
  'subject-missing': 'A thing the lines name is not on stage at rest. Check what the layout drops to make room.',
};

function pickCard(cards: readonly Technique[], asked: readonly string[]): Target | null {
  const words = new Set(asked.join(' ').toLowerCase().match(/[a-z]{4,}/g) ?? []);
  let best: { card: Technique; score: number } | null = null;
  for (const card of cards) {
    const own = new Set(`${card.title} ${card.summary}`.toLowerCase().match(/[a-z]{4,}/g) ?? []);
    let score = 0;
    for (const w of own) if (words.has(w)) score += 1;
    if (best === null || score > best.score) best = { card, score };
  }
  return best !== null && best.score >= 3 ? { kind: 'technique', card: best.card.title, file: best.card.id.replace(/^seed:/, 'techniques/seed/') + '.md' } : null;
}

function propose(turns: readonly Turn[], mattered: readonly Matched[], cards: readonly Technique[]): Lesson[] {
  const lessons: Lesson[] = [];
  const evidenceOf = (turn: Turn, p: Problem, element: string | null): Evidence => ({ session: turn.log.replace(/\.jsonl$/, ''), turn: turn.id, element, gate: p.gate, owner: p.owner, said: p.what.slice(0, 200) });

  for (const family of FAMILIES) {
    const hits: { turn: Turn; problem: Problem }[] = [];
    for (const turn of turns) for (const problem of turn.finding?.problems ?? []) if (familiesOf(problem).includes(family.id)) hits.push({ turn, problem });
    const ignored = mattered.filter((m) => familiesOf(m.problem).includes(family.id));
    const distinct = new Set(hits.map((h) => `${h.turn.log}#${h.turn.id}`));
    if (distinct.size < 2 && ignored.length === 0) continue;
    const split: Record<string, number> = {};
    for (const h of hits) split[h.problem.owner ?? 'unassigned'] = (split[h.problem.owner ?? 'unassigned'] ?? 0) + 1;
    // the owner is the one the critic named most often; when it named none, the brain, which a rule can change
    const named = Object.entries(split).filter(([o]) => o !== 'unassigned').sort((a, b) => b[1] - a[1]);
    const owner = named[0]?.[0] ?? 'brain';
    const evidence: Evidence[] = [];
    for (const m of ignored) evidence.push(evidenceOf(m.left.turn, m.problem, m.left.on));
    for (const h of hits.slice(-8)) if (!evidence.some((e) => e.turn === h.turn.id && e.session === h.turn.log.replace(/\.jsonl$/, ''))) evidence.push(evidenceOf(h.turn, h.problem, null));
    const text = RULES[family.id];
    const ticket = owner === 'painter' || owner === 'kit';
    const rule = ticket ? `Ticket: ${TICKETS[family.id] ?? family.label}` : ignored.length > 0 && text !== undefined ? `${text.rule} ${text.ignoredRule}` : (text?.rule ?? '');
    const target: Target =
      owner === 'painter' ? { kind: 'painter-ticket', where: 'loop/queue/painter-bugs.md (the layout engine or the painter)' } : owner === 'kit' ? { kind: 'kit-ticket', where: 'loop/queue/painter-bugs.md (the kit: the part that draws the shape)' } : (pickCard(cards, hits.map((h) => h.turn.asked)) ?? { kind: 'prompt', where: 'language/src/prompt.ts: the core rules the brain is handed every turn' });
    lessons.push({
      id: '',
      family: family.id,
      title: family.label,
      rule,
      owner,
      target,
      counts: { turns: distinct.size, sessions: new Set(hits.map((h) => h.turn.log)).size, problems: hits.length, ignoredAndMattered: ignored.length, ownerSplit: split },
      evidence,
    });
  }

  // a gate the critic itself says keeps failing, and whose words matched no family
  const gated = new Map<string, { turns: Set<string>; owners: Record<string, number>; max: number; sample: { turn: Turn; problem: Problem }[] }>();
  for (const turn of turns) {
    for (const problem of turn.finding?.problems ?? []) {
      if (problem.inferred || problem.gate === null || problem.owner === null || familiesOf(problem).length > 0) continue;
      const key = `${problem.gate}/${problem.owner}`;
      const slot = gated.get(key) ?? { turns: new Set<string>(), owners: {}, max: 0, sample: [] };
      slot.turns.add(`${turn.log}#${turn.id}`);
      slot.owners[problem.owner] = (slot.owners[problem.owner] ?? 0) + 1;
      slot.sample.push({ turn, problem });
      for (const r of turn.finding?.repeats ?? []) if (r.gate === problem.gate) slot.max = Math.max(slot.max, r.count);
      gated.set(key, slot);
    }
  }
  for (const [key, slot] of [...gated].sort((a, b) => b[1].turns.size - a[1].turns.size)) {
    if (slot.turns.size < 3) continue;
    const [gate = '', owner = 'brain'] = key.split('/');
    lessons.push({
      id: '',
      family: `gate:${gate}`,
      title: `the ${gate} gate keeps failing (${owner})`,
      rule: `${owner === 'painter' || owner === 'kit' ? 'Ticket' : 'Rule to write'}: the ${gate} gate failed in ${slot.turns.size} turns, owner ${owner}; the newest says: ${clip(slot.sample[slot.sample.length - 1]?.problem.what ?? '', 160)}`,
      owner,
      target: owner === 'painter' ? { kind: 'painter-ticket', where: 'loop/queue/painter-bugs.md' } : owner === 'kit' ? { kind: 'kit-ticket', where: 'loop/queue/painter-bugs.md' } : { kind: 'prompt', where: 'language/src/prompt.ts' },
      counts: { turns: slot.turns.size, sessions: new Set(slot.sample.map((s) => s.turn.log)).size, problems: slot.sample.length, ignoredAndMattered: 0, ownerSplit: slot.owners },
      evidence: slot.sample.slice(-6).map((s) => evidenceOf(s.turn, s.problem, null)),
    });
  }

  // a kind of observation the brain keeps leaving open and the critic keeps catching: its own lesson, however the words read
  lessons.sort((a, b) => b.counts.ignoredAndMattered - a.counts.ignoredAndMattered || b.counts.turns - a.counts.turns);
  lessons.forEach((l, i) => (l.id = `L${i + 1}`));
  return lessons;
}

// ---------- the report ----------

function report(turns: readonly Turn[], lessons: readonly Lesson[], matched: readonly Matched[], left: readonly Left[], root: string, file: string | null, repairs: RepairTally): string[] {
  const lines: string[] = [];
  const held = turns.filter((t) => t.held !== null);
  const judged = turns.filter((t) => t.finding !== null);
  const sessions = new Set(turns.map((t) => t.log));
  lines.push(`attention report: ${turns.length} turns in ${sessions.size} logs under ${join(root, 'logs')}; ${held.length} with an attention record, ${judged.length} with a critic finding`);

  const gateText = [...repairs.byGate].sort((a, b) => b[1].tried - a[1].tried).map(([gate, n]) => `${gate} ${n.tried}/${n.kept}/${n.refused}`).join(', ');
  const rescored = repairs.judged.length === 0 ? '' : `; the critic's second look: ${repairs.judged.map((j) => `${j.before} to ${j.after}`).join(', ')}`;
  lines.push(`repairs: ${repairs.tried} tried, ${repairs.kept} kept, ${repairs.refused} refused${repairs.other > 0 ? `, ${repairs.other} failed or cancelled` : ''}${gateText === '' ? '' : ` (by gate, tried/kept/refused: ${gateText})`}${rescored}`);

  lines.push('\n== what the brain was shown, pulled, ignored and left open ==');
  if (held.length === 0) lines.push('(no attention records: these logs are from before SA3, or from turns without eyes. The critic sections below still count.)');
  else {
    const sum = (f: (h: Held) => number): number => held.reduce((n, t) => n + f(t.held as Held), 0);
    lines.push(`shown ${sum((h) => h.shown.length)} fingerprints over ${held.length} turns; pulled ${sum((h) => h.pulled.length)} times in ${held.filter((t) => (t.held as Held).pulled.length > 0).length} turns; ignore set in ${held.filter((t) => (t.held as Held).ignore.length > 0).length}; the floor refused an ignore ${sum((h) => h.refusedIgnore.length)} times`);
    const count = (fate: Fate): number => left.filter((l) => l.fate === fate).length;
    lines.push(`of ${left.length} things open at a brief: ${count('acted-on')} cleared, ${count('looked-at')} pulled but still open, ${count('ignored')} ignored by kind, ${count('shown-not-pulled')} shown but not pulled or cleared, ${count('never-shown')} never shown (digest full)`);
  }

  lines.push('\n== ignored, and it mattered ==');
  if (matched.length === 0) lines.push('(none: nothing the brain left alone was later raised by the critic)');
  for (const m of matched) {
    const t = m.left.turn;
    lines.push(`- ${t.log.replace(/\.jsonl$/, '')} ${t.id}: ${m.left.kind} on ${m.left.on ?? '(no element)'} [${m.left.rule || m.left.kind}] was ${m.left.fate.replace(/-/g, ' ')}; the critic then raised, matching by ${m.by}: (${m.problem.gate ?? 'ungated'}, ${m.problem.owner ?? 'no owner'}) ${clip(m.problem.what, 140)}${m.problem.evidence === '' ? '' : `\n    evidence: ${clip(m.problem.evidence, 140)}`}`);
  }

  lines.push('\n== repeat failures per gate and owner (the critic: failed gates, in how many turns; and its own `repeats` count) ==');
  const table = new Map<string, { turns: Set<string>; max: number }>();
  let ungated = 0;
  for (const t of judged) {
    for (const p of t.finding?.problems ?? []) {
      if (p.inferred) {
        ungated += 1;
        continue;
      }
      const key = `${p.gate} / ${p.owner ?? 'no owner'}`;
      const slot = table.get(key) ?? { turns: new Set<string>(), max: 0 };
      slot.turns.add(`${t.log}#${t.id}`);
      for (const r of t.finding?.repeats ?? []) if (r.gate === p.gate) slot.max = Math.max(slot.max, r.count);
      table.set(key, slot);
    }
  }
  for (const [key, slot] of [...table].sort((a, b) => b[1].turns.size - a[1].turns.size)) lines.push(`- ${key}: ${slot.turns.size} turns${slot.max > 0 ? `, critic repeats up to ${slot.max} in one session` : ''}`);
  if (table.size === 0) lines.push('(no gated findings)');
  if (ungated > 0) lines.push(`(${ungated} problems came before the gates existed and have no owner; counted by family below)`);

  lines.push('\n== problem families (from the critic\'s words; turns where it was raised) ==');
  for (const f of FAMILIES) {
    const ts = new Set<string>();
    let n = 0;
    for (const t of judged) for (const p of t.finding?.problems ?? []) if (familiesOf(p).includes(f.id)) {
      ts.add(`${t.log}#${t.id}`);
      n += 1;
    }
    lines.push(`- ${f.id}: ${n} problems in ${ts.size} turns`);
  }

  lines.push(`\n== proposed lessons (${lessons.length}); proposed, never applied ==`);
  for (const l of lessons) {
    lines.push(`\n${l.id}  ${l.title}  [${l.family}]`);
    lines.push(`  rule: ${l.rule}`);
    lines.push(`  counts: ${l.counts.problems} problems in ${l.counts.turns} turns in ${l.counts.sessions} sessions; ignored and mattered ${l.counts.ignoredAndMattered}; owners ${JSON.stringify(l.counts.ownerSplit)}`);
    lines.push(`  would go: ${l.target.kind === 'technique' ? `technique card "${l.target.card}" (${l.target.file})` : l.target.kind === 'prompt' ? `a prompt line, ${l.target.where}` : `${l.target.kind}, ${l.target.where}`}`);
    for (const e of l.evidence.slice(0, 4)) lines.push(`  - ${e.session} ${e.turn}${e.element === null ? '' : ` element ${e.element}`}${e.gate === null ? '' : ` [${e.gate}${e.owner === null ? '' : `/${e.owner}`}]`}: ${clip(e.said, 110)}`);
    if (l.evidence.length > 4) lines.push(`  (+${l.evidence.length - 4} more in the file)`);
  }
  lines.push(file === null ? '\n(no file written)' : `\nproposals written to ${file}; approve with \`pnpm attention --to-remote ${file}\` (a dry run) or \`--to-queue\``);
  return lines;
}

// ---------- the approval step ----------

interface ProposalFile {
  readonly kind: 'conduit-attention-proposals';
  readonly version: 1;
  readonly lessons: readonly Lesson[];
}

const readProposals = (path: string, only: ReadonlySet<string> | null): Lesson[] => {
  let parsed: ProposalFile;
  try {
    parsed = JSON.parse(readFileSync(resolve(path), 'utf8')) as ProposalFile;
  } catch (error) {
    return fail(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed.kind !== 'conduit-attention-proposals' || !Array.isArray(parsed.lessons)) return fail(`${path} is not a proposal file from this tool`);
  return parsed.lessons.filter((l) => only === null || only.has(l.id));
};

async function toRemote(path: string, only: ReadonlySet<string> | null, write: boolean, dataRoot: string): Promise<void> {
  const identity = stewardIdentity(!write);
  if (write && identity.agent !== STEWARD) fail(`--write writes to Remote and only the steward may: set REMOTE_AGENT=${STEWARD} (this is ${identity.agent})`);
  if (write && process.env['REMOTE_SESSION_ID'] === undefined) fail('--write needs REMOTE_SESSION_ID set (the tree records it for every write)');
  const settings: RemoteSettings = { kind: 'remote', bin: process.env['REMOTE_BIN'] ?? 'remote', actor: 'series@example.invalid', env: 'prod', root: CONDUIT_ROOT_BLOCK, seedDir: join(repo, 'techniques', 'seed'), cacheDir: dataPaths(dataRoot).techniquesCache, overlayDir: null, refreshMs: 0, timeoutMs: 30_000 };
  const cards = new Map(readTechniqueDir(settings.seedDir, 'seed').map((c) => [c.title, c]));
  const writer = createRemoteWriter(settings, identity, createLogger('warn'));
  const limit = AbortSignal.timeout(300_000);
  out(write ? 'WRITE (steward)' : 'dry run (nothing is written; these are the commands the steward would run)');
  let n = 0;
  for (const lesson of readProposals(path, only)) {
    if (lesson.target.kind !== 'technique') {
      out(`${lesson.id}: ${lesson.target.kind} lessons do not go to Remote; use --to-queue for tickets, or put the line in the prompt by hand`);
      continue;
    }
    const card = cards.get(lesson.target.card);
    if (card === undefined) {
      out(`${lesson.id}: the card "${lesson.target.card}" is not in the seed; skipped`);
      continue;
    }
    const cites = lesson.evidence.slice(0, 6).map((e) => `${e.session} ${e.turn}${e.element === null ? '' : ` ${e.element}`}`).join('; ');
    const body = [
      lesson.rule,
      '',
      'PROPOSED: not yet measured; the brain does not read this until promoted.',
      '',
      `**Use it when** ${card.body.when}`,
      '',
      `**Not when** ${card.body.notWhen === '' ? 'the request is not the kind this card is for.' : card.body.notWhen}`,
      '',
      '**Example**',
      '```series',
      ...card.body.example,
      '```',
      '',
      `**What failed** ${lesson.title}: ${lesson.counts.problems} critic problems in ${lesson.counts.turns} turns, ${lesson.counts.ignoredAndMattered} left open by the brain and then raised. Seen in: ${cites}.`,
      '',
      '**Score** Not measured yet.',
    ].join('\n');
    const draft = { id: null, title: `${PROPOSED_PREFIX} ${card.title}: ${lesson.family}`, summary: `${card.summary} Lesson: ${lesson.title}.`, reason: card.reason, markdown: body };
    const problems = lintTechnique(draft.title, draft.summary, draft.reason, draft.markdown);
    if (problems.length > 0) {
      out(`${lesson.id}: refused by lint: ${problems.join('; ')}`);
      continue;
    }
    let result: Awaited<ReturnType<typeof writer.write>>;
    try {
      result = await writer.write(draft, null, limit);
    } catch (error) {
      if (write) return fail(`Remote cannot be reached, so duplicates cannot be checked: ${error instanceof Error ? error.message : String(error)}`);
      out(`${lesson.id}: passes lint as "${draft.title}", but Remote could not be read to check for a duplicate (${error instanceof Error ? error.message : String(error)}); the draft body follows\n----- body.md -----\n${body}\n-------------------`);
      n += 1;
      continue;
    }
    out(result.outcome === 'refused' ? `${lesson.id}: refused: ${result.problems.join('; ')}` : result.outcome === 'conflict' ? `${lesson.id}: conflict` : `${lesson.id}: ${write ? `written ${result.id}` : 'planned'}  ${draft.title}`);
    n += 1;
  }
  if (!write) for (const step of writer.plan) out(`\n${step.line}\n----- body.md -----\n${step.stdin ?? ''}-------------------`);
  out(write ? `${n} written` : `dry run complete: nothing was written (${n} planned)`);
}

function toQueue(path: string, only: ReadonlySet<string> | null, dataRoot: string): void {
  const queue = dataPaths(dataRoot).queue;
  const bugs = join(queue, 'painter-bugs.md');
  const rows = readProposals(path, only).filter((l) => l.target.kind === 'painter-ticket' || l.target.kind === 'kit-ticket');
  if (rows.length === 0) return out('no painter or kit lessons chosen');
  mkdirSync(queue, { recursive: true });
  const header = existsSync(bugs) ? '' : '# Painter bugs the critic found\n\nProblems the brain did not cause: for the steward. One line each, with the log and turn it was seen in.\n\n';
  appendFileSync(bugs, `${header}${rows.map((l) => `- [${l.target.kind === 'kit-ticket' ? 'kit' : 'painter'}] ${l.title}: ${l.rule}  [attention ${l.id}: ${l.evidence.slice(0, 4).map((e) => `${e.session} ${e.turn}${e.element === null ? '' : ` ${e.element}`}`).join('; ')}]\n`).join('')}`);
  out(`${rows.length} ticket(s) appended to ${bugs}`);
}

// ---------- main ----------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | null => {
    const at = argv.indexOf(name);
    const v = at < 0 ? undefined : argv[at + 1];
    return v === undefined || v.startsWith('--') ? null : v;
  };
  const root = resolve(resolveDataDir(withDataFlag(argv, process.env)));
  const only = flag('--only') === null ? null : new Set((flag('--only') ?? '').split(',').map((s) => s.trim()));
  const remoteFile = flag('--to-remote');
  if (remoteFile !== null) return toRemote(remoteFile, only, argv.includes('--write'), root);
  const queueFile = flag('--to-queue');
  if (queueFile !== null) return toQueue(queueFile, only, root);

  const turns = readLogs(dataPaths(root).logs);
  const left = turns.flatMap(fates);
  const mattered: Matched[] = [];
  for (const l of left) {
    if (l.fate === 'acted-on' || l.fate === 'looked-at') continue;
    const m = matches(l.turn, l);
    if (m !== null) mattered.push(m);
  }
  const cards = readTechniqueDir(join(repo, 'techniques', 'seed'), 'seed');
  const lessons = propose(turns, mattered, cards);

  let file: string | null = null;
  if (!argv.includes('--no-file')) {
    const dir = resolve(flag('--out') ?? join(root, 'lessons'));
    mkdirSync(dir, { recursive: true });
    file = join(dir, `proposed-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')}.json`);
    const doc = { kind: 'conduit-attention-proposals', version: 1, at: new Date().toISOString(), logs: dataPaths(root).logs, turns: turns.length, lessons, ignoredAndMattered: mattered.map((m) => ({ session: m.left.turn.log.replace(/\.jsonl$/, ''), turn: m.left.turn.id, fingerprint: m.left.fingerprint, fate: m.left.fate, by: m.by, gate: m.problem.gate, owner: m.problem.owner, problem: m.problem.what })) };
    writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  }
  if (argv.includes('--json') && file !== null) return out(readFileSync(file, 'utf8'));
  for (const line of report(turns, lessons, mattered, left, root, file, readRepairs(dataPaths(root).logs))) out(line);
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
