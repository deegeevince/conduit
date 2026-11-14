// The edge between untrusted JSON and the typed domain. Every check names the field it found wrong.

import { AMBIENT_KINDS, CAMERA_MOVES, CHART_KINDS, CONTROL_KINDS, ENTER_EFFECTS, EXIT_EFFECTS, FACES, FX_NAMES, LAYERS, LOOPS, MARKS, PROCEDURAL_MEDIA, STROKES, STRUCTURE_KINDS, TEXTURES, ALIGNS, BACK_EVENT_TYPES, BRAIN_EFFORTS, BRAIN_MODES, BRAIN_MODELS, CANVAS_NAMES, DEMOS, ELEMENT_KINDS, LAYOUTS, LIMITS, LOOK_IDS, MOODS, NO_SIGHT, NO_V21_CAPABILITIES, NO_V4_CAPABILITIES, PACES, SIGHT_ITEMS, SIGHT_NOTE, UPLOAD_LIMITS } from '@conduit/language';
import type {
  BackEvent,
  BrainChange,
  ContentCount,
  CanvasBox,
  Capabilities,
  ControlValue,
  ControlValues,
  PlacedBox,
  ClockState,
  CreateSessionRequest,
  StartTurnRequest,
  LookId,
  ScreenFacts,
  Sight,
  SightItem,
  SightNote,
  StageBase,
  TurnInput,
  TurnReport,
} from '@conduit/language';
import { errors } from '../errors';
import { SERVER_LIMITS } from './session';

type Obj = Record<string, unknown>;

function obj(value: unknown, what: string): Obj {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw errors.badRequest(`${what} must be an object`);
  return value as Obj;
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string') throw errors.badRequest(`${what} must be a string`);
  return value;
}

/**
 * A permission request's id is the CLI's own (a 36-character UUID) and is looked up whole: cut, it matches nothing and the owner's answer is
 * thrown away, so the deadline answers no. It is kept as it is, or refused when it cannot be one.
 */
const REQUEST_ID_MAX = 128;
function requestId(value: unknown): string {
  const id = text(value, 'request');
  if (id === '' || id.length > REQUEST_ID_MAX) throw errors.badRequest(`request must be 1 to ${REQUEST_ID_MAX} characters`);
  return id;
}

function num(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw errors.badRequest(`${what} must be a finite number`);
  return value;
}

function bool(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw errors.badRequest(`${what} must be true or false`);
  return value;
}

function list(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw errors.badRequest(`${what} must be an array`);
  return value;
}

function strings(value: unknown, what: string): string[] {
  return list(value, what).map((item, index) => text(item, `${what}[${index}]`));
}

/** A list from the browser, kept only for what the vocabulary knows: a word it does not know is not a capability, and is not cast into one. */
function members<T extends string>(value: unknown, allowed: readonly T[], what: string): T[] {
  return strings(value, what).filter((word): word is T => allowed.some((known) => known === word));
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  const found = allowed.find((item) => item === value);
  if (found === undefined) throw errors.badRequest(`${what} must be one of ${allowed.join(' | ')}`);
  return found;
}

function look(value: unknown, what: string): LookId {
  return oneOf(value, LOOK_IDS, what);
}

function screen(value: unknown): ScreenFacts {
  const raw = obj(value, 'screen');
  return {
    width: num(raw.width, 'screen.width'),
    height: num(raw.height, 'screen.height'),
    dpr: num(raw.dpr, 'screen.dpr'),
    cols: num(raw.cols, 'screen.cols'),
    rows: num(raw.rows, 'screen.rows'),
    canvas: oneOf(raw.canvas, CANVAS_NAMES, 'screen.canvas'),
    reducedMotion: bool(raw.reducedMotion, 'screen.reducedMotion'),
    pointer: oneOf(raw.pointer, ['fine', 'coarse', 'none'] as const, 'screen.pointer'),
  };
}

function capabilities(value: unknown): Capabilities {
  const raw = obj(value, 'capabilities');
  return {
    language: num(raw.language, 'capabilities.language'),
    renderer: text(raw.renderer, 'capabilities.renderer'),
    depth: bool(raw.depth, 'capabilities.depth'),
    looks: members(raw.looks, LOOK_IDS, 'capabilities.looks'),
    layers: members(raw.layers, LAYERS, 'capabilities.layers'),
    layouts: members(raw.layouts, LAYOUTS, 'capabilities.layouts'),
    camera: members(raw.camera, CAMERA_MOVES, 'capabilities.camera'),
    enters: members(raw.enters, ENTER_EFFECTS, 'capabilities.enters'),
    exits: members(raw.exits, EXIT_EFFECTS, 'capabilities.exits'),
    loops: members(raw.loops, LOOPS, 'capabilities.loops'),
    marks: members(raw.marks, MARKS, 'capabilities.marks'),
    kinds: members(raw.kinds, ELEMENT_KINDS, 'capabilities.kinds'),
    faces: members(raw.faces, FACES, 'capabilities.faces'),
    fx: members(raw.fx, FX_NAMES, 'capabilities.fx'),
    ambient: members(raw.ambient, AMBIENT_KINDS, 'capabilities.ambient'),
    sight: oneOf(raw.sight, ['none', 'report', 'snapshot'] as const, 'capabilities.sight'),
    // A painter that speaks Series 3 leaves these out: it is then taught none of what they gate.
    structures: raw.structures === undefined ? NO_V4_CAPABILITIES.structures : (members(raw.structures, STRUCTURE_KINDS, 'capabilities.structures')),
    charts: raw.charts === undefined ? NO_V4_CAPABILITIES.charts : (members(raw.charts, CHART_KINDS, 'capabilities.charts')),
    controls: raw.controls === undefined ? NO_V4_CAPABILITIES.controls : (members(raw.controls, CONTROL_KINDS, 'capabilities.controls')),
    media: raw.media === undefined ? NO_V4_CAPABILITIES.media : (members(raw.media, PROCEDURAL_MEDIA, 'capabilities.media')),
    textures: raw.textures === undefined ? NO_V4_CAPABILITIES.textures : (members(raw.textures, TEXTURES, 'capabilities.textures')),
    brushes: raw.brushes === undefined ? NO_V4_CAPABILITIES.brushes : (members(raw.brushes, STROKES, 'capabilities.brushes')),
    drafts: raw.drafts === undefined ? NO_V4_CAPABILITIES.drafts : bool(raw.drafts, 'capabilities.drafts'),
    // A painter of v2 leaves these out: no fix is tried on it, and it is taught neither decks nor the user's pictures.
    candidates: raw.candidates === undefined ? NO_V21_CAPABILITIES.candidates : bool(raw.candidates, 'capabilities.candidates'),
    decks: raw.decks === undefined ? NO_V21_CAPABILITIES.decks : bool(raw.decks, 'capabilities.decks'),
    uploads: raw.uploads === undefined ? NO_V21_CAPABILITIES.uploads : bool(raw.uploads, 'capabilities.uploads'),
    links: raw.links === undefined ? NO_V21_CAPABILITIES.links : bool(raw.links, 'capabilities.links'),
  };
}

const CONTROL_TEXT_CHARS = 400;

function controlValue(value: unknown, what: string): ControlValue {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') return value.slice(0, CONTROL_TEXT_CHARS);
  throw errors.badRequest(`${what} must be a number, true or false, or text`);
}

/** Every control's value by id. A stage holds at most `LIMITS.controls`; a few more are let through so that a control just dropped does not fail the request. */
function controlValues(value: unknown, what: string): ControlValues {
  const raw = obj(value, what);
  const entries = Object.entries(raw);
  if (entries.length > LIMITS.controls * 4) throw errors.badRequest(`${what} holds more than ${LIMITS.controls * 4} controls`);
  const out: Record<string, ControlValue> = {};
  for (const [id, held] of entries) out[id.slice(0, LIMITS.name)] = controlValue(held, `${what}.${id}`);
  return out;
}

export function parseCreateSession(body: unknown): CreateSessionRequest {
  const raw = obj(body, 'body');
  return { screen: screen(raw.screen), capabilities: capabilities(raw.capabilities), look: look(raw.look, 'look') };
}

/** The ids of the photos a prompt carries (`u1`, `u2`, ...): at most one turn's worth, each once. Whether the conversation holds them is the conductor's to say. */
function photoIds(value: unknown): string[] {
  if (value === undefined) return [];
  const ids = list(value, 'input.images').map((item) => text(item, 'input.images'));
  if (ids.length > UPLOAD_LIMITS.perTurn) throw errors.badRequest(`a prompt may carry at most ${UPLOAD_LIMITS.perTurn} photos`);
  for (const id of ids) if (!/^u[1-9][0-9]{0,3}$/.test(id)) throw errors.badRequest('input.images must be the ids the server gave the photos (u1, u2, ...)');
  return [...new Set(ids)];
}

export function parseTurnInput(body: unknown): TurnInput {
  const input = obj(obj(body, 'body').input, 'input');
  const kind = oneOf(input.kind, ['prompt', 'tap', 'demo', 'script', 'act'] as const, 'input.kind');
  if (kind === 'act') {
    return { kind, id: text(input.id, 'input.id').slice(0, LIMITS.name), text: text(input.text, 'input.text').slice(0, CONTROL_TEXT_CHARS), values: controlValues(input.values ?? {}, 'input.values') };
  }
  if (kind === 'script') {
    const source = text(input.text, 'input.text');
    if (source.trim() === '') throw errors.badRequest('input.text must not be empty');
    if (source.length > SERVER_LIMITS.scriptChars) throw errors.badRequest(`input.text is longer than ${SERVER_LIMITS.scriptChars} characters`);
    return { kind, text: source };
  }
  if (kind === 'prompt') {
    const value = text(input.text, 'input.text');
    if (value.trim() === '') throw errors.badRequest('input.text must not be empty');
    if (value.length > SERVER_LIMITS.promptChars) throw errors.badRequest(`input.text is longer than ${SERVER_LIMITS.promptChars} characters`);
    const images = photoIds(input.images);
    return images.length === 0 ? { kind, text: value } : { kind, text: value, images };
  }
  if (kind === 'tap') {
    const said = text(input.text, 'input.text');
    if (said.length > SERVER_LIMITS.promptChars) throw errors.badRequest(`input.text is longer than ${SERVER_LIMITS.promptChars} characters`);
    return { kind, id: text(input.id, 'input.id'), text: said };
  }
  const script = text(input.script, 'input.script');
  if (!DEMOS.some((demo) => demo.name === script)) {
    throw errors.badRequest(`input.script must be one of ${DEMOS.map((demo) => demo.name).join(' | ')}`);
  }
  return { kind, script };
}

const STAGE_ELEMENTS = 400;
const STAGE_TEXT_CHARS = 4_000;
const STAGE_KEY_CHARS = 120;
const STAGE_SHEET_BYTES = 64 * 1024;

/** Cuts a string a painter sent to the length a brief can carry; the brief shows these to a brain. */
function bounded(value: unknown, what: string, max: number): string {
  return text(value, what).slice(0, max);
}

function sheet(value: unknown, what: string): Obj {
  const raw = value === undefined ? {} : obj(value, what);
  if (JSON.stringify(raw).length > STAGE_SHEET_BYTES) throw errors.badRequest(`${what} is larger than ${STAGE_SHEET_BYTES} bytes`);
  return raw;
}

/** The changes a control drives on an element: carried as the painter sent them, bounded in number and size. The painter and the schedule are the only readers. */
function driven(value: unknown, what: string): NonNullable<StageBase['elements'][number]['driven']> {
  const changes = list(value, what).slice(0, LIMITS.binds);
  if (JSON.stringify(changes).length > STAGE_SHEET_BYTES) throw errors.badRequest(`${what} is larger than ${STAGE_SHEET_BYTES} bytes`);
  return changes.map((item, index) => obj(item, `${what}[${index}]`)) as unknown as NonNullable<StageBase['elements'][number]['driven']>;
}

function stage(value: unknown): StageBase {
  const raw = obj(value, 'report.stage');
  const stageLook = look(raw.look, 'report.stage.look');
  const scene = obj(raw.scene, 'report.stage.scene');
  const elements = list(raw.elements, 'report.stage.elements');
  if (elements.length > STAGE_ELEMENTS) throw errors.badRequest(`report.stage.elements has more than ${STAGE_ELEMENTS} entries`);
  const expected = scene.expected === null || scene.expected === undefined ? null : num(scene.expected, 'report.stage.scene.expected');
  return {
    look: stageLook,
    lookName: bounded(raw.lookName ?? stageLook, 'report.stage.lookName', STAGE_KEY_CHARS),
    scene: {
      id: bounded(scene.id, 'report.stage.scene.id', STAGE_KEY_CHARS),
      index: num(scene.index, 'report.stage.scene.index'),
      layout: oneOf(scene.layout, LAYOUTS, 'report.stage.scene.layout'),
      canvas: oneOf(scene.canvas, CANVAS_NAMES, 'report.stage.scene.canvas'),
      align: oneOf(scene.align, ALIGNS, 'report.stage.scene.align'),
      mood: oneOf(scene.mood, MOODS, 'report.stage.scene.mood'),
      pace: oneOf(scene.pace, PACES, 'report.stage.scene.pace'),
      expected,
    },
    styles: sheet(raw.styles, 'report.stage.styles') as unknown as StageBase['styles'],
    colors: sheet(raw.colors, 'report.stage.colors') as unknown as StageBase['colors'],
    looks: sheet(raw.looks, 'report.stage.looks') as unknown as StageBase['looks'],
    elements: elements.map((item, index) => {
      const what = `report.stage.elements[${index}]`;
      const element = obj(item, what);
      const figure = element.figure === null || element.figure === undefined ? null : obj(element.figure, `${what}.figure`);
      if (figure !== null && JSON.stringify(figure).length > STAGE_SHEET_BYTES) throw errors.badRequest(`${what}.figure is larger than ${STAGE_SHEET_BYTES} bytes`);
      const link = (field: 'parent' | 'replaces'): string | null => (element[field] === null || element[field] === undefined ? null : bounded(element[field], `${what}.${field}`, STAGE_KEY_CHARS));
      return {
        key: bounded(element.key, `${what}.key`, STAGE_KEY_CHARS),
        id: bounded(element.id, `${what}.id`, STAGE_KEY_CHARS),
        kind: oneOf(element.kind, ELEMENT_KINDS, `${what}.kind`),
        order: num(element.order, `${what}.order`),
        scene: bounded(element.scene, `${what}.scene`, STAGE_KEY_CHARS),
        text: bounded(element.text, `${what}.text`, STAGE_TEXT_CHARS),
        emphasis: list(element.emphasis, `${what}.emphasis`).slice(0, 64) as unknown as StageBase['elements'][number]['emphasis'],
        style: sheet(element.style, `${what}.style`) as unknown as StageBase['elements'][number]['style'],
        figure: figure as unknown as StageBase['elements'][number]['figure'],
        parent: link('parent'),
        struck: bool(element.struck, `${what}.struck`),
        replaces: link('replaces'),
        ...(element.placed === undefined || element.placed === null ? {} : { placed: canvasBox(element.placed, `${what}.placed`) }),
        ...(element.driven === undefined || element.driven === null ? {} : { driven: driven(element.driven, `${what}.driven`) }),
      };
    }),
  };
}

const SIGHT_NOTES = Object.keys(SIGHT_NOTE) as SightNote[];
const SIGHT_ID_CHARS = 80;

function canvasBox(value: unknown, what: string): CanvasBox {
  const box = obj(value, what);
  return { x: num(box.x, `${what}.x`), y: num(box.y, `${what}.y`), w: num(box.w, `${what}.w`), h: num(box.h, `${what}.h`) };
}

function placedBoxes(value: unknown): readonly PlacedBox[] | undefined {
  if (value === undefined || value === null) return undefined;
  return list(value, 'report.placed').slice(0, STAGE_ELEMENTS).map((item, index) => {
    const what = `report.placed[${index}]`;
    const entry = obj(item, what);
    return {
      id: bounded(entry.id, `${what}.id`, STAGE_KEY_CHARS),
      kind: oneOf(entry.kind, ELEMENT_KINDS, `${what}.kind`),
      parent: entry.parent === null || entry.parent === undefined ? null : bounded(entry.parent, `${what}.parent`, STAGE_KEY_CHARS),
      box: canvasBox(entry.box, `${what}.box`),
    };
  });
}

function sightItem(value: unknown, what: string): SightItem {
  const raw = obj(value, what);
  const box = obj(raw.box, `${what}.box`);
  // An id goes back into the brain's brief, so it is one short line whatever the painter sent.
  const id = text(raw.id, `${what}.id`).replace(/\s+/g, ' ').slice(0, SIGHT_ID_CHARS);
  const notes = strings(raw.notes, `${what}.notes`).filter((note): note is SightNote => (SIGHT_NOTES as string[]).includes(note));
  return {
    id,
    kind: oneOf(raw.kind, ELEMENT_KINDS, `${what}.kind`),
    box: { x: num(box.x, `${what}.box.x`), y: num(box.y, `${what}.box.y`), w: num(box.w, `${what}.box.w`), h: num(box.h, `${what}.box.h`) },
    resting: bool(raw.resting, `${what}.resting`),
    notes: [...new Set(notes)],
  };
}

function sight(value: unknown): Sight {
  if (value === undefined || value === null) return NO_SIGHT;
  const raw = obj(value, 'report.sight');
  // A busy turn is cut, not refused: a report that is too rich must still close its turn.
  const items = list(raw.items, 'report.sight.items')
    .slice(0, SIGHT_ITEMS)
    .map((item, index) => sightItem(item, `report.sight.items[${index}]`));
  return {
    canvas: oneOf(raw.canvas, CANVAS_NAMES, 'report.sight.canvas'),
    coverage: Math.min(1, Math.max(0, num(raw.coverage, 'report.sight.coverage'))),
    items,
    snapshot: bool(raw.snapshot, 'report.sight.snapshot'),
  };
}

function report(value: unknown): TurnReport {
  const raw = obj(value, 'report');
  const shown = list(raw.shown, 'report.shown').slice(0, STAGE_ELEMENTS).map((item, index) => {
    const entry = obj(item, `report.shown[${index}]`);
    return {
      id: bounded(entry.id, 'shown.id', STAGE_KEY_CHARS),
      kind: oneOf(entry.kind, ELEMENT_KINDS, 'shown.kind'),
      text: bounded(entry.text, 'shown.text', STAGE_TEXT_CHARS),
      struck: bool(entry.struck, 'shown.struck'),
      partial: bool(entry.partial, 'shown.partial'),
      ...(entry.part === true ? { part: true } : {}),
    };
  });
  const placed = placedBoxes(raw.placed);
  return {
    turn: text(raw.turn, 'report.turn'),
    outcome: oneOf(raw.outcome, ['finished', 'interrupted'] as const, 'report.outcome'),
    playhead: num(raw.playhead, 'report.playhead'),
    shown,
    stage: stage(raw.stage),
    sight: sight(raw.sight),
    skippedAt: raw.skippedAt === null || raw.skippedAt === undefined ? null : num(raw.skippedAt, 'report.skippedAt'),
    ...(placed === undefined ? {} : { placed }),
    ...(raw.controls === undefined || raw.controls === null ? {} : { controls: controlValues(raw.controls, 'report.controls') }),
  };
}

const CLOCK_STATES: readonly ClockState[] = ['idle', 'waiting', 'playing', 'holding', 'paused', 'hidden'];

function backEvent(value: unknown, index: number): BackEvent {
  const raw = obj(value, `events[${index}]`);
  const type = oneOf(raw.type, BACK_EVENT_TYPES, `events[${index}].type`);
  switch (type) {
    case 'ready':
      return { type, screen: screen(raw.screen), capabilities: capabilities(raw.capabilities), look: look(raw.look, 'look') };
    case 'started':
      return { type, turn: text(raw.turn, 'turn') };
    case 'progress':
      return {
        type,
        turn: text(raw.turn, 'turn'),
        playhead: Math.max(0, num(raw.playhead, 'playhead')),
        pen: Math.max(0, num(raw.pen, 'pen')),
        clock: oneOf(raw.clock, CLOCK_STATES, 'clock'),
        ackSeq: num(raw.ackSeq, 'ackSeq'),
        shown: strings(raw.shown, 'shown'),
        gone: strings(raw.gone, 'gone'),
      };
    case 'tap':
      return {
        type,
        turn: raw.turn === null ? null : text(raw.turn, 'turn'),
        id: text(raw.id, 'id'),
        text: text(raw.text, 'text'),
        playhead: num(raw.playhead, 'playhead'),
        choice: bool(raw.choice, 'choice'),
      };
    case 'report':
      return { type, report: report(raw.report) };
    case 'control':
      return {
        type,
        turn: raw.turn === null ? null : text(raw.turn, 'turn'),
        id: text(raw.id, 'id').slice(0, LIMITS.name),
        value: controlValue(raw.value, 'value'),
        text: text(raw.text, 'text').slice(0, CONTROL_TEXT_CHARS),
        playhead: num(raw.playhead, 'playhead'),
        send: bool(raw.send, 'send'),
        ...(raw.app === true && { app: true as const }),
      };
    case 'draft': {
      const placed = placedBoxes(raw.placed);
      return {
        type,
        turn: text(raw.turn, 'turn'),
        pass: Math.max(1, Math.round(num(raw.pass, 'pass'))),
        sight: sight(raw.sight),
        ...(placed === undefined ? {} : { placed }),
        snapshot: bool(raw.snapshot, 'snapshot'),
        ...(raw.content === undefined || raw.content === null ? {} : { content: contentCount(raw.content) }),
      };
    }
    case 'permit':
      return { type, turn: text(raw.turn, 'turn'), request: requestId(raw.request), allow: bool(raw.allow, 'allow') };
  }
}

/** What a draft or a candidate puts on stage, as the painter counted it. Whole numbers, none below zero. */
function contentCount(value: unknown): ContentCount {
  const raw = obj(value, 'content');
  const count = (field: unknown, name: string): number => Math.max(0, Math.round(num(field, `content.${name}`)));
  const choices = raw.choices === undefined ? [] : list(raw.choices, 'content.choices').slice(0, LIMITS.elements).map((item) => text(item, 'content.choices').slice(0, LIMITS.text));
  return { structures: count(raw.structures, 'structures'), parts: count(raw.parts, 'parts'), drawn: count(raw.drawn, 'drawn'), controls: count(raw.controls, 'controls'), words: count(raw.words, 'words'), choices };
}

export function parseBackEvents(body: unknown): BackEvent[] {
  const events = list(obj(body, 'body').events, 'events');
  return events.map((item, index) => backEvent(item, index));
}

/** Body of `POST …/turns`: the input, and the back events queued ahead of it (optional). */
export function parseStartTurn(body: unknown): StartTurnRequest {
  const input = parseTurnInput(body);
  const raw = obj(body, 'body').events;
  if (raw === undefined) return { input };
  return { input, events: list(raw, 'events').map((item, index) => backEvent(item, index)) };
}

/** Body of `PUT …/brain`: a model and/or an effort, each from the allowlist. Anything else is refused by name. */
export function parseBrainChange(body: unknown): BrainChange {
  const o = obj(body, 'body');
  const unknown = Object.keys(o).filter((key) => key !== 'model' && key !== 'effort' && key !== 'mode');
  if (unknown.length > 0) throw errors.badRequest(`unknown setting ${unknown.join(', ')}: only model, effort and mode can be set`);
  if (o.model === undefined && o.effort === undefined && o.mode === undefined) {
    throw errors.badRequest(`say a model (${BRAIN_MODELS.join(' | ')}), an effort (${BRAIN_EFFORTS.join(' | ')}) or a mode (${BRAIN_MODES.join(' | ')})`);
  }
  return {
    ...(o.model === undefined ? {} : { model: oneOf(o.model, BRAIN_MODELS, 'model') }),
    ...(o.effort === undefined ? {} : { effort: oneOf(o.effort, BRAIN_EFFORTS, 'effort') }),
    ...(o.mode === undefined ? {} : { mode: oneOf(o.mode, BRAIN_MODES, 'mode') }),
  };
}

/** Body of `PUT …/tools`: the name of a tool or service and whether it is on. The server checks the name against what it offers. */
export function parseToolSwitch(body: unknown): { readonly name: string; readonly on: boolean } {
  const o = obj(body, 'body');
  const name = text(o.name, 'name').trim();
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) throw errors.badRequest('name must be the name of a tool or service, as /tools lists it');
  return { name, on: bool(o.on, 'on') };
}

/** Body of `DELETE …/asks`: nothing or `{}` forgets every standing ask; `{ drop: n }` forgets the nth. Answers the number to drop, or null for all. */
export function parseAsksClear(body: unknown): number | null {
  const o = obj(body, 'body');
  if (o.drop === undefined) return null;
  const n = Math.round(num(o.drop, 'drop'));
  if (n < 1) throw errors.badRequest('drop must be a number from 1');
  return n;
}
