// kinds/code.ts: The `code` engine (a listing: rows taken exactly, monospaced, each word coloured by what it is)
// wrapped; its code stays in `painter/blocks/code.ts` (the tokenizer in `code-lex.ts`).

import { layoutCode } from '../../painter/blocks/code';
import { seal } from '../seal';
import { structureKind } from './adapt-structure';

export const code = seal(
  structureKind({
    id: 'code',
    engine: layoutCode,
    fit: 'reflow',
    fixtures: [['code py | Hello', '| def hello(name):', '|     return "hi " + name']],
  }),
);
