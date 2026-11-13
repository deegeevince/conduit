// Which font file a face is set in: shared by both renderers, and handed to the exporter through `Renderer.fontFile`.

import type { FontResolver } from '../contracts/renderer';
import { FONTS, fontFor } from '../fonts';
import { FACES } from '../fonts/faces';

export const fontFile: FontResolver = (face, bold) => {
  const spec = FACES[face];
  const key = bold && spec.bold === 'face' && spec.boldFont !== null ? spec.boldFont : spec.font;
  return FONTS[key] === undefined ? fontFor(spec.font) : fontFor(key);
};
