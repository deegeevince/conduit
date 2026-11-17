// @conduit/web/engine: the one entry the page and the server both import. DOM-free (tsconfig.engine.json proves it).
export { CHART_KINDS, digestOf, measureStage, scoreOfCase, tryLines } from './measure';
export type { EngineCase, EngineInputs, EngineView, Insets, LineProblem, StageFacts } from './measure';
export { ENGINE_VERSION, hashOf } from './version';
export { WALL_SHAPES, generatedNodes, movedTiles, planWall, wallCounters } from './wall';
export type { Tile, WallBox, WallNode, WallPlan, WallShape } from './wall';
export { wallNodesOfTurns } from '../wall/source-turns';
export type { WallTurn } from '../wall/source-turns';
export { asksOf } from '../painter/controls/ask-state';
export type { AskFacts } from '../painter/controls/ask-state';
export { targetFor } from '../core/contracts';
export { hasDevice } from '../fonts/fold';
