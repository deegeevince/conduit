// One instant of the stage, fully decided. The painter produces a Frame for a
// time; a renderer draws it. A Frame carries no history and no future: the
// same Frame always draws the same picture, which is what makes seeking to a
// time and inspecting it possible.

import type { AmbientKind, ClockState, Face, Layer, LookId, Mark, Mask, Medium, Polyline, StrokeCharacter, Texture, Weight } from '@conduit/language';
import type { ChartState } from './chart';
import type { TuneCue } from './tune';
import type { LookSpec } from './look';
import type { Box, CameraPose, Viewport } from './space';

/** `#rrggbb`, already mapped into the look's gamut and checked for contrast against the ground. */
export type Colour = string;

export type Quality =
  /** every effect of the look */
  | 'full'
  /** the look without its expensive passes (no feedback buffer, no curvature, lower pixel ratio) */
  | 'lite';

/**
 * A run is the unit of motion: one word, or part of one when emphasis splits
 * it. It never contains a space. Typed and wiped entrances advance `reveal`
 * inside a run; softer entrances move and fade the run as a whole.
 */
export interface RunFrame {
  readonly text: string;
  /** top-left of the run's cell box, relative to the centre of its element, in the element's own unscaled units */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly colour: Colour;
  readonly opacity: number;
  /** extra offset from motion, stage units */
  readonly dx: number;
  readonly dy: number;
  /** about the run's own centre */
  readonly scale: number;
  /**
   * 0..1: the share of the run's WIDTH that is visible, from the left. The
   * painter turns "this many characters" into a width with the face's own
   * advances, so a renderer clips at this share and needs no font metrics.
   */
  readonly reveal: number;
}

/**
 * v2.1. A frame something is kept inside: a rectangle on the thing's own layer plane, stage units, camera at rest. Nothing of the
 * thing is drawn outside it, whatever the camera does, in every renderer, in a rasterised still and in an SVG. Absent: not clipped.
 * It is how a painting's parts stay inside the painting, a code block's lines inside its block, and a picture out of the words' band.
 * Picking follows it: a point outside the clip does not hit the thing.
 */
export type Clip = Box;

export interface ElementFrame {
  /** stable across frames for the same element; the renderer keys its objects on it */
  readonly key: string;
  readonly id: string;
  readonly layer: Layer;
  /** drawing order within its layer, shared with figures: a higher z is drawn later, on top */
  readonly z: number;
  /** the face it is set in; the renderer finds the font files in `FACES` */
  readonly face: Face;
  /** centre of the text block on its layer's plane, stage units */
  readonly x: number;
  readonly y: number;
  /** size of the text block, unscaled */
  readonly width: number;
  readonly height: number;
  /** em height in stage units */
  readonly fontSize: number;
  /** horizontal scale of the glyphs; below 1 is how a double-height cell is drawn */
  readonly stretch: number;
  readonly weight: Weight;
  readonly opacity: number;
  /** about the block's centre */
  readonly scale: number;
  /** radians about the block's centre */
  readonly rotation: number;
  readonly runs: readonly RunFrame[];
  /** one box per wrapped line, relative to the block's centre; marks are drawn per line */
  readonly lines: readonly Box[];
  readonly mark: Mark;
  readonly markColour: Colour;
  /**
   * 0..1: how much of a strike-through laid over the element has been drawn.
   * Governs whenever it is above 0, whatever `mark` is: a correction sends the
   * old element with `mark: 'none'` and `strike` rising to 1. When
   * `mark === 'strike'` the line is part of how the element was written and is
   * drawn at full length regardless of `strike` (which stays 0 then). The
   * strike is drawn in the ink of the first run.
   */
  readonly strike: number;
  /** a struck predecessor lingering beside its replacement */
  readonly ghost: boolean;
  readonly tappable: boolean;
  /** v2.1: see `Clip` */
  readonly clip?: Clip;
  /**
   * 0..1: how solid a plate in the ground colour is behind each line box.
   * The painter raises it when text sits over something drawn, which is how
   * the contrast rule is kept on a stage that has pictures on it.
   */
  readonly plate: number;
}

/**
 * Maps a figure's own units (canvas units: outlines, stroke width and a sprite's cell are all measured in them) to stage units on its
 * layer's plane: x' = a x + c y + e, y' = b x + d y + f. A group's place, turn and size are already folded in.
 */
export interface Affine {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

export const IDENTITY: Affine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export interface StrokeFrame {
  readonly colour: Colour;
  /** canvas units, before `transform` (a stroke of 0.3 is 0.3 canvas units wide, never thinner than 1.25 device pixels) */
  readonly width: number;
  /** 0..1: the share of the outline's whole length that has been drawn, in the order its polylines are listed */
  readonly progress: number;
  readonly character: StrokeCharacter;
}

export interface FillFrame {
  readonly colour: Colour;
  /** the colour at the bottom of the shape's box when the fill is a gradient; null for a flat fill */
  readonly to: Colour | null;
  readonly opacity: number;
  /**
   * What the fill is made of (`tex=`). Absent means `flat`. A texture is drawn
   * by the renderer's own shader in the fill's colour, fixed to the shape so
   * that nothing shimmers when the shape or the camera moves. A renderer that
   * has none (it says so in `RendererCapabilities.textures`) draws flat.
   */
  readonly texture?: Texture;
  /**
   * v2.1. The top and height, in the shape's own units, that a gradient runs over, when the outline has been made to run on past what
   * the brain drew (bleed). Absent: the outline's own box. A flat fill ignores it.
   */
  readonly span?: { readonly top: number; readonly height: number };
}

/**
 * One drawn shape at one instant. `outline` is already flat polylines, in the
 * shape's own units, with any hand wobble the look's stroke asks for already
 * applied by the painter (so every renderer draws the same line). A renderer
 * tessellates when `geometryKey` changes and otherwise only updates uniforms.
 */
export interface ShapeFrame {
  readonly kind: 'shape';
  /** stable for the element; a copy's parts are `<copy key>/<part key>` */
  readonly key: string;
  readonly id: string;
  readonly layer: Layer;
  readonly z: number;
  /** canvas units (polylines of the figure's own space); `transform` carries them to the layer's plane */
  readonly outline: readonly Polyline[];
  readonly geometryKey: string;
  readonly transform: Affine;
  readonly fill: FillFrame | null;
  readonly stroke: StrokeFrame | null;
  readonly opacity: number;
  /** `rect full`: the renderer extends it to cover the whole screen on its layer, whatever the camera does */
  readonly bleed: boolean;
  /** v2.1: see `Clip`. A shape with `bleed` is never clipped by the renderer and the painter never sets both. */
  readonly clip?: Clip;
  readonly tappable: boolean;
  /**
   * How far the shape's edge fades out, in the shape's own units (`soft=`): light, cloud, shadow. Absent or 0 is a hard edge.
   * It widens what is drawn by that much and never moves the outline, so picking and layout are as for a hard shape.
   */
  readonly soft?: number;
}

/** A sprite at one instant: real pixels. A renderer draws each cell as a hard-edged square, never smoothed. */
export interface SpriteFrame {
  readonly kind: 'sprite';
  readonly key: string;
  readonly id: string;
  readonly layer: Layer;
  readonly z: number;
  readonly cols: number;
  readonly rows: number;
  /** row-major, `cols x rows`, the animation frame showing now; null is an empty cell */
  readonly cells: readonly (Colour | null)[];
  /** changes when `cells` does, so a renderer rebuilds its texture only then */
  readonly cellsKey: string;
  /** side of one cell in canvas units; the sprite is centred on its origin */
  readonly cell: number;
  readonly transform: Affine;
  /** how many rows have landed, from the top; the fraction is the row arriving now */
  readonly landed: number;
  readonly opacity: number;
  readonly tappable: boolean;
  /** v2.1: see `Clip` */
  readonly clip?: Clip;
}

/**
 * A picture at one instant: a painting, or the place one is waiting for. The
 * sketch under it is ordinary shapes elsewhere in the frame; the painter fades
 * them as `develop` rises when the brain asked for that.
 */
export interface PictureFrame {
  readonly kind: 'picture';
  readonly key: string;
  readonly id: string;
  readonly layer: Layer;
  readonly z: number;
  /** in the picture's own units */
  readonly box: Box;
  readonly transform: Affine;
  /** same-origin URL of the painting, already loaded with `Renderer.preload`; null while there is none */
  readonly src: string | null;
  /** 0..1: how far the painting has developed over the sketch: revealed through a noise threshold with a soft edge, never as a cross-fade. It does not yet spread from the sketch's lines (product.md). */
  readonly develop: number;
  readonly mask: Mask;
  readonly opacity: number;
  /** a painting has been asked for and has not arrived: the renderer may breathe the box's edge, and nothing else */
  readonly waiting: boolean;
  readonly tappable: boolean;
  /** v2.1: see `Clip` */
  readonly clip?: Clip;
  /**
   * Set when the painting is the renderer's own: the frame's figures whose keys are in `sketch` are re-rendered in this
   * medium into the picture's box, and `src` is null. `develop` reveals it over the sketch exactly as it reveals a
   * painting that was fetched. Absent when the picture is waiting for, or showing, an image model's painting.
   */
  readonly medium?: Medium;
  /** the keys of the figures that are the sketch, in drawing order; with `medium` */
  readonly sketch?: readonly string[];
}

export type FigureFrame = ShapeFrame | SpriteFrame | PictureFrame;

/**
 * One chart at one instant. A chart is not drawn from shapes: it is handed to
 * a charting engine (contracts/chart.ts), which draws it crisp in a surface of
 * its own that sits over the stage. So a ChartFrame says where that surface
 * goes and what the engine should be showing; a renderer does two things with
 * it and no more: it keeps the chart's room clear on the stage, and, when it
 * is asked for a picture (`rasterise`), it draws the engine's own still of the
 * chart into that room, so that a snapshot, an exported film and the brain's
 * look at its draft all show the chart.
 */
export interface ChartFrame {
  readonly key: string;
  readonly id: string;
  readonly layer: Layer;
  readonly z: number;
  /** where the chart's surface goes on screen now, host CSS pixels: the room it was given, through the camera */
  readonly box: Box;
  /** the same room with the camera at rest: the size the chart is drawn at, so that a camera move scales it and never re-lays it out */
  readonly rest: Box;
  readonly opacity: number;
  /** what to draw, already read from its rows or its data and themed from the look */
  readonly state: ChartState;
  readonly tappable: boolean;
  /** v2.1: see `Clip` */
  readonly clip?: Clip;
}

/**
 * A field of particles at one instant. The renderer owns every particle: the
 * position of particle `i` is a pure function of (`seed`, `i`, `time`), so the
 * same frame always draws the same weather and a field can be seeked.
 */
export interface FieldFrame {
  readonly kind: 'field';
  readonly key: string;
  readonly layer: Layer;
  readonly field: AmbientKind;
  /**
   * 0..1 from the brain's `light | some | heavy`, already scaled for this screen. The renderer turns it into a particle count
   * (a share of the kind's own count at 1440x900), and halves the count in `lite` quality; the painter does not.
   */
  readonly density: number;
  readonly colour: Colour;
  readonly opacity: number;
  readonly seed: number;
  /** seconds on the ambient clock: weather keeps falling while the playhead holds */
  readonly time: number;
  /** where flowing text sits on the reading plane, stage units. Weather on `fg` thins to a third over it, so it is never the thing that makes words hard to read. */
  readonly flow: Box;
}

/** Where the next character will appear. Looks draw it in their own idiom: a block, a print head. */
export interface CursorFrame {
  readonly layer: Layer;
  /** top-left of the cell, stage units on the layer's plane */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly colour: Colour;
  /** false during the off half of a blink */
  readonly lit: boolean;
  /**
   * How it is drawn. `block`, `bar` and `head` are the cursors of the fixed
   * pitch faces. `dots` is the waiting signal of every other look: three soft
   * dots that swell in turn, at the place the next thing will appear.
   */
  readonly shape: 'block' | 'bar' | 'head' | 'dots';
}

export interface Frame {
  /** the playhead, seconds on the turn clock */
  readonly time: number;
  /** seconds that keep running while the playhead holds; drives breathing, blinking and signal noise */
  readonly ambient: number;
  /** milliseconds since the epoch, frozen while paused, for looks that show a clock */
  readonly wallTime: number;
  readonly clock: ClockState;
  readonly viewport: Viewport;
  /** the preset the look drawn now stands on. During a change it is the old look's until `progress` reaches 0.5, then the new one's. */
  readonly look: LookId;
  /** the look drawn now, fully resolved: a preset as shipped, or the brain's own variation of one. Everything a renderer needs about colour, type, stroke and surface is here. */
  readonly spec: LookSpec;
  /** set while one look is giving way to another; `progress` runs 0..1 and the picture is cut over at 0.5 */
  readonly lookChange: { readonly from: LookId; readonly to: LookId; readonly progress: number } | null;
  /** body font size for this look on this viewport, stage units. A skin scales its grain from it: scanline pitch, pixel size, the height of a paper bar. */
  readonly bodySize: number;
  /** the empty border around the safe frame, CSS pixels: at least 16, however small the screen */
  readonly margin: number;
  /**
   * The scene's canvas as placed on the reading plane, stage units, and the size of one canvas unit there. A look that draws something
   * to line up with the picture (blueprint's squares) hangs it from `box`, so it meets the shapes to the pixel.
   */
  readonly canvas: { readonly box: Box; readonly unit: number };
  /** stage y of the top of the safe frame, where the painter's first line of text starts. A look that draws a grid to line up with the text (printout's bars) hangs it from here. */
  readonly gridTop: number;
  readonly ground: Colour;
  readonly camera: CameraPose;
  /** 0..1 from the mood: how nervous the signal is (noise, jitter, flicker) */
  readonly agitation: number;
  /** 0..1 from the mood: how much the whole picture is dimmed */
  readonly dim: number;
  readonly reducedMotion: boolean;
  /** text */
  readonly elements: readonly ElementFrame[];
  /** everything drawn: shapes, sprites, pictures. Within a layer, text and figures are drawn together in `z` order. */
  readonly figures: readonly FigureFrame[];
  /** the charts on stage. Absent means none: a frame from a painter with no charting engine never has any. */
  readonly charts?: readonly ChartFrame[];
  /** the tunes on stage, and which are whole and may be played: what a player is told. Absent means none. A renderer draws nothing for them; the roll is already in the figures. */
  readonly tunes?: readonly TuneCue[];
  /** atmosphere, drawn behind everything else on its layer */
  readonly fields: readonly FieldFrame[];
  readonly cursor: CursorFrame | null;
}
