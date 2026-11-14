// Send: ink becomes one turn input. The picture of the ink is cropped and uploaded through the port the host gives (the app's photo upload, which
// keeps it as the server keeps any photo); what goes up is `InkMarks` with the picture's id. Nothing here knows how the turn is sent.

import type { InkMarks, InkVoice } from '@conduit/language';
import type { Ink } from './layer';

/** What the host gives to send ink: how a picture reaches the server, and how a turn goes up with marks. */
export interface InkPort {
  /** keeps the picture; resolves with its id (`u3`), rejects with a sentence a person can read */
  upload(png: Blob): Promise<string>;
  /** starts the turn: the words (the host adds its own default when empty) and the marks */
  turn(words: string, marks: InkMarks): Promise<unknown>;
}

export class NothingToSend extends Error {}

/** Builds the marks for what is on the layer: the picture uploaded, the strokes, the boxes and what it was drawn on. Throws `NothingToSend` when the layer is empty. */
export async function prepareMarks(ink: Ink, upload: InkPort['upload'], voice?: InkVoice): Promise<InkMarks> {
  const picture = await ink.picture();
  if (picture === null) throw new NothingToSend('There is nothing drawn to send.');
  const parts = ink.marks(picture.crop, voice);
  if (parts === null) throw new NothingToSend('There is nothing drawn to send.');
  const image = await upload(picture.blob);
  return { image, ...parts };
}

/**
 * "Send" / "Check my working": the picture, the strokes, the words and (when the browser's own dictation gave some) what was said, as one turn.
 * Words are the person's own; a voice note's audio is a slot (`voice.audio`) the voice package fills. On success the layer is cleared (the ink went up
 * with the turn; the strokes are kept by whoever keeps the document), unless `keep` is true.
 */
export async function sendInk(ink: Ink, port: InkPort, options: { readonly words?: string; readonly voice?: InkVoice; readonly keep?: boolean } = {}): Promise<InkMarks> {
  const dictated = options.voice?.text?.trim();
  const voice: InkVoice | undefined = options.voice === undefined ? undefined : { ...options.voice, ...(dictated === undefined || dictated === '' ? {} : { text: dictated }) };
  const marks = await prepareMarks(ink, port.upload, voice);
  await port.turn((options.words ?? '').trim(), marks);
  if (options.keep !== true) ink.reset();
  return marks;
}
