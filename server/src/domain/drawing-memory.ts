// The drawing memory: every accepted line of a drawing, by turn, and a version for each turn that changed the drawing. The brain sees an index
// of the versions (`DRAWING MEMORY`) and brings any of it back: all of a turn (`restore t5`, `/undo`) or some of its parts (`use bridge from=t5`).
// What comes back is lines, read by the server and ingested one by one, so they are real elements the brain can `set`, `move` and `drop`.
// Held in memory for the conversation; the session log is the durable copy, and `rebuildMemory` reads it again on resume.

import { EMPTY_STAGE, LineNormalizer, buildSchedule, parseLine, restingBox, serializeLine, settle } from '@conduit/language';
import type { CanvasBox, ColourRef, FillRef, Line, Point, ScoreEntry, StyleProps } from '@conduit/language';

/** lines and bytes a conversation's memory holds; past either the oldest turns fold into the version that follows them */
export const MEMORY_LIMITS = { lines: 4000, bytes: 1_000_000 } as const;

/** Verbs of a drawing: what is kept. Words, structures, controls and paintings (which cost a model call to make again) are not. */
const KEPT: ReadonlySet<string> = new Set(['scene', 'color', 'style', 'circle', 'ellipse', 'rect', 'line', 'poly', 'path', 'group', 'use', 'pix', 'row', 'frame', 'set', 'move', 'drop']);
const SHAPES: ReadonlySet<string> = new Set(['shape', 'group', 'sprite', 'copy']);

interface MemoryLine {
  readonly turn: string;
  readonly seq: number;
  readonly text: string;
}

/** One standing element of a version: its lines (creating, then what changed it), with colour names written as hex. */
export interface ElementMemory {
  readonly id: string;
  readonly kind: 'shape' | 'group' | 'sprite' | 'copy';
  /** id of its group */
  readonly parent: string | null;
  readonly at: Point | null;
  readonly box: CanvasBox | null;
  readonly fill: string;
  readonly lines: readonly string[];
}

export interface Version {
  readonly turn: string;
  /** the person's words that turn, cut short */
  readonly said: string;
  /** a signature of the resting drawing: two versions with the same one look alike */
  readonly sig: string;
  readonly elements: readonly ElementMemory[];
  /** `style` lines in force, by name */
  readonly styles: Readonly<Record<string, string>>;
  /** the index of the version this one put back (`/undo` and `restore`), when it did */
  readonly restored?: number;
}

const clip = (text: string, max: number): string => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
};

const hexOf = (colors: Readonly<Record<string, string>>) => (ref: ColourRef): ColourRef => (typeof ref === 'object' && 'named' in ref ? ((colors[ref.named] as `#${string}` | undefined) ?? ref) : ref);

/** A line with its colour names written as hex (a name may mean something else by the time it comes back) and its time dropped. */
function settled(line: Line, colors: Readonly<Record<string, string>>): Line {
  const hex = hexOf(colors);
  const props = (line as { props?: StyleProps }).props;
  let next: Line = line;
  if ('when' in line && line.when !== undefined) next = { ...next, when: undefined } as Line;
  if (props === undefined) return next;
  const fill = props.fill;
  const mapped: FillRef | undefined = fill === undefined ? undefined : typeof fill === 'object' && 'from' in fill ? { from: hex(fill.from), to: hex(fill.to) } : fill === 'none' ? fill : hex(fill);
  const out: Record<string, unknown> = { ...props };
  if (mapped !== undefined) out['fill'] = mapped;
  if (props.stroke !== undefined && props.stroke !== 'none') out['stroke'] = hex(props.stroke);
  if (props.ink !== undefined) out['ink'] = hex(props.ink);
  return { ...next, props: out } as Line;
}

/** Every id a line names, renamed by `rename` (identity for ids not in it). */
function renamed(line: Line, rename: ReadonlyMap<string, string>): Line {
  const to = (id: string): string => rename.get(id) ?? id;
  const l = line as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { ...l };
  if (typeof l['id'] === 'string' && l['id'] !== '-') out['id'] = to(l['id']);
  if (typeof l['source'] === 'string') out['source'] = to(l['source']);
  if (typeof l['along'] === 'string') out['along'] = to(l['along']);
  const target = l['target'] as { kind: string; id?: string } | undefined;
  if (target !== undefined && target.kind === 'id' && target.id !== undefined) out['target'] = { ...target, id: to(target.id) };
  const props = l['props'] as { in?: string } | undefined;
  if (props?.in !== undefined) out['props'] = { ...props, in: to(props.in) };
  return out as unknown as Line;
}

/** A line as it comes back: it arrives at once (a drawing put back is not drawn in again), and a change it carries is quick. */
function arriving(line: Line, creating: boolean): Line {
  if (creating && 'props' in line) return { ...line, props: { ...(line as { props: StyleProps }).props, enter: 'cut' } } as Line;
  if (line.verb === 'set' || line.verb === 'move') return { ...line, over: 0.05 } as Line;
  return line;
}

function parsed(text: string): Line | null {
  const read = parseLine(text);
  return read.kind === 'line' ? (read.line as Line) : null;
}

export interface Recalled {
  readonly lines: readonly Line[];
  /** the ids that came back, as they are now named */
  readonly ids: readonly string[];
  /** a word for the log */
  readonly note: string;
}

export class DrawingMemory {
  private lines: MemoryLine[] = [];
  private bytes = 0;
  readonly versions: Version[] = [];
  /** the lines as the schedule reads them; it is built once for each version, never for each line */
  private entries: ScoreEntry[] = [];
  private normalizer = this.freshNormalizer();
  private styleLines = new Map<string, string>();
  /** lines kept for the turn now open, and whether any of them touched the drawing */
  private open: { turn: string; said: string; touched: boolean; restored?: number } | null = null;

  private freshNormalizer(): LineNormalizer {
    let counter = 0;
    return new LineNormalizer(() => `m${(counter += 1)}`);
  }

  get lineCount(): number {
    return this.lines.length;
  }

  /** The turn that lines now belong to: its first line opens it, and `close` ends it. */
  begin(turn: string, said: string): void {
    if (this.open?.turn === turn) return;
    this.close();
    this.open = { turn, said: clip(said, 80), touched: false };
  }

  /** One accepted line of the turn. Words, structures and controls are not a drawing's, and are not kept. */
  record(turn: string, seq: number, text: string): void {
    const line = parsed(text);
    if (line === null || !KEPT.has(line.verb)) return;
    if (this.open === null || this.open.turn !== turn) this.begin(turn, '');
    this.push({ turn, seq, text }, line);
    if (this.open !== null && line.verb !== 'color' && line.verb !== 'style') this.open.touched = true;
  }

  /** Notes that the turn put an earlier version back (so a second `/undo` goes on from there, not back to where it came from). */
  restoredIndex(index: number): void {
    if (this.open !== null) this.open.restored = index;
  }

  private push(entry: MemoryLine, line: Line): void {
    this.lines.push(entry);
    this.bytes += entry.text.length + 1;
    if (line.verb === 'style') this.styleLines.set(line.name, entry.text);
    const normalized = this.normalizer.normalize(line);
    if (normalized.line !== null) this.entries.push({ seq: entry.seq, line: normalized.line, floor: 0, void: false });
  }

  /** Ends the open turn: when the drawing now differs from the last version, this turn is a version. Returns it. */
  close(): Version | null {
    const open = this.open;
    this.open = null;
    if (open === null || !open.touched) return null;
    const version = this.versionOf(open.turn, open.said, open.restored);
    const last = this.versions.at(-1);
    if (last !== undefined && last.sig === version.sig) return null;
    this.versions.push(version);
    this.trim();
    return version;
  }

  /** The drawing as it stands in the memory's own replay: each standing shape, group and sprite with the lines that made it so. */
  private versionOf(turn: string, said: string, restored?: number): Version {
    const schedule = buildSchedule(this.entries, EMPTY_STAGE, { retireChoices: false, freshControls: false });
    const at = schedule.pen + 1e6;
    const stage = settle(schedule, EMPTY_STAGE, at);
    const standing = new Set(stage.elements.filter((element) => !element.struck && SHAPES.has(element.kind)).map((element) => element.key));
    const spans = schedule.elements.filter((span) => standing.has(span.key));
    const bySeq = new Map(this.entries.map((entry) => [entry.seq, entry.line] as const));
    const colors = stage.colors as Readonly<Record<string, string>>;
    const idOf = (key: string | null): string | null => (key === null ? null : (spans.find((span) => span.key === key)?.id ?? null));
    const elements: ElementMemory[] = spans.map((span) => {
      const carried = stage.elements.find((element) => element.key === span.key);
      const texts: string[] = [];
      const add = (line: Line | undefined): void => {
        if (line !== undefined) texts.push(serializeLine(settled(line, colors)));
      };
      add(bySeq.get(span.seq));
      if (span.kind === 'sprite') {
        // the rows and frames of a sprite are lines of their own, after its `pix`
        const rest = this.entries.filter((entry) => !entry.void && entry.seq > span.seq && (entry.line.verb === 'row' || entry.line.verb === 'frame') && entry.line.id === span.id);
        const stop = this.entries.find((entry) => !entry.void && entry.seq > span.seq && entry.line.verb === 'pix' && entry.line.id === span.id)?.seq ?? Infinity;
        for (const entry of rest) if (entry.seq < stop) add(entry.line);
      }
      for (const change of span.changes) {
        if (change.kind !== 'set' && change.kind !== 'move' && change.kind !== 'morph') continue;
        const line = bySeq.get(change.seq);
        if (line === undefined) continue;
        if (line.verb === 'set' && !(line.target.kind === 'id' && line.target.id === span.id)) continue;
        if (line.verb === 'move' && line.id !== span.id) continue;
        add(line);
      }
      const at = carried !== undefined && typeof carried.style.at === 'object' && carried.style.at !== null && 'x' in carried.style.at ? carried.style.at : null;
      const fill = carried?.style.fill;
      return {
        id: span.id,
        kind: span.kind as ElementMemory['kind'],
        parent: idOf(span.parent),
        at,
        box: carried === undefined ? null : restingBox(carried, stage.elements),
        fill: typeof fill === 'string' ? fill : '',
        lines: texts,
      };
    });
    const sig = elements.map((element) => element.lines.join(';')).join('\n');
    return { turn, said, sig, elements, styles: Object.fromEntries(this.styleLines), ...(restored === undefined ? {} : { restored }) };
  }

  /** Past the limits the replay's lines go: it starts again from the newest version's resting drawing. The versions keep their own copy of what each held. */
  private trim(): void {
    if (this.lines.length <= MEMORY_LIMITS.lines && this.bytes <= MEMORY_LIMITS.bytes) return;
    this.lines = [];
    this.bytes = 0;
    this.entries = [];
    this.normalizer = this.freshNormalizer();
    const last = this.versions.at(-1);
    let seq = 0;
    for (const element of last?.elements ?? []) {
      for (const text of element.lines) {
        const line = parsed(text);
        if (line === null) continue;
        seq += 1;
        this.push({ turn: last?.turn ?? 't0', seq, text }, line);
      }
    }
  }

  /** The version of a turn, `undo` for the one before the one showing, or null. `-1` is the empty canvas before the first. */
  find(word: string): { readonly index: number; readonly version: Version | null } | null {
    const said = word.trim().toLowerCase();
    if (said === 'undo' || said === 'back' || said === 'prev' || said === 'previous') {
      const last = this.versions.length - 1;
      if (last < 0) return null;
      const showing = this.versions[last]?.restored ?? last;
      const index = showing - 1;
      return { index, version: index < 0 ? null : (this.versions[index] ?? null) };
    }
    // a turn that changed nothing shows what the version before it did
    for (let at = this.versions.length - 1; at >= 0; at -= 1) {
      const version = this.versions[at];
      if (version !== undefined && version.turn === said) return { index: at, version };
    }
    const number = Number(/^t(\d+)$/.exec(said)?.[1] ?? NaN);
    if (!Number.isFinite(number)) return null;
    for (let at = this.versions.length - 1; at >= 0; at -= 1) {
      const version = this.versions[at];
      if (version !== undefined && Number(/^t(\d+)$/.exec(version.turn)?.[1] ?? Infinity) <= number) return { index: at, version };
    }
    return null;
  }

  /**
   * The lines that put a version's whole drawing back: drop what is live, then say every part again, colours as hex. `live` is the ids of
   * the drawn things on stage now (roots), which go first.
   */
  restore(index: number, live: readonly string[]): Recalled {
    const version = index < 0 ? null : (this.versions[index] ?? null);
    const lines: Line[] = [];
    if (live.length > 0) lines.push({ verb: 'drop', target: { kind: 'id', id: live[0] as string }, exit: 'cut', ...(live.length > 1 ? { also: live.slice(1) } : {}) } as Line);
    const ids: string[] = [];
    if (version !== null) {
      for (const [name, text] of Object.entries(version.styles)) {
        const style = parsed(text);
        if (style !== null && version.elements.some((element) => element.lines.some((line) => new RegExp(`\\b${name}\\b`).test(line)))) lines.push(style);
      }
      for (const element of version.elements) {
        ids.push(element.id);
        for (const [n, text] of element.lines.entries()) {
          const line = parsed(text);
          if (line !== null) lines.push(arriving(line, n === 0));
        }
      }
    }
    return { lines, ids, note: version === null ? 'the empty canvas' : `${version.turn} (${version.elements.length} parts)` };
  }

  /**
   * The lines that bring some parts of a turn onto the canvas as they are now: the ids asked for, with everything inside a group. A part
   * comes back under its own id when that is free, else `<id>-<turn>`. Several parts, or a part from inside a group, come as one group.
   * `taken` is what is on the canvas now.
   */
  bring(turn: string, wanted: readonly string[], taken: ReadonlySet<string>, place: { readonly at?: Point; readonly scale?: number; readonly rot?: number }): Recalled | null {
    const found = this.find(turn);
    const version = found?.version ?? null;
    if (version === null) return null;
    const byId = new Map(version.elements.map((element) => [element.id, element] as const));
    const chosen = new Set<string>();
    const take = (id: string): void => {
      if (chosen.has(id) || !byId.has(id)) return;
      chosen.add(id);
      for (const element of version.elements) if (element.parent === id) take(element.id);
    };
    const missing = wanted.filter((id) => !byId.has(id));
    for (const id of wanted) take(id);
    if (chosen.size === 0) return null;
    const asked = wanted.filter((id) => byId.has(id));
    // where a part measures from: its groups' places, added up
    const offsetOf = (id: string): Point => {
      let x = 0;
      let y = 0;
      for (let parent = byId.get(id)?.parent ?? null, depth = 0; parent !== null && depth < 6; depth += 1) {
        const group = byId.get(parent);
        if (group?.at) {
          x += group.at.x;
          y += group.at.y;
        }
        parent = group?.parent ?? null;
      }
      return { x, y };
    };
    const rename = new Map<string, string>();
    const used = new Set<string>(taken);
    const free = (id: string): string => {
      let name = used.has(id) ? `${id}-${turn}` : id;
      for (let n = 2; used.has(name); n += 1) name = `${id}-${turn}-${n}`;
      used.add(name);
      return name.slice(0, 40);
    };
    for (const element of version.elements) if (chosen.has(element.id)) rename.set(element.id, free(element.id));
    // the top of what comes back: the asked-for parts that are not inside another asked-for part
    const tops = asked.filter((id) => {
      for (let parent = byId.get(id)?.parent ?? null; parent !== null; parent = byId.get(parent)?.parent ?? null) if (chosen.has(parent) && asked.includes(parent)) return false;
      return true;
    });
    const single = tops.length === 1 && offsetOf(tops[0] as string).x === 0 && offsetOf(tops[0] as string).y === 0;
    const wrapper = single ? null : free(`back-${turn}`);
    const lines: Line[] = [];
    const tweak = (line: Line): Line => {
      const props = (line as { props?: StyleProps }).props ?? {};
      const next: Record<string, unknown> = { ...props };
      if (place.at !== undefined) next['at'] = place.at;
      if (place.scale !== undefined) next['scale'] = place.scale;
      if (place.rot !== undefined) next['rot'] = place.rot;
      return { ...line, props: next } as Line;
    };
    if (wrapper !== null) {
      const base: Record<string, unknown> = {};
      if (place.at !== undefined) base['at'] = place.at;
      if (place.scale !== undefined) base['scale'] = place.scale;
      if (place.rot !== undefined) base['rot'] = place.rot;
      lines.push({ verb: 'group', id: wrapper, styles: [], props: { ...base, enter: 'cut' } } as Line);
    }
    const subs = new Map<string, string>();
    for (const element of version.elements) {
      if (!chosen.has(element.id)) continue;
      const isTop = tops.includes(element.id);
      for (const [n, text] of element.lines.entries()) {
        const line = parsed(text);
        if (line === null) continue;
        let out = renamed(line, rename);
        if (n === 0 && isTop) {
          const offset = offsetOf(element.id);
          let holder = wrapper;
          if (wrapper !== null && (offset.x !== 0 || offset.y !== 0)) {
            const key = `${offset.x},${offset.y}`;
            let sub = subs.get(key);
            if (sub === undefined) {
              sub = free(`${wrapper}-g${subs.size + 1}`);
              subs.set(key, sub);
              lines.push({ verb: 'group', id: sub, styles: [], props: { in: wrapper, at: offset, enter: 'cut' } } as Line);
            }
            holder = sub;
          }
          const props = { ...((out as { props?: StyleProps }).props ?? {}) } as Record<string, unknown>;
          delete props['in'];
          if (holder !== null) props['in'] = holder;
          out = { ...out, props } as Line;
          if (wrapper === null) out = tweak(out);
        }
        lines.push(arriving(out, n === 0));
      }
    }
    const ids = [...rename.values()];
    const note = `${turn}: ${asked.join(' ')}${missing.length > 0 ? ` (no ${missing.join(' ')} in it)` : ''}`;
    return { lines, ids: wrapper === null ? ids : [wrapper, ...ids], note };
  }

  /** A row of the brief's index for each of the newest versions: the turn, what was asked, and what stood in it. */
  index(limit = 6): readonly { readonly turn: string; readonly said: string; readonly parts: number; readonly roots: readonly string[]; readonly current: boolean }[] {
    const last = this.versions.length - 1;
    return this.versions
      .map((version, at) => ({
        turn: version.turn,
        said: version.said,
        parts: version.elements.length,
        roots: version.elements.filter((element) => element.parent === null).map((element) => element.id),
        current: at === last,
      }))
      .slice(-limit);
  }
}

/** Reads a conversation's drawing memory again from its log records (a page that took the conversation up again). */
export function rebuildMemory(records: readonly { readonly type: string; readonly turn?: string | null; readonly text?: string; readonly seq?: number; readonly input?: { readonly kind: string; readonly text?: string } }[]): DrawingMemory {
  const memory = new DrawingMemory();
  const skipped = new Set<string>();
  for (const record of records) {
    if (record.type === 'turn' && typeof record.turn === 'string') {
      if (record.input?.kind === 'demo') skipped.add(record.turn);
      memory.begin(record.turn, record.input?.text ?? '');
    } else if (record.type === 'line' && typeof record.turn === 'string' && typeof record.text === 'string' && typeof record.seq === 'number' && !skipped.has(record.turn)) {
      memory.record(record.turn, record.seq, record.text);
    }
  }
  memory.close();
  return memory;
}
