// The single definition of every word in Series. Types, the parser, the
// reference tables in docs/language.md and the brain's system prompt are all
// derived from the tables in this file. Each gloss says what a word MEANS,
// because the gloss is what the brain reads when it chooses. Glosses are kept
// short on purpose: every one of them is paid for in the brain's prompt.

export const LANGUAGE = { name: 'Series', version: 4 } as const;

function keysOf<T extends Record<string, unknown>>(table: T): readonly (keyof T & string)[] {
  return Object.keys(table) as (keyof T & string)[];
}

export const LAYER = {
  far: 'the deep background: sky, horizon, weather. Never holds the pen.',
  bg: 'behind the subject: scenery, or one huge dim word. Never holds the pen.',
  mid: 'the subject and the reading plane. Default.',
  fg: 'in front, close to the camera: stamps, labels, things passing by.',
} as const;
export type Layer = keyof typeof LAYER;
export const LAYERS = keysOf(LAYER);
/** Layers whose elements are atmosphere: they arrive alongside whatever is said next. */
export const BACKDROP_LAYERS: readonly Layer[] = ['far', 'bg'];

export const LAYOUT = {
  stack: 'lines build downward into one block: a thought growing. Default.',
  solo: 'one line at a time, centre stage; each new line replaces the last.',
  split: 'two columns for contrast; send lines to at=left and at=right.',
  list: 'compact left-aligned items.',
  page: 'plain prose in a reading column, arriving at reading speed. For answers that are information.',
  caption: 'the picture has the stage; lines appear one at a time in a band under it, like subtitles.',
  figure: 'the picture on one side, the lines beside it. For explaining something drawn.',
  free: 'no flow; each line goes where its at= or near= says.',
} as const;
export type Layout = keyof typeof LAYOUT;
export const LAYOUTS = keysOf(LAYOUT);

/**
 * The drawing space of a scene. Units are square. The painter fits the canvas
 * into the room the layout leaves for pictures, so the same coordinates draw
 * the same picture on every screen.
 */
export const CANVAS = {
  wide: { width: 160, height: 90, gist: '160 x 90, landscape. Default.' },
  square: { width: 100, height: 100, gist: '100 x 100.' },
  tall: { width: 90, height: 160, gist: '90 x 160, portrait: for phones.' },
} as const;
export type CanvasName = keyof typeof CANVAS;
export const CANVAS_NAMES = keysOf(CANVAS);
export const DEFAULT_CANVAS: CanvasName = 'wide';

export const MOOD = {
  calm: 'slow ambient motion, long eases',
  neutral: 'at rest. Default.',
  tense: 'tighter framing, nervous, short eases',
  playful: 'lighter and quicker',
  grave: 'very slow, heavy, dimmer',
} as const;
export type Mood = keyof typeof MOOD;
export const MOODS = keysOf(MOOD);

export const PACE = {
  slow: 'unhurried: weight, tenderness, difficulty',
  steady: 'conversational. Default.',
  brisk: 'quick: lists, excitement, urgency',
} as const;
export type Pace = keyof typeof PACE;
export const PACES = keysOf(PACE);

export const ALIGN = {
  auto: 'the painter chooses from the layout. Default.',
  left: 'ragged right, like prose',
  center: 'centred, like a title card',
  right: 'ragged left',
} as const;
export type Align = keyof typeof ALIGN;
export const ALIGNS = keysOf(ALIGN);

export const CLEAR = {
  scene: 'everything that is not pinned leaves. Default.',
  all: 'everything leaves, pins included',
  none: 'nothing leaves; the new scene is added on top',
} as const;
export type Clear = keyof typeof CLEAR;
export const CLEARS = keysOf(CLEAR);

export const SIZE = {
  xs: 'fine print',
  s: 'an aside',
  m: 'body. Default.',
  l: 'emphasis',
  xl: 'a headline',
  xxl: 'one or two words that fill the stage',
} as const;
export type Size = keyof typeof SIZE;
export const SIZES = keysOf(SIZE);

/**
 * Nominal size of each step against body. A look may snap these to what its
 * machine could really do, but it must keep the order, and neighbouring steps
 * it tells apart by size alone must differ by at least 1.25x.
 */
export const SIZE_SCALE: Readonly<Record<Size, number>> = { xs: 0.64, s: 0.8, m: 1, l: 1.5, xl: 2.25, xxl: 3.4 };

export const INK = {
  ink: "the look's normal colour. Default.",
  dim: 'receded: asides, things already said, construction lines',
  accent: "the look's one strong colour: the thing that matters",
  alt: 'a second, cooler signal',
  ground: 'the background colour: for knocking a shape out of another',
} as const;
export type InkRole = keyof typeof INK;
export const INK_ROLES = keysOf(INK);

export const WEIGHT = {
  normal: 'Default.',
  bold: "heavier, in the look's own way",
} as const;
export type Weight = keyof typeof WEIGHT;
export const WEIGHTS = keysOf(WEIGHT);

/** Typefaces. Every one is shipped with the app; nothing is fetched. A look names the face its text is set in. */
export const FACE = {
  serif: 'a bookish text face: warmth, story, authority',
  sans: 'a clean neutral face: explanation, labels',
  hand: 'handwriting: notes, sketches, intimacy',
  display: 'a heavy poster face: titles and shouts',
  mono: 'a typewriter face: code, data, exactness',
  terminal: 'a 1980s terminal face (fixed pitch)',
  teletext: 'the broadcast teletext face (fixed pitch)',
  dot: 'a dot-matrix printer face (fixed pitch)',
} as const;
export type Face = keyof typeof FACE;
export const FACES = keysOf(FACE);

export const ENTER = {
  type: 'character by character, as if being thought right now',
  fade: 'eases into being',
  rise: 'lifts into place',
  slam: 'lands hard, all at once: a verdict',
  wipe: 'unrolls left to right',
  cut: 'is simply there',
  flicker: 'struggles on: doubt, a bad signal',
  draw: 'draws itself: a stroke along its length, a sprite row by row. Default for anything drawn.',
  pop: 'springs up from nothing',
} as const;
export type EnterEffect = keyof typeof ENTER;
export const ENTER_EFFECTS = keysOf(ENTER);

export const EXIT = {
  fade: 'lets go gently',
  cut: 'is gone',
  fall: 'drops away',
  wipe: 'is erased as you watch',
} as const;
export type ExitEffect = keyof typeof EXIT;
export const EXIT_EFFECTS = keysOf(EXIT);

/** What a filled shape does at the edge of the canvas. */
export const BLEED = {
  auto: 'a filled shape that touches the canvas edge runs on to the screen edge. Default.',
  none: 'it stops at the canvas edge',
} as const;
export type Bleed = keyof typeof BLEED;
export const BLEEDS = keysOf(BLEED);

export const BY = {
  all: 'the whole text at once',
  word: 'word by word, at speaking rhythm',
  char: 'character by character',
} as const;
export type By = keyof typeof BY;
export const BYS = keysOf(BY);

export const LOOP = {
  none: 'still. Default.',
  breathe: 'a slow swell',
  pulse: 'a steady beat',
  blink: 'on, off',
  shake: 'a tremor',
  drift: 'a slow wander',
  spin: 'turns steadily about its centre',
  bob: 'rides up and down: floating, idling',
  sway: 'rocks a little from side to side',
} as const;
export type Loop = keyof typeof LOOP;
export const LOOPS = keysOf(LOOP);

export const MARK = {
  none: 'Default.',
  underline: 'this matters',
  box: 'a label, a key term, something to press',
  invert: 'knocked out of a solid bar',
  strike: 'withdrawn, but left visible',
} as const;
export type Mark = keyof typeof MARK;
export const MARKS = keysOf(MARK);

export const LETTERCASE = {
  asis: 'as written. Default.',
  upper: 'ALL CAPITALS',
  lower: 'all lower case',
} as const;
export type LetterCase = keyof typeof LETTERCASE;
export const LETTERCASES = keysOf(LETTERCASE);

export const STAY = {
  beat: 'leaves by itself once it has been read',
  scene: 'leaves when the next scene opens. Default.',
  pin: 'stays across scenes until you drop it',
} as const;
export type StayWord = keyof typeof STAY;
export const STAY_WORDS = keysOf(STAY);

export const ANCHOR = {
  center: 'centre',
  top: 'top centre',
  bottom: 'bottom centre',
  left: 'left centre (in layout=split: the left column)',
  right: 'right centre (in layout=split: the right column)',
  'top-left': 'top left corner',
  'top-right': 'top right corner',
  'bottom-left': 'bottom left corner',
  'bottom-right': 'bottom right corner',
} as const;
export type Anchor = keyof typeof ANCHOR;
export const ANCHORS = keysOf(ANCHOR);

/** Which side of its neighbour a `near=` element sits on. */
export const SIDE = {
  auto: 'wherever there is room. Default.',
  above: 'above it',
  below: 'below it',
  left: 'to its left',
  right: 'to its right',
} as const;
export type Side = keyof typeof SIDE;
export const SIDES = keysOf(SIDE);

export const CAMERA = {
  push: 'move closer: intensity, intimacy',
  pull: 'move back: release, the bigger picture',
  pan: 'travel across the scene: give left, right, up or down',
  drift: 'a slow sideways float: time passing',
  orbit: 'swing a little around the stage so the layers separate',
  focus: 'travel to one element and frame it (give its id)',
  shake: 'one jolt: impact',
  rest: 'return to neutral',
} as const;
export type CameraMove = keyof typeof CAMERA;
export const CAMERA_MOVES = keysOf(CAMERA);

export const DIRECTION = { left: 'left', right: 'right', up: 'up', down: 'down' } as const;
export type Direction = keyof typeof DIRECTION;
export const DIRECTIONS = keysOf(DIRECTION);

/** How fast a move is: the camera, `move`, and `set` when it is given a speed. */
export const CAMERA_SPEED = {
  slow: 'felt more than seen',
  steady: 'a deliberate move. Default.',
  fast: 'a snap',
} as const;
export type CameraSpeed = keyof typeof CAMERA_SPEED;
export const CAMERA_SPEEDS = keysOf(CAMERA_SPEED);

export const HIT = {
  pulse: 'one swell: "this, again". Default.',
  flash: 'one bright blink: "look here, now"',
  shake: 'one jolt: "no", or an impact',
} as const;
export type HitGesture = keyof typeof HIT;
export const HIT_GESTURES = keysOf(HIT);

/** Atmosphere: fields of small moving things. The painter animates every particle; the brain names the weather. */
export const AMBIENT = {
  rain: 'falling streaks',
  snow: 'slow drifting flakes',
  dust: 'motes hanging in light',
  stars: 'a still field of points that twinkle',
  fireflies: 'a few warm lights wandering',
  embers: 'sparks rising and dying',
  sparks: 'a burst flying outward',
  bubbles: 'rising, wobbling',
  leaves: 'tumbling across',
  confetti: 'celebration',
  fog: 'slow soft banks',
  rays: 'shafts of light from above',
} as const;
export type AmbientKind = keyof typeof AMBIENT;
export const AMBIENT_KINDS = keysOf(AMBIENT);

export const AMOUNT = { light: 'a little', some: 'Default.', heavy: 'a lot' } as const;
export type Amount = keyof typeof AMOUNT;
export const AMOUNTS = keysOf(AMOUNT);

/** The character of a drawn line. Part of a look. */
export const STROKE = {
  clean: 'even, exact: diagrams',
  pencil: 'slightly uneven and grainy: a sketch',
  marker: 'thick, confident, a little wobbly',
  chalk: 'dusty, broken',
  pixel: 'hard stair-stepped edges',
  ink: 'a brush pen: swells and tapers along the stroke',
  dry: 'a dry brush: streaky, breaking up where it runs out',
} as const;
export type StrokeCharacter = keyof typeof STROKE;
export const STROKES = keysOf(STROKE);

/**
 * Screen and paper effects, composable. A look lists the ones it wants; the
 * painter always applies them in one fixed order, whatever order they are
 * written in. `taught: false` marks the machinery of one retro preset: it
 * works, but the brain's prompt does not spend words on it.
 */
export const FX = {
  paper: { gist: 'paper fibre; ink soaks in', taught: true },
  grain: { gist: 'film grain', taught: true },
  glow: { gist: 'bright things bleed light', taught: true },
  vignette: { gist: 'darker toward the edges', taught: true },
  halftone: { gist: 'printed dots for tone', taught: true },
  misprint: { gist: 'two inks out of register', taught: true },
  pixelate: { gist: 'chunky square pixels', taught: true },
  dither: { gist: 'few colours, dot shading', taught: true },
  scanlines: { gist: 'the raster of an old tube', taught: true },
  grid: { gist: 'faint drafting squares', taught: true },
  dust: { gist: 'chalk dust and smears', taught: true },
  persistence: { gist: 'afterglow: what moves or leaves lingers', taught: false },
  curve: { gist: 'curved tube glass', taught: false },
  signal: { gist: 'jitter and noise that rise with a tense mood', taught: false },
  header: { gist: 'a teletext page header row', taught: false },
  bars: { gist: 'green-bar fanfold paper with tractor holes', taught: false },
  ribbon: { gist: 'uneven ink from a fabric ribbon', taught: false },
  shadow: { gist: 'foreground things cast a soft shadow on the sheet', taught: false },
} as const satisfies Record<string, { gist: string; taught: boolean }>;
export type FxName = keyof typeof FX;
export const FX_NAMES = keysOf(FX);

/** What a painting should look like it was made with. */
export const MEDIUM = {
  watercolor: 'loose wet washes',
  oil: 'thick visible brushwork',
  gouache: 'flat opaque shapes',
  ink: 'brush and ink, few tones',
  pastel: 'soft chalky colour',
  woodcut: 'carved black and white',
  photo: 'a photograph',
  pixel: 'pixel art',
} as const;
export type Medium = keyof typeof MEDIUM;
export const MEDIUMS = keysOf(MEDIUM);
/**
 * The media the painter renders by itself, as shader passes over the sketch the
 * brain drew: no image model, nothing fetched. It re-renders the brain's own
 * shapes in that medium; it invents nothing that was not drawn. `photo` is the
 * one medium only an image model can make.
 */
export const PROCEDURAL_MEDIA: readonly Medium[] = ['watercolor', 'oil', 'gouache', 'ink', 'pastel', 'woodcut', 'pixel'];

/** What a fill is made of, beyond flat colour. Procedural: drawn by the painter's shaders in the fill's own colour, fixed to the surface so nothing shimmers. */
export const TEXTURE = {
  flat: 'even colour. Default.',
  wash: 'a watercolour wash: pooled, darker at the edges',
  hatch: 'pen hatching',
  dots: 'stippled dots',
  grain: 'a dry, chalky grain',
  weave: 'canvas weave under thick paint',
} as const;
export type Texture = keyof typeof TEXTURE;
export const TEXTURES = keysOf(TEXTURE);

/** How a shape's paint meets what is under it: `multiply` darkens like a glaze, `screen` lightens like light. */
export const BLEND = {
  normal: 'paint over paint. Default.',
  multiply: 'a glaze: darkens what is under it',
  screen: 'light: lightens what is under it',
} as const;
export type Blend = keyof typeof BLEND;
export const BLENDS = keysOf(BLEND);

/**
 * The painter's tools on a drawn line, read by their own verbs and taught in the drawing brief (`drawingKit`) only: they are not in the fixed
 * prompt, so a line that has none of them costs nothing. Every one is a setting on a mark the brain makes; none places anything.
 */
export const PAINT_PROP = {
  dash: { also: 'on,off', gist: 'breaks the stroke into dashes along its own length, in canvas units' },
  thick: { also: 'a>b>c', gist: 'width along the stroke, like pressure: thin, full, thin' },
  stroke: { also: 'c1>c2', gist: 'colour along the stroke' },
  clip: { also: '<shape id>', gist: 'paints only inside that shape' },
  blend: { also: BLENDS.join(' | '), gist: 'multiply glazes, screen lights' },
  fill: { also: 'a>b>c, radial, angle=N', gist: 'a gradient of any number of stops; radial from the middle; angle turns it (0 top to bottom, 90 left to right)' },
} as const;

export const MASK = {
  none: 'the whole rectangle. Default.',
  round: 'rounded corners',
  circle: 'a circle',
  soft: 'edges fade out',
  torn: 'a rough torn edge',
} as const;
export type Mask = keyof typeof MASK;
export const MASKS = keysOf(MASK);

export type HexString = `#${string}`;

export interface LookSpecLanguage {
  readonly gist: string;
  readonly ground: HexString;
  readonly ink: HexString;
  readonly dim: HexString;
  readonly accent: HexString;
  readonly alt: HexString;
  readonly face: Face;
  readonly fx: readonly FxName[];
  readonly stroke: StrokeCharacter;
  /** what text does when the brain leaves motion unspecified */
  readonly enter: EnterEffect;
  readonly by: By;
  readonly exit: ExitEffect;
}

// The presets. Each is written in the same words the brain uses to define a
// look of its own, so the brain can read exactly what `night` is and make a
// variation of it. `enter`, `by` and `exit` are what text does when the brain
// leaves motion unspecified; they live here, not in the painter, because they
// change durations and the schedule must be the same on both sides.
export const LOOK = {
  paper: {
    gist: 'Ink on warm paper. Quiet and bright.',
    ground: '#f4efe4',
    ink: '#23201b',
    dim: '#6f685c',
    accent: '#c13e1e',
    alt: '#2a5d8f',
    face: 'serif',
    fx: ['paper', 'grain'],
    stroke: 'pencil',
    enter: 'fade',
    by: 'word',
    exit: 'fade',
  },
  night: {
    gist: 'Deep blue dark, soft light. Stories, stillness, anything after sunset.',
    ground: '#0f1424',
    ink: '#e9e4d6',
    dim: '#8e93a8',
    accent: '#ffb454',
    alt: '#7fb8d8',
    face: 'serif',
    fx: ['glow', 'grain', 'vignette'],
    stroke: 'clean',
    enter: 'fade',
    by: 'word',
    exit: 'fade',
  },
  chalk: {
    gist: 'A blackboard: only when asked for, or for working something out by hand.',
    ground: '#22302b',
    ink: '#eef0e6',
    dim: '#9aa79c',
    accent: '#ffd866',
    alt: '#8fd3e8',
    face: 'hand',
    fx: ['dust', 'vignette'],
    stroke: 'chalk',
    enter: 'wipe',
    by: 'all',
    exit: 'fade',
  },
  blueprint: {
    gist: 'White line on drafting blue: only when asked for, or for a real plan or schematic. Never the default for a mechanism.',
    ground: '#18407a',
    ink: '#f2f6ff',
    dim: '#a9c0e6',
    accent: '#ffd23f',
    alt: '#ff8fa3',
    face: 'mono',
    fx: ['grid', 'grain'],
    stroke: 'clean',
    enter: 'type',
    by: 'char',
    exit: 'cut',
  },
  riso: {
    gist: 'A two-colour print: flat shapes, halftone dots. Bold, playful.',
    ground: '#f6f0e2',
    ink: '#1f2a5c',
    dim: '#636b98',
    accent: '#db0013',
    alt: '#007980',
    face: 'display',
    fx: ['paper', 'halftone', 'misprint'],
    stroke: 'marker',
    enter: 'pop',
    by: 'all',
    exit: 'cut',
  },
  phosphor: {
    gist: 'An amber terminal, 1987: one colour, typed in.',
    ground: '#140d04',
    ink: '#f0a000',
    dim: '#a87400',
    accent: '#ffd070',
    alt: '#cf8a00',
    face: 'terminal',
    fx: ['persistence', 'glow', 'scanlines', 'curve', 'signal'],
    stroke: 'clean',
    enter: 'type',
    by: 'char',
    exit: 'cut',
  },
  teletext: {
    gist: 'Broadcast teletext, 1981: eight hard colours, chunky pixels.',
    ground: '#000000',
    ink: '#ffffff',
    dim: '#7f7f7f',
    accent: '#ffff00',
    alt: '#00ffff',
    face: 'teletext',
    fx: ['pixelate', 'dither', 'signal', 'header'],
    stroke: 'pixel',
    enter: 'cut',
    by: 'word',
    exit: 'cut',
  },
  pixel: {
    gist: 'Flat mid-grey, hard edges. For pixel art: no sprite colour vanishes.',
    ground: '#8a8f98',
    ink: '#141414',
    dim: '#262a33',
    accent: '#7a0f22',
    alt: '#123a6b',
    face: 'mono',
    fx: [],
    stroke: 'pixel',
    enter: 'cut',
    by: 'all',
    exit: 'cut',
  },
  printout: {
    gist: 'A dot-matrix printout on green-bar paper, 1980.',
    ground: '#f1ede0',
    ink: '#1d1a18',
    dim: '#625d57',
    accent: '#b3261e',
    alt: '#1f3f8f',
    face: 'dot',
    fx: ['bars', 'ribbon', 'shadow', 'paper'],
    stroke: 'pencil',
    enter: 'type',
    by: 'char',
    exit: 'fade',
  },
  wireframe: {
    gist: 'Boxes and lines on white: an interface before anyone has chosen a colour. For mock-ups (INTERFACE).',
    ground: '#171a21',
    ink: '#1d2129',
    dim: '#5d6573',
    accent: '#1d2129',
    alt: '#8a93a3',
    face: 'sans',
    fx: [],
    stroke: 'clean',
    enter: 'fade',
    by: 'all',
    exit: 'fade',
  },
  studio: {
    gist: 'A finished interface design: surfaces, soft shadows, one accent. For mock-ups (INTERFACE).',
    ground: '#14161d',
    ink: '#12151c',
    dim: '#5b6479',
    accent: '#1f5eff',
    alt: '#97a0b3',
    face: 'sans',
    fx: [],
    stroke: 'clean',
    enter: 'fade',
    by: 'all',
    exit: 'fade',
  },
} as const satisfies Record<string, LookSpecLanguage>;
/** The id of a preset. A look the brain defines has a name of its own and stands on one of these. */
export type LookId = keyof typeof LOOK;
export const LOOK_IDS = keysOf(LOOK);
export const DEFAULT_LOOK: LookId = 'paper';
/** The presets pinned to one old machine. They are offered, never assumed. */
export const RETRO_LOOKS: readonly LookId[] = ['phosphor', 'teletext', 'printout'];
/** The looks of a mock-up. They are taught by the interface chapter in the brief, never by the fixed prompt (which is full). */
export const INTERFACE_LOOKS: readonly LookId[] = ['wireframe', 'studio'];

/**
 * The sixteen colours a sprite cell can name with one hex digit. The order
 * follows the fantasy-console convention models already know: 0 black,
 * 7 white, 8 red, a yellow, b green, c blue.
 */
export const SPRITE_PALETTE: readonly HexString[] = [
  '#141414',
  '#22305c',
  '#7b2a55',
  '#1f7a4d',
  '#a5562f',
  '#5c5a55',
  '#bfc3c7',
  '#fbf3e4',
  '#e83b46',
  '#f59f1c',
  '#ffe74a',
  '#3fd45c',
  '#3aa8f2',
  '#8576a6',
  '#f582a8',
  '#f7c9a3',
];

/**
 * Structures: diagrams the brain names and the painter lays out. The brain says
 * what the parts are and how they relate; the painter places every part, routes
 * every connector and keeps every label clear. Each is also a verb.
 */
export const STRUCTURE = {
  flow: { gist: 'steps joined by arrows: a process, a decision', parts: 'nodes', lays: 'painter' },
  tree: { gist: 'each node under its from=: a family, a hierarchy', parts: 'nodes', lays: 'painter' },
  cycle: { gist: 'nodes round a ring, the last leading back to the first', parts: 'nodes', lays: 'painter' },
  timeline: { gist: 'nodes on an axis, to scale by their number (a year; two numbers are a span)', parts: 'nodes', lays: 'axis' },
  map: { gist: 'pins at your x,y, labelled clear of each other', parts: 'nodes', lays: 'brain' },
  table: { gist: 'rows `| a | b | c`, the first the header; `bars` draws its numbers as bars too', parts: 'rows', lays: 'painter' },
  chart: { gist: 'rows `| when | value`: an instrument with axes, a crosshair and zoom', parts: 'rows', lays: 'engine' },
  code: { gist: 'rows `| line` taken exactly as written, indentation kept: monospaced and highlighted, with a copy action', parts: 'rows', lays: 'engine' },
  tune: { gist: 'rows `| line` of ABC notation, taken exactly: a piano roll that plays, with a playhead and the notes lighting as they sound', parts: 'rows', lays: 'engine' },
  app: { gist: 'rows `| line` of one HTML document (inline style and script), taken exactly: a live app that runs in a locked sandbox on the stage and answers back (taught only when the user asks for something that works)', parts: 'rows', lays: 'engine' },
  figure: { gist: 'a labelled drawing: each part one line (taught by the FIGURE chapter in the brief); rows are the lines of the figure, taken as written', parts: 'rows', lays: 'engine' },
  math: { gist: 'a written method laid out as on paper (taught by the maths chapter, not yet in the brief): the line is `math <id> <method> | <sum>`, the painter works every digit', parts: 'rows', lays: 'engine' },
  problem: { gist: 'an old maths question: it plays as an `ask` for its answer (the question as its words); write an `ask` instead', parts: 'rows', lays: 'engine' },
  screen: { gist: 'a mock-up: devices at true size, each part one line (taught by the INTERFACE chapter in the brief); rows are the lines of the interface, taken as written', parts: 'rows', lays: 'engine' },
} as const satisfies Record<string, { gist: string; parts: 'nodes' | 'rows'; lays: 'painter' | 'axis' | 'brain' | 'engine' }>;
export type StructureKind = keyof typeof STRUCTURE;
export const STRUCTURE_KINDS = keysOf(STRUCTURE);

/**
 * The ways a `problem` can be laid out under its question. The painter draws each from the question's own numbers; the brain never draws one.
 * `ways=` on a problem chooses or limits them; without it the painter offers every way that fits the question.
 */
export const PROBLEM_WAYS = ['groups', 'bar', 'array', 'column', 'line'] as const;
export type ProblemWay = (typeof PROBLEM_WAYS)[number];
/** The words a brain says for a way, as they are written after `ways=`. */
export const PROBLEM_WAY_WORDS: Readonly<Record<string, ProblemWay>> = {
  groups: 'groups', group: 'groups', equal: 'groups', sharing: 'groups', share: 'groups',
  bar: 'bar', bars: 'bar', strip: 'bar', model: 'bar',
  array: 'array', grid: 'array', rows: 'array',
  column: 'column', columns: 'column', tens: 'column', place: 'column', blocks: 'column',
  line: 'line', numberline: 'line', 'number-line': 'line', jumps: 'line', jump: 'line',
};

/**
 * The names a `code` block knows a language by, as the brain writes them. A word here is never taken for an id: `code python` is a block of
 * Python. Any other name is kept as written (`lang=elvish`), and the painter's tokenizer shows what it does not know as plain text.
 */
export const CODE_LANGUAGES = [
  'text', 'plain', 'txt', 'ts', 'typescript', 'js', 'javascript', 'jsx', 'tsx', 'json', 'python', 'py', 'bash', 'sh', 'shell', 'zsh', 'css', 'scss', 'html', 'xml', 'svg', 'sql',
  'c', 'cpp', 'c++', 'csharp', 'c#', 'cs', 'java', 'kotlin', 'swift', 'go', 'golang', 'rust', 'rs', 'ruby', 'rb', 'php', 'yaml', 'yml', 'toml', 'ini', 'md', 'markdown', 'diff',
  'lua', 'r', 'haskell', 'scala', 'perl', 'dart', 'elixir', 'ocaml', 'regex', 'dockerfile', 'makefile', 'graphql',
] as const;
export type CodeLanguage = (typeof CODE_LANGUAGES)[number];

/**
 * The instruments a `tune` can be played on: a soft piano, bowed strings, a square-wave chip lead, a bell. The painter's own synthesiser
 * makes them; there is nothing to load, and nothing to choose between but the word.
 */
export const TUNE_VOICES = ['piano', 'strings', 'chip', 'bell'] as const;
export type TuneVoice = (typeof TUNE_VOICES)[number];
export const DEFAULT_TUNE_VOICE: TuneVoice = 'piano';

/** The room a live `app` asks for, as a height in canvas units (a width is what the stage gives it); more or less is clamped. */
export const APP_HEIGHT = { min: 120, max: 1200, default: 480 } as const;

/**
 * v2.1. The vetted library shelf a live app may ask for (`app … uses=physics,sound`). The host puts the library in the app's own document,
 * because the sandbox has no network: `physics` is matter.js (global `Matter`), `sound` Tone.js (`Tone`), `maths` KaTeX (`katex`, its stylesheet
 * included) and `charts`/`graphs` D3 (`d3`; both words name the one library). Other words are said back as a mistake and ignored.
 */
export const APP_SHELVES = ['physics', 'sound', 'maths', 'charts', 'graphs', 'fonts'] as const;
export type AppShelf = (typeof APP_SHELVES)[number];
/** Words a brain says for a shelf that are not its name. */
export const APP_SHELF_ALIASES: Readonly<Record<string, AppShelf>> = { math: 'maths', matter: 'physics', music: 'sound', tone: 'sound', katex: 'maths', chart: 'charts', graph: 'graphs', d3: 'charts' };

/** Which way a flow or a tree grows. */
export const GROWTH = { right: 'left to right', down: 'top to bottom' } as const;
export type Growth = keyof typeof GROWTH;
export const GROWTHS = keysOf(GROWTH);

/**
 * What a chart draws. A chart is an instrument, not a drawing: the painter
 * hands it to a charting engine that gives it formatted axes, gridlines, a
 * crosshair with the value under it, pan and zoom, a legend, and enough speed
 * for thousands of points. It takes its colours and its face from the look.
 */
export const CHART = {
  line: 'a line through the points: a trend. Default.',
  area: 'a line with the ground under it filled',
  columns: 'upright bars: amounts, a distribution',
  candles: 'candlesticks: rows give open, high, low, close, and volume if there is any',
  ohlc: 'open-high-low-close bars',
} as const;
export type ChartKind = keyof typeof CHART;
export const CHART_KINDS = keysOf(CHART);
export const DEFAULT_CHART: ChartKind = 'line';

/** Words on a chart line that change how it reads. */
export const CHART_WORD = {
  indexed: 'every series starts from 100, so growth can be compared',
  log: 'a logarithmic scale',
  spark: 'no axes or grid: a small chart for a tile',
  live: 'the last point pulses, as on a feed',
  approx: 'the numbers are recalled, not data: the chart says so',
} as const;
export type ChartWord = keyof typeof CHART_WORD;
export const CHART_WORDS = keysOf(CHART_WORD);

/** What a node of a flow, a tree or a cycle is drawn as. Timelines and maps draw their own markers. */
export const NODE = {
  step: 'a box. Default.',
  ask: 'a decision: its links carry the answers',
  end: 'where it starts or stops',
  note: 'an aside with no frame',
} as const;
export type NodeShape = keyof typeof NODE;
export const NODE_SHAPES = keysOf(NODE);

/** The ends of a link. */
export const LINK_END = {
  arrow: 'points at the second node. Default.',
  both: 'points both ways',
  plain: 'no arrowhead: a relation, not a direction',
} as const;
export type LinkEnd = keyof typeof LINK_END;
export const LINK_ENDS = keysOf(LINK_END);

/**
 * Controls: the catalogue of interactive parts. The brain declares one in a
 * line; the painter draws it in the look and makes it work. Each is also a verb.
 */
export const CONTROL = {
  button: 'press it: the press is sent to you with every control\'s value',
  toggle: 'on or off',
  slider: 'a number between two ends, dragged',
  pick: 'one of several options, written `| a | b | c`',
  input: 'a line of text the user types',
} as const;
export type ControlKind = keyof typeof CONTROL;
export const CONTROL_KINDS = keysOf(CONTROL);

/** How a `pick` shows its options. */
export const PICK = {
  row: 'side by side. Default.',
  tabs: 'as tabs over what they switch',
  menu: 'folded into a menu: for many options',
  steps: 'one at a time with back and next: a walk-through',
} as const;
export type PickForm = keyof typeof PICK;
export const PICK_FORMS = keysOf(PICK);

export type VerbTime =
  /** starts at the pen and moves the pen past itself */
  | 'holds'
  /** starts at the pen and moves the pen part of the way through its own drawing, so strokes overlap like a quick hand */
  | 'draws'
  /** starts at the pen and leaves the pen where it is */
  | 'starts'
  /** starts at the pen and moves the pen past most of the outgoing exits */
  | 'opens'
  /** takes no time */
  | 'instant'
  /** edits lines that have not played yet */
  | 'edit';

export type VerbFamily = 'plan' | 'words' | 'text' | 'drawing' | 'pixels' | 'composition' | 'structure' | 'control' | 'picture' | 'atmosphere' | 'change' | 'camera' | 'time' | 'mind';

export const VERB = {
  scene: {
    form: 'scene [id] [layout] [canvas=…] [lines=N] [mood] [pace] [align=…] [clear=…]',
    gist: 'Open a new scene and state its plan first. What was on stage leaves.',
    time: 'opens',
    family: 'plan',
  },
  plan: {
    form: 'plan [lines=N] [mood=…] [pace=…]',
    gist: 'Amend the open scene mid-stream.',
    time: 'instant',
    family: 'plan',
  },
  look: {
    form: 'look <name> [like=<look>] [ground= ink= dim= accent= alt=#hex] [face=…] [fx=a,b] [stroke=…]',
    gist: 'Choose a preset, or define and wear a look of your own.',
    time: 'holds',
    family: 'words',
  },
  style: {
    form: 'style <name> [like=<style>] <prop>=<value>…',
    gist: 'Define a named style. It lasts for the conversation.',
    time: 'instant',
    family: 'words',
  },
  color: {
    form: 'color <name>=#hex …',
    gist: 'Name colours of your own; use the names wherever a colour goes.',
    time: 'instant',
    family: 'words',
  },
  say: {
    form: 'say [id] [style…] [prop=value…] | <text>',
    gist: 'Text. The pen moves on once it has arrived and been read.',
    time: 'holds',
    family: 'text',
  },
  correct: {
    form: 'correct <id> | <new text>',
    gist: 'Visibly take it back: the old text is struck through, the new arrives beside it.',
    time: 'holds',
    family: 'text',
  },
  circle: {
    form: 'circle [id] x,y r [prop=value…]',
    gist: 'A circle: centre and radius.',
    time: 'draws',
    family: 'drawing',
  },
  ellipse: {
    form: 'ellipse [id] x,y RXxRY [prop=value…]',
    gist: 'An ellipse: centre and radii.',
    time: 'draws',
    family: 'drawing',
  },
  rect: {
    form: 'rect [id] x,y WxH [r=N] [prop=value…]',
    gist: 'A rectangle: top-left corner and size. `rect full` covers the whole screen.',
    time: 'draws',
    family: 'drawing',
  },
  line: {
    form: 'line [id] x,y x,y [x,y…] [prop=value…]',
    gist: 'A line through points.',
    time: 'draws',
    family: 'drawing',
  },
  poly: {
    form: 'poly [id] x,y x,y x,y [x,y…] [prop=value…]',
    gist: 'A closed shape through points.',
    time: 'draws',
    family: 'drawing',
  },
  path: {
    form: 'path [id] [prop=value…] | <SVG path data>',
    gist: 'Any curve, in SVG path data (M L H V C S Q T A Z).',
    time: 'draws',
    family: 'drawing',
  },
  pix: {
    form: 'pix [id] [scale=N] [fps=N] [key=c:colour,…] [prop=value…]',
    gist: 'Pixel art. Follow it with one `| row` line per row of cells.',
    time: 'holds',
    family: 'pixels',
  },
  row: {
    form: '| <cells>',
    gist: 'One row of the sprite above. `.` is empty, `#` is ink, 0-9 a-f are the sixteen sprite colours.',
    time: 'holds',
    family: 'pixels',
  },
  frame: {
    form: 'frame [id]',
    gist: 'Start the next animation frame of the sprite; its rows follow.',
    time: 'instant',
    family: 'pixels',
  },
  group: {
    form: 'group <id> [at=x,y] [prop=value…]',
    gist: 'A thing made of parts. Parts say in=<id> and use coordinates measured from its at=.',
    time: 'instant',
    family: 'composition',
  },
  use: {
    form: 'use [id] <source> [at=x,y] [scale=N] [rot=N] [prop=value…]',
    gist: 'Another copy of a group, shape or sprite.',
    time: 'draws',
    family: 'composition',
  },
  flow: {
    form: 'flow [id] [right|down] [x,y WxH] [| title]',
    gist: 'A flowchart. Follow it with `node` lines; the painter places them and routes the arrows.',
    time: 'starts',
    family: 'structure',
  },
  tree: {
    form: 'tree [id] [down|right] [x,y WxH] [| title]',
    gist: 'A tree. Each `node` after the first says from=<its parent>.',
    time: 'starts',
    family: 'structure',
  },
  cycle: {
    form: 'cycle [id] [x,y WxH] [| title]',
    gist: 'A loop. Its `node` lines go round a ring, each leading to the next and the last to the first.',
    time: 'starts',
    family: 'structure',
  },
  timeline: {
    form: 'timeline [id] [x,y WxH] [| title]',
    gist: 'An axis of time. Each `node` gives its number (a year); the painter spaces them to scale.',
    time: 'starts',
    family: 'structure',
  },
  map: {
    form: 'map [id] [route] [x,y WxH] [| title]',
    gist: 'Pins on a drawing. Each `node x,y` is a labelled pin; `route` joins them in order.',
    time: 'starts',
    family: 'structure',
  },
  table: {
    form: 'table [id] [bars] [x,y WxH] [| title]',
    gist: 'A table. Follow it with one `| cell | cell` line per row; the first is the header.',
    time: 'starts',
    family: 'structure',
  },
  chart: {
    form: 'chart [id] [line|area|columns|candles|ohlc] [indexed] [log] [spark] [live] [approx] [x,y WxH] [data=<id>] [| title]',
    gist: 'A chart: an instrument with axes, a crosshair and zoom. Follow it with one `| when | value…` line per point, or name DATA from the brief.',
    time: 'starts',
    family: 'structure',
  },
  code: {
    form: 'code [id] [lang] [file=<name>] [x,y WxH] [| title]',
    gist: 'Code, taken exactly: follow it with one `| line` per line of the source, indentation kept, a bare `|` for an empty line.',
    time: 'starts',
    family: 'structure',
  },
  tune: {
    form: 'tune [id] [tempo=<bpm>] [voice=piano|strings|chip|bell] [x,y WxH] [| title]',
    gist: 'Music, in ABC notation: follow it with one `| line` per line of the score (K: M: L: Q: V:1 V:2, then the notes). It is drawn as a piano roll and played when it is whole.',
    time: 'starts',
    family: 'structure',
  },
  app: {
    form: 'app [id] [height=<n>] [x,y WxH] [| title]',
    gist: 'A live app: follow it with one `| line` per line of one HTML document (inline <style> and <script>). It runs in a locked sandbox on the stage, with no network. Taught only when the user asks for something that works.',
    time: 'starts',
    family: 'structure',
  },
  figure: {
    form: 'figure <id> [cutaway|exploded] [| title]',
    gist: 'A labelled drawing: follow it with its parts (path, poly, line, ellipse, rect, each with label="…"), route and step lines, then `end`. Taught by the FIGURE chapter in the brief.',
    time: 'starts',
    family: 'structure',
  },
  problem: {
    form: 'problem <id> answer=<a>[,<b>…] [ways=<way>[,<way>…]] [for=<who>] | <the question exactly as given, ___ for the blank>',
    gist: 'An old maths question, kept so earlier answers still play: it is an `ask` for its answer, with the question as its words. Write an `ask` instead.',
    time: 'starts',
    family: 'structure',
  },
  fill: {
    form: 'fill <problem or ask id> | <the answer>',
    gist: 'Puts an answer the person gave you (by voice, by pen or in the chat) into the blank of a maths problem or an ask. The page shows it there and checks it itself, like a typed answer. It is the only way anything gets filled in: never say you filled a blank any other way.',
    time: 'instant',
    family: 'mind',
  },
  screen: {
    form: 'screen <id> phone|tablet|desktop|browser [from=<screen>[:label]] [| name]',
    gist: 'A mock-up: a device at its true size. The parts of the screen follow, one a line (nav, heading, button, field, item, image, row, col, end…); the painter lays them out. Taught by the INTERFACE chapter in the brief; on the wire its first line is the title and each later line a row, taken as written.',
    time: 'starts',
    family: 'structure',
  },
  node: {
    form: 'node [id] [number | x,y] [ask|end|note] [from=<id>[:label]] [x=<when>] [y=<value>] [prop=value…] | <text>',
    gist: 'One part of the structure above. from= also draws the link from that node. On a chart it is a mark: x= an event, y= a level, both a point.',
    time: 'draws',
    family: 'structure',
  },
  link: {
    form: 'link <a> <b> [c…] [both|plain] [dashed] [| label]',
    gist: 'Join nodes with a routed connector, in a chain when more than two are named.',
    time: 'draws',
    family: 'structure',
  },
  button: {
    form: 'button [id] [prop=value…] | <label>',
    gist: 'A button. Pressing it is sent to you, with the value of every control on stage.',
    time: 'draws',
    family: 'control',
  },
  toggle: {
    form: 'toggle [id] [on|off] [send] | <label>',
    gist: 'A switch.',
    time: 'draws',
    family: 'control',
  },
  slider: {
    form: 'slider [id] <min> <max> [value] [step=N] [unit=…] [send] | <label>',
    gist: 'A number the user drags.',
    time: 'draws',
    family: 'control',
  },
  pick: {
    form: 'pick [id] [tabs|menu|steps] [N] [send] | <a> | <b> | <c>',
    gist: 'One of several options. N is the one chosen to begin with.',
    time: 'draws',
    family: 'control',
  },
  input: {
    form: 'input [id] [send] | <placeholder>',
    gist: 'A line the user types.',
    time: 'draws',
    family: 'control',
  },
  card: {
    form: 'card <id> [x,y WxH] [| title]',
    gist: 'A framed group, for controls and what they change. Its parts say in=<id>.',
    time: 'instant',
    family: 'control',
  },
  bind: {
    form: 'bind <control>[=<value>] [<from>..<to>] | <set, move, correct or shape line>',
    gist: 'Let a control drive a change on stage, at once, with no round trip: the change is as far along as the control is.',
    time: 'instant',
    family: 'control',
  },
  pic: {
    form: 'pic [id] from=<picture id> [x,y WxH] [prop=value…]',
    gist: 'Put a picture the user gave on stage, to draw over, point at or trace. Its id is in the brief.',
    time: 'draws',
    family: 'picture',
  },
  paint: {
    form: 'paint [id] [x,y WxH] [over=<group>] [as=<medium>] [sketch=fade|keep] [mask=…] [| what it is]',
    gist: 'Paint over what you drew: the painter re-renders your sketch in a medium.',
    time: 'starts',
    family: 'picture',
  },
  ambient: {
    form: 'ambient [id] <kind> [amount] [ink=…] [layer=…]',
    gist: 'Atmosphere for the scene: weather, light, particles. `ambient none` clears it.',
    time: 'starts',
    family: 'atmosphere',
  },
  set: {
    form: 'set <id|scene|all> [style…] [prop=value…] [speed] [over=Ns] [| <new text>]',
    gist: 'Change something on stage: colour, size, place, turn, opacity, layer, pin, its words; a structure or chart with its own line again and a new room.',
    time: 'starts',
    family: 'change',
  },
  move: {
    form: 'move <id> <x,y|anchor> [speed] [over=Ns] [along=<path id>]',
    gist: 'Travel to a place, straight or along a drawn path.',
    time: 'starts',
    family: 'change',
  },
  drop: {
    form: 'drop <id|scene|all> [exit=…]',
    gist: 'Make something leave now.',
    time: 'starts',
    family: 'change',
  },
  hit: {
    form: 'hit <id> [gesture]',
    gist: 'Point back at something with one gesture.',
    time: 'holds',
    family: 'change',
  },
  cam: {
    form: 'cam <move> [id|direction] [speed] [over=Ns] [amount=0..1]',
    gist: 'Move the camera. It runs underneath the lines that follow.',
    time: 'starts',
    family: 'camera',
  },
  wait: {
    form: 'wait [N | Ns]',
    gist: 'Silence. N beats (default 1), or exact seconds with an s.',
    time: 'holds',
    family: 'time',
  },
  revise: {
    form: 'revise <id> [style…] [prop=value…] [| <new text>]',
    gist: 'Quietly change a line that has not played yet. Read, never taught: `set` does it now.',
    time: 'edit',
    family: 'mind',
  },
  deck: {
    form: 'deck | <title>',
    gist: 'Make this answer a deck: each scene after it is a slide, and the viewer steps through them.',
    time: 'opens',
    family: 'plan',
  },
  standing: {
    form: 'standing | <their words>  or  standing drop <n>',
    gist: 'Hold what the user asked for from now on ("add a visual to every reply"), in their words; every later brief gives it back.',
    time: 'instant',
    family: 'mind',
  },
  refine: {
    form: 'refine [passes]',
    gist: 'Keep making the picture better, pass by pass, because the user asked for iteration.',
    time: 'instant',
    family: 'mind',
  },
  cancel: {
    form: 'cancel [id]',
    gist: 'Throw away what has not played yet: one line, or everything ahead of the playhead.',
    time: 'edit',
    family: 'mind',
  },
} as const satisfies Record<string, { form: string; gist: string; time: VerbTime; family: VerbFamily }>;
export type Verb = keyof typeof VERB;
export const VERBS = keysOf(VERB);

export const SHAPE_VERBS = ['circle', 'ellipse', 'rect', 'line', 'poly', 'path'] as const satisfies readonly Verb[];
export type ShapeVerb = (typeof SHAPE_VERBS)[number];

/** The verbs that open a structure. The verb is the structure's kind. */
export const STRUCTURE_VERBS = STRUCTURE_KINDS satisfies readonly (Verb | 'math')[];
/** `math` is a structure on the stage but its own line (`MathLine`), not a `StructureLine`. */
export type StructureVerb = Exclude<StructureKind, 'math'>;

/** The verbs that put a control on stage. The verb is the control's kind. */
export const CONTROL_VERBS = CONTROL_KINDS satisfies readonly Verb[];
export type ControlVerb = ControlKind;

/** What an element is. Everything on stage has an id, a layer, a lifetime and a style, whatever its kind. */
export const ELEMENT_KIND = {
  text: 'words',
  shape: 'one drawn shape',
  sprite: 'pixel art',
  group: 'a thing made of parts',
  copy: 'another copy of something',
  picture: 'a painting, or the sketch waiting for one',
  field: 'atmosphere',
  structure: 'a diagram the painter lays out: a flow, a tree, a cycle, a timeline, a map, a table or a chart',
  node: 'one part of a structure',
  link: 'a connector between two nodes',
  control: 'an interactive part: a button, a toggle, a slider, a pick or an input',
} as const;
export type ElementKind = keyof typeof ELEMENT_KIND;
export const ELEMENT_KINDS = keysOf(ELEMENT_KIND);

export type PropLevel =
  /** says what something means; the painter works out the rest */
  | 'mind'
  /** an exact value that overrides the painter */
  | 'hand';

/** Which kinds of element a property means something on. */
export type PropScope = 'any' | 'text' | 'drawn';

export interface PropSpec {
  readonly values: readonly string[] | null;
  readonly also: string | null;
  readonly gist: string;
  readonly level: PropLevel;
  readonly scope: PropScope;
}

export const STYLE_PROP = {
  size: { values: SIZES, also: null, gist: 'how loud', level: 'mind', scope: 'text' },
  ink: { values: INK_ROLES, also: 'a colour name | #hex', gist: 'text colour', level: 'mind', scope: 'text' },
  weight: { values: WEIGHTS, also: null, gist: 'heaviness', level: 'mind', scope: 'text' },
  face: { values: FACES, also: null, gist: "typeface, when the look's own is not what you mean", level: 'mind', scope: 'text' },
  case: { values: LETTERCASES, also: null, gist: 'letter case', level: 'mind', scope: 'text' },
  mark: { values: MARKS, also: null, gist: 'a drawn mark on the text', level: 'mind', scope: 'text' },
  by: { values: BYS, also: null, gist: 'the unit of text that arrives', level: 'mind', scope: 'text' },
  fill: { values: ['none', ...INK_ROLES], also: 'a colour name | #hex | top>bottom for a gradient', gist: 'what a shape is filled with', level: 'mind', scope: 'drawn' },
  stroke: { values: ['none', ...INK_ROLES], also: 'a colour name | #hex', gist: 'outline colour', level: 'mind', scope: 'drawn' },
  thick: { values: null, also: 'N', gist: 'outline thickness in canvas units', level: 'mind', scope: 'drawn' },
  brush: { values: STROKES, also: null, gist: "the character of this one line, when the look's own is not what you mean", level: 'mind', scope: 'drawn' },
  tex: { values: TEXTURES, also: null, gist: 'what the fill is made of', level: 'mind', scope: 'drawn' },
  soft: { values: null, also: 'N', gist: 'how far its edge fades out, in canvas units: light, cloud, shadow', level: 'mind', scope: 'drawn' },
  enter: { values: ENTER_EFFECTS, also: null, gist: 'how it arrives', level: 'mind', scope: 'any' },
  exit: { values: EXIT_EFFECTS, also: null, gist: 'how it leaves', level: 'mind', scope: 'any' },
  loop: { values: LOOPS, also: null, gist: 'what it keeps doing', level: 'mind', scope: 'any' },
  stay: { values: STAY_WORDS, also: 'Ns', gist: 'how long it lives', level: 'mind', scope: 'any' },
  layer: { values: LAYERS, also: null, gist: 'which plane in depth', level: 'mind', scope: 'any' },
  at: { values: ANCHORS, also: 'x,y in canvas units', gist: 'where its centre goes', level: 'mind', scope: 'any' },
  near: { values: null, also: '<id> or <id>:above|below|left|right', gist: 'beside another element: a label on a drawing', level: 'mind', scope: 'any' },
  leader: { values: ['yes', 'no'], also: null, gist: 'yes draws a line from the label to what it names; the painter finds clear room for the label', level: 'mind', scope: 'text' },
  in: { values: null, also: '<group id>', gist: 'make it a part of a group', level: 'mind', scope: 'any' },
  bleed: { values: BLEEDS, also: null, gist: 'whether a filled shape touching the canvas edge runs on to the screen edge', level: 'mind', scope: 'drawn' },
  scale: { values: null, also: 'N', gist: 'size multiplier (a sprite: canvas units per pixel)', level: 'mind', scope: 'drawn' },
  rot: { values: null, also: 'N degrees', gist: 'turned clockwise', level: 'mind', scope: 'any' },
  opacity: { values: null, also: '0..1', gist: 'how solid', level: 'mind', scope: 'any' },
  align: { values: ['left', 'center', 'right'], also: null, gist: 'with at=x,y: which edge of the words that point is (right for digits lined up in a column)', level: 'mind', scope: 'text' },
  tap: { values: ['yes', 'no'], also: null, gist: 'yes makes it a choice the user can tap', level: 'mind', scope: 'any' },
  dur: { values: null, also: 'Ns', gist: 'exact entrance length', level: 'hand', scope: 'any' },
  period: { values: null, also: 'N', gist: 'with loop=, around= or along=: one cycle in clock units (seconds until a slider is the clock); negative runs backwards, any size, kept exactly', level: 'hand', scope: 'any' },
  around: { values: null, also: '<id> or x,y', gist: 'the point it turns about (spin, sway or rot=): another element\'s centre, which carries it, or a fixed point; both top-level or in the same group', level: 'hand', scope: 'any' },
  phase: { values: null, also: '0..1', gist: 'how far into its cycle it is when the clock reads zero', level: 'hand', scope: 'any' },
  amp: { values: null, also: 'N', gist: 'how far a loop goes: degrees for sway, canvas units for bob, a share for pulse and breathe', level: 'hand', scope: 'any' },
  along: { values: null, also: '<shape id> | none', gist: 'with period=: rides that outline for ever, upright (round a closed one, there and back on an open one); none stops it', level: 'hand', scope: 'any' },
} as const satisfies Record<string, PropSpec>;
export type StylePropName = keyof typeof STYLE_PROP;
export const STYLE_PROP_NAMES = keysOf(STYLE_PROP);

export const TIME_FORM = {
  '@with': 'start together with the previous line',
  '@+N': 'start N seconds after the pen (a delay)',
  '@-N': 'start N seconds before the pen (overlap the previous line)',
  '@N': 'start at exactly N seconds on the turn clock (at most 10 s past the pen; use @+N for a delay)',
} as const;

export const RESERVED_IDS = ['all', 'scene', '-', 'none', 'full'] as const;

export const LIMITS = {
  /** characters in one raw line */
  line: 1200,
  /** characters in one raw `say` line; longer text is split into lines, never cut */
  speechLine: 12000,
  /** characters of text in one element */
  text: 320,
  /** characters in an id or a style name */
  name: 24,
  /** seconds; the longest single wait or delay */
  wait: 10,
  /** seconds; the longest entrance */
  enter: 4,
  /** text elements alive on stage at once before the oldest are retired */
  elements: 48,
  /** drawn elements (shapes, sprites, copies, pictures, fields) alive at once before the oldest are retired */
  figures: 240,
  /** points in one line, poly or flattened path */
  points: 400,
  /** cells along either side of a sprite */
  sprite: 64,
  /** animation frames in one sprite */
  frames: 8,
  /** characters in a painting's description */
  prompt: 400,
  /** nodes in one structure */
  nodes: 40,
  /** links in one structure */
  links: 80,
  /** rows in one table */
  rows: 24,
  /** points in one chart written out as rows; more than this is data, and comes by reference (`data=`) */
  chartPoints: 400,
  /** marks on one chart */
  marks: 24,
  /** cells in one row of a table or chart */
  cells: 8,
  /** lines in one `code` block; more is scrolled, not cut, up to this */
  codeRows: 400,
  /** lines in one `tune` block */
  tuneRows: 160,
  /** notes in one tune; a chord is one note a pitch */
  tuneNotes: 3000,
  /** seconds of music in one tune; more is cut */
  tuneSeconds: 300,
  /** lines in one `app` block */
  appRows: 700,
  /** characters in one `app` document (the lines joined); a longer one is cut at the last whole line that fits */
  appChars: 60_000,
  /** characters in the file name of a `code` block */
  file: 48,
  /** characters in a link's address */
  href: 400,
  /** options in one pick */
  options: 12,
  /** controls alive on stage at once */
  controls: 16,
  /** bound changes alive on stage at once */
  binds: 48,
} as const;

// ---------------------------------------------------------------------------------------------------------------------------------
// v3: the document and the lesson (PLAN-v3-core 2.1, 2.6, 2.10, section 3). The words that make a tree of parts, and a part a lesson.
//
// They are a table of their own and not rows of `VERB`: the brain's fixed prompt is built by walking `VERB`, it is at its budget, and a
// lesson is taught by its own chapter on its own cues (package WS7), which builds its text from `LESSON_VERB`, `TECHNIQUE` and `VISUAL`.
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * v3 art (PLAN-art step 4). `draw`: a finished drawing of a named thing from the server's shelf. A table of its own, and not a row of `VERB`, for the
 * same reason as the lesson words: the fixed prompt is built by walking `VERB`, and `draw` is taught nowhere yet (step 7, behind `Services.art`).
 * The parser and the server accept it regardless.
 */
export const ART_VERB = {
  draw: {
    form: 'draw [id] <subject> [at=x,y] [size=N] [fill=<colour>] [as=<name>] [new] [in=<group>] [| pose, view, mood]',
    gist: 'A finished drawing of a named thing, from the shelf: a group whose parts are its own (`fox1-tail`). Centred and two fifths of the canvas high unless said.',
    time: 'instant',
    family: 'composition',
  },
} as const satisfies Record<string, { form: string; gist: string; time: VerbTime; family: VerbFamily }>;
export type ArtVerb = keyof typeof ART_VERB;

/** The words that build a document and a lesson. Their forms are what the TEACH chapter and `docs/language.md` print. */
export const LESSON_VERB = {
  part: {
    form: 'part <id> [in=<part>] [tag=<word>] [for=<ask>] [crop=x,y,w,h [from=<photo>]] | <title>',
    gist: 'A place in the document: a sheet, a section, a question, a way of doing it. `in=` is where it sits (an open `part … end` says it for you). Only a title is an outline: named now, written later. `for=<ask>` says this part helps that ask (a way, a variation, a clause explained): help the person pulls, never shown first. `tag=` is any one word naming what kind of part it is (a way of thinking, a variation, a day); with `tag=` and no `for=`, it helps the last ask of the part it sits in. `crop=` is where a question sits on the photo, in whole percents of its width and height from the top left (`crop=6,31,88,7`); `from=` names the photo when there are several.',
    time: 'instant',
    family: 'lesson',
  },
  step: {
    form: 'step [id] [in=<part>] [show=<visual> [a..b] [key=value…]] | <words>',
    gist: 'One reveal of a lesson: the words, and the picture to show with them. Steps stack into a worked page; nothing shown is taken away. Write the same id again to replace a step.',
    time: 'instant',
    family: 'lesson',
  },
  ask: {
    form: 'ask <id> [in=<part>] is=<a>[,<b>…] [pick=<x>,<y>,<z>] [unit=<unit>] [check=working|order|any|done] | <question>',
    gist: 'A try: the learner types the answer, or taps one of the large choices in `pick=`. It is checked on the page, at once; every answer you will accept is in `is=` and nowhere else. A `_` stands for a space inside a value. `check=working` is for a question she works out on paper: her ink is read into lines of working, each step is checked with real arithmetic, and she is right when every step is and it ends on an answer in `is=`. `check=order` is for putting things in order: `is=` lists the items IN THE RIGHT ORDER (the question\'s own numbers or words; no `pick=`), she drags tiles into order, and the sequence is compared exactly. `check=any` is a choice with no single right answer (`pick=` the options, no `is=`): the gate opens when she holds a value. `check=done` is a tick (no `is=`, no `pick=`): the gate opens when she ticks it. Neither is sealed or checked.',
    time: 'instant',
    family: 'lesson',
  },
  hint: {
    form: 'hint [in=<ask>] | <words>',
    gist: 'What to say after a wrong try, one per wrong try, in the order written. A hint never holds the answer.',
    time: 'instant',
    family: 'lesson',
  },
  reply: {
    form: 'reply | <words>',
    gist: 'The answer as one sentence for the conversation thread. It is never drawn on a stage.',
    time: 'instant',
    family: 'lesson',
  },
  end: {
    form: 'end',
    gist: 'Closes the part last opened without an `in=`; the parts written after it sit beside it, not inside it.',
    time: 'instant',
    family: 'lesson',
  },
} as const satisfies Record<string, { form: string; gist: string; time: VerbTime; family: 'lesson' }>;
export type LessonVerb = keyof typeof LESSON_VERB;
export const LESSON_VERBS = keysOf(LESSON_VERB);

/** The ways of going at a primary-maths question: what the maths card teaches and the lesson page has names and glyphs for. Content, not structure: a `tag=` is any word, and what is help is what says `for=`. */
export const TECHNIQUE = {
  'draw-it': 'make a picture of it and count what is there',
  'share-it-out': 'deal it into equal groups, or the same amount to each',
  'count-on-a-line': 'hop along a number line, forward or back',
  'make-ten': 'build to a ten first, then add what is left',
  'break-it-apart': 'split a number into easier pieces (tens and ones, doubles, halves)',
  'find-the-pattern': 'look for what repeats or changes by the same amount',
  'read-the-question': 'say what is really being asked before doing any sums',
  'work-backwards': 'start from the end and undo each step',
} as const;
export type TechniqueId = keyof typeof TECHNIQUE;
export const TECHNIQUES = keysOf(TECHNIQUE);

/** What a value of a visual's parameter looks like. */
export type VisualParam = 'number' | 'numbers' | 'word' | 'time' | 'cells';

/**
 * The pictures a step may `show=`: the lesson view's own widgets (WS6), each worked by hand. The first words after `show=<visual>` may be a
 * span (`0..70`) when the visual has `range`; every other parameter is `key=value`. A value of `numbers` is a comma list in which `?` is a
 * gap the learner fills; a `word` may use `_` for a space.
 */
export const VISUAL = {
  numberline: { gist: 'a number line: a span, a place marked, hops along it', range: true, keys: { mark: 'number', hops: 'numbers', step: 'number' } },
  groups: { gist: 'groups of counters to tap and count: how many groups, how many in each, how each splits', range: false, keys: { count: 'number', each: 'number', parts: 'numbers', label: 'word' } },
  blocks: { gist: 'ten-rods and unit cubes: a number built, or taken away from', range: false, keys: { tens: 'number', ones: 'number', take: 'number' } },
  bar: { gist: 'a bar model: a whole and its parts, one of them a gap', range: false, keys: { total: 'number', parts: 'numbers' } },
  coins: { gist: 'coins to count and add up', range: false, keys: { coins: 'numbers', target: 'number' } },
  clock: { gist: 'a clock face to read or to set', range: false, keys: { time: 'time', mode: 'word' } },
  grid: { gist: 'a shape on squares she ticks: cells= rows joined by /, x whole, h half, o empty', range: false, keys: { cells: 'cells' } },
  ruler: { gist: 'a ruler she slides along straight roads between places to read their lengths; `mm=` is each road in millimetres, never shown as numbers', range: false, keys: { mm: 'numbers' } },
} as const satisfies Record<string, { gist: string; range: boolean; keys: Readonly<Record<string, VisualParam>> }>;
export type VisualKind = keyof typeof VISUAL;
export const VISUAL_KINDS = keysOf(VISUAL);

/** The limits of a lesson. */
export const LESSON_LIMITS = {
  /** parts in one document */
  parts: 400,
  /** levels of parts, the root's children being the first */
  depth: 6,
  /** steps and asks in one part */
  steps: 40,
  /** answers one `ask` accepts */
  accepted: 12,
  /** choices on one `ask` */
  pick: 6,
  /** hints on one `ask` */
  hints: 6,
  /** characters in one accepted answer or choice */
  answer: 40,
  /** characters in a visual's parameter value */
  value: 120,
  /** numbers in a `numbers` value */
  numbers: 24,
} as const;

// ---------------------------------------------------------------------------------------------------------------------------------
// v3 maths (PLAN-maths M0). `math`: a written method laid out as on paper. A table of its own and not a row of `VERB`, for the same reason as
// `draw`: the fixed prompt is built by walking `VERB` and is at its budget. It is taught nowhere yet (M5); the parser and the server accept it.
// ---------------------------------------------------------------------------------------------------------------------------------

/** The written methods (the digit algorithms) and the pictures (`bar`, `groups`, `array`, `line`). */
export const MATH_METHODS = ['column', 'times', 'split', 'bond', 'bar', 'groups', 'array', 'line'] as const;
export type MathMethod = (typeof MATH_METHODS)[number];
/** The methods the painter lays out digit by digit; the rest are pictures. */
export const MATH_WRITTEN = ['column', 'times', 'split', 'bond'] as const satisfies readonly MathMethod[];
/** What is left empty for the learner: the answer cells (the default), or every cell the method asks to be written. */
export const MATH_BLANKS = ['answer', 'all'] as const;
export type MathBlank = (typeof MATH_BLANKS)[number];
/** Carries: the learner writes them, they are drawn (small, above the column), or there are none. */
export const MATH_CARRIES = ['write', 'shown', 'none'] as const;
export type MathCarry = (typeof MATH_CARRIES)[number];
/** The place names a part can be named by. */
export const MATH_PLACES = ['ones', 'tens', 'hundreds', 'thousands', 'tenthousands', 'tenths', 'hundredths', 'thousandths'] as const;
export type MathPlace = (typeof MATH_PLACES)[number];
export const MATH_LIMITS = {
  /** rows in a column sum */
  rows: 8,
  /** digits in one number */
  digits: 9,
} as const;

export const MATH_VERB = {
  math: {
    form: 'math <id> column|times|split|bond|bar|groups|array|line [worked] [blank=answer|all] [carry=write|shown|none] [steps | step=<n|control>] | <sum>',
    gist: 'A written method laid out as on paper, in place-value columns. The painter computes every digit; you write none. The answer is sealed like an ask\'s `is=`: the default shows the method (the givens, the signs, the rule and empty cells) and never the answer. `worked` writes everything, for teaching on a different sum. `steps` adds a stepper, `step=<id>` follows a `pick`. Its parts are named `<id>.<part>`: `m1.r3` (a row), `m1.tens`, `m1.carry-tens`, `m1.ans-ones`, `m1.rule`, `m1.s2` (a step).',
    time: 'holds',
    family: 'structure',
  },
} as const satisfies Record<string, { form: string; gist: string; time: VerbTime; family: VerbFamily }>;
export type MathVerb = keyof typeof MATH_VERB;
