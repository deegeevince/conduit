// The sound track of a film: the tunes its pictures keep time with, played by the painter's own synthesiser into an OfflineAudioContext.
// It is rendered faster than it plays, from the same notes, voices, fades and master level the live stage uses (`audio/sound.ts`), so a saved
// film sounds as the stage did. Nothing here touches a speaker.

import type { FilmTune } from '../contracts/film';
import { makeWaves, playNote } from '../audio/synth';

export const SOUND_RATE = 48000;
/** The live stage's master level and fades (`audio/sound.ts`): kept the same, so that a film is as loud as the stage was. */
const MASTER = 0.55;
const FADE_IN = 0.06;
const FADE_OUT = 0.25;

export interface Sound {
  /** mono, `SOUND_RATE` Hz, as long as the film */
  readonly samples: Float32Array<ArrayBuffer>;
  readonly sampleRate: number;
}

/** The music of `tunes` laid on a track `seconds` long; null when there is no music, or this browser cannot render audio off line. */
export async function renderSound(tunes: readonly FilmTune[], seconds: number): Promise<Sound | null> {
  if (tunes.length === 0 || typeof OfflineAudioContext === 'undefined' || seconds <= 0) return null;
  const length = Math.max(1, Math.ceil(seconds * SOUND_RATE));
  const ctx = new OfflineAudioContext(1, length, SOUND_RATE);
  const master = ctx.createGain();
  master.gain.value = MASTER;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -9;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.12;
  master.connect(limiter);
  limiter.connect(ctx.destination);
  const waves = makeWaves(ctx);
  let notes = 0;
  for (const tune of tunes) {
    const bus = ctx.createGain();
    bus.gain.setValueAtTime(0, tune.at);
    bus.gain.linearRampToValueAtTime(1, tune.at + FADE_IN);
    // A tune whose picture left the stage before it ended is let go with the short fade the stage gives it.
    const ends = tune.at + tune.model.seconds + 0.35;
    if (tune.until < ends) bus.gain.setTargetAtTime(0, Math.max(tune.at + FADE_IN, tune.until), FADE_OUT / 4);
    bus.connect(master);
    const perBeat = 60 / tune.model.tempo;
    for (const note of tune.model.notes) {
      const at = tune.at + note.start * perBeat;
      if (at >= Math.min(seconds, tune.until)) break;
      playNote({ ctx, out: bus, waves }, { voice: tune.voice, midi: note.midi, vel: note.vel, at, hold: Math.max(0.05, note.dur * perBeat * 0.96) });
      notes += 1;
    }
  }
  if (notes === 0) return null;
  const rendered = await ctx.startRendering();
  return { samples: rendered.getChannelData(0), sampleRate: rendered.sampleRate };
}
