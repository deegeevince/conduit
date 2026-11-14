// v2.1: text out. The stage's words are drawn in WebGL, so they cannot be selected, copied or read by a screen reader as text in
// place. The chrome lays a transparent layer of real text over the stage, one element per run of words, each exactly where its
// drawn twin is (as a PDF viewer does). The painter says where the words are; the chrome owns the DOM.

import type { Box } from './space';

/** What a run of words is, for how it is copied: a heading becomes `# …`, a choice is left out of "copy answer", code keeps its spaces. */
export type TextRole = 'heading' | 'body' | 'aside' | 'choice' | 'label' | 'node' | 'cell' | 'code' | 'control';

/** One wrapped line of one element as it is on screen now, camera included. */
export interface TextLine {
  readonly text: string;
  /** host CSS pixels */
  readonly box: Box;
}

/** The words of one element on stage, for the text layer. */
export interface TextSpanView {
  /** the element's key; a structure's parts are `<key>/<part>` */
  readonly key: string;
  readonly id: string;
  readonly role: TextRole;
  /** the element's whole text, unwrapped: what is copied */
  readonly text: string;
  readonly lines: readonly TextLine[];
  readonly fontPx: number;
  /** CSS font family and weight the layer sets its invisible twin in, so that a selection's highlight covers the drawn glyphs */
  readonly family: string;
  readonly bold: boolean;
  /** degrees; a twin of rotated words is rotated with them */
  readonly rotation: number;
  /** reading order over the whole stage: top to bottom within a block, blocks in the order they were written */
  readonly order: number;
  /** for `cell` and `node`: the structure it belongs to and its row and column, so that a table is copied as a table */
  readonly within: { readonly key: string; readonly row: number; readonly column: number } | null;
}
