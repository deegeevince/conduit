import { VOICE_LIMITS } from '@conduit/language';
import type { VoiceResponse, VoiceStatus } from '@conduit/language';

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

/**
 * The microphone button and the strip above the field: while recording, a level meter, the time against the two-minute cap, Cancel and Done;
 * then "Reading on this Mac"; then the words go into the field to be checked before they are sent (or are sent at once when the owner chose that).
 * A tap records until the next tap, a hold records while held. The button is hidden where there is no microphone to use, and the strip says
 * plainly when the Mac cannot read a note (permission not given, a language it cannot recognise on the device) instead of recording into nothing.
 */
export function mountVoice(button: HTMLButtonElement, host: HTMLElement, field: HTMLElement, port: VoicePort, handlers: VoiceHandlers): Voice {
  button.innerHTML = MIC;
  const supported = typeof navigator.mediaDevices?.getUserMedia === 'function' && typeof MediaRecorder !== 'undefined';
  button.hidden = !supported;

  const strip = document.createElement('div');
  strip.className = 'voice';
  strip.hidden = true;
  strip.innerHTML = `
    <div class="voice__row">
      <span class="voice__meter" aria-hidden="true"><span class="voice__level"></span></span>
      <span class="voice__time" aria-hidden="true"></span>
      <p class="voice__note" role="status"></p>
      <button type="button" class="voice__action voice__retry" hidden>Try again</button>
      <button type="button" class="voice__action voice__done" hidden>Done</button>
      <button type="button" class="voice__action voice__cancel" hidden>Cancel</button>
    </div>
    <label class="voice__auto"><input type="checkbox" /> Send voice notes as soon as they are read</label>`;
  host.append(strip);
  const part = <T extends HTMLElement>(selector: string): T => {
    const found = strip.querySelector<T>(selector);
    if (found === null) throw new Error('The voice strip could not be built.');
    return found;
  };
  const level = part('.voice__level');
  const time = part('.voice__time');
  const note = part('.voice__note');
  const retry = part<HTMLButtonElement>('.voice__retry');
  const done = part<HTMLButtonElement>('.voice__done');
  const cancel = part<HTMLButtonElement>('.voice__cancel');
  const auto = part<HTMLInputElement>('.voice__auto input');
  const meter = part('.voice__meter');
  auto.checked = remembered();
  auto.addEventListener('change', () => remember(auto.checked));

  const notes: string[] = [];
  let state: 'idle' | 'checking' | 'recording' | 'reading' = 'idle';
  let recorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let audio: AudioContext | null = null;
  let frame = 0;
  let timer = 0;
  let cap = 0;
  let began = 0;
  let pieces: Blob[] = [];
  let discard = false;
  /** the last recording that could not be read, kept in memory so "Try again" does not ask the person to speak twice */
  let unread: Blob | null = null;
  let pressedAt = 0;
  let holding = false;
  let secondTap = false;

  const show = (text: string, options: { readonly recording?: boolean; readonly retry?: boolean; readonly problem?: boolean } = {}): void => {
    strip.hidden = text === '' && options.recording !== true;
    note.textContent = text;
    note.classList.toggle('voice__note--problem', options.problem === true);
    meter.hidden = options.recording !== true;
    time.hidden = options.recording !== true;
    done.hidden = options.recording !== true;
    cancel.hidden = options.recording !== true;
    retry.hidden = options.retry !== true;
    button.classList.toggle('prompt__voice--recording', options.recording === true);
    button.setAttribute('aria-pressed', options.recording === true ? 'true' : 'false');
    button.setAttribute('aria-label', options.recording === true ? 'Stop recording' : 'Record a voice note');
  };

  const release = (): void => {
    window.cancelAnimationFrame(frame);
    window.clearInterval(timer);
    window.clearTimeout(cap);
    stream?.getTracks().forEach((track) => track.stop());
    void audio?.close().catch(() => undefined);
    stream = null;
    audio = null;
    recorder = null;
    level.style.setProperty('--level', '0');
  };

  async function read(recording: Blob): Promise<void> {
    state = 'reading';
    unread = null;
    show('Reading your note on this Mac. It goes nowhere else.');
    try {
      const wav = (await asWav(recording)) ?? recording;
      const kept = await port.upload(wav);
      state = 'idle';
      notes.push(kept.id);
      show(`Read on this Mac, on the device. Check the words, then send.`);
      handlers.onWords(kept.text, auto.checked);
      if (auto.checked) show('');
    } catch (cause) {
      state = 'idle';
      unread = recording;
      show(`${cause instanceof Error ? cause.message : 'The note could not be read.'} You can type the message instead.`, { problem: true, retry: true });
    }
  }

  const finish = (): void => {
    if (state !== 'recording' || recorder === null) return;
    if (recorder.state !== 'inactive') recorder.stop();
  };

  const abandon = (): void => {
    if (state !== 'recording') return;
    discard = true;
    finish();
  };

  async function begin(): Promise<void> {
    if (state !== 'idle') return;
    state = 'checking';
    // Ask first, so a note is never recorded that the Mac cannot read (and the person is told why, in words, before they speak).
    let status: VoiceStatus;
    try {
      status = await port.status();
    } catch {
      state = 'idle';
      show('The server could not be reached, so a voice note cannot be read. You can type the message instead.', { problem: true });
      return;
    }
    if (!status.available) {
      state = 'idle';
      show(`${status.problem ?? 'Voice notes cannot be read on this server.'} You can type the message instead.`, { problem: true });
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (cause) {
      state = 'idle';
      const denied = cause instanceof DOMException && (cause.name === 'NotAllowedError' || cause.name === 'SecurityError');
      show(denied ? 'This browser was not allowed to use the microphone. Allow it for this site in the browser\'s settings, or type the message.' : 'No microphone could be used here. You can type the message instead.', { problem: true });
      return;
    }
    pieces = [];
    discard = false;
    const made = new MediaRecorder(stream);
    recorder = made;
    made.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) pieces.push(event.data);
    });
    made.addEventListener('stop', () => {
      const recording = new Blob(pieces, { type: made.mimeType !== '' ? made.mimeType : 'audio/webm' });
      const thrown = discard;
      release();
      if (thrown || recording.size === 0) {
        state = 'idle';
        show('');
        return;
      }
      void read(recording);
    });
    // the level: the loudness of the last few milliseconds, drawn as a bar
    try {
      const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      audio = new Context();
      const analyser = audio.createAnalyser();
      analyser.fftSize = 512;
      // a context made after an await may start suspended (autoplay rules): the tap that began the note allows it to run
      void audio.resume().catch(() => undefined);
      audio.createMediaStreamSource(stream).connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      const tick = (): void => {
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const value of samples) sum += ((value - 128) / 128) ** 2;
        level.style.setProperty('--level', String(Math.min(1, Math.sqrt(sum / samples.length) * 3.5).toFixed(3)));
        frame = window.requestAnimationFrame(tick);
      };
      tick();
    } catch {
      // no meter, still a recording
    }
    state = 'recording';
    began = Date.now();
    made.start();
    show('Listening. Tap the microphone again or press Done when you have finished.', { recording: true });
    time.textContent = `0:00 / ${clock(VOICE_LIMITS.seconds * 1000)}`;
    timer = window.setInterval(() => {
      time.textContent = `${clock(Date.now() - began)} / ${clock(VOICE_LIMITS.seconds * 1000)}`;
    }, 250);
    // two minutes, and it stops by itself and reads what there is
    cap = window.setTimeout(finish, VOICE_LIMITS.seconds * 1000);
  }

  // Tap: record until the next tap. Hold: record while held.
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
    if (Date.now() - pressedAt >= HOLD_MS && state === 'recording') finish();
  };
  button.addEventListener('pointerdown', onDown);
  document.addEventListener('pointerup', onUp);
  document.addEventListener('pointercancel', onUp);
  // A press while recording is a second tap and stops it on its click; the click after a first tap or a hold does nothing (the pointer events did the work). Keyboard Enter and Space arrive only as clicks.
  button.addEventListener('click', (event) => {
    const fromKeyboard = event.detail === 0;
    if (fromKeyboard) {
      if (state === 'recording') finish();
      else void begin();
      return;
    }
    if (secondTap) {
      secondTap = false;
      finish();
    }
  });
  button.addEventListener('contextmenu', (event) => event.preventDefault());
  done.addEventListener('click', finish);
  cancel.addEventListener('click', abandon);
  retry.addEventListener('click', () => {
    if (unread !== null) void read(unread);
  });
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && state === 'recording') {
      event.preventDefault();
      abandon();
    }
  };
  document.addEventListener('keydown', onKey);
  // typing over the words clears the reminder that they are a transcript to check
  field.addEventListener('input', () => {
    if (state === 'idle' && unread === null && note.textContent?.startsWith('Read on this Mac') === true) show('');
  });

  show('');
  return {
    ids: () => [...notes],
    clear() {
      notes.length = 0;
      if (state === 'idle') show('');
    },
    cancel: abandon,
    dispose() {
      discard = true;
      if (recorder !== null && recorder.state !== 'inactive') recorder.stop();
      release();
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      document.removeEventListener('keydown', onKey);
      strip.remove();
    },
  };
}
