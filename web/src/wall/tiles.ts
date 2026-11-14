// The tiles' pictures: four tiers by the tile's width on screen, held inside the caps of PLAN-wall section 3.
//
//   live  in focus, full size, at rest: today's pipeline (the bench stands the still in for it and counts it)
//   still 40% of the view or more: one picture, 1024 px long side on a desk and 768 on a phone; 12 held on a desk, 6 on a phone, nearest first
//   thumb 6% to 40%: a 256 px picture (128 on a phone); 300 held
//   card  under 6%, or past the budget: the look's ground (tinted by the picture) and nothing else
//
// A tile is never waited for: it is drawn with the best picture already held, and the better one is asked for and swapped in when it lands.

import { onPictureEvicted } from '../render/three/pictures';
import type { Tile, WallBox, WallPlan } from './plan';
import type { Lens, Resolved, Screen, StillIndex, Tier } from './view';
import { visibleTiles } from './view';

export interface Picture {
  readonly url: string;
  readonly width: number;
  readonly height: number;
}

/** What the server says about one tile (server/src/tools/wall-bench.ts). */
export interface TileSource {
  readonly id: string;
  readonly lane: string;
  readonly seq: number;
  readonly title: string;
  readonly aspect: number;
  readonly tint: string;
  readonly still: Picture;
  readonly thumb: Picture;
}

export interface Caps {
  readonly stills: number;
  readonly thumbs: number;
  /** bytes of textures and targets, mipmaps counted */
  readonly bytes: number;
  readonly stillSide: number;
  readonly thumbSide: number;
}

export const DESK_CAPS: Caps = { stills: 12, thumbs: 300, bytes: 256 * 1024 * 1024, stillSide: 1024, thumbSide: 256 };
export const PHONE_CAPS: Caps = { stills: 6, thumbs: 300, bytes: 96 * 1024 * 1024, stillSide: 768, thumbSide: 128 };

/** where the tiers change, as shares of the view's width; the bench can move them to stress the PictureFrames themselves */
export const LOD = { still: 0.4, thumb: 0.06 };

/** A mipmapped RGBA texture: a third more than its base level. */
export const textureBytes = (p: Picture): number => Math.round(p.width * p.height * 4 * (4 / 3));

export class TileCache implements StillIndex {
  private readonly sources = new Map<string, TileSource>();
  private readonly boxes = new Map<string, WallBox>();
  /** url -> bytes of what is held in the renderer's pool */
  private readonly held = new Map<string, number>();
  private readonly pending = new Set<string>();
  private readonly wanted = new Map<number, Tier>();
  private readonly queue: { url: string; index: number }[] = [];
  private readonly scratch: Tile[] = [];
  private inflight = 0;
  private centre = { x: 0, y: 0 };
  private pinned = -1;
  private stopListening: () => void;
  stats = { requested: 0, landed: 0, failed: 0, evicted: 0, waited: 0 };
  /** a picture has landed: the wall wants drawing again */
  onLand: (() => void) | null = null;

  constructor(
    private plan: WallPlan,
    sources: readonly TileSource[],
    private readonly preload: (url: string) => Promise<void>,
    readonly caps: Caps,
    private readonly concurrency = 4,
  ) {
    for (const source of sources) this.sources.set(source.id, source);
    this.stopListening = onPictureEvicted((url) => {
      if (this.held.delete(url)) this.stats.evicted += 1;
    });
  }

  dispose(): void {
    this.stopListening();
  }

  setPlan(plan: WallPlan): void {
    this.plan = plan;
    this.boxes.clear();
  }

  /** bytes of pictures this cache believes the renderer holds */
  get bytes(): number {
    let sum = 0;
    for (const b of this.held.values()) sum += b;
    return sum;
  }

  get heldCount(): number {
    return this.held.size;
  }

  /** The tier wanted for each tile this frame; call once a frame before `wallFrame`. Nothing here plans, measures or lays out. */
  prepare(lens: Lens, screen: Screen, also?: Lens): readonly Tile[] {
    this.centre = { x: lens.x, y: lens.y };
    this.wanted.clear();
    // during a cross-fade the old view is drawn too: its tiles are wanted first, the new view's override
    if (also !== undefined) this.want(also, screen);
    const seen = this.want(lens, screen);
    if (this.pinned >= 0 && this.plan.tiles[this.pinned] !== undefined) this.ask(this.plan.tiles[this.pinned] as Tile, 'still');
    this.pump();
    return seen;
  }

  private want(lens: Lens, screen: Screen): readonly Tile[] {
    const seen = visibleTiles(this.plan, lens, screen, this.scratch);
    const near = (tile: Tile): number => Math.hypot(tile.box.x + tile.box.width / 2 - lens.x, tile.box.y + tile.box.height / 2 - lens.y);
    const order = seen.length > this.caps.stills ? [...seen].sort((a, b) => near(a) - near(b)) : seen;
    let stills = 0;
    for (const tile of order) {
      const share = (tile.box.width * lens.scale) / screen.width;
      let tier: Tier = share >= LOD.still ? 'still' : share >= LOD.thumb ? 'thumb' : 'card';
      if (tier === 'still') {
        if (stills >= this.caps.stills) tier = 'thumb';
        else stills += 1;
      }
      this.wanted.set(tile.index, tier);
      if (tier !== 'card') this.ask(tile, tier);
    }
    return seen;
  }

  /** the tile the lens is gliding to: its still is asked for before it lands */
  pin(index: number): void {
    this.pinned = index;
  }

  /** every thumb, nearest the lens first, so that the map is there before it is looked at */
  warm(): void {
    const count = Math.min(this.plan.tiles.length, this.caps.thumbs);
    for (let i = 0; i < count; i += 1) {
      const tile = this.plan.tiles[i];
      if (tile !== undefined) this.ask(tile, 'thumb');
    }
    this.pump();
  }

  idle(): boolean {
    return this.inflight === 0 && this.queue.length === 0;
  }

  private pictureOf(node: string, tier: Tier): Picture | null {
    const source = this.sources.get(node);
    if (source === undefined || tier === 'card') return null;
    return tier === 'still' ? source.still : source.thumb;
  }

  private ask(tile: Tile, tier: Tier): void {
    const picture = this.pictureOf(tile.node, tier);
    if (picture === null || this.held.has(picture.url) || this.pending.has(picture.url)) return;
    this.pending.add(picture.url);
    this.queue.push({ url: picture.url, index: tile.index });
  }

  private pump(): void {
    while (this.inflight < this.concurrency && this.queue.length > 0) {
      // the one nearest the lens first
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < this.queue.length; i += 1) {
        const entry = this.queue[i];
        const tile = entry === undefined ? undefined : this.plan.tiles[entry.index];
        if (tile === undefined) continue;
        const d = Math.hypot(tile.box.x + tile.box.width / 2 - this.centre.x, tile.box.y + tile.box.height / 2 - this.centre.y);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      const [next] = this.queue.splice(best, 1);
      if (next === undefined) break;
      this.inflight += 1;
      this.stats.requested += 1;
      this.preload(next.url).then(
        () => {
          const tile = this.plan.tiles[next.index];
          const source = tile === undefined ? undefined : this.sources.get(tile.node);
          const picture = source === undefined ? undefined : source.still.url === next.url ? source.still : source.thumb;
          if (picture !== undefined) this.held.set(next.url, textureBytes(picture));
          this.stats.landed += 1;
          this.onLand?.();
        },
        () => {
          this.stats.failed += 1;
        },
      ).finally(() => {
        this.inflight -= 1;
        this.pending.delete(next.url);
        this.pump();
      });
    }
  }

  private boxOf(tile: Tile): WallBox {
    let box = this.boxes.get(tile.node);
    if (box === undefined) {
      const aspect = this.sources.get(tile.node)?.aspect ?? tile.box.width / tile.box.height;
      const cellAspect = tile.box.width / tile.box.height;
      const width = aspect > cellAspect ? tile.box.width : tile.box.height * aspect;
      const height = aspect > cellAspect ? tile.box.width / aspect : tile.box.height;
      box = { x: tile.box.x + (tile.box.width - width) / 2, y: tile.box.y + (tile.box.height - height) / 2, width, height };
      this.boxes.set(tile.node, box);
    }
    return box;
  }

  resolve(tile: Tile, _share: number): Resolved {
    const source = this.sources.get(tile.node);
    const box = this.boxOf(tile);
    const want = this.wanted.get(tile.index) ?? 'card';
    if (source !== undefined) {
      if (want === 'still' && this.held.has(source.still.url)) return { kind: 'picture', src: source.still.url, tier: 'still', box };
      if (want !== 'card') {
        if (this.held.has(source.thumb.url)) return { kind: 'picture', src: source.thumb.url, tier: 'thumb', box };
        // the thumb has not landed, but a still of it may be held (a tile that has just got smaller)
        if (this.held.has(source.still.url)) return { kind: 'picture', src: source.still.url, tier: 'still', box };
        this.stats.waited += 1;
      }
    }
    return { kind: 'card', tint: source?.tint ?? '#cccccc', box: tile.box };
  }

  /** the tier each tile in `seen` is drawn at, for the probe */
  tiers(seen: readonly Tile[], lens: Lens, screen: Screen): { still: number; thumb: number; card: number; texelsPerPixel: { min: number; max: number } } {
    const out = { still: 0, thumb: 0, card: 0, texelsPerPixel: { min: Infinity, max: 0 } };
    for (const tile of seen) {
      const what = this.resolve(tile, 0);
      if (what.kind === 'card') {
        out.card += 1;
        continue;
      }
      out[what.tier === 'still' ? 'still' : 'thumb'] += 1;
      const source = this.sources.get(tile.node);
      const picture = source === undefined ? null : what.tier === 'still' ? source.still : source.thumb;
      if (picture === null) continue;
      const px = what.box.width * lens.scale;
      if (px < 1 || what.box.width * lens.scale > screen.width * 4) continue;
      const ratio = picture.width / px;
      out.texelsPerPixel.min = Math.min(out.texelsPerPixel.min, ratio);
      out.texelsPerPixel.max = Math.max(out.texelsPerPixel.max, ratio);
    }
    return out;
  }
}
