import { LOOK_IDS } from '@conduit/language';
import type { Layer, LookId } from '@conduit/language';
import type { ElementFrame, Frame, Quality } from '../../contracts/frame';
import type { Renderer, RendererCapabilities } from '../../contracts/renderer';
import { cssOf, layerZ, projectToScreen } from '../../contracts/space';
import { clipQuad } from '../place';
import type { Viewport } from '../../contracts/space';
import { FONTS, hasDevice, startsRtl } from '../../fonts';
import '../../fonts/device';
import { FACES } from '../../fonts/faces';
import { LOOKS } from '../../looks';
import { fontFile } from '../fonts';
import { formulaRecord } from '../formula/host';
import { createPlainFigures } from './figures';
import type { PlainFigures } from './figures';

interface Node {
  /** what sits in the stage: it holds `root` and carries the frame's clip, which a turned `root` would turn with it */
  readonly outer: HTMLDivElement;
  readonly root: HTMLDivElement;
  readonly runs: HTMLSpanElement[];
  readonly marks: HTMLDivElement[];
  readonly plates: HTMLDivElement[];
  /** a typeset formula: KaTeX's own markup, put in the page where the formula's box is */
  formula: HTMLDivElement | null;
  formulaKey: string;
}

interface Picked {
  readonly key: string;
  readonly layer: Layer;
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly visible: boolean;
}

/** Each layer has two z-indexes: its drawing, and above it its text. */
const LAYER_RANK: Readonly<Record<Layer, number>> = { far: 0, bg: 1, mid: 2, fg: 3 };

function px(value: number): string {
  return `${Math.round(value * 100) / 100}px`;
}

/**
 * The plain renderer: positioned DOM text, no WebGL. It is the fallback when
 * WebGL2 is missing, and the proof that the painter does not depend on
 * three.js. It draws every look's colours, type and layout, and approximates
 * depth with scale and parallax; it simulates no screen.
 */
export function createPlainRenderer(): Renderer {
  const capabilities: RendererCapabilities = { depth: false, post: false, looks: LOOK_IDS, kinds: ['text', 'shape', 'sprite', 'group', 'copy', 'picture'], fx: [], ambient: [], capture: false, media: [], textures: ['flat', 'hatch', 'dots'], brushes: [], clip: true };
  let root: HTMLDivElement | null = null;
  let cursor: HTMLDivElement | null = null;
  const nodes = new Map<string, Node>();
  let picked: Picked[] = [];
  let loaded = false;
  let figures: PlainFigures | null = null;
  let lensCss = '';

  const makeNode = (parent: HTMLElement): Node => {
    const outer = document.createElement('div');
    outer.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;';
    const element = document.createElement('div');
    element.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;';
    outer.appendChild(element);
    parent.appendChild(outer);
    return { outer, root: element, runs: [], marks: [], plates: [], formula: null, formulaKey: '' };
  };

  // The element names its own face (a line can be set in another than its look's); the box was measured for that one.
  const family = (element: ElementFrame): string => {
    const spec = FACES[element.face];
    const key = element.weight === 'bold' && spec.bold === 'face' && spec.boldFont !== null ? spec.boldFont : spec.font;
    return `"${FONTS[key]?.family ?? 'monospace'}", monospace`;
  };

  const drawElement = (frame: Frame, element: ElementFrame, node: Node): void => {
    const { viewport, camera } = frame;
    const projected = projectToScreen({ x: element.x, y: element.y, z: layerZ(element.layer, viewport) }, camera, viewport);
    const s = projected.scale * element.scale;
    const centreX = projected.x;
    const centreY = projected.y;
    const fontPx = element.fontSize * projected.scale * element.scale;
    const lineHeight = FACES[element.face].lineHeight * fontPx;
    const faceFamily = family(element);

    node.root.style.opacity = String(element.opacity);
    node.root.style.zIndex = String(LAYER_RANK[element.layer] * 2 + 1);
    // The frame the element is kept inside, through this frame's camera. A clip path makes a stacking context, so the layer's rank goes on the outer box too.
    node.outer.style.zIndex = element.clip === undefined ? '' : String(LAYER_RANK[element.layer] * 2 + 1);
    node.outer.style.clipPath =
      element.clip === undefined
        ? ''
        : `polygon(${clipQuad(element.clip, element.layer, camera, viewport)
            .map((p) => `${px(p.x)} ${px(p.y)}`)
            .join(',')})`;
    node.root.style.transform = element.rotation === 0 ? '' : `translate(${px(centreX)},${px(centreY)}) rotate(${element.rotation}rad) translate(${px(-centreX)},${px(-centreY)})`;

    while (node.runs.length < element.runs.length) {
      const span = document.createElement('span');
      span.style.cssText = 'position:absolute;left:0;top:0;white-space:pre;font-kerning:none;font-variant-ligatures:none;font-feature-settings:"liga" 0,"kern" 0,"calt" 0;font-synthesis:none;font-weight:400;letter-spacing:0;transform-origin:50% 50%;';
      node.root.appendChild(span);
      node.runs.push(span);
    }
    // A typeset formula is KaTeX's markup, in the box the layout gave it; until the page has set it nothing of it shows.
    const formula = element.formula;
    if (formula === undefined && node.formula !== null) {
      node.formula.remove();
      node.formula = null;
      node.formulaKey = '';
    }
    if (formula !== undefined) {
      const set = formulaRecord(formula.tex, formula.display);
      const run = element.runs[0];
      if (node.formula === null) {
        node.formula = document.createElement('div');
        node.formula.className = 'conduit-formula';
        node.formula.setAttribute('aria-hidden', 'true');
        node.formula.style.cssText = 'position:absolute;left:0;top:0;width:max-content;line-height:normal;white-space:nowrap;pointer-events:none;';
        node.root.appendChild(node.formula);
      }
      const key = `${formula.tex}|${formula.display ? 'd' : 'i'}`;
      if (node.formulaKey !== key && set !== null) {
        node.formula.innerHTML = set.html;
        node.formulaKey = key;
      }
      const shown = set !== null && run !== undefined && run.opacity > 0 && run.reveal > 0;
      node.formula.style.display = shown ? '' : 'none';
      if (shown && set !== null && run !== undefined) {
        // the formula's own top left, which KaTeX's markup keeps `origin` ems inside the box it makes
        const left = centreX + (run.x + run.dx) * s - set.origin.x * fontPx;
        const top = centreY + (run.y + run.dy) * s - set.origin.y * fontPx;
        node.formula.style.fontSize = px(fontPx);
        node.formula.style.color = run.colour;
        node.formula.style.opacity = run.opacity === 1 ? '' : String(run.opacity);
        node.formula.style.transform = `translate(${px(left)},${px(top)})${run.scale === 1 ? '' : ` scale(${run.scale})`}`;
        node.formula.style.clipPath = run.reveal >= 1 ? '' : `inset(0 ${(1 - run.reveal) * 100}% 0 0)`;
        node.formula.style.transformOrigin = '0 0';
      }
    }
    node.runs.forEach((span, i) => {
      const run = element.runs[i];
      if (formula !== undefined) {
        span.style.display = 'none';
        return;
      }
      // Typed and wiped reveals show whole character cells only, as the WebGL path does.
      const chars = run === undefined ? 0 : [...run.text].length;
      const cells = run === undefined ? 0 : run.reveal >= 1 ? chars : Math.floor(chars * run.reveal + 1e-6);
      if (run === undefined || run.opacity <= 0 || cells <= 0) {
        span.style.display = 'none';
        return;
      }
      const x = centreX + (run.x + run.dx) * s;
      const y = centreY + (run.y + run.dy) * s;
      const width = (run.width * s) / element.stretch;
      span.style.display = '';
      span.textContent = run.text;
      // Scripts the faces lack are the browser's own text: shaping, joining and bidi must be left on (they are off for Latin, where the painter's widths rely on it).
      const device = hasDevice(run.text);
      span.dir = device && startsRtl(run.text) ? 'rtl' : 'ltr';
      span.style.fontKerning = device ? 'normal' : 'none';
      span.style.fontVariantLigatures = device ? 'normal' : 'none';
      span.style.fontFeatureSettings = device ? 'normal' : '"liga" 0,"kern" 0,"calt" 0';
      span.style.fontFamily = faceFamily;
      span.style.fontSize = px(fontPx);
      span.style.lineHeight = px(lineHeight);
      span.style.height = px(lineHeight);
      span.style.width = px(width);
      span.style.color = run.colour;
      span.style.opacity = run.opacity === 1 ? '' : String(run.opacity);
      span.style.clipPath = cells >= chars ? '' : `inset(0 ${(1 - cells / chars) * 100}% 0 0)`;
      const squeeze = element.stretch === 1 ? '' : `scaleX(${element.stretch})`;
      const grow = run.scale === 1 ? '' : `scale(${run.scale})`;
      span.style.transform = `translate(${px(x)},${px(y)}) ${grow} ${squeeze}`.trim();
      span.style.transformOrigin = element.stretch === 1 ? '50% 50%' : '0 50%';
    });

    const needed = element.mark === 'none' && element.strike <= 0 ? 0 : element.lines.length * 2;
    while (node.marks.length < needed) {
      const bar = document.createElement('div');
      bar.style.cssText = 'position:absolute;left:0;top:0;box-sizing:border-box;';
      node.root.appendChild(bar);
      node.marks.push(bar);
    }
    node.marks.forEach((bar, index) => {
      const line = element.lines[index >> 1];
      const second = (index & 1) === 1;
      if (line === undefined || (second ? element.strike <= 0 : element.mark === 'none')) {
        bar.style.display = 'none';
        return;
      }
      const left = centreX + line.x * s;
      const top = centreY + line.y * s;
      const width = line.width * s;
      const height = line.height * s;
      const thick = Math.max(1, Math.round(fontPx / 14));
      bar.style.display = '';
      bar.style.background = 'transparent';
      bar.style.border = '0';
      bar.style.zIndex = '-1';
      if (second || element.mark === 'strike') {
        const reach = second ? element.strike : 1;
        bar.style.background = element.runs[0]?.colour ?? element.markColour;
        bar.style.transform = `translate(${px(left)},${px(top + height / 2 - thick / 2)})`;
        bar.style.width = px(width * reach);
        bar.style.height = px(thick);
        bar.style.zIndex = '1';
      } else if (element.mark === 'underline') {
        bar.style.background = element.markColour;
        bar.style.transform = `translate(${px(left)},${px(top + height - thick)})`;
        bar.style.width = px(width);
        bar.style.height = px(thick);
      } else if (element.mark === 'box') {
        const pad = fontPx * 0.2;
        bar.style.border = `${thick}px solid ${element.markColour}`;
        const inset = fontPx * 0.04;
        bar.style.transform = `translate(${px(left - pad)},${px(top + inset)})`;
        bar.style.width = px(width + pad * 2);
        bar.style.height = px(Math.max(1, height - inset * 2));
      } else if (element.mark === 'invert') {
        const pad = fontPx * 0.3;
        bar.style.background = element.markColour;
        bar.style.transform = `translate(${px(left - pad)},${px(top - pad / 3)})`;
        bar.style.width = px(width + pad * 2);
        bar.style.height = px(height + (pad * 2) / 3);
      } else {
        bar.style.display = 'none';
      }
    });

    // Where text lies over something drawn, a plate of the ground sits behind each line, soft at the edge.
    const wanted = element.plate > 0 ? element.lines.length : 0;
    while (node.plates.length < wanted) {
      const plate = document.createElement('div');
      plate.style.cssText = 'position:absolute;left:0;top:0;z-index:-2;';
      node.root.appendChild(plate);
      node.plates.push(plate);
    }
    node.plates.forEach((plate, index) => {
      const line = element.lines[index];
      if (line === undefined || element.plate <= 0) {
        plate.style.display = 'none';
        return;
      }
      const pad = fontPx * 0.35;
      plate.style.display = '';
      plate.style.background = frame.ground;
      plate.style.opacity = String(Math.min(1, element.plate));
      plate.style.boxShadow = `0 0 ${px(pad)} ${px(pad * 0.5)} ${frame.ground}`;
      plate.style.transform = `translate(${px(centreX + line.x * s - pad)},${px(centreY + line.y * s)})`;
      plate.style.width = px(line.width * s + pad * 2);
      plate.style.height = px(line.height * s);
    });

    let box = {
      left: centreX - (element.width * s) / 2,
      top: centreY - (element.height * s) / 2,
      right: centreX + (element.width * s) / 2,
      bottom: centreY + (element.height * s) / 2,
    };
    if (element.clip !== undefined) {
      // A point outside the frame does not hit the element: the box is cut to the frame's bounds on the screen.
      const quad = clipQuad(element.clip, element.layer, camera, viewport);
      box = {
        left: Math.max(box.left, Math.min(...quad.map((p) => p.x))),
        top: Math.max(box.top, Math.min(...quad.map((p) => p.y))),
        right: Math.min(box.right, Math.max(...quad.map((p) => p.x))),
        bottom: Math.min(box.bottom, Math.max(...quad.map((p) => p.y))),
      };
    }
    picked.push({ key: element.key, layer: element.layer, ...box, visible: element.opacity * Math.max(0, ...element.runs.map((run) => (run.reveal > 0 ? run.opacity : 0))) > 0.05 });
  };

  return {
    id: 'plain',
    capabilities,
    fontFile,

    async mount(target: HTMLElement, viewport: Viewport, look: LookId): Promise<void> {
      if (getComputedStyle(target).position === 'static') target.style.position = 'relative';
      const container = document.createElement('div');
      container.setAttribute('aria-hidden', 'true');
      container.style.cssText = `position:absolute;left:0;top:0;overflow:hidden;isolation:isolate;pointer-events:none;user-select:none;-webkit-user-select:none;width:${px(viewport.width)};height:${px(viewport.height)};background:${LOOKS[look].roles.ground};`;
      target.appendChild(container);
      root = container;
      cursor = document.createElement('div');
      cursor.style.cssText = 'position:absolute;left:0;top:0;display:none;pointer-events:none;z-index:9;';
      container.appendChild(cursor);
      figures = createPlainFigures(container);
      const faces = Object.values(FONTS).map(async (face) => {
        const loaded = new FontFace(face.family, `url(${face.url}) format("${face.format}")`);
        await loaded.load();
        document.fonts.add(loaded);
      });
      await Promise.all(faces);
      loaded = true;
    },

    resize(viewport: Viewport): void {
      if (root === null) return;
      root.style.width = px(viewport.width);
      root.style.height = px(viewport.height);
    },

    render(frame: Frame): void {
      if (root === null) return;
      root.style.background = frame.ground;
      // the lens: the page is drawn as it always is, and the box that holds it is moved and scaled over the screen (the stage clips it)
      const lens = cssOf(frame.view);
      if (lens !== lensCss) {
        lensCss = lens;
        root.style.transformOrigin = lens === '' ? '' : '0 0';
        root.style.transform = lens;
      }
      figures?.sync(frame.figures, frame.camera, frame.viewport);
      picked = [];
      const seen = new Set<string>();
      for (const element of frame.elements) {
        seen.add(element.key);
        let node = nodes.get(element.key);
        if (node === undefined) {
          node = makeNode(root);
          nodes.set(element.key, node);
        }
        drawElement(frame, element, node);
      }
      for (const [key, node] of nodes) {
        if (seen.has(key)) continue;
        node.outer.remove();
        nodes.delete(key);
      }
      if (cursor !== null) {
        const mark = frame.cursor;
        if (mark === null || !mark.lit) cursor.style.display = 'none';
        else {
          const z = layerZ(mark.layer, frame.viewport);
          const topLeft = projectToScreen({ x: mark.x, y: mark.y, z }, frame.camera, frame.viewport);
          cursor.style.display = '';
          cursor.style.transform = `translate(${px(topLeft.x)},${px(topLeft.y)})`;
          cursor.style.width = px(mark.width * topLeft.scale);
          cursor.style.height = px(mark.height * topLeft.scale);
          if (mark.shape === 'dots') {
            // The waiting signal of the proportional looks: three soft dots that swell in turn.
            cursor.style.background = 'none';
            while (cursor.children.length < 3) {
              const dot = document.createElement('span');
              dot.style.cssText = 'position:absolute;top:50%;border-radius:50%;transform:translate(-50%,-50%);';
              cursor.appendChild(dot);
            }
            const size = Math.max(3, mark.height * topLeft.scale * 0.3);
            Array.from(cursor.children).forEach((child, i) => {
              const dot = child as HTMLElement;
              const swell = frame.reducedMotion ? 0.6 : 0.5 + 0.5 * Math.sin(2 * Math.PI * (frame.ambient / 1.2 - i / 3));
              dot.style.left = `${(i + 0.5) * (100 / 3)}%`;
              dot.style.width = dot.style.height = px(size * (0.6 + 0.4 * swell));
              dot.style.background = mark.colour;
              dot.style.opacity = String(0.35 + 0.65 * swell);
            });
          } else {
            cursor.replaceChildren();
            cursor.style.background = mark.colour;
          }
        }
      }
    },

    isDrawable(): boolean {
      // Text is DOM: once the faces are loaded, whatever the frame says is what the browser lays out.
      return loaded && root !== null;
    },

    reset(): void {
      // Nothing is carried between frames.
    },

    pick(x: number, y: number): string | null {
      for (let i = picked.length - 1; i >= 0; i -= 1) {
        const item = picked[i];
        if (item === undefined || !item.visible) continue;
        if (x >= item.left && x <= item.right && y >= item.top && y <= item.bottom) return item.key;
      }
      return null;
    },

    setQuality(quality: Quality): void {
      void quality;
    },

    preload(url: string): Promise<void> {
      return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve();
        image.onerror = () => reject(new Error(`could not load ${url}`));
        image.src = url;
      });
    },

    rasterise(): Promise<Blob | null> {
      return Promise.resolve(null);
    },

    dispose(): void {
      figures?.dispose();
      figures = null;
      root?.remove();
      root = null;
      loaded = false;
      cursor = null;
      nodes.clear();
      picked = [];
    },
  };
}
