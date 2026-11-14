// The wall's plan: where each tile sits. Pure and DOM-free (WL1 moves it to W/engine). A tile's place is two integers, a lane and a slot;
// the boxes are those integers times (cell + gap), so a node that arrives later never moves an earlier tile (the append law).

export interface WallNode {
  readonly id: string;
  /** the topic it is in; null opens a new one */
  readonly lane: string | null;
  /** the frame it was asked from */
  readonly from: string | null;
  readonly seq: number;
  readonly title: string;
}

export interface WallShape {
  /** the view's stage box: one world unit is one CSS pixel at full size */
  readonly cell: { readonly width: number; readonly height: number };
  readonly gap: number;
  /** `row`: lanes run across (a desk); `column`: lanes run down (a phone) */
  readonly axis: 'row' | 'column';
}

export interface WallBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Tile {
  readonly node: string;
  readonly index: number;
  readonly lane: number;
  readonly slot: number;
  readonly box: WallBox;
  readonly from: string | null;
}

export interface WallPlan {
  readonly tiles: readonly Tile[];
  readonly bounds: WallBox;
  readonly digest: string;
  readonly lanes: number;
}

/** Counted so a probe can prove the plan is not called while the lens moves. */
export const wallCounters = { plan: 0 };

export function planWall(nodes: readonly WallNode[], shape: WallShape): WallPlan {
  wallCounters.plan += 1;
  const ordered = [...nodes].sort((a, b) => a.seq - b.seq);
  const laneOf = new Map<string, number>();
  const depth: number[] = [];
  const tiles: Tile[] = [];
  const stepX = shape.cell.width + shape.gap;
  const stepY = shape.cell.height + shape.gap;
  for (const node of ordered) {
    const key = node.lane ?? node.id;
    let lane = laneOf.get(key);
    if (lane === undefined) {
      lane = depth.length;
      laneOf.set(key, lane);
      depth.push(0);
    }
    const slot = depth[lane] ?? 0;
    depth[lane] = slot + 1;
    const across = shape.axis === 'row' ? slot : lane;
    const down = shape.axis === 'row' ? lane : slot;
    tiles.push({ node: node.id, index: tiles.length, lane, slot, box: { x: across * stepX, y: down * stepY, width: shape.cell.width, height: shape.cell.height }, from: node.from });
  }
  let x1 = 0;
  let y1 = 0;
  for (const tile of tiles) {
    x1 = Math.max(x1, tile.box.x + tile.box.width);
    y1 = Math.max(y1, tile.box.y + tile.box.height);
  }
  let h = 2166136261;
  for (const tile of tiles) {
    const text = `${tile.node}:${tile.lane}:${tile.slot}:${tile.box.x}:${tile.box.y};`;
    for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  }
  return { tiles, bounds: { x: 0, y: 0, width: x1, height: y1 }, digest: (h >>> 0).toString(16), lanes: depth.length };
}
