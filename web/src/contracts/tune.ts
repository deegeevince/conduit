// Tunes: the port between the painter and whatever makes the sound.
//
// The painter decides WHEN a tune is whole and may begin (a later line has closed its block, or the turn has ended) and draws what is
// sounding; it makes no sound. A player makes it, and says how far into each tune it is, so that the picture's playhead keeps time with
// what is heard. With no player a stage is silent and the painter reckons the position from its own clock, which is how a still, a film or
// a draft shows a tune.

import type { TuneModel, TuneVoice } from '@conduit/language';

/** One tune on stage, as the player is told of it every frame. */
export interface TuneCue {
  readonly key: string;
  readonly id: string;
  readonly voice: TuneVoice;
  /** the score as it stands: the notes to play */
  readonly model: TuneModel;
  /** the block is whole: the player may begin it, once */
  readonly ready: boolean;
}

export interface TuneClockState {
  /** the painter's ambient seconds: the music's own clock, frozen while the stage is paused or hidden */
  readonly aq: number;
  /** false while paused, hidden or seeking: the sound holds with the picture */
  readonly running: boolean;
}

export interface TunePlayer {
  /**
   * Told every frame which tunes are on stage and which are ready. It begins each ready tune once; a tune that is no longer named has left the
   * stage and is let go with a short fade. Cheap when nothing changed.
   */
  sync(cues: readonly TuneCue[], now: TuneClockState): void;
  /** Seconds into the tune that is sounding now; null when it is not (not begun, finished, or stopped). */
  positionOf(key: string): number | null;
  /** Silences everything at once; what was stopped is not begun again while it stays on stage. */
  stop(): void;
}
