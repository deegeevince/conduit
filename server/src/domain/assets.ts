import type { Snapshot } from './brain';

export const ASSET_LIMITS = {
  /** bytes of pictures kept per session before the oldest painting is dropped */
  bytesPerSession: 48 * 1024 * 1024,
  /** bytes in one uploaded sketch or snapshot */
  uploadBytes: 1024 * 1024,
  /** bytes in one film made in the page for the steward (`/capture`) */
  filmBytes: 32 * 1024 * 1024,
  /** how long the server waits for the painter's sketch before it paints from the words alone */
  sketchWaitMs: 1500,
} as const;

export interface StoredAsset {
  readonly id: string;
  readonly session: string;
  readonly mime: string;
  readonly bytes: Uint8Array;
}

const SKETCHES_KEPT = 8;
const SNAPSHOTS_KEPT = 2;

interface Held {
  /** insertion order is age */
  readonly paintings: Map<string, StoredAsset>;
  paintingBytes: number;
  readonly sketches: Map<string, Uint8Array>;
  readonly waiting: Map<string, Set<(bytes: Uint8Array | null) => void>>;
  readonly snapshots: Map<string, Snapshot>;
}

/**
 * Pictures held for the sessions in memory: paintings on their way to the
 * painter, sketches on their way to the image model, and the latest snapshot
 * of each turn. Nothing here touches the disk; the session log keeps its own
 * copy of what it wants.
 */
export class AssetStore {
  private readonly sessions = new Map<string, Held>();
  private counter = 0;

  private held(session: string): Held {
    let held = this.sessions.get(session);
    if (held === undefined) {
      held = { paintings: new Map(), paintingBytes: 0, sketches: new Map(), waiting: new Map(), snapshots: new Map() };
      this.sessions.set(session, held);
    }
    return held;
  }

  /** Keeps a painting and returns the id it can be fetched under. Drops the session's oldest paintings beyond `ASSET_LIMITS.bytesPerSession`. */
  putPainting(session: string, mime: string, bytes: Uint8Array): StoredAsset {
    const held = this.held(session);
    this.counter += 1;
    const asset: StoredAsset = { id: `p${this.counter}`, session, mime, bytes };
    held.paintings.set(asset.id, asset);
    held.paintingBytes += bytes.byteLength;
    for (const [id, old] of held.paintings) {
      if (held.paintingBytes <= ASSET_LIMITS.bytesPerSession || id === asset.id) break;
      held.paintings.delete(id);
      held.paintingBytes -= old.bytes.byteLength;
    }
    return asset;
  }

  /** The painting with this id, if the session still holds it. */
  painting(session: string, id: string): StoredAsset | undefined {
    return this.sessions.get(session)?.paintings.get(id);
  }

  /** The painter's sketch for a picture element has arrived. Wakes whoever is waiting in `sketchFor`. */
  putSketch(session: string, key: string, bytes: Uint8Array): void {
    const held = this.held(session);
    const waiting = held.waiting.get(key);
    if (waiting !== undefined && waiting.size > 0) {
      for (const resolve of [...waiting]) resolve(bytes);
      return;
    }
    // A sketch nobody asks for (it came after the wait ran out) must not pile up.
    held.sketches.delete(key);
    held.sketches.set(key, bytes);
    while (held.sketches.size > SKETCHES_KEPT) {
      const oldest = held.sketches.keys().next();
      if (oldest.done === true) break;
      held.sketches.delete(oldest.value);
    }
  }

  /**
   * The sketch for a picture element: at once if it is here, otherwise when it
   * arrives, otherwise null after `waitMs` or when `signal` aborts. A sketch
   * is handed out once and then forgotten.
   */
  sketchFor(session: string, key: string, waitMs: number, signal: AbortSignal): Promise<Uint8Array | null> {
    const held = this.held(session);
    const here = held.sketches.get(key);
    if (here !== undefined) {
      held.sketches.delete(key);
      return Promise.resolve(here);
    }
    if (signal.aborted || waitMs <= 0) return Promise.resolve(null);
    return new Promise((resolve) => {
      const set = held.waiting.get(key) ?? new Set<(bytes: Uint8Array | null) => void>();
      held.waiting.set(key, set);
      const done = (bytes: Uint8Array | null): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        set.delete(done);
        if (set.size === 0) held.waiting.delete(key);
        resolve(bytes);
      };
      const onAbort = (): void => done(null);
      const timer = setTimeout(() => done(null), waitMs);
      set.add(done);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Keeps the picture of how a turn landed. Only the session's two most recent are kept. */
  putSnapshot(session: string, turn: string, snapshot: Snapshot): void {
    const held = this.held(session);
    held.snapshots.delete(turn);
    held.snapshots.set(turn, snapshot);
    while (held.snapshots.size > SNAPSHOTS_KEPT) {
      const oldest = held.snapshots.keys().next();
      if (oldest.done === true) break;
      held.snapshots.delete(oldest.value);
    }
  }

  snapshot(session: string, turn: string): Snapshot | undefined {
    return this.sessions.get(session)?.snapshots.get(turn);
  }

  /** Forgets everything held for a session. */
  drop(session: string): void {
    const held = this.sessions.get(session);
    if (held === undefined) return;
    this.sessions.delete(session);
    for (const set of held.waiting.values()) for (const resolve of [...set]) resolve(null);
  }
}
