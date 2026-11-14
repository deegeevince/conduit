// Observations and the brain's attention (PLAN-stage section 2; package SA3). PURE and shared: the server builds the feed, the brief prints the digest.
//
// PROTECTED, beside review.ts: the urgent table and the floor below are constants the lessons loop may PROPOSE changes to and never apply.
// The brain decides what to look at; what it cannot choose to ignore is `FLOOR`: the person's input, refusals, and unreadable text on the answer.

import type { Rule, Severity } from './loop';
import { estimateTokens } from './prompt';
import type { Sight, SightNote } from './sight';
import type { CanvasBox } from './types';

export type ObsKind =
  | Rule
  | 'fit'
  | 'refusal'
  | 'fault'
  | 'said'
  | 'tap'
  | 'ink'
  | 'voice'
  | 'did'
  | 'state'
  | 'scroll'
  | 'viewport'
  | 'fonts'
  | 'drift'
  | 'surface'
  | 'picture';

export const OBS_KINDS: readonly ObsKind[] = ['present', 'inside', 'apart', 'legible', 'reachable', 'steady', 'spoiler', 'shell', 'fit', 'refusal', 'fault', 'said', 'tap', 'ink', 'voice', 'did', 'state', 'scroll', 'viewport', 'fonts', 'drift', 'surface', 'picture'];

export type ObsSource = 'engine' | 'eyes' | 'person' | 'server';
export type ObsSeverity = Severity | 'info';

export interface Observation {
  /** its own counter in the session; 0 for an engine observation, which is derived and never stored */
  readonly seq: number;
  /** the revision it was true at (until the document lands, the session's own count of what the brain has been told) */
  readonly rev: number;
  readonly source: ObsSource;
  readonly kind: ObsKind;
  readonly severity: ObsSeverity;
  /** an element or node id */
  readonly on: string | null;
  /** about the newest answer (this turn, or the stage it left), not history */
  readonly answer: boolean;
  /** 160 characters at most; a person's or a document's words are quoted, never instructions */
  readonly note: string;
  readonly box: CanvasBox | null;
  /** kind|on|rule: the same fault is one observation that appears and clears */
  readonly fingerprint: string;
}

export const DIGEST_BUDGET = { lines: 6, urgent: 8, noteChars: 160, tokens: 300 } as const;

/** What the brain has asked to watch or ignore this turn (set by `canvas_attend`, which comes with the canvas tools; empty until then), and the facts the header prints. */
export interface Attention {
  readonly rev: number;
  /** the revision at which the brain last wrote */
  readonly wrote: number;
  /** `390x844 phone, touch` */
  readonly screen: string;
  readonly engine: 'ok' | 'drift' | 'unmeasured';
  /** things that landed with nothing to report; null when no answer has been seen */
  readonly clean: number | null;
  readonly watch: readonly ObsKind[];
  readonly ignore: readonly ObsKind[];
  /** the canvas tools are on, so the digest may point at `canvas_observe` */
  readonly tools: boolean;
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// THE URGENT TABLE AND THE FLOOR. Constants; do not make them configurable.

/** What the person did. Always urgent: it is what the turn is about. */
export const PERSON_KINDS: readonly ObsKind[] = ['said', 'tap', 'ink', 'voice', 'did'];
/** Unreadable, and only when it is about the answer. */
export const UNREADABLE_KINDS: readonly ObsKind[] = ['apart', 'present', 'inside', 'legible', 'spoiler'];
/** The eyes cannot be trusted: the server's facts are not the page's for this session. */
export const UNTRUSTED_KINDS: readonly ObsKind[] = ['drift', 'fonts'];

export type UrgentClass = 'person' | 'refusal' | 'unreadable' | 'untrusted';

/** Why an observation is urgent, or null when it only counts. */
export function urgentClass(o: Observation): UrgentClass | null {
  if (PERSON_KINDS.includes(o.kind)) return 'person';
  if (o.kind === 'refusal') return 'refusal';
  if (UNREADABLE_KINDS.includes(o.kind) && o.answer && o.severity === 'blocking') return 'unreadable';
  if (UNTRUSTED_KINDS.includes(o.kind)) return 'untrusted';
  return null;
}

/** The floor: the brain may not put these in `ignore`, and an open one always causes the measured look at the end of a draft. */
export function onFloor(o: Observation): boolean {
  const why = urgentClass(o);
  return why === 'person' || why === 'refusal' || why === 'unreadable';
}

/** A kind the brain is not allowed to ignore. */
export function floorKind(kind: ObsKind): boolean {
  return PERSON_KINDS.includes(kind) || kind === 'refusal' || UNREADABLE_KINDS.includes(kind);
}

// ---------------------------------------------------------------------------------------------------------------------------------------

export const NOTE_CHARS = DIGEST_BUDGET.noteChars;

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

/** A person's words, quoted and cut. */
export const quoted = (text: string, max = 100): string => `"${clip(text, max).replace(/"/g, "'")}"`;

export const fingerprintOf = (kind: ObsKind, on: string | null, rule: string): string => `${kind}|${on ?? ''}|${rule}`;

/** What a sight note means as a rule, with how heavily it weighs and the few words the digest prints. */
const LINT: Readonly<Record<SightNote, { readonly kind: ObsKind; readonly severity: ObsSeverity; readonly words: string } | null>> = {
  clipped: { kind: 'inside', severity: 'blocking', words: 'part of it falls off the screen' },
  'off-canvas': { kind: 'inside', severity: 'blocking', words: 'none of it is on screen' },
  covered: { kind: 'present', severity: 'blocking', words: 'something drawn later hides it' },
  overlaps: { kind: 'apart', severity: 'blocking', words: 'it sits on top of text' },
  collides: { kind: 'apart', severity: 'blocking', words: 'its words run into other words' },
  crossed: { kind: 'apart', severity: 'blocking', words: 'a drawn line runs through its words' },
  faint: { kind: 'legible', severity: 'blocking', words: 'hard to read against what is behind it' },
  tiny: { kind: 'legible', severity: 'blocking', words: 'too small to make out' },
  lost: { kind: 'present', severity: 'blocking', words: 'the line the answer rests on is not on stage at rest' },
  shrunk: { kind: 'fit', severity: 'note', words: 'made smaller to fit' },
  wrapped: { kind: 'fit', severity: 'note', words: 'broke over many lines' },
  recoloured: { kind: 'legible', severity: 'note', words: 'recoloured to stay readable' },
  crowded: { kind: 'fit', severity: 'note', words: 'too many parts for the room' },
  sparse: { kind: 'fit', severity: 'note', words: 'most of the picture is empty' },
  // FG1: a label that spills out of the shape that mostly holds it, or whose leader line ends on the wrong part or crosses another, is the layout's to mend
  spills: { kind: 'inside', severity: 'blocking', words: 'it spills out past the shape that mostly holds it' },
  'wrong-part': { kind: 'apart', severity: 'blocking', words: 'its leader line ends on the wrong part' },
  tangled: { kind: 'apart', severity: 'blocking', words: 'its leader line crosses another label\'s' },
  refit: { kind: 'fit', severity: 'note', words: 'shrunk toward its centre to fit inside its shape' },
  retired: null,
  partial: null,
  painted: null,
  unpainted: null,
};

/** The part of a measurement the feed reads. A server `Measured`, a page `draft` or a report's `sight` all satisfy it. */
export interface LintFacts {
  readonly sight: Sight;
}

/** v2.1's SightNotes (and, when they ride on the report, LP1's violations) as one list. Engine observations: derived, never stored, `seq` 0. */
export function lintOf(facts: LintFacts | null, rev = 0): Observation[] {
  if (facts === null) return [];
  const out: Observation[] = [];
  for (const item of facts.sight.items) {
    for (const note of item.notes) {
      const rule = LINT[note];
      if (rule === null) continue;
      if (!item.resting && rule.kind !== 'apart') continue;
      out.push({
        seq: 0,
        rev,
        source: 'engine',
        kind: rule.kind,
        severity: rule.severity,
        on: item.id,
        answer: true,
        note: clip(`${rule.words} (${item.kind})`, NOTE_CHARS),
        box: item.box,
        fingerprint: fingerprintOf(rule.kind, item.id, note),
      });
    }
  }
  return out;
}

/** Everything the brain has not yet been told since `since`: what was recorded after it, and what the newest answer's facts say now. `before` is where the previous digest stood (the diff arm lands with the document). */
export function feedSince(records: readonly Observation[], _before: LintFacts | null, now: LintFacts | null, since: number, rev = 0): Observation[] {
  return [...records.filter((one) => one.seq > since), ...lintOf(now, rev)];
}

/** Fingerprints of what is open on the floor, or urgent: the set a later turn's `cleared` is taken against. */
export function openOf(feed: readonly Observation[]): string[] {
  return [...new Set(feed.filter((one) => urgentClass(one) !== null && one.source !== 'person').map((one) => one.fingerprint))];
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// THE DIGEST

const CLASS_ORDER: readonly UrgentClass[] = ['person', 'unreadable', 'refusal', 'untrusted'];

function itemText(o: Observation): string {
  if (PERSON_KINDS.includes(o.kind) || o.kind === 'refusal') return o.note;
  return `${o.kind}${o.on === null ? '' : ` ${o.on}`}: ${o.note}`;
}

/** The urgent items a digest would show, in the order it shows them, one per fingerprint (the latest). */
export function urgentOf(feed: readonly Observation[]): Observation[] {
  const latest = new Map<string, Observation>();
  for (const one of feed) if (urgentClass(one) !== null) latest.set(one.fingerprint, one);
  return [...latest.values()].sort((a, b) => CLASS_ORDER.indexOf(urgentClass(a) ?? 'untrusted') - CLASS_ORDER.indexOf(urgentClass(b) ?? 'untrusted') || a.seq - b.seq);
}

const LINE_CHARS = 230;

export interface Digest {
  readonly text: string;
  readonly lines: number;
  readonly tokens: number;
  /** fingerprints of the urgent items printed */
  readonly shown: readonly string[];
  /** urgent items there was no room for */
  readonly more: number;
  readonly counts: Readonly<Record<string, number>>;
  readonly urgent: number;
}

function counted(feed: readonly Observation[], pick: (one: Observation) => string | null): string {
  const counts = new Map<string, number>();
  for (const one of feed) {
    const key = pick(one);
    if (key !== null) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([key, n]) => `${key} ${n}`).join(' · ');
}

/** The digest in full, with what it holds; `digestOf` is its text. */
export function digestFull(feed: readonly Observation[], attention: Attention, budget = DIGEST_BUDGET): Digest {
  const header = `EYES rev ${attention.rev} (you last wrote at ${attention.wrote}) · ${attention.screen} · engine ${attention.engine}`;
  const urgent = urgentOf(feed);
  const person = counted(feed, (one) => (one.source === 'person' ? one.kind : null));
  const eyes = counted(feed, (one) => (one.source === 'eyes' || one.source === 'server' ? (one.kind === 'refusal' ? null : one.kind) : null));
  const blocking = feed.filter((one) => one.source === 'engine' && one.severity === 'blocking').length;
  const notes = feed.filter((one) => one.source === 'engine' && one.severity === 'note').length;
  const layoutParts = [blocking > 0 ? `blocking ${blocking}` : '', notes > 0 ? `notes ${notes}` : '', attention.clean === null || attention.clean === 0 ? '' : `clean ${attention.clean}`].filter((part) => part !== '');
  const layout = layoutParts.length === 0 ? '' : `layout  ${layoutParts.join(' · ')}`;
  const countsLine = [person === '' ? '' : `person  ${person}`, layout, eyes === '' ? '' : `eyes  ${eyes}`].filter((part) => part !== '').join('      ');
  const watching = [attention.watch.length === 0 ? '' : `watching ${attention.watch.join(', ')}`, attention.ignore.length === 0 ? '' : `ignoring ${attention.ignore.join(', ')}`, attention.tools ? 'detail: canvas_observe kind=<kind> since=<rev>' : ''].filter((part) => part !== '');
  const counts: Record<string, number> = {};
  for (const one of feed) counts[one.kind] = (counts[one.kind] ?? 0) + 1;

  const compose = (n: number): { text: string; lines: number; shown: string[] } => {
    const lines = [header];
    const shown = urgent.slice(0, n);
    const rest = urgent.length - shown.length;
    // pack the urgent items into at most three lines
    const rows: string[] = [];
    let row = '';
    for (const one of shown) {
      const piece = itemText(one);
      if (row !== '' && row.length + piece.length + 3 > LINE_CHARS) {
        rows.push(row);
        row = '';
      }
      row = row === '' ? piece : `${row} · ${piece}`;
    }
    if (row !== '') rows.push(row);
    if (rest > 0) rows.push(`… ${rest} more urgent${attention.tools ? ': canvas_observe severity=blocking' : ''}`);
    rows.forEach((text, at) => lines.push(`  ${at === 0 ? 'urgent   ' : '         '}${text}`));
    if (countsLine !== '') lines.push(`  ${countsLine}`);
    if (watching.length > 0) lines.push(`  ${watching.join(' · ')}`);
    if (lines.length === 1 && feed.length === 0) lines[0] = `${header} · nothing new`;
    return { text: lines.join('\n'), lines: lines.length, shown: shown.map((one) => one.fingerprint) };
  };

  let n = Math.min(urgent.length, budget.urgent);
  let built = compose(n);
  while (n > 0 && (built.lines > budget.lines || estimateTokens(built.text) > budget.tokens)) {
    n -= 1;
    built = compose(n);
  }
  // Last resort: the counts line goes before the header does.
  let text = built.text;
  if (estimateTokens(text) > budget.tokens || built.lines > budget.lines) text = text.split('\n').slice(0, budget.lines).join('\n').slice(0, Math.floor(budget.tokens * 2.3));
  return { text, lines: text.split('\n').length, tokens: estimateTokens(text), shown: built.shown, more: urgent.length - built.shown.length, counts, urgent: urgent.length };
}

/** The `EYES` block of a turn's brief. It replaces the sight block, so the brief does not grow: six lines and 300 estimated tokens at most. */
export function digestOf(feed: readonly Observation[], attention: Attention, budget = DIGEST_BUDGET): string {
  return digestFull(feed, attention, budget).text;
}
