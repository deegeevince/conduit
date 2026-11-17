// The painter's tokenizer for a `code` block: one pass over the lines, no grammar. It knows the comments, the strings, the numbers and the
// reserved words of the languages a brain names (`CODE_LANGUAGES`), well enough to tell them apart by colour, and shows every other word as plain
// text. A language it does not know (`lang=elvish`) is plain text throughout, which is what the vocabulary says it does.
//
// Pure: lines in, tones out. A block comment or a triple-quoted string that runs over several lines is carried from one line to the next.

/** What a stretch of a line is, which decides its colour: a reserved word (the accent), a string or a number (the alt), a comment (dim), the rest (ink). */
export type Tone = 'plain' | 'keyword' | 'literal' | 'comment';

export interface Token {
  /** column of its first character */
  readonly from: number;
  /** column after its last */
  readonly to: number;
  readonly tone: Tone;
}

interface Syntax {
  readonly line: readonly string[];
  readonly block: readonly [string, string] | null;
  readonly quotes: string;
  /** `"""` and `'''` run over lines */
  readonly triple: boolean;
  readonly words: ReadonlySet<string>;
  readonly caseless: boolean;
  /** an extra pattern, tried at each position, and what it is */
  readonly extra: { readonly pattern: RegExp; readonly tone: Tone } | null;
}

const wordSet = (text: string): ReadonlySet<string> => new Set(text.split(/\s+/).filter((word) => word !== ''));

const C_WORDS = 'if else for while do switch case break continue return goto default struct union enum typedef const static extern void sizeof volatile register inline true false null NULL class public private protected new delete this template typename namespace using try catch throw virtual override final nullptr';
const JS_WORDS = 'const let var function return if else for while do switch case break continue new delete typeof instanceof in of class extends super this import export from default async await yield try catch finally throw true false null undefined void interface type enum implements public private protected readonly static abstract as is keyof declare namespace module satisfies';
const PY_WORDS = 'def class return if elif else for while in not and or is import from as with try except finally raise pass break continue lambda yield global nonlocal del assert async await True False None self match case';
const SH_WORDS = 'if then else elif fi for while until do done case esac in function select time return exit export local readonly unset set shift source alias trap eval exec true false';
const SQL_WORDS = 'select from where group by order having insert into values update set delete create table drop alter add index join inner outer left right full on as and or not null is in like between distinct limit offset union all case when then else end primary key foreign references default unique with asc desc count sum avg min max true false';
const GO_WORDS = 'package import func return if else for range switch case break continue go defer select chan map struct interface type var const fallthrough default goto true false nil iota';
const RUST_WORDS = 'fn let mut const static struct enum impl trait pub use mod crate self super match if else for while loop break continue return as in ref move where async await dyn unsafe type true false Some None Ok Err';
const JAVA_WORDS = 'class interface enum extends implements public private protected static final abstract void int long double float boolean char byte short new return if else for while do switch case break continue try catch finally throw throws import package this super null true false var record sealed instanceof synchronized volatile default fun val when object override data lateinit suspend struct func let guard extension protocol init deinit';
const RUBY_WORDS = 'def end class module if elsif else unless case when while until for in do begin rescue ensure raise return yield self nil true false require include extend attr_accessor puts and or not then lambda proc';
const PHP_WORDS = 'function class return if elseif else foreach for while do switch case break continue new echo print public private protected static abstract interface extends implements namespace use try catch finally throw true false null array isset empty';
const LUA_WORDS = 'function end if then elseif else for while do repeat until return local break in and or not nil true false';
const HASKELL_WORDS = 'module import where let in if then else case of do data type newtype class instance deriving infixl infixr True False';
const DOCKER_WORDS = 'FROM RUN CMD LABEL EXPOSE ENV ADD COPY ENTRYPOINT VOLUME USER WORKDIR ARG ONBUILD STOPSIGNAL HEALTHCHECK SHELL AS';
const DATA_WORDS = 'true false null yes no on off';
const GRAPHQL_WORDS = 'query mutation subscription fragment on type input enum interface union scalar schema extend implements directive true false null';

const syntax = (line: readonly string[], block: Syntax['block'], words: string, quotes = '"\'', options: Partial<Pick<Syntax, 'triple' | 'caseless' | 'extra'>> = {}): Syntax => ({
  line,
  block,
  quotes,
  words: wordSet(words),
  triple: options.triple ?? false,
  caseless: options.caseless ?? false,
  extra: options.extra ?? null,
});

const SLASH = ['//'] as const;
const BLOCK_C = ['/*', '*/'] as const;

const CLANG = syntax(SLASH, BLOCK_C, C_WORDS);
const JS = syntax(SLASH, BLOCK_C, JS_WORDS, '"\'`');
const PY = syntax(['#'], null, PY_WORDS, '"\'', { triple: true });
const SH = syntax(['#'], null, SH_WORDS, '"\'`', { extra: { pattern: /^\$(?:\{[^}]*\}|\w+|\([^)]*\))/, tone: 'literal' } });
const SQL = syntax(['--'], BLOCK_C, SQL_WORDS, '"\'', { caseless: true });
const DATA = syntax(['#'], null, DATA_WORDS, '"\'', { extra: { pattern: /^[A-Za-z_][\w.-]*(?=\s*[:=])/, tone: 'keyword' } });
const JAVA = syntax(SLASH, BLOCK_C, JAVA_WORDS);
const CSHARP = syntax(SLASH, BLOCK_C, `${JAVA_WORDS} string bool using namespace get set`);
const GO = syntax(SLASH, BLOCK_C, GO_WORDS, '"\'`');
const RUST = syntax(SLASH, BLOCK_C, RUST_WORDS);
const RUBY = syntax(['#'], null, RUBY_WORDS);

const SYNTAX: Readonly<Record<string, Syntax>> = {
  ts: JS, typescript: JS, js: JS, javascript: JS, jsx: JS, tsx: JS,
  json: syntax([], null, 'true false null'),
  python: PY, py: PY,
  bash: SH, sh: SH, shell: SH, zsh: SH,
  c: CLANG, cpp: CLANG, 'c++': CLANG,
  csharp: CSHARP, 'c#': CSHARP, cs: CSHARP,
  java: JAVA, kotlin: JAVA, swift: JAVA, scala: JAVA, dart: JAVA,
  go: GO, golang: GO,
  rust: RUST, rs: RUST,
  ruby: RUBY, rb: RUBY,
  php: syntax(['//', '#'], BLOCK_C, PHP_WORDS),
  perl: syntax(['#'], null, 'my our sub if elsif else unless while until for foreach return use package print last next'),
  r: syntax(['#'], null, 'function if else for while repeat break next return TRUE FALSE NULL NA in library'),
  lua: syntax(['--'], ['--[[', ']]'], LUA_WORDS),
  haskell: syntax(['--'], ['{-', '-}'], HASKELL_WORDS),
  elixir: syntax(['#'], null, 'def defp defmodule do end if else unless case cond when fn with for in import alias use require true false nil and or not'),
  ocaml: syntax([], ['(*', '*)'], 'let in rec fun function match with if then else begin end type module open true false and or not of'),
  sql: SQL,
  graphql: syntax(['#'], null, GRAPHQL_WORDS, '"'),
  yaml: DATA, yml: DATA, toml: DATA,
  ini: syntax([';', '#'], null, DATA_WORDS, '"\'', { extra: { pattern: /^(?:\[[^\]]*\]|[A-Za-z_][\w.-]*(?=\s*=))/, tone: 'keyword' } }),
  dockerfile: syntax(['#'], null, DOCKER_WORDS),
  makefile: syntax(['#'], null, 'ifeq ifneq ifdef ifndef else endif include define endef', '"\'', { extra: { pattern: /^[\w./%-]+(?=\s*:(?!=))/, tone: 'keyword' } }),
  css: syntax([], BLOCK_C, '', '"\'', { extra: { pattern: /^(?:@[\w-]+|#[0-9a-fA-F]{3,8}\b|![a-z]+)/, tone: 'keyword' } }),
  scss: syntax(SLASH, BLOCK_C, '', '"\'', { extra: { pattern: /^(?:@[\w-]+|\$[\w-]+|#[0-9a-fA-F]{3,8}\b|![a-z]+)/, tone: 'keyword' } }),
  html: syntax([], ['<!--', '-->'], '', '"\'', { extra: { pattern: /^<\/?[A-Za-z][\w:-]*/, tone: 'keyword' } }),
  xml: syntax([], ['<!--', '-->'], '', '"\'', { extra: { pattern: /^<[/?!]?[A-Za-z][\w:-]*/, tone: 'keyword' } }),
  svg: syntax([], ['<!--', '-->'], '', '"\'', { extra: { pattern: /^<\/?[A-Za-z][\w:-]*/, tone: 'keyword' } }),
  regex: syntax([], null, ''),
};

/** Markdown and diff are read by their lines, not their words. */
const BY_LINE = new Set(['md', 'markdown', 'diff']);
const PLAIN = new Set(['text', 'plain', 'txt']);

const WORD = /[A-Za-z_$][\w$]*/y;
const NUMBER = /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)/y;

interface Carried {
  /** the closer of the comment or string still open at the end of the last line, and what it is */
  readonly close: string;
  readonly tone: Tone;
}

/** The tone of a diff or Markdown line, as a whole. */
function toneOfLine(name: string, text: string): Tone {
  if (name === 'diff') {
    if (/^(?:\+\+\+|---|diff |index )/.test(text)) return 'comment';
    if (text.startsWith('@@')) return 'keyword';
    if (text.startsWith('+')) return 'literal';
    if (text.startsWith('-')) return 'keyword';
    return 'plain';
  }
  if (/^\s{0,3}#{1,6}\s/.test(text)) return 'keyword';
  if (/^\s{0,3}(?:[-*+]|\d+\.)\s/.test(text)) return 'literal';
  return 'plain';
}

/** Joins neighbours of one tone: a token is a stretch of one tone, the spaces inside it kept. */
function merged(tokens: readonly Token[]): Token[] {
  const out: Token[] = [];
  for (const token of tokens) {
    if (token.to <= token.from) continue;
    const last = out[out.length - 1];
    if (last !== undefined && last.tone === token.tone && last.to === token.from) out[out.length - 1] = { from: last.from, to: token.to, tone: token.tone };
    else out.push(token);
  }
  return out;
}

/**
 * The tones of every line of a block, in order. `lines` are the rows exactly as written (tabs already set to spaces); a language the tokenizer
 * does not know gives one `plain` token for the whole of each line.
 */
export function lexCode(lang: string | null | undefined, lines: readonly string[]): Token[][] {
  const name = (lang ?? '').toLowerCase();
  const syn = SYNTAX[name];
  if (PLAIN.has(name) || (syn === undefined && !BY_LINE.has(name))) return lines.map((line) => (line === '' ? [] : [{ from: 0, to: line.length, tone: 'plain' as const }]));
  if (syn === undefined) return lines.map((line) => (line === '' ? [] : [{ from: 0, to: line.length, tone: toneOfLine(name, line) }]));
  let carried: Carried | null = null;
  return lines.map((line) => {
    const tokens: Token[] = [];
    let at = 0;
    const push = (to: number, tone: Tone): void => {
      tokens.push({ from: at, to, tone });
      at = to;
    };
    // a comment or string left open by the line before
    if (carried !== null) {
      const end = line.indexOf(carried.close);
      if (end < 0) {
        push(line.length, carried.tone);
        return merged(tokens);
      }
      push(end + carried.close.length, carried.tone);
      carried = null;
    }
    while (at < line.length) {
      const rest = line.slice(at);
      const char = line[at] as string;
      // a comment to the end of the line (a `#` inside a shell word is not one: `$#`, `a#b`)
      const starter = syn.line.find((mark) => rest.startsWith(mark) && (mark !== '#' || syn !== SH || at === 0 || /\s/.test(line[at - 1] as string)));
      if (starter !== undefined) {
        push(line.length, 'comment');
        break;
      }
      if (syn.block !== null && rest.startsWith(syn.block[0])) {
        const end = line.indexOf(syn.block[1], at + syn.block[0].length);
        if (end < 0) {
          carried = { close: syn.block[1], tone: 'comment' };
          push(line.length, 'comment');
        } else push(end + syn.block[1].length, 'comment');
        continue;
      }
      if (syn.quotes.includes(char)) {
        if (syn.triple && rest.startsWith(char.repeat(3))) {
          const end = line.indexOf(char.repeat(3), at + 3);
          if (end < 0) {
            carried = { close: char.repeat(3), tone: 'literal' };
            push(line.length, 'literal');
          } else push(end + 3, 'literal');
          continue;
        }
        let end = at + 1;
        while (end < line.length && line[end] !== char) end += line[end] === '\\' ? 2 : 1;
        // a template string (a backtick) may run on; an ordinary one ends with its line
        if (end >= line.length && char === '`') {
          carried = { close: '`', tone: 'literal' };
          push(line.length, 'literal');
        } else push(Math.min(line.length, end + 1), 'literal');
        continue;
      }
      if (syn.extra !== null) {
        const found = syn.extra.pattern.exec(rest);
        if (found !== null && found[0] !== '') {
          push(at + found[0].length, syn.extra.tone);
          continue;
        }
      }
      if (/[A-Za-z_$]/.test(char)) {
        WORD.lastIndex = at;
        const word = (WORD.exec(line) as RegExpExecArray)[0];
        push(at + word.length, syn.words.has(syn.caseless ? word.toLowerCase() : word) ? 'keyword' : 'plain');
        continue;
      }
      if (/\d/.test(char) && !/[\w$]/.test(line[at - 1] ?? ' ')) {
        NUMBER.lastIndex = at;
        const number = NUMBER.exec(line);
        if (number !== null) {
          push(at + number[0].length, 'literal');
          continue;
        }
      }
      push(at + 1, 'plain');
    }
    return merged(tokens);
  });
}
