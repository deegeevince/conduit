// Every font file the app ships, self-hosted. Vite copies each into the build
// and hands back its URL; nothing is fetched from a font service at run time.
//
// The files are the `*-fixed` builds made by `pnpm --filter @conduit/web fonts`
// (`scripts/build-fonts.mjs`):
// the original faces with their OpenType layout tables removed. That is not
// tidiness. The WebGL text renderer applies kerning and ligatures whenever a
// font offers them, and either one breaks the fixed character grid that all
// layout arithmetic here depends on. Do not swap in an unprocessed font.

import archivoBlack400 from './archivo-black/archivo-black-400-fixed.ttf?url';
import bedstead from './bedstead/bedstead-fixed.otf?url';
import caveat500 from './caveat/caveat-500-fixed.ttf?url';
import caveat700 from './caveat/caveat-700-fixed.ttf?url';
import doto700 from './doto/doto-700-fixed.ttf?url';
import doto900 from './doto/doto-900-fixed.ttf?url';
import inter400 from './inter/inter-400-fixed.ttf?url';
import inter700 from './inter/inter-700-fixed.ttf?url';
import jetbrainsMono400 from './jetbrains-mono/jetbrains-mono-400-fixed.ttf?url';
import jetbrainsMono700 from './jetbrains-mono/jetbrains-mono-700-fixed.ttf?url';
import sourceSerif400 from './source-serif-4/source-serif-4-400-fixed.ttf?url';
import sourceSerif700 from './source-serif-4/source-serif-4-700-fixed.ttf?url';
import vt323 from './vt323/vt323-fixed.ttf?url';
import { familyFor } from './families';
import { GLYPHS } from './glyphs';

export { GLYPHS };

export interface FontFace {
  /** the CSS family name the plain renderer registers it under */
  readonly family: string;
  readonly url: string;
  readonly format: 'truetype' | 'opentype';
}

/** Keyed by `LookSpec.type.font` and `LookSpec.type.boldFont`. */
export const FONTS: Readonly<Record<string, FontFace>> = {
  'vt323': { family: familyFor('vt323'), url: vt323, format: 'truetype' },
  'bedstead': { family: familyFor('bedstead'), url: bedstead, format: 'opentype' },
  'doto-700': { family: familyFor('doto-700'), url: doto700, format: 'truetype' },
  'doto-900': { family: familyFor('doto-900'), url: doto900, format: 'truetype' },
  'source-serif-400': { family: familyFor('source-serif-400'), url: sourceSerif400, format: 'truetype' },
  'source-serif-700': { family: familyFor('source-serif-700'), url: sourceSerif700, format: 'truetype' },
  'inter-400': { family: familyFor('inter-400'), url: inter400, format: 'truetype' },
  'inter-700': { family: familyFor('inter-700'), url: inter700, format: 'truetype' },
  'caveat-500': { family: familyFor('caveat-500'), url: caveat500, format: 'truetype' },
  'caveat-700': { family: familyFor('caveat-700'), url: caveat700, format: 'truetype' },
  'archivo-black-400': { family: familyFor('archivo-black-400'), url: archivoBlack400, format: 'truetype' },
  'jetbrains-mono-400': { family: familyFor('jetbrains-mono-400'), url: jetbrainsMono400, format: 'truetype' },
  'jetbrains-mono-700': { family: familyFor('jetbrains-mono-700'), url: jetbrainsMono700, format: 'truetype' },
};

export function fontFor(key: string): FontFace {
  const face = FONTS[key];
  if (face === undefined) throw new Error(`no font is registered under "${key}"`);
  return face;
}

export { foldText, hasWide, isWide } from './fold';
