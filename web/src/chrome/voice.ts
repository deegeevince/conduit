import { VOICE_LIMITS } from '@conduit/language';
import type { VoiceResponse, VoiceStatus } from '@conduit/language';
import type { ComposerMenu } from './menu';

/** What the prompt bar needs from the app to take a voice note: ask whether the Mac can read one, and send the recording to be read. */
export interface VoicePort {
  /** whether voice notes can be read on the owner's Mac right now, and if not why not (a sentence a person can act on) */
  status(): Promise<VoiceStatus>;
  /** sends the recording; resolves with the words and the id the server gave the note, rejects with a sentence a person can read */
  upload(recording: Blob): Promise<VoiceResponse>;
}

export interface Voice {
  /** the ids of the notes whose words are in the field, for the turn that carries them */
  ids(): string[];
  /** forgets the notes: they went with the turn (or the words were cleared) */
  clear(): void;
  /** stops a recording in progress and throws it away */
  cancel(): void;
  dispose(): void;
}

export interface VoiceHandlers {
  /** the words came back: put them in the field (appended to what is there). `send` is true when the owner asked for voice notes to go at once. */
  readonly onWords: (text: string, send: boolean) => void;
  /** a recording has begun or ended (read aloud is held while one runs: nothing is ever spoken over a voice note) */
  readonly onRecording?: (recording: boolean) => void;
}

const MIC = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3"/></svg>';

const AUTOSEND_KEY = 'conduit.voice.autosend';
/** A press shorter than this is a tap (record until the next tap); longer is hold-to-talk (record until it is let go). */
const HOLD_MS = 450;
/** The speech recogniser works at 16 kHz; sending that, mono, keeps a two-minute note under 4 MB and in a format every Mac reads. */
const SAMPLE_RATE = 16_000;

function remembered(): boolean {
  try {
    return localStorage.getItem(AUTOSEND_KEY) === 'on';
  } catch {
    return false;
  }
}

function remember(on: boolean): void {
  try {
    localStorage.setItem(AUTOSEND_KEY, on ? 'on' : 'off');
  } catch {
    // a browser that will not remember is not a problem
  }
}

/** The recording as a 16-bit mono WAV at 16 kHz, whatever the browser recorded it as (WebM/Opus in Chrome, MP4/AAC in Safari: a Mac cannot read the first). Null when this browser cannot decode what it recorded. */
async function asWav(recording: Blob): Promise<Blob | null> {
  try {
    const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const context = new Context();
    let decoded: AudioBuffer;
    try {
      decoded = await context.decodeAudioData(await recording.arrayBuffer());
    } finally {
      void context.close();
    }
    const length = Math.max(1, Math.ceil(decoded.duration * SAMPLE_RATE));
    const offline = new OfflineAudioContext(1, length, SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const samples = (await offline.startRendering()).getChannelData(0);
    const out = new DataView(new ArrayBuffer(44 + samples.length * 2));
    const text = (at: number, value: string): void => [...value].forEach((char, i) => out.setUint8(at + i, char.charCodeAt(0)));
    text(0, 'RIFF');
    out.setUint32(4, 36 + samples.length * 2, true);
    text(8, 'WAVEfmt ');
    out.setUint32(16, 16, true);
    out.setUint16(20, 1, true);
    out.setUint16(22, 1, true);
    out.setUint32(24, SAMPLE_RATE, true);
    out.setUint32(28, SAMPLE_RATE * 2, true);
    out.setUint16(32, 2, true);
    out.setUint16(34, 16, true);
    text(36, 'data');
    out.setUint32(40, samples.length * 2, true);
    samples.forEach((sample, i) => out.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, sample)) * 32767), true));
    return new Blob([out], { type: 'audio/wav' });
  } catch {
    return null;
  }
}

const clock = (ms: number): string => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

/** A microphone that has been heard to be silent for this long at the start of a note is taken to be dead. */
const DEAD_MIC_MS = 3000;
/** Loudness (RMS of the samples, 0 to 1) below which nothing is being heard: about -62 dB, under any real room's noise. */
const SILENT_RMS = 0.0008;
/** The microphone stays open this long after the last note, so the next one does not ask again, then it is let go. */
const MIC_KEEP_MS = 120_000;
/** How long a line in the field (an error) stays before the field comes back by itself. */
const SAY_MS = 9000;
const DEAD_MIC = "The mic isn't hearing anything. Check it isn't in use by dictation or another app, then try again.";
const X = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const TICK = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const UP = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>';

/**
 * The microphone in the composer, with nothing extra on screen. While recording, the pill itself becomes the recorder: Cancel (x), a live waveform
 * and the time, Stop (a tick: read it and put the words in the box to edit) and Send (an arrow: read it and send at once). Reading shows "Reading..."
 * in the same place, and an error is one short line there. A tap records until Stop, a hold records while held (letting go is Stop, or Send when
 * the owner chose "send voice notes as soon as they are read"). The microphone is asked for once and kept for a couple of minutes, so the browser
 * does not ask again for each note; a microphone that has gone quiet or been taken away is dropped and asked for again. A note is sent once.
 */
export function mountVoice(button: HTMLButtonElement, pill: HTMLElement, field: HTMLElement, port: VoicePort, handlers: VoiceHandlers, options: { readonly menu?: ComposerMenu } = {}): Voice {
  button.innerHTML = MIC;
  const supported = typeof navigator.mediaDevices?.getUserMedia === 'function' && typeof MediaRecorder !== 'undefined';
  button.hidden = !supported;

  const bar = document.createElement('div');
  bar.className = 'voicebar';
  bar.hidden = true;
  bar.innerHTML = `
    <button type="button" class="voicebar__btn voicebar__cancel" aria-label="Cancel the recording" title="Cancel">${X}</button>
    <canvas class="voicebar__wave" aria-hidden="true"></canvas>
    <span class="voicebar__time" aria-hidden="true"></span>
    <p class="voicebar__text" role="status"></p>
    <button type="button" class="voicebar__btn voicebar__stop" aria-label="Stop: put the words in the box to check" title="Stop: put the words in the box">${TICK}</button>
    <button type="button" class="voicebar__btn voicebar__send" aria-label="Stop and send" title="Stop and send">${UP}</button>`;
  field.before(bar);
  const part = <T extends HTMLElement>(selector: string): T => {
    const found = bar.querySelector<T>(selector);
    if (found === null) throw new Error('The voice bar could not be built.');
    return found;
  };
  const wave = part<HTMLCanvasElement>('.voicebar__wave');
  const time = part('.voicebar__time');
  const text = part('.voicebar__text');
  const cancel = part<HTMLButtonElement>('.voicebar__cancel');
  const stop = part<HTMLButtonElement>('.voicebar__stop');
  const sendNow = part<HTMLButtonElement>('.voicebar__send');

  let autosend = remembered();
  const autoEntry = options.menu?.add({
    id: 'voice-auto',
    label: 'Send voice notes when read',
    gist: 'instead of putting the words in the box first',
    order: 60,
    check: true,
    checked: autosend,
    hidden: !supported,
    run: () => {
      autosend = !autosend;
      remember(autosend);
      autoEntry?.set({ checked: autosend });
    },
  });

  type Mode = 'idle' | 'checking' | 'recording' | 'reading';
  let state: Mode = 'idle';
  let recorder: MediaRecorder | null = null;
  /** the microphone, kept between notes while it is alive */
  let mic: MediaStream | null = null;
  let micTimer = 0;
  let audio: AudioContext | null = null;
  let frame = 0;
  let timer = 0;
  let cap = 0;
  let sayTimer = 0;
  let began = 0;
  let pieces: Blob[] = [];
  let discard = false;
  let thenSend = false;
  let dead = false;
  let peak = -1;
  let levels: number[] = [];
  let pressedAt = 0;
  let holding = false;
  let secondTap = false;
  /** recordings already on their way: a recording is never sent twice */
  const sent = new WeakSet<Blob>();

  const view = (mode: 'field' | 'recording' | 'reading' | 'say'): void => {
    handlers.onRecording?.(mode === 'recording');
    bar.hidden = mode === 'field';
    pill.classList.toggle('voice--busy', mode === 'recording' || mode === 'reading');
    pill.classList.toggle('voice--say', mode === 'say');
    pill.classList.toggle('voice--recording', mode === 'recording');
    cancel.hidden = stop.hidden = sendNow.hidden = mode !== 'recording';
    wave.hidden = time.hidden = mode !== 'recording';
    text.hidden = mode === 'recording';
    bar.classList.toggle('voicebar--problem', mode === 'say');
    button.classList.toggle('prompt__voice--recording', mode === 'recording');
    button.setAttribute('aria-pressed', mode === 'recording' ? 'true' : 'false');
    button.setAttribute('aria-label', mode === 'recording' ? 'Stop recording' : 'Record a voice note');
  };
  const clearSay = (): void => {
    window.clearTimeout(sayTimer);
    if (state === 'idle' && pill.classList.contains('voice--say')) view('field');
  };
  /** one short line in the field's place, which goes by itself (or on a tap) */
  const say = (line: string): void => {
    state = 'idle';
    text.textContent = line;
    view('say');
    window.clearTimeout(sayTimer);
    sayTimer = window.setTimeout(clearSay, SAY_MS);
  };
  bar.addEventListener('click', (event) => {
    if (state !== 'idle' || (event.target as HTMLElement).closest('button') !== null) return;
    clearSay();
    field.focus({ preventScroll: true });
  });

  // the microphone, kept
  const dropMic = (): void => {
    window.clearTimeout(micTimer);
    mic?.getTracks().forEach((track) => track.stop());
    mic = null;
  };
  const alive = (): boolean => {
    const track = mic?.getAudioTracks()[0];
    return track !== undefined && track.readyState === 'live' && !track.muted && track.enabled;
  };
  const keepMic = (): void => {
    window.clearTimeout(micTimer);
    micTimer = window.setTimeout(dropMic, MIC_KEEP_MS);
  };
  const onHidden = (): void => {
    if (document.visibilityState === 'hidden' && state === 'idle') dropMic();
  };
  document.addEventListener('visibilitychange', onHidden);
  async function microphone(): Promise<MediaStream> {
    window.clearTimeout(micTimer);
    if (mic !== null && alive()) return mic;
    dropMic();
    const got = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const track = got.getAudioTracks()[0];
    // taken away by the system (a call, dictation, Siri, the app in the background): forget it so the next note asks again
    const lost = (): void => {
      if (mic === got) dropMic();
    };
    track?.addEventListener('ended', lost);
    track?.addEventListener('mute', () => {
      if (state !== 'recording') lost();
    });
    mic = got;
    return got;
  }

  const release = (): void => {
    window.cancelAnimationFrame(frame);
    window.clearInterval(timer);
    window.clearTimeout(cap);
    void audio?.close().catch(() => undefined);
    audio = null;
    recorder = null;
    if (mic !== null) keepMic();
  };

  const draw = (): void => {
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(wave.clientWidth * ratio));
    const height = Math.max(1, Math.round(wave.clientHeight * ratio));
    if (wave.width !== width) wave.width = width;
    if (wave.height !== height) wave.height = height;
    const context = wave.getContext('2d');
    if (context === null) return;
    context.clearRect(0, 0, width, height);
    context.fillStyle = getComputedStyle(wave).color;
    const step = 4 * ratio;
    const count = Math.floor(width / step);
    const shown = levels.slice(-count);
    shown.forEach((value, i) => {
      const h = Math.max(2 * ratio, Math.min(1, value) * height);
      context.fillRect(width - (shown.length - i) * step, (height - h) / 2, 2 * ratio, h);
    });
  };

  async function read(recording: Blob): Promise<void> {
    if (sent.has(recording)) return;
    sent.add(recording);
    state = 'reading';
    text.textContent = 'Reading…';
    view('reading');
    const send = thenSend || false;
    try {
      const wav = (await asWav(recording)) ?? recording;
      const kept = await port.upload(wav);
      state = 'idle';
      view('field');
      notes.push(kept.id);
      handlers.onWords(kept.text, send);
    } catch (cause) {
      say(cause instanceof Error ? cause.message : 'The note could not be read.');
    }
  }
  const notes: string[] = [];

  const finish = (send: boolean): void => {
    if (state !== 'recording' || recorder === null) return;
    thenSend = send;
    if (recorder.state !== 'inactive') recorder.stop();
  };
  const abandon = (): void => {
    if (state !== 'recording') return;
    discard = true;
    finish(false);
  };

  async function begin(): Promise<void> {
    if (state !== 'idle') return;
    state = 'checking';
    window.clearTimeout(sayTimer);
    // Ask first, so a note is never recorded that the Mac cannot read (and the person is told why, in words, before they speak).
    let status: VoiceStatus;
    try {
      status = await port.status();
    } catch {
      say('The server could not be reached, so a voice note cannot be read.');
      return;
    }
    if (!status.available) {
      say(status.problem ?? 'Voice notes cannot be read on this server.');
      return;
    }
    let stream: MediaStream;
    try {
      stream = await microphone();
    } catch (cause) {
      const denied = cause instanceof DOMException && (cause.name === 'NotAllowedError' || cause.name === 'SecurityError');
      say(denied ? "This browser isn't allowed to use the microphone. Allow it for this site in the browser's settings." : 'No microphone could be used here.');
      return;
    }
    pieces = [];
    discard = false;
    thenSend = false;
    dead = false;
    peak = -1;
    levels = [];
    const made = new MediaRecorder(stream);
    recorder = made;
    made.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) pieces.push(event.data);
    });
    made.addEventListener('stop', () => {
      const recording = new Blob(pieces, { type: made.mimeType !== '' ? made.mimeType : 'audio/webm' });
      const thrown = discard;
      const heard = peak;
      const wasDead = dead;
      release();
      if (wasDead) {
        dropMic();
        say(DEAD_MIC);
        return;
      }
      if (thrown || recording.size === 0) {
        state = 'idle';
        view('field');
        return;
      }
      // heard to be silent from the first moment to the last: nothing to read, nothing to send
      if (heard >= 0 && heard < SILENT_RMS) {
        dropMic();
        say(DEAD_MIC);
        return;
      }
      void read(recording);
    });
    // the level: the loudness of the last few milliseconds, drawn as a waveform that scrolls
    try {
      const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      audio = new Context();
      const analyser = audio.createAnalyser();
      analyser.fftSize = 1024;
      // a context made after an await may start suspended (autoplay rules): the tap that began the note allows it to run
      void audio.resume().catch(() => undefined);
      audio.createMediaStreamSource(stream).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      peak = 0;
      let drawn = 0;
      const tick = (): void => {
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const value of samples) sum += value * value;
        const rms = Math.sqrt(sum / samples.length);
        peak = Math.max(peak, rms);
        const now = Date.now();
        if (state === 'recording' && peak <= SILENT_RMS && now - began >= DEAD_MIC_MS) {
          // three seconds at the start and not a sound: stop, send nothing
          dead = true;
          discard = true;
          finish(false);
          return;
        }
        if (now - drawn > 50) {
          drawn = now;
          levels.push(Math.min(1, rms * 5));
          if (levels.length > 400) levels.splice(0, 200);
          draw();
        }
        frame = window.requestAnimationFrame(tick);
      };
      state = 'recording';
      began = Date.now();
      made.start();
      view('recording');
      tick();
    } catch {
      // no meter, still a recording
      peak = -1;
      state = 'recording';
      began = Date.now();
      made.start();
      view('recording');
    }
    time.textContent = `0:00`;
    timer = window.setInterval(() => {
      time.textContent = clock(Date.now() - began);
    }, 250);
    // two minutes, and it stops by itself and reads what there is
    cap = window.setTimeout(() => finish(autosend), VOICE_LIMITS.seconds * 1000);
  }

  // Tap: record until Stop or Send. Hold: record while held.
  const onDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    pressedAt = Date.now();
    secondTap = state === 'recording';
    holding = state === 'idle';
    if (state === 'idle') void begin();
  };
  const onUp = (): void => {
    if (!holding) return;
    holding = false;
    if (Date.now() - pressedAt >= HOLD_MS && state === 'recording') finish(autosend);
  };
  button.addEventListener('pointerdown', onDown);
  document.addEventListener('pointerup', onUp);
  document.addEventListener('pointercancel', onUp);
  // Keyboard Enter and Space arrive only as clicks; a click after a pointer press does nothing but stop a recording a second tap ended.
  button.addEventListener('click', (event) => {
    if (event.detail === 0) {
      if (state === 'recording') finish(false);
      else void begin();
      return;
    }
    if (secondTap) {
      secondTap = false;
      finish(false);
    }
  });
  button.addEventListener('contextmenu', (event) => event.preventDefault());
  stop.addEventListener('click', () => finish(false));
  sendNow.addEventListener('click', () => finish(true));
  cancel.addEventListener('click', abandon);
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && state === 'recording') {
      event.preventDefault();
      abandon();
    }
  };
  document.addEventListener('keydown', onKey);
  field.addEventListener('input', () => {
    clearSay();
    // the words were cleared: the notes they came from no longer go with the turn
    if ((field as HTMLTextAreaElement).value.trim() === '' && state === 'idle') notes.length = 0;
  });

  view('field');
  return {
    ids: () => [...notes],
    clear() {
      notes.length = 0;
    },
    cancel: abandon,
    dispose() {
      discard = true;
      if (recorder !== null && recorder.state !== 'inactive') recorder.stop();
      release();
      dropMic();
      window.clearTimeout(sayTimer);
      autoEntry?.remove();
      document.removeEventListener('visibilitychange', onHidden);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      document.removeEventListener('keydown', onKey);
      pill.classList.remove('voice--busy', 'voice--say', 'voice--recording');
      bar.remove();
    },
  };
}
