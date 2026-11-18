// The page's side of a typeset formula: what the painter asks of it (`FormulaHost`, `painter/formula.ts`) and what the renderers draw from.
//
// The painter asks for a formula's size and is told when it is known. KaTeX is loaded the first time one is asked for, as a chunk of its own (`typeset.ts`), so a page
// that never shows a formula never has it; the formula is then set once, measured in the browser's own layout, and kept, and everything after is a lookup.
//
//   known / want    the painter's: the size, in ems, or the fault KaTeX found
//   canvasOf        the WebGL renderer's and the vector export's: the formula on a 2D canvas (a glyph box, a rule and a path at a time), cached by size and colour
//   htmlOf          the plain renderer's: KaTeX's markup
//   mathmlOf        the text layer's: KaTeX's MathML
//   settled         resolves once every formula asked for is set (what a check waits on)

import { announceFormulas, setFormulaHost } from '../../painter/formula';
import type { FormulaHost, FormulaSize } from '../../painter/formula';
import { drawFormula } from './drawing';
import type { FormulaDrawing } from './drawing';

interface Held {
  readonly size: FormulaSize;
  readonly fault: string | null;
  readonly html: string;
  readonly mathml: string;
  readonly drawing: FormulaDrawing | null;
  readonly origin: { readonly x: number; readonly y: number };
}

const keyOf = (tex: string, display: boolean): string => `${display ? 'd' : 'i'}\u0000${tex}`;

const records = new Map<string, Held>();
const asked = new Set<string>();
let chain: Promise<void> = Promise.resolve();
let installed = false;

const canvases = new Map<string, HTMLCanvasElement>();
const KEPT_CANVASES = 48;

async function set(list: readonly { readonly tex: string; readonly display: boolean }[]): Promise<void> {
  let module: typeof import('./typeset') | null = null;
  try {
    module = await import('./typeset');
  } catch {
    module = null;
  }
  for (const { tex, display } of list) {
    const key = keyOf(tex, display);
    if (records.has(key)) continue;
    const nothing = { width: 0, height: 0, depth: 0 };
    if (module === null) {
      records.set(key, { size: nothing, fault: 'the typesetter could not be loaded', html: '', mathml: '', drawing: null, origin: { x: 0, y: 0 } });
      continue;
    }
    try {
      const made = await module.typesetFormula(tex, display);
      if ('fault' in made) records.set(key, { size: nothing, fault: made.fault, html: '', mathml: '', drawing: null, origin: { x: 0, y: 0 } });
      else records.set(key, { size: { width: made.drawing.width, height: made.drawing.height, depth: made.drawing.depth }, fault: null, html: made.html, mathml: made.mathml, drawing: made.drawing, origin: made.origin });
    } catch (error) {
      records.set(key, { size: nothing, fault: error instanceof Error ? error.message : String(error), html: '', mathml: '', drawing: null, origin: { x: 0, y: 0 } });
    }
  }
}

const host: FormulaHost = {
  known(tex, display) {
    const found = records.get(keyOf(tex, display));
    return found === undefined ? null : { ...found.size, fault: found.fault };
  },
  want(requests) {
    const fresh = requests.filter(({ tex, display }) => !records.has(keyOf(tex, display)) && !asked.has(keyOf(tex, display)));
    if (fresh.length === 0) return;
    for (const { tex, display } of fresh) asked.add(keyOf(tex, display));
    chain = chain.then(async () => {
      await set(fresh);
      for (const { tex, display } of fresh) asked.delete(keyOf(tex, display));
      announceFormulas();
    });
  },
};

/** Makes this page the one that sets formulas for the painter. Once; the page's `main` calls it. */
export function installFormulas(): void {
  if (installed) return;
  installed = true;
  setFormulaHost(host);
}

/** Resolves when every formula asked for so far is set. */
export function settledFormulas(): Promise<void> {
  return chain;
}

/** A formula the painter has set, for a renderer: null while KaTeX has not set it, or when it could not. */
export function formulaRecord(tex: string, display: boolean): Pick<Held, 'size' | 'html' | 'mathml' | 'origin'> | null {
  const found = records.get(keyOf(tex, display));
  return found === undefined || found.fault !== null ? null : found;
}

/** The formula as a canvas, `emPx` pixels to the em, in one colour (the WebGL renderer draws it white and tints the plane, the export draws it in the ink). Null while it is not set. */
export function formulaCanvas(tex: string, display: boolean, emPx: number, colour: string): HTMLCanvasElement | null {
  const found = records.get(keyOf(tex, display));
  if (found === undefined || found.drawing === null) return null;
  const key = `${keyOf(tex, display)}\u0000${emPx}\u0000${colour}`;
  let canvas = canvases.get(key);
  if (canvas === undefined) {
    canvas = drawFormula(found.drawing, emPx, colour);
    canvases.set(key, canvas);
    if (canvases.size > KEPT_CANVASES) canvases.delete(canvases.keys().next().value as string);
  }
  return canvas;
}

/** KaTeX's MathML for the formula, `<math>…</math>`: null while it is not set. */
export function formulaMathML(tex: string, display: boolean): string | null {
  const found = records.get(keyOf(tex, display));
  if (found === undefined || found.fault !== null) return null;
  const inner = /<math[\s\S]*<\/math>/.exec(found.mathml);
  return inner === null ? null : inner[0];
}

/** The formulas that are set, for the test hook: the TeX, whether KaTeX read it, its size and the words of the fault. */
export function formulasKnown(): readonly { readonly tex: string; readonly display: boolean; readonly fault: string | null; readonly size: FormulaSize }[] {
  return [...records].map(([key, record]) => ({ tex: key.slice(2), display: key.startsWith('d'), fault: record.fault, size: record.size }));
}
