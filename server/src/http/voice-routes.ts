// The owner's voice notes: in as audio, out as words. Read on this Mac by Apple's on-device recogniser; nothing leaves the machine.

import { API } from '@conduit/language';
import type { VoiceResponse } from '@conduit/language';
import type { Hono } from 'hono';
import { AppError, errors } from '../errors';
import type { HttpDeps } from './deps';
import { param } from './json';

/**
 * - `GET  API.voiceStatus`: `VoiceStatus`, without asking the system for anything. `state` is `ready` or the reason (permission not given, a
 *   language the device cannot recognise, no Swift); `problem` is the sentence to show.
 * - `POST API.voice(session)`: the body is the recording itself, whatever its Content-Type says; what it is is read from its bytes (WAV, M4A,
 *   CAF, MP3 or AIFF) and at most `VOICE_LIMITS.bytes` and `.seconds`. It is read on this Mac, on the device, and the audio is deleted (unless
 *   `VOICE_KEEP=on`). 201 `VoiceResponse`. 413 too large or long, 415 not audio it knows, 422 `voice_language` (never falls back to a server
 *   recogniser) or `voice_no_speech`, 503 `voice_permission` or `voice_unavailable`.
 *   Both the upload and the reading are in the audit trail (kind `voice`) by id, size, language and recogniser, never the words.
 */
export function registerVoiceRoutes(app: Hono, deps: HttpDeps): void {
  const { conductor, voice, audit } = deps;

  app.get(API.voiceStatus, async (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json(await voice.status());
  });

  app.post(API.voice(':session'), async (c) => {
    const session = param(c, 'session');
    conductor.assertSession(session);
    if (!voice.available) throw errors.forbidden('voice notes are switched off on this server');
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    try {
      const stored = await voice.put(session, bytes);
      audit.record({ kind: 'voice', session, tool: 'voice-upload', target: `${stored.id} ${stored.format}, ${stored.bytes} bytes`, decision: 'allowed', decidedBy: 'policy', note: stored.kept ? `kept as ${stored.file}` : 'deleted once read' });
      audit.record({ kind: 'voice', session, tool: 'voice-transcribe', target: `${stored.id} ${stored.seconds}s ${stored.locale}`, decision: 'done', decidedBy: 'policy', note: `read on this Mac by the ${stored.recogniser} recogniser; the words are not recorded here` });
      const answer: VoiceResponse = { id: stored.id, text: stored.text, seconds: stored.seconds, recogniser: stored.recogniser, locale: stored.locale, kept: stored.kept };
      c.header('Cache-Control', 'no-store');
      return c.json(answer, 201);
    } catch (cause) {
      if (cause instanceof AppError) audit.record({ kind: 'voice', session, tool: 'voice-upload', target: `${bytes.byteLength} bytes`, decision: 'denied', decidedBy: 'policy', note: `${cause.code}: ${cause.message}` });
      throw cause;
    }
  });
}
