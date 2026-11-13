import type { ColourRef, Fill, FillRef, HexColor, LookProps, Near, Paint, Point, Seconds, StyleProps } from './types';
import { DEFAULT_LOOK, INK_ROLES, LOOK } from './vocabulary';
import type {
  Anchor,
  Bleed,
  By,
  ElementKind,
  EnterEffect,
  ExitEffect,
  Face,
  FxName,
  Layer,
  Layout,
  LetterCase,
  LookId,
  Loop,
  Mark,
  Size,
  StayWord,
  StrokeCharacter,
  Weight,
} from './vocabulary';

/**
 * A name the brain chose, looked up in a table. Only the table's own entries
 * count: a style, colour or look called `constructor` is not a function.
 */
export function own<T>(table: Readonly<Record<string, T>>, name: string): T | undefined {
  return Object.hasOwn(table, name) ? table[name] : undefined;
}

export interface StyleDef {
  readonly like?: string;
  readonly props: StyleProps;
}

/** Brain-defined styles by name. Built-ins are not stored here; a definition with a built-in's name shadows it. */
export type StyleSheet = Readonly<Record<string, StyleDef>>;

/** Colours the brain has named with `color`. */
export type ColorSheet = Readonly<Record<string, HexColor>>;

export interface LookDef {
  readonly like?: string;
  readonly props: LookProps;
}

/** Looks the brain has defined, by name. A definition with a preset's name shadows the preset. */
export type LookSheet = Readonly<Record<string, LookDef>>;

/** A look with nothing left open: what the painter turns into colours, type and screen. */
export interface ResolvedLook {
  readonly name: string;
  /** the preset it stands on, directly or through a chain of `like=` */
  readonly preset: LookId;
  readonly ground: HexColor;
  readonly ink: HexColor;
  readonly dim: HexColor;
  readonly accent: HexColor;
  readonly alt: HexColor;
  readonly face: Face;
  readonly fx: readonly FxName[];
  readonly stroke: StrokeCharacter;
  readonly enter: EnterEffect;
  readonly by: By;
  readonly exit: ExitEffect;
}

const MAX_LIKE_DEPTH = 8;

function presetLook(id: LookId): ResolvedLook {
  const spec = LOOK[id];
  return {
    name: id,
    preset: id,
    ground: spec.ground,
    ink: spec.ink,
    dim: spec.dim,
    accent: spec.accent,
    alt: spec.alt,
    face: spec.face,
    fx: spec.fx,
    stroke: spec.stroke,
    enter: spec.enter,
    by: spec.by,
    exit: spec.exit,
  };
}

export function isPresetLook(name: string): name is LookId {
  return Object.hasOwn(LOOK, name);
}

function lookupLook(name: string, sheet: LookSheet, depth: number): ResolvedLook | null {
  const defined = own(sheet, name);
  if (defined === undefined) return isPresetLook(name) ? presetLook(name) : null;
  let base: ResolvedLook | null;
  // A look may be `like` the preset it shadows (look paper like=paper accent=#0a0).
  if (defined.like === undefined) base = isPresetLook(name) ? presetLook(name) : presetLook(DEFAULT_LOOK);
  else if (defined.like === name || depth >= MAX_LIKE_DEPTH) base = isPresetLook(defined.like) ? presetLook(defined.like) : presetLook(DEFAULT_LOOK);
  else base = lookupLook(defined.like, sheet, depth + 1) ?? presetLook(DEFAULT_LOOK);
  return { ...base, ...defined.props, name, preset: base.preset };
}

/** The look called `name`: a preset, or one the brain defined. Null when there is no such look. */
export function resolveLook(name: string, sheet: LookSheet): ResolvedLook | null {
  return lookupLook(name, sheet, 0);
}

/**
 * The styles the painter ships. They are defined in the same vocabulary the
 * brain uses, so the brain can read exactly what `strong` means and redefine it.
 */
export const BUILTIN_STYLES = {
  body: { gist: 'plain speech; every line starts from this', props: {} },
  strong: { gist: 'the point of the sentence', props: { size: 'l', weight: 'bold' } },
  title: { gist: 'names the scene', props: { size: 'xl', weight: 'bold' } },
  shout: { gist: 'one or two words at full volume', props: { size: 'xxl', weight: 'bold', ink: 'accent', enter: 'slam', by: 'all' } },
  aside: { gist: 'said under the breath', props: { size: 's', ink: 'dim' } },
  label: { gist: 'a small caption on something drawn', props: { size: 'xs', ink: 'dim', case: 'upper', enter: 'fade', by: 'all' } },
  ghost: { gist: 'a huge dim word far behind, setting the subject', props: { layer: 'bg', size: 'xxl', ink: 'dim', enter: 'fade', by: 'all', loop: 'drift' } },
  stamp: { gist: 'a verdict stamped in front', props: { layer: 'fg', size: 'l', ink: 'accent', mark: 'box', case: 'upper', enter: 'slam', by: 'all' } },
  choice: { gist: 'an option the user can tap; the tap becomes their next message', props: { tap: true, mark: 'box', ink: 'alt' } },
} as const satisfies Record<string, { gist: string; props: StyleProps }>;

export type BuiltinStyleName = keyof typeof BUILTIN_STYLES;
export const BUILTIN_STYLE_NAMES: ReadonlySet<string> = new Set(Object.keys(BUILTIN_STYLES));

/**
 * A style with every property decided and every colour name resolved.
 * `enter`, `by` and `exit` are concrete because the look, the kind of element
 * and the layout have filled them in.
 */
export interface ElementStyle {
  readonly size: Size;
  readonly ink: Paint;
  readonly weight: Weight;
  /** null: the look's own face */
  readonly face: Face | null;
  readonly enter: EnterEffect;
  readonly by: By;
  readonly exit: ExitEffect;
  readonly loop: Loop;
  readonly mark: Mark;
  readonly case: LetterCase;
  readonly stay: StayWord | Seconds;
  readonly layer: Layer;
  readonly at: Anchor | Point | null;
  readonly near: Near | null;
  /** id of the group it is a part of */
  readonly group: string | null;
  readonly fill: Fill;
  readonly stroke: Paint | 'none';
  /** `auto`: a filled shape touching the canvas's left, right or bottom edge runs on to the viewport edge; `none` keeps it inside */
  readonly bleed: Bleed;
  /** outline thickness in canvas units; null: the look's own */
  readonly thick: number | null;
  /** null: the painter sizes it (a sprite: a share of the canvas; anything else: as drawn) */
  readonly scale: number | null;
  /** degrees, clockwise */
  readonly rot: number;
  readonly opacity: number;
  readonly tap: boolean;
  readonly dur: number | null;
}

/** Style properties with colour names already looked up. */
export type ResolvedProps = Omit<StyleProps, 'ink' | 'fill' | 'stroke'> & {
  readonly ink?: Paint;
  readonly fill?: Fill;
  readonly stroke?: Paint | 'none';
};

function lookupProps(sheet: StyleSheet, name: string, depth: number, unknown: string[]): StyleProps {
  const defined = own(sheet, name);
  if (defined !== undefined) {
    if (defined.like === undefined || depth >= MAX_LIKE_DEPTH) return defined.props;
    // A style may be `like` the built-in it shadows (style strong like=strong ink=accent).
    const base =
      defined.like === name
        ? own(BUILTIN_STYLES as Record<string, { props: StyleProps }>, name)?.props ?? {}
        : lookupProps(sheet, defined.like, depth + 1, unknown);
    return { ...base, ...defined.props };
  }
  const builtin = own(BUILTIN_STYLES as Record<string, { props: StyleProps }>, name);
  if (builtin !== undefined) return builtin.props;
  unknown.push(name);
  return {};
}

/** Merges named styles left to right, then inline properties. Unknown names are reported, not fatal. */
export function mergeStyles(sheet: StyleSheet, names: readonly string[], inline: StyleProps): { props: StyleProps; unknown: string[] } {
  const unknown: string[] = [];
  let props: StyleProps = {};
  for (const name of names) props = { ...props, ...lookupProps(sheet, name, 0, unknown) };
  return { props: { ...props, ...inline }, unknown };
}

function isRole(value: string): value is (typeof INK_ROLES)[number] {
  return (INK_ROLES as readonly string[]).includes(value);
}

function paintOf(ref: ColourRef, colors: ColorSheet, unknown: string[]): Paint {
  if (typeof ref === 'string') return ref;
  const found = own(colors, ref.named);
  if (found !== undefined) return found;
  unknown.push(ref.named);
  return 'ink';
}

function fillOf(ref: FillRef, colors: ColorSheet, unknown: string[]): Fill {
  if (ref === 'none') return 'none';
  if (typeof ref === 'object' && 'from' in ref) return { from: paintOf(ref.from, colors, unknown), to: paintOf(ref.to, colors, unknown) };
  return paintOf(ref, colors, unknown);
}

/** Looks up every colour name in `props`. A name nobody defined becomes `ink` and is reported. */
export function resolveColours(props: StyleProps, colors: ColorSheet): { props: ResolvedProps; unknown: string[] } {
  const unknown: string[] = [];
  const { ink, fill, stroke, ...rest } = props;
  const resolved: ResolvedProps = {
    ...rest,
    ...(ink !== undefined && { ink: paintOf(ink, colors, unknown) }),
    ...(fill !== undefined && { fill: fillOf(fill, colors, unknown) }),
    ...(stroke !== undefined && { stroke: stroke === 'none' ? 'none' : paintOf(stroke, colors, unknown) }),
  };
  return { props: resolved, unknown };
}

export function isRolePaint(paint: Paint): boolean {
  return isRole(paint);
}

/** What decides the properties a line leaves open. */
export interface StyleContext {
  readonly kind: ElementKind;
  /** the look's motion defaults */
  readonly look: Pick<ResolvedLook, 'enter' | 'by' | 'exit'>;
  /** the layout of the scene the element joins; `page` and `caption` set their own text motion */
  readonly layout: Layout;
}

function defaultEnter(props: ResolvedProps, context: StyleContext): { enter: EnterEffect; by: By } {
  const { kind, look, layout } = context;
  if (kind === 'text') {
    if (props.enter !== undefined) return { enter: props.enter, by: props.enter === 'type' ? 'char' : (props.by ?? 'all') };
    // Prose is for reading, not for watching: it arrives a paragraph at a time, quickly.
    if (layout === 'page') return { enter: 'fade', by: props.by ?? 'all' };
    return { enter: look.enter, by: look.enter === 'type' ? 'char' : (props.by ?? look.by) };
  }
  if (props.enter !== undefined) return { enter: props.enter, by: 'all' };
  if (kind === 'shape') return { enter: props.stroke === 'none' || (props.stroke === undefined && props.fill !== undefined && props.fill !== 'none') ? 'fade' : 'draw', by: 'all' };
  if (kind === 'sprite') return { enter: 'draw', by: 'all' };
  if (kind === 'group') return { enter: 'cut', by: 'all' };
  return { enter: 'fade', by: 'all' };
}

/** Fills every property a line left open: language defaults, then what the look, the kind and the layout decide. */
export function completeStyle(props: ResolvedProps, context: StyleContext): ElementStyle {
  const { enter, by } = defaultEnter(props, context);
  const drawn = context.kind !== 'text';
  const fill: Fill = props.fill ?? 'none';
  // A shape given only a fill is a flat shape; given neither it is an outline in ink.
  const stroke: Paint | 'none' = props.stroke ?? (fill === 'none' ? 'ink' : 'none');
  return {
    size: props.size ?? 'm',
    ink: props.ink ?? 'ink',
    weight: props.weight ?? 'normal',
    face: props.face ?? null,
    enter,
    by,
    exit: props.exit ?? (drawn && context.look.exit !== 'cut' ? 'fade' : context.look.exit),
    loop: props.loop ?? 'none',
    mark: props.mark ?? 'none',
    case: props.case ?? 'asis',
    stay: props.stay ?? 'scene',
    layer: props.layer ?? 'mid',
    at: props.at ?? null,
    near: props.near ?? null,
    group: props.in ?? null,
    fill,
    stroke,
    bleed: props.bleed ?? 'auto',
    thick: props.thick ?? null,
    scale: props.scale ?? null,
    rot: props.rot ?? 0,
    opacity: props.opacity ?? 1,
    tap: props.tap ?? false,
    dur: props.dur ?? null,
  };
}

export interface ResolvedStyle {
  readonly style: ElementStyle;
  readonly unknownStyles: string[];
  readonly unknownColours: string[];
}

export function resolveStyle(sheet: StyleSheet, colors: ColorSheet, names: readonly string[], inline: StyleProps, context: StyleContext): ResolvedStyle {
  const merged = mergeStyles(sheet, names, inline);
  const coloured = resolveColours(merged.props, colors);
  return { style: completeStyle(coloured.props, context), unknownStyles: merged.unknown, unknownColours: coloured.unknown };
}

/** Applies a `set` to an element that already has a full style. Only what was named changes. */
export function patchStyle(style: ElementStyle, props: ResolvedProps): ElementStyle {
  return {
    ...style,
    ...(props.size !== undefined && { size: props.size }),
    ...(props.ink !== undefined && { ink: props.ink }),
    ...(props.weight !== undefined && { weight: props.weight }),
    ...(props.face !== undefined && { face: props.face }),
    ...(props.enter !== undefined && { enter: props.enter }),
    ...(props.by !== undefined && { by: props.by }),
    ...(props.exit !== undefined && { exit: props.exit }),
    ...(props.loop !== undefined && { loop: props.loop }),
    ...(props.mark !== undefined && { mark: props.mark }),
    ...(props.case !== undefined && { case: props.case }),
    ...(props.stay !== undefined && { stay: props.stay }),
    ...(props.layer !== undefined && { layer: props.layer }),
    ...(props.at !== undefined && { at: props.at, near: null }),
    ...(props.near !== undefined && { near: props.near, at: null }),
    ...(props.in !== undefined && { group: props.in }),
    ...(props.fill !== undefined && { fill: props.fill }),
    ...(props.stroke !== undefined && { stroke: props.stroke }),
    ...(props.bleed !== undefined && { bleed: props.bleed }),
    ...(props.thick !== undefined && { thick: props.thick }),
    ...(props.scale !== undefined && { scale: props.scale }),
    ...(props.rot !== undefined && { rot: props.rot }),
    ...(props.opacity !== undefined && { opacity: props.opacity }),
    ...(props.tap !== undefined && { tap: props.tap }),
    ...(props.dur !== undefined && { dur: props.dur }),
  };
}
