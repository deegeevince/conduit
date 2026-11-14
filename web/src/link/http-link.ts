import { API, checkStageEvent, STAGE_EVENT_TYPES, STREAM_HEARTBEAT } from '@conduit/language';
import type { AppStatus, BackEvent, BrainChange, BrainChoice, CreateSessionRequest, DemoInfo, DocumentSummary, DocumentView, OpenDocumentResponse, StageEvent, StageEventType, StartTurnRequest, ToolChoice, TurnInput, UploadCrop, UploadResponse, VoiceResponse, VoiceStatus } from '@conduit/language';
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
  /** v2.1 ops. What the server's model calls have used (`/usage`). */
  usage(): Promise<UsageView>;
  /** v2.1 ops. The kill switch (`/stop-all`): stops everything the server is doing, for every conversation, and turns agent tools off. Answers what was stopped. */
  killAll(): Promise<KillAnswer>;
  /** v2.1 ops. Switches agent tools back on after a kill (`/stop-all resume`). */
  resumeAgent(): Promise<void>;
  /** v2.1. Saves a film of a turn made in the page beside the session's log, for the steward to watch (`/capture`). */
  saveCapture(turn: string, film: Blob): Promise<void>;
  /** v2.1. Gives the server a photo of the user's (picked, taken, pasted or dropped). It checks it by its bytes, converts and shrinks it, drops its metadata and keeps it; rejects with the server's own sentence when it will not. */
  uploadPhoto(photo: Blob): Promise<UploadResponse>;
  /** v2.1. Whether the owner's Mac can read a voice note right now (no permission is asked for); `problem` is the sentence to show when it cannot. */
  voiceStatus(): Promise<VoiceStatus>;
  /** v2.1. Gives the server a recording to read on its Mac, on the device. Resolves with the words and the note's id; rejects with the server's own sentence when it will not. */
  uploadVoice(recording: Blob): Promise<VoiceResponse>;
  /** v2.1. Frames one part of a photo this conversation holds (a question from a page) as a new photo; the page stays as it was. Rejects with the server's sentence. */
  cropPhoto(id: string, crop: UploadCrop): Promise<UploadResponse>;
  /** v2.1. Where a photo this conversation holds is, by its id (`u1`); null before there is a conversation. What the prompt bar's thumbnail and `pic u1` draw. */
  photoUrl(id: string): string | null;
  /** v3. The catalogue: every document there is, newest first (`GET /api/documents`). */
  documents(): Promise<readonly DocumentSummary[]>;
  /**
   * v3. Opens a document again in a NEW session and moves this link onto it (`POST /api/documents/:id/open`): the stream, the back channel and every
   * later request are the new session's. Resolves with the document and the person's place in it. Used at boot (a reload resumes) and from the catalogue.
   * Rejects with the server's sentence; the link is left on the session it had.
   */
  resumeDocument(id: string, ready?: CreateSessionRequest): Promise<DocumentView>;
  /** v3. Reads what the person wrote by hand in an ask's answer area, from the picture of the ink (an upload id): the words, as the server's reader sees them. */
  readInk(request: { readonly image: string; readonly node: string; readonly ask: string }): Promise<{ readonly text: string; readonly lines: readonly string[]; readonly unclear: boolean }>;
}

/** One hour or one day of model use, as `/api/usage` gives it; only what `/usage` shows. */
export interface UsageBucketView {
  readonly start: string;
  readonly calls: number;
  readonly costUsd: number;
  readonly unmetered: number;
  readonly outputTokens: number;
  readonly byKind: Readonly<Record<string, { readonly calls: number; readonly costUsd: number }>>;
}

export interface UsageView {
  readonly throttle: { readonly capUsd: number | null; readonly spentLastHourUsd: number; readonly state: 'off' | 'ok' | 'near' | 'over'; readonly nearAtUsd: number | null };
  readonly hours: readonly UsageBucketView[];
  readonly days: readonly UsageBucketView[];
}

/** What the kill switch says it did: how many answers it ended, questions it refused and processes it killed, and how many would not die. */
export interface KillAnswer {
  readonly engaged: true;
  readonly turns: number;
  readonly permissionsDenied: number;
  readonly children: number;
  readonly survivors: number;
  /** tabs the brain opened in Chrome that the server cannot close once the brain is gone */
  readonly browserTabs: number;
}

async function bodyOf(response: Response): Promise<unknown> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(messageOf(body, `the server refused it (${response.status})`));
  return body;
}

/** What the server said of a photo it kept; throws its own sentence when it refused. */
function keptFrom(response: Response, body: unknown): UploadResponse {
  if (!response.ok) {
    const said = messageOf(body, `the server refused it (${response.status})`);
    throw new Error(`${said.charAt(0).toUpperCase()}${said.slice(1)}${/[.!?]$/.test(said) ? '' : '.'}`);
  }
  const kept = body as Partial<UploadResponse> | null;
  if (kept === null || typeof kept.id !== 'string') throw new Error('The server did not say what it kept.');
  return { id: kept.id, mime: String(kept.mime ?? 'image/jpeg'), width: Number(kept.width ?? 0), height: Number(kept.height ?? 0), bytes: Number(kept.bytes ?? 0) };
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
  /** what the painter said of itself when the session was made: a document opened again is made with the same */
  let readyRequest: CreateSessionRequest | null = null;
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

  /** `sent`; `gone` (the session is not there: nothing can be sent); `refused` (a 4xx: this body will never be accepted); `failed` (the network or a 5xx: it may be, later). */
  type Posted = 'sent' | 'gone' | 'refused' | 'failed';

  async function postBatch(id: string, batch: readonly BackEvent[]): Promise<Posted> {
    for (let tries = 0; tries <= MAX_RETRIES; tries += 1) {
      try {
        const response = await fetch(API.events(id), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ events: batch }),
          keepalive: JSON.stringify(batch).length < 60000,
        });
        if (response.ok) return 'sent';
        if (response.status === 404) {
          setStatus('closed');
          return 'gone';
        }
        if (response.status >= 400 && response.status < 500) return 'refused';
      } catch {
        // network failure: retry
      }
      await new Promise((resolve) => setTimeout(resolve, 150 * (tries + 1)));
    }
    return 'failed';
  }

  /**
   * How long an event is kept for sending again after the link has failed it. The owner's answer to a confirm control is kept the
   * longest: a lost `permit` is a no the owner never gave, and it cannot be sent again from the page. A `progress` is only a
   * heartbeat and is not kept at all.
   */
  const KEEP_MS: Readonly<Record<string, number>> = { permit: 300_000, progress: 0 };
  const KEEP_OTHER_MS = 30_000;
  const keptUntil = new WeakMap<BackEvent, number>();
  const RESEND_PAUSE_MS = [500, 1_000, 2_000, 4_000];
  let failedRounds = 0;

  async function drain(): Promise<void> {
    while (queue.length > 0 && canSend() && startingTurns === 0 && session !== null) {
      const batch = queue.slice(0, MAX_BATCH);
      queue = queue.slice(batch.length);
      const posted = await postBatch(session, batch);
      if (posted === 'sent') {
        failedRounds = 0;
        continue;
      }
      if (posted === 'refused' && batch.length > 1) {
        // One bad event must not take forty-nine good ones with it: each goes alone, and only the refused is dropped.
        let lost = 0;
        for (const event of batch) {
          if (session === null || (await postBatch(session, [event])) !== 'sent') lost += 1;
        }
        if (lost > 0) for (const listener of [...droppedListeners]) listener(lost);
        continue;
      }
      if (posted === 'failed') {
        const now = Date.now();
        const keep = batch.filter((event) => {
          const until = keptUntil.get(event) ?? now + (KEEP_MS[event.type] ?? KEEP_OTHER_MS);
          keptUntil.set(event, until);
          return until > now && (KEEP_MS[event.type] ?? 1) > 0;
        });
        if (keep.length < batch.length) for (const listener of [...droppedListeners]) listener(batch.length - keep.length);
        // Back at the front, in order, and a pause before the next try: the link is down, not the events wrong.
        queue = [...keep, ...queue];
        if (keep.length > 0) await new Promise((resolve) => setTimeout(resolve, RESEND_PAUSE_MS[Math.min(failedRounds, RESEND_PAUSE_MS.length - 1)]));
        failedRounds += 1;
        continue;
      }
      for (const listener of [...droppedListeners]) listener(batch.length);
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
      readyRequest = ready;
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
      const answer: unknown = await response.json().catch(() => null);
      const turn = asTurnId(answer);
      if (turn === null) throw new Error('The server did not say which turn it opened.');
      // The turn goes ahead whatever this says: the owner is told the hour is near the cap they set, and decides.
      const warning = typeof answer === 'object' && answer !== null ? (answer as { warning?: unknown }).warning : undefined;
      if (typeof warning === 'string' && warning !== '') note(warning);
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

    async usage(): Promise<UsageView> {
      const body = (await bodyOf(await fetch(`${API.usage}?hours=24&days=7`))) as Partial<UsageView> | null;
      if (body === null || typeof body !== 'object' || !Array.isArray(body.hours) || !Array.isArray(body.days) || typeof body.throttle !== 'object' || body.throttle === null) throw new Error('the server answered with something that is not a usage summary');
      return body as UsageView;
    },

    async killAll(): Promise<KillAnswer> {
      const body = await bodyOf(await fetch(API.kill, { method: 'POST' }));
      const answer = body as (Partial<KillAnswer> & { descendants?: unknown }) | null;
      if (answer === null || typeof answer !== 'object' || answer.engaged !== true) throw new Error('the server did not say it had stopped');
      const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
      return { engaged: true, turns: count(answer.turns), permissionsDenied: count(answer.permissionsDenied), children: count(answer.children) + count(answer.descendants), survivors: Array.isArray(answer.survivors) ? answer.survivors.length : 0, browserTabs: count((answer as { browserTabsLeftOpen?: unknown }).browserTabsLeftOpen) };
    },

    async resumeAgent(): Promise<void> {
      await bodyOf(await fetch(API.kill, { method: 'DELETE' }));
    },

    async cropPhoto(id: string, crop: UploadCrop): Promise<UploadResponse> {
      if (session === null || !canSend()) throw new Error('Not connected. Try again in a moment.');
      const response = await fetch(API.uploadCrop(session, id), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(crop) });
      return keptFrom(response, await response.json().catch(() => null));
    },

    async voiceStatus(): Promise<VoiceStatus> {
      let response: Response;
      try {
        response = await fetch(API.voiceStatus, { cache: 'no-store' });
      } catch (cause) {
        throw new Error('The server cannot be reached.', { cause });
      }
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok || typeof body !== 'object' || body === null) throw new Error(messageOf(body, `the server refused it (${response.status})`));
      return body as VoiceStatus;
    },

    async uploadVoice(recording: Blob): Promise<VoiceResponse> {
      if (session === null || !canSend()) throw new Error('Not connected. Try again in a moment.');
      let response: Response;
      try {
        response = await fetch(API.voice(session), { method: 'POST', headers: { 'content-type': recording.type !== '' ? recording.type : 'application/octet-stream' }, body: recording });
      } catch (cause) {
        throw new Error('The voice note could not be sent: the server cannot be reached.', { cause });
      }
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const said = messageOf(body, `the server refused it (${response.status})`);
        throw new Error(`${said.charAt(0).toUpperCase()}${said.slice(1)}${/[.!?]$/.test(said) ? '' : '.'}`);
      }
      const read = body as Partial<VoiceResponse> | null;
      if (read === null || typeof read.id !== 'string' || typeof read.text !== 'string') throw new Error('The server did not say what it heard.');
      return { id: read.id, text: read.text, seconds: Number(read.seconds ?? 0), recogniser: 'on-device', locale: String(read.locale ?? ''), kept: read.kept === true };
    },

    async uploadPhoto(photo: Blob): Promise<UploadResponse> {
      if (session === null || !canSend()) throw new Error('Not connected. Try again in a moment.');
      let response: Response;
      try {
        response = await fetch(API.uploads(session), { method: 'POST', headers: { 'content-type': photo.type !== '' ? photo.type : 'application/octet-stream' }, body: photo });
      } catch (cause) {
        throw new Error('The photo could not be sent: the server cannot be reached.', { cause });
      }
      return keptFrom(response, await response.json().catch(() => null));
    },

    photoUrl(id: string): string | null {
      return session === null ? null : API.upload(session, id);
    },

    async documents(): Promise<readonly DocumentSummary[]> {
      const body = await bodyOf(await fetch(API.documents, { cache: 'no-store' }));
      return Array.isArray(body) ? (body as DocumentSummary[]) : [];
    },

    async resumeDocument(id: string, ready?: CreateSessionRequest): Promise<DocumentView> {
      const request = ready ?? readyRequest;
      if (request === null) throw new Error('The stage is not ready yet.');
      readyRequest = request;
      let response: Response;
      try {
        response = await fetch(API.documentOpen(id), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
      } catch (cause) {
        throw new Error('The server cannot be reached.', { cause });
      }
      const body = (await bodyOf(response)) as Partial<OpenDocumentResponse> | null;
      const made = asSessionResponse(body);
      if (made === null || body === null || body.view === undefined) throw new Error('The server answered with something that is not a session.');
      // the old session stays where it was; the stream, the queue and every request are the new one's
      queue = [];
      session = made.session;
      status = 'connecting';
      openStream(made.session);
      setStatus('open');
      void flush();
      return body.view;
    },

    async readInk(request): Promise<{ readonly text: string; readonly lines: readonly string[]; readonly unclear: boolean }> {
      if (session === null || !canSend()) throw new Error('Not connected. Try again in a moment.');
      const response = await fetch(API.readInk(session), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
      const body = (await bodyOf(response)) as { text?: unknown; lines?: unknown; unclear?: unknown } | null;
      const lines = Array.isArray(body?.lines) ? (body.lines as unknown[]).filter((line): line is string => typeof line === 'string') : [];
      return { text: typeof body?.text === 'string' ? body.text : lines.join('\n'), lines, unclear: body?.unclear === true };
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
