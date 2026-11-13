// The single definition of every word in Series. Types, the parser, the
// reference tables in docs/language.md and the brain's system prompt are all
// derived from the tables in this file. Each gloss says what a word MEANS,
// because the gloss is what the brain reads when it chooses. Glosses are kept
// short on purpose: every one of them is paid for in the brain's prompt.

export const LANGUAGE = { name: 'Series', version: 3 } as const;

function keysOf<T extends Record<string, unknown>>(table: T): readonly (keyof T & string)[] {
  return Object.keys(table) as (keyof T & string)[];
}

export const LAYER = {
  far: 'the deep background: sky, horizon, weather. Moves least under the camera. Never holds the pen.',
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
  paper: { gist: 'paper fibre; ink soaks in instead of glowing', taught: true },
  grain: { gist: 'fine film grain over everything', taught: true },
  glow: { gist: 'bright things bleed light', taught: true },
  vignette: { gist: 'darker toward the edges', taught: true },
  halftone: { gist: 'printed dots instead of flat tone', taught: true },
  misprint: { gist: 'two inks slightly out of register', taught: true },
  pixelate: { gist: 'everything in chunky square pixels', taught: true },
  dither: { gist: 'few colours, shading by dot pattern', taught: true },
  scanlines: { gist: 'the raster of an old tube', taught: true },
  grid: { gist: 'faint drafting-paper squares', taught: true },
  dust: { gist: 'chalk dust and smears on a board', taught: true },
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
    gist: 'Ink on warm paper. Quiet, bright, good for drawing and for reading. The default.',
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
    gist: 'A blackboard. Explaining, working something out by hand.',
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
    gist: 'White line on drafting blue. Mechanisms, plans, how a thing is built.',
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
    gist: 'A two-colour print: flat shapes, halftone dots, a little out of register. Bold, playful.',
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
    gist: 'An amber terminal, 1987. One colour at three intensities; text is typed in. Nocturnal, thinking aloud.',
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
    gist: 'Broadcast teletext, 1981. Eight hard colours on black, chunky pixels. Public, declarative, a little playful.',
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
    gist: 'Flat mid-grey, hard edges, whole-number scale. For pixel art: no sprite colour vanishes.',
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
    gist: 'A dot-matrix printout on green-bar paper, 1980. Whatever is said here is on the record.',
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
} as const satisfies Record<string, LookSpecLanguage>;
/** The id of a preset. A look the brain defines has a name of its own and stands on one of these. */
export type LookId = keyof typeof LOOK;
export const LOOK_IDS = keysOf(LOOK);
export const DEFAULT_LOOK: LookId = 'paper';
/** The presets pinned to one old machine. They are offered, never assumed. */
export const RETRO_LOOKS: readonly LookId[] = ['phosphor', 'teletext', 'printout'];

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

export type VerbFamily = 'plan' | 'words' | 'text' | 'drawing' | 'pixels' | 'composition' | 'picture' | 'atmosphere' | 'change' | 'camera' | 'time' | 'mind';

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
  paint: {
    form: 'paint [id] [x,y WxH] [over=<group>] [as=<medium>] [sketch=fade|keep] [mask=…] | <what to paint>',
    gist: 'Ask for a painting. The sketch you drew shows until it arrives, and if it never does.',
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
    form: 'set <id|scene|all> [style…] [prop=value…] [speed] [over=Ns]',
    gist: 'Change something on stage: colour, size, place, turn, opacity, layer, pin.',
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
    gist: 'Quietly change a line that has not played yet.',
    time: 'edit',
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

/** What an element is. Everything on stage has an id, a layer, a lifetime and a style, whatever its kind. */
export const ELEMENT_KIND = {
  text: 'words',
  shape: 'one drawn shape',
  sprite: 'pixel art',
  group: 'a thing made of parts',
  copy: 'another copy of something',
  picture: 'a painting, or the sketch waiting for one',
  field: 'atmosphere',
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
  enter: { values: ENTER_EFFECTS, also: null, gist: 'how it arrives', level: 'mind', scope: 'any' },
  exit: { values: EXIT_EFFECTS, also: null, gist: 'how it leaves', level: 'mind', scope: 'any' },
  loop: { values: LOOPS, also: null, gist: 'what it keeps doing', level: 'mind', scope: 'any' },
  stay: { values: STAY_WORDS, also: 'Ns', gist: 'how long it lives', level: 'mind', scope: 'any' },
  layer: { values: LAYERS, also: null, gist: 'which plane in depth', level: 'mind', scope: 'any' },
  at: { values: ANCHORS, also: 'x,y in canvas units', gist: 'where its centre goes', level: 'mind', scope: 'any' },
  near: { values: null, also: '<id> or <id>:above|below|left|right', gist: 'beside another element: a label on a drawing', level: 'mind', scope: 'any' },
  in: { values: null, also: '<group id>', gist: 'make it a part of a group', level: 'mind', scope: 'any' },
  bleed: { values: BLEEDS, also: null, gist: 'whether a filled shape touching the canvas edge runs on to the screen edge', level: 'mind', scope: 'drawn' },
  scale: { values: null, also: 'N', gist: 'size multiplier (a sprite: canvas units per pixel)', level: 'mind', scope: 'drawn' },
  rot: { values: null, also: 'N degrees', gist: 'turned clockwise', level: 'mind', scope: 'any' },
  opacity: { values: null, also: '0..1', gist: 'how solid', level: 'mind', scope: 'any' },
  tap: { values: ['yes', 'no'], also: null, gist: 'yes makes it a choice the user can tap', level: 'mind', scope: 'any' },
  dur: { values: null, also: 'Ns', gist: 'exact entrance length', level: 'hand', scope: 'any' },
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
} as const;
