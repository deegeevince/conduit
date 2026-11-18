// A typeset formula as the painter knows it (PLAN-maths M7). The painter is pure and sets no TeX: KaTeX sets it, in the browser, as a lazy chunk, and the page
// measures what it set. So the painter asks here for a formula's size, in ems of the font it will be set at, and is told when the page knows more:
//
//   facts(tex, display)   what is known of a formula: its size, or the fault KaTeX found. Until the page has measured it, an estimate from the characters
//                         (`exact: false`); the layout is made again when the page says it knows (`onFormulaChange`), so the estimate only holds a place.
//   the host              the page's side (`render/formula/host.ts`): it loads KaTeX, sets and measures each formula that was asked for, and keeps what the
//                         renderers draw. Without one (the server, a bench under `tsx`) nothing is ever exact, which is why a turn that holds a formula is
//                         the page's to measure (`measurable`, `server/src/domain/stage-facts.ts`), as a script the faces lack is.
//
// Units: ems of the container the formula is set in. KaTeX sets its own text at 1.21 of that (its stylesheet's choice), and the sizes here already hold it.

/** A formula's box, in ems: `height` is the whole of it, and `depth` is how much of that hangs below the baseline. */
export interface FormulaSize {
  readonly width: number;
  readonly height: number;
  readonly depth: number;
}

/** What is known of one formula. A `fault` is KaTeX's own words for what it could not read: the source is then set as text. */
export interface FormulaFacts extends FormulaSize {
  readonly exact: boolean;
  readonly fault: string | null;
}

/** The page's side of it. `known` answers at once from what has been set; `want` asks for what has not been, and the host says when it has (`announceFormulas`). */
export interface FormulaHost {
  known(tex: string, display: boolean): (FormulaSize & { readonly fault: string | null }) | null;
  want(requests: readonly { readonly tex: string; readonly display: boolean }[]): void;
}

let host: FormulaHost | null = null;
let revision = 0;
const listeners = new Set<() => void>();
const wanted = new Map<string, { readonly tex: string; readonly display: boolean }>();
let asking = false;

const keyOf = (tex: string, display: boolean): string => `${display ? 'd' : 'i'}\u0000${tex}`;

/** The page's own host, or null (the server: nothing is set there). */
export function setFormulaHost(next: FormulaHost | null): void {
  host = next;
  revision += 1;
}

/** Whether a page is there to set formulas: what a renderer that draws them waits on. */
export const hasFormulaHost = (): boolean => host !== null;

/** What a layout that holds a formula is remembered by, apart from its words: it changes when the page has set more of them. */
export const formulaRev = (): number => revision;

/** The page knows more formulas than it did: every layout that held one is made again. Called by the host. */
export function announceFormulas(): void {
  revision += 1;
  for (const listen of [...listeners]) listen();
}

/** Calls `listen` whenever the page has set more formulas; returns how to stop. */
export function onFormulaChange(listen: () => void): () => void {
  listeners.add(listen);
  return () => listeners.delete(listen);
}

/** A glance at the TeX for its size: the characters that print, scaled for what stands over what. Only a place-holder until the page has measured it. */
export function estimateFormula(tex: string, display: boolean): FormulaSize {
  const words = tex.replace(/\\(?:text|mathrm|mathbf|mathit|operatorname)\s*\{([^{}]*)\}/g, (_all, inner: string) => inner);
  const stacked = (words.match(/\\(?:frac|dfrac|tfrac|binom)\b/g) ?? []).length;
  const roots = (words.match(/\\sqrt\b/g) ?? []).length;
  const big = (words.match(/\\(?:sum|prod|int|oint|lim)\b/g) ?? []).length;
  const raised = (words.match(/[\^_]/g) ?? []).length;
  const glyphs = words
    .replace(/\\(?:left|right|big|Big|bigg|Bigg|displaystyle|textstyle)\b/g, '')
    .replace(/\\[,;:! ]|\\q?quad\b/g, ' ')
    .replace(/\\[a-zA-Z]+/g, 'M')
    .replace(/[{}^_]/g, '');
  const count = [...glyphs].length;
  // a stacked fraction is as wide as the wider of its two lines, not the sum: take the glyphs of the longer half as the fraction's share
  const fractions = [...words.matchAll(/\\(?:frac|dfrac|tfrac)\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g)];
  let saved = 0;
  for (const found of fractions) saved += Math.min([...(found[1] ?? '')].length, [...(found[2] ?? '')].length) * 0.8;
  const width = Math.max(0.8, (count - saved) * 0.62 + stacked * 0.3 + roots * 0.9 + big * 0.5);
  const tall = stacked > 0 || big > 0 || roots > 0;
  const height = (tall ? (display ? 2.55 : 1.9) : 1.4) + (raised > 0 && !tall ? 0.45 : 0) + Math.max(0, stacked - 1) * 0.3;
  return { width, height, depth: tall ? height * 0.42 : 0.3 };
}

/** What is known of a formula now. A formula the page has not set is asked for, and answered with the estimate. */
export function formulaFacts(tex: string, display: boolean): FormulaFacts {
  const known = host?.known(tex, display) ?? null;
  if (known !== null) return { ...known, exact: true };
  if (host !== null) {
    wanted.set(keyOf(tex, display), { tex, display });
    if (!asking) {
      asking = true;
      void Promise.resolve().then(() => {
        asking = false;
        const list = [...wanted.values()];
        wanted.clear();
        if (list.length > 0) host?.want(list);
      });
    }
  }
  return { ...estimateFormula(tex, display), exact: false, fault: null };
}
