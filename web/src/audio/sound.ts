// The sound of a stage: a `TunePlayer` made of the synthesiser in `synth.ts`, a master volume and a limiter, and nothing loaded.
//
//   voices -> a bus for each tune (its fade) -> master (the volume, and the mute) -> a limiter -> the speakers
//
// QUIET BY DEFAULT. The master sits at a modest level; every tune fades in over a moment and out when it is stopped or has left the stage; a
// compressor set as a limiter catches a thick chord, so nothing is ever louder than the notes were meant to be. Muting is a ramp, not a cut.
//
// IN STEP. The first note of a tune is set a little after "now", and the playhead the painter draws is read from the audio clock itself,
// less the output latency: what moves is what is heard. Notes are scheduled a second or two ahead, a few at a time, so a long piece never
// makes a burst of nodes. Everything stops with the stage: while the painter's clock is paused or the tab is hidden the context is suspended
// and the music holds with the picture.
//
// THE FIRST SOUND NEEDS A GESTURE. A browser lets a page make sound only after the person has done something on it. `unlock` is called from
// the click or the key that sends a prompt; until then there is no context, and a tune is silent but still moves on the painter's clock.

import type { TuneModel, TuneVoice } from '@conduit/language';
import type { TuneCue, TunePlayer } from '../contracts/tune';
import { makeWaves, playNote } from './synth';
import type { Rig } from './synth';

/** The master level: well under full scale, because a chord of piano notes and a bass add up. */
const MASTER = 0.55;
/** Notes are scheduled this far ahead of the audio clock, and the first note is held back this long, so that nothing begins late. */
const AHEAD = 1.6;
const LEAD_IN = 0.18;
const FADE_IN = 0.06;
const FADE_OUT = 0.25;
/** The silence between one tune and the next of the same answer, seconds. */
const BREATH = 0.9;
/** The most notes sounding at once: past it the quietest new notes are dropped, which no one hears. */
const MOST_NOTES = 40;

export interface NoteLog {
  readonly key: string;
  readonly voice: TuneVoice;
  readonly midi: number;
  /** seconds into the tune the score says it begins */
  readonly score: number;
  /** the audio clock's time the note was set to sound, and the tune's own beginning on it: `when - began` is `score` when all is in step */
  readonly when: number;
  readonly began: number;
  /** the audio clock's time when the note was handed over: always before `when` */
  readonly handed: number;
}

export interface Sound extends TunePlayer {
  /** Makes or wakes the audio context. Must be called from a click or a key. Safe to call again. */
  unlock(): void;
  readonly muted: boolean;
  mute(on: boolean): void;
  /** the tunes sounding now, by key */
  playing(): readonly string[];
  /** Hears a change in what is sounding or in the mute. Returns the way to stop hearing. */
  onChange(listener: () => void): () => void;
  /** the notes handed to the audio clock so far, for a test that cannot hear (the last 4,000) */
  log(): readonly NoteLog[];
  dispose(): void;
}

interface Running {
  readonly key: string;
  readonly voice: TuneVoice;
  readonly model: TuneModel;
  readonly bus: GainNode | null;
  /** audio-clock time of the tune's beginning; null when there is no audio clock (a silent stage keeps time on the painter's) */
  readonly t0: number | null;
  /** the painter's ambient seconds at the beginning, for the silent case */
  readonly aq0: number;
  /** index of the next note to schedule */
  next: number;
  /** painter seconds of the silent clock, when there is no audio */
  silentAt: number;
  ended: boolean;
}

export function createSound(): Sound {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let waves: Map<string, PeriodicWave> | null = null;
  let muted = false;
  let held = false;
  let sounding = 0;
  const running = new Map<string, Running>();
  /** keys that have begun once: a tune is begun once, and one that was stopped or has finished is not begun again while it stays on stage */
  const begun = new Set<string>();
  /** keys that were whole and have not begun: they wait for the tune before them */
  const queued = new Set<string>();
  let cues: readonly TuneCue[] = [];
  let lastAq = 0;
  /** when nothing was last sounding (performance clock, ms): the first tune of an answer begins at once, the next after a breath */
  let freeSince = -1e9;
  const listeners = new Set<() => void>();
  const notes: NoteLog[] = [];
  let pump: ReturnType<typeof setInterval> | null = null;

  const changed = (): void => {
    for (const listener of listeners) listener();
  };

  const make = (): void => {
    if (ctx !== null || typeof AudioContext === 'undefined') return;
    try {
      ctx = new AudioContext({ latencyHint: 'interactive' });
    } catch {
      ctx = null;
      return;
    }
    master = ctx.createGain();
    master.gain.value = muted ? 0 : MASTER;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -9;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;
    master.connect(limiter);
    limiter.connect(ctx.destination);
    waves = makeWaves(ctx);
  };

  const latency = (): number => {
    if (ctx === null) return 0;
    const reported = ctx.outputLatency;
    return Number.isFinite(reported) && reported > 0 ? reported : ctx.baseLatency;
  };

  /** `fade`: a stop or a tune that left the stage; `end`: it played out, and what still rings is let ring; `now`: the page is going. */
  const finish = (tune: Running, how: 'fade' | 'end' | 'now'): void => {
    if (tune.ended) return;
    tune.ended = true;
    const bus = tune.bus;
    if (bus !== null && ctx !== null) {
      if (how === 'fade') {
        bus.gain.cancelScheduledValues(ctx.currentTime);
        bus.gain.setTargetAtTime(0, ctx.currentTime, FADE_OUT / 4);
        setTimeout(() => bus.disconnect(), FADE_OUT * 1000 + 600);
      } else if (how === 'end') setTimeout(() => bus.disconnect(), 6000);
      else bus.disconnect();
    }
    running.delete(tune.key);
    sounding = running.size;
    changed();
  };

  /** Hands the notes that begin before `horizon` seconds into the tune to the audio clock. */
  const schedule = (tune: Running, horizon: number): void => {
    if (ctx === null || waves === null || tune.t0 === null) return;
    if (tune.bus === null) return;
    const rig: Rig = { ctx, out: tune.bus, waves };
    const secondsPerBeat = 60 / tune.model.tempo;
    const all = tune.model.notes;
    while (tune.next < all.length) {
      const note = all[tune.next] as (typeof all)[number];
      const at = note.start * secondsPerBeat;
      if (at > horizon) break;
      tune.next += 1;
      if (tune.t0 + at < ctx.currentTime - 0.05) continue;
      if (sounding > MOST_NOTES * 4) continue;
      // the stage keeps what the player has: a few thousand notes at most, for a test that cannot hear
      playNote({ ...rig, out: tune.bus ?? rig.out }, { voice: tune.voice, midi: note.midi, vel: note.vel, at: tune.t0 + at, hold: Math.max(0.05, note.dur * secondsPerBeat * 0.96) });
      notes.push({ key: tune.key, voice: tune.voice, midi: note.midi, score: at, when: tune.t0 + at, began: tune.t0, handed: ctx.currentTime });
      if (notes.length > 4000) notes.splice(0, notes.length - 4000);
    }
  };

  const position = (tune: Running): number => {
    if (ctx !== null && tune.t0 !== null) return ctx.currentTime - tune.t0 - latency();
    return lastAq - tune.aq0;
  };

  const tick = (): void => {
    for (const tune of [...running.values()]) {
      const at = position(tune);
      if (at > tune.model.seconds + 0.35) {
        finish(tune, 'end');
        continue;
      }
      if (!held) schedule(tune, Math.max(0, at) + AHEAD + latency());
    }
  };

  const start = (cue: TuneCue, aq: number): void => {
    begun.add(cue.key);
    queued.delete(cue.key);
    // a stage that cannot make sound yet (no gesture has come) still keeps time: its picture moves on the painter's clock
    const live = ctx !== null && master !== null && ctx.state === 'running';
    let bus: GainNode | null = null;
    if (live && ctx !== null && master !== null) {
      bus = ctx.createGain();
      bus.gain.setValueAtTime(0, ctx.currentTime);
      bus.gain.linearRampToValueAtTime(1, ctx.currentTime + FADE_IN);
      bus.connect(master);
    }
    const tune: Running = { key: cue.key, voice: cue.voice, model: cue.model, bus, t0: live && ctx !== null ? ctx.currentTime + LEAD_IN : null, aq0: aq, next: 0, silentAt: aq, ended: false };
    running.set(cue.key, tune);
    sounding = running.size;
    schedule(tune, AHEAD);
    changed();
  };

  return {
    unlock() {
      make();
      if (ctx !== null && ctx.state === 'suspended' && !held) void ctx.resume().then(changed, () => undefined);
      if (pump === null) pump = setInterval(tick, 200);
    },
    get muted() {
      return muted;
    },
    mute(on) {
      muted = on;
      if (ctx !== null && master !== null) {
        master.gain.cancelScheduledValues(ctx.currentTime);
        master.gain.setTargetAtTime(on ? 0 : MASTER, ctx.currentTime, 0.04);
      }
      changed();
    },
    playing: () => [...running.keys()],
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    log: () => notes,
    sync(next, now) {
      cues = next;
      lastAq = now.aq;
      // the music holds with the picture: asleep while the stage is paused or hidden
      const hold = !now.running;
      if (hold !== held) {
        held = hold;
        if (ctx !== null) void (hold ? ctx.suspend() : ctx.resume()).catch(() => undefined);
      }
      const names = new Set(next.map((cue) => cue.key));
      for (const tune of [...running.values()]) if (!names.has(tune.key)) finish(tune, 'fade');
      for (const key of [...begun]) if (!names.has(key)) begun.delete(key);
      // a tune that was whole is waiting its turn even after its answer has finished and it rests on the stage
      for (const cue of next) if (cue.ready && !begun.has(cue.key)) queued.add(cue.key);
      for (const key of [...queued]) if (!names.has(key)) queued.delete(key);
      // Movements of a sonata come one after another, never over each other: a tune that is ready waits for the one before it to play out,
      // then a breath, then begins. The order is the order they were written in.
      if (running.size === 0 && !held && performance.now() - freeSince >= BREATH * 1000) {
        const waiting = next.find((cue) => queued.has(cue.key) && !begun.has(cue.key) && cue.model.notes.length > 0);
        if (waiting !== undefined) start(waiting, now.aq);
      }
      if (running.size > 0) freeSince = performance.now();
      tick();
    },
    positionOf(key) {
      const tune = running.get(key);
      if (tune === undefined) return null;
      const at = position(tune);
      return at < 0 ? 0 : at;
    },
    stop() {
      for (const tune of [...running.values()]) finish(tune, 'fade');
      // what was stopped stays begun, so that it is not played again while its picture is on stage
      for (const cue of cues) begun.add(cue.key);
      queued.clear();
    },
    dispose() {
      for (const tune of [...running.values()]) finish(tune, 'now');
      if (pump !== null) clearInterval(pump);
      void ctx?.close().catch(() => undefined);
      listeners.clear();
    },
  };
}
