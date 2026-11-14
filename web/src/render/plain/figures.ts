// The plain renderer's drawing: one inline SVG per layer, behind the text.
// It is the proof that drawing does not depend on WebGL, and what a browser
// without it gets.

import type { Layer } from '@conduit/language';
import type { Affine, FigureFrame, PictureFrame, ShapeFrame, SpriteFrame } from '../../contracts/frame';
import { layerZ, projectToScreen } from '../../contracts/space';
import type { CameraPose, Viewport } from '../../contracts/space';

export interface PlainFigures {
  /** Draws shapes and sprites (stroke progress as a dash offset, sprites as crisp rects); pictures as <image>; no fields, no surface effects. */
  sync(figures: readonly FigureFrame[], camera: CameraPose, viewport: Viewport): void;
  dispose(): void;
}

const SVG = 'http://www.w3.org/2000/svg';
const LAYERS: readonly Layer[] = ['far', 'bg', 'mid', 'fg'];
/** A stroke is never thinner than this many device pixels. */
const MIN_STROKE_DEVICE_PX = 1.25;

interface Node {
  readonly root: SVGGElement;
  readonly body: SVGElement;
  readonly layer: Layer;
  /** attributes as last written, so an unchanged frame touches nothing */
  readonly written: Map<string, string>;
  shape: string;
}

function px(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

function put(node: Node, target: Element, name: string, value: string): void {
  const key = `${target === node.root ? 'r' : 'b'}:${name}`;
  if (node.written.get(key) === value) return;
  node.written.set(key, value);
  if (value === '') target.removeAttribute(name);
  else target.setAttribute(name, value);
}

/** The matrix that takes a figure's own units to the screen: its layer's plane, seen through the camera. */
function screenMatrix(transform: Affine, layer: Layer, camera: CameraPose, viewport: Viewport): Affine {
  const z = layerZ(layer, viewport);
  const at = (x: number, y: number): { x: number; y: number } => {
    const sx = transform.a * x + transform.c * y + transform.e;
    const sy = transform.b * x + transform.d * y + transform.f;
    return projectToScreen({ x: sx, y: sy, z }, camera, viewport);
  };
  const origin = at(0, 0);
  const right = at(1, 0);
  const down = at(0, 1);
  return { a: right.x - origin.x, b: right.y - origin.y, c: down.x - origin.x, d: down.y - origin.y, e: origin.x, f: origin.y };
}

function matrixText(m: Affine): string {
  return `matrix(${px(m.a)} ${px(m.b)} ${px(m.c)} ${px(m.d)} ${px(m.e)} ${px(m.f)})`;
}

function scaleOf(m: Affine): number {
  return Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
}

function pathData(shape: ShapeFrame): string {
  const parts: string[] = [];
  for (const line of shape.outline) {
    line.points.forEach((p, i) => parts.push(`${i === 0 ? 'M' : 'L'}${px(p.x)} ${px(p.y)}`));
    if (line.closed && line.points.length > 0) parts.push('Z');
  }
  return parts.join('');
}

export function createPlainFigures(host: HTMLElement): PlainFigures {
  const layers = new Map<Layer, SVGSVGElement>();
  const defs = new Map<Layer, SVGDefsElement>();
  const nodes = new Map<string, Node>();
  const orders = new Map<Layer, string>();
  LAYERS.forEach((layer, rank) => {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.cssText = `position:absolute;left:0;top:0;overflow:visible;pointer-events:none;z-index:${rank * 2};`;
    const definitions = document.createElementNS(SVG, 'defs');
    svg.appendChild(definitions);
    host.appendChild(svg);
    layers.set(layer, svg);
    defs.set(layer, definitions);
  });

  const make = (figure: FigureFrame): Node | null => {
    const svg = layers.get(figure.layer);
    if (svg === undefined) return null;
    const root = document.createElementNS(SVG, 'g');
    const body = document.createElementNS(SVG, figure.kind === 'shape' ? 'path' : 'g');
    root.appendChild(body);
    svg.appendChild(root);
    return { root, body, layer: figure.layer, written: new Map(), shape: '' };
  };

  const gradient = (layer: Layer, id: string, from: string, to: string): void => {
    const definitions = defs.get(layer);
    if (definitions === undefined) return;
    let found = definitions.querySelector(`#${CSS.escape(id)}`);
    if (found === null) {
      found = document.createElementNS(SVG, 'linearGradient');
      found.setAttribute('id', id);
      found.setAttribute('x1', '0');
      found.setAttribute('y1', '0');
      found.setAttribute('x2', '0');
      found.setAttribute('y2', '1');
      found.appendChild(document.createElementNS(SVG, 'stop'));
      found.appendChild(document.createElementNS(SVG, 'stop'));
      definitions.appendChild(found);
    }
    const stops = found.querySelectorAll('stop');
    stops[0]?.setAttribute('stop-color', from);
    stops[0]?.setAttribute('offset', '0');
    stops[1]?.setAttribute('stop-color', to);
    stops[1]?.setAttribute('offset', '1');
  };

  /** A pattern for a hatched or dotted fill, in the shape's own units so it stays put on the shape: one per kind, colour and pitch. */
  const pattern = (layer: Layer, texture: 'hatch' | 'dots', colour: string, pitch: number): string => {
    const id = `t-${texture}-${colour.replace(/[^a-z0-9]/gi, '')}-${Math.round(pitch * 100)}`;
    const definitions = defs.get(layer);
    if (definitions === undefined || definitions.querySelector(`#${CSS.escape(id)}`) !== null) return id;
    const made = document.createElementNS(SVG, 'pattern');
    made.setAttribute('id', id);
    made.setAttribute('patternUnits', 'userSpaceOnUse');
    made.setAttribute('width', px(pitch));
    made.setAttribute('height', px(pitch));
    if (texture === 'hatch') {
      // pen lines at 45 degrees, a stroke apart
      made.setAttribute('patternTransform', 'rotate(-45)');
      const line = document.createElementNS(SVG, 'rect');
      line.setAttribute('width', px(pitch));
      line.setAttribute('height', px(pitch * 0.3));
      line.setAttribute('fill', colour);
      made.appendChild(line);
    } else {
      const dot = document.createElementNS(SVG, 'circle');
      dot.setAttribute('cx', px(pitch / 2));
      dot.setAttribute('cy', px(pitch / 2));
      dot.setAttribute('r', px(pitch * 0.22));
      dot.setAttribute('fill', colour);
      made.appendChild(dot);
    }
    definitions.appendChild(made);
    return id;
  };

  /** A blur for a soft edge, one per size. */
  const softness = (layer: Layer, size: number): string => {
    const id = `s-${Math.round(size * 100)}`;
    const definitions = defs.get(layer);
    if (definitions === undefined || definitions.querySelector(`#${CSS.escape(id)}`) !== null) return id;
    const filter = document.createElementNS(SVG, 'filter');
    filter.setAttribute('id', id);
    filter.setAttribute('x', '-50%');
    filter.setAttribute('y', '-50%');
    filter.setAttribute('width', '200%');
    filter.setAttribute('height', '200%');
    const blur = document.createElementNS(SVG, 'feGaussianBlur');
    blur.setAttribute('stdDeviation', px(size * 0.5));
    filter.appendChild(blur);
    definitions.appendChild(filter);
    return id;
  };

  const drawShape = (node: Node, figure: ShapeFrame, m: Affine, viewport: Viewport): void => {
    const body = node.body;
    const key = figure.geometryKey;
    if (node.shape !== key) {
      node.shape = key;
      body.setAttribute('d', pathData(figure));
      node.written.delete('b:d');
    }
    const scale = Math.max(1e-6, scaleOf(m));
    const stroke = figure.stroke;
    put(node, node.root, 'transform', figure.bleed ? '' : matrixText(m));
    put(node, node.root, 'opacity', figure.opacity >= 1 ? '' : px(figure.opacity));
    put(node, body, 'filter', figure.soft !== undefined && figure.soft > 0 && !figure.bleed ? `url(#${softness(node.layer, figure.soft)})` : '');
    const texture = figure.fill?.texture;
    if (figure.fill !== null && (texture === 'hatch' || texture === 'dots')) {
      put(node, body, 'fill', `url(#${pattern(node.layer, texture, figure.fill.colour, Math.max(1, (figure.stroke?.width ?? 1.2) * 2.2))})`);
      put(node, body, 'fill-opacity', figure.fill.opacity >= 1 ? '' : px(figure.fill.opacity));
    } else if (figure.fill === null) put(node, body, 'fill', 'none');
    else if (figure.fill.to === null) {
      put(node, body, 'fill', figure.fill.colour);
      put(node, body, 'fill-opacity', figure.fill.opacity >= 1 ? '' : px(figure.fill.opacity));
    } else {
      const id = `g-${figure.key.replace(/[^a-z0-9_-]/gi, '_')}`;
      gradient(node.layer, id, figure.fill.colour, figure.fill.to);
      put(node, body, 'fill', `url(#${id})`);
      put(node, body, 'fill-opacity', figure.fill.opacity >= 1 ? '' : px(figure.fill.opacity));
    }
    if (stroke === null) {
      put(node, body, 'stroke', 'none');
      put(node, body, 'stroke-dasharray', '');
    } else {
      put(node, body, 'stroke', stroke.colour);
      put(node, body, 'stroke-width', px(Math.max(stroke.width, MIN_STROKE_DEVICE_PX / viewport.dpr / scale)));
      put(node, body, 'stroke-linecap', 'round');
      put(node, body, 'stroke-linejoin', 'round');
      put(node, body, 'pathLength', '1');
      // The share drawn so far, in the order the outline was written; one tick short of whole is still a dash and a gap.
      put(node, body, 'stroke-dasharray', stroke.progress >= 1 ? '' : `${px(Math.max(0, stroke.progress))} 2`);
      put(node, body, 'shape-rendering', stroke.character === 'pixel' ? 'crispEdges' : '');
    }
    if (figure.bleed) {
      // A full-bleed sheet covers the screen whatever the camera does.
      put(node, body, 'd', `M0 0H${px(viewport.width)}V${px(viewport.height)}H0Z`);
      put(node, node.root, 'transform', '');
    }
  };

  const drawSprite = (node: Node, figure: SpriteFrame, m: Affine): void => {
    put(node, node.root, 'transform', matrixText(m));
    put(node, node.root, 'opacity', figure.opacity >= 1 ? '' : px(figure.opacity));
    put(node, node.body, 'shape-rendering', 'crispEdges');
    const key = `${figure.cellsKey}|${figure.cell}`;
    if (node.shape === key) return;
    node.shape = key;
    node.body.replaceChildren();
    const x0 = (-figure.cols * figure.cell) / 2;
    const y0 = (-figure.rows * figure.cell) / 2;
    for (let r = 0; r < figure.rows; r += 1) {
      let c = 0;
      while (c < figure.cols) {
        const colour = figure.cells[r * figure.cols + c] ?? null;
        if (colour === null) {
          c += 1;
          continue;
        }
        let end = c + 1;
        while (end < figure.cols && figure.cells[r * figure.cols + end] === colour) end += 1;
        const rect = document.createElementNS(SVG, 'rect');
        // A hair of overlap, so no seam shows between neighbours at a fractional size.
        rect.setAttribute('x', px(x0 + c * figure.cell));
        rect.setAttribute('y', px(y0 + r * figure.cell));
        rect.setAttribute('width', px((end - c) * figure.cell + 0.02 * figure.cell));
        rect.setAttribute('height', px(figure.cell * 1.02));
        rect.setAttribute('fill', colour);
        node.body.appendChild(rect);
        c = end;
      }
    }
  };

  const clipFor = (node: Node, figure: PictureFrame): string => {
    const b = figure.box;
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    // The painting spreads outward from the middle of the sketch like a wash; the plain renderer has no lines to start from.
    const reach = Math.hypot(b.width, b.height) / 2;
    const r = reach * figure.develop;
    const svg = layers.get(node.layer);
    const id = `c-${figure.key.replace(/[^a-z0-9_-]/gi, '_')}`;
    if (svg !== undefined) {
      let clip = svg.querySelector(`#${CSS.escape(id)}`);
      if (clip === null) {
        clip = document.createElementNS(SVG, 'clipPath');
        clip.setAttribute('id', id);
        clip.appendChild(document.createElementNS(SVG, 'circle'));
        svg.appendChild(clip);
      }
      const circle = clip.firstElementChild;
      circle?.setAttribute('cx', px(cx));
      circle?.setAttribute('cy', px(cy));
      circle?.setAttribute('r', px(r));
    }
    return `url(#${id})`;
  };

  const drawPicture = (node: Node, figure: PictureFrame, m: Affine): void => {
    put(node, node.root, 'transform', matrixText(m));
    put(node, node.root, 'opacity', figure.opacity >= 1 ? '' : px(figure.opacity));
    let image = node.body.firstElementChild;
    if (figure.src === null || figure.develop <= 0) {
      image?.remove();
      return;
    }
    if (image === null) {
      image = document.createElementNS(SVG, 'image');
      image.setAttribute('preserveAspectRatio', 'none');
      node.body.appendChild(image);
    }
    const b = figure.box;
    image.setAttribute('href', figure.src);
    image.setAttribute('x', px(b.x));
    image.setAttribute('y', px(b.y));
    image.setAttribute('width', px(b.width));
    image.setAttribute('height', px(b.height));
    node.body.setAttribute('clip-path', figure.develop >= 1 ? '' : clipFor(node, figure));
    if (figure.develop >= 1) node.body.removeAttribute('clip-path');
  };

  return {
    sync(figures, camera, viewport) {
      const seen = new Set<string>();
      const wanted = new Map<Layer, string[]>();
      // The renderer cannot paint a sketch in a medium, so it keeps the sketch: a painting that is wanted shows its sketch whole instead of fading it away to nothing.
      const sketched = new Map<string, number>();
      for (const figure of figures) {
        if (figure.kind !== 'picture' || figure.medium === undefined || figure.src !== null || figure.develop <= 0) continue;
        for (const key of figure.sketch ?? []) sketched.set(key, figure.opacity);
      }
      for (const original of figures) {
        const whole = original.kind === 'shape' ? sketched.get(original.key) : undefined;
        const figure: FigureFrame =
          original.kind === 'shape' && whole !== undefined ? { ...original, opacity: Math.max(original.opacity, whole), stroke: original.stroke === null ? null : { ...original.stroke, progress: 1 } } : original;
        seen.add(figure.key);
        let node = nodes.get(figure.key);
        if (node === undefined) {
          node = make(figure) ?? undefined;
          if (node === undefined) continue;
          nodes.set(figure.key, node);
        }
        const matrix = screenMatrix(figure.transform, figure.layer, camera, viewport);
        if (figure.kind === 'shape') drawShape(node, figure, matrix, viewport);
        else if (figure.kind === 'sprite') drawSprite(node, figure, matrix);
        else drawPicture(node, figure, matrix);
        const list = wanted.get(figure.layer) ?? [];
        list.push(figure.key);
        wanted.set(figure.layer, list);
      }
      for (const [key, node] of nodes) {
        if (seen.has(key)) continue;
        node.root.remove();
        nodes.delete(key);
      }
      for (const layer of LAYERS) {
        const svg = layers.get(layer);
        if (svg === undefined) continue;
        svg.setAttribute('width', px(viewport.width));
        svg.setAttribute('height', px(viewport.height));
        const list = wanted.get(layer) ?? [];
        const order = list.join('|');
        if (orders.get(layer) === order) continue;
        orders.set(layer, order);
        // Drawing order within a layer is z order; the list arrives sorted.
        for (const key of list) {
          const node = nodes.get(key);
          if (node !== undefined) svg.appendChild(node.root);
        }
      }
    },
    dispose() {
      for (const svg of layers.values()) svg.remove();
      layers.clear();
      defs.clear();
      nodes.clear();
      orders.clear();
    },
  };
}
