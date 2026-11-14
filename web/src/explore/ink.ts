// The rasterised mask of the audit (quality bar, row 4; the cold review's second recommendation): the resting stage drawn with no words and no
// charts, so that what is left is ink, and how much ink lies under a run of words is read from pixels and not from anyone's bounding box.
// A caption over a drawing is the one collision no pair of boxes can show: the drawing's box is a rectangle and the drawing is not.

export interface InkMask {
  /** the picture's size in pixels */
  readonly width: number;
  readonly height: number;
  /** 1 where something is drawn, 0 where the ground shows */
  readonly ink: Uint8Array;
}

/** The ground is the colour most of the picture is: a look's paper, a night sky. Pixels near it are ground; the rest are ink. */
export function maskOf(image: ImageData): InkMask {
  const { width, height, data } = image;
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
    const found = buckets.get(key);
    if (found === undefined) buckets.set(key, { count: 1, r, g, b });
    else {
      found.count += 1;
      found.r += r;
      found.g += g;
      found.b += b;
    }
  }
  let ground = { count: 0, r: 0, g: 0, b: 0 };
  for (const bucket of buckets.values()) if (bucket.count > ground.count) ground = bucket;
  const gr = ground.r / Math.max(1, ground.count);
  const gg = ground.g / Math.max(1, ground.count);
  const gb = ground.b / Math.max(1, ground.count);
  const ink = new Uint8Array(width * height);
  for (let at = 0; at < ink.length; at += 1) {
    const i = at * 4;
    const d = Math.abs((data[i] ?? 0) - gr) + Math.abs((data[i + 1] ?? 0) - gg) + Math.abs((data[i + 2] ?? 0) - gb);
    ink[at] = d > 72 ? 1 : 0;
  }
  return { width, height, ink };
}

/** The share of a rectangle (in the picture's own pixels) that is ink. */
export function coverage(mask: InkMask, box: { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }): number {
  const x0 = Math.max(0, Math.floor(box.x0));
  const y0 = Math.max(0, Math.floor(box.y0));
  const x1 = Math.min(mask.width, Math.ceil(box.x1));
  const y1 = Math.min(mask.height, Math.ceil(box.y1));
  if (x1 <= x0 || y1 <= y0) return 0;
  let ink = 0;
  for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) ink += mask.ink[y * mask.width + x] ?? 0;
  return ink / ((x1 - x0) * (y1 - y0));
}
