// Vite plugin: `import program from 'virtual:lesson-program'` is the lesson view as ONE self-contained script (an IIFE), minified, gzipped and
// written in base64 (the surface host runs a source of at most 64,000 characters, and the lesson with the language it uses is more than that
// as text; the frame's own boot line unpacks it with the browser's DecompressionStream).
// A sandboxed surface can load nothing (its policy allows inline script only), so the lesson's TypeScript is bundled once here and the
// host writes the text into the frame's document. The same call serves the dev server and the build; a change to any file the program
// imports reloads the page that holds it.

import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import type { Plugin } from 'vite';

const VIRTUAL = 'virtual:lesson-program';
const RESOLVED = `\0${VIRTUAL}`;

export function lessonProgram(): Plugin {
  const entry = fileURLToPath(new URL('../src/surfaces/lesson/program.ts', import.meta.url));
  const slice = fileURLToPath(new URL('../src/surfaces/lesson/language-slice.ts', import.meta.url));
  return {
    name: 'conduit-lesson-program',
    resolveId(id) {
      return id === VIRTUAL ? RESOLVED : null;
    },
    async load(id) {
      if (id !== RESOLVED) return null;
      const result = await build({
        configFile: false,
        logLevel: 'silent',
        resolve: { alias: { '@conduit/language': slice } },
        build: {
          write: false,
          minify: true,
          target: 'es2020',
          lib: { entry, formats: ['iife'], name: 'ConduitLesson', fileName: 'lesson' },
        },
      });
      const outputs = Array.isArray(result) ? result : [result];
      let code = '';
      for (const output of outputs) {
        if (!('output' in output)) continue;
        for (const chunk of output.output) {
          if (chunk.type !== 'chunk') continue;
          code += chunk.code;
          for (const module of Object.keys(chunk.modules)) if (!module.startsWith('\0')) this.addWatchFile(module);
        }
      }
      return `export default ${JSON.stringify(gzipSync(code, { level: 9 }).toString('base64'))};`;
    },
  };
}
