// The `figure` engine: pure and DOM-free. `core/kinds/figure.ts` is its `Kind`; `bench/figure-bench.ts` its page.
export type { FigureHeldState, FigureInput, FigureMode, FigureNote, FigurePart, FigureRoute, FigureShape, FigureStep, Pt } from './types';
export { FIGURES, FIGURE_NAMES } from './fixtures';
export { layoutFigure, litParts, MAX_LABELS, SHARES, TARGET, wrapWords } from './layout';
export type { Chrome, FigureEnv, FigureKeep, FigureLayout, LaidLabel, LaidPart } from './layout';
export { paintFigure, DIM, EASE_SECONDS, LABEL_DIM } from './paint';
export type { Painted, PaintedWord, PaintOptions } from './paint';
export { placeBoundary } from './boundary';
export type { BoundaryInput, BoundaryLabel, BoundaryResult, PlacedLabel, Side } from './boundary';
export { refitInto, resolveParts } from './refit';
export { buildRoute, CROSSING_SECONDS, dotsOn, stretchOf } from './routes';
export type { FigureLook, Shade } from './palette';
export { shadeFor } from './palette';
