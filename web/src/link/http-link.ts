import { API, checkStageEvent, STAGE_EVENT_TYPES, STREAM_HEARTBEAT } from '@conduit/language';
import type { AppStatus, BackEvent, BrainChange, BrainChoice, CreateSessionRequest, DemoInfo, StageEvent, StageEventType, StartTurnRequest, ToolChoice, TurnInput } from '@conduit/language';
import type { LinkStatus, StageLink } from '../contracts/link';
import type { PainterUpload } from '../contracts/painter';
import { asAsks, asBrainChoice, asDemos, asSessionResponse, asStatus, asTools, asTurnId, messageOf } from './guards';

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000] as const;
const MAX_RETRIES = 3;
const MAX_BATCH = 50;

/**
 * The link over same-origin HTTP: Server-Sent Events down, small POSTs up.
 * Reconnects the stream by itself with backoff; a session does not survive a
 * server restart, so a 404 on reconnect is reported as `closed`.
 */
export interface HttpLink extends StageLink {
  /** called with the number of back-channel events that were given up on after retries */
  onDropped(listener: (count: number) => void): () => void;
  /** a sentence for the HUD when something best-effort, like an upload, was given up on */
  onNote(listener: (note: string) => void): () => void;
  /**
   * Whether the viewer wants look and fix. Off, every request carries `x-conduit-review: off` so the server does not wait for
   * a draft report or look at one. (Request to the server's package: honour it per turn.)
   */
  setReview(on: boolean): void;
  /** v2.1. This session's tools and connected services (`/tools`). Rejects with the server's sentence. */
  tools(): Promise<readonly ToolChoice[]>;
  /** v2.1. Switches one tool or service for this session; answers the whole list. */
  setTool(name: string, on: boolean): Promise<readonly ToolChoice[]>;
  /** v2.1. The steward's account of where the product stands (`/status`). */
  appStatus(): Promise<AppStatus>;
  /** v2.1. What the user asked to hold for every reply (`/asks`); `clear` forgets them. Needs the server's `asks` route (see the hand-back). */
  asks(clear: boolean): Promise<readonly string[]>;
  /** v2.1. Saves a film of a turn made in the page beside the session's log, for the steward to watch (`/capture`). */
  saveCapture(turn: string, film: Blob): Promise<void>;
}

async function bodyOf(response: Response): Promise<unknown> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(messageOf(body, `the server refused it (${response.status})`));
  return body;
}

async function brainAnswer(response: Response): Promise<BrainChoice> {
  const choice = asBrainChoice(await bodyOf(response));
  if (choice === null) throw new Error('the server answered with something that is not a brain setting');
  return choice;
}

export function createHttpLink(): HttpLink {
  let status: LinkStatus = 'connecting';
  let reviewHeader: Record<string, string> = {};
  let session: string | null = null;
  let source: EventSource | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let disposed = false;
  let queue: BackEvent[] = [];
  /** while a turn request is being assembled, queued events wait for it instead of posting on their own */
  let startingTurns = 0;
  let flushing: Promise<void> | null = null;
  const eventListeners = new Set<(event: StageEvent) => void>();
  const statusListeners = new Set<(status: LinkStatus) => void>();

  function setStatus(next: LinkStatus): void {
    if (status === next || (status === 'closed' && next !== 'closed')) return;
    status = next;
    for (const listener of [...statusListeners]) listener(next);
  }

  /** what has gone wrong with the stream, said once per kind to the HUD and every time to the console: a faulty event is never silent */
  const toldKinds = new Set<string>();
  function trouble(kind: string, detail: string): void {
    console.error(`[conduit link] ${kind}: ${detail}`);
    if (toldKinds.has(kind)) return;
    toldKinds.add(kind);
    note(`${kind}: ${detail}`);
  }

  function emit(event: StageEvent): void {
    for (const listener of [...eventListeners]) {
      try {
        listener(event);
      } catch (error) {
        // a faulty listener must not stop the stream, and must not hide itself
        trouble(`a listener failed on a ${event.type} event`, error instanceof Error ? error.message : String(error));
      }
    }
  }

  function parseEvent(type: StageEventType, data: string): StageEvent | null {
    let body: unknown;
    try {
      body = JSON.parse(data);
    } catch {
      trouble(`a ${type} event was not JSON`, data.slice(0, 80));
      return null;
    }
    const checked = checkStageEvent(type, body);
    if ('why' in checked) {
      trouble('the server sent a malformed event, ignored', checked.why);
      return null;
    }
    return checked.event;
  }

  /** when the stream last said anything at all, a heartbeat included; a stream that says nothing for `silentMs` is taken for half-open */
  let lastHeard = Date.now();
  let watchdog: ReturnType<typeof setInterval> | undefined;
  function watch(id: string): void {
    clearInterval(watchdog);
    lastHeard = Date.now();
    watchdog = setInterval(() => {
      if (disposed || status !== 'open') return;
      const quiet = Date.now() - lastHeard;
      if (quiet < STREAM_HEARTBEAT.silentMs) return;
      trouble('the event stream went quiet, reconnecting', `${Math.round(quiet / 1000)} s with no word, not even a heartbeat`);
      scheduleReconnect(id);
    }, Math.max(1000, Math.floor(STREAM_HEARTBEAT.everyMs / 3)));
  }

  function closeSource(): void {
    if (source !== null) {
      source.close();
      source = null;
    }
  }

  async function sessionExists(id: string): Promise<'yes' | 'no' | 'unknown'> {
    try {
      const response = await fetch(API.events(id), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"events":[]}' });
      if (response.status === 404) return 'no';
      return response.status < 500 ? 'yes' : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  function scheduleReconnect(id: string): void {
    if (disposed || status === 'closed') return;
    closeSource();
    setStatus('reconnecting');
    const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 8000;
    attempt += 1;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      void (async () => {
        if (disposed) return;
        const exists = await sessionExists(id);
        if (disposed) return;
        if (exists === 'no') {
          setStatus('closed');
          return;
        }
        if (exists === 'unknown') {
          scheduleReconnect(id);
          return;
        }
        openStream(id);
      })();
    }, delay);
  }

  function openStream(id: string): void {
    closeSource();
    const stream = new EventSource(API.stream(id));
    source = stream;
    stream.onopen = () => {
      attempt = 0;
      watch(id);
      setStatus('open');
    };
    stream.addEventListener(STREAM_HEARTBEAT.eventName, () => {
      lastHeard = Date.now();
    });
    for (const type of STAGE_EVENT_TYPES) {
      stream.addEventListener(type, (message) => {
        lastHeard = Date.now();
        if (!(message instanceof MessageEvent) || typeof message.data !== 'string') return;
        const event = parseEvent(type, message.data);
        if (event !== null) emit(event);
      });
    }
    stream.onerror = () => {
      if (source !== stream) return;
      // EventSource retries on its own but cannot tell a restart from a blip; take over so a 404 is noticed.
      scheduleReconnect(id);
    };
  }

  async function postBatch(id: string, batch: readonly BackEvent[]): Promise<boolean> {
    for (let tries = 0; tries <= MAX_RETRIES; tries += 1) {
      try {
        const response = await fetch(API.events(id), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ events: batch }),
          keepalive: JSON.stringify(batch).length < 60000,
        });
        if (response.ok) return true;
        if (response.status === 404) {
          setStatus('closed');
          return false;
        }
        if (response.status >= 400 && response.status < 500) return false;
      } catch {
        // network failure: retry
      }
      await new Promise((resolve) => setTimeout(resolve, 150 * (tries + 1)));
    }
    return false;
  }

  async function drain(): Promise<void> {
    while (queue.length > 0 && canSend() && startingTurns === 0 && session !== null) {
      const batch = queue.slice(0, MAX_BATCH);
      queue = queue.slice(batch.length);
      const delivered = await postBatch(session, batch);
      if (!delivered) {
        for (const listener of [...droppedListeners]) listener(batch.length);
      }
    }
  }

  const droppedListeners = new Set<(count: number) => void>();
  const noteListeners = new Set<(note: string) => void>();

  function note(text: string): void {
    for (const listener of [...noteListeners]) listener(text);
  }

  async function putPicture(url: string, blob: Blob, fallbackType: string): Promise<string | null> {
    for (let tries = 0; tries < 2; tries += 1) {
      try {
        const response = await fetch(url, { method: 'POST', headers: { 'content-type': blob.type !== '' ? blob.type : fallbackType }, body: blob });
        if (response.ok) return null;
        if (response.status >= 400 && response.status < 500) return `the server refused it (${response.status})`;
      } catch {
        // network failure: one more try
      }
      if (disposed || tries === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    return 'it could not be sent';
  }

  function canSend(): boolean {
    return session !== null && status !== 'closed' && !disposed;
  }

  /** Resolves when the queue is empty and nothing is in flight (or the link cannot send). */
  function flush(): Promise<void> {
    if (flushing === null) {
      flushing = drain().finally(() => {
        flushing = null;
      });
    }
    return flushing.then(() => (canSend() && startingTurns === 0 && queue.length > 0 ? flush() : undefined));
  }

  let pendingFlush = false;
  function scheduleFlush(): void {
    if (pendingFlush) return;
    pendingFlush = true;
    queueMicrotask(() => {
      pendingFlush = false;
      // a turn about to be posted carries the queue itself
      if (startingTurns === 0) void flush();
    });
  }

  return {
    get status() {
      return status;
    },

    async connect(ready: CreateSessionRequest): Promise<void> {
      setStatus('connecting');
      let response: Response;
      try {
        response = await fetch(API.sessions, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ready) });
      } catch (cause) {
        throw new Error('The server cannot be reached.', { cause });
      }
      if (!response.ok) {
        throw new Error(`The server refused the session (${response.status}).`);
      }
      const body = asSessionResponse(await response.json().catch(() => null));
      if (body === null) throw new Error('The server answered with something that is not a session.');
      session = body.session;
      openStream(body.session);
      setStatus('open');
      void flush();
    },

    onEvent(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },

    onStatus(listener) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },

    async startTurn(input: TurnInput): Promise<string> {
      // Yield one microtask so the painter's queued emissions (the interruption report) reach the
      // queue, let events already in flight land, then carry the queue inside the turn request: the
      // server applies it before it opens the turn.
      startingTurns += 1;
      let events: BackEvent[];
      try {
        // a batch already in flight finishes (drain pauses while a turn is starting); the rest rides with the turn
        if (flushing !== null) await flushing;
        await Promise.resolve();
        if (session === null) throw new Error('Not connected.');
        events = queue;
        queue = [];
      } finally {
        startingTurns -= 1;
      }
      const restore = (): void => {
        queue = [...events, ...queue];
        if (events.length > 0) scheduleFlush();
      };
      let response: Response;
      try {
        response = await fetch(API.turns(session), {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...reviewHeader },
          body: JSON.stringify((events.length > 0 ? { input, events } : { input }) satisfies StartTurnRequest),
        });
      } catch (cause) {
        restore();
        throw new Error('The server cannot be reached.', { cause });
      }
      if (response.status === 404) setStatus('closed');
      if (!response.ok) {
        restore();
        throw new Error(`The turn was refused (${response.status}).`);
      }
      const turn = asTurnId(await response.json().catch(() => null));
      if (turn === null) throw new Error('The server did not say which turn it opened.');
      return turn;
    },

    send(event: BackEvent): void {
      queue.push(event);
      if (queue.length > 500) queue.shift();
      scheduleFlush();
    },

    async brain(): Promise<BrainChoice> {
      if (session === null) throw new Error('Not connected.');
      return brainAnswer(await fetch(API.brain(session)));
    },

    async setBrain(change: BrainChange): Promise<BrainChoice> {
      if (session === null) throw new Error('Not connected.');
      return brainAnswer(await fetch(API.brain(session), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(change) }));
    },

    flush,

    setReview(on) {
      reviewHeader = on ? {} : { 'x-conduit-review': 'off' };
    },

    async tools(): Promise<readonly ToolChoice[]> {
      if (session === null) throw new Error('Not connected.');
      const tools = asTools(await bodyOf(await fetch(API.tools(session))));
      if (tools === null) throw new Error('the server answered with something that is not a list of tools');
      return tools;
    },

    async setTool(name: string, on: boolean): Promise<readonly ToolChoice[]> {
      if (session === null) throw new Error('Not connected.');
      const response = await fetch(API.tools(session), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, on }) });
      const tools = asTools(await bodyOf(response));
      if (tools === null) throw new Error('the server answered with something that is not a list of tools');
      return tools;
    },

    async appStatus(): Promise<AppStatus> {
      const status = asStatus(await bodyOf(await fetch(API.status)));
      if (status === null) throw new Error('the server answered with something that is not a status');
      return status;
    },

    async asks(clear: boolean): Promise<readonly string[]> {
      if (session === null) throw new Error('Not connected.');
      const response = await fetch(API.asks(session), { method: clear ? 'DELETE' : 'GET' });
      if (response.status === 404) throw new Error('this server does not keep standing asks yet');
      const asks = asAsks(await bodyOf(response));
      if (asks === null) throw new Error('the server answered with something that is not a list of asks');
      return asks;
    },

    async saveCapture(turn: string, film: Blob): Promise<void> {
      if (session === null) throw new Error('Not connected.');
      const response = await fetch(API.capture(session, turn), { method: 'POST', headers: { 'content-type': 'video/webm' }, body: film });
      if (!response.ok) throw new Error(`the server refused the film (${response.status})`);
    },

    onDropped(listener) {
      droppedListeners.add(listener);
      return () => droppedListeners.delete(listener);
    },

    async listDemos(): Promise<readonly DemoInfo[]> {
      const response = await fetch(API.demos);
      if (!response.ok) return [];
      return asDemos(await response.json().catch(() => null));
    },

    upload(upload: PainterUpload): void {
      const id = session;
      const what = upload.kind === 'sketch' ? `the sketch for ${upload.key}` : upload.kind === 'draft' ? 'the picture of the draft' : 'the snapshot of the stage';
      if (id === null || !canSend()) {
        note(`${what} was not sent: there is no connection`);
        return;
      }
      const url = upload.kind === 'sketch' ? API.sketch(id, upload.key) : upload.kind === 'draft' ? API.draft(id, upload.turn, upload.pass) : API.snapshot(id, upload.turn);
      void putPicture(url, upload.blob, upload.kind === 'sketch' ? 'image/png' : 'image/jpeg').then((failure) => {
        if (failure !== null) note(`${what} was not sent: ${failure}`);
      });
    },

    onNote(listener) {
      noteListeners.add(listener);
      return () => noteListeners.delete(listener);
    },

    close(): void {
      disposed = true;
      clearTimeout(retryTimer);
      clearInterval(watchdog);
      closeSource();
      setStatus('closed');
    },
  };
}
