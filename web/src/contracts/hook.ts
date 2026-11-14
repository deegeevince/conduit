import type { BackEvent, ControlValue, Sight } from '@conduit/language';
import type { ExportJob, ExportRequest } from './export';
import type { ChartProbe, ChartView } from './chart';
import type { ControlView, LineView, PainterSnapshot, StageElementView } from './painter';

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
  /** The charts on stage: what each draws, its visible range, and what its crosshair is on. */
  charts(): readonly ChartView[];
  /**
   * Works a chart as a pointer would, for a test: `hover` puts the crosshair at a share of the chart's width (0 left, 1 right),
   * `zoom` by a factor about its centre, `pan` by a share of its width, `reset` puts the view back. Resolves with what the chart
   * shows after the engine has drawn it. Throws when no chart has the id.
   */
  chart(id: string, action: { readonly hover: number } | { readonly zoom: number } | { readonly pan: number } | { readonly reset: true }): Promise<ChartProbe>;
  /** The controls on stage, with their values and where they are on screen. */
  controls(): readonly ControlView[];
  /**
   * The same as the user setting this control and letting go: bindings follow at once, a `control` back event is sent, and a
   * button or a control marked `send` opens a turn. A button takes no value. Throws when no live control has the id.
   */
  control(id: string, value?: ControlValue): void;
  /** The same as pressing Stop. */
  interrupt(): void;
  /** The music: whether it is muted, which tunes are sounding, and the notes handed to the audio clock so far (for a test that cannot hear). */
  music(): { readonly muted: boolean; readonly playing: readonly string[]; readonly notes: readonly { readonly key: string; readonly voice: string; readonly midi: number; readonly score: number; readonly when: number; readonly began: number; readonly handed: number }[] };

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
