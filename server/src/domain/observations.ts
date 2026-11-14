// What the session has seen and been told, as observations (SA3; PLAN-stage section 2). One feed per session: the person's input, the page's
// eyes (`observe` events), the server's refusals and drift, and the engine's lint of the answer the stage left. The turn brief prints its digest
// (`EYES`); the session log holds each observation as an `obs` record and each turn's attention as an `attention` record.
//
// The urgent table and the floor are constants in `@conduit/language` observe.ts, a protected file. Nothing here decides what is urgent.

import { OBSERVE_LIMITS, digestFull, feedSince, fingerprintOf, openOf, quoted } from '@conduit/language';
import type { Attention, InkMarks, ObsKind, ObsSeverity, ObsSource, Observation, ObserveItem, ScreenFacts, TurnInput, TurnMemory } from '@conduit/language';
import type { Session } from './session';
import { engineMismatch } from './stage-facts';

const KEPT = 400;

export interface NewObservation {
  readonly source: ObsSource;
  readonly kind: ObsKind;
  readonly severity?: ObsSeverity;
  readonly on?: string | null;
  readonly answer?: boolean;
  readonly note: string;
}

interface Held {
  readonly o: Observation;
  readonly at: number;
}

/** One session's feed. */
export class Observations {
  private held: Held[] = [];
  private seq = 0;
  /** counts what the person and the eyes changed, and each turn: the revision observations were true at */
  rev = 0;
  /** the revision at which the brain was last given a brief */
  wrote = 0;
  /** the highest seq the last brief covered */
  briefedThrough = 0;
  /** fingerprints open (urgent, not the person's) at the last brief */
  open: readonly string[] = [];
  private observeAt = Number.NEGATIVE_INFINITY;

  /** True when an `observe` event may be taken: one a second at most. */
  allowObserve(now: number): boolean {
    if (now - this.observeAt < OBSERVE_LIMITS.everyMs) return false;
    this.observeAt = now;
    return true;
  }

  add(input: NewObservation, now: number): Observation {
    const severity = input.severity ?? 'info';
    const on = input.on ?? null;
    if (input.source === 'person' || input.source === 'eyes') this.rev += 1;
    this.seq += 1;
    const note = input.note.replace(/\s+/g, ' ').trim().slice(0, 160);
    // the person's moves are each their own; a repeated report of the same thing from the eyes is one observation that appears and clears
    const fingerprint = fingerprintOf(input.kind, on, input.source === 'person' ? String(this.seq) : input.kind === 'fonts' || input.kind === 'drift' ? note : '');
    const o: Observation = { seq: this.seq, rev: this.rev, source: input.source, kind: input.kind, severity, on, answer: input.answer ?? false, note, box: null, fingerprint };
    this.held.push({ o, at: now });
    if (this.held.length > KEPT) this.held.splice(0, this.held.length - KEPT);
    return o;
  }

  /** Was something of this kind on this id added within `ms`, after seq `after`? */
  recent(kinds: readonly ObsKind[], on: string | null, ms: number, now: number, after = 0): boolean {
    return this.held.some(({ o, at }) => o.seq > after && now - at <= ms && kinds.includes(o.kind) && o.on === on);
  }

  all(): readonly Observation[] {
    return this.held.map((entry) => entry.o);
  }
}

export function screenText(screen: ScreenFacts): string {
  const shape = screen.width < 600 ? 'phone' : screen.width < 1000 ? 'tablet' : 'desktop';
  return `${screen.width}x${screen.height} ${shape}, ${screen.pointer === 'coarse' ? 'touch' : screen.pointer === 'fine' ? 'mouse' : 'no pointer'}`;
}

/** What the page's `observe` item becomes. */
export function itemObservation(item: ObserveItem): NewObservation {
  return { source: 'eyes', kind: item.kind, severity: item.severity === 'fault' ? 'fault' : item.severity, on: item.on, answer: item.kind === 'present' || item.kind === 'legible', note: item.note };
}

function inkNote(marks: InkMarks): string {
  const n = marks.strokes.length;
  const on = marks.on?.element ?? marks.on?.node ?? marks.on?.label ?? null;
  return `you drew ${n} stroke${n === 1 ? '' : 's'}${on === null ? '' : ` on ${on}`}`;
}

/** The person's own input as observations: what they said, tapped, drew or spoke. Added before the brief is built. */
export function observeInput(s: Session, input: TurnInput, now: number): void {
  const add = (kind: ObsKind, note: string, on: string | null = null): void => void s.obs.add({ source: 'person', kind, note, on, severity: 'info' }, now);
  if (input.kind === 'prompt') {
    if (input.text.trim() !== '') add('said', `you said ${quoted(input.text)}`);
    if (input.marks !== undefined) add('ink', inkNote(input.marks), input.marks.on?.element ?? input.marks.on?.node ?? null);
    for (const id of input.voice ?? []) add('voice', `you sent a voice note (${id})`, id);
  } else if (input.kind === 'tap' || input.kind === 'act') {
    // the page already told us of the tap or the control as it happened; this is the same act arriving as the turn's input
    if (!s.obs.recent(['tap', 'state'], input.id, 5000, now, s.obs.briefedThrough)) add('tap', `you ${input.kind === 'act' ? 'pressed' : 'tapped'} ${quoted(input.text, 60)}`, input.id);
  } else if (input.kind === 'refine') {
    add('said', 'you asked to keep making it better');
  }
}

export interface Briefed {
  /** the EYES block, or null when there is nothing worth a line (the very first turn, nothing seen) */
  readonly eyes: string | null;
  readonly record: {
    readonly rev: readonly [number, number];
    readonly digest: { readonly counts: Readonly<Record<string, number>>; readonly urgent: number; readonly lines: number; readonly tokens: number };
    readonly shown: readonly string[];
    readonly pulled: readonly { readonly tool: string; readonly kind: string; readonly since: number; readonly n: number; readonly ms: number }[];
    readonly watch: readonly string[];
    readonly ignore: readonly string[];
    readonly refusedIgnore: readonly string[];
    readonly cleared: readonly string[];
    readonly open: readonly string[];
    readonly calls: number;
    readonly toolMs: number;
  };
}

/** Builds the digest for the turn about to open, and moves the session's marks on: the brain has now been told. */
export function briefEyes(s: Session, tools = false): Briefed {
  const obs = s.obs;
  const last: TurnMemory | undefined = s.history[s.history.length - 1];
  const facts = last?.sight == null ? null : { sight: last.sight };
  const feed = feedSince(obs.all(), null, facts, obs.briefedThrough, obs.rev);
  const clean = last?.sight == null ? null : last.sight.items.filter((item) => item.resting && item.notes.length === 0).length;
  const attention: Attention = {
    rev: obs.rev,
    wrote: obs.wrote,
    screen: screenText(s.screen),
    engine: s.drift !== null ? 'drift' : engineMismatch(s.capabilities) !== null ? 'unmeasured' : 'ok',
    clean,
    watch: [],
    ignore: [],
    tools,
  };
  const digest = digestFull(feed, attention);
  const open = openOf(feed);
  const cleared = obs.open.filter((fingerprint) => !open.includes(fingerprint));
  const record: Briefed['record'] = {
    rev: [obs.wrote, obs.rev],
    digest: { counts: digest.counts, urgent: digest.urgent, lines: digest.lines, tokens: digest.tokens },
    shown: digest.shown,
    // What the brain pulled with the canvas tools is added when the turn ends (`Conductor.finish`).
    pulled: [],
    watch: [],
    ignore: [],
    refusedIgnore: [],
    cleared,
    open,
    calls: 0,
    toolMs: 0,
  };
  obs.open = open;
  obs.wrote = obs.rev;
  obs.briefedThrough = Math.max(obs.briefedThrough, ...obs.all().map((one) => one.seq));
  const nothing = feed.length === 0 && s.history.length === 0;
  return { eyes: nothing ? null : digest.text, record };
}
