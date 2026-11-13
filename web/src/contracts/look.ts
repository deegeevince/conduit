// What a look IS, as data. The painter reads it to lay out, colour and move
// things in the look's idiom; a renderer adds the part that cannot be data:
// fonts, shaders and the furniture of the screen. DESIGN.md says why each
// value is what it is.

import type { EnterEffect, ExitEffect, Face, FxName, InkRole, LookId, Mood, Size, StrokeCharacter } from '@conduit/language';
import type { Colour } from './frame';

export type Ease =
  | 'linear'
  /** fast start, long settle: the default for anything arriving */
  | 'out'
  /** quick, firm stop: for slams and exits */
  | 'out-hard'
  | 'in'
  | 'in-out'
  /** no motion at all until the end, then there: a hard cut */
  | 'hold';

/**
 * How one entrance or exit is performed in a look. The length comes from the
 * language's schedule; this only says what happens during it.
 */
export interface MotionRecipe {
  /** where a run starts from (entrance) or ends at (exit); each missing field means "no change" */
  readonly from: {
    readonly opacity?: number;
    /** offsets in em of the element's font size */
    readonly dx?: number;
    readonly dy?: number;
    readonly scale?: number;
  };
  readonly ease: Ease;
  /** runs appear by having their characters revealed left to right instead of all at once */
  readonly reveal: boolean;
  /** opacity is gated by an irregular on/off pattern that resolves to on */
  readonly flicker: boolean;
}

/** How a size step is drawn. Bitmap-era machines scaled cells by whole numbers and sometimes only in one direction. */
export interface CellScale {
  /** multiplier on the body cell width */
  readonly x: number;
  /** multiplier on the body cell height */
  readonly y: number;
}

/** How arbitrary colours from the brain are brought into what the machine could show. */
export type Gamut =
  /** one phosphor: only luminance survives, mapped onto a ramp from `low` to `high` */
  | { readonly kind: 'mono'; readonly low: Colour; readonly high: Colour }
  /** a fixed set: the nearest member wins */
  | { readonly kind: 'palette'; readonly colours: readonly Colour[] }
  /** inks on paper: hue is kept, lightness is capped so it still reads as ink */
  | { readonly kind: 'ink'; readonly maxLightness: number }
  /** no machine behind the look: any colour is shown as asked, and only the contrast rule moves it */
  | { readonly kind: 'any' };

export interface MoodCharacter {
  /** 0..1 signal nervousness handed to the renderer */
  readonly agitation: number;
  /** 0..1 dimming of the whole picture */
  readonly dim: number;
  /** idle camera sway: amplitude as a share of viewport height, and seconds per cycle */
  readonly sway: number;
  readonly swayPeriod: number;
  /** resting push toward the stage as a share of rest distance; tense scenes sit a little closer */
  readonly lean: number;
  /** multiplier on eased motion lengths inside the painter (not on the schedule) */
  readonly snap: number;
}

/** One effect of a look's surface, with how strongly it is applied. The renderer applies a look's effects in its own fixed order, never the listed one. */
export interface FxSetting {
  readonly name: FxName;
  /** 0..1; each effect documents what 1 means in DESIGN.md */
  readonly amount: number;
}

/**
 * A look, resolved for the painter and the renderer. The palette, face, fx
 * list and stroke come from the language's definition of the look (a preset,
 * or the brain's variation of one); everything else here is what a look needs
 * that a brain never names. `specFor` in `looks/` builds one.
 */
export interface LookSpec {
  /** the preset it stands on */
  readonly id: LookId;
  /** the look's own name: the preset's, or the one the brain gave its variation */
  readonly name: string;
  /** what it is pinned to: a machine and a year for the retro presets, a material for the others */
  readonly machine: string;

  readonly roles: Readonly<Record<InkRole, Colour>>;
  /** a second ground some looks have (paper bars); contrast is checked against the worse of the two */
  readonly groundAlt: Colour | null;
  readonly gamut: Gamut;
  /** the colour `*emphasis*` takes when the surrounding text is in the given role */
  readonly emphasis: Readonly<Record<InkRole, InkRole>>;
  /**
   * A level above the top of the ramp, for a monochrome tube: `*emphasis*`
   * takes it where its role's colour would equal, or sit within 1.25x of, the
   * colour it emphasises (bold, strong and accent text are already at the
   * top). null when the look tells emphasis apart by hue.
   */
  readonly hot: Colour | null;

  /** the surface, in the language's own words; amounts are the look's */
  readonly fx: readonly FxSetting[];

  readonly stroke: {
    readonly character: StrokeCharacter;
    /** outline thickness when a line names none, canvas units */
    readonly thick: number;
    /** how far a hand-drawn line strays from true, canvas units; 0 for a ruled line */
    readonly wobble: number;
  };

  /** the sixteen colours a sprite cell can name, already brought into this look's gamut */
  readonly sprite: readonly Colour[];

  readonly type: {
    readonly face: Face;
    /** `fixed`: every character is one cell wide and layout is cell arithmetic. `proportional`: widths come from the face's metrics. */
    readonly pitch: 'fixed' | 'proportional';
    /** key into the renderer's font table */
    readonly font: string;
    /** key of the face used for weight=bold, or null when bold is drawn some other way */
    readonly boldFont: string | null;
    /** how weight=bold is drawn: a heavier face, a brighter beam, or not at all (the machine had no bold; size and colour carry it) */
    readonly bold: 'face' | 'bright' | 'none';
    /** cell width as a share of the font size for a fixed-pitch face; the average advance of running text for a proportional one (used only to estimate how many characters fit) */
    readonly advance: number;
    /** line height as a share of the font size */
    readonly lineHeight: number;
    /** the machine had capitals only */
    readonly upperOnly: boolean;
    /** body size is chosen so about this many characters fit across the safe frame */
    readonly targetCols: number;
    /** body font size limits, CSS pixels on the reading plane */
    readonly minBody: number;
    readonly maxBody: number;
    /** no text on the reading plane is ever set smaller than this, whatever its size word */
    readonly minFont: number;
    /** the longest line the painter will set at body size, however wide the screen */
    readonly measure: number;
    readonly sizes: Readonly<Record<Size, CellScale>>;
    /** positions snap to whole cells of the body grid */
    readonly snapToCells: boolean;
    /** what `align=auto` means here */
    readonly align: 'left' | 'center';
    /** the marker `layout=list` puts before each item */
    readonly bullet: string;
  };

  readonly motion: {
    /** element motion is sampled at this many frames per second; null is smooth */
    readonly step: number | null;
    /** the camera is sampled at this many frames per second; null is smooth */
    readonly cameraStep: number | null;
    readonly ease: Ease;
    readonly enter: Readonly<Record<EnterEffect, MotionRecipe>>;
    readonly exit: Readonly<Record<ExitEffect, MotionRecipe>>;
    /** seconds for one on-off cycle of the cursor and of loop=blink */
    readonly blink: number;
    /** whether a cursor is drawn at the writing position */
    readonly cursor: boolean;
    /** how the stage shows it is waiting for the brain: the face's own cursor, or the three dots every other look uses */
    readonly waiting: 'cursor' | 'dots';
  };

  readonly mood: Readonly<Record<Mood, MoodCharacter>>;

  /** safe margin as a share of the shorter viewport side; never less than 16 CSS pixels */
  readonly margin: number;

  /**
   * Rows of the look's own furniture, kept clear on every layer. `top` is a
   * number of body rows added to the margin at the top edge of the safe frame
   * (teletext draws its header there); text, stamps and ghost words never sit
   * in them. 0 when the look has none.
   */
  readonly furniture: { readonly top: number };
}
