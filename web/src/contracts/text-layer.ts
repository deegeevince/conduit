// v2.1: text out. The stage's words are drawn in WebGL, so they cannot be selected, copied or read by a screen reader as text in
// place. The chrome lays a transparent layer of real text over the stage, one element per run of words, each exactly where its
// drawn twin is (as a PDF viewer does). The painter says where the words are; the chrome owns the DOM.

import type { Box } from './space';

/** What a run of words is, for how it is copied: a heading becomes `# …`, a choice is left out of "copy answer", code keeps its spaces. */
export type TextRole = 'heading' | 'body' | 'aside' | 'choice' | 'label' | 'node' | 'cell' | 'code' | 'control';

/**
 * One wrapped line of one element as it is on screen now, camera included. `box` is the line as an upright rectangle in host CSS pixels
 * whose centre is where the drawn line's centre is; the span's `rotation` turns it about that centre. Its width is the drawn glyphs'.
 */
export interface TextLine {
  readonly text: string;
  /** host CSS pixels */
  readonly box: Box;
}

/**
 * fb-055. A label the brain drew that a tap can ask about (`say callout near=X`, `say label near=X`, a figure part's `label=`): what it says as written, the
 * id of the element (or figure part) that is the label, and what it names (the `near=` target, the figure a part is in), when it names one. One label can be
 * several spans (a figure sets each line of its words as an element of its own): they share `group`.
 */
export interface TextAsk {
  readonly label: string;
  readonly id: string;
  readonly on: string | null;
  readonly group: string;
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
  /** v2.1. A heading's level, 1 (the loudest) to 3; 0 for anything else */
  readonly level: number;
  /** v2.1. What the owner is when it is a structure (`table`, `chart`, `code`, `screen`...), else null: how its words are copied */
  readonly structure: string | null;
  /** v2.1. A code block's language as written; null for anything else */
  readonly lang: string | null;
  /**
   * v2.1. False for words that are the stage's but are not drawn as text a layer could sit on: a chart's rows, which its charting engine draws in
   * a canvas. `lines` is then empty: they are copied and read, not laid over the picture.
   */
  readonly placed: boolean;
  /** fb-055. Set when a tap on these words asks about what they label; absent for every other kind of words */
  readonly ask?: TextAsk;
  /** PLAN-maths M7. Set when the words are a typeset formula: `text` is its TeX, and the layer holds KaTeX's MathML for it, which a screen reader reads and a copy keeps as TeX */
  readonly formula?: { readonly tex: string; readonly display: boolean };
}

/** The element a key on stage belongs to: a structure's parts are `<owner>/<part>`, a mock-up's lines `<owner>/…#<n>`. */
export function ownerKeyOf(key: string): string {
  const slash = key.indexOf('/');
  const head = slash < 0 ? key : key.slice(0, slash);
  const hash = head.indexOf('#');
  return hash < 0 ? head : head.slice(0, hash);
}
