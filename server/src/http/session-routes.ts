// The browser's side of the API. Each handler translates HTTP to one call on
// the Conductor and back; no handler holds state or touches a brain.

import { API } from '@conduit/language';
import type { BrainChoice, CreateSessionResponse, CriticFinding, StageEvent, StartTurnResponse, ToolChoice } from '@conduit/language';
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { SERVER_LIMITS } from '../domain/session';
import { parseAsksClear, parseBackEvents, parseBrainChange, parseCreateSession, parseStartTurn, parseToolSwitch } from '../domain/validate';
import { listScripts } from '../brains/replay/scripts';
import type { HttpDeps } from './deps';
import { errors } from '../errors';
import { jsonBody, param } from './json';

/**
 * Where the standing asks are listed and cleared. Not in `API` (`wire.ts` is frozen): a request to the integrator asks for
 * `asks: (session) => `/api/sessions/${session}/asks`` there, and this line then reads it from `API`.
 */
const ASKS_PATH = (session: string): string => `/api/sessions/${session}/asks`;

/** A slow client may fall this many events behind before its stream is cut; it reconnects and is brought up to date. */
const MAX_UNWRITTEN = 1000;

export function registerSessionRoutes(app: Hono, deps: HttpDeps): void {
  const { conductor } = deps;

  /** Body: CreateSessionRequest. 201 CreateSessionResponse. This is the painter's `ready`. */
  app.post(API.sessions, async (c) => {
    const request = parseCreateSession(await jsonBody(c));
    return c.json<CreateSessionResponse>(conductor.createSession(request), 201);
  });

  /**
   * Server-Sent Events of StageEvent: the event name is the `type`, the data
   * is the JSON of the whole event. First event is `hello`. A comment line is
   * written every SERVER_LIMITS.heartbeatMs. Closing the connection detaches the sink.
   */
  app.get(API.stream(':session'), (c) => {
    const session = param(c, 'session');
    conductor.assertSession(session);
    c.header('X-Accel-Buffering', 'no');
    c.header('Cache-Control', 'no-cache');
    return streamSSE(c, async (stream) => {
      let unwritten = 0;
      let chain: Promise<void> = Promise.resolve();
      let close: () => void = () => undefined;
      const closed = new Promise<void>((resolve) => {
        close = resolve;
      });
      // The replay of a turn is already in memory and bounded by the turn's size; it is written in order, one
      // write at a time, and is not counted against the slow-client limit. Only what arrives live is.
      const enqueue = (write: () => Promise<void>, counted = true): void => {
        if (counted && unwritten >= MAX_UNWRITTEN) {
          close();
          return;
        }
        if (counted) unwritten += 1;
        chain = chain
          .then(write)
          .catch(() => close())
          .finally(() => {
            if (counted) unwritten -= 1;
          });
      };
      let replaying = true;
      const sink = (event: StageEvent): void => enqueue(() => stream.writeSSE({ event: event.type, data: JSON.stringify(event) }), !replaying);

      const detach = conductor.subscribe(session, sink, close);
      replaying = false;
      stream.onAbort(close);
      const beat = setInterval(() => enqueue(() => stream.write(': heartbeat\n\n').then(() => undefined)), SERVER_LIMITS.heartbeatMs);
      await closed;
      clearInterval(beat);
      detach();
    });
  });

  /** Body: StartTurnRequest. 202 StartTurnResponse. Applies `events` in order as `POST …/events` would, then interrupts whatever turn is open and opens this one. */
  app.post(API.turns(':session'), async (c) => {
    const request = parseStartTurn(await jsonBody(c));
    const session = param(c, 'session');
    // Validated whole before anything is applied, then applied ahead of the turn: one request, one order.
    conductor.assertSession(session);
    if (request.events !== undefined) conductor.receive(session, request.events);
    return c.json<StartTurnResponse>(conductor.startTurn(session, request.input, { look: c.req.header('x-conduit-review')?.trim().toLowerCase() !== 'off' }), 202);
  });

  /** 200 BrainChoice: what this session's brain is set to. */
  app.get(API.brain(':session'), (c) => c.json<BrainChoice>(conductor.brainChoice(param(c, 'session'))));

  /** Body: BrainChange. 200 BrainChoice. Sets the model and/or effort for this session only; 400 for a value outside the allowlist or a brain with nothing to set. */
  app.put(API.brain(':session'), async (c) => {
    const change = parseBrainChange(await jsonBody(c));
    return c.json<BrainChoice>(conductor.setBrain(param(c, 'session'), change));
  });

  /** 200 `ToolChoice[]`: what this session's brain may use in agent mode, and whether each is on. Empty for a brain with no tools. */
  app.get(API.tools(':session'), (c) => c.json<readonly ToolChoice[]>(conductor.toolsOf(param(c, 'session'))));

  /** Body: `{ name, on }`. 200 `ToolChoice[]`. Switches one tool or connected service for this session; 400 for a name the server does not offer. */
  app.put(API.tools(':session'), async (c) => {
    const change = parseToolSwitch(await jsonBody(c));
    return c.json<readonly ToolChoice[]>(conductor.setTool(param(c, 'session'), change.name, change.on));
  });

  /** 200 `CriticFinding`: what the critic made of a turn's resting picture; 404 until it has looked. */
  app.get(API.critic(':session', ':turn'), (c) => {
    const finding = conductor.criticOf(param(c, 'session'), param(c, 'turn'));
    if (finding === undefined) throw errors.notFound(`a finding for turn ${param(c, 'turn')}`);
    return c.json<CriticFinding>(finding);
  });

  /** 200 `{ asks }`: what the user asked to hold on every reply (`/asks`). */
  app.get(ASKS_PATH(':session'), (c) => c.json({ asks: conductor.asksOf(param(c, 'session')) }));

  /** Body: `{}` forgets them all, `{ drop: n }` forgets the nth (from 1). 200 `{ asks }` with what is left. */
  app.delete(ASKS_PATH(':session'), async (c) => {
    const drop = parseAsksClear(c.req.header('content-length') === '0' || c.req.header('content-length') === undefined ? {} : await jsonBody(c));
    return c.json({ asks: conductor.forgetAsks(param(c, 'session'), drop) });
  });

  /** Body: PostEventsRequest. 204. The back channel. */
  app.post(API.events(':session'), async (c) => {
    const events = parseBackEvents(await jsonBody(c));
    conductor.receive(param(c, 'session'), events);
    return c.body(null, 204);
  });

  /** 200 DemoInfo[]. */
  app.get(API.demos, (c) => c.json(listScripts()));
}
