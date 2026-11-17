// Getting an answer off the stage as something that can be kept and used
// elsewhere: a video, a still, a vector drawing, or the script
// itself. A film is rendered frame by frame from the timeline, never recorded
// off the screen, so an export is exact at any size and any frame rate and
// does not depend on how fast this machine can draw.

import type { Film } from './film';

export type ExportRequest =
  /**
   * a video file; the container is chosen by what this browser can encode (`formats()` says). `scope` is for the app, which decides what film
   * it hands the exporter: `turn` the last turn alone, `answer` (the default) the last answer and the taps that carried it on, `conversation`
   * every turn, each after a title card. The exporter only names the file by it. The tunes in the film are in the file as sound when this
   * browser can encode it.
   */
  | { readonly kind: 'video'; readonly format: 'webm' | 'mp4'; readonly width: number; readonly height: number; readonly fps: number; readonly from?: number; readonly to?: number; readonly scope?: 'turn' | 'answer' | 'conversation'; /** a film that says where it is quiet has its long waits cut to a moment with a marker (default on); `false` keeps them whole, `{ threshold }` sets how long a wait must be (seconds, default 4) */ readonly cuts?: boolean | { readonly threshold?: number }; /** a film that can (`Film.framing`) eases its framing toward the element being drawn and back out to the whole stage between lines (default on); `false` keeps the whole stage always */ readonly follow?: boolean }
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
  readonly done: Promise<{ readonly blob: Blob; readonly fileName: string; /** a video: the film's music is in the file */ readonly hasSound?: boolean; /** something the viewer should be told about what was made, in a sentence (the film was cut to its limit) */ readonly note?: string; /** a film with waits cut out: where, in the session's real time, so another recording can be cut the same */ readonly cuts?: CutList }>;
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
 * - Frame `n` of a video is `film.frameAt(from + n / fps)`,
 *   for every n, with no frame dropped or doubled; the file's duration is
 *   `to - from` to within one frame.
 * - `svg` contains shapes, sprites and text as vectors (text as outlines or
 *   with its font embedded, never as a reference to a font the reader may not
 *   have), paintings as embedded images, a shape that bleeds covering the
 *   whole picture, the look's flat ground, and none of its surface effects.
 *   Weather is not drawn: the file names the kinds it left out in a `<desc>`.
 *   The fonts come from `Renderer.fontFile`; `export` imports none of its own.
 * - One renderer job at a time (a film, a PNG still): starting
 *   one while another is running fails the new job with a message and leaves
 *   the running one alone; a job that has been cancelled is waited for first.
 *   The script and the SVG touch no renderer and run beside any job.
 * - Cancel is heard while a load, a mount or a capture is being waited for.
 */
export interface Exporter {
  /** what this browser can make, so the menu offers nothing that will fail */
  formats(): Promise<{ readonly video: readonly ('webm' | 'mp4')[]; readonly svg: boolean; readonly pdf: boolean }>;
  start(film: Film, request: ExportRequest): ExportJob;
  dispose(): void;
}

/** One cut, in real time (the session's own clock, before anything was cut). */
export interface Cut {
  /** the real second the cut begins and the real second the film goes on from */
  readonly from: number;
  readonly to: number;
  /** the real seconds taken out: `to - from`, which is the number in the marker */
  readonly removed: number;
}

/** What is written beside a film that had waits cut out of it. */
export interface CutList {
  readonly threshold: number;
  readonly keep: number;
  /** the film's length in real time, and what it came to after the cuts */
  readonly realSeconds: number;
  readonly filmSeconds: number;
  readonly cuts: readonly Cut[];
}
