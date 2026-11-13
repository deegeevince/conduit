import type { BackEvent, Sight } from '@conduit/language';
import type { ExportJob, ExportRequest } from './export';
import type { LineView, PainterSnapshot, StageElementView } from './painter';

/**
 * `window.__stage`: how a tester (human or agent) inspects and drives a stage
 * from the browser console. Nothing here waits for requestAnimationFrame, so
 * all of it works in a background tab, where the browser stops the frame loop.
 */
export interface StageHook {
  /** resolves once the stage is mounted and connected to the server */
  readonly ready: Promise<void>;

  /** playhead, pen, lead, clock state, `hidden`, look, scene, renderer, quality, fps */
  state(): PainterSnapshot;
  /** what is on stage at the playhead, with on-screen boxes, colours and contrast ratios */
  elements(): readonly StageElementView[];
  /** the lines of the open turn, or of the last finished one, with their scheduled times */
  lines(): readonly LineView[];
  /** the back-channel events handed to the link so far, oldest first (the last 200); a tap the app set aside is not among them */
  events(): readonly BackEvent[];

  pause(): void;
  play(): void;
  /**
   * Pauses at `seconds` on the turn clock and draws that frame before returning.
   * Works on the open turn, and on the last finished or interrupted turn until
   * the next one opens (`play()` then replays it to its end and the stage rests
   * again). With neither it only redraws. `state().clock` reads `paused`
   * whenever the clock is paused, turn or no turn.
   */
  seek(seconds: number): PainterSnapshot;
  /** Pauses, advances by `seconds`, and draws that frame before returning. */
  step(seconds: number): PainterSnapshot;

  /** The same as typing a prompt and pressing Enter. Resolves with the turn id. */
  prompt(text: string): Promise<string>;
  /** Plays a fixture script through the replay brain. Resolves with the turn id. */
  demo(name: string): Promise<string>;
  /** The same as tapping the element with this id. */
  tap(id: string): void;
  /** The same as pressing Stop. */
  interrupt(): void;

  /** The same as pressing "Show all". */
  showAll(): void;
  /** The canonical Series lines of the last turn, one per line: what "Copy script" copies. '' before the first turn has ended. */
  script(): string;
  /** Plays lines of Series through the replay brain: what "Play a script" does. Resolves with the turn id. */
  playScript(script: string): Promise<string>;
  /** How the last turn landed, exactly as it was reported to the server. Null before the first report. */
  sight(): Sight | null;
  /** A picture of the stage right now as a data URL, at most `maxSide` pixels on its longer side; null when the renderer cannot capture. */
  capture(maxSide?: number): Promise<string | null>;
  /** Starts an export of the last turn and returns the job, whose `done` resolves with the file. */
  export(request: ExportRequest): ExportJob;
}

declare global {
  interface Window {
    /** the stage on the main page */
    __stage?: StageHook;
    /** the gallery's stages, keyed by look */
    __stages?: Record<string, StageHook>;
  }
}
