// The painter's own synthesiser: four instruments out of oscillators, filters and envelopes, with nothing to load. One note is a handful
// of nodes made when it is scheduled and let go when it ends, so a tune costs no more than the notes in the next second or two.
//
//   piano    two slightly detuned strings, each a wave of harmonics that fall away as the note rings, through a filter that darkens as it
//            decays, the way a struck string does; the lower the note the longer it rings; a lifted key damps it
//   strings  two sawtooth voices a few cents apart, a slow bow, a little vibrato that arrives after the note has settled
//   chip     a square wave and nothing else, with a quick attack and release: a games console
//   bell     two sine operators in an inharmonic ratio, the modulation fading faster than the tone: a struck metal bell that rings on

import type { TuneVoice } from '@conduit/language';

/** Frequency of a MIDI note, equal temperament, A4 = 440 Hz. */
export const hertz = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);

export interface NoteOn {
  readonly voice: TuneVoice;
  readonly midi: number;
  /** 0..1 */
  readonly vel: number;
  /** AudioContext time the note begins, and the seconds the key is held */
  readonly at: number;
  readonly hold: number;
}

/** Everything a voice needs of the world: the context, where to send the sound, and a way to know a note is over. */
export interface Rig {
  readonly ctx: BaseAudioContext;
  readonly out: AudioNode;
  readonly waves: ReadonlyMap<string, PeriodicWave>;
}

/** The waves the piano is made of, built once for a context. The harmonics are the same for every note; the filter does the rest. */
export function makeWaves(ctx: BaseAudioContext): Map<string, PeriodicWave> {
  const make = (amplitudes: readonly number[]): PeriodicWave => {
    const real = new Float32Array(amplitudes.length + 1);
    const imag = new Float32Array(amplitudes.length + 1);
    amplitudes.forEach((a, i) => {
      imag[i + 1] = a;
    });
    return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
  };
  return new Map([
    ['piano', make([1, 0.62, 0.38, 0.22, 0.14, 0.09, 0.055, 0.035, 0.02, 0.012])],
    ['strings', make([1, 0.5, 0.33, 0.25, 0.2, 0.16, 0.13, 0.11])],
  ]);
}

function shape(param: AudioParam, at: number, steps: readonly (readonly [number, number])[]): void {
  // exponential ramps cannot touch zero, and a ramp needs somewhere to start
  param.setValueAtTime(Math.max(steps[0]?.[1] ?? 0.0001, 0.0001), at);
  for (const [seconds, value] of steps.slice(1)) param.exponentialRampToValueAtTime(Math.max(value, 0.0001), at + seconds);
}

/**
 * A level that follows `points` (seconds, level; each stretch a straight line on a log scale) until the key is lifted at `hold`, then falls away
 * over `damp` seconds from wherever it had got to. Events go in the order the audio clock reads them, which a ramp and a damper cannot be trusted to.
 */
function envelope(param: AudioParam, at: number, points: readonly (readonly [number, number])[], hold: number, damp: number): void {
  param.setValueAtTime(Math.max(points[0]?.[1] ?? 0.0001, 0.0001), at);
  let cut = false;
  for (let i = 1; i < points.length; i += 1) {
    const [s0, v0] = points[i - 1] as readonly [number, number];
    const [s1, v1] = points[i] as readonly [number, number];
    if (s1 <= hold) {
      param.exponentialRampToValueAtTime(Math.max(v1, 0.0001), at + s1);
    } else {
      if (s0 < hold) {
        const level = Math.exp(Math.log(Math.max(v0, 0.0001)) + ((Math.log(Math.max(v1, 0.0001)) - Math.log(Math.max(v0, 0.0001))) * (hold - s0)) / (s1 - s0));
        param.exponentialRampToValueAtTime(level, at + hold);
      }
      cut = true;
      break;
    }
  }
  if (cut || (points[points.length - 1]?.[0] ?? 0) > hold) param.exponentialRampToValueAtTime(0.0001, at + hold + damp);
}

/**
 * Schedules one note on `rig`. Returns when the last of its sound will have ended, in context time, so that the caller can count the notes
 * still sounding; nothing here waits and nothing is held after that moment.
 */
export function playNote(rig: Rig, note: NoteOn): number {
  const { ctx, out } = rig;
  const f = hertz(note.midi);
  const t = note.at;
  const hold = Math.max(0.05, note.hold);
  const amp = note.vel;
  const nodes: AudioScheduledSourceNode[] = [];
  const done = (end: number): number => {
    for (const node of nodes) node.stop(end);
    return end;
  };
  const gain = ctx.createGain();
  gain.connect(out);
  const osc = (type: 'sine' | 'square' | { readonly wave: PeriodicWave }, frequency: number, detune = 0): OscillatorNode => {
    const o = ctx.createOscillator();
    if (typeof type === 'string') o.type = type;
    else o.setPeriodicWave(type.wave);
    o.frequency.setValueAtTime(frequency, t);
    o.detune.setValueAtTime(detune, t);
    o.start(t);
    nodes.push(o);
    return o;
  };

  switch (note.voice) {
    case 'piano': {
      // lower notes ring longer; a key lifted early damps the string
      const ring = Math.min(5, Math.max(0.7, 4.2 - (note.midi - 36) * 0.045));
      const end = t + Math.max(hold, 0.12) + 0.14;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.Q.value = 0.4;
      const open = Math.min(9000, f * (3 + amp * 9));
      shape(filter.frequency, t, [[0, open], [0.05, open * 0.55], [ring * 0.5, Math.max(f * 1.6, 500)]]);
      const wave = rig.waves.get('piano');
      if (wave === undefined) return t;
      for (const detune of [-1.6, 1.4]) osc({ wave }, f, detune).connect(filter);
      filter.connect(gain);
      const peak = 0.2 * amp * (0.8 + 0.4 * (1 - Math.min(1, Math.max(0, (note.midi - 36) / 60))));
      envelope(gain.gain, t, [[0, 0.0001], [0.004, peak], [0.12, peak * 0.35], [ring, 0.0003]], hold, 0.09);
      return done(Math.min(t + ring + 0.1, end + 0.4, t + hold + 0.45));
    }
    case 'strings': {
      const attack = Math.min(0.14, hold * 0.5);
      const release = 0.3;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.Q.value = 0.7;
      filter.frequency.setValueAtTime(Math.min(8000, f * 2.2), t);
      filter.frequency.linearRampToValueAtTime(Math.min(8000, f * (3 + amp * 4)), t + attack + 0.1);
      const wave = rig.waves.get('strings');
      if (wave === undefined) return t;
      const voices = [osc({ wave }, f, -6), osc({ wave }, f, 6)];
      // a vibrato that comes in once the note has settled
      const lfo = osc('sine', 5.4);
      const depth = ctx.createGain();
      depth.gain.setValueAtTime(0, t);
      depth.gain.linearRampToValueAtTime(7, t + attack + 0.35);
      lfo.connect(depth);
      for (const v of voices) {
        depth.connect(v.detune);
        v.connect(filter);
      }
      filter.connect(gain);
      const peak = 0.13 * amp;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.linearRampToValueAtTime(peak, t + attack);
      gain.gain.setValueAtTime(peak * 0.9, t + hold);
      gain.gain.setTargetAtTime(0.0001, t + hold, release / 3);
      return done(t + hold + release * 1.6);
    }
    case 'chip': {
      const release = 0.04;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 7000;
      osc('square', f).connect(filter);
      filter.connect(gain);
      const peak = 0.075 * (0.5 + amp);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.linearRampToValueAtTime(peak, t + 0.003);
      // a console's note drops to a lower level at once and holds it
      gain.gain.setValueAtTime(peak, t + 0.02);
      gain.gain.linearRampToValueAtTime(peak * 0.72, t + Math.min(0.08, hold));
      gain.gain.setValueAtTime(peak * 0.72, t + hold);
      gain.gain.linearRampToValueAtTime(0.0001, t + hold + release);
      return done(t + hold + release + 0.02);
    }
    case 'bell': {
      const ring = Math.min(4.5, Math.max(1.6, hold + 1.6));
      const carrier = osc('sine', f);
      const modulator = osc('sine', f * 3.5);
      const index = ctx.createGain();
      shape(index.gain, t, [[0, f * (1.2 + amp * 2.4)], [ring * 0.35, f * 0.05]]);
      modulator.connect(index);
      index.connect(carrier.frequency);
      carrier.connect(gain);
      // a second, higher partial that dies sooner: the bright strike
      const partial = osc('sine', f * 2.76);
      const brightness = ctx.createGain();
      shape(brightness.gain, t, [[0, 0.35], [0.9, 0.001]]);
      partial.connect(brightness);
      brightness.connect(gain);
      const peak = 0.17 * amp;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.linearRampToValueAtTime(peak, t + 0.003);
      gain.gain.exponentialRampToValueAtTime(0.0003, t + ring);
      return done(t + ring + 0.05);
    }
  }
}
