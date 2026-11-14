// The wall's plan: where each tile sits. Pure and DOM-free; the page and the server both call it (@conduit/web/engine). A tile's place is
// two integers, a lane and a slot; the boxes are those integers times (cell + gap), so a node that arrives later never moves an earlier
// tile (the append law). Nothing here stores a position: the plan is derived from the nodes and the shape, every time.

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
    const text = `${tile.node}:${tile.lane}:${tile.slot}:${tile.box.x}:${tile.box.y}:${tile.box.width}:${tile.box.height}:${tile.from ?? ''};`;
    for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  }
  return { tiles, bounds: { x: 0, y: 0, width: x1, height: y1 }, digest: (h >>> 0).toString(16), lanes: depth.length };
}

/** The tiles of `earlier` that are not, exactly, the first tiles of `later`: the append law says there are none. */
export function movedTiles(earlier: WallPlan, later: WallPlan): readonly string[] {
  const moved: string[] = [];
  for (const a of earlier.tiles) {
    const b = later.tiles[a.index];
    if (b === undefined || b.node !== a.node || b.lane !== a.lane || b.slot !== a.slot || b.box.x !== a.box.x || b.box.y !== a.box.y || b.box.width !== a.box.width || b.box.height !== a.box.height || b.from !== a.from) moved.push(a.node);
  }
  return moved;
}

/** A small deterministic generator (LCG): the same seed makes the same tree on the page and on the server. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** A made-up tree of nodes for the parity and append checks: `seed` says which, and it is the same everywhere. Some lanes are shared, some open; seqs are not in order of listing. */
export function generatedNodes(seed: number): readonly WallNode[] {
  const r = seeded(seed * 2654435761 + 17);
  const count = 1 + Math.floor(r() * 40);
  const nodes: WallNode[] = [];
  const laneKeys: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = `n${seed}-${i}`;
    const roll = r();
    let lane: string | null = null;
    if (laneKeys.length > 0 && roll > 0.35) lane = laneKeys[Math.floor(r() * laneKeys.length)] ?? null;
    if (lane === null) laneKeys.push(id);
    const parent = i > 0 && r() > 0.3 ? (nodes[Math.floor(r() * i)]?.id ?? null) : null;
    nodes.push({ id, lane, from: parent, seq: i * 3 + 1 + Math.floor(r() * 3), title: `Frame ${i} \u00e9 ${'x'.repeat(Math.floor(r() * 12))}` });
  }
  // listed out of order: the plan sorts by seq
  for (let i = nodes.length - 1; i > 0; i -= 1) {
    const j = Math.floor(r() * (i + 1));
    const a = nodes[i] as WallNode;
    nodes[i] = nodes[j] as WallNode;
    nodes[j] = a;
  }
  return nodes;
}

/** The shapes the checks run over: a desk (lanes across), a phone (lanes down), and a cell that is not a screen's. */
export const WALL_SHAPES: readonly WallShape[] = [
  { cell: { width: 1280, height: 720 }, gap: 160, axis: 'row' },
  { cell: { width: 390, height: 844 }, gap: 96, axis: 'column' },
  { cell: { width: 333.5, height: 211.25 }, gap: 17, axis: 'row' },
];
