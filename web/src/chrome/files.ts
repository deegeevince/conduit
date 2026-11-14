// What leaves the page as a file or on the clipboard: the Save menu and the slash commands both go through here, so
// each does one thing one way.

import { parseScript, parseTune, tuneToMidi } from '@conduit/language';
import type { ExportJob, ExportRequest } from '../contracts/export';
import type { StageApp } from '../app/stage-app';

export const SIZES = [
  { id: 'landscape', label: '1920 by 1080, landscape', width: 1920, height: 1080 },
  { id: 'portrait', label: '1080 by 1920, portrait', width: 1080, height: 1920 },
  { id: 'square', label: '1080 by 1080, square', width: 1080, height: 1080 },
] as const;

export function stamp(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** The size an export is made at when nobody chose one: the screen's own shape. */
export function defaultSize(app: StageApp): { width: number; height: number } {
  const viewport = app.painter.snapshot().viewport;
  return viewport.height > viewport.width ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };
}

function stillSize(app: StageApp): { width: number; height: number } {
  const viewport = app.painter.snapshot().viewport;
  const scale = 1920 / Math.max(viewport.width, viewport.height);
  return { width: Math.round(viewport.width * scale), height: Math.round(viewport.height * scale) };
}

/** Starts an export and saves the file when it is done; says what happened in the status line. Never throws. */
export function runExport(app: StageApp, request: ExportRequest): ExportJob | null {
  try {
    const job = app.export(request);
    job.done.then(
      ({ blob, fileName, hasSound, note }) => {
        saveBlob(blob, fileName);
        app.announce(`Saved ${fileName}${hasSound === true ? ', with its music' : ''}${note === undefined ? '' : `. ${note}`}`);
      },
      () => undefined,
    );
    return job;
  } catch (cause) {
    app.announce(cause instanceof Error ? cause.message : String(cause));
    return null;
  }
}

export function saveStill(app: StageApp, format: 'png' | 'svg'): void {
  // Infinity: the film clamps it to the moment everything has come to rest.
  runExport(app, { kind: 'still', format, ...stillSize(app), at: Number.POSITIVE_INFINITY });
}

export function saveScript(app: StageApp): void {
  saveBlob(new Blob([`${app.script()}\n`], { type: 'text/plain' }), `conduit-${stamp()}.series`);
  app.announce('Saved the script');
}

export async function copyText(app: StageApp, text: string, said: string, failed: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    app.announce(said);
  } catch {
    app.announce(failed);
  }
}

export function copyScript(app: StageApp): Promise<void> {
  return copyText(app, app.script(), 'Script copied', 'The script could not be copied. Use Save script instead.');
}

/** A standard MIDI file of the last tune the answer wrote: its notes and tempo, a track a voice, the instrument it was played on. */
export function saveMidi(app: StageApp): void {
  const { lines } = parseScript(app.script());
  const opener = [...lines].reverse().find((line) => line.verb === 'tune');
  if (opener === undefined || opener.verb !== 'tune') {
    app.announce('There is no tune to save yet');
    return;
  }
  const rows = lines.filter((line) => line.verb === 'row' && line.id === opener.id).map((line) => (line.verb === 'row' ? line.cells : ''));
  const model = parseTune(rows, { tempo: opener.tempo ?? null, title: opener.title ?? null });
  if (model.notes.length === 0) {
    app.announce('The tune has no notes to save');
    return;
  }
  const bytes = tuneToMidi(model, opener.voice ?? 'piano');
  saveBlob(new Blob([bytes.buffer as ArrayBuffer], { type: 'audio/midi' }), `conduit-${stamp()}.mid`);
  app.announce('Saved the tune as a MIDI file');
}
