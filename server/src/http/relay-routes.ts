// The outside agent's side of the API, shaped for curl. An agent that claims
// a turn here IS the brain for that turn; the browser cannot tell.
//
//   curl -s -X POST 'localhost:4300/api/relay/next?wait=25'
//   curl -s -X POST localhost:4300/api/relay/turns/t1/lines -H 'content-type: text/plain' --data-binary $'scene layout=solo\nsay a1 | Hello.'
//   curl -s 'localhost:4300/api/relay/turns/t1/events?since=0&wait=5'
//   curl -s -X POST localhost:4300/api/relay/turns/t1/end

import { API, buildRelayAppendix, buildTurnBrief, LEAD_WINDOW } from '@conduit/language';
import type { RelayAppendResponse, RelayClaim, RelayEventsResponse, RelayRejected } from '@conduit/language';
import type { Hono } from 'hono';
import type { BrainEvent } from '../domain/brain';
import { SERVER_LIMITS } from '../domain/session';
import { errors } from '../errors';
import type { HttpDeps } from './deps';
import { param, textBody, waitMs } from './json';

export function registerRelayRoutes(app: Hono, deps: HttpDeps): void {
  const { conductor, relayHub, log } = deps;

  const eventsResponse = async (turn: string, since: number | null, wait: number, signal: AbortSignal): Promise<RelayEventsResponse> => {
    const page = await conductor.turnEvents(turn, since, wait, signal);
    return { events: page.events, cursor: page.cursor, clock: conductor.clockOf(turn), open: conductor.isOpen(turn) };
  };

  /** Claiming changes state, so it is a POST; a GET (a cross-site image tag can send one) is told so and claims nothing. */
  app.get(API.relayNext, () => {
    throw errors.methodNotAllowed(`claiming a turn changes state: use POST ${API.relayNext}?wait=25`);
  });

  /**
   * Long-poll for the next unclaimed turn. Query: wait=<seconds, default 25,
   * max SERVER_LIMITS.longPollMs>. 200 RelayClaim, or 204 when nothing arrived.
   */
  app.post(API.relayNext, async (c) => {
    const signal = c.req.raw.signal;
    const request = await relayHub.claim(waitMs(c.req.query('wait'), 25, SERVER_LIMITS.longPollMs), signal);
    if (request === null) return c.body(null, 204);
    if (signal.aborted) {
      // The agent hung up as its turn was handed over: give it to the next one.
      relayHub.release(request.turn);
      return c.body(null, 204);
    }
    const brief = buildTurnBrief(request.context, request.input);
    conductor.noteBrief(request.turn, brief);
    const claim: RelayClaim = {
      turn: request.turn,
      session: request.session,
      input: request.input,
      context: request.context,
      brief,
      links: {
        lines: API.relayLines(request.turn),
        end: API.relayEnd(request.turn),
        events: API.relayEvents(request.turn),
        guide: `${API.relayGuide}?session=${request.session}`,
        snapshot: conductor.snapshotLinkFor(request.turn),
      },
    };
    return c.json(claim);
  });

  /** The brain system prompt followed by the relay appendix, as text/plain. Query: session=<id> tailors it to that session's screen. */
  app.get(API.relayGuide, (c) => {
    const session = c.req.query('session');
    const prompt = conductor.guideFor(session === undefined || session === '' ? null : session);
    return c.text(`${prompt}\n\n${buildRelayAppendix(LEAD_WINDOW)}`);
  });

  /** 200 RelayStatus: what is waiting and what is claimed. */
  app.get(API.relayStatus, (c) => c.json(relayHub.status()));

  /**
   * Append lines to a claimed turn. Body: plain text, one Series line per
   * line, Content-Type text/plain (curl needs -H 'content-type: text/plain');
   * blank lines and # comments are skipped. Query: end=1 also ends the
   * turn. 200 RelayAppendResponse. Good lines are accepted even when others
   * in the same body are rejected. 409 `turn_closed` once the user has
   * interrupted or the turn has ended.
   */
  app.post(API.relayLines(':turn'), async (c) => {
    const turn = param(c, 'turn');
    conductor.sessionOfTurn(turn);
    if (!conductor.isOpen(turn)) throw errors.turnClosed(turn, 'the user interrupted it or it has ended');

    const reader = conductor.lineReaderFor(turn);
    const events: BrainEvent[] = [];
    const rejected: RelayRejected[] = [];
    const warnings: RelayRejected[] = [];
    (await textBody(c)).split('\n').forEach((raw, index) => {
      const parsed = reader.read(raw);
      const lineNumber = index + 1;
      if (parsed.kind === 'line') {
        events.push({ type: 'line', line: parsed.line, issues: parsed.issues });
        if (parsed.issues.length > 0) warnings.push({ lineNumber, raw, issues: parsed.issues });
      } else if (parsed.kind === 'reject') {
        events.push({ type: 'reject', raw, issues: parsed.issues });
        rejected.push({ lineNumber, raw, issues: parsed.issues });
      }
    });

    relayHub.append(turn, events);
    const wantsEnd = c.req.query('end') === '1';
    if (wantsEnd) relayHub.end(turn);
    // Until the turn has taken the lines in, its pen does not include them.
    await relayHub.drained(turn);
    if (wantsEnd) await new Promise<void>((resolve) => setImmediate(resolve));

    const page = await conductor.turnEvents(turn, null, 0, c.req.raw.signal);
    const body: RelayAppendResponse = {
      accepted: events.filter((event) => event.type === 'line').length,
      rejected,
      warnings,
      clock: conductor.clockOf(turn),
      events: page.events,
      cursor: page.cursor,
      ended: wantsEnd || !conductor.isOpen(turn),
    };
    log.debug('relay.appended', { turn, accepted: body.accepted, rejected: rejected.length });
    return c.json(body);
  });

  /** End the turn. 200 RelayEventsResponse. Idempotent. */
  app.post(API.relayEnd(':turn'), async (c) => {
    const turn = param(c, 'turn');
    conductor.sessionOfTurn(turn);
    relayHub.end(turn);
    await relayHub.drained(turn);
    await new Promise<void>((resolve) => setImmediate(resolve));
    return c.json(await eventsResponse(turn, null, 0, c.req.raw.signal));
  });

  /**
   * The back channel, for listening at a break. Query: since=<cursor, default
   * the cursor this turn last saw>, wait=<seconds to wait for something new,
   * default 0>. 200 RelayEventsResponse. Still answers after the turn closes,
   * so an agent can read the final report.
   */
  app.get(API.relayEvents(':turn'), async (c) => {
    const turn = param(c, 'turn');
    conductor.sessionOfTurn(turn);
    const rawSince = c.req.query('since');
    let since: number | null = null;
    if (rawSince !== undefined && rawSince !== '') {
      since = Number(rawSince);
      if (!Number.isInteger(since) || since < 0) throw errors.badRequest('since must be a whole number, 0 or more');
    }
    return c.json(await eventsResponse(turn, since, waitMs(c.req.query('wait'), 0, SERVER_LIMITS.longPollMs), c.req.raw.signal));
  });
}
