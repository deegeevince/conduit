// A change to a figure that is on stage, played on the painter's own clock (language/src/figure.ts, `FIGURE_REVISE`, `reviseTimes`): however the lines of the change arrived, a burst
// or one at a time, what it did to the figure is shown in order. The parts that go (or are put right) fade out one after another; then the parts that come (or are put right) are
// drawn in, the stroke first and the fill after; then the routes; then the labels, each wiped in. What the change left alone is never faded or redrawn: a part that stays stays lit
// throughout, and if the figure was fitted to its room afresh (a scale or a place that is not the one it had) it eases to the new one.
//
// The figure kit lays the figure out as finished frames, once for each layout epoch (`structures.ts`). This takes the layout before the change, the epochs since it (the first is
// where the change began, the last is now) and the second; it tells a part from how it is drawn apart from where and how large (a part, a route, a label), and plays each from
// the time its line arrived. Pure: no DOM, no clock of its own.

import { FIGURE_REVISE, reviseTimes } from '@conduit/language';
import type { ReviseItem } from '@conduit/language';
import type { DrawnFrames } from '../contracts/blocks';
import type { ElementFrame, FigureFrame, ShapeFrame } from '../contracts/frame';

type Frame = FigureFrame | ElementFrame;
type Kind = 'part' | 'route' | 'label' | 'chrome';

interface Group {
  readonly name: string;
  readonly kind: Kind;
  readonly frames: Frame[];
  /** what it is, apart from how much of it is shown and where and how large: its colours and words, and its outline taken to its own box (`norm`); two groups with the same look are the same drawing */
  look: string;
  norm: number[];
  /** where it comes in the drawing order: back to front */
  z: number;
}

export interface RevisionEpoch {
  readonly start: number;
  readonly drawn: DrawnFrames;
}

const isText = (frame: Frame): frame is ElementFrame => 'runs' in frame;
const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/** Which part, route or label a frame belongs to: the figure kit keys its frames `<structure>/<figure>/<part>[~shade]`, `route:<id>…`, `label:<part>:…`, and the band and stepper. */
function groupOf(key: string): { readonly kind: Kind; readonly id: string; readonly local: string } {
  const local = key.split('/').slice(2).join('/');
  if (local.startsWith('label:')) return { kind: 'label', id: local.split(':')[1] ?? local, local };
  if (local.startsWith('route:')) return { kind: 'route', id: local.split(':')[1] ?? local, local };
  if (local === 'band' || local.startsWith('caption') || local.startsWith('stepper')) return { kind: 'chrome', id: local, local };
  return { kind: 'part', id: local.split('~')[0] ?? local, local };
}

/** A shape as it is drawn, whatever its size and place: its colours, and its outline taken to a unit box of its own (a share of its width and height for each point). */
function shapeLook(frame: ShapeFrame): { readonly text: string; readonly norm: number[] } {
  const points = frame.outline.flatMap((line) => line.points);
  const text = `${frame.outline.length}:${points.length}|${frame.fill?.colour ?? ''}>${frame.fill?.to ?? ''}|${frame.stroke?.colour ?? ''}`;
  if (points.length === 0) return { text, norm: [] };
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const wide = Math.max(...xs) - left || 1;
  const high = Math.max(...ys) - top || 1;
  return { text, norm: points.flatMap((point) => [(point.x - left) / wide, (point.y - top) / high]) };
}

/** Whether two groups are the same drawing: the same colours and words, and outlines that are the same shape to within a few hundredths of the box (a part set again at another size). */
function sameLook(a: Group, b: Group): boolean {
  if (a.look !== b.look || a.norm.length !== b.norm.length) return false;
  for (let i = 0; i < a.norm.length; i += 1) if (Math.abs((a.norm[i] as number) - (b.norm[i] as number)) > 0.04) return false;
  return true;
}

function groups(drawn: DrawnFrames): Map<string, Group> {
  const out = new Map<string, Group>();
  const all: Frame[] = [...drawn.figures, ...drawn.elements];
  for (const frame of all) {
    const { kind, id, local } = groupOf(frame.key);
    const name = `${kind}:${id}`;
    const have = out.get(name) ?? { name, kind, frames: [], look: '', norm: [], z: frame.z };
    have.frames.push(frame);
    have.z = Math.min(have.z, frame.z);
    // a part is what its fill and edge draw (the shadows and lights follow them); a route is its line; a label is its words
    if (isText(frame)) have.look += kind === 'label' || kind === 'part' ? `${frame.runs.map((run) => run.text).join(' ')};` : '';
    else if (frame.kind === 'shape') {
      if ((kind === 'part' && (!local.includes('~') || local.endsWith('~edge'))) || (kind === 'route' && !/:(chevron|dot):/.test(local))) {
        const look = shapeLook(frame);
        have.look += `${look.text};`;
        have.norm.push(...look.norm);
      }
    }
    out.set(name, have);
  }
  return out;
}

/** Whether two layouts of a figure draw the same parts, routes and labels (apart from where the whole stands): an epoch that changed nothing is not a change. */
export function sameFigure(a: DrawnFrames, b: DrawnFrames): boolean {
  const was = groups(a);
  const is = groups(b);
  if (was.size !== is.size) return false;
  for (const [name, group] of was) {
    const there = is.get(name);
    if (there === undefined || !sameLook(group, there)) return false;
  }
  return true;
}

/** A frame part-way (`p`, 0..1) from where and how large it was to where and how large it is, when it is the same drawing. */
function tweened(frame: Frame, old: Frame | undefined, p: number): Frame {
  if (old === undefined || p >= 1) return frame;
  const mix = (a: number, b: number): number => a + (b - a) * p;
  if (isText(frame) && isText(old)) return { ...frame, x: mix(old.x, frame.x), y: mix(old.y, frame.y), fontSize: mix(old.fontSize, frame.fontSize), width: mix(old.width, frame.width), height: mix(old.height, frame.height) };
  if (!isText(frame) && !isText(old) && frame.kind === 'shape' && old.kind === 'shape' && frame.outline.length === old.outline.length && frame.outline.every((line, i) => line.points.length === (old.outline[i]?.points.length ?? -1))) {
    const outline = frame.outline.map((line, i) => ({ closed: line.closed, points: line.points.map((point, j) => ({ x: mix(old.outline[i]?.points[j]?.x ?? point.x, point.x), y: mix(old.outline[i]?.points[j]?.y ?? point.y, point.y) })) }));
    return { ...frame, outline, geometryKey: `${frame.geometryKey}~m${Math.round(p * 16)}`, transform: { ...frame.transform, e: mix(old.transform.e, frame.transform.e), f: mix(old.transform.f, frame.transform.f) }, ...(frame.stroke === null || old.stroke === null ? {} : { stroke: { ...frame.stroke, width: mix(old.stroke.width, frame.stroke.width) } }) } as ShapeFrame;
  }
  return frame;
}

/**
 * The frames to draw `tq` seconds into the turn, while a change to the figure plays: `before` the figure as it was, `chain` the layouts since the change began (the last is the one now),
 * `previous` the layout before the last. `done` when the change has finished playing.
 */
export function reviseFigure(args: { readonly before: DrawnFrames; readonly chain: readonly RevisionEpoch[]; readonly previous: DrawnFrames | null; readonly tq: number }): { readonly figures: FigureFrame[]; readonly elements: ElementFrame[]; readonly done: boolean } {
  const { before, chain, previous, tq } = args;
  const current = chain[chain.length - 1] as RevisionEpoch;
  const was = groups(before);
  const is = groups(current.drawn);
  const looks = chain.map((epoch) => groups(epoch.drawn));

  // what goes and what comes, each with the moment of the layout that first had it so
  interface Played { readonly group: Group; readonly item: number }
  const items: ReviseItem[] = [];
  const leaving: Played[] = [];
  const coming: Played[] = [];
  for (const [name, group] of was) {
    if (group.kind === 'chrome') continue;
    const now = is.get(name);
    if (now !== undefined && sameLook(now, group)) continue;
    // the first layout, since the change began, in which it was not as it had been
    const at = chain.find((_, i) => {
      const there = looks[i]?.get(name);
      return there === undefined || !sameLook(there, group);
    })?.start ?? current.start;
    leaving.push({ group, item: items.length });
    items.push({ at, kind: 'leave' });
  }
  for (const [name, group] of is) {
    if (group.kind === 'chrome') continue;
    const had = was.get(name);
    if (had !== undefined && sameLook(had, group)) continue;
    // the first layout of the unbroken run of them that have it as it is now
    let i = chain.length - 1;
    while (i > 0) {
      const earlier = looks[i - 1]?.get(name);
      if (earlier === undefined || !sameLook(earlier, group)) break;
      i -= 1;
    }
    coming.push({ group, item: items.length });
    items.push({ at: chain[i]?.start ?? current.start, kind: group.kind === 'route' ? 'route' : group.kind === 'label' ? 'label' : 'part' });
  }
  const times = reviseTimes(items);
  const first = items.length === 0 ? current.start : Math.min(...items.map((item) => item.at));
  const t = tq - first;
  const k = times.pace;
  const seconds = (kind: ReviseItem['kind']): number => k * (kind === 'leave' ? FIGURE_REVISE.leave : kind === 'part' ? FIGURE_REVISE.enter : kind === 'route' ? FIGURE_REVISE.route : FIGURE_REVISE.label);
  const progress = (played: Played): number => {
    const item = items[played.item] as ReviseItem;
    return clamp01((t - (times.starts[played.item] ?? 0)) / seconds(item.kind));
  };

  const figures: FigureFrame[] = [];
  const elements: ElementFrame[] = [];
  const push = (frame: Frame): void => void (isText(frame) ? elements.push(frame) : figures.push(frame));
  const comingNames = new Set(coming.map((played) => played.group.name));

  // what leaves: the old picture, whole until its turn, then fading; its old key is kept when nothing replaces it and a key of its own when something does
  for (const played of leaving) {
    const p = progress(played);
    if (p >= 1) continue;
    const replaced = is.has(played.group.name);
    for (const frame of played.group.frames) push({ ...frame, ...(replaced ? { key: `${frame.key}~was` } : {}), opacity: frame.opacity * (1 - p) } as Frame);
  }

  // what stays is never faded; if the figure was fitted afresh it eases to where it is now
  const moved = clamp01((tq - current.start) / FIGURE_REVISE.move);
  const olds = new Map<string, Frame>();
  if (previous !== null && moved < 1) for (const frame of [...previous.figures, ...previous.elements]) olds.set(frame.key, frame);
  for (const [name, group] of is) {
    if (comingNames.has(name)) continue;
    for (const frame of group.frames) push(tweened(frame, olds.get(frame.key), 1 - (1 - moved) * (1 - moved)));
  }

  // what comes: nothing until its turn, then drawn in (the line first, the colour after it; a label's words wiped in)
  for (const played of coming) {
    const p = progress(played);
    const startsAt = times.starts[played.item] ?? 0;
    if (t < startsAt) continue;
    for (const frame of played.group.frames) {
      if (p >= 1) {
        push(frame);
        continue;
      }
      if (isText(frame)) {
        push({ ...frame, opacity: frame.opacity * Math.min(1, p * 3), runs: frame.runs.map((run) => ({ ...run, reveal: Math.min(run.reveal, p) })) });
        continue;
      }
      if (frame.kind !== 'shape') {
        push({ ...frame, opacity: frame.opacity * p } as FigureFrame);
        continue;
      }
      const line = Math.min(1, p / 0.7);
      const colour = clamp01((p - 0.25) / 0.75);
      push({ ...frame, opacity: frame.opacity * (frame.fill === null ? Math.min(1, p * 4) : colour), ...(frame.stroke === null ? {} : { stroke: { ...frame.stroke, progress: frame.stroke.progress * line } }) });
    }
  }
  return { figures, elements, done: t >= times.end && moved >= 1 };
}
