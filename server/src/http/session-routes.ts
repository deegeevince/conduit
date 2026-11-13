// The browser's side of the API. Each handler translates HTTP to one call on
// the Conductor and back; no handler holds state or touches a brain.

import { API } from '@conduit/language';
import type { CreateSessionResponse, StageEvent, StartTurnResponse } from '@conduit/language';
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { SERVER_LIMITS } from '../domain/session';
import { parseBackEvents, parseCreateSession, parseStartTurn } from '../domain/validate';
import { listScripts } from '../brains/replay/scripts';
import type { HttpDeps } from './deps';
import { jsonBody, param } from './json';

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
    return c.json<StartTurnResponse>(conductor.startTurn(session, request.input), 202);
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
