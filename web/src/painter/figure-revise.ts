// A change to a figure that is on stage, played on the painter's own clock (language/src/figure.ts, `FIGURE_REVISE`): however the lines of the change arrived, a burst
// or one at a time, what it did to the figure is shown in order. The parts that go (or are put right) fade out one after another; then the parts that come (or are put
// right) are drawn in, the stroke first and the fill after; then the routes; then the labels, each wiped in. What the change left alone stands as it was throughout.
//
// The figure kit lays the figure out as finished frames, once for how it was and once for how it is (two layout epochs, `structures.ts`); this takes the two and the seconds
// since the second began. Pure: no DOM, no clock of its own.

import { FIGURE_REVISE } from '@conduit/language';
import type { DrawnFrames } from '../contracts/blocks';
import type { ElementFrame, FigureFrame, ShapeFrame } from '../contracts/frame';

type Frame = FigureFrame | ElementFrame;
type Kind = 'part' | 'route' | 'label' | 'chrome';

interface Group {
  readonly name: string;
  readonly kind: Kind;
  readonly frames: Frame[];
  /** what it looks like, apart from how much of it is shown: two groups with the same look are the same drawing */
  look: string;
  /** where it comes in the drawing order: back to front */
  readonly z: number;
}

const isText = (frame: Frame): frame is ElementFrame => 'runs' in frame;

/** Which part, route or label a frame belongs to: the figure kit keys its frames `<structure>/<figure>/<part>[~shade]`, `route:<id>…`, `label:<part>:…`, and the band and stepper. */
function groupOf(key: string): { readonly kind: Kind; readonly id: string } {
  const local = key.split('/').slice(2).join('/');
  if (local.startsWith('label:')) return { kind: 'label', id: local.split(':')[1] ?? local };
  if (local.startsWith('route:')) return { kind: 'route', id: local.split(':')[1] ?? local };
  if (local === 'band' || local.startsWith('caption') || local.startsWith('stepper')) return { kind: 'chrome', id: local };
  return { kind: 'part', id: local.split('~')[0] ?? local };
}

function groups(drawn: DrawnFrames): Map<string, Group> {
  const out = new Map<string, Group>();
  const all: Frame[] = [...drawn.figures, ...drawn.elements];
  for (const frame of all) {
    const { kind, id } = groupOf(frame.key);
    const name = `${kind}:${id}`;
    const have = out.get(name) ?? { name, kind, frames: [], look: '', z: frame.z };
    have.frames.push(frame);
    have.look += isText(frame) ? `${frame.runs.map((run) => run.text).join(' ')}|${Math.round(frame.x)}|${Math.round(frame.y)}|${frame.fontSize};` : frame.kind === 'shape' ? `${frame.geometryKey}|${JSON.stringify(frame.fill)}|${frame.stroke?.colour ?? ''}|${frame.stroke?.width ?? ''};` : `${frame.key};`;
    out.set(name, { ...have, z: Math.min(have.z, frame.z) });
  }
  return out;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/** Whether two layouts of a figure draw the same parts, routes and labels (apart from where the whole stands): an epoch that changed nothing is not a change. */
export function sameFigure(a: DrawnFrames, b: DrawnFrames): boolean {
  const was = groups(a);
  const is = groups(b);
  if (was.size !== is.size) return false;
  for (const [name, group] of was) if (is.get(name)?.look !== group.look) return false;
  return true;
}

/** `frames` with how much of each is shown at `since` seconds into the change; `done` when the change has finished playing. */
export function reviseFigure(before: DrawnFrames, now: DrawnFrames, since: number, q = 1): { readonly figures: FigureFrame[]; readonly elements: ElementFrame[]; readonly done: boolean } {
  const was = groups(before);
  const is = groups(now);
  const gone: Group[] = [];
  const coming: Group[] = [];
  for (const [name, group] of was) {
    const there = is.get(name);
    if (group.kind === 'chrome') continue;
    if (there === undefined || there.look !== group.look) gone.push(group);
  }
  for (const [name, group] of is) {
    const here = was.get(name);
    if (group.kind === 'chrome') continue;
    if (here === undefined || here.look !== group.look) coming.push(group);
  }
  const byZ = (a: Group, b: Group): number => a.z - b.z;
  const order = { part: 0, route: 1, label: 2, chrome: 3 } as const;
  gone.sort((a, b) => order[a.kind] - order[b.kind] || byZ(a, b));
  const parts = coming.filter((group) => group.kind === 'part').sort(byZ);
  const routes = coming.filter((group) => group.kind === 'route').sort(byZ);
  const labels = coming.filter((group) => group.kind === 'label').sort(byZ);

  // the times, in seconds from the start of the change: who leaves, then who is drawn, then the routes, then the labels
  const start = new Map<string, { readonly at: number; readonly seconds: number }>();
  gone.forEach((group, i) => start.set(`out:${group.name}`, { at: i * FIGURE_REVISE.leaveStagger, seconds: FIGURE_REVISE.leave }));
  const leaves = gone.length === 0 ? 0 : (gone.length - 1) * FIGURE_REVISE.leaveStagger + FIGURE_REVISE.leave;
  parts.forEach((group, i) => start.set(`in:${group.name}`, { at: leaves + i * FIGURE_REVISE.enterStagger, seconds: FIGURE_REVISE.enter }));
  const drawn = leaves + (parts.length === 0 ? 0 : (parts.length - 1) * FIGURE_REVISE.enterStagger + FIGURE_REVISE.enter);
  routes.forEach((group) => start.set(`in:${group.name}`, { at: drawn, seconds: FIGURE_REVISE.route }));
  const routed = drawn + (routes.length === 0 ? 0 : FIGURE_REVISE.route);
  labels.forEach((group, i) => start.set(`in:${group.name}`, { at: routed + i * FIGURE_REVISE.labelStagger, seconds: FIGURE_REVISE.label }));
  const total = routed + (labels.length === 0 ? 0 : (labels.length - 1) * FIGURE_REVISE.labelStagger + FIGURE_REVISE.label);
  // a long change is played faster rather than longer than `most`
  const pace = total > FIGURE_REVISE.most ? total / FIGURE_REVISE.most : 1;
  const at = since * pace;
  const progress = (name: string): number | null => {
    const found = start.get(name);
    return found === undefined ? null : clamp01((at - found.at) / found.seconds);
  };

  const figures: FigureFrame[] = [];
  const elements: ElementFrame[] = [];
  const push = (frame: Frame): void => void (isText(frame) ? elements.push(frame) : figures.push(frame));
  // what leaves is the old picture fading, the old key kept when nothing replaces it and a key of its own when something does
  for (const group of gone) {
    const p = progress(`out:${group.name}`) ?? 1;
    if (p >= 1) continue;
    const replaced = is.has(group.name);
    for (const frame of group.frames) {
      const key = replaced ? `${frame.key}~was` : frame.key;
      push({ ...frame, key, opacity: frame.opacity * (1 - p) } as Frame);
    }
  }
  const comingNames = new Set(coming.map((group) => group.name));
  // what the change left alone stands as it was; if its place moved with the layout, it eases across (as any drawn frame does between two layouts)
  const olds = new Map<string, Frame>();
  if (q < 1) for (const frame of [...before.figures, ...before.elements]) olds.set(frame.key, frame);
  const eased = (frame: Frame): Frame => {
    const old = olds.get(frame.key);
    if (old === undefined) return frame;
    if (isText(frame) && isText(old)) return { ...frame, x: old.x + (frame.x - old.x) * q, y: old.y + (frame.y - old.y) * q };
    if (!isText(frame) && !isText(old) && 'transform' in frame && 'transform' in old) return { ...frame, transform: { ...frame.transform, e: old.transform.e + (frame.transform.e - old.transform.e) * q, f: old.transform.f + (frame.transform.f - old.transform.f) * q } } as FigureFrame;
    return frame;
  };
  for (const [name, group] of is) {
    if (!comingNames.has(name)) {
      for (const frame of group.frames) push(eased(frame));
      continue;
    }
    const p = progress(`in:${name}`) ?? 1;
    if (at < (start.get(`in:${name}`)?.at ?? 0)) continue;
    for (const frame of group.frames) {
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
      // drawn in: the line first (the stroke runs along the outline), the colour after it
      const shape: ShapeFrame = frame;
      const line = Math.min(1, p / 0.7);
      const colour = clamp01((p - 0.25) / 0.75);
      push({ ...shape, opacity: shape.opacity * (shape.fill === null ? Math.min(1, p * 4) : colour), ...(shape.stroke === null ? {} : { stroke: { ...shape.stroke, progress: shape.stroke.progress * line } }) });
    }
  }
  return { figures, elements, done: at >= total };
}
