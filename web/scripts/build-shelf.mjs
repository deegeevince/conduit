// The vetted library shelf, built. Live apps run with no network, so a library cannot be fetched: the host puts it in the app's own document.
// This turns each library in node_modules into one self-contained fragment (`<style>`/`<script>` text, nothing fetched at run time) under
// web/src/surfaces/shelf/built/, writes web/src/surfaces/shelf/NOTICE.md (each library's licence), and prints each one's size.
//   node web/scripts/build-shelf.mjs [--force]      (cached: a run with the same versions and the same script does nothing)
// Pinned in web/package.json as exact dev dependencies. The built folder is not committed; `pnpm dev`/`build` run this first.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, '..');
const out = join(web, 'src/surfaces/shelf/built');
const force = process.argv.includes('--force');
const pkgDir = (name) => realpathSync(join(web, 'node_modules', name));
const read = (path) => readFileSync(path, 'utf8');

const D3_MODULES = ['array', 'axis', 'chord', 'color', 'dispatch', 'drag', 'ease', 'force', 'format', 'hierarchy', 'interpolate', 'path', 'polygon', 'quadtree', 'random', 'scale', 'scale-chromatic', 'selection', 'shape', 'time', 'time-format', 'timer', 'transition', 'zoom'];
/** KaTeX's fonts kept (woff2, inlined as data: URIs): body, bold, italic, math italic, the AMS symbols, the four big-delimiter sizes, sans. Script, fraktur, caligraphic and typewriter fall back to the page's own. */
const KATEX_FONTS = ['Main-Regular', 'Main-Bold', 'Main-Italic', 'Math-Italic', 'AMS-Regular', 'Size1-Regular', 'Size2-Regular', 'Size3-Regular', 'Size4-Regular', 'SansSerif-Regular'];

const versions = {
  matter: JSON.parse(read(join(pkgDir('matter-js'), 'package.json'))).version,
  tone: JSON.parse(read(join(pkgDir('tone'), 'package.json'))).version,
  katex: JSON.parse(read(join(pkgDir('katex'), 'package.json'))).version,
  d3: JSON.parse(read(join(pkgDir('d3'), 'package.json'))).version,
};
const stamp = createHash('sha256').update(JSON.stringify(versions)).update(read(fileURLToPath(import.meta.url))).digest('hex').slice(0, 16);
const stampFile = join(out, '.stamp');
if (!force && existsSync(stampFile) && read(stampFile).trim() === stamp && ['matter', 'tone', 'katex', 'd3'].every((name) => existsSync(join(out, `${name}.html`)))) {
  console.log(`shelf: up to date (${stamp})`);
  process.exit(0);
}
mkdirSync(out, { recursive: true });

/** Text that is safe inside a <script> or <style> element: no closing tag and no comment opener. A `\/` or `\!` in a string or a regular expression means the same character. */
function inertText(text, label) {
  const safe = text.replace(/<\/(script|style)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
  if (/<\/(script|style)|<!--/i.test(safe)) throw new Error(`${label}: closing tag left in`);
  return safe;
}
function script(code, label) {
  new Function(code.replace(/^#!.*/, '')); // syntax only: it is never run here
  return `<script>${inertText(code, label)}</script>`;
}

const parts = {};
const licences = [];
const licenceText = (dir) => {
  for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license']) if (existsSync(join(dir, name))) return read(join(dir, name)).trim();
  return null;
};
const note = (name, version, spdx, dir, role) => licences.push({ name, version, spdx, text: licenceText(dir), role });

// matter.js: physics
{
  const dir = pkgDir('matter-js');
  parts.matter = script(read(join(dir, 'build/matter.min.js')), 'matter');
  note('matter-js', versions.matter, 'MIT', dir, 'physics (the `physics` shelf), global `Matter`');
}
// Tone.js: sound (its own build is already minified, a UMD that sets `Tone`)
{
  const dir = pkgDir('tone');
  parts.tone = script(read(join(dir, 'build/Tone.js')).replace(/\/\/# sourceMappingURL=.*$/m, ''), 'tone');
  note('tone', versions.tone, 'MIT', dir, 'sound (the `sound` shelf), global `Tone`; bundles standardized-audio-context (MIT), automation-events (MIT), tslib (0BSD)');
}
// KaTeX: its script, and its stylesheet with the fonts inlined
{
  const dir = pkgDir('katex');
  const kept = new Set(KATEX_FONTS);
  let css = read(join(dir, 'dist/katex.min.css'));
  let dropped = 0;
  css = css.replace(/@font-face\{[^}]*\}/g, (block) => {
    const file = /url\(fonts\/KaTeX_([A-Za-z0-9-]+)\.woff2\)/.exec(block);
    if (file === null || !kept.has(file[1])) {
      dropped += 1;
      return '';
    }
    const data = readFileSync(join(dir, `dist/fonts/KaTeX_${file[1]}.woff2`)).toString('base64');
    return block.replace(/src:[^;}]*/, `src:url(data:font/woff2;base64,${data}) format("woff2")`);
  });
  if (/url\((?!data:)/.test(css)) throw new Error('katex: a stylesheet address is left');
  parts.katex = `<style>${inertText(css, 'katex css')}</style>${script(read(join(dir, 'dist/katex.min.js')), 'katex')}`;
  note('katex', versions.katex, 'MIT', dir, `maths typesetting (the \`maths\` shelf), global \`katex\`; its stylesheet with ${KATEX_FONTS.length} fonts inlined (${dropped} font faces dropped)`);
}
// D3: the modules a chart, a graph or a force layout needs; delaunay (its robust-predicates is public-domain, not MIT/BSD/Apache), geo, brush, contour, fetch and dsv are left out
{
  const dir = pkgDir('d3');
  const modules = D3_MODULES.map((name) => `d3-${name}`);
  const result = await build({
    stdin: { contents: modules.map((name) => `export * from '${name}';`).join('\n'), resolveDir: dir, loader: 'js' },
    bundle: true, minify: true, format: 'iife', globalName: 'd3', legalComments: 'none', target: 'es2020', write: false, logLevel: 'silent',
  });
  parts.d3 = script(result.outputFiles[0].text, 'd3');
  for (const name of modules) {
    const moduleDir = realpathSync(join(dir, '..', name));
    const json = JSON.parse(read(join(moduleDir, 'package.json')));
    note(name, json.version, json.license, moduleDir, name === modules[0] ? 'charts, graphs and force layouts (the `charts` and `graphs` shelves), global `d3`' : 'part of D3');
  }
}

for (const [name, text] of Object.entries(parts)) writeFileSync(join(out, `${name}.html`), text);
writeFileSync(stampFile, stamp);

const rows = Object.entries(parts).map(([name, text]) => `${name.padEnd(8)} ${String(Buffer.byteLength(text)).padStart(8)} bytes  ${String(gzipSync(text).length).padStart(8)} gzip`);
console.log(`shelf: built (${stamp})\n${rows.join('\n')}`);

// the notice: committed, so a change in a licence shows in review
const groups = new Map();
for (const entry of licences) {
  const key = `${entry.spdx}\n${entry.text ?? ''}`;
  groups.set(key, [...(groups.get(key) ?? []), entry]);
}
const lines = [
  '# Library shelf: notices',
  '',
  'Generated by `web/scripts/build-shelf.mjs`; do not edit by hand. These libraries are put into a live app\'s own document by the host, only when the app asks for them (`app … uses=…`).',
  'Every one is permissively licensed (MIT, BSD or ISC, which is the MIT licence in fewer words, with Apache-2.0 colour tables in d3-scale-chromatic). None is copyleft, and no part of the shelf is fetched at run time.',
  '',
  '| Library | Version | Licence | Used for |',
  '|---|---|---|---|',
  ...licences.map((entry) => `| ${entry.name} | ${entry.version} | ${entry.spdx} | ${entry.role} |`),
  '',
  'Left out on purpose: d3-delaunay (it bundles robust-predicates, which is public domain, not MIT/BSD/Apache), d3-geo, d3-brush, d3-contour, d3-fetch, d3-dsv, and the KaTeX fonts for script, fraktur, caligraphic and typewriter faces.',
  '',
  '## Licence texts',
  '',
  ...[...groups.values()].flatMap((entries) => [`### ${entries.map((entry) => entry.name).join(', ')}`, '', '```', entries[0].text ?? `(${entries[0].spdx}: no licence file shipped in the package)`, '```', '']),
];
writeFileSync(join(web, 'src/surfaces/shelf/NOTICE.md'), lines.join('\n'));
