// troika-three-text ships no usable type declarations. This is the part of
// its API the adapter uses, checked against version 0.53.1; extend it here
// rather than casting at the call site.

declare module 'troika-three-text' {
  import type { Color, Material, Mesh } from 'three';

  export interface TextRenderInfo {
    readonly blockBounds: readonly [number, number, number, number];
    readonly visibleBounds: readonly [number, number, number, number];
    readonly caretPositions: Float32Array;
    /** [minX, minY, maxX, maxY] per glyph, in the order of the text */
    readonly glyphBounds: Float32Array;
    readonly lineHeight: number;
    readonly topBaseline: number;
  }

  export class Text extends Mesh {
    text: string;
    font: string | null;
    fontSize: number;
    letterSpacing: number;
    lineHeight: number | 'normal';
    maxWidth: number;
    whiteSpace: 'normal' | 'nowrap';
    textAlign: 'left' | 'right' | 'center' | 'justify';
    anchorX: number | string;
    anchorY: number | string;
    color: string | number | Color;
    colorRanges: Record<number, string | number | Color> | null;
    fillOpacity: number;
    outlineWidth: number | string;
    outlineColor: string | number | Color;
    outlineOpacity: number;
    outlineBlur: number | string;
    strokeWidth: number | string;
    strokeColor: string | number | Color;
    strokeOpacity: number;
    /** [minX, minY, maxX, maxY] in local units; glyphs outside are not drawn */
    clipRect: [number, number, number, number] | null;
    depthOffset: number;
    sdfGlyphSize: number | null;
    gpuAccelerateSDF: boolean;
    material: Material | Material[];
    readonly textRenderInfo: TextRenderInfo | null;
    /** Typesetting is asynchronous; `callback` runs once the mesh reflects the current properties. */
    sync(callback?: () => void): void;
    dispose(): void;
  }

  export function preloadFont(
    options: { font?: string; characters?: string | readonly string[]; sdfGlyphSize?: number },
    callback: () => void,
  ): void;

  export function configureTextBuilder(config: {
    defaultFontURL?: string;
    unicodeFontsURL?: string;
    sdfGlyphSize?: number;
    sdfExponent?: number;
    sdfMargin?: number;
    textureWidth?: number;
    useWorker?: boolean;
  }): void;
}
