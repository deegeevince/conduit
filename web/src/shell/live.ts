// This page's own conversation, made from what the stage says as it says it: the turn the painter opens becomes the person's message and Conduit's reply;
// the reply's words are the transcript's own lines (chrome/transcript.ts), re-read as they come; when the turn rests, a still of the stage is kept for its card.

import { serializeLine } from '@conduit/language';
import type { TurnInput, TurnTrace } from '@conduit/language';
import { startTrace } from './trace-live';
import type { LiveTrace } from './trace-live';
import type { StageApp } from '../app/stage-app';
import type { Transcript } from '../chrome/transcript';
import { NO_REPLY, drewFromTranscript } from './model';
import type { AnswerTurn, Message, Reply, ReplyMessage, ReplyState, UserMessage } from './model';

export interface LiveHooks {
  /** a message was added or changed */
  readonly put: (message: Message) => void;
  readonly remove: (id: string) => void;
  /** a turn of this conversation has opened: the list should know it has a title now */
  readonly onTurn: (turn: string) => void;
  /** the stage shows this turn's answer now (it is being made on it) */
  readonly onStage: (turn: string) => void;
  /** the brain a reply is made with, for the head of its timeline */
  readonly brain: () => TurnTrace['brain'];
  /** the log's own account of a turn of this conversation (null when it cannot be had yet); it takes the place of what the events built */
  readonly fetchTrace: (turn: string) => Promise<TurnTrace | null>;
}

export interface Live {
  messages(): readonly Message[];
  /** what the person said first, for the title; '' before anything */
  firstWords(): string;
  /** an older conversation this page has taken up: its messages come first, its turns can be replayed on the canvas. Only before this page has said anything. */
  seed(earlier: readonly Message[], turns: readonly AnswerTurn[]): void;
  /** the turns this page has had, with the lines each was told in, from the painter's own recordings */
  answerTurns(): AnswerTurn[];
  /** shows the message at once, before the stage has opened the turn */
  addPending(text: string, photos: readonly string[], voice: boolean, inked: boolean): void;
  /** the turn was not accepted: take the message away */
  dropPending(): void;
  /** the turn on the stage that this conversation made last */
  lastTurn(): string | null;
  dispose(): void;
}

const isPage = (turn: string): boolean => turn.startsWith('local-');

function saidOf(input: TurnInput): string {
  switch (input.kind) {
    case 'prompt':
    case 'tap':
    case 'act':
      return input.text;
    case 'demo':
      return `Played the demo ${input.script}`;
    case 'script':
      return 'Played a script';
    case 'refine':
      return 'Keep making it better';
  }
}

export function mountLive(app: StageApp, transcript: Transcript, hooks: LiveHooks): Live {
  const messages: Message[] = [];
  let earlier: readonly Message[] = [];
  let earlierTurns: readonly AnswerTurn[] = [];
  /** the first thing said on this page, after an older conversation was taken up, gets the divider */
  const startsHere = (except?: string): boolean => earlier.length > 0 && !messages.some((message) => message.role === 'user' && message.id !== except);
  const ended = new Map<string, { readonly reason: string; readonly message: string | null }>();
  let counter = 0;
  let pending: { readonly user: UserMessage; readonly reply: ReplyMessage } | null = null;
  let current: { readonly turn: string; readonly userId: string; readonly replyId: string } | null = null;
  let pageOpen = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const traces = new Map<string, LiveTrace>();
  const dirty = new Set<string>();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let clock: ReturnType<typeof setInterval> | undefined;

  const find = (id: string): Message | undefined => messages.find((message) => message.id === id);
  const replace = (message: Message): void => {
    const at = messages.findIndex((candidate) => candidate.id === message.id);
    if (at >= 0) messages[at] = message;
    else messages.push(message);
    hooks.put(message);
  };
  const reply = (id: string): ReplyMessage | null => {
    const found = find(id);
    return found?.role === 'reply' ? found : null;
  };

  const readReply = (turn: string): Reply => {
    const said = transcript.replyOf(turn);
    // the transcript tells weather as a line of its own: it is something drawn, not something said
    const weather = said.words.filter((line) => /^Weather: /.test(line));
    return { words: said.words.filter((line) => !weather.includes(line)), choices: said.choices.map((choice) => ({ text: choice.text, key: choice.key, open: choice.open })), drew: drewFromTranscript([...said.drawn, ...weather]) };
  };

  const builderOf = (turn: string): LiveTrace => {
    let held = traces.get(turn);
    if (held === undefined) {
      held = startTrace(Date.now(), hooks.brain());
      traces.set(turn, held);
    }
    return held;
  };
  const startFresh = (turn: string): LiveTrace => {
    const held = startTrace(Date.now(), hooks.brain());
    traces.set(turn, held);
    return held;
  };
  const replyOfTurn = (turn: string): ReplyMessage | null => messages.find((message): message is ReplyMessage => message.role === 'reply' && message.turn === turn) ?? null;
  /** the reply of each turn that moved gets its trace; a few times a second at most */
  const flush = (): void => {
    flushTimer = undefined;
    for (const turn of dirty) {
      const held = replyOfTurn(turn);
      const built = traces.get(turn);
      if (held === null || built === undefined) continue;
      replace({ ...held, trace: built.snapshot(), elapsedMs: held.state === 'working' && built.snapshot().end === null ? built.elapsed(Date.now()) : null });
    }
    dirty.clear();
  };
  const touch = (turn: string): void => {
    dirty.add(turn);
    flushTimer ??= setTimeout(flush, 150);
  };
  const keepClock = (): void => {
    const making = current !== null && reply(current.replyId)?.state === 'working' && traces.get(current.turn)?.snapshot().end === null;
    if (making && clock === undefined) {
      clock = setInterval(() => {
        if (current !== null) touch(current.turn);
        keepClock();
      }, 1000);
    } else if (!making && clock !== undefined) {
      clearInterval(clock);
      clock = undefined;
    }
  };
  /** once a turn has ended its log is the truth: take the trace from there (usage and the look's tally are written after the last line) */
  const settleTrace = (turn: string, wait: number): void => {
    setTimeout(() => {
      if (disposed) return;
      void hooks.fetchTrace(turn).then(
        (trace) => {
          const held = replyOfTurn(turn);
          if (disposed || trace === null || held === null) return;
          replace({ ...held, trace, elapsedMs: null });
        },
        () => undefined,
      );
    }, wait);
  };

  const refresh = (): void => {
    timer = undefined;
    if (disposed || current === null || pageOpen) return;
    const held = reply(current.replyId);
    if (held === null) return;
    const next = readReply(current.turn);
    if (JSON.stringify(next) === JSON.stringify(held.reply)) return;
    replace({ ...held, reply: next });
  };
  const soon = (): void => {
    timer ??= setTimeout(refresh, 60);
  };

  /** the reply that was being made is over, one way or another */
  const settle = (state: ReplyState, still: string | null): void => {
    if (current === null) return;
    const held = reply(current.replyId);
    if (held === null) return;
    const done = ended.get(current.turn);
    const note = state === 'failed' ? (done?.message ?? 'The reply did not finish.') : state === 'stopped' ? 'Stopped before it finished.' : null;
    replace({ ...held, reply: readReply(current.turn), state, note, still: still ?? held.still });
  };

  const stateOf = (turn: string): ReplyState => {
    const reason = ended.get(turn)?.reason;
    return reason === 'failed' || reason === 'timeout' ? 'failed' : reason === 'interrupted' ? 'stopped' : 'done';
  };

  const offTranscript = app.painter.on('transcript', (event) => {
    if (event.kind !== 'turn') {
      soon();
      return;
    }
    if (isPage(event.turn)) {
      pageOpen = true;
      return;
    }
    pageOpen = false;
    // whatever was being made is stopped by this turn
    if (current !== null && reply(current.replyId)?.state === 'working') settle(ended.has(current.turn) ? stateOf(current.turn) : 'stopped', null);
    const input = event.input;
    const photos = input.kind === 'prompt' ? (input.images ?? []).flatMap((id, index) => {
      const url = app.link.photoUrl(id);
      return url === null ? [] : [{ url, alt: `Photo ${index + 1} you gave` }];
    }) : [];
    const user: UserMessage = {
      role: 'user',
      id: pending?.user.id ?? `u-${event.turn}-${(counter += 1)}`,
      turn: event.turn,
      said: saidOf(input),
      photos,
      voice: input.kind === 'prompt' && (input.voice?.length ?? 0) > 0,
      inked: input.kind === 'prompt' && input.marks !== undefined,
      quiet: input.kind !== 'prompt',
      ...(startsHere(pending?.user.id) ? { continued: true } : {}),
    };
    const made: ReplyMessage = { role: 'reply', id: pending?.reply.id ?? `r-${event.turn}-${(counter += 1)}`, turn: event.turn, reply: NO_REPLY, state: 'working', note: null, still: null, trace: builderOf(event.turn).snapshot(), elapsedMs: 0 };
    // a prompt the page already showed is the one that opened: it is adopted, not shown twice
    if (pending !== null && input.kind === 'prompt') pending = null;
    else if (pending !== null) {
      hooks.remove(pending.user.id);
      hooks.remove(pending.reply.id);
      messages.splice(0, messages.length, ...messages.filter((message) => message.id !== pending?.user.id && message.id !== pending?.reply.id));
      pending = null;
    }
    replace(user);
    replace(made);
    current = { turn: event.turn, userId: user.id, replyId: made.id };
    hooks.onTurn(event.turn);
    hooks.onStage(event.turn);
    keepClock();
  });

  const offLink = app.link.onEvent((event) => {
    // a `doc` event (v3) can come between turns, with no turn of its own
    if ('turn' in event && event.turn !== null && !isPage(event.turn)) {
      // the opening of a turn starts its clock; every later event of it is one more step in how it was made
      const builder = event.type === 'turn' ? startFresh(event.turn) : builderOf(event.turn);
      if (builder.take(event, Date.now())) touch(event.turn);
      if (event.type === 'end') settleTrace(event.turn, 1500);
      if (event.type === 'critic') settleTrace(event.turn, 1200);
      if (event.type === 'end' || event.type === 'turn') setTimeout(keepClock, 0);
    }
    if (event.type !== 'end' || isPage(event.turn)) return;
    ended.set(event.turn, { reason: event.reason, message: event.message });
    if (current?.turn === event.turn && (event.reason === 'failed' || event.reason === 'timeout')) settle('failed', null);
  });

  let kept: string | null = null;
  const offStatus = app.onStatus((status) => {
    if (status.busy || current === null || pageOpen) return;
    const held = reply(current.replyId);
    if (held === null || held.state !== 'working' || !ended.has(current.turn) || kept === current.replyId) return;
    kept = current.replyId;
    const turn = current.turn;
    const replyId = current.replyId;
    // the stage has come to rest: keep a still of it for the card, once the last frame is drawn
    setTimeout(() => {
      if (disposed) return;
      void app.capture(520).then((still) => {
        if (disposed) return;
        const at = current?.replyId === replyId ? current : null;
        if (at === null) {
          const old = reply(replyId);
          if (old !== null) replace({ ...old, still: still ?? old.still });
          return;
        }
        settle(stateOf(turn), still);
      });
    }, 250);
  });

  return {
    messages: () => [...earlier, ...messages],
    seed(before, turns) {
      earlier = before;
      earlierTurns = turns;
    },
    firstWords: () => [...earlier, ...messages].find((message): message is UserMessage => message.role === 'user' && !message.quiet)?.said ?? '',
    answerTurns: () => [
      ...earlierTurns,
      ...app.painter.recordings().map((recording) => ({ turn: recording.turn, kind: recording.opened ?? 'none', lines: recording.lines.map((entry) => serializeLine(entry.line)) })),
    ],
    addPending(text, photos, voice, inked) {
      counter += 1;
      const user: UserMessage = {
        role: 'user',
        id: `u-pending-${counter}`,
        turn: null,
        said: text,
        photos: photos.flatMap((id, index) => {
          const url = app.link.photoUrl(id);
          return url === null ? [] : [{ url, alt: `Photo ${index + 1} you gave` }];
        }),
        voice,
        inked,
        quiet: false,
        ...(startsHere() ? { continued: true } : {}),
      };
      const made: ReplyMessage = { role: 'reply', id: `r-pending-${counter}`, turn: null, reply: NO_REPLY, state: 'working', note: null, still: null, trace: null, elapsedMs: null };
      pending = { user, reply: made };
      replace(user);
      replace(made);
    },
    dropPending() {
      if (pending === null) return;
      const gone = pending;
      pending = null;
      hooks.remove(gone.user.id);
      hooks.remove(gone.reply.id);
      messages.splice(0, messages.length, ...messages.filter((message) => message.id !== gone.user.id && message.id !== gone.reply.id));
    },
    lastTurn: () => current?.turn ?? null,
    dispose() {
      disposed = true;
      clearTimeout(timer);
      clearTimeout(flushTimer);
      clearInterval(clock);
      offTranscript();
      offLink();
      offStatus();
    },
  };
}
