// `{…}` in text. The braces are read once per element (`parseTemplate` in the
// language), the values are worked out every frame from what the controls
// hold. Text with nothing in braces that names a control costs nothing: it
// compiles to a single run and `reactive` is false, so the painter never
// re-sets it.

import { evalExpr, formatValue, hasValues, numberOf, parseTemplate, controlText } from '@conduit/language';
import type { ControlSpec, ControlValue, Expr, Range, Scope, TemplatePart } from '@conduit/language';

export interface Template {
  readonly parts: readonly TemplatePart[];
  /** names the text depends on: the ids of controls */
  readonly names: readonly string[];
  /** true when any brace holds a value: the text must be re-set when a control changes */
  readonly reactive: boolean;
}

/** What a template is worked out from: a control's spec and what it holds, by id. */
export type ControlLookup = (id: string) => { readonly spec: ControlSpec; readonly value: ControlValue | null } | null;

function namesOf(parts: readonly TemplatePart[]): string[] {
  const out = new Set<string>();
  const walk = (node: Expr): void => {
    if (node.op === 'name') out.add(node.name);
    else if (node.op === 'negate') walk(node.of);
    else if (node.op === 'binary') {
      walk(node.left);
      walk(node.right);
    } else if (node.op === 'call') node.args.forEach(walk);
  };
  for (const part of parts) if (part.kind === 'value') walk(part.expr);
  return [...out];
}

/** Reads the braces of `text` against the ids on stage. `known` must be the same answer for the life of the element. */
export function compileTemplate(text: string, known: (id: string) => boolean): Template {
  if (!text.includes('{')) return { parts: [{ kind: 'text', text }], names: [], reactive: false };
  const parts = parseTemplate(text, known);
  return { parts, names: namesOf(parts), reactive: hasValues(parts) };
}

/** The scope an expression is worked out in: every control's value as a number. */
export function scopeOf(ids: readonly string[], lookup: ControlLookup): Scope {
  const scope: Record<string, number> = {};
  for (const id of ids) {
    const found = lookup(id);
    if (found !== null) scope[id] = numberOf(found.value ?? found.spec.value ?? found.spec.min);
  }
  return scope;
}

export interface RenderedTemplate {
  readonly text: string;
  /** the emphasis ranges of the source, moved to where they now fall */
  readonly emphasis: readonly Range[];
}

/**
 * The text as it reads now. A brace holding one control's name shows that
 * control's own words (an option's text, `on`, a slider's number and unit);
 * any other expression shows its number as few decimals as say it, or as many
 * as `{x:2}` asked. A brace with no answer (a name that left the stage, a
 * division by nothing) shows a dash, never the brace.
 */
export function renderTemplate(template: Template, source: string, emphasis: readonly Range[], lookup: ControlLookup): RenderedTemplate {
  if (!template.reactive) return { text: source, emphasis };
  const scope = scopeOf(template.names, lookup);
  let out = '';
  // source offsets of each part's start, and where that part starts in the output
  const map: { readonly from: number; readonly to: number; readonly outFrom: number; readonly outTo: number }[] = [];
  let at = 0;
  for (const part of template.parts) {
    const start = out.length;
    let shown: string;
    if (part.kind === 'text') shown = part.text;
    else if (part.name !== null && part.digits === null) {
      const found = lookup(part.name);
      shown = found === null ? '-' : controlText(found.spec, found.value ?? found.spec.value);
    } else {
      const value = evalExpr(part.expr, scope);
      shown = formatValue(value, part.digits);
    }
    out += shown;
    const length = part.kind === 'text' ? part.text.length : part.source.length;
    map.push({ from: at, to: at + length, outFrom: start, outTo: out.length });
    at += length;
  }
  const move = (offset: number, end: boolean): number => {
    for (const piece of map) {
      if (offset < piece.from || offset > piece.to) continue;
      if (offset === piece.to && !end && piece.to !== piece.from) continue;
      if (piece.outTo - piece.outFrom === piece.to - piece.from) return piece.outFrom + (offset - piece.from);
      return end ? piece.outTo : piece.outFrom;
    }
    return out.length;
  };
  return { text: out, emphasis: emphasis.map((range) => ({ start: move(range.start, false), end: Math.max(move(range.start, false), move(range.end, true)) })) };
}
