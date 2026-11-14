// The interface tree (PLAN-v2.2 E13): what a mock-up IS, as data, and the reader of the lines that say it.
//
// A mock-up is described, not drawn. The brain says what is on each screen, in order, and never where. This file is the
// words: the devices at their true proportions, the container and the part words, the spacing scale, the tokens a look
// must fill in, and `parseInterface`, which turns the brain's lines into a tree. The painter's kit (web/src/painter/blocks/ui)
// lays the tree out and draws it.
//
// Pure: no DOM, no clock, no fonts. The bench calls `parseInterface` now; the line parser calls it later, when the hooks in
// section 9 land (`screen`, `row`, `col`, `end` and the parts are read only inside a screen).
//
// Forgiving, as the line parser is: a part it does not know is read as `text` and named in `notes`; an `end` with nothing
// open and a container left open are named and mended; nothing throws.

// ------------------------------------------------------------------ devices

export const UI_DEVICES = ['phone', 'tablet', 'desktop', 'browser'] as const;
export type UiDevice = (typeof UI_DEVICES)[number];

/** The inside of each device in points (a phone is 390 across): the unit designers use. A browser's chrome is drawn outside this. */
export const UI_DEVICE_SIZE: Readonly<Record<UiDevice, { readonly width: number; readonly height: number }>> = {
  phone: { width: 390, height: 844 },
  tablet: { width: 820, height: 1180 },
  desktop: { width: 1280, height: 800 },
  browser: { width: 1280, height: 720 },
};

export const UI_LOOKS = ['wireframe', 'studio'] as const;
export type UiLookId = (typeof UI_LOOKS)[number];

// ------------------------------------------------------------------ the style of a mock-up

/**
 * What the brain sets on a `screen` line to make a mock-up read as the kind of app it is: `theme=dark|light accent=<colour name or hex> radius=sharp|soft|round
 * type=geometric|humanist|serif density=compact|comfortable`. The kit derives the whole token set from these (the grounds, the inks, the lines, the accent and
 * what is written on it, all at a contrast of at least 4.5); the brain never writes a colour for a part. A screen that says none of them takes the one before it,
 * so one screen line of a journey can set them all.
 */
export const UI_THEMES = ['dark', 'light'] as const;
export const UI_RADII = ['sharp', 'soft', 'round'] as const;
export const UI_TYPES = ['geometric', 'humanist', 'serif'] as const;
export const UI_DENSITIES = ['compact', 'comfortable'] as const;

export interface UiStyle {
  readonly theme?: (typeof UI_THEMES)[number];
  /** a colour name or `#rrggbb`, as written; the kit reads it (`web/src/painter/blocks/ui/theme.ts`) */
  readonly accent?: string;
  readonly radius?: (typeof UI_RADII)[number];
  readonly type?: (typeof UI_TYPES)[number];
  readonly density?: (typeof UI_DENSITIES)[number];
}

export const UI_STYLE_KEYS = ['theme', 'accent', 'radius', 'type', 'density'] as const;

function pickWord<T extends string>(value: string | undefined, allowed: readonly T[], key: string, notes: UiNote[], line: number): T | undefined {
  if (value === undefined) return undefined;
  const v = value.toLowerCase();
  if ((allowed as readonly string[]).includes(v)) return v as T;
  notes.push({ line, message: `${key}=${value}: use ${allowed.join(', ')}; ignored` });
  return undefined;
}

/** The words of a `screen` line that set the style. A colour that is neither a hex nor a name the kit knows is kept as written (the kit names it and falls back). */
function styleOf(attrs: Readonly<Record<string, string>>, notes: UiNote[], line: number): UiStyle {
  const accent = attrs['accent'];
  const theme = pickWord(attrs['theme'], UI_THEMES, 'theme', notes, line);
  const radius = pickWord(attrs['radius'], UI_RADII, 'radius', notes, line);
  const type = pickWord(attrs['type'], UI_TYPES, 'type', notes, line);
  const density = pickWord(attrs['density'], UI_DENSITIES, 'density', notes, line);
  return { ...(theme === undefined ? {} : { theme }), ...(accent === undefined || accent === '' ? {} : { accent }), ...(radius === undefined ? {} : { radius }), ...(type === undefined ? {} : { type }), ...(density === undefined ? {} : { density }) };
}

// ------------------------------------------------------------------ the words

/** The spacing scale, on a four-point grid. `gap=` and `pad=` take these words or a number of points. */
export const UI_SPACE = { none: 0, xs: 4, s: 8, m: 16, l: 24, xl: 32, xxl: 48 } as const;
export type UiSpaceWord = keyof typeof UI_SPACE;

/** The parts of a screen, one a line. `pick`, `toggle`, `slider` and `input` are the controls the language already has: the kit's live parts. */
export const UI_PART_KINDS = [
  'nav',
  'tabbar',
  'heading',
  'text',
  'note',
  'button',
  'field',
  'item',
  'badge',
  'price',
  'progress',
  'image',
  'icon',
  'divider',
  'space',
  'pick',
  'toggle',
  'slider',
  'input',
  'chart',
  // the richer parts: each holds its own words, so that a screen of an app is a few lines (see the chapter)
  'media',
  'carousel',
  'player',
  'chat',
  'map',
  'stat',
  'people',
  'segment',
] as const;
export type UiPartKind = (typeof UI_PART_KINDS)[number];

export const UI_CONTAINER_KINDS = ['row', 'col'] as const;
export type UiContainerKind = (typeof UI_CONTAINER_KINDS)[number];

/** The first words this file reads. `end` closes the nearest row or col. */
export const UI_WORDS: readonly string[] = ['screen', 'end', ...UI_CONTAINER_KINDS, ...UI_PART_KINDS];

/** Variant words each part knows. Any other bare word on a part is named in `notes`. */
export const UI_VARIANTS: Readonly<Record<UiPartKind, readonly string[]>> = {
  nav: ['back', 'close', 'menu'],
  tabbar: [],
  heading: ['display', 'large', 'small', 'center'],
  text: ['dim', 'small', 'large', 'bold', 'center'],
  note: ['center'],
  button: ['primary', 'ghost', 'danger', 'small', 'wide', 'disabled', 'send'],
  field: ['error', 'multi', 'password'],
  item: ['chevron', 'toggle', 'on', 'selected'],
  badge: ['success', 'danger'],
  price: [],
  progress: [],
  image: ['wide', 'square', 'tall', 'round'],
  icon: ['small', 'large', 'xl', 'dim', 'accent', 'success'],
  divider: [],
  space: ['s', 'm', 'l', 'xl', 'grow'],
  pick: [],
  toggle: ['on'],
  slider: [],
  input: ['error', 'password'],
  chart: ['wide', 'square'],
  media: ['round', 'wide'],
  carousel: ['round', 'wide', 'square'],
  player: ['large', 'playing'],
  chat: [],
  map: ['tall', 'route'],
  stat: ['up', 'down'],
  people: ['chevron'],
  segment: ['tabs', 'chips'],
};

// ------------------------------------------------------------------ the tree

export interface UiBoxProps {
  /** points between children; null: the kit's own for this container */
  readonly gap: number | null;
  /** points inside the edge; null: none */
  readonly pad: number | null;
  readonly align: 'start' | 'center' | 'end' | null;
  /** first and last pushed apart */
  readonly spread: boolean;
  /** takes the room that is left */
  readonly grow: boolean;
  readonly wrap: boolean;
  /** a surface with an edge */
  readonly card: boolean;
  /** a shadow under it */
  readonly lift: boolean;
  /** widest it goes, points; it then stands in the middle of the room if `center` */
  readonly max: number | null;
  readonly center: boolean;
}

export interface UiContainer {
  readonly kind: UiContainerKind;
  readonly id: string;
  /** the line of the brain's text it came from, from 0 */
  readonly line: number;
  readonly props: UiBoxProps;
  readonly children: readonly UiNode[];
}

export interface UiPartNode {
  readonly kind: UiPartKind;
  readonly id: string;
  readonly line: number;
  /** the bare words before the first `|`: `primary`, `wide`, `chevron` */
  readonly flags: readonly string[];
  /** `key=value` before the first `|`: `icon=shield`, `action=user`, `icons=a,b,c` */
  readonly attrs: Readonly<Record<string, string>>;
  /** what follows each `|`, trimmed: the words of the part */
  readonly fields: readonly string[];
}

export type UiNode = UiContainer | UiPartNode;

export interface UiScreen {
  readonly id: string;
  readonly device: UiDevice;
  /** the screen this one is reached from: draws the arrow of a journey */
  readonly from: string | null;
  /** what is written on that arrow */
  readonly fromLabel: string | null;
  readonly name: string;
  readonly line: number;
  /** the theme words of its `screen` line, or the screen before it's when it says none */
  readonly style: UiStyle;
  readonly children: readonly UiNode[];
}

export interface UiNote {
  readonly line: number;
  readonly message: string;
}

export interface UiDocument {
  /** `look wireframe|studio` when the lines said it */
  readonly look: UiLookId | null;
  /** `scene board` was written */
  readonly board: boolean;
  readonly screens: readonly UiScreen[];
  /** the lines that are not the interface's (`say`, `set`, ...), kept in order with the line they were */
  readonly others: readonly { readonly line: number; readonly text: string }[];
  readonly notes: readonly UiNote[];
}

export function isUiPartNode(node: UiNode): node is UiPartNode {
  return node.kind !== 'row' && node.kind !== 'col';
}

export function isUiContainer(node: UiNode): node is UiContainer {
  return node.kind === 'row' || node.kind === 'col';
}

// ------------------------------------------------------------------ tokens

/** The type scale: role -> size, line height (both multiples of four, so a line is always on the grid) and weight. */
export const UI_TEXT_ROLES = ['caption', 'note', 'body', 'label', 'title', 'heading', 'display', 'hero', 'price'] as const;
export type UiTextRole = (typeof UI_TEXT_ROLES)[number];

export interface UiTextToken {
  readonly size: number;
  readonly line: number;
  readonly weight: 'normal' | 'bold';
  /** the face it is set in; absent: the sans */
  readonly face?: 'sans' | 'serif' | 'display';
}

export interface UiElevation {
  /** points below the surface */
  readonly dy: number;
  /** how far the shadow fades, points */
  readonly blur: number;
  /** 0..1 */
  readonly alpha: number;
}

/**
 * What a look gives the kit. Two looks fill it in (`web/src/looks/wireframe.ts`, `studio.ts`); the same lines serve both, so
 * `look studio` after a wireframe is the wireframe becoming the design. Colours are `#rrggbb`.
 */
export interface UiTokens {
  readonly id: UiLookId;
  /** boxes and lines: surfaces are bare, a control is an outline, a picture is a crossed box */
  readonly wire: boolean;
  /**
   * The smallest type the screens may be set in, points. A board drawn small (several phones in a room that is not tall) sets it so that the smallest
   * type still reads when it is scaled to the room: every role below it, and every hard-set size, is taken up to it. Absent: the scale as it is.
   */
  readonly minText?: number;
  /** `density=` of the screen's style: parts set closer (compact) or roomier (comfortable) than the look's own measure; absent: the look's own */
  readonly pack?: 'compact' | 'comfortable';
  readonly radius: { readonly s: number; readonly m: number; readonly l: number; readonly device: number };
  readonly type: Readonly<Record<UiTextRole, UiTextToken>>;
  readonly elevation: { readonly none: UiElevation; readonly low: UiElevation; readonly high: UiElevation };
  readonly colour: {
    /** what the screens stand on */
    readonly ground: string;
    /** the device's body and its edge */
    readonly bezel: string;
    readonly bezelEdge: string;
    /** a screen's own ground */
    readonly screen: string;
    /** a card, a field, a list row */
    readonly surface: string;
    /** a quieter surface: the track of a pick, a picture's tint, a disabled thing */
    readonly sunken: string;
    readonly ink: string;
    readonly dim: string;
    /** a placeholder, a hint */
    readonly faint: string;
    /** a hairline */
    readonly line: string;
    /** the edge of a field and of a card */
    readonly edge: string;
    readonly accent: string;
    /** the accent as words and lines on the grounds (a tab, a ghost button, an icon): the accent itself, moved until it reads at 4.5 */
    readonly accentInk: string;
    /** what is written on an accent surface */
    readonly onAccent: string;
    /** the tint an accent is washed to behind its own words */
    readonly accentWash: string;
    readonly success: string;
    readonly danger: string;
    readonly shadow: string;
  };
}

// ------------------------------------------------------------------ reading

const SPACE_WORDS: Readonly<Record<string, number>> = UI_SPACE;

/** `gap=` and `pad=`: a word of the scale or a number of points, held to the grid. null when it is neither. */
export function spaceOf(value: string | undefined): number | null {
  if (value === undefined) return null;
  const word = SPACE_WORDS[value];
  if (word !== undefined) return word;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 200 ? n : null;
}

interface Words {
  readonly flags: string[];
  readonly attrs: Record<string, string>;
}

/** `primary wide icon=shield label="two words"` -> flags and attributes. */
function words(head: string): Words {
  const flags: string[] = [];
  const attrs: Record<string, string> = {};
  const token = /([A-Za-z][\w-]*)=("[^"]*"|\S*)|\S+/g;
  for (let m = token.exec(head); m !== null; m = token.exec(head)) {
    if (m[1] !== undefined) attrs[m[1].toLowerCase()] = (m[2] ?? '').replace(/^"|"$/g, '');
    else flags.push(m[0].toLowerCase());
  }
  return { flags, attrs };
}

/** `a | b | c` after the head. Words themselves never contain a bar. */
function fieldsOf(rest: string | null): string[] {
  if (rest === null) return [];
  return rest.split('|').map((field) => field.trim());
}

function boxProps(w: Words, notes: UiNote[], line: number): UiBoxProps {
  const read = (key: string): number | null => {
    const v = w.attrs[key];
    if (v === undefined) return null;
    const n = spaceOf(v);
    if (n === null) notes.push({ line, message: `${key}=${v}: use none, xs, s, m, l, xl or a number of points` });
    return n;
  };
  const align = w.attrs['align'];
  const max = w.attrs['max'] === undefined ? null : Number(w.attrs['max']);
  return {
    gap: read('gap'),
    pad: read('pad'),
    align: align === 'start' || align === 'center' || align === 'end' ? align : null,
    spread: w.flags.includes('spread'),
    grow: w.flags.includes('grow'),
    wrap: w.flags.includes('wrap'),
    card: w.flags.includes('card'),
    lift: w.flags.includes('lift'),
    max: max !== null && Number.isFinite(max) && max > 0 ? max : null,
    center: w.flags.includes('center'),
  };
}

const KNOWN_OTHERS = new Set(['say', 'set', 'look', 'scene', 'hit', 'drop', 'pause', 'bind', 'move', 'cam', 'beat', 'caption']);

interface MutableContainer {
  kind: UiContainerKind;
  id: string;
  line: number;
  props: UiBoxProps;
  children: UiNode[];
}

interface MutableScreen {
  id: string;
  device: UiDevice;
  from: string | null;
  fromLabel: string | null;
  name: string;
  line: number;
  style: UiStyle;
  children: UiNode[];
}

/** What one line did to the tree: the node it made (with the id of what it sits in), or that it was an `end`, or not the interface's. */
export type InterfaceRead =
  | { readonly kind: 'screen'; readonly screen: UiScreen }
  | { readonly kind: 'node'; readonly node: UiNode; readonly parent: string }
  | { readonly kind: 'end' }
  | { readonly kind: 'other' };

/**
 * Reads the brain's lines into a tree, one at a time (`read`), so that the normaliser can say what each line made as the line
 * arrives. Nesting comes from `row`, `col` and `end`; a line that carries `in=<id>` (what `interfaceLines` writes, so that each
 * line on the wire stands alone) is put into that container or screen instead of the one that is open. Lines that are not the
 * interface's are returned in `others`.
 */
export class InterfaceReader {
  private readonly notes: UiNote[] = [];
  private readonly others: { line: number; text: string }[] = [];
  private readonly screens: MutableScreen[] = [];
  private readonly byId = new Map<string, MutableContainer | MutableScreen>();
  private look: UiLookId | null = null;
  private board = false;
  private screen: MutableScreen | null = null;
  private stack: MutableContainer[] = [];
  private readonly counts = new Map<string, number>();
  private count = 0;

  private idFor(kind: string, given: string | undefined): string {
    if (given !== undefined && given !== '' && !this.byId.has(given)) return given;
    const scope = this.screen?.id ?? 'ui';
    const key = `${scope}.${kind}`;
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    return `${key}${n}`;
  }

  private closeAll(line: number): void {
    if (this.stack.length > 0) this.notes.push({ line, message: `${this.stack.length} ${this.stack.length === 1 ? 'row or col was' : 'rows or cols were'} left open and closed here: write \`end\` for each` });
    this.stack = [];
  }

  /** What has been read so far. */
  document(): UiDocument {
    return { look: this.look, board: this.board, screens: this.screens, others: this.others, notes: this.notes };
  }

  /** Closes what is still open (a container left without its `end`) and returns the document. */
  finish(): UiDocument {
    if (this.stack.length > 0) this.closeAll(this.count);
    return this.document();
  }

  read(raw: string): InterfaceRead {
    const line = this.count;
    this.count += 1;
    const { notes, others, screens, byId } = this;
    const text = raw.trim();
    if (text === '') return { kind: 'other' };
    const bar = text.indexOf('|');
    const head = bar < 0 ? text : text.slice(0, bar).trim();
    const first = (head.split(/\s+/)[0] ?? '').toLowerCase();
    const rest = head.slice(first.length).trim();
    const fields = fieldsOf(bar < 0 ? null : text.slice(bar + 1));

    if (first === 'look') {
      const word = rest.split(/\s+/)[0]?.toLowerCase() ?? '';
      if (word === 'wireframe' || word === 'studio') {
        this.look = word;
        return { kind: 'other' };
      }
      others.push({ line, text });
      return { kind: 'other' };
    }
    if (first === 'scene') {
      if (rest.split(/\s+/)[0]?.toLowerCase() === 'board') {
        this.board = true;
        return { kind: 'other' };
      }
      others.push({ line, text });
      return { kind: 'other' };
    }

    if (first === 'screen') {
      this.closeAll(line);
      const w = words(rest);
      const idWord = w.flags[0];
      const deviceWord = w.flags.find((f): f is UiDevice => (UI_DEVICES as readonly string[]).includes(f));
      const device = deviceWord ?? ((UI_DEVICES as readonly string[]).includes(w.attrs['device'] ?? '') ? (w.attrs['device'] as UiDevice) : 'phone');
      if (deviceWord === undefined && w.attrs['device'] === undefined) notes.push({ line, message: 'screen has no device word (phone, tablet, desktop or browser): a phone is assumed' });
      const fromRaw = w.attrs['from'];
      const [fromId, ...labelParts] = (fromRaw ?? '').split(':');
      const id = idWord !== undefined && !(UI_DEVICES as readonly string[]).includes(idWord) && !byId.has(idWord) ? idWord : `s${screens.length + 1}`;
      // a label of several words, written without quotes, runs on over the bare words after it
      const spill = w.flags.filter((f, i) => i > 0 && f !== idWord && !(UI_DEVICES as readonly string[]).includes(f));
      const label = labelParts.length > 0 ? [labelParts.join(':'), ...spill].join(' ') : null;
      // the style a screen does not say is the one before it: a journey is one app
      const style: UiStyle = { ...(screens[screens.length - 1]?.style ?? {}), ...styleOf(w.attrs, notes, line) };
      const made: MutableScreen = { id, device, from: fromId === undefined || fromId === '' ? null : fromId, fromLabel: label, name: fields[0] ?? '', line, style, children: [] };
      this.screen = made;
      screens.push(made);
      byId.set(id, made);
      return { kind: 'screen', screen: made };
    }

    const isPart = (UI_PART_KINDS as readonly string[]).includes(first);
    const isBox = first === 'row' || first === 'col';
    const isEnd = first === 'end';
    const screen = this.screen;
    // inside a screen, a word that is not a part is set as text, and said: the mock-up is never missing what the brain wrote
    if (screen !== null && !isPart && !isBox && !isEnd && !KNOWN_OTHERS.has(first)) {
      const id = this.idFor('text', undefined);
      const target: MutableContainer | MutableScreen = this.stack[this.stack.length - 1] ?? screen;
      notes.push({ line, message: `\`${first}\` is not a part (${UI_PART_KINDS.join(', ')}): set as text` });
      const node: UiPartNode = { kind: 'text', id, line, flags: [], attrs: {}, fields: [bar < 0 ? text : (fields[0] ?? '')] };
      target.children.push(node);
      return { kind: 'node', node, parent: target.id };
    }
    if (!(isPart || isBox || isEnd) || screen === null) {
      if (!(isPart || isBox || isEnd) && !KNOWN_OTHERS.has(first)) {
        notes.push({ line, message: `\`${first}\` is not a line of the interface: kept as it is` });
      } else if ((isPart || isBox || isEnd) && screen === null) {
        notes.push({ line, message: `\`${first}\` is read only inside a screen: write \`screen <id> phone\` first` });
      }
      others.push({ line, text });
      return { kind: 'other' };
    }

    if (isEnd) {
      if (this.stack.length === 0) notes.push({ line, message: '`end` with nothing open' });
      else this.stack.pop();
      return { kind: 'end' };
    }

    const w = words(rest);
    const parentId = w.attrs['in'];
    const parentFound = parentId === undefined ? undefined : byId.get(parentId);
    const target: MutableContainer | MutableScreen = parentFound ?? this.stack[this.stack.length - 1] ?? screen;
    if (parentId !== undefined && parentFound === undefined) notes.push({ line, message: `in=${parentId}: no such container; put on the open one` });

    if (isBox) {
      const props = boxProps(w, notes, line);
      const id = this.idFor(first, w.attrs['id']);
      const container: MutableContainer = { kind: first === 'row' ? 'row' : 'col', id, line, props, children: [] };
      target.children.push(container);
      byId.set(id, container);
      if (parentId === undefined) this.stack.push(container);
      return { kind: 'node', node: container, parent: target.id };
    }

    const kind = first as UiPartKind;
    const known = UI_VARIANTS[kind];
    const flags = w.flags.filter((f) => {
      if (known.includes(f) || f === 'grow') return true;
      if (kind === 'progress' || kind === 'tabbar' || kind === 'icon') return true;
      notes.push({ line, message: `${kind}: \`${f}\` is not a variant of ${kind} (${known.join(', ') || 'none'}); ignored` });
      return false;
    });
    const id = this.idFor(kind, w.attrs['id']);
    const attrs: Record<string, string> = { ...w.attrs };
    delete attrs['in'];
    delete attrs['id'];
    const node: UiPartNode = { kind, id, line, flags, attrs, fields };
    target.children.push(node);
    return { kind: 'node', node, parent: target.id };
  }
}

export function parseInterface(lines: readonly string[]): UiDocument {
  const reader = new InterfaceReader();
  for (const raw of lines) reader.read(raw);
  return reader.finish();
}

// ------------------------------------------------------------------ writing, so that every line stands alone

function quoteIfNeeded(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

function propWords(p: UiBoxProps): string[] {
  const out: string[] = [];
  const space = (n: number): string => (Object.entries(UI_SPACE).find(([, v]) => v === n)?.[0] ?? String(n));
  if (p.gap !== null) out.push(`gap=${space(p.gap)}`);
  if (p.pad !== null) out.push(`pad=${space(p.pad)}`);
  if (p.align !== null) out.push(`align=${p.align}`);
  if (p.max !== null) out.push(`max=${p.max}`);
  for (const [flag, on] of [['spread', p.spread], ['grow', p.grow], ['wrap', p.wrap], ['card', p.card], ['lift', p.lift], ['center', p.center]] as const) if (on) out.push(flag);
  return out;
}

/** One node as a line that stands alone: its `id=` and the `in=` of what it sits in. */
export function nodeLine(node: UiNode, parent: string): string {
  if (isUiContainer(node)) return [node.kind, `id=${node.id}`, `in=${parent}`, ...propWords(node.props)].join(' ');
  const attrs = Object.entries(node.attrs).map(([k, v]) => `${k}=${quoteIfNeeded(v)}`);
  const head = [node.kind, ...node.flags, `id=${node.id}`, `in=${parent}`, ...attrs].join(' ');
  return node.fields.length === 0 ? head : `${head} | ${node.fields.join(' | ')}`;
}

/** A screen as a line that stands alone. */
export function screenLine(screen: UiScreen): string {
  const from = screen.from === null ? '' : ` from=${screen.from}${screen.fromLabel === null ? '' : `:${screen.fromLabel}`}`;
  const style = UI_STYLE_KEYS.filter((key) => screen.style[key] !== undefined).map((key) => ` ${key}=${quoteIfNeeded(screen.style[key] as string)}`).join('');
  return `screen ${screen.id} ${screen.device}${from}${style}${screen.name === '' ? '' : ` | ${screen.name}`}`;
}

/**
 * The tree as lines that each stand alone: every container and part carries its `id=` and its `in=` (the screen or
 * container it is in), and there is no `end`. This is what the normaliser puts on the wire; `parseInterface` reads it
 * back as the same tree.
 */
export function interfaceLines(doc: UiDocument): string[] {
  const out: string[] = [];
  if (doc.look !== null) out.push(`look ${doc.look}`);
  if (doc.board) out.push('scene board');
  const walk = (nodes: readonly UiNode[], parent: string): void => {
    for (const node of nodes) {
      out.push(nodeLine(node, parent));
      if (isUiContainer(node)) walk(node.children, node.id);
    }
  };
  for (const screen of doc.screens) {
    out.push(screenLine(screen));
    walk(screen.children, screen.id);
  }
  for (const other of doc.others) out.push(other.text);
  return out;
}

/** The lines a screen took, for the bar's "lines a screen": its own, every container and every part. An `end` closes what is already counted. */
export function linesPerScreen(doc: UiDocument): readonly number[] {
  return doc.screens.map((screen) => {
    let n = 1;
    const walk = (nodes: readonly UiNode[]): void => {
      for (const node of nodes) {
        n += 1;
        if (isUiContainer(node)) walk(node.children);
      }
    };
    walk(screen.children);
    return n;
  });
}

/** Strips `*stars*`: returns the words and whether they were starred (chosen, emphasised). */
export function unstar(field: string): { readonly text: string; readonly starred: boolean } {
  const m = /^\*(.+)\*$/.exec(field.trim());
  return m === null ? { text: field.trim(), starred: false } : { text: m[1] ?? '', starred: true };
}

// ------------------------------------------------------------------ the chapter

/**
 * What the brain is told (PLAN-v2.2 E11, Appendix C): the interface chapter, as the prompt package rides it in the brief
 * when a message has its cues (mock-up, wireframe, screen, page, app, site, figma). It is written here, beside the words it
 * teaches, so that the two cannot drift: the parts and the variants below are read from the tables above.
 */
export const INTERFACE_CHAPTER: string = [
  'INTERFACE (more of the language; this painter performs it)',
  '',
  'A mock-up is described, not drawn. You say what is on each screen, in order; the painter sizes, spaces and aligns every part, in the look, on a designer\'s grid. Never place a part by coordinates (no at=, x=, y=), and never build a control out of rects.',
  '- `screen <id> phone|tablet|desktop|browser [from=<screen>[:label]] [| name]` is a device at its true proportions (a phone is 390 across; a browser is a page). Screens stand side by side in the order written. Its parts follow, one a line, top to bottom, until the next screen. `from=` draws the arrow of a journey.',
  '- `row` and `col` hold the lines after them, side by side or stacked, until `end`. They nest. Words: gap=none|xs|s|m|l|xl, pad=(same), align=start|center|end, spread (first and last pushed apart), grow (takes the room that is left), wrap, card (a surface with an edge), lift (a shadow), max=<points> center (a page no wider than that, in the middle).',
  '- Parts, one a line (a word before the bar is a variant; the words after each bar are what it says):',
  '  nav [back|close|menu] [action=<icon>] | Title        a top bar; on a browser: nav links="Car,Home,Help" action="Get a quote" | Brand',
  '  tabbar icons=a,b,c | One | Two | Three               the first tab is chosen, or mark one with *stars*',
  '  heading [large|small|center] | words   text [dim|large|bold] | words   note | small dim words',
  '  button [primary|ghost|danger] [wide|small] [to=<screen>] [send] | Label   field [error|password] | Label | hint | message   pick | Label | A | B | C',
  '  toggle [on] | Label     slider | Label | 40     item [icon=<name>] [chevron|toggle|on] [value=<words>] | Title | subtitle',
  '  badge [success|danger] | words   price | 34 | /mo   progress 2 of 4   image [wide|square|tall|round|grow] [q="nouns"] | what it shows',
  '  icon <name> [small|large|xl]   divider   space [s|m|l|grow]   chart ref=<id> | Title',
  '- A photograph is looked up for an image by its `q="…"`: three to five concrete things that are IN the picture, the subject first (q="sailing boats harbour water"), never a mood, a brand or a name. A hero is `wide` (a landscape). Only those words leave the machine. Without q the words after the bar are used.',
  '- `*Words*` on an item, a tab or a pick option is the one chosen. Any part may say `grow`.',
  '- A clickable mock-up is the same `screen`: its tabs, picks, toggles, sliders, fields (typing shows in them; `password` shows dots) and buttons answer taps, and a button with `to=<screen>` goes to that screen (write the next screen after it). A button with no `to=` is sent to you when it is pressed ("the user pressed Sign in", with what every field holds; a password is only said to be filled), so you can answer it; add `send` to a button that has a `to=` when you must hear it too (a sign-in that opens the next screen). Never build a mock-up from `card`, `input`, `toggle` or `button` lines outside a `screen`.',
  '- To change a mock-up that is on stage, reuse its screen ids: write `screen s1 …` again with the lines it should now have and that screen is replaced where it stands (the screens you do not write stay as they are); a new id is a new screen. Never draw a mock-up a second time under new ids to change it.',
  '- Icons are plain words: home search user bell cart heart star check close back menu plus shield car house umbrella phone mail lock card calendar camera map pin clock info warning document profile bank wallet chart-line.',
  '- Make the mock-up read as the kind of app it is: on the first screen line set `theme=dark|light accent=<colour word or #hex> radius=sharp|soft|round type=geometric|humanist|serif density=compact|comfortable` (the kit derives every ground, ink and line from them, readable; later screens follow the first). Music, video, banking and games are dark with one accent; shops, health and news are light; a reading app is serif. Name the app yourself: never a real app\'s name, logo or colours.',
  '- Richer parts, each one line that holds its own words (items are `Title / Subtitle`; cover art is drawn from the title, no `q` needed): `media [cols=2|3] [round] [title="…"] | Mix / Sub | …` a grid of covers; `carousel [round|wide] [title="…" more="See all"] | A / sub | …` a row you drag (put it directly in the screen, not in a padded col); `player [large] [len=3:48] | Title / Artist` (a bar with play and progress; `large` is the now-playing page; `to=<screen>`); `chat | ~Today 9:41 | Maya: words | me: words | …` bubbles; `map [route] [pins=3] | Place | 4 min away`; `stat [up|down] [spark=1,3,2,5] | Label | $4,200 | +2.4% this month`; `people [to=<screen>] | *Name / last words / 2m* | …` avatars, the starred one unread; `segment [tabs] | *All* | Music | Podcasts` chips or underlined tabs. A phone screen is about 700 points: a media grid or a carousel takes a third of it, a stat or a player a tenth, so one grid and one carousel at most, then the player, then the tabbar.',
  '- `look wireframe` is boxes and lines; `look studio` is a finished design. The same lines serve both.',
  'Open with `scene caption` (the mock-up takes the stage; your one `say` is its caption), then the look, then the screens. Write the words a real product would: real labels and copy. At most twelve parts a phone screen. A button that matters most is `primary`; one a screen. A website is a `browser` screen (nav links=… first, then a hero, one row of cards, a footer; no more than one and a half screens of it); an app is `phone`. Start with `look studio` for a finished design, or `look wireframe` when asked for a wireframe. End with one short sentence (`say | …`, under twelve words) and no choices, never a list of the parts: the mock-up is the answer and needs the room.',
  '',
  'Example ("a sign-in screen"):',
  'scene caption',
  'look wireframe',
  'screen s1 phone | Sign in',
  'nav close | Sign in',
  'col pad=l gap=m grow',
  'heading | Welcome back',
  'field | Email | you@example.com',
  'field | Password | ••••••••',
  'row spread',
  'toggle | Remember me',
  'note | Forgot password?',
  'end',
  'space grow',
  'button primary wide | Sign in',
  'button ghost wide | Create an account',
  'end',
  '',
  'Example ("a music app home and now-playing"):',
  'scene caption',
  'look studio',
  'screen home phone theme=dark accent=green radius=round type=geometric | Home',
  'col pad=m gap=m',
  'heading | Good evening',
  'segment | *All* | Music | Podcasts',
  'media cols=2 | Daily Mix / Slow mornings | Late Jazz / Evening',
  'end',
  'carousel round title="Artists you follow" | Marla Quinn / Artist | The Low Tide / Band | Juno Park / Artist',
  'space s',
  'player to=now | Blue Hour / Marla Quinn',
  'tabbar icons=home,search,queue | *Home* | Search | Library',
  'screen now phone from=home:Now playing | Now playing',
  'nav back | Daily Mix',
  'player large len=3:48 | Blue Hour / Marla Quinn',
].join('\n');
