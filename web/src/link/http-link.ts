import { API, STAGE_EVENT_TYPES } from '@conduit/language';
import type { BackEvent, CreateSessionRequest, CreateSessionResponse, DemoInfo, StageEvent, StageEventType, StartTurnRequest, TurnInput } from '@conduit/language';
import type { LinkStatus, StageLink } from '../contracts/link';
import type { PainterUpload } from '../contracts/painter';

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000] as const;
const MAX_RETRIES = 3;
const MAX_BATCH = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

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

  function emit(event: StageEvent): void {
    for (const listener of [...eventListeners]) {
      try {
        listener(event);
      } catch {
        // a faulty listener must not stop the stream
      }
    }
  }

  function parseEvent(type: StageEventType, data: string): StageEvent | null {
    let body: unknown;
    try {
      body = JSON.parse(data);
    } catch {
      return null;
    }
    if (!isRecord(body)) return null;
    return { ...body, type } as StageEvent;
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
      setStatus('open');
    };
    for (const type of STAGE_EVENT_TYPES) {
      stream.addEventListener(type, (message) => {
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
      const body = (await response.json()) as CreateSessionResponse;
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
      const body = (await response.json()) as { turn: string };
      return body.turn;
    },

    send(event: BackEvent): void {
      queue.push(event);
      if (queue.length > 500) queue.shift();
      scheduleFlush();
    },

    flush,

    setReview(on) {
      reviewHeader = on ? {} : { 'x-conduit-review': 'off' };
    },

    onDropped(listener) {
      droppedListeners.add(listener);
      return () => droppedListeners.delete(listener);
    },

    async listDemos(): Promise<readonly DemoInfo[]> {
      const response = await fetch(API.demos);
      if (!response.ok) return [];
      return (await response.json()) as DemoInfo[];
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
      closeSource();
      setStatus('closed');
    },
  };
}
