// Getting an answer off the stage as something that can be kept and used
// elsewhere: a video, a strip of stills, a vector drawing, or the script
// itself. A film is rendered frame by frame from the timeline, never recorded
// off the screen, so an export is exact at any size and any frame rate and
// does not depend on how fast this machine can draw.

import type { Film } from './film';

export type ExportRequest =
  /** a video file; the container is chosen by what this browser can encode (`formats()` says) */
  | { readonly kind: 'video'; readonly format: 'webm' | 'mp4'; readonly width: number; readonly height: number; readonly fps: number; readonly from?: number; readonly to?: number }
  /** a zip of numbered PNGs */
  | { readonly kind: 'frames'; readonly width: number; readonly height: number; readonly fps: number; readonly from?: number; readonly to?: number }
  /** one still */
  | { readonly kind: 'still'; readonly format: 'png' | 'svg'; readonly width: number; readonly height: number; readonly at: number }
  /** the Series lines, as a .series text file */
  | { readonly kind: 'script' }
  /** a PDF with one page for each of `at` (film times, in order): a deck's slides, or any set of stills. Each page is a JPEG of the stage at `width` x `height`. */
  | { readonly kind: 'pdf'; readonly width: number; readonly height: number; readonly at: readonly number[] };

export interface ExportProgress {
  /** 0..1 */
  readonly done: number;
  readonly frame: number;
  readonly frames: number;
  /** present once a video frame had to be taken before all of its text was drawable (the exporter waits 2 s for it first): the film is made, but say so */
  readonly incompleteFrames?: number;
}

export interface ExportJob {
  /** resolves with the finished file; rejects with a message a person can act on, or with an AbortError after `cancel` */
  readonly done: Promise<{ readonly blob: Blob; readonly fileName: string }>;
  onProgress(listener: (progress: ExportProgress) => void): () => void;
  cancel(): void;
}

/**
 * The port. The app owns this interface; WebCodecs and a muxer sit behind it
 * in `export/video.ts` and nowhere else.
 *
 * Contract:
 * - It draws through a renderer of its own, mounted off screen at the export
 *   size, so the visible stage is never resized, paused or slowed.
 * - Frame `n` of a video or a frame strip is `film.frameAt(from + n / fps)`,
 *   for every n, with no frame dropped or doubled; the file's duration is
 *   `to - from` to within one frame.
 * - `svg` contains shapes, sprites and text as vectors (text as outlines or
 *   with its font embedded, never as a reference to a font the reader may not
 *   have), paintings as embedded images, a shape that bleeds covering the
 *   whole picture, the look's flat ground, and none of its surface effects.
 *   Weather is not drawn: the file names the kinds it left out in a `<desc>`.
 *   The fonts come from `Renderer.fontFile`; `export` imports none of its own.
 * - One renderer job at a time (a film, a frame strip, a PNG still): starting
 *   one while another is running fails the new job with a message and leaves
 *   the running one alone; a job that has been cancelled is waited for first.
 *   The script and the SVG touch no renderer and run beside any job.
 * - Cancel is heard while a load, a mount or a capture is being waited for.
 */
export interface Exporter {
  /** what this browser can make, so the menu offers nothing that will fail */
  formats(): Promise<{ readonly video: readonly ('webm' | 'mp4')[]; readonly frames: boolean; readonly svg: boolean; readonly pdf: boolean }>;
  start(film: Film, request: ExportRequest): ExportJob;
  dispose(): void;
}
