// Structures: the contract between the painter and the engines that lay out
// a flow, a tree, a cycle, a timeline, a map, a table, a chart, and the
// callouts on a free drawing.
//
// The brain names a structure and its parts. An engine decides where every
// part goes, how every connector runs and where every label sits, so that no
// two things collide. It returns boxes, outlines and text: the same things the
// painter already turns into frames. No renderer learns anything new.
//
// An engine is pure. It takes everything it needs as arguments (text is
// measured through a function it is handed), keeps nothing between calls,
// touches no DOM and reads no clock, so the same input always gives the same
// layout: on screen, in an exported film, and under `tsx` with no browser.
//
// STABILITY. A structure is laid out from every line of it that has ARRIVED,
// not from what the playhead has reached. The brain writes seconds ahead of
// the audience, so most of a diagram is known before its first node is seen.
// When a part does arrive after the layout has been shown, the engine must
// move what is already on stage as little as it can (the painter eases the
// rest): append along the growing axis, keep ranks and columns, never
// reshuffle what the viewer has read.

import type { ElementSpan, Face, LetterCase, Polyline, Range, Scope, SightNote, Size, Weight } from '@conduit/language';
import type { ElementFrame, FigureFrame } from './frame';
import type { Box } from './space';

/** How a piece of text is to be set. `shrink` is the engine's own request on top of the look's size (1: the look's size). */
export interface TextSpec {
  readonly size: Size;
  readonly weight: Weight;
  /** null: the look's own face */
  readonly face: Face | null;
  readonly letterCase: LetterCase;
  readonly shrink: number;
}

export interface MeasuredText {
  /** stage units */
  readonly width: number;
  readonly height: number;
  readonly lineHeight: number;
  /** how it broke, top to bottom */
  readonly lines: readonly { readonly text: string; readonly width: number }[];
}

/**
 * Sizes text exactly as the painter will set it: the look's face, the
 * advance tables, `foldText`, the size ladder. Handed in, so that an engine
 * imports no fonts and can be run with a stand-in.
 */
export type TextMeasure = (text: string, spec: TextSpec, maxWidth: number) => MeasuredText;

/** What the look gives a structure, in stage units. */
export interface BlockLook {
  /** the height of a line of body text */
  readonly body: number;
  /** text may be shrunk to this share of its size and no further; below it the engine reports `crowded` instead */
  readonly minShrink: number;
  /** the look's stroke thickness */
  readonly stroke: number;
  /** corner radius of a box, 0 in the looks whose machine had none */
  readonly radius: number;
  /** true where everything sits on a character grid (the fixed-pitch looks): boxes and gaps snap to `cell` */
  readonly grid: { readonly cell: { readonly width: number; readonly height: number } } | null;
}

export interface StructureInput {
  /** the structure element; its `figure.kind` is `structure` */
  readonly structure: ElementSpan;
  /** its nodes, in the order they were written, whether or not the playhead has reached them */
  readonly nodes: readonly ElementSpan[];
  /** its links (those a `node from=` made, and those `link` made), in the order written */
  readonly links: readonly ElementSpan[];
  /** the room it is given, in stage units on its layer's plane with the camera at rest */
  readonly room: Box;
  /** where canvas (0,0) is and how big a canvas unit is, in the same stage units: a map's pins are written in canvas units */
  readonly canvas: { readonly origin: { readonly x: number; readonly y: number }; readonly unit: number };
  readonly measure: TextMeasure;
  readonly look: BlockLook;
  /** the number every control holds now: what a `{…}` in a chart cell or in a node's words is worked out from */
  readonly scope: Scope;
  /** boxes inside the room that parts and labels must keep clear of: the brain's own drawing under a map, text the layout has placed */
  readonly obstacles: readonly Box[];
}

/**
 * Something to draw for a structure. It belongs to the element whose key is
 * `owner`: it enters, leaves, is restyled, pointed at and tapped as that
 * element is. `part` tells the parts of one owner apart and must not change
 * between layouts of the same structure (`box`, `head`, `bar`, `tick:3`), so
 * that a renderer can keep what it has built.
 */
export type BlockPart =
  | {
      readonly kind: 'shape';
      readonly owner: string;
      readonly part: string;
      /** stage units, in the room's own coordinates */
      readonly outline: readonly Polyline[];
      /**
       * What it is, which decides its colours from the owner's style and the look:
       * `frame` (an outline round a node), `fill` (its ground), `line` (a
       * connector, a leader, an axis), `head` (an arrowhead), `grid` (a tick, a
       * rule: drawn in `dim`), `bar` (a bar or column of a chart), `marker` (a
       * pin, a point, a dot on a timeline), and, for a tune's roll, `note` (a note of the first voice: the look's accent), `note2` (of the
       * second: its alt) and `lit` (a note sounding now).
       */
      readonly role: 'frame' | 'fill' | 'line' | 'head' | 'grid' | 'bar' | 'marker' | 'note' | 'note2' | 'lit';
      /** the row of a table or a chart it belongs to: it lands when that row does. Absent: it comes with its owner. */
      readonly row?: number;
      /** a dashed line is already cut into dashes here, as separate polylines */
    }
  | {
      readonly kind: 'text';
      readonly owner: string;
      readonly part: string;
      readonly text: string;
      readonly emphasis: readonly Range[];
      /** where the text block goes: its box, stage units */
      readonly box: Box;
      readonly spec: TextSpec;
      readonly align: 'left' | 'center' | 'right';
      /**
       * `words` (a node's own words), `label` (on a link, beside a pin, a
       * callout), `title`, `header` and `cell` (a table), `tick` and `value`
       * (a chart or a timeline: drawn in `dim`).
       */
      readonly role: 'words' | 'label' | 'title' | 'header' | 'cell' | 'tick' | 'value';
      readonly row?: number;
      /** true when the text sits on something drawn and needs the ground behind it to stay readable (a label on a link) */
      readonly plate: boolean;
    };

/**
 * v2.2. A structure that is drawn as finished frames in stage units, not as `BlockPart`s: the interface kit's screens have fills, edges,
 * shadows, clips and photographs that a part has no words for. The painter hands these to the renderer as they are, a row at a time as the
 * rows land (`rowOf` says which row of the structure each figure and element belongs to, by key).
 */
export interface DrawnFrames {
  readonly figures: readonly FigureFrame[];
  readonly elements: readonly ElementFrame[];
  readonly rowOf: ReadonlyMap<string, number>;
  /** the smallest type on it, in stage units: what sight judges legibility by */
  readonly fontPx: number;
}

export interface StructureLayout {
  /** v2.2: set by a structure that draws itself (see `DrawnFrames`); `parts` is then empty */
  readonly drawn?: DrawnFrames;
  /** every node's and link's box by element key, and the structure's own under its key: what sight reports, what `cam focus` frames, what a tap hits */
  readonly boxes: ReadonlyMap<string, Box>;
  /** what to draw, back to front */
  readonly parts: readonly BlockPart[];
  /** the route of each link by key, from the node it leaves to the node it reaches: what draws itself, and what `move along=` rides */
  readonly routes: ReadonlyMap<string, Polyline>;
  /** what could not be kept clear or made to fit, for sight: `crowded`, `crossed`, `clipped` */
  readonly notes: readonly { readonly key: string; readonly note: SightNote }[];
  /** 1 when everything is at the look's size; less when the structure was shrunk to fit its room */
  readonly shrink: number;
  /** how far it stands outside its room, as shares of the room's width and height added, when it does even at the least size it is ever set at (absent or 0: it fits): the engines prefer any arrangement that fits, then the one that overflows least */
  readonly overflows?: number;
}

/** Lays out one structure. Every structure kind in `STRUCTURES_READY` must be handled; any other returns an empty layout. */
export type StructureEngine = (input: StructureInput) => StructureLayout;

/** A label with a leader line (`say callout near=<id>` or `at=x,y`), as the callout engine is handed it. */
export interface CalloutInput {
  /** the labels of one scene and one layer, in the order written */
  readonly labels: readonly {
    readonly key: string;
    /** its text block, already measured at its style */
    readonly size: { readonly width: number; readonly height: number };
    /** what it names: the box of the element, or the point, in stage units */
    readonly target: Box | { readonly x: number; readonly y: number };
    /** the side the brain asked for, or `auto` */
    readonly side: 'auto' | 'above' | 'below' | 'left' | 'right';
    /** v2.1: the target's own outline, in stage units, when it has one: the leader ends on the edge of the shape, not of its box */
    readonly outline?: Polyline;
    /** v2.1: the target is a filled shape, so a leader may end inside it; a bare outline is touched at its edge */
    readonly filled?: boolean;
  }[];
  /** the box of the drawing the labels are about: labels go round it, not on it */
  readonly figure: Box;
  /** where labels may go */
  readonly room: Box;
  /** text and drawn things the labels and their leaders must keep clear of */
  readonly obstacles: readonly Box[];
  /** outlines a leader may cross only at its target: every stroke the brain drew, as polylines in stage units */
  readonly strokes: readonly Polyline[];
  /** v2.1: every filled closed shape of the drawing, as polygons in stage units: ink a label must not sit on, though no stroke of it is touched */
  readonly fills?: readonly Polyline[];
  /** v2.1: the smallest scale the labels' type may be shrunk to (1 = never); under it a label is not made smaller */
  readonly floorScale?: number;
  readonly look: BlockLook;
}

export interface CalloutLayout {
  /** where each label's box goes, by key */
  readonly boxes: ReadonlyMap<string, Box>;
  /** each label's leader, by key: from the edge of the label to the edge of its target, never across another leader */
  readonly leaders: ReadonlyMap<string, Polyline>;
  /** labels that could not be placed clear, or whose leader has to cross a stroke: `collides`, `crossed` */
  readonly notes: readonly { readonly key: string; readonly note: SightNote }[];
  /** v2.1: a label that had to be set smaller to find clear room, as the scale of its type (absent = as measured) */
  readonly scales?: ReadonlyMap<string, number>;
}

/** Places all the callouts of a drawing together, so that their leaders never cross and no label sits on a stroke. */
export type CalloutEngine = (input: CalloutInput) => CalloutLayout;

export const EMPTY_STRUCTURE_LAYOUT: StructureLayout = { boxes: new Map(), parts: [], routes: new Map(), notes: [], shrink: 1 };
export const EMPTY_CALLOUT_LAYOUT: CalloutLayout = { boxes: new Map(), leaders: new Map(), notes: [] };
