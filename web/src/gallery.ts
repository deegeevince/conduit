// Entry for gallery.html: eight stills, one per look, all of the same moment of one script; and one live
// stage that performs the script in whichever look is chosen. Two WebGL contexts at most, however many looks.

import { DEFAULT_LOOK, EMPTY_STAGE, GALLERY_DEMO, LOOK_IDS, LineNormalizer, LineReader } from '@conduit/language';
import type { Line, LookId } from '@conduit/language';
import stylesScript from '@conduit/language/demos/styles.series?raw';
import { readParams } from './app/params';
import { mountStage } from './app/stage-app';
import type { StageApp } from './app/stage-app';
import type { Renderer } from './contracts/renderer';
import { LOOKS } from './looks';
import { createFilm } from './painter/film';
import { createPlainRenderer } from './render/plain';
import { canUseThree, createThreeRenderer } from './render/three';

const STILL_VIEWPORT = { width: 800, height: 600, dpr: 1 } as const;
const STILL_SIDE = 640;

const root = document.getElementById('app');
if (root === null) throw new Error('gallery.html has no #app element.');

const params = { ...readParams(window.location.search), look: null };

root.innerHTML = `
  <header class="gallery__header">
    <h1 class="gallery__title">The same moment, eight looks</h1>
    <button class="gallery__again" type="button">Play again</button>
  </header>
  <div class="gallery__row" role="group" aria-label="Looks"></div>
  <section class="gallery__live" data-theme-root aria-label="Live stage">
    <div class="gallery__stage"></div>
    <p class="gallery__caption"></p>
  </section>`;
const row = root.querySelector<HTMLElement>('.gallery__row');
const again = root.querySelector<HTMLButtonElement>('.gallery__again');
const live = root.querySelector<HTMLElement>('.gallery__live');
const liveStage = root.querySelector<HTMLElement>('.gallery__stage');
const liveCaption = root.querySelector<HTMLElement>('.gallery__caption');
if (row === null || again === null || live === null || liveStage === null || liveCaption === null) throw new Error('The looks page could not be built.');

const liveSection: HTMLElement = live;
const stageHost: HTMLElement = liveStage;
const captionHost: HTMLElement = liveCaption;

window.__stages = {};

interface Cell {
  readonly id: LookId;
  readonly button: HTMLButtonElement;
  readonly picture: HTMLElement;
}

const cells = new Map<LookId, Cell>();
for (const id of LOOK_IDS) {
  const spec = LOOKS[id];
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'gallery__look';
  button.setAttribute('aria-pressed', 'false');
  button.style.setProperty('--look-ground', spec.roles.ground);
  button.style.setProperty('--look-ink', spec.roles.ink);
  const picture = document.createElement('span');
  picture.className = 'gallery__still';
  const name = document.createElement('strong');
  name.textContent = spec.name;
  const machine = document.createElement('span');
  machine.className = 'gallery__machine';
  machine.textContent = spec.machine;
  button.append(picture, name, machine);
  row.append(button);
  cells.set(id, { id, button, picture });
}

// The live stage

let current: StageApp | null = null;
let chosen: LookId = DEFAULT_LOOK;
let generation = 0;

function showUnavailable(message: string): void {
  const note = document.createElement('p');
  note.className = 'stage__unavailable';
  note.setAttribute('role', 'alert');
  note.textContent = `Stage unavailable. ${message}`;
  stageHost.replaceChildren(note);
}

/** Mounts run one at a time: a stage holds a WebGL context, and quick clicks must not stack several. */
let mounting: Promise<void> = Promise.resolve();

function choose(id: LookId): Promise<void> {
  chosen = id;
  generation += 1;
  const mine = generation;
  for (const cell of cells.values()) cell.button.setAttribute('aria-pressed', String(cell.id === id));
  const spec = LOOKS[id];
  captionHost.textContent = `${spec.name}: ${spec.machine}`;
  liveSection.style.setProperty('--stage-ground', spec.roles.ground);
  liveSection.style.setProperty('--stage-ink', spec.roles.ink);
  liveSection.style.setProperty('--stage-dim', spec.roles.dim);
  liveSection.style.setProperty('--stage-accent', spec.roles.accent);
  current?.dispose();
  current = null;
  stageHost.replaceChildren();
  window.__stages = {};
  mounting = mounting.then(() => mount(id, mine));
  return mounting;
}

async function mount(id: LookId, mine: number): Promise<void> {
  // A click made while an earlier mount was running replaced this one before it began: skip it.
  if (mine !== generation) return;
  try {
    const app = await mountStage({ host: stageHost, params, lockLook: id, autoplay: GALLERY_DEMO });
    if (mine !== generation) {
      app.dispose();
      return;
    }
    current = app;
    (window.__stages ??= {})[id] = app.hook;
  } catch (cause) {
    if (mine === generation) showUnavailable(cause instanceof Error ? cause.message : String(cause));
  }
}

for (const cell of cells.values()) cell.button.addEventListener('click', () => void choose(cell.id));
again.addEventListener('click', () => {
  if (current === null) void choose(chosen);
  else void current.demo(GALLERY_DEMO).catch(() => undefined);
});

// The stills

function linesOf(script: string): Line[] {
  const reader = new LineReader();
  let auto = 0;
  const normalizer = new LineNormalizer(() => `x${(auto += 1)}`);
  const lines: Line[] = [];
  for (const raw of script.split('\n')) {
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue;
    const parsed = reader.read(raw);
    if (parsed.kind !== 'line') continue;
    const { line } = normalizer.normalize(parsed.line);
    if (line !== null) lines.push(line);
  }
  return lines;
}

function newRenderer(): Renderer {
  try {
    if (params.renderer !== 'plain' && (params.renderer === 'three' || canUseThree())) return createThreeRenderer();
  } catch {
    // the plain renderer can always be mounted
  }
  return createPlainRenderer();
}

async function makeStills(): Promise<void> {
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = `position:fixed;left:-10000px;top:0;width:${STILL_VIEWPORT.width}px;height:${STILL_VIEWPORT.height}px;overflow:hidden;pointer-events:none`;
  document.body.append(host);
  const renderer = newRenderer();
  try {
    await renderer.mount(host, STILL_VIEWPORT, DEFAULT_LOOK);
    const lines = linesOf(stylesScript).map((line, index) => ({ seq: index + 1, line }));
    for (const id of LOOK_IDS) {
      const cell = cells.get(id);
      if (cell === undefined) continue;
      const film = createFilm(
        { turn: `looks-${id}`, base: { ...EMPTY_STAGE, look: id, lookName: id }, lines, paintings: {} },
        { viewport: STILL_VIEWPORT, reducedMotion: true, arrival: 'at-once' },
      );
      let incomplete = false;
      const blob = await renderer.rasterise(film.frameAt(film.duration), { maxSide: STILL_SIDE, mime: 'image/png', onIncomplete: () => { incomplete = true; } });
      if (blob === null) continue;
      const image = document.createElement('img');
      image.alt = `${LOOKS[id].name}, a still of the same moment${incomplete ? ' (its words had not finished drawing)' : ''}`;
      if (incomplete) cell.picture.dataset['incomplete'] = 'true';
      image.src = URL.createObjectURL(blob);
      image.width = STILL_VIEWPORT.width;
      image.height = STILL_VIEWPORT.height;
      cell.picture.replaceChildren(image);
    }
  } finally {
    renderer.dispose();
    host.remove();
  }
}

void choose(DEFAULT_LOOK);
void makeStills().catch((cause: unknown) => {
  const note = document.createElement('p');
  note.className = 'gallery__note';
  note.textContent = `The stills could not be made here: ${cause instanceof Error ? cause.message : String(cause)}`;
  row.after(note);
});
