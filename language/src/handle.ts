// A hand on a drawn thing works a slider: given what a slider does to a thing, which value keeps the thing nearest the finger? Pure
// search over a pose function; nothing here knows a control, a pointer or a painter. The pose is whatever the drawing does at a value (a turn about a
// pivot, a move along an outline, a point on a ball under a yaw and a pitch), so one solver serves every handle.
//
// It looks near the current value first. A slider that spins a thing is periodic, so the target is reached at 90, 450 and 810 on a 0 to 1080 slider;
// the answer is the one nearest where the slider stands (a time slider of three years stays in its lap), and a place elsewhere is taken only if the thing is
// really nearer the finger there, not merely as near. The cost is a hard cap on calls to the pose: 96 for one value, 256 for two.
import type { Point } from './types';

/** What a slider offers: its ends, and the step its values come in (null for any value between). */
export interface HandleRange {
  readonly min: number;
  readonly max: number;
  readonly step: number | null;
}

const GOLDEN = (Math.sqrt(5) - 1) / 2;

interface Axis {
  readonly lo: number;
  readonly hi: number;
  readonly span: number;
  readonly step: number | null;
  /** how many whole steps fit, when there is a step */
  readonly top: number;
  readonly decimals: number;
}

function decimalsOf(n: number): number {
  const text = String(n);
  if (text.includes('e')) return 12;
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : Math.min(12, text.length - dot - 1);
}

function axisOf(range: HandleRange): Axis {
  const lo = Math.min(range.min, range.max);
  const hi = Math.max(range.min, range.max);
  const step = range.step !== null && Number.isFinite(range.step) && range.step > 0 ? range.step : null;
  return {
    lo,
    hi,
    span: hi - lo,
    step,
    top: step === null ? 0 : Math.floor((hi - lo) / step + 1e-9),
    decimals: step === null ? 0 : Math.max(decimalsOf(step), decimalsOf(lo)),
  };
}

function clampTo(axis: Axis, v: number): number {
  return Math.min(axis.hi, Math.max(axis.lo, Number.isFinite(v) ? v : axis.lo));
}

/** The value of the k-th step, written without the dust of adding a step k times. */
function stepValue(axis: Axis, k: number): number {
  const index = Math.min(axis.top, Math.max(0, k));
  return Number((axis.lo + index * (axis.step ?? 0)).toFixed(axis.decimals));
}

/** The steps either side of a value, nearest first; a value on a step is its own. */
function stepsAround(axis: Axis, v: number): number[] {
  if (axis.step === null) return [clampTo(axis, v)];
  const at = (clampTo(axis, v) - axis.lo) / axis.step;
  const below = Math.floor(at + 1e-9);
  const above = Math.min(axis.top, below + 1);
  const candidates = [below, above].filter((k, i, all) => all.indexOf(k) === i).sort((p, q) => Math.abs(p - at) - Math.abs(q - at));
  return candidates.map((k) => stepValue(axis, k));
}

/** Two costs are one cost if they differ by no more than the dust of working them out. */
function tied(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * (1 + Math.min(a, b));
}

/**
 * The value of a slider that puts a thing nearest a point. `pose` is where the thing is at a value; `from` is where the slider stands. At most `evals` calls
 * to `pose` (96 by default), and a value that comes in the slider's steps and inside its ends.
 *
 * Near `from` first: it samples the whole slider, more finely about `from`, and looks at each valley of the samples from the nearest out, so a 0 to 1080
 * slider at 400 whose thing is at 90 degrees round a pivot gives 450, not 90. A valley further out wins only if the thing is nearer the point there, and of
 * places as near as each other (the laps of a spin) the one nearest `from` wins.
 */
export function nearestValue(pose: (v: number) => Point, target: Point, range: HandleRange, from: number, evals = 96): number {
  const axis = axisOf(range);
  const cap = Math.max(1, Math.floor(evals));
  const start = clampTo(axis, from);
  if (axis.span === 0) return axis.lo;
  let used = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const costs = new Map<number, number>();
  const poses = new Map<number, Point>();
  const cost = (v: number): number => {
    const seen = costs.get(v);
    if (seen !== undefined) return seen;
    if (used >= cap) return Infinity;
    used += 1;
    const p = pose(v);
    poses.set(v, p);
    const squared = (p.x - target.x) ** 2 + (p.y - target.y) ** 2;
    if (Number.isFinite(p.x) && Number.isFinite(p.y)) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    const result = Number.isFinite(squared) ? squared : Infinity;
    costs.set(v, result);
    return result;
  };
  const snapReserve = axis.step === null ? 0 : 2;
  const room = (): boolean => used < cap - snapReserve;

  // A slider with few enough steps is just tried at every one. The nearest to where it stands wins a tie, which is what keeps a lap.
  if (axis.step !== null && axis.top + 1 <= cap) {
    let best = stepValue(axis, 0);
    let bestCost = Infinity;
    for (let k = 0; k <= axis.top; k += 1) {
      const v = stepValue(axis, k);
      const c = cost(v);
      if (c < bestCost && !tied(c, bestCost)) {
        best = v;
        bestCost = c;
      } else if (tied(c, bestCost) && Math.abs(v - start) < Math.abs(best - start)) {
        best = v;
      }
    }
    return best;
  }

  /** The lowest point inside (lo, hi) by golden sections, given a bracket whose middle `mid` is no higher than its ends. */
  const refine = (lo: number, hi: number, mid: number): number => {
    let a = lo;
    let b = hi;
    let best = mid;
    let bestCost = cost(mid);
    let c = b - GOLDEN * (b - a);
    let d = a + GOLDEN * (b - a);
    let fc = cost(c);
    let fd = cost(d);
    for (const [x, f] of [[c, fc], [d, fd]] as const) {
      if (f < bestCost) {
        best = x;
        bestCost = f;
      }
    }
    while (b - a > axis.span * 1e-5 && room()) {
      if (fc < fd) {
        b = d;
        d = c;
        fd = fc;
        c = b - GOLDEN * (b - a);
        fc = cost(c);
        if (fc < bestCost) {
          best = c;
          bestCost = fc;
        }
      } else {
        a = c;
        c = d;
        fc = fd;
        d = a + GOLDEN * (b - a);
        fd = cost(d);
        if (fd < bestCost) {
          best = d;
          bestCost = fd;
        }
      }
    }
    return best;
  };

  // Sample the whole slider, with a finer run of samples about where it stands, then look at each valley of the samples nearest-first.
  const near = Math.max(axis.span / 80, axis.step ?? 0);
  const uniform = Math.min(28, Math.max(3, Math.floor(cap * 0.3)));
  const asked = new Set<number>([start]);
  for (let i = 0; i < uniform; i += 1) asked.add(clampTo(axis, axis.lo + (axis.span * i) / (uniform - 1)));
  for (let k = 1; k <= 3; k += 1) {
    asked.add(clampTo(axis, start - k * near));
    asked.add(clampTo(axis, start + k * near));
  }
  const places = [...asked].sort((p, q) => p - q);
  // the ones nearest the current value are paid for first, in case the budget is small
  for (const v of [...places].sort((p, q) => Math.abs(p - start) - Math.abs(q - start))) cost(v);
  const at = (i: number): number => (i < 0 || i >= places.length ? Infinity : cost(places[i] ?? start));
  const dust = (1e-3 * Math.hypot(maxX - minX, maxY - minY)) ** 2;
  const valleys: number[] = [];
  for (let i = 0; i < places.length; i += 1) {
    const here = at(i);
    if (Number.isFinite(here) && (i === 0 || here < at(i - 1)) && here <= at(i + 1)) valleys.push(i);
  }
  if (valleys.length === 0 || places.every((v) => tied(cost(v), cost(start)))) return axis.step === null ? start : (stepsAround(axis, start)[0] ?? start);
  // how fast the thing moves, for a bound on how low a valley can go between its samples
  let speed = 0;
  for (let i = 1; i < places.length; i += 1) {
    const a = places[i - 1];
    const b = places[i];
    const pa = a === undefined ? undefined : poses.get(a);
    const pb = b === undefined ? undefined : poses.get(b);
    if (a === undefined || b === undefined || pa === undefined || pb === undefined || b <= a) continue;
    const moved = Math.hypot(pb.x - pa.x, pb.y - pa.y);
    if (Number.isFinite(moved)) speed = Math.max(speed, moved / (b - a));
  }
  let best = start;
  let bestCost = Infinity;
  for (const i of valleys.sort((p, q) => Math.abs((places[p] ?? start) - start) - Math.abs((places[q] ?? start) - start))) {
    if (!room()) break;
    const v = places[i] ?? start;
    const lo = places[i - 1] ?? v;
    const hi = places[i + 1] ?? v;
    const floor = Math.max(0, Math.sqrt(at(i)) - speed * Math.max(v - lo, hi - v)) ** 2;
    if (bestCost < Infinity && floor > bestCost + dust) continue;
    const found = refine(lo, hi, v);
    const foundCost = cost(found);
    if (bestCost === Infinity || foundCost < bestCost - dust || (foundCost <= bestCost + dust && Math.abs(found - start) < Math.abs(best - start))) {
      best = found;
      bestCost = Math.min(foundCost, bestCost);
    }
  }
  if (bestCost === Infinity) {
    // no budget to look at a valley: the best of what was sampled
    for (const [v, c] of costs) {
      if (c < bestCost) {
        best = v;
        bestCost = c;
      }
    }
  }

  if (axis.step === null) return best;
  const around = stepsAround(axis, best);
  let chosen = around[0] ?? best;
  let chosenCost = Infinity;
  for (const v of around) {
    const c = cost(v);
    if (c < chosenCost && !tied(c, chosenCost)) {
      chosen = v;
      chosenCost = c;
    }
  }
  return chosen;
}

/** The two values of a pair of sliders that put a thing nearest a point, a sphere turned by yaw and pitch for one. */
export function nearestPair(pose: (a: number, b: number) => Point, target: Point, ra: HandleRange, rb: HandleRange, from: readonly [number, number], evals = 256): [number, number] {
  const axes = [axisOf(ra), axisOf(rb)] as const;
  const cap = Math.max(1, Math.floor(evals));
  const start: [number, number] = [clampTo(axes[0], from[0]), clampTo(axes[1], from[1])];
  let used = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  interface Miss {
    readonly dx: number;
    readonly dy: number;
    readonly c: number;
  }
  const seen = new Map<string, Miss>();
  const miss = (a: number, b: number): Miss => {
    const key = `${a},${b}`;
    const known = seen.get(key);
    if (known !== undefined) return known;
    if (used >= cap) return { dx: 0, dy: 0, c: Infinity };
    used += 1;
    const p = pose(a, b);
    const dx = p.x - target.x;
    const dy = p.y - target.y;
    const c = dx * dx + dy * dy;
    const result: Miss = Number.isFinite(c) ? { dx, dy, c } : { dx: 0, dy: 0, c: Infinity };
    if (Number.isFinite(c)) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    seen.set(key, result);
    return result;
  };
  const snapReserve = axes[0].step === null && axes[1].step === null ? 0 : 4;
  const limit = cap - snapReserve;

  /**
   * Damped Gauss-Newton from a start: two calls to feel which way each slider moves the thing, then a try; a try that does not help makes the damping heavier,
   * one that does makes it lighter. It starts heavy (a short, careful first step), because a thing turned by two angles is far from straight and a long first
   * step can land against the end of a slider and stay there.
   */
  const descend = (begin: readonly [number, number], allowance: number): { at: [number, number]; c: number } => {
    const stop = Math.min(limit, used + allowance);
    let at: [number, number] = [begin[0], begin[1]];
    let now = miss(at[0], at[1]);
    let damping = 1;
    while (used < stop && now.c > 1e-14 && Number.isFinite(now.c)) {
      const columns: [number, number][] = [];
      for (const i of [0, 1] as const) {
        const axis = axes[i];
        if (axis.span === 0) {
          columns.push([0, 0]);
          continue;
        }
        const h = Math.max(axis.span * 1e-5, 1e-9);
        const forward = at[i] + h <= axis.hi;
        const probe: [number, number] = [at[0], at[1]];
        probe[i] = forward ? at[i] + h : at[i] - h;
        const moved = miss(probe[0], probe[1]);
        const sign = forward ? 1 : -1;
        columns.push([(moved.dx - now.dx) / (sign * h), (moved.dy - now.dy) / (sign * h)]);
      }
      const [c0, c1] = columns as [[number, number], [number, number]];
      const a00 = c0[0] * c0[0] + c0[1] * c0[1];
      const a11 = c1[0] * c1[0] + c1[1] * c1[1];
      const a01 = c0[0] * c1[0] + c0[1] * c1[1];
      const g0 = c0[0] * now.dx + c0[1] * now.dy;
      const g1 = c1[0] * now.dx + c1[1] * now.dy;
      let moved = false;
      for (let tries = 0; tries < 10 && used < stop; tries += 1) {
        const m00 = a00 + damping * (a00 + 1e-12);
        const m11 = a11 + damping * (a11 + 1e-12);
        const det = m00 * m11 - a01 * a01;
        if (!(Math.abs(det) > 0)) {
          damping *= 10;
          continue;
        }
        const next: [number, number] = [
          clampTo(axes[0], at[0] - (m11 * g0 - a01 * g1) / det),
          clampTo(axes[1], at[1] - (m00 * g1 - a01 * g0) / det),
        ];
        if (Math.abs(next[0] - at[0]) <= axes[0].span * 1e-9 && Math.abs(next[1] - at[1]) <= axes[1].span * 1e-9) break;
        const tried = miss(next[0], next[1]);
        if (tried.c < now.c) {
          const gain = now.c - tried.c;
          at = next;
          now = tried;
          damping = Math.max(damping / 4, 1e-9);
          moved = gain > 1e-6 * now.c;
          break;
        }
        damping *= 4;
      }
      if (!moved) break;
    }
    return { at, c: now.c };
  };

  let best = descend(start, Math.floor(cap * 0.4));

  // Not an exact hit: it may have settled against an end of a slider. Look over both sliders, and take the best of what a few starts reach.
  if (best.c > 1e-8 && used < limit) {
    const count = 5;
    const grid: { at: [number, number]; c: number }[] = [];
    for (let i = 0; i < count && used < limit; i += 1) {
      for (let j = 0; j < count && used < limit; j += 1) {
        const a = clampTo(axes[0], axes[0].lo + (axes[0].span * i) / (count - 1));
        const b = clampTo(axes[1], axes[1].lo + (axes[1].span * j) / (count - 1));
        grid.push({ at: [a, b], c: miss(a, b).c });
      }
    }
    const dust = (1e-3 * Math.hypot(maxX - minX, maxY - minY)) ** 2;
    for (const sample of grid.sort((p, q) => p.c - q.c).slice(0, 2)) {
      if (used >= limit || best.c <= 1e-8) break;
      const found = descend(sample.at, Math.floor(cap * 0.25));
      if (found.c < best.c - dust) best = found;
    }
  }

  if (axes[0].step === null && axes[1].step === null) return best.at;
  let chosen: [number, number] = best.at;
  let chosenCost = Infinity;
  for (const a of stepsAround(axes[0], best.at[0])) {
    for (const b of stepsAround(axes[1], best.at[1])) {
      const c = miss(a, b).c;
      if (c < chosenCost && !tied(c, chosenCost)) {
        chosen = [a, b];
        chosenCost = c;
      }
    }
  }
  return chosen;
}
