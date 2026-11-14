// The CSS family name each shipped font file is registered under. Pure: no font files, no Vite, so the engine can name a family.

export const FONT_FAMILIES: Readonly<Record<string, string>> = {
  'vt323': 'Conduit VT323',
  'bedstead': 'Conduit Bedstead',
  'doto-700': 'Conduit Doto 700',
  'doto-900': 'Conduit Doto 900',
  'source-serif-400': 'Conduit Source Serif 400',
  'source-serif-700': 'Conduit Source Serif 700',
  'inter-400': 'Conduit Inter 400',
  'inter-700': 'Conduit Inter 700',
  'caveat-500': 'Conduit Caveat 500',
  'caveat-700': 'Conduit Caveat 700',
  'archivo-black-400': 'Conduit Archivo Black 400',
  'jetbrains-mono-400': 'Conduit JetBrains Mono 400',
  'jetbrains-mono-700': 'Conduit JetBrains Mono 700',
};

export function familyFor(key: string): string {
  const family = FONT_FAMILIES[key];
  if (family === undefined) throw new Error(`no font is registered under "${key}"`);
  return family;
}
