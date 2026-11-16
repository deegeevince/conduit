// Read aloud: the browser's own speech (`speechSynthesis`). It runs on the device: free, private, no server, nothing is sent anywhere. This file is the
// speaker and nothing else: a queue of lines said in order, the choice of voice and pace, and the rule that it is never on while it must not be
// (a recording, a hidden page, a new message). What is said and when is decided by `speak-reader.ts`; the switch the person works is `speak-ui.ts`.
//
// A voice is used only if it runs on the device (`localService`): some browsers list voices that send the text to a speech service, and this one
// never does. iOS needs the first utterance to start inside a tap, so `prime()` is called from the switch's own handler.

import { sentencesOf, spokenText } from './speak-text';

export type Pace = 'slow' | 'normal' | 'fast';

const KEY_ON = 'conduit.speak';
const KEY_VOICE = 'conduit.speak.voice';
const KEY_PACE = 'conduit.speak.pace';

/** The rate of each pace (1 is the voice's own). Slow suits a child who is reading along. */
export const PACE_RATE: Readonly<Record<Pace, number>> = { slow: 0.78, normal: 1, fast: 1.25 };
export const PACES: readonly Pace[] = ['slow', 'normal', 'fast'];

/** Novelty voices that ship with macOS and iOS: never a good voice for a lesson. */
const NOVELTY = /\b(albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|fred|junior|ralph|kathy)\b/i;

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // a browser that will not remember: the choice lasts until the page is closed
  }
}

const norm = (lang: string): string => lang.replace(/_/g, '-').toLowerCase();

/** How good a voice is for a language: the exact language beats the same language elsewhere, and a richer voice (Premium, Enhanced, Siri) beats a plain one. Null: not usable. */
export function voiceScore(voice: Pick<SpeechSynthesisVoice, 'lang' | 'name' | 'localService' | 'default'>, lang: string): number | null {
  if (!voice.localService || NOVELTY.test(voice.name)) return null;
  const want = norm(lang);
  const have = norm(voice.lang);
  const primary = want.split('-')[0] ?? want;
  let score = 0;
  if (have === want) score += 100;
  else if (have.split('-')[0] === primary) score += 60;
  else return null;
  if (/premium/i.test(voice.name)) score += 40;
  else if (/enhanced/i.test(voice.name)) score += 30;
  else if (/siri|natural/i.test(voice.name)) score += 25;
  if (voice.default) score += 3;
  return score;
}

/** The voices usable for a language, best first. */
export function rankVoices(voices: readonly SpeechSynthesisVoice[], lang: string): SpeechSynthesisVoice[] {
  return voices
    .map((voice) => ({ voice, score: voiceScore(voice, lang) }))
    .filter((item): item is { voice: SpeechSynthesisVoice; score: number } => item.score !== null)
    .sort((a, b) => b.score - a.score || a.voice.name.localeCompare(b.voice.name))
    .map((item) => item.voice);
}

export interface Speaker {
  /** this browser has speech at all */
  readonly supported: boolean;
  /** there is a voice that runs on the device for the page's language (voices load a moment after the page does) */
  readonly available: boolean;
  readonly on: boolean;
  /** something is being said now, or waits to be */
  readonly speaking: boolean;
  readonly pace: Pace;
  /** the voices to choose from, best first */
  voices(): readonly SpeechSynthesisVoice[];
  /** the voice in use: the person's choice if it is still there, else the best */
  voice(): SpeechSynthesisVoice | null;
  /** the person's choice (a voice's `voiceURI`), or null for the best one */
  setVoice(uri: string | null): void;
  setPace(pace: Pace): void;
  /** Switch on or off. Call it from the tap that switches it, so iOS lets the first line start. Off stops what is being said. */
  setOn(on: boolean): void;
  /** Add a line to what is being said, after the lines before it. Nothing is said when it is off, held or the page is hidden. */
  say(text: string): void;
  /** Say a sample in the chosen voice and pace, whether or not Read aloud is on (the person asked to hear it). */
  sample(text: string): void;
  /** Stop what is being said and say this instead: a tap on a block of words. */
  sayNow(text: string): void;
  /** Stop at once and forget what waited. */
  stop(): void;
  /** While held (a voice note is being recorded) nothing is said and what was being said stops. */
  hold(held: boolean): void;
  /** Tell when the speaker is stopped (a stop, a new message, a recording): what waited to be said after the answer is forgotten. */
  onStop(listener: () => void): () => void;
  /** Tell when the speaker changes: switched, started or finished speaking, voice or pace chosen, voices arrived. */
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

/** The one speaker of the page. */
let shared: Speaker | null = null;
export function pageSpeaker(): Speaker {
  shared ??= createSpeaker();
  return shared;
}

export function createSpeaker(): Speaker {
  const synth: SpeechSynthesis | null = typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined' ? window.speechSynthesis : null;
  const listeners = new Set<() => void>();
  const stoppers = new Set<() => void>();
  const tell = (): void => {
    for (const listener of [...listeners]) listener();
  };

  let on = read(KEY_ON) === 'on';
  let chosen = read(KEY_VOICE);
  const storedPace = read(KEY_PACE);
  let pace: Pace = PACES.find((item) => item === storedPace) ?? 'slow';
  let held = false;
  /** lines handed to the engine and not yet finished; a line from before a stop is ignored when its end arrives */
  let pending = 0;
  let generation = 0;
  let ranked: SpeechSynthesisVoice[] = [];
  let primed = false;

  /** the page's language, made exact by the device's own when they agree (the page says `en`, this device `en-AU`) */
  const lang = (): string => {
    const page = document.documentElement.lang || '';
    const own = navigator.language || '';
    if (page === '') return own || 'en';
    return own.toLowerCase().startsWith(page.toLowerCase().split('-')[0] ?? page) && own.length > page.length ? own : page;
  };

  const refresh = (): void => {
    if (synth === null) return;
    ranked = rankVoices(synth.getVoices(), lang());
    tell();
  };
  // voices load later on iOS and Chrome: `voiceschanged`; some browsers have them at once, some never fire it, so it is asked again a few times too
  synth?.addEventListener?.('voiceschanged', refresh);
  refresh();
  const retry = [400, 1200, 3000].map((ms) => window.setTimeout(refresh, ms));

  const voice = (): SpeechSynthesisVoice | null => {
    const mine = chosen === null ? undefined : ranked.find((item) => item.voiceURI === chosen);
    return mine ?? ranked[0] ?? null;
  };

  const stop = (): void => {
    generation += 1;
    for (const stopper of [...stoppers]) stopper();
    const was = pending > 0;
    pending = 0;
    if (synth === null) return;
    // cancel first, then it is quiet whatever state it was left in (a paused engine on iOS speaks the next line otherwise)
    synth.cancel();
    if (was) tell();
  };

  const speakOne = (sentence: string): void => {
    if (synth === null) return;
    const utterance = new SpeechSynthesisUtterance(sentence);
    const using = voice();
    if (using !== null) {
      utterance.voice = using;
      utterance.lang = using.lang;
    } else utterance.lang = lang();
    utterance.rate = PACE_RATE[pace];
    const mine = generation;
    pending += 1;
    const done = (): void => {
      if (mine !== generation) return;
      pending = Math.max(0, pending - 1);
      tell();
    };
    utterance.addEventListener('end', done);
    utterance.addEventListener('error', done);
    synth.speak(utterance);
  };

  const allowed = (anyway: boolean): boolean => synth !== null && (on || anyway) && !held && document.visibilityState !== 'hidden' && ranked.length > 0;

  const say = (text: string, anyway = false): void => {
    if (!allowed(anyway)) return;
    const words = spokenText(text);
    if (words === '') return;
    const before = pending;
    for (const sentence of sentencesOf(words)) speakOne(sentence);
    if (before === 0 && pending > 0) tell();
  };

  /** iOS (and Chrome) let the first utterance start only inside a tap or a key: an empty one, said in the first, is silent and unlocks the rest */
  const prime = (): void => {
    if (synth === null || primed || !on) return;
    primed = true;
    synth.speak(new SpeechSynthesisUtterance(''));
  };
  document.addEventListener('pointerdown', prime, true);
  document.addEventListener('keydown', prime, true);

  const onHidden = (): void => {
    if (document.visibilityState === 'hidden') stop();
  };
  document.addEventListener('visibilitychange', onHidden);
  window.addEventListener('pagehide', stop);

  return {
    supported: synth !== null,
    get available() {
      return ranked.length > 0;
    },
    get on() {
      return on;
    },
    get speaking() {
      return pending > 0;
    },
    get pace() {
      return pace;
    },
    voices: () => ranked,
    voice,
    setVoice(uri) {
      chosen = uri;
      write(KEY_VOICE, uri);
      tell();
    },
    setPace(next) {
      pace = next;
      write(KEY_PACE, next);
      tell();
    },
    setOn(next) {
      if (synth === null) return;
      refresh();
      if (next && ranked.length === 0) {
        on = false;
        tell();
        return;
      }
      on = next;
      write(KEY_ON, next ? 'on' : 'off');
      if (!next) stop();
      else prime();
      tell();
    },
    say: (text) => say(text),
    sample(text) {
      stop();
      say(text, true);
    },
    sayNow(text) {
      stop();
      say(text);
    },
    stop,
    hold(next) {
      if (held === next) return;
      held = next;
      if (held) stop();
    },
    onStop(listener) {
      stoppers.add(listener);
      return () => stoppers.delete(listener);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      document.removeEventListener('visibilitychange', onHidden);
      document.removeEventListener('pointerdown', prime, true);
      document.removeEventListener('keydown', prime, true);
      window.removeEventListener('pagehide', stop);
      synth?.removeEventListener?.('voiceschanged', refresh);
      for (const timer of retry) window.clearTimeout(timer);
      stop();
      listeners.clear();
    },
  };
}
