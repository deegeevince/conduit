// Expressions over the controls on stage: what `{…}` means inside text and
// inside a cell of a chart.
//
// A control holds a value; a name in an expression is the id of a control and
// stands for that value as a number (a slider: its number; a toggle: 1 or 0; a
// pick: the 1-based number of the option chosen). The painter evaluates an
// expression every frame from the controls' values, so a sentence or a chart
// follows a slider with no round trip to the brain.
//
// It is arithmetic and nothing else: no assignment, no loops, no access to
// anything but the numbers it is given. It is parsed here, once, by hand; it is
// never handed to `eval` or `Function`.

import type { ControlValue } from './types';

/** The value of every name an expression may use: control ids, by number. */
export type Scope = Readonly<Record<string, number>>;

export type Expr =
  | { readonly op: 'number'; readonly value: number }
  | { readonly op: 'name'; readonly name: string }
  | { readonly op: 'negate'; readonly of: Expr }
  | { readonly op: 'binary'; readonly operator: BinaryOperator; readonly left: Expr; readonly right: Expr }
  | { readonly op: 'call'; readonly fn: FunctionName; readonly args: readonly Expr[] };

type BinaryOperator = '+' | '-' | '*' | '/' | '%' | '^' | '<' | '>' | '<=' | '>=' | '==' | '!=';

/** The functions an expression may call, with what each means. Angles are in radians, as everywhere in mathematics; `rad` and `deg` convert. */
export const EXPR_FUNCTION = {
  sin: 'sine of an angle in radians',
  cos: 'cosine',
  tan: 'tangent',
  asin: 'inverse sine, in radians',
  acos: 'inverse cosine',
  atan: 'inverse tangent',
  rad: 'degrees to radians',
  deg: 'radians to degrees',
  sqrt: 'square root',
  abs: 'size without sign',
  sign: '-1, 0 or 1',
  round: 'to the nearest whole number; round(x, n) to n decimals',
  floor: 'down to a whole number',
  ceil: 'up to a whole number',
  min: 'the smallest of its arguments',
  max: 'the largest of its arguments',
  clamp: 'clamp(x, low, high)',
  pow: 'pow(x, y) is x to the power y',
  exp: 'e to the power x',
  log: 'natural logarithm; log(x, base) in another base',
  if: 'if(test, then, otherwise)',
} as const;
export type FunctionName = keyof typeof EXPR_FUNCTION;

const CONSTANTS: Readonly<Record<string, number>> = { pi: Math.PI, e: Math.E };

/** Longest expression read; a brain that writes more than this in one pair of braces has mistaken the stage for a spreadsheet. */
const MAX_SOURCE = 160;
const MAX_DEPTH = 24;

const PRECEDENCE: Readonly<Record<BinaryOperator, number>> = { '==': 1, '!=': 1, '<': 2, '>': 2, '<=': 2, '>=': 2, '+': 3, '-': 3, '*': 4, '/': 4, '%': 4, '^': 6 };

type Token = { readonly kind: 'number'; readonly value: number } | { readonly kind: 'name'; readonly name: string } | { readonly kind: 'symbol'; readonly symbol: string };

function tokenize(source: string): Token[] | null {
  const tokens: Token[] = [];
  // A name here is letters, digits and underscores. An id may also hold a hyphen, but in arithmetic a hyphen is a minus,
  // so a control that is computed with is named in one word (`rate`, `max_speed`).
  const pattern = /\s*(?:(\d+\.?\d*|\.\d+)|([a-zA-Z][a-zA-Z0-9_]*)|(<=|>=|==|!=|[-+*/%^<>(),]))/y;
  let index = 0;
  const trimmed = source.trimEnd();
  while (index < trimmed.length) {
    pattern.lastIndex = index;
    const match = pattern.exec(trimmed);
    if (match === null) return null;
    if (match[1] !== undefined) tokens.push({ kind: 'number', value: Number(match[1]) });
    else if (match[2] !== undefined) tokens.push({ kind: 'name', name: match[2].toLowerCase() });
    else if (match[3] !== undefined) tokens.push({ kind: 'symbol', symbol: match[3] });
    index = pattern.lastIndex;
  }
  return tokens;
}

function isFunctionName(name: string): name is FunctionName {
  return Object.hasOwn(EXPR_FUNCTION, name);
}

/** Reads an expression. Null when it is not one: the caller then treats the braces as ordinary text. */
export function parseExpr(source: string): Expr | null {
  if (source.length > MAX_SOURCE) return null;
  const tokens = tokenize(source);
  if (tokens === null || tokens.length === 0) return null;
  let position = 0;
  const peek = (): Token | undefined => tokens[position];
  const symbol = (value: string): boolean => {
    const token = peek();
    if (token?.kind === 'symbol' && token.symbol === value) {
      position += 1;
      return true;
    }
    return false;
  };

  const primary = (depth: number): Expr | null => {
    if (depth > MAX_DEPTH) return null;
    const token = peek();
    if (token === undefined) return null;
    position += 1;
    if (token.kind === 'number') return { op: 'number', value: token.value };
    if (token.kind === 'symbol') {
      if (token.symbol === '-') {
        const of = binary(5, depth + 1);
        return of === null ? null : { op: 'negate', of };
      }
      if (token.symbol === '(') {
        const inner = binary(0, depth + 1);
        return inner !== null && symbol(')') ? inner : null;
      }
      return null;
    }
    if (isFunctionName(token.name) && symbol('(')) {
      const args: Expr[] = [];
      if (!symbol(')')) {
        do {
          const argument = binary(0, depth + 1);
          if (argument === null) return null;
          args.push(argument);
        } while (symbol(','));
        if (!symbol(')')) return null;
      }
      return args.length === 0 || args.length > 4 ? null : { op: 'call', fn: token.name, args };
    }
    return { op: 'name', name: token.name };
  };

  const binary = (floor: number, depth: number): Expr | null => {
    let left = primary(depth);
    for (;;) {
      if (left === null) return null;
      const token = peek();
      if (token?.kind !== 'symbol' || !Object.hasOwn(PRECEDENCE, token.symbol)) return left;
      const operator = token.symbol as BinaryOperator;
      const weight = PRECEDENCE[operator];
      if (weight < floor) return left;
      position += 1;
      // `^` binds to the right (2^3^2 is 2^9); everything else to the left.
      const right = binary(operator === '^' ? weight : weight + 1, depth + 1);
      if (right === null) return null;
      left = { op: 'binary', operator, left, right };
    }
  };

  const parsed = binary(0, 0);
  return parsed !== null && position === tokens.length ? parsed : null;
}

function call(fn: FunctionName, a: readonly number[]): number {
  const [x = Number.NaN, y, z] = a;
  switch (fn) {
    case 'sin':
      return Math.sin(x);
    case 'cos':
      return Math.cos(x);
    case 'tan':
      return Math.tan(x);
    case 'asin':
      return Math.asin(x);
    case 'acos':
      return Math.acos(x);
    case 'atan':
      return y === undefined ? Math.atan(x) : Math.atan2(x, y);
    case 'rad':
      return (x * Math.PI) / 180;
    case 'deg':
      return (x * 180) / Math.PI;
    case 'sqrt':
      return Math.sqrt(x);
    case 'abs':
      return Math.abs(x);
    case 'sign':
      return Math.sign(x);
    case 'round': {
      const scale = 10 ** Math.min(6, Math.max(0, Math.round(y ?? 0)));
      return Math.round(x * scale) / scale;
    }
    case 'floor':
      return Math.floor(x);
    case 'ceil':
      return Math.ceil(x);
    case 'min':
      return Math.min(...a);
    case 'max':
      return Math.max(...a);
    case 'clamp':
      return y === undefined || z === undefined ? x : Math.min(Math.max(x, Math.min(y, z)), Math.max(y, z));
    case 'pow':
      return y === undefined ? x : x ** y;
    case 'exp':
      return Math.exp(x);
    case 'log':
      return y === undefined ? Math.log(x) : Math.log(x) / Math.log(y);
    case 'if':
      return x !== 0 && !Number.isNaN(x) ? (y ?? Number.NaN) : (z ?? Number.NaN);
  }
}

/** The value of an expression. A name nobody defined, or arithmetic with no answer, gives NaN, which `formatValue` shows as a dash. */
export function evalExpr(expr: Expr, scope: Scope): number {
  switch (expr.op) {
    case 'number':
      return expr.value;
    case 'name':
      return Object.hasOwn(scope, expr.name) ? (scope[expr.name] ?? Number.NaN) : (CONSTANTS[expr.name] ?? Number.NaN);
    case 'negate':
      return -evalExpr(expr.of, scope);
    case 'call':
      return call(
        expr.fn,
        expr.args.map((argument) => evalExpr(argument, scope)),
      );
    case 'binary': {
      const left = evalExpr(expr.left, scope);
      const right = evalExpr(expr.right, scope);
      switch (expr.operator) {
        case '+':
          return left + right;
        case '-':
          return left - right;
        case '*':
          return left * right;
        case '/':
          return left / right;
        case '%':
          return left % right;
        case '^':
          return left ** right;
        case '<':
          return left < right ? 1 : 0;
        case '>':
          return left > right ? 1 : 0;
        case '<=':
          return left <= right ? 1 : 0;
        case '>=':
          return left >= right ? 1 : 0;
        case '==':
          return left === right ? 1 : 0;
        case '!=':
          return left !== right ? 1 : 0;
      }
    }
  }
}

/** The names an expression uses that are not constants: the controls it depends on. */
export function namesIn(expr: Expr): string[] {
  const found = new Set<string>();
  const walk = (node: Expr): void => {
    if (node.op === 'name' && !Object.hasOwn(CONSTANTS, node.name)) found.add(node.name);
    else if (node.op === 'negate') walk(node.of);
    else if (node.op === 'binary') {
      walk(node.left);
      walk(node.right);
    } else if (node.op === 'call') node.args.forEach(walk);
  };
  walk(expr);
  return [...found];
}

/** A control's value as the number an expression uses. An input's text is a number when it reads as one. */
export function numberOf(value: ControlValue | null): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === null || value.trim() === '') return Number.NaN;
  return Number(value);
}

/**
 * A number as text on stage. `digits` decimals when given; otherwise as few as
 * say it (at most two), so 30 is "30" and 0.333… is "0.33". No answer is a dash.
 */
export function formatValue(value: number, digits: number | null = null): string {
  if (!Number.isFinite(value)) return '-';
  if (digits !== null) return value.toFixed(Math.min(6, Math.max(0, digits)));
  return String(Number(value.toFixed(2)));
}

export type TemplatePart =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'value';
      /** the braces as written, shown as they are when the expression has no answer to give */
      readonly source: string;
      readonly expr: Expr;
      /** decimals asked for with `{expr:2}`; null: as few as say it */
      readonly digits: number | null;
      /** set when the braces hold one name and nothing else: the painter then shows that control's own words (an option's text, `on`, a slider's number with its unit) */
      readonly name: string | null;
    };

const BRACES = /\{([^{}]{1,200})\}/g;

/**
 * Splits text into plain runs and `{…}` values. Braces are a value only when
 * what they hold reads as an expression and every name in it is known (the id
 * of a control on stage); anything else is left exactly as written, so code,
 * JSON and set notation in an answer are never mistaken for arithmetic.
 */
export function parseTemplate(text: string, known: (name: string) => boolean): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let last = 0;
  for (const match of text.matchAll(BRACES)) {
    const inner = match[1] ?? '';
    const colon = /^(.*):\s*(\d)\s*$/.exec(inner);
    const source = colon === null ? inner : (colon[1] ?? inner);
    const expr = parseExpr(source);
    if (expr === null) continue;
    const names = namesIn(expr);
    if (names.length === 0 || !names.every(known)) continue;
    const start = match.index;
    if (start > last) parts.push({ kind: 'text', text: text.slice(last, start) });
    parts.push({ kind: 'value', source: match[0], expr, digits: colon === null ? null : Number(colon[2]), name: expr.op === 'name' ? expr.name : null });
    last = start + match[0].length;
  }
  if (last < text.length || parts.length === 0) parts.push({ kind: 'text', text: text.slice(last) });
  return parts;
}

/** Whether text holds anything that follows a control: the painter re-sets such text when a value changes, and never otherwise. */
export function hasValues(parts: readonly TemplatePart[]): boolean {
  return parts.some((part) => part.kind === 'value');
}
