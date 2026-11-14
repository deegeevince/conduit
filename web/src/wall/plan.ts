// The plan lives in the engine now (WL1), so the page and the server run one function; this re-exports it for the lens, the tiles and the bench.
export { planWall, wallCounters } from '../engine/wall';
export type { Tile, WallBox, WallNode, WallPlan, WallShape } from '../engine/wall';
