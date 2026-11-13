// Where a label goes: beside the thing it names, clear of every other piece
// of text and of every drawn line and fill, and never nearer to something it
// does not name. Pure geometry on the reading plane in stage units; the
// painter hands it what is on stage at the moment and takes back a centre.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Something drawn that a label must not sit on. */
export interface Obstacle {
  readonly rect: Rect;
  /**
   * A large closed shape (a box, a panel): a label may sit wholly inside it
   * but may not cross its edge. A small one is avoided whole.
   */
  readonly outline: boolean;
}

export type Side = 'above' | 'below' | 'left' | 'right';

export interface LabelQuery {
  /** the label's box */
  readonly w: number;
  readonly h: number;
  /** the thing named */
  readonly target: Rect;
  /** the canvas: the label stays inside it */
  readonly region: Rect;
  readonly side: Side | 'auto';
  /** clear space between the target and the label */
  readonly gap: number;
  /** slide step along the target's edge */
  readonly step: number;
  /** clear space kept between two pieces of text */
  readonly pad: number;
  /** text already on stage: other labels and the layout's lines */
  readonly taken: readonly Rect[];
  /** drawn things other than the target and its parts */
  readonly obstacles: readonly Obstacle[];
  /** where a label may go when nowhere inside `region` is clear of text: the room on screen around the canvas. Absent: nowhere else. */
  readonly outer?: Rect;
}

const OPPOSITE: Readonly<Record<Side, Side>> = { above: 'below', below: 'above', left: 'right', right: 'left' };
const MAX_SLIDE = 16;
const MAX_STACK = 8;

const hit = (a: Rect, b: Rect, pad: number): boolean => a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
const within = (inner: Rect, outer: Rect): boolean => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

/** Empty space between two rectangles; 0 when they touch or overlap. */
function gapBetween(a: Rect, b: Rect): number {
  const dx = Math.max(0, Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w)));
  const dy = Math.max(0, Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h)));
  return Math.hypot(dx, dy);
}

/** How far two spans overlap on one axis (negative: they are apart). */
const overlapOn = (a0: number, a1: number, b0: number, b1: number): number => Math.min(a1, b1) - Math.max(a0, b0);

/**
 * The centre for a label. Tries the asked side, then the opposite, then the
 * other two, sliding along the target's edge; the first pass keeps the label
 * squarely against its target and clear of everything, later passes let it
 * drift along the edge and finally ignore drawn things. Never returns a spot
 * on text that a clear spot would avoid.
 */
export function placeLabel(q: LabelQuery): { x: number; y: number } {
  const inCanvas = findClear(q);
  if (inCanvas !== null) return inCanvas;
  // Words on words are worse than a label a little way off the canvas.
  const outside = q.outer === undefined ? null : findClear({ ...q, region: q.outer });
  if (outside !== null) return outside;
  const { w, h, target, region, gap } = q;
  const centre = { x: target.x + target.w / 2, y: target.y + target.h / 2 };
  const c =
    q.side === 'above'
      ? { x: centre.x, y: target.y - gap - h / 2 }
      : q.side === 'left'
        ? { x: target.x - gap - w / 2, y: centre.y }
        : q.side === 'right'
          ? { x: target.x + target.w + gap + w / 2, y: centre.y }
          : { x: centre.x, y: target.y + target.h + gap + h / 2 };
  return {
    x: Math.max(region.x + w / 2, Math.min(region.x + region.w - w / 2, c.x)),
    y: Math.max(region.y + h / 2, Math.min(region.y + region.h - h / 2, c.y)),
  };
}

function findClear(q: LabelQuery): { x: number; y: number } | null {
  const { w, h, target, region, gap } = q;
  const centre = { x: target.x + target.w / 2, y: target.y + target.h / 2 };
  const sideCentre = (side: Side, along: number): { x: number; y: number } => {
    if (side === 'above') return { x: centre.x + along, y: target.y - gap - h / 2 };
    if (side === 'below') return { x: centre.x + along, y: target.y + target.h + gap + h / 2 };
    if (side === 'left') return { x: target.x - gap - w / 2, y: centre.y + along };
    return { x: target.x + target.w + gap + w / 2, y: centre.y + along };
  };
  const room: Record<Side, number> = {
    above: target.y - region.y - (gap + h),
    below: region.y + region.h - (target.y + target.h) - (gap + h),
    left: target.x - region.x - (gap + w),
    right: region.x + region.w - (target.x + target.w) - (gap + w),
  };
  const asked = q.side;
  const order: Side[] =
    asked === 'auto'
      ? (['above', 'below', 'right', 'left'] as const).slice().sort((a, b) => room[b] - room[a])
      : [asked, OPPOSITE[asked], ...((asked === 'above' || asked === 'below' ? ['right', 'left'] : ['below', 'above']) as Side[])];
  const rectOf = (c: { x: number; y: number }): Rect => ({ x: c.x - w / 2, y: c.y - h / 2, w, h });
  const inside = (c: { x: number; y: number }): boolean => {
    const r = rectOf(c);
    return r.x >= region.x - 0.5 && r.y >= region.y - 0.5 && r.x + r.w <= region.x + region.w + 0.5 && r.y + r.h <= region.y + region.h + 0.5;
  };
  /** the share of the shorter of label and target that lies against the target along the edge */
  const against = (side: Side, r: Rect): number => {
    const shared = side === 'above' || side === 'below' ? overlapOn(r.x, r.x + r.w, target.x, target.x + target.w) : overlapOn(r.y, r.y + r.h, target.y, target.y + target.h);
    const shorter = side === 'above' || side === 'below' ? Math.min(r.w, target.w) : Math.min(r.h, target.h);
    return shorter <= 0 ? 0 : shared / shorter;
  };
  const crosses = (r: Rect, o: Obstacle): boolean => hit(r, o.rect, 0) && !(o.outline && within(r, o.rect));
  const ownGap = (r: Rect): number => gapBetween(r, target);
  const wrongTarget = (r: Rect): boolean => {
    const own = ownGap(r);
    return q.obstacles.some((o) => !o.outline && gapBetween(r, o.rect) < own - 0.5);
  };

  // strictness 2: against its target, clear of all, not nearer to anything else; 1: allowed to drift along the edge; 0: drawn things ignored
  for (const strictness of [2, 1, 0]) {
    for (const side of order) {
      for (let k = 0; k <= MAX_SLIDE; k += 1) {
        for (const sign of k === 0 ? [1] : [1, -1]) {
          const c = sideCentre(side, sign * k * q.step);
          if (!inside(c)) continue;
          const r = rectOf(c);
          if (hit(r, target, 0)) continue;
          if (q.taken.some((other) => hit(r, other, q.pad))) continue;
          if (strictness > 0) {
            const share = against(side, r);
            if (strictness === 2 ? share < 0.5 : share <= 0) continue;
            if (q.obstacles.some((o) => crosses(r, o))) continue;
            if (wrongTarget(r)) continue;
          }
          return c;
        }
      }
    }
  }
  // Everything near its target is taken (several labels asked for one side): stack outward on the same side, one label's height further each time,
  // so words never lie on words. Further from its target is better than on top of other text.
  for (const side of order) {
    // as near the target's own line as the canvas lets a label of this size stand
    const flat = side === 'above' || side === 'below';
    const base = sideCentre(side, 0);
    const lo = flat ? region.x + w / 2 : region.y + h / 2;
    const hi = flat ? region.x + region.w - w / 2 : region.y + region.h - h / 2;
    if (lo > hi) continue;
    const slid = flat ? { x: Math.max(lo, Math.min(hi, base.x)), y: base.y } : { x: base.x, y: Math.max(lo, Math.min(hi, base.y)) };
    for (let n = 1; n <= MAX_STACK; n += 1) {
      const out = n * (h + q.pad);
      const c = side === 'above' ? { x: slid.x, y: slid.y - out } : side === 'below' ? { x: slid.x, y: slid.y + out } : side === 'left' ? { x: slid.x - out, y: slid.y } : { x: slid.x + out, y: slid.y };
      if (!inside(c)) break;
      const r = rectOf(c);
      if (q.taken.some((other) => hit(r, other, q.pad)) || q.obstacles.some((o) => crosses(r, o))) continue;
      return c;
    }
  }
  return null;
}
