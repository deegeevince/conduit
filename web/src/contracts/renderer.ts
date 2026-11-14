import type { AmbientKind, ElementKind, Face, FxName, LookId, Medium, StrokeCharacter, Texture } from '@conduit/language';
import type { Frame, Quality } from './frame';
import type { Viewport } from './space';

export interface RendererCapabilities {
  /** layers are real planes at different depths seen through a perspective camera */
  readonly depth: boolean;
  /** the look's screen behaviour is simulated (scanlines, persistence, pixel grid, paper) */
  readonly post: boolean;
  readonly looks: readonly LookId[];
  /** what it can draw besides text. The plain renderer draws shapes and sprites and nothing that moves in the thousands. */
  readonly kinds: readonly ElementKind[];
  readonly fx: readonly FxName[];
  readonly ambient: readonly AmbientKind[];
  /** `rasterise` returns pictures */
  readonly capture: boolean;
  /** the media it renders a sketch in by itself (`PictureFrame.medium`); empty when it cannot */
  readonly media: readonly Medium[];
  /** the fill textures it draws (`FillFrame.texture`), `flat` included */
  readonly textures: readonly Texture[];
  /** the stroke characters it draws on a single shape, whatever the look's own stroke is (`StrokeFrame.character`) */
  readonly brushes: readonly StrokeCharacter[];
}

/**
 * What happened to a renderer's GPU context: `lost` (drawing stops), then `restored` (the browser gave it back),
 * `rebuilt` (it did not, and a new one was made in its place) or `failed` (a new one could not be made: the stage
 * should say so and offer the plain renderer).
 */
export type ContextEvent = 'lost' | 'restored' | 'rebuilt' | 'failed';

/** A font file a renderer sets text in, so a vector export can carry it. */
export interface RendererFont {
  /** the CSS family name */
  readonly family: string;
  readonly url: string;
  readonly format: 'truetype' | 'opentype';
}

/** The font file a face is set in, at normal or bold weight (a face with no bold file gives its one file). */
export type FontResolver = (face: Face, bold: boolean) => RendererFont;

export interface RasteriseOptions {
  /** the longer side of the picture, in pixels; the frame's own aspect is kept */
  readonly maxSide: number;
  readonly mime: 'image/png' | 'image/jpeg' | 'image/webp';
  /** 0..1 for the lossy types */
  readonly quality?: number;
  /** false draws the stage without the look's surface effects, on its flat ground: what a sketch sent to an image model wants */
  readonly fx?: boolean;
  /**
   * The picture of a chart to draw into this one, by the chart's key (`Frame.charts`): the charting engine's own still.
   * A chart draws itself in a surface over the stage, so without this a picture of the stage would have a hole where
   * the chart is. Null for a chart that has nothing to show yet: its room is left as the ground.
   */
  readonly chartStill?: (key: string) => HTMLCanvasElement | null;
  /**
   * Called when the picture had to be taken before all of the frame's text was drawable (the renderer waits up to
   * 2 s for it first), so the caller can mark the picture incomplete or ask again.
   */
  readonly onIncomplete?: () => void;
}

/** What the caller already knows about the stage that is being mounted. */
export interface MountOptions {
  /**
   * The looks this stage can ever show. The others are never compiled or warmed.
   * A stage locked to one look passes just that one; the default is every look.
   */
  readonly looks?: readonly LookId[];
}

/**
 * Draws Frames. The painter owns this interface; three.js is one adapter
 * behind it and the plain DOM renderer is another.
 *
 * A renderer holds no opinion about time, layout or meaning. It may keep
 * objects alive between frames for speed (keyed by `ElementFrame.key`), and a
 * look's feedback effects may read the previous picture, but drawing the same
 * Frame twice after `reset()` must give the same picture.
 */
export interface Renderer {
  readonly id: string;
  readonly capabilities: RendererCapabilities;

  /** Where the renderer's own font files are, usable before `mount`. The exporter embeds them in an SVG; `export` imports no fonts of its own. */
  readonly fontFile?: FontResolver;

  /** Tells the listener when the GPU context is lost, restored, rebuilt or cannot be. Absent on a renderer with no GPU context. Returns the way to stop listening. */
  readonly onContext?: (listener: (event: ContextEvent) => void) => () => void;

  /**
   * Builds the canvas or DOM inside `host` and loads fonts. Resolves only when
   * `look` is truly ready: its face is fully typeset for every character in
   * `GLYPHS`, its programs are compiled, and a real frame of its ground has
   * been presented. Warming never draws into the visible canvas. Until then
   * the host shows the look's ground and nothing else. The other looks in
   * `options.looks` get ready in the background, in idle time, off screen.
   * Rejects when this renderer cannot run here (no WebGL2), so the caller can
   * fall back.
   */
  mount(host: HTMLElement, viewport: Viewport, look: LookId, options?: MountOptions): Promise<void>;

  resize(viewport: Viewport): void;

  /**
   * Draws one frame, completely and synchronously. It must not depend on
   * requestAnimationFrame: the test hook calls it directly while the tab is
   * hidden.
   */
  render(frame: Frame): void;

  /**
   * True when every text run in the most recently rendered frame was typeset
   * and actually drawn: nothing that should be visible was withheld, drawn
   * from stale text or drawn in a stand-in face. False before the first
   * render. The painter holds its clock while this is false during an open
   * turn, and reports nothing as shown before it has been drawn. The look's
   * own furniture (a clock in a header) does not count.
   */
  isDrawable(): boolean;

  /** Clears anything carried between frames (afterglow, trails). Called on seek. */
  reset(): void;

  /**
   * Fetches and decodes a painting so that a later frame naming this URL in a
   * `PictureFrame.src` draws it at once. Resolves when it can be drawn;
   * rejects if it cannot be loaded. Never blocks `render`: until this
   * resolves the painter simply does not send the URL.
   */
  preload(url: string): Promise<void>;

  /**
   * Draws `frame` off screen and returns it as a picture, without touching
   * the visible canvas, the carried state, or `isDrawable`. The frame may be
   * of any viewport: the painter uses this for the snapshot of a resting
   * stage, for the sketch a painting is asked to follow, and the exporter
   * for every frame of a film. Null when this renderer cannot (`capture` is
   * false). Calls are answered in order.
   */
  rasterise(frame: Frame, options: RasteriseOptions): Promise<Blob | null>;

  /** The key of the topmost tappable or visible element under a point in host CSS pixels, as last rendered. */
  pick(x: number, y: number): string | null;

  setQuality(quality: Quality): void;

  dispose(): void;
}
