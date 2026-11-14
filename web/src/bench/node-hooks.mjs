// Lets the painter's pure modules load under tsx: a vite-style `?url` import (a font file) becomes its own path, `?raw` its text.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function resolve(specifier, context, next) {
  if (/\?(url|raw)$/.test(specifier)) {
    const bare = specifier.replace(/\?(url|raw)$/, '');
    const parent = context.parentURL === undefined ? import.meta.url : context.parentURL;
    const resolved = new URL(bare, parent).href;
    return { url: `${resolved}?${specifier.endsWith('?raw') ? 'raw' : 'url'}`, shortCircuit: true, format: 'module' };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  const match = /\?(url|raw)$/.exec(url);
  if (match === null) return next(url, context);
  const file = url.replace(/\?(url|raw)$/, '');
  const value = match[1] === 'raw' ? readFileSync(fileURLToPath(file), 'utf8') : file;
  return { format: 'module', source: `export default ${JSON.stringify(value)};`, shortCircuit: true };
}
