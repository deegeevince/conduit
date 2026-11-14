// @conduit/web/engine: the one entry the page and the server both import. DOM-free (tsconfig.engine.json proves it).
export { CHART_KINDS, digestOf, measureStage, scoreOfCase, tryLines } from './measure';
export type { EngineCase, EngineInputs, EngineView, Insets, LineProblem, StageFacts } from './measure';
export { ENGINE_VERSION, hashOf } from './version';
