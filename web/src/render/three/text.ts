// The only module that imports troika-three-text.

import type { Face, Layer } from '@conduit/language';
import { CanvasTexture, Group, LinearFilter, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace } from 'three';
import type { IUniform, Vector4 } from 'three';
import type { Object3D, WebGLProgramParametersWithUniforms } from 'three';
import { Text, configureTextBuilder, preloadFont } from 'troika-three-text';
import type { ElementFrame, RunFrame } from '../../contracts/frame';
import { FONTS, GLYPHS, fontFor, foldText, hasWide, isWide } from '../../fonts';
import { prefixEm } from '../../fonts/measure';
import { FACES } from '../../fonts/faces';
import { CLIP_FRAGMENT_DECL, CLIP_TEST, CLIP_VERTEX_DECL, clipVertex, makeClipUniform, setClip } from './clip';
import { BAYER4, HASH } from './glsl';
import { ORDER, placeElement, renderOrderOf } from './stage';
import { hash01, inkColour } from './style';
import type { SurfaceStyle } from './style';

/** Every run is typeset once at this em size and scaled; a change of size is a transform, never a re-typeset. */
const TYPESET_SIZE = 64;

/** SDF resolution per face. Dot-matrix and pixel faces have small hard features that need more texels. */
const SDF_SIZE: Readonly<Record<string, number>> = { vt323: 64, bedstead: 128, 'doto-700': 128, 'doto-900': 128 };

const ALLOWED: ReadonlySet<string> = new Set(GLYPHS);

/** The device's own CJK fonts, in the order a phone, a Mac, a PC and a Linux box are likely to have them. Nothing is downloaded. */
const WIDE_STACK = '"PingFang SC","Hiragino Sans","Hiragino Kaku Gothic ProN","Apple SD Gothic Neo","Noto Sans CJK SC","Noto Sans SC","Source Han Sans SC","Microsoft YaHei","Yu Gothic","Malgun Gothic",sans-serif';
/** The most pixels an em of a CJK run is drawn at, and the widest picture of one run. */
const WIDE_PX = 96;
const WIDE_MAX_SIDE = 4096;

/** The plane every CJK run is drawn on: one unit, its top left corner at the origin, so a run is placed like troika's text (left, top). */
let widePlane: PlaneGeometry | null = null;
const wideGeometry = (): PlaneGeometry => {
  if (widePlane === null) {
    widePlane = new PlaneGeometry(1, 1);
    widePlane.translate(0.5, -0.5, 0);
  }
  return widePlane;
};

/** Face files the page has been asked to register for the 2D canvas (the canvas can draw only what the document has loaded), by font key. */
const wideFaces = new Map<string, 'loading' | 'done'>();
function wideFace(key: string): boolean {
  const state = wideFaces.get(key);
  if (state === 'done') return true;
  if (state === undefined) {
    wideFaces.set(key, 'loading');
    const face = FONTS[key];
    if (face === undefined || typeof FontFace === 'undefined' || typeof document === 'undefined') {
      wideFaces.set(key, 'done');
      return true;
    }
    const loaded = new FontFace(face.family, `url(${face.url}) format("${face.format}")`);
    void loaded
      .load()
      .then((ok) => document.fonts.add(ok))
      .catch(() => undefined)
      .finally(() => wideFaces.set(key, 'done'));
  }
  return false;
}

/**
 * Keeps one text mesh per run alive between frames. Text content and font are
 * typeset once (asynchronously, off the main thread); everything that changes
 * per frame — position, opacity, scale, colour, the reveal edge — is a
 * transform or a uniform, so a frame never waits for typesetting.
 */
export interface TextPool {
  /** Makes the meshes match these elements: creates, updates and removes as needed. */
  sync(roots: Readonly<Record<Layer | 'furniture', Object3D>>, elements: readonly ElementFrame[], furniture: readonly ElementFrame[], style: SurfaceStyle): void;
  /** True once every run of the last `sync` has been typeset with the right font. */
  readonly settled: boolean;
  /**
   * True when every run of the last `sync` that should be visible (the element's own text, not the look's furniture)
   * was typeset for exactly the text it was given and was drawn. A run whose text changed and is still being
   * typeset counts as not drawable, even though its previous text may be on screen.
   */
  readonly drawable: boolean;
  /**
   * Keys of the elements (not furniture) with a run that has never been typeset. Such an element has no letters
   * yet, so its marks (bar, box, underline, strike) wait too: an element is drawn whole or not at all.
   */
  readonly unlettered: ReadonlySet<string>;
  /** Shared by every run of a look with a ribbon: how uneven the ink is, and whether it varies dot by dot. */
  setInk(agitation: number, perDot: boolean): void;
  dispose(): void;
}

interface RunEntry {
  readonly text: Text;
  readonly group: Group;
  /** this run's own base material: troika derives a material from it and disposes that one only when the base goes, so the run disposes it with itself */
  readonly base: MeshBasicMaterial;
  /** the frame (`ElementFrame.clip`) this run is kept inside, in the derived material's own uniforms */
  readonly clip: IUniform<Vector4>;
  content: string;
  fontKey: string;
  /** a run with CJK characters is a picture of its text, drawn with the device's own font */
  wide: { readonly mesh: Mesh; readonly material: MeshBasicMaterial; texture: CanvasTexture | null; key: string; em: number } | null;
  token: number;
  ready: boolean;
  /** typeset at least once, so there is something truthful to draw even while a change of text is in flight */
  typeset: boolean;
}

interface ElementEntry {
  readonly group: Group;
  readonly runs: RunEntry[];
  root: Object3D | null;
  seen: boolean;
}

interface Metrics {
  /** where troika puts the baseline, below the top of the line box, in ems */
  readonly baseline: number;
  /** where the cap height is centred in the line box instead */
  readonly target: number;
  readonly xHeight: number;
}

const metrics = new Map<string, Metrics>();

function fontKeyOf(face: Face, bold: boolean): string {
  const spec = FACES[face];
  return bold && spec.bold === 'face' && spec.boldFont !== null ? spec.boldFont : spec.font;
}

function metricsFor(fontKey: string, lineHeight: number): Metrics {
  return metrics.get(`${fontKey}|${lineHeight}`) ?? { baseline: 0.8, target: 0.8, xHeight: 0.4 };
}

/**
 * Distance from the top of a line box to the baseline, as a share of the em.
 * Every face is placed with its capitals centred in the line box, whatever
 * ascent and descent its tables claim, so the painter's boxes mean the same thing in all looks.
 */
export function baselineRatio(face: Face): number {
  return metricsFor(FACES[face].font, FACES[face].lineHeight).target;
}

export function xHeightRatio(face: Face): number {
  return metricsFor(FACES[face].font, FACES[face].lineHeight).xHeight;
}

function sdfSizeFor(fontKey: string): number {
  return SDF_SIZE[fontKey] ?? 64;
}

let configured = false;
function configure(): void {
  if (configured) return;
  configured = true;
  // The fallback-font resolver would reach a public CDN for a missing glyph; point it at nothing that exists.
  configureTextBuilder({ unicodeFontsURL: '/__no-fallback-fonts__' });
}

/** How long to wait for a face before giving up; the caller then falls back to the plain renderer. */
const FONT_TIMEOUT_MS = 15000;

/**
 * Font files already asked for, by font key. troika gives a glyph its atlas slot the moment it is first typeset and draws
 * its shape afterwards, so a second request for the same glyphs (another renderer, a still) is answered at once, while
 * the shapes are still being drawn, and its text has holes in it. Everyone who wants a font therefore waits on the one
 * request that is really loading it.
 */
const fontLoads = new Map<string, Promise<void>>();

function loadFont(key: string): Promise<void> {
  let load = fontLoads.get(key);
  if (load === undefined) {
    load = new Promise<void>((resolve) => {
      preloadFont({ font: fontFor(key).url, characters: GLYPHS, sdfGlyphSize: sdfSizeFor(key) }, () => resolve());
    });
    fontLoads.set(key, load);
  }
  return load;
}

/**
 * Loads the font files of these faces and builds every glyph in `GLYPHS` into the SDF atlas, so the first frame is
 * typeset in the right face, with nothing left to generate on demand. Resolves when all of it is done.
 */
export function preloadFonts(faces: readonly Face[]): Promise<void> {
  configure();
  const keys = new Set<string>();
  const probes: { key: string; lineHeight: number }[] = [];
  for (const face of new Set(faces)) {
    const spec = FACES[face];
    keys.add(spec.font);
    if (spec.boldFont !== null) keys.add(spec.boldFont);
    if (!metrics.has(`${spec.font}|${spec.lineHeight}`) && !probes.some((probe) => probe.key === spec.font && probe.lineHeight === spec.lineHeight)) probes.push({ key: spec.font, lineHeight: spec.lineHeight });
  }
  const loads = [...keys].map((key) => loadFont(key));
  const measured = probes.map(
    ({ key, lineHeight }) =>
      new Promise<void>((resolve) => {
        const probe = new Text();
        probe.font = fontFor(key).url;
        probe.fontSize = TYPESET_SIZE;
        probe.lineHeight = lineHeight;
        probe.anchorX = 'left';
        probe.anchorY = 'top';
        probe.sdfGlyphSize = sdfSizeFor(key);
        probe.text = 'Hx';
        probe.sync(() => {
          const info = probe.textRenderInfo;
          if (info !== null) {
            const bounds = info.glyphBounds;
            const baseline = -info.topBaseline / TYPESET_SIZE;
            const cap = ((bounds[3] ?? 0) - info.topBaseline) / TYPESET_SIZE;
            const xHeight = ((bounds[7] ?? 0) - info.topBaseline) / TYPESET_SIZE;
            metrics.set(`${key}|${lineHeight}`, {
              baseline,
              target: (lineHeight - cap) / 2 + cap,
              xHeight,
            });
          }
          probe.dispose();
          resolve();
        });
      }),
  );
  const all = Promise.all(loads).then(() => Promise.all(measured)).then(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<void>((_, reject) => {
    timer = setTimeout(() => reject(new Error('the fonts did not load')), FONT_TIMEOUT_MS);
  });
  return Promise.race([all, expired]).finally(() => clearTimeout(timer));
}

function guard(text: string): string {
  const folded = foldText(text);
  let out = '';
  for (const char of folded) out += ALLOWED.has(char) || isWide(char) ? char : '?';
  return out;
}

const hardFragmentDefs = `${BAYER4}\n`;

/** Hard edges and ordered dither: a glyph pixel is lit or it is not, and opacity is the share of pixels lit. */
function patchHard(shader: WebGLProgramParametersWithUniforms): void {
  shader.fragmentShader = (hardFragmentDefs + shader.fragmentShader).replace(
    'gl_FragColor.a *= edgeAlpha;',
    'gl_FragColor.a = (edgeAlpha >= 0.5 && fillRGBA.a > conduitBayer(gl_FragCoord.xy)) ? 1.0 : 0.0;\n  if (gl_FragColor.a == 0.0) discard;',
  );
}

const ribbonFragmentDefs = `
uniform float uConduitAgitation;
uniform float uConduitDots;
uniform float uConduitAmount;
uniform float uConduitSeed;
varying vec2 vConduitLocal;
${HASH}
float conduitNoise1(float x) {
  float i = floor(x);
  float f = fract(x);
  float u = f * f * (3.0 - 2.0 * f);
  return mix(hash11(i + uConduitSeed * 17.0), hash11(i + 1.0 + uConduitSeed * 17.0), u);
}
float conduitDensity() {
  float em = ${TYPESET_SIZE.toFixed(1)};
  float drift = conduitNoise1(vConduitLocal.x / (em * 3.0) + uConduitSeed * 3.0);
  vec2 dot = floor(vConduitLocal / (em * 0.0625));
  float grain = hash21(dot + uConduitSeed * 101.0);
  float spread = (0.1 + 0.16 * uConduitAgitation) * uConduitAmount;
  float density = 1.0 - spread * (0.55 * drift + 0.45 * grain * uConduitDots);
  float pin = step(0.985 - 0.03 * uConduitAgitation, hash21(dot * 1.7 + uConduitSeed * 53.0)) * step(0.15, uConduitAgitation) * step(0.001, uConduitAmount);
  return density * (1.0 - pin);
}
`;

/** The ribbon: ink density that wanders along the line and varies per dot, fixed to the glyph so it never shimmers. */
function patchRibbon(shader: WebGLProgramParametersWithUniforms): void {
  shader.vertexShader = `varying vec2 vConduitLocal;\n${shader.vertexShader}`;
  const assign = 'vConduitLocal = position.xy;';
  if (shader.vertexShader.includes('gl_Position = projectionMatrix * mvPosition;')) {
    shader.vertexShader = shader.vertexShader.replace('gl_Position = projectionMatrix * mvPosition;', `gl_Position = projectionMatrix * mvPosition;\n  ${assign}`);
  } else {
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>\n  ${assign}`);
  }
  shader.fragmentShader = (ribbonFragmentDefs + shader.fragmentShader).replace('gl_FragColor.a *= edgeAlpha;', 'gl_FragColor.a *= edgeAlpha * conduitDensity();');
}

/** The frame: the glyph's world position is carried to the fragment, which discards what lies outside `ElementFrame.clip`. */
function patchClip(shader: WebGLProgramParametersWithUniforms): void {
  const assign = clipVertex('inverse(viewMatrix) * mvPosition');
  shader.vertexShader = `${CLIP_VERTEX_DECL}\n${shader.vertexShader}`;
  if (shader.vertexShader.includes('gl_Position = projectionMatrix * mvPosition;')) {
    shader.vertexShader = shader.vertexShader.replace('gl_Position = projectionMatrix * mvPosition;', `gl_Position = projectionMatrix * mvPosition;\n  ${assign}`);
  } else {
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>\n  ${assign}`);
  }
  shader.fragmentShader = `${CLIP_FRAGMENT_DECL}\n${shader.fragmentShader}`.replace('void main() {', `void main() {\n${CLIP_TEST}`);
}

function variantOf(style: SurfaceStyle): string {
  return `${style.hard ? 'h' : 'n'}${style.ribbon > 0 ? 'r' : 'n'}`;
}

export function createTextPool(): TextPool {
  configure();
  const entries = new Map<string, ElementEntry>();
  const agitation = { value: 0 };
  const dots = { value: 1 };
  const amount = { value: 0 };
  let activeVariant: string | null = null;
  let settled = true;
  let drawable = false;
  let unlettered: ReadonlySet<string> = new Set();

  const makeMaterial = (variant: string): MeshBasicMaterial => {
    const base = new MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
    base.customProgramCacheKey = () => `conduit-text-${variant}`;
    return base;
  };

  const makeRun = (style: SurfaceStyle, seed: number): RunEntry => {
    const text = new Text();
    const clip = makeClipUniform();
    const base = makeMaterial(activeVariant ?? variantOf(style));
    text.material = base;
    text.fontSize = TYPESET_SIZE;
    text.anchorX = 'left';
    text.anchorY = 'top';
    text.whiteSpace = 'nowrap';
    text.textAlign = 'left';
    text.frustumCulled = false;
    text.visible = false;
    const derived = text.material;
    if (!Array.isArray(derived)) {
      const look = style.hard ? patchHard : style.ribbon > 0 ? patchRibbon : (): void => undefined;
      derived.onBeforeCompile = (shader) => {
        patchClip(shader);
        look(shader);
      };
      const uniforms = (derived as unknown as { uniforms: Record<string, { value: unknown }> }).uniforms;
      uniforms['uConduitClip'] = clip;
      if (style.ribbon > 0 && !style.hard) {
        uniforms['uConduitAgitation'] = agitation;
        uniforms['uConduitDots'] = dots;
        uniforms['uConduitAmount'] = amount;
        uniforms['uConduitSeed'] = { value: seed };
      }
    }
    const group = new Group();
    group.add(text);
    return { text, group, base, clip, content: '', fontKey: '', wide: null, token: 0, ready: false, typeset: false };
  };

  const disposeEntry = (entry: ElementEntry): void => {
    entry.group.removeFromParent();
    for (const run of entry.runs) {
      run.text.removeFromParent();
      run.text.dispose();
      run.base.dispose();
      if (run.wide !== null) {
        run.wide.mesh.removeFromParent();
        run.wide.texture?.dispose();
        run.wide.material.dispose();
      }
    }
  };

  const disposeAll = (): void => {
    for (const entry of entries.values()) disposeEntry(entry);
    entries.clear();
  };

  const configureRun = (run: RunEntry, element: ElementFrame, runFrame: RunFrame, style: SurfaceStyle, index: number, order: number, fontKey: string): boolean => {
    const spec = FACES[element.face];
    const content = guard(runFrame.text);
    if (hasWide(content)) return configureWide(run, element, runFrame, style, order, fontKey, content);
    if (run.wide !== null) run.wide.mesh.visible = false;
    if (run.content !== content || run.fontKey !== fontKey) {
      run.content = content;
      run.fontKey = fontKey;
      run.ready = false;
      run.text.text = content;
      run.text.font = fontFor(fontKey).url;
      run.text.sdfGlyphSize = sdfSizeFor(fontKey);
      run.text.lineHeight = spec.lineHeight;
      const token = ++run.token;
      run.text.sync(() => {
        if (run.token === token) {
          run.ready = true;
          run.typeset = true;
        }
      });
    }

    const cellHeight = element.fontSize * spec.lineHeight;
    const scale = element.fontSize / TYPESET_SIZE;
    const across = scale * element.stretch;
    const chars = [...content].length;
    const opacity = element.opacity * runFrame.opacity;
    const wantedNow = runFrame.reveal > 0 && opacity > 0.002 && chars > 0;
    run.text.visible = run.typeset && wantedNow;
    // Drawable means drawn from exactly this text; a stale previous typeset is shown (it is better than a hole) but not counted.
    const honest = !wantedNow || (run.ready && run.typeset);
    if (!run.text.visible) return honest;

    let offsetX = 0;
    let offsetY = 0;
    let tilt = 0;
    if (style.ribbon > 0) {
      // Impact imperfection: decided once from the key, so it is a property of the line and never moves.
      const h1 = hash01(`${element.key}:x`);
      const h2 = hash01(`${element.key}:y`);
      const h3 = hash01(`${element.key}:${index}:r`);
      offsetX = (h1 - 0.5) * 0.7;
      offsetY = (h2 - 0.5) * 0.7;
      tilt = (h3 - 0.5) * 0.0035;
    }

    run.group.position.set(runFrame.x + runFrame.dx + runFrame.width / 2 + offsetX, -(runFrame.y + runFrame.dy + cellHeight / 2) + offsetY, 0);
    run.group.rotation.z = tilt;
    run.group.scale.set(runFrame.scale, runFrame.scale, 1);
    const m = metricsFor(fontKey, spec.lineHeight);
    run.text.position.set(-runFrame.width / 2, cellHeight / 2 + (m.baseline - m.target) * element.fontSize, 0);
    run.text.scale.set(across, scale, 1);
    run.text.renderOrder = order;
    run.text.color = inkColour(style, runFrame.colour).getHex();
    run.text.fillOpacity = opacity;
    setClip(run.clip, element.clip);
    // The reveal is a share of the run's drawn width, whatever the face: the painter has already turned characters into a width.
    run.text.clipRect = runFrame.reveal >= 1 ? null : [-TYPESET_SIZE * 2, -TYPESET_SIZE * 6, (runFrame.reveal * runFrame.width) / across, TYPESET_SIZE * 2];
    return honest;
  };

  /** A run with CJK characters: the whole run is drawn on a canvas, one character at a time at the advance the painter measured, and shown on a plane in the run's place. */
  const configureWide = (run: RunEntry, element: ElementFrame, runFrame: RunFrame, style: SurfaceStyle, order: number, fontKey: string, content: string): boolean => {
    const spec = FACES[element.face];
    const bold = element.weight === 'bold';
    run.text.visible = false;
    run.content = content;
    run.fontKey = fontKey;
    const opacity = element.opacity * runFrame.opacity;
    const wantedNow = runFrame.reveal > 0 && opacity > 0.002;
    if (run.wide === null) {
      const material = new MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
      material.customProgramCacheKey = () => 'conduit-text-wide';
      material.onBeforeCompile = (shader) => {
        patchClip(shader);
        shader.uniforms['uConduitClip'] = run.clip;
      };
      const mesh = new Mesh(wideGeometry(), material);
      mesh.frustumCulled = false;
      mesh.visible = false;
      run.group.add(mesh);
      run.wide = { mesh, material, texture: null, key: '', em: 0 };
    }
    const wide = run.wide;
    const key = `${content}|${fontKey}|${bold ? 'b' : 'n'}|${element.face}`;
    if (wide.key !== key) {
      if (!wideFace(fontKey)) {
        run.ready = false;
        return !wantedNow;
      }
      const running = prefixEm(content, element.face, bold ? 'bold' : 'normal');
      const em = running[content.length] ?? 0;
      const px = Math.max(8, Math.min(WIDE_PX, WIDE_MAX_SIDE / Math.max(1, em)));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(em * px));
      canvas.height = Math.max(1, Math.ceil(spec.lineHeight * px));
      const ctx = canvas.getContext('2d');
      if (ctx !== null) {
        const latin = `${bold ? '700 ' : ''}${px}px "${FONTS[fontKey]?.family ?? 'sans-serif'}", ${WIDE_STACK}`;
        const cjk = `${bold ? '700 ' : ''}${px}px ${WIDE_STACK}`;
        ctx.fillStyle = '#fff';
        ctx.textBaseline = 'alphabetic';
        const baseline = metricsFor(fontKey, spec.lineHeight).baseline * px;
        for (let i = 0; i < content.length; i += 1) {
          const char = content.charAt(i);
          if (char === ' ') continue;
          ctx.font = isWide(char) ? cjk : latin;
          // a CJK glyph is centred in its em, a Latin one starts at its pen position, as the painter's running widths place them
          const x = (running[i] ?? 0) * px;
          if (isWide(char)) {
            ctx.textAlign = 'center';
            ctx.fillText(char, x + px / 2, baseline);
          } else {
            ctx.textAlign = 'left';
            ctx.fillText(char, x, baseline);
          }
        }
      }
      wide.texture?.dispose();
      const texture = new CanvasTexture(canvas);
      texture.colorSpace = SRGBColorSpace;
      texture.minFilter = LinearFilter;
      texture.generateMipmaps = false;
      wide.texture = texture;
      wide.material.map = texture;
      wide.material.needsUpdate = true;
      wide.key = key;
      wide.em = em;
    }
    run.ready = true;
    run.typeset = true;
    wide.mesh.visible = wantedNow;
    if (!wantedNow) return true;
    const cellHeight = element.fontSize * spec.lineHeight;
    const scale = element.fontSize / TYPESET_SIZE;
    const across = scale * element.stretch;
    const reveal = Math.max(0, Math.min(1, runFrame.reveal));
    const m = metricsFor(fontKey, spec.lineHeight);
    run.group.position.set(runFrame.x + runFrame.dx + runFrame.width / 2, -(runFrame.y + runFrame.dy + cellHeight / 2), 0);
    run.group.rotation.z = 0;
    run.group.scale.set(runFrame.scale, runFrame.scale, 1);
    wide.mesh.position.set(-runFrame.width / 2, cellHeight / 2 + (m.baseline - m.target) * element.fontSize, 0);
    wide.mesh.scale.set(wide.em * TYPESET_SIZE * across * reveal, spec.lineHeight * TYPESET_SIZE * scale, 1);
    if (wide.texture !== null) wide.texture.repeat.set(Math.max(reveal, 1e-4), 1);
    wide.mesh.renderOrder = order;
    wide.material.color.copy(inkColour(style, runFrame.colour));
    wide.material.opacity = opacity;
    setClip(run.clip, element.clip);
    return true;
  };

  const syncSet = (
    root: Object3D,
    list: readonly ElementFrame[],
    style: SurfaceStyle,
    prefix: string,
    orderFor: (element: ElementFrame) => number,
    only: Layer | null,
    counts: boolean,
    pending: Set<string>,
  ): boolean => {
    let all = true;
    for (const element of list) {
      if (only !== null && element.layer !== only) continue;
      const id = `${prefix}${element.key}`;
      let entry = entries.get(id);
      if (entry === undefined) {
        entry = { group: new Group(), runs: [], root: null, seen: true };
        entries.set(id, entry);
      }
      entry.seen = true;
      if (entry.root !== root) {
        root.add(entry.group);
        entry.root = root;
      }
      placeElement(entry.group, element);
      const fontKey = fontKeyOf(element.face, element.weight === 'bold');
      const order = orderFor(element);
      element.runs.forEach((runFrame, index) => {
        let run = entry.runs[index];
        if (run === undefined) {
          run = makeRun(style, hash01(`${id}#${index}`));
          entry.runs[index] = run;
          entry.group.add(run.group);
        }
        const honest = configureRun(run, element, runFrame, style, index, order, fontKey);
        if (counts && !honest) all = false;
        if (counts && !run.typeset && run.content !== '') pending.add(element.key);
      });
      for (let extra = element.runs.length; extra < entry.runs.length; extra++) {
        const run = entry.runs[extra];
        if (run !== undefined) run.text.visible = false;
      }
    }
    return all;
  };

  return {
    get settled() {
      return settled;
    },
    get drawable() {
      return drawable;
    },
    get unlettered() {
      return unlettered;
    },
    setInk(value, perDot) {
      agitation.value = value;
      dots.value = perDot ? 1 : 0;
    },
    sync(roots, elements, furniture, style) {
      const variant = variantOf(style);
      if (activeVariant !== variant) {
        disposeAll();
        activeVariant = variant;
      }
      amount.value = style.ribbon;
      for (const entry of entries.values()) entry.seen = false;
      drawable = true;
      const pending = new Set<string>();
      for (const layer of ['far', 'bg', 'mid', 'fg'] as const) {
        if (!syncSet(roots[layer], elements, style, '', (element) => renderOrderOf(element.layer, 'text', element.z), layer, true, pending)) drawable = false;
      }
      unlettered = pending;
      syncSet(roots.furniture, furniture, style, '~', () => ORDER.furniture + 50, null, false, new Set());
      for (const [id, entry] of entries) {
        if (!entry.seen) {
          disposeEntry(entry);
          entries.delete(id);
        }
      }
      settled = true;
      for (const entry of entries.values()) for (const run of entry.runs) if (!run.ready && run.content !== '') settled = false;
    },
    dispose() {
      disposeAll();
    },
  };
}
