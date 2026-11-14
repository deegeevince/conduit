// The owner's voice notes: recorded in the page, read on this Mac, on the device, and never sent to anyone.
//
// The domain owns this port; `voice/store.ts` is the disk and the recogniser behind it. Ids are `n1`, `n2`, ... within a session, and a note is
// its session's: no other session can name it. The audio is kept only for the moment it is read (or, when the owner says `VOICE_KEEP=on`,
// in the data folder, owner-only); the words are held in memory for the turn that names the note, and never in the audit trail.

import type { VoiceResponse, VoiceStatus } from '@conduit/language';

/** What a note is, and where its audio is, if it was kept (relative to the data folder, for the audit trail; never the bytes or the words). */
export interface StoredVoice extends VoiceResponse {
  readonly bytes: number;
  /** what the recording was: `wav`, `m4a`, `caf`, `mp3` or `aiff`, read from its bytes */
  readonly format: string;
  readonly file: string | null;
}

export interface VoiceNotes {
  /** False when voice notes are switched off (`VOICE=off`). */
  readonly available: boolean;
  /** Whether a note can be read here, and if not why not, without asking the system for anything. */
  status(): Promise<VoiceStatus>;
  /**
   * Checks the bytes by their content (WAV, M4A, CAF, MP3 or AIFF, nothing else), keeps them owner-only for as long as it takes to read them,
   * reads them on this Mac with the on-device recogniser, deletes them (unless kept) and names the note. Throws an `AppError` that says why when it
   * will not: too large or long, not audio it knows, permission missing, the language not recognisable on the device, nothing heard.
   */
  put(session: string, bytes: Uint8Array): Promise<StoredVoice>;
  /** The words as read; null when this session has no such note. */
  transcript(session: string, id: string): string | null;
  has(session: string, id: string): boolean;
}

export const NO_VOICE: VoiceNotes = {
  available: false,
  status: () => Promise.resolve({ available: false, state: 'off', problem: 'Voice notes are switched off on this server.', locale: null }),
  put: () => Promise.reject(new Error('voice notes are off')),
  transcript: () => null,
  has: () => false,
};

/** What the recogniser says. `code` is the helper's: see `ops/transcribe/transcribe.swift`. */
export type Reading =
  | { readonly ok: true; readonly text: string; readonly seconds: number; readonly recogniser: 'on-device'; readonly locale: string }
  | { readonly ok: false; readonly code: string; readonly message: string };

export interface HelperStatus {
  readonly ok: boolean;
  readonly permission?: string;
  readonly locale?: string;
  readonly onDevice?: boolean;
  readonly available?: boolean;
  readonly code?: string;
  readonly message?: string;
}

/** The recogniser behind the port: Apple's Speech framework through the helper in `ops/transcribe`. A fake stands in for it in tests of the plumbing. */
export interface Transcriber {
  status(locale: string | null): Promise<HelperStatus>;
  read(file: string, options: { readonly locale: string | null; readonly maxSeconds: number }): Promise<Reading>;
}
