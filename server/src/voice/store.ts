// Voice notes on disk, briefly: `<DATA_DIR>/voice/<run>-<session>/n1.wav`, owner-only, deleted as soon as the words are read (unless the owner
// set `VOICE_KEEP=on`). The words live in memory, for the turn that names the note; they are never written to the audit trail or the log.

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { VOICE_LIMITS } from '@conduit/language';
import type { VoiceStatus } from '@conduit/language';
import { AppError, errors } from '../errors';
import type { Logger } from '../log';
import type { StoredVoice, Transcriber, VoiceNotes } from '../domain/voice';

const SESSION_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const ID_NAME = /^n[1-9][0-9]{0,3}$/;
const FORMATS_SAID = 'WAV, M4A, CAF, MP3 or AIFF';

export interface VoiceStoreDeps {
  readonly dir: string;
  readonly transcriber: Transcriber;
  /** `VOICE_LOCALE`: the language to recognise; null: the Mac's own */
  readonly locale: string | null;
  /** `VOICE_KEEP=on`: keep the audio after it is read */
  readonly keep: boolean;
  readonly log: Logger;
  readonly now: () => number;
}

/** What a recording is, from its first bytes (never from its name or Content-Type); null when it is not audio the Mac's decoder reads. */
export function sniffAudio(bytes: Uint8Array): string | null {
  const at = (offset: number, text: string): boolean => bytes.length >= offset + text.length && [...text].every((char, i) => bytes[offset + i] === char.charCodeAt(0));
  if (at(0, 'RIFF') && at(8, 'WAVE')) return 'wav';
  if (at(4, 'ftyp')) return 'm4a';
  if (at(0, 'caff')) return 'caf';
  if (at(0, 'FORM') && (at(8, 'AIFF') || at(8, 'AIFC'))) return 'aiff';
  if (at(0, 'ID3') || (bytes.length > 2 && bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)) return 'mp3';
  return null;
}

/** A recording the browser made that the Mac cannot read, said as what to do about it. */
function notAudio(bytes: Uint8Array): AppError {
  const webm = bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  const ogg = bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53;
  const why = webm || ogg ? `that is ${webm ? 'WebM' : 'Ogg'} audio, which this Mac cannot read` : 'that is not audio this Mac can read';
  return new AppError('unsupported_audio', 415, `${why}; send ${FORMATS_SAID}`);
}

export function createVoiceNotes(deps: VoiceStoreDeps): VoiceNotes {
  const run = new Date(deps.now()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  interface Held {
    readonly folder: string;
    next: number;
    readonly words: Map<string, string>;
  }
  const sessions = new Map<string, Held>();
  const heldFor = (session: string): Held => {
    if (!SESSION_NAME.test(session)) throw errors.badRequest('that is not a session');
    let held = sessions.get(session);
    if (held === undefined) {
      held = { folder: join(deps.dir, `${run}-${session}`), next: 1, words: new Map() };
      sessions.set(session, held);
    }
    return held;
  };

  // One note is read at a time: the first may be compiling the helper, and the recogniser is not made for several at once.
  let queue: Promise<unknown> = Promise.resolve();
  const alone = <T>(job: () => Promise<T>): Promise<T> => {
    const next = queue.then(job, job);
    queue = next.catch(() => undefined);
    return next;
  };

  return {
    available: true,

    async status(): Promise<VoiceStatus> {
      try {
        const answer = await deps.transcriber.status(deps.locale);
        const locale = answer.locale ?? deps.locale;
        const permission = answer.permission ?? 'unknown';
        if (permission === 'not_determined') {
          return { available: false, state: 'permission_not_determined', locale, problem: 'Voice notes need Speech Recognition to be allowed once on the Mac running Conduit. Run `pnpm voice-check` there and click Allow.' };
        }
        if (permission === 'denied') return { available: false, state: 'permission_denied', locale, problem: 'Speech Recognition is off for "Conduit Voice" on the Mac running Conduit. Switch it on in System Settings > Privacy & Security > Speech Recognition.' };
        if (permission === 'restricted') return { available: false, state: 'permission_restricted', locale, problem: 'Speech Recognition is restricted on the Mac running Conduit, so voice notes cannot be read. Type the message instead.' };
        if (answer.available !== true) return { available: false, state: 'recogniser_unavailable', locale, problem: `The speech recogniser${locale === null || locale === undefined ? '' : ` for ${locale}`} is not available on the Mac running Conduit. Type the message instead.` };
        if (answer.onDevice !== true) {
          return { available: false, state: 'on_device_unsupported', locale, problem: `${locale ?? 'This language'} cannot be recognised on the Mac without sending the audio to Apple, and Conduit never does that. Add the language under System Settings > Keyboard > Dictation, or type the message.` };
        }
        return { available: true, state: 'ready', problem: null, locale };
      } catch (cause) {
        if (cause instanceof AppError) return { available: false, state: 'unsupported', problem: cause.message, locale: deps.locale };
        deps.log.warn('voice.status_failed', { error: cause });
        return { available: false, state: 'unsupported', problem: 'Voice notes could not be checked on this server.', locale: deps.locale };
      }
    },

    async put(session, bytes): Promise<StoredVoice> {
      const held = heldFor(session);
      if (bytes.byteLength === 0) throw errors.badRequest('the recording is empty');
      if (bytes.byteLength > VOICE_LIMITS.bytes) throw new AppError('payload_too_large', 413, `a voice note may be at most ${VOICE_LIMITS.bytes / 1_000_000} MB`);
      const format = sniffAudio(bytes);
      if (format === null) throw notAudio(bytes);
      if (held.words.size >= VOICE_LIMITS.perSession) throw errors.conflict(`this conversation already holds ${VOICE_LIMITS.perSession} voice notes`);

      return alone(async () => {
        const id = `n${held.next}`;
        held.next += 1;
        await mkdir(held.folder, { recursive: true, mode: 0o700 });
        const path = join(held.folder, `${id}.${format}`);
        await writeFile(path, bytes, { mode: 0o600 });
        try {
          const reading = await deps.transcriber.read(path, { locale: deps.locale, maxSeconds: VOICE_LIMITS.seconds });
          if (!reading.ok) throw failure(reading.code, reading.message);
          held.words.set(id, reading.text);
          return { id, text: reading.text, seconds: reading.seconds, recogniser: reading.recogniser, locale: reading.locale, kept: deps.keep, bytes: bytes.byteLength, format, file: deps.keep ? `voice/${run}-${session}/${id}.${format}` : null };
        } finally {
          if (!deps.keep) await rm(path, { force: true }).catch((cause: unknown) => deps.log.warn('voice.delete_failed', { error: cause }));
        }
      });
    },

    transcript(session, id) {
      if (!ID_NAME.test(id) || !SESSION_NAME.test(session)) return null;
      return sessions.get(session)?.words.get(id) ?? null;
    },

    has: (session, id) => ID_NAME.test(id) && sessions.get(session)?.words.has(id) === true,
  };
}

/** The helper's own codes, as the HTTP errors a page can act on. */
function failure(code: string, message: string): AppError {
  switch (code) {
    case 'permission_not_determined':
    case 'permission_denied':
    case 'permission_restricted':
      return new AppError('voice_permission', 503, message);
    case 'on_device_unsupported':
      return new AppError('voice_language', 422, message);
    case 'no_speech':
      return new AppError('voice_no_speech', 422, message);
    case 'too_long':
      return new AppError('payload_too_large', 413, message);
    case 'unreadable_audio':
      return new AppError('unsupported_audio', 415, message);
    default:
      return new AppError('voice_unavailable', 503, message);
  }
}
