// The part of `@conduit/language` the lesson program uses, and nothing else. The program is bundled into one script for a sandboxed frame
// (scripts/lesson-program.ts), and the language package's barrel is a megabyte; the bundle is built with `@conduit/language` aliased to this
// file so it holds the document and the lesson's functions and not the parser, the prompt and the painter's maths.
// Everything here is a re-export: the page itself imports `@conduit/language` as usual.

export { advance, askView, nodeOf, progressOf, stopOf } from '../../../../language/src/document';
export { accepts, maskSealed, numbersOf, openAskOf, sealed, textHolds } from '../../../../language/src/lesson';
export { VISUAL_KINDS } from '../../../../language/src/vocabulary';
export { resolveText } from '../../../../language/src/anchor';
export { typesetUnits } from '../../../../language/src/text';
