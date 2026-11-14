// Writes the kit's icons as data (PLAN-v2.2 E13, F0): about 160 outlines from Lucide (ISC), a development dependency
// that is read here and never shipped. Each icon becomes one SVG path string on a 24 x 24 grid; `geometry.ts` already reads
// path data, so nothing else is needed to draw them. Run with `pnpm --filter @conduit/web icons`.
//
// The names the brain writes are plain words (home, cart, back, warning); `ICONS` maps each to the Lucide icon it is drawn from.
// A name that Lucide does not have stops the script. The file it writes, and the licence notice that goes with it, are
// checked in: the build never needs the dependency.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const nodes = JSON.parse(readFileSync(here('../node_modules/lucide-static/icon-nodes.json'), 'utf8'));
const licence = readFileSync(here('../node_modules/lucide-static/LICENSE'), 'utf8');
const version = JSON.parse(readFileSync(here('../node_modules/lucide-static/package.json'), 'utf8')).version;

/** [the word the brain writes, the Lucide icon it is drawn from] */
const ICONS = [
  // the words the interface chapter names
  ['home', 'house'], ['house', 'house'], ['search', 'search'], ['user', 'user'], ['bell', 'bell'], ['cart', 'shopping-cart'], ['heart', 'heart'], ['star', 'star'],
  ['check', 'check'], ['close', 'x'], ['back', 'chevron-left'], ['menu', 'menu'], ['plus', 'plus'], ['shield', 'shield'], ['car', 'car'], ['umbrella', 'umbrella'],
  ['phone', 'phone'], ['mail', 'mail'], ['lock', 'lock'], ['card', 'credit-card'], ['calendar', 'calendar'], ['camera', 'camera'], ['map', 'map'], ['pin', 'map-pin'],
  ['clock', 'clock'], ['info', 'info'], ['warning', 'triangle-exclamation-point'],
  // arrows and marks
  ['chevron-left', 'chevron-left'], ['chevron-right', 'chevron-right'], ['chevron-down', 'chevron-down'], ['chevron-up', 'chevron-up'], ['arrow-left', 'arrow-left'],
  ['arrow-right', 'arrow-right'], ['arrow-up', 'arrow-up'], ['arrow-down', 'arrow-down'], ['minus', 'minus'], ['more', 'ellipsis'], ['more-vertical', 'ellipsis-vertical'],
  ['refresh', 'refresh-cw'], ['undo', 'undo-2'], ['external', 'external-link'], ['link', 'link'], ['copy', 'copy'], ['check-circle', 'circle-check'], ['x-circle', 'circle-x'],
  // people and accounts
  ['users', 'users'], ['user-plus', 'user-plus'], ['user-check', 'user-check'], ['profile', 'circle-user'], ['id', 'id-card'], ['key', 'key'], ['log-in', 'log-in'], ['log-out', 'log-out'],
  ['eye', 'eye'], ['eye-off', 'eye-off'], ['fingerprint', 'fingerprint-pattern'], ['shield-check', 'shield-check'], ['badge-check', 'badge-check'],
  // money
  ['wallet', 'wallet'], ['receipt', 'receipt'], ['dollar', 'dollar-sign'], ['banknote', 'banknote'], ['piggy-bank', 'piggy-bank'], ['bank', 'landmark'], ['percent', 'percent'],
  ['calculator', 'calculator'], ['tag', 'tag'], ['gift', 'gift'], ['package', 'package'], ['truck', 'truck'], ['shop', 'store'], ['bag', 'shopping-bag'],
  // documents
  ['document', 'file-text'], ['folder', 'folder'], ['clipboard', 'clipboard-list'], ['list', 'list'], ['grid', 'layout-grid'], ['image', 'image'], ['paperclip', 'paperclip'],
  ['bookmark', 'bookmark'], ['flag', 'flag'], ['news', 'newspaper'], ['book', 'book-open'], ['graduation', 'graduation-cap'], ['download', 'download'], ['upload', 'upload'],
  ['share', 'share-2'], ['send', 'send'], ['edit', 'pencil'], ['trash', 'trash'], ['filter', 'funnel'], ['settings', 'settings'], ['sliders', 'sliders-horizontal'],
  // charts and dashboards
  ['dashboard', 'layout-dashboard'], ['layers', 'layers'], ['chart-line', 'chart-line'], ['chart-bar', 'chart-bar'], ['chart-pie', 'chart-pie'], ['trend-up', 'trending-up'],
  ['trend-down', 'trending-down'], ['activity', 'activity'], ['target', 'target'], ['award', 'award'], ['trophy', 'trophy'], ['gauge', 'gauge'], ['zap', 'zap'],
  // things, places, vehicles
  ['building', 'building'], ['briefcase', 'briefcase'], ['globe', 'globe'], ['store', 'store'], ['hospital', 'hospital'], ['plane', 'plane'], ['train', 'train-front'],
  ['bus', 'bus'], ['bike', 'bike'], ['fuel', 'fuel'], ['wrench', 'wrench'], ['hammer', 'hammer'], ['compass', 'compass'], ['navigation', 'navigation'], ['locate', 'locate'],
  // health and life
  ['heart-pulse', 'heart-pulse'], ['stethoscope', 'stethoscope'], ['pill', 'pill'], ['baby', 'baby'], ['paw', 'paw-print'], ['dog', 'dog'], ['cat', 'cat'], ['leaf', 'leaf'],
  ['tree', 'tree-pine'], ['flame', 'flame'], ['droplet', 'droplet'], ['sun', 'sun'], ['moon', 'moon'], ['cloud', 'cloud'], ['rain', 'cloud-rain'], ['snow', 'snowflake'],
  ['wind', 'wind'], ['thermometer', 'thermometer'], ['bolt', 'zap'], ['lightbulb', 'lightbulb'], ['sparkles', 'sparkles'],
  // devices and media
  ['smartphone', 'smartphone'], ['laptop', 'laptop'], ['monitor', 'monitor'], ['tablet', 'tablet'], ['wifi', 'wifi'], ['battery', 'battery'], ['headphones', 'headphones'],
  ['mic', 'mic'], ['video', 'video'], ['play', 'play'], ['pause', 'pause'], ['tv', 'tv'], ['gamepad', 'gamepad-2'], ['qr', 'qr-code'], ['scan', 'scan-line'],
  // talk
  ['chat', 'message-circle'], ['message', 'message-square'], ['thumbs-up', 'thumbs-up'], ['bot', 'bot'], ['at', 'at-sign'], ['hash', 'hash'], ['help', 'message-circle-question-mark'],
  ['timer', 'timer'], ['hourglass', 'hourglass'], ['alarm', 'alarm-clock'],
  // players and money moving
  ['skip-back', 'skip-back'], ['skip-forward', 'skip-forward'], ['shuffle', 'shuffle'], ['repeat', 'repeat'], ['music', 'audio-waveform'], ['volume', 'volume-2'], ['disc', 'disc-3'],
  ['queue', 'list-music'], ['arrow-up-right', 'arrow-up-right'], ['arrow-down-left', 'arrow-down-left'], ['transfer', 'arrow-left-right'], ['podcast', 'mic-vocal'], ['radio', 'radio'],
];

const round = (n) => Number(n.toFixed(2));
const num = (v, fallback = 0) => (v === undefined ? fallback : Number(v));

function pathOf(tag, a) {
  switch (tag) {
    case 'path':
      // a path that begins with a lowercase m starts at its own point; once it is joined to the one before it, that m would be relative to where the last one ended
      // (its further pairs stay relative lines, so they take an explicit l)
      return String(a.d).replace(/^\s*m\s*(-?(?:\d+\.?\d*|\.\d+))[\s,]*(-?(?:\d+\.?\d*|\.\d+))([^]*)$/, (_all, x, y, rest) => `M${x} ${y}${/^[\s,\-.\d]/.test(rest) ? `l${rest}` : rest}`);
    case 'line':
      return `M${num(a.x1)} ${num(a.y1)}L${num(a.x2)} ${num(a.y2)}`;
    case 'polyline':
    case 'polygon': {
      const pts = String(a.points).trim().split(/[\s,]+/).map(Number);
      let d = `M${pts[0]} ${pts[1]}`;
      for (let i = 2; i < pts.length; i += 2) d += `L${pts[i]} ${pts[i + 1]}`;
      return tag === 'polygon' ? `${d}Z` : d;
    }
    case 'circle': {
      const cx = num(a.cx), cy = num(a.cy), r = num(a.r);
      return `M${round(cx - r)} ${cy}a${r} ${r} 0 1 0 ${round(2 * r)} 0a${r} ${r} 0 1 0 ${round(-2 * r)} 0Z`;
    }
    case 'ellipse': {
      const cx = num(a.cx), cy = num(a.cy), rx = num(a.rx), ry = num(a.ry);
      return `M${round(cx - rx)} ${cy}a${rx} ${ry} 0 1 0 ${round(2 * rx)} 0a${rx} ${ry} 0 1 0 ${round(-2 * rx)} 0Z`;
    }
    case 'rect': {
      const x = num(a.x), y = num(a.y), w = num(a.width), h = num(a.height);
      const rx = Math.min(num(a.rx, num(a.ry, 0)), w / 2), ry = Math.min(num(a.ry, num(a.rx, 0)), h / 2);
      if (rx === 0 && ry === 0) return `M${x} ${y}h${w}v${h}h${-w}Z`;
      return `M${round(x + rx)} ${y}h${round(w - 2 * rx)}a${rx} ${ry} 0 0 1 ${rx} ${ry}v${round(h - 2 * ry)}a${rx} ${ry} 0 0 1 ${-rx} ${ry}h${round(2 * rx - w)}a${rx} ${ry} 0 0 1 ${-rx} ${-ry}v${round(2 * ry - h)}a${rx} ${ry} 0 0 1 ${rx} ${-ry}Z`;
    }
    default:
      throw new Error(`unknown element ${tag}`);
  }
}

const out = {};
const missing = [];
for (const [word, name] of ICONS) {
  const parts = nodes[name];
  if (parts === undefined) {
    missing.push(`${word} -> ${name}`);
    continue;
  }
  out[word] = parts.map(([tag, attrs]) => pathOf(tag, attrs)).join('');
}
if (missing.length > 0) throw new Error(`Lucide has no icon for: ${missing.join(', ')}`);

const names = Object.keys(out).sort();
const body = names.map((n) => `  ${JSON.stringify(n)}: ${JSON.stringify(out[n])},`).join('\n');
writeFileSync(
  here('../src/painter/blocks/ui/icon-paths.ts'),
  `// GENERATED by web/scripts/build-icons.mjs from Lucide ${version} (ISC). Do not edit by hand; see ICONS-NOTICE.txt.\n// ${names.length} outlines on a 24 x 24 grid, drawn as strokes 2 wide with round ends. Each is one SVG path string, read by language/src/geometry.ts.\n\nexport const ICON_GRID = 24;\n\nexport const ICON_PATHS: Readonly<Record<string, string>> = {\n${body}\n};\n`,
);
writeFileSync(here('../src/painter/blocks/ui/ICONS-NOTICE.txt'), `The icons in icon-paths.ts are drawn from Lucide ${version} (https://lucide.dev), written out as path data by web/scripts/build-icons.mjs.\nLucide is used under the ISC licence, below. Some of its icons derive from Feather (MIT), whose notice is in the Lucide repository.\n\n${licence}`);
console.log(`wrote ${names.length} icons from Lucide ${version}`);
