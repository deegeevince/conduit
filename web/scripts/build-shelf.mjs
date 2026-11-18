// The vetted library shelf, built. Live apps run with no network, so a library cannot be fetched: the host puts it in the app's own document.
// This turns each library in node_modules into one self-contained fragment (`<style>`/`<script>` text, nothing fetched at run time) under
// web/src/surfaces/shelf/built/, writes web/src/surfaces/shelf/NOTICE.md (each library's licence), and prints each one's size.
//   node web/scripts/build-shelf.mjs [--force]      (cached: a run with the same versions and the same script does nothing)
// Pinned in web/package.json as exact dev dependencies. The built folder is not committed; `pnpm dev`/`build` run this first.
// The one thing that is data and not a library: the land outlines (`maps`), vendored in web/src/surfaces/shelf/data/ as the TopoJSON it was published as, decoded here into GeoJSON.
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

const D3_MODULES = ['array', 'axis', 'chord', 'color', 'dispatch', 'drag', 'ease', 'force', 'format', 'geo', 'hierarchy', 'interpolate', 'path', 'polygon', 'quadtree', 'random', 'scale', 'scale-chromatic', 'selection', 'shape', 'time', 'time-format', 'timer', 'transition', 'zoom'];
/** KaTeX's fonts kept (woff2, inlined as data: URIs): body, bold, italic, math italic, the AMS symbols, the four big-delimiter sizes, sans. Script, fraktur, caligraphic and typewriter fall back to the page's own. */
const KATEX_FONTS = ['Main-Regular', 'Main-Bold', 'Main-Italic', 'Math-Italic', 'AMS-Regular', 'Size1-Regular', 'Size2-Regular', 'Size3-Regular', 'Size4-Regular', 'SansSerif-Regular'];

const versions = {
  matter: JSON.parse(read(join(pkgDir('matter-js'), 'package.json'))).version,
  tone: JSON.parse(read(join(pkgDir('tone'), 'package.json'))).version,
  katex: JSON.parse(read(join(pkgDir('katex'), 'package.json'))).version,
  d3: JSON.parse(read(join(pkgDir('d3'), 'package.json'))).version,
};
const LAND_FILE = join(web, 'src/surfaces/shelf/data/land-110m.json');
const stamp = createHash('sha256').update(JSON.stringify(versions)).update(read(fileURLToPath(import.meta.url))).update(readFileSync(LAND_FILE)).digest('hex').slice(0, 16);
const stampFile = join(out, '.stamp');
if (!force && existsSync(stampFile) && read(stampFile).trim() === stamp && ['matter', 'tone', 'katex', 'd3', 'fonts', 'maps'].every((name) => existsSync(join(out, `${name}.html`)))) {
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
// D3: the modules a chart, a graph, a force layout or a globe needs (d3-geo: projections and paths, no map data); delaunay (its robust-predicates is public-domain, not MIT/BSD/Apache), brush, contour, fetch and dsv are left out
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
    note(name, json.version, json.license, moduleDir, name === modules[0] ? 'charts, graphs, force layouts and map projections (the `charts` and `graphs` shelves), global `d3`' : 'part of D3');
  }
}

// Maps: the land outlines, as the global `World` (`World.land`, a GeoJSON MultiPolygon, deep-frozen). The data is Natural Earth 1:110m land, packaged as TopoJSON by world-atlas 2.0.2;
// the arcs are decoded here (delta-encoded integer arcs, a transform, shared arcs stitched into rings), so an app gets GeoJSON that d3.geoPath, d3.geoContains and d3.geoArea take as it is.
// Coordinates are rounded to 0.01 degree (about a kilometre; the data's own spacing is several). The winding is the file's own (clockwise outer rings, what d3-geo's spherical clipping needs).
const LAND = { url: 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/land-110m.json', version: '2.0.2', vendored: '2026-11-18', decimals: 2 };
const land = (() => {
  const raw = readFileSync(LAND_FILE);
  const topo = JSON.parse(raw.toString('utf8'));
  if (topo.type !== 'Topology' || topo.objects?.land === undefined || !Array.isArray(topo.arcs) || topo.transform === undefined) throw new Error('maps: land-110m.json is not a quantized TopoJSON Topology with a `land` object');
  const [sx, sy] = topo.transform.scale;
  const [tx, ty] = topo.transform.translate;
  const factor = 10 ** LAND.decimals;
  const round = (n) => Math.round(n * factor) / factor;
  // each arc is a run of [dx, dy] steps from its first point; a negative index is the arc `~i` walked backwards
  const arcs = topo.arcs.map((steps) => {
    let x = 0;
    let y = 0;
    return steps.map(([dx, dy]) => [round((x += dx) * sx + tx), round((y += dy) * sy + ty)]);
  });
  const arc = (index) => (index < 0 ? arcs[~index].slice().reverse() : arcs[index]);
  let dropped = 0;
  // a ring is its arcs joined end to start (the shared point is kept once); points that round to the one before are dropped
  const ring = (indexes) => {
    const points = [];
    for (const index of indexes) points.push(...arc(index).slice(points.length === 0 ? 0 : 1));
    const out = points.filter((point, i) => i === 0 || point[0] !== points[i - 1][0] || point[1] !== points[i - 1][1]);
    dropped += points.length - out.length;
    const first = out[0];
    const last = out[out.length - 1];
    if (out.length < 4 || first[0] !== last[0] || first[1] !== last[1]) throw new Error('maps: a ring does not close');
    return out;
  };
  const polygons = [];
  const walk = (geometry) => {
    if (geometry.type === 'GeometryCollection') geometry.geometries.forEach(walk);
    else if (geometry.type === 'MultiPolygon') polygons.push(...geometry.arcs.map((rings) => rings.map(ring)));
    else if (geometry.type === 'Polygon') polygons.push(geometry.arcs.map(ring));
    else throw new Error(`maps: a ${geometry.type} in the land object`);
  };
  walk(topo.objects.land);
  const geometry = { type: 'MultiPolygon', coordinates: polygons };
  const points = polygons.reduce((sum, rings) => sum + rings.reduce((n, one) => n + one.length, 0), 0);
  return { geometry, polygons: polygons.length, points, dropped, sha256: createHash('sha256').update(raw).digest('hex'), bytes: raw.length };
})();
{
  // the global is a plain property (an app's own `const World` still shadows it); what is frozen is the data
  const code = `(function(){var land=${JSON.stringify(land.geometry)};function freeze(o){Object.freeze(o);for(var k in o)if(o[k]!==null&&typeof o[k]==='object'&&!Object.isFrozen(o[k]))freeze(o[k]);return o}globalThis.World=freeze({land:land})})()`;
  parts.maps = script(code, 'maps');
}

// The painter's own faces, for an app that wants a real page's type: the latin subset only, a weight or two each, as woff2 data: URIs (font-src data: is allowed)
{
  const faces = [
    ['inter', 'Inter', [400, 700]],
    ['source-serif-4', 'Source Serif 4', [400, 700]],
    ['archivo-black', 'Archivo Black', [400]],
    ['jetbrains-mono', 'JetBrains Mono', [400, 700]],
  ];
  let css = '';
  for (const [pkg, family, weights] of faces) {
    const dir = pkgDir(`@fontsource/${pkg}`);
    for (const weight of weights) {
      const data = readFileSync(join(dir, 'files', `${pkg}-latin-${weight}-normal.woff2`)).toString('base64');
      css += `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:swap;src:url(data:font/woff2;base64,${data}) format('woff2')}`;
    }
    note(`@fontsource/${pkg}`, JSON.parse(read(join(dir, 'package.json'))).version, JSON.parse(read(join(dir, 'package.json'))).license, dir, `${family} ${weights.join(', ')} latin (the \`fonts\` shelf)`);
  }
  parts.fonts = `<style>${inertText(css, 'fonts')}</style>`;
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
  'The libraries are permissively licensed (MIT, BSD or ISC, which is the MIT licence in fewer words, with Apache-2.0 colour tables in d3-scale-chromatic). The four font families are SIL OFL 1.1, which allows embedding and redistribution with the licence kept (the painter already ships them). None is copyleft in a way that touches an app, and no part of the shelf is fetched at run time.',
  '',
  '| Library | Version | Licence | Used for |',
  '|---|---|---|---|',
  ...licences.map((entry) => `| ${entry.name} | ${entry.version} | ${entry.spdx} | ${entry.role} |`),
  '',
  'Left out on purpose: d3-delaunay (it bundles robust-predicates, which is public domain, not MIT/BSD/Apache), d3-brush, d3-contour, d3-fetch, d3-dsv, and the KaTeX fonts for script, fraktur, caligraphic and typewriter faces.',
  '',
  '## Map data (the `maps` shelf)',
  '',
  'Not a library: a data file, vendored as it was published and decoded at build time. An app that asks for `uses=maps` (or whose code says `World.land`) is given the global `World`, whose `land` is a GeoJSON MultiPolygon of the world\'s land.',
  '',
  `- File: \`web/src/surfaces/shelf/data/land-110m.json\` (${land.bytes} bytes, sha256 ${land.sha256}), the TopoJSON \`land\` object, unchanged.`,
  `- Source: ${LAND.url} (the \`world-atlas\` package, version ${LAND.version}), downloaded ${LAND.vendored}.`,
  '- The outlines are Natural Earth 1:110m land (https://www.naturalearthdata.com), which is in the public domain: no permission or credit is needed.',
  '- The packaging, world-atlas, is ISC-licensed (the same grant as the D3 modules above). Its own LICENSE file was not fetched, so its copyright line is not reproduced here.',
  `- Conversion (this script): arcs delta-decoded and the transform applied, shared arcs stitched into rings, coordinates rounded to ${LAND.decimals} decimals (${land.dropped} points that rounded onto their neighbour dropped); ${land.polygons} polygons, ${land.points} points. Nothing is fetched when an app runs.`,
  '',
  '## Licence texts',
  '',
  ...[...groups.values()].flatMap((entries) => [`### ${entries.map((entry) => entry.name).join(', ')}`, '', '```', entries[0].text ?? `(${entries[0].spdx}: no licence file shipped in the package)`, '```', '']),
];
writeFileSync(join(web, 'src/surfaces/shelf/NOTICE.md'), lines.join('\n'));
