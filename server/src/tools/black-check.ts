// pnpm check's fb-021 group: the screen must not go black on a phone, with Draw or without it (docs/feedback.md fb-021).
//
// The owner's phone (Android 10, Chrome 157, 718x626 at three pixels to the point) showed the stage black, and an iPhone had before, "on opening Draw". Neither could be seen in a desktop
// browser, so this plays the owner's own first minute at the owner's own size, in headless Chrome (an Android user agent, touch) and in Playwright's WebKit, and looks at the pixels:
//
//   load      the first-load welcome is on the stage; no ink layer is on screen yet (a stage-sized plane that does nothing is a cost every phone pays for a pen it does not have), and
//             the stage's centre and its four corners are not black (the ground's own colour is what they are compared with)
//   stop      the welcome is stopped with the Send button, which has become Stop (what the owner did first): nothing is asked of the server for the turn it never heard of (the
//             snapshot of "local-first-load" answered 404), and the screen is as lit as before
//   draw      Draw is opened from the [+] menu with a finger: the layer is over the stage and the screen's centre and corners are still not black; the layer's own canvases are
//             fully transparent (an empty drawing has no colour of its own); a finger's stroke is written and shows
//   picture   the picture the brain would be sent is lit (the stage's picture under the ink, or the ink on white): a stage picture that came back black is never used
//
// Each run twice: as the device does, and with the failure modelled on it (`FORCED`), because a desktop GPU never shows what a phone's does:
//   - a canvas that asked for the low-latency path (`desynchronized`) is painted opaque black, as a phone's compositor may hand a layer that lies over the whole stage to the display
//     (the leading suspect for the owner's phone: the ink layer, which has been on screen over the stage since the pen began to write with no Draw, asked for it);
//   - every read of the GL buffer comes back zeros, as a cleared back buffer does (the stage's picture taken for Draw, for the snapshot and for the report).
// The first is held by never asking for the path on a phone and by keeping an idle layer off the screen; the second by never using a picture that is black.
//
// Run by `pnpm check` (group fb-021) and the WebKit pass (scene fb-021); standalone: `tsx black-check.ts --url <server> [--out dir]`.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sleep } from './explore-browser';
import { Tab } from './smoke';
import type { LensScene, LensScreen } from './lens-check';
import type { CheckResult } from './smoke';

/** the owner's screen: Android 10, Chrome 157, the page 718x626, three pixels to the point */
export const BLACK_SCREEN: LensScreen = { name: '718x626', width: 718, height: 626, dpr: 3 };
export const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';

/** the failure modelled on a phone, installed before the page's own script runs (see the header) */
export const FORCED = `(() => {
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attributes) {
    if (type === '2d' && attributes && attributes.desynchronized === true) { this.style.background = '#000'; this.dataset.lowLatency = '1'; }
    return getContext.call(this, type, attributes);
  };
  for (const name of ['WebGL2RenderingContext', 'WebGLRenderingContext']) {
    const proto = window[name] && window[name].prototype;
    if (!proto) continue;
    const readPixels = proto.readPixels;
    proto.readPixels = function (...args) {
      const out = readPixels.apply(this, args);
      const buffer = args[6];
      if (buffer && typeof buffer.fill === 'function') buffer.fill(0);
      return out;
    };
  }
})();`;

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** the patches a screen is judged at: the four corners of the stage and its centre (client pixels) */
export function patchesOf(stage: Rect): { readonly name: string; readonly rect: Rect }[] {
  const corner = 24;
  const inset = 4;
  const middle = 40;
  return [
    { name: 'top-left', rect: { x: stage.x + inset, y: stage.y + inset, width: corner, height: corner } },
    { name: 'top-right', rect: { x: stage.x + stage.width - inset - corner, y: stage.y + inset, width: corner, height: corner } },
    { name: 'bottom-left', rect: { x: stage.x + inset, y: stage.y + stage.height - inset - corner, width: corner, height: corner } },
    { name: 'bottom-right', rect: { x: stage.x + stage.width - inset - corner, y: stage.y + stage.height - inset - corner, width: corner, height: corner } },
    { name: 'centre', rect: { x: stage.x + (stage.width - middle) / 2, y: stage.y + (stage.height - middle) / 2, width: middle, height: middle } },
  ];
}

export interface Patch {
  readonly name: string;
  /** mean luminance, 0..255 */
  readonly lum: number;
  /** the share of its pixels that are dark (under a third of the ground's, or of mid grey when there is none) */
  readonly dark: number;
}

/** In a page: decodes a screenshot of a page `width` points wide and reports each patch (client pixels): its mean luminance and its share of dark pixels (`under`: what counts as dark) */
export const READ_PATCHES = `async ({ png, width, patches, under }) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + png;
  await img.decode();
  const scale = img.naturalWidth / width;
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(img, 0, 0);
  return patches.map((p) => {
    const sx = Math.max(0, Math.round(p.rect.x * scale)), sy = Math.max(0, Math.round(p.rect.y * scale));
    const sw = Math.max(1, Math.min(c.width - sx, Math.round(p.rect.width * scale))), sh = Math.max(1, Math.min(c.height - sy, Math.round(p.rect.height * scale)));
    const d = x.getImageData(sx, sy, sw, sh).data;
    let sum = 0, dark = 0;
    for (let i = 0; i < d.length; i += 4) { const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; sum += l; if (l < under) dark++; }
    return { name: p.name, lum: sum / (d.length / 4), dark: dark / (d.length / 4) };
  });
}`;

/** In a page: the stage's box, whether any ink layer is on screen, and what the ink layer's canvases hold (the most opaque pixel of each), and which asked for the low-latency path */
export const PROBE = `(() => {
  const stage = document.getElementById('stage');
  const r = stage.getBoundingClientRect();
  const shown = (e) => { const b = e.getBoundingClientRect(); return b.width >= 1 && b.height >= 1 && !e.closest('[hidden]'); };
  const layer = document.querySelector('.ink-stage');
  const canvases = layer ? [...layer.querySelectorAll('canvas')].map((c) => {
    let alpha = -1;
    try { const x = c.getContext('2d'); if (x && c.width > 0 && c.height > 0) { const d = x.getImageData(0, 0, c.width, c.height).data; alpha = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > alpha) alpha = d[i]; } } catch (e) {}
    return { cls: c.className, width: c.width, height: c.height, alpha, lowLatency: c.dataset.lowLatency === '1' };
  }) : [];
  const stop = document.querySelector('.prompt__button');
  const s = window.__stage ? window.__stage.state() : null;
  return {
    stage: { x: r.left, y: r.top, width: r.width, height: r.height },
    inkOnScreen: [...document.querySelectorAll('.ink')].filter(shown).length,
    layerOpen: !!layer && shown(layer) && !layer.classList.contains('ink-stage--through'),
    canvases,
    stopShown: !!stop && stop.classList.contains('prompt__button--stop'),
    turn: s ? s.turn : null,
    strokes: window.__inkStrokes ? window.__inkStrokes() : 0,
  };
})()`;

export interface Probe {
  readonly stage: Rect;
  readonly inkOnScreen: number;
  readonly layerOpen: boolean;
  readonly canvases: readonly { readonly cls: string; readonly width: number; readonly height: number; readonly alpha: number; readonly lowLatency: boolean }[];
  readonly stopShown: boolean;
  readonly turn: string | null;
  readonly strokes: number;
}

/** In a page: the mean luminance of a data URL's picture (0..255) */
export const PICTURE_LUM = (url: string): string => `new Promise((resolve) => { const i = new Image(); i.onload = () => { const c = document.createElement('canvas'); c.width = 48; c.height = 48; const x = c.getContext('2d'); x.drawImage(i, 0, 0, 48, 48); const d = x.getImageData(0, 0, 48, 48).data; let s = 0; for (let k = 0; k < d.length; k += 4) s += 0.2126 * d[k] + 0.7152 * d[k + 1] + 0.0722 * d[k + 2]; resolve(s / 2304); }; i.onerror = () => resolve(-1); i.src = ${JSON.stringify(url)}; })`;

/**
 * A screen judged: the ground is the lightest corner's mean (the stage's own colour); a patch is black when most of it is dark against that. `ground` null: not known yet (the first
 * look, which fixes it). Returns what is wrong with it, empty when nothing is.
 */
export function judgeScreen(tag: string, patches: readonly Patch[], ground: number | null): { readonly problems: string[]; readonly ground: number } {
  const corners = patches.filter((p) => p.name !== 'centre');
  const mine = ground ?? Math.max(...corners.map((p) => p.lum));
  const problems: string[] = [];
  if (ground === null && mine < 90) problems.push(`${tag}: the stage showed no ground before anything was done to it (its lightest corner has luminance ${mine.toFixed(0)})`);
  for (const p of patches) {
    if (p.dark >= 0.85 && p.lum < mine * 0.35) problems.push(`${tag}: the ${p.name} of the stage is black (luminance ${p.lum.toFixed(0)}, ${(p.dark * 100).toFixed(0)}% dark pixels, against a ground of ${mine.toFixed(0)})`);
  }
  // a ground that was itself black (said above) is not what the later looks are held to: the stage is a light one at first load
  return { problems, ground: ground === null && mine < 90 ? 230 : mine };
}

export const describe = (patches: readonly Patch[]): string => patches.map((p) => `${p.name} ${p.lum.toFixed(0)}`).join(', ');

/** The two passes: as the device does, and with the failure modelled on it */
export const PASSES = [
  { name: 'natural', forced: false },
  { name: 'forced', forced: true },
] as const;

/** What a pass says about the layer and the canvases after Draw has opened */
export function judgeLayer(tag: string, probe: Probe): string[] {
  const problems: string[] = [];
  if (!probe.layerOpen) problems.push(`${tag}: Draw did not open the layer over the stage`);
  const own = probe.canvases.filter((c) => c.alpha !== -1);
  if (own.length === 0) problems.push(`${tag}: the layer's canvases could not be read back`);
  for (const c of own) if (c.alpha > 0) problems.push(`${tag}: the empty layer's ${c.cls} canvas is not transparent (its most opaque pixel has alpha ${c.alpha})`);
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Chrome

interface Look {
  readonly patches: Patch[];
  readonly probe: Probe;
}

export async function blackGroup(base: string, screen: LensScreen, dir: string, timeoutMs: number, note: (text: string) => void = () => undefined): Promise<LensScene[]> {
  await mkdir(dir, { recursive: true });
  const scenes: LensScene[] = [];
  for (const pass of PASSES) {
    const began = Date.now();
    const problems: string[] = [];
    const facts: string[] = [];
    const tag = `${screen.name}-${pass.name}`;
    let picture = '';
    const tab = await Tab.open(screen.width, screen.height, { dpr: screen.dpr, touch: true });
    try {
      note(`fb-021: ${tag}`);
      await tab.send('Emulation.setUserAgentOverride', { userAgent: ANDROID_UA, platform: 'Linux armv81' });
      if (pass.forced) await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: FORCED });
      await tab.send('Page.navigate', { url: `${base}/` });
      const until = Date.now() + timeoutMs;
      for (;;) {
        await sleep(200);
        if ((await tab.eval<boolean>('!!window.__stage && !!document.getElementById("stage") && !!document.querySelector(".prompt__button")').catch(() => false)) === true) break;
        if (Date.now() > until) throw new Error('the page did not come up');
      }
      await tab.eval('window.__stage.ready');
      tab.drain();
      const look = async (name: string, ground: number | null): Promise<{ look: Look; ground: number }> => {
        const probe = await tab.eval<Probe>(PROBE);
        const png = Buffer.from((await tab.shot()).split(',')[1] ?? '', 'base64');
        const file = join(dir, `${tag}-${name}.png`);
        await writeFile(file, png);
        picture = `${tag}-${name}.png`;
        const patches = await tab.eval<Patch[]>(`(${READ_PATCHES})(${JSON.stringify({ png: png.toString('base64'), width: screen.width, patches: patchesOf(probe.stage), under: (ground ?? 235) * 0.35 })})`);
        const judged = judgeScreen(`${pass.name} ${name}`, patches, ground);
        problems.push(...judged.problems);
        facts.push(`${name}: ${describe(patches)}`);
        return { look: { patches, probe }, ground: judged.ground };
      };
      const tapAt = async (selector: string): Promise<boolean> => {
        const at = await tab.eval<{ x: number; y: number } | null>(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
        if (at === null) return false;
        await tab.tap(at.x, at.y);
        return true;
      };

      // 1. the first load, a few seconds in
      await sleep(2500);
      const first = await look('load', null);
      const ground = first.ground;
      if (first.look.probe.inkOnScreen > 0) problems.push(`${pass.name} load: ${first.look.probe.inkOnScreen} ink layer(s) are on screen over the stage before anything was drawn`);

      // 2. Send has become Stop while the welcome plays: the owner pressed it
      if (first.look.probe.stopShown) {
        await tapAt('.prompt__button');
        await sleep(1500);
        const stopped = await look('stopped', ground);
        if (stopped.look.probe.turn !== null) facts.push(`the turn was still ${stopped.look.probe.turn} after Stop`);
      } else facts.push('the welcome had finished before Stop could be pressed');
      const refused = tab.drain().failedRequests.filter((entry) => /\/snapshot/.test(entry.text));
      if (refused.length > 0) problems.push(`${pass.name} stop: the page asked the server to keep a picture for a turn it never heard of (${refused.map((entry) => entry.text.replace(/^https?:\/\/[^/]+/, '')).join('; ')})`);

      // 3. Draw, from the + menu, with a finger
      await tapAt('.composer__plus');
      await sleep(600);
      const reached = await tab.eval<{ x: number; y: number } | null>(`(() => { const n = [...document.querySelectorAll('.composer__item')].find((e) => /^Draw/.test(e.textContent.trim())); if (!n) return null; n.scrollIntoView({ block: 'center' }); const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      if (reached === null) throw new Error('the + menu has no Draw');
      await tab.tap(reached.x, reached.y);
      await sleep(2500);
      const drawn = await look('draw', ground);
      problems.push(...judgeLayer(`${pass.name} draw`, drawn.look.probe));

      // 4. a stroke, from the stage's left third to its right third
      const stage = drawn.look.probe.stage;
      await tab.drag({ x: stage.x + stage.width * 0.3, y: stage.y + stage.height * 0.4 }, { x: stage.x + stage.width * 0.7, y: stage.y + stage.height * 0.6 });
      await sleep(500);
      const written = await look('stroke', ground);
      if (written.look.probe.strokes !== 1) problems.push(`${pass.name} stroke: one finger stroke was drawn and the ink holds ${written.look.probe.strokes}`);

      // 5. the picture that would be sent
      const url = await tab.eval<string | null>('window.__inkPicture ? window.__inkPicture() : null');
      if (url === null) problems.push(`${pass.name} picture: no picture was made of the drawing`);
      else {
        const lum = await tab.eval<number>(PICTURE_LUM(url));
        facts.push(`the picture sent has luminance ${lum.toFixed(0)}`);
        if (lum < ground * 0.6) problems.push(`${pass.name} picture: the picture that would be sent with the drawing is dark (luminance ${lum.toFixed(0)}, the ground ${ground.toFixed(0)}): a stage picture that came back black was used`);
      }
      const logged = tab.drain();
      const bad = logged.failedRequests.filter((entry) => !/\/snapshot/.test(entry.text));
      if (bad.length > 0) problems.push(`${pass.name}: requests failed: ${bad.map((entry) => entry.text.replace(/^https?:\/\/[^/]+/, '')).slice(0, 3).join('; ')}`);
    } catch (error) {
      problems.push(`${pass.name}: stopped: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await tab.close();
    }
    const results: CheckResult[] = [
      {
        turn: 0,
        check: `fb-021-${pass.name}`,
        verdict: problems.length === 0 ? 'PASS' : 'FAIL',
        detail: problems.length === 0 ? `${pass.forced ? 'with a low-latency canvas painted black and every GL read zero: ' : ''}first load, Stop, Draw and a stroke at ${screen.name}: the stage's corners and centre stay lit, the layer is off the screen until Draw, its canvases are transparent, the picture sent is lit, nothing asked of the server for the welcome (${facts.join('; ')})` : problems.join('; '),
      },
    ];
    scenes.push({ name: `fb-021-${tag}`, picture, results, seconds: (Date.now() - began) / 1000 });
  }
  return scenes;
}

if (process.argv[1] !== undefined && /black-check\.ts$/.test(process.argv[1])) {
  const arg = (name: string, fallback: string): string => (process.argv.includes(name) ? (process.argv[process.argv.indexOf(name) + 1] as string) : fallback);
  const url = arg('--url', '');
  const out = arg('--out', '/tmp/conduit-black');
  if (!url.startsWith('http')) {
    process.stderr.write('usage: tsx black-check.ts --url http://127.0.0.1:<port> [--out <dir>]\n');
    process.exit(2);
  }
  void (async () => {
    const all = await blackGroup(url, BLACK_SCREEN, out, 90_000, (text) => process.stdout.write(`${text}\n`));
    let failed = 0;
    for (const scene of all) for (const r of scene.results) {
      process.stdout.write(`${r.verdict} ${scene.name} ${r.check}: ${r.detail}\n`);
      if (r.verdict === 'FAIL') failed += 1;
    }
    process.exit(failed === 0 ? 0 : 1);
  })();
}
