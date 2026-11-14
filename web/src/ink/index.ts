// INK: handwriting and drawing as input. One module, no dependency, no network, no storage: it runs on the stage and inside a sandboxed surface.
//
//   createInk(host, options)        a layer that fills `host` (or flows as a sheet): pen, highlighter, eraser, undo/redo, palm rejection
//   overlayOn(target, options)      the same, laid over any element: a mock-up, a chart, a photo, a card
//   mountWorksheet(host, options)   a picture or card with ink over it, answer boxes, a scratch area and a "Check my working" button
//   mountInkBar(host, ink, options) the toolbar (the send button included)
//   sendInk(ink, port, options)     ink becomes one turn: the cropped picture uploaded, then `TurnInput.marks`
//   mountStageInk(stage, slot, app) the chrome bar's Draw toggle over the stage
//   serialize / parse               the document as JSON, under the size cap
//   exportPng / exportSvg           the ink out, cropped to the inked part

export { createInk } from './layer';
export type { Ink, InkBackground, InkOptions, InkToolName, LatencyStats } from './layer';
export { overlayOn } from './overlay';
export type { Overlay } from './overlay';
export { mountWorksheet } from './worksheet';
export type { Worksheet, WorksheetOptions } from './worksheet';
export { mountInkBar } from './toolbar';
export type { InkBar, InkBarOptions } from './toolbar';
export { NothingToSend, prepareMarks, sendInk } from './send';
export type { InkPort } from './send';
export { mountStageInk, DRAW_WORDS } from './stage';
export type { StageInk, StageInkApp } from './stage';
export { InkModel, InkTooLarge, compact, parse, serialize } from './model';
export { cropFor, drawCrop, exportPng, exportSvg } from './export';
export type { ExportOptions, InkBackdrop } from './export';
export { regionOf, reportRegions, strokeBounds } from './geometry';
export { outlinePolygon, smoothPathData } from './outline';
export { PalmGuard } from './palm';
export { INK_CSS, injectInkStyles } from './styles';
export type { InkBox, InkDocument, InkMarks, InkOn, InkPoint, InkRegionDef, InkRegionHit, InkSpace, InkStroke, InkVoice } from '@conduit/language';
