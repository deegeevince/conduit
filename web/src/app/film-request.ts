// A video request, made into the film it asks for: which turns, with or without a title card each, the language pane and the input box round the stage as the request leaves
// them, the caption and the tag over it, a slider the session moved dragged or not. Pure, so the app and the film's checks make the same film from the same request.

import type { VideoRequest } from '../contracts/export';
import type { Film, FilmOptions, Recording } from '../contracts/film';
import { createReel, lastAnswer } from '../painter/reel';
import type { Reel } from '../painter/reel';
import { langLayout, withPane } from './lang-film';
import type { LangLayout } from './lang-film';
import type { LangLog } from './lang-log';

export interface VideoSource {
  /** the last turn */
  readonly recording: Recording;
  /** every turn the session has had, oldest first (may be empty: the last turn stands alone) */
  readonly recordings: readonly Recording[];
  readonly log: LangLog;
  /** what a film is made with, but for its viewport: the stage is laid out for the picture the request asks for, less what is drawn round it */
  readonly options: Omit<FilmOptions, 'viewport'>;
  /** the longest the film may be, seconds */
  readonly maxSeconds: number;
}

export interface VideoFilm {
  /** the film to hand the exporter */
  readonly film: Film;
  /** the turns laid end to end, before the pane and the labels were laid round them */
  readonly reel: Reel;
  /** how the picture is divided */
  readonly layout: LangLayout;
  /** a sentence for the person when turns were left out of the front or the last was cut short for the length limit; null otherwise */
  readonly note: string | null;
}

export function videoFilm(request: VideoRequest, source: VideoSource): VideoFilm {
  const layout = langLayout(request.width, request.height, request.surround);
  const options: FilmOptions = { ...source.options, viewport: { width: layout.stage.width, height: layout.stage.height, dpr: 1 } };
  const everything = source.recordings;
  const conversation = request.scope === 'conversation';
  // A film is of the last answer (a prompt and the taps that carried it on) unless `scope` says the last turn alone, or the whole conversation.
  const turns = request.scope === 'turn' ? [source.recording] : conversation ? everything : lastAnswer(everything);
  const reel = createReel(turns.length > 0 ? turns : [source.recording], options, { cards: conversation && request.cards !== false, maxSeconds: source.maxSeconds, session: true, drag: request.drag === true });
  const note = reel.leftOut > 0 || reel.cut ? `The film holds at most ${source.maxSeconds / 60} minutes: ${reel.leftOut > 0 ? `the first ${reel.leftOut} turn${reel.leftOut === 1 ? '' : 's'} ${reel.leftOut === 1 ? 'is' : 'are'} left out` : 'the last turn is cut short'}` : null;
  const film = withPane(reel, everything.length > 0 ? everything : [source.recording], source.log, layout, { ...(request.captions === undefined ? {} : { captions: request.captions }), ...(request.tag === undefined ? {} : { tag: request.tag }) });
  return { film, reel, layout, note };
}
