// The one place the kit reads the interface words from. They live in `language/src/interface.ts`; the package's index
// does not export that file until the language hook lands (PLAN-v2.2 section 9), so it is read by path here. When the
// hook adds `export * from './interface'` to the language's index, this file becomes
// `export * from '@conduit/language'` and nothing else changes.

export * from '../../../../../language/src/interface';
