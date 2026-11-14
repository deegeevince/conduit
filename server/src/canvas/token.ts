// The bearer tokens of the canvas service (SA4; PLAN-stage section 3). One is minted for each warm process, is bound to the one conversation that
// process serves, and is revoked when the process is let go. A token is never logged and never leaves the 0600 file the process was started with.

import { randomBytes, timingSafeEqual } from 'node:crypto';

export interface CanvasGrant {
  readonly session: string;
}

export class CanvasTokens {
  private readonly grants = new Map<string, CanvasGrant>();

  /** A new token for a process that serves `session`. */
  mint(session: string): string {
    const token = randomBytes(32).toString('hex');
    this.grants.set(token, { session });
    return token;
  }

  revoke(token: string): void {
    this.grants.delete(token);
  }

  /** The grant a bearer header carries, or null. Compared in constant time against each token held. */
  resolve(header: string | undefined): CanvasGrant | null {
    if (header === undefined) return null;
    const match = /^Bearer ([0-9a-f]{64})$/.exec(header.trim());
    if (match === null) return null;
    const given = Buffer.from(match[1] ?? '', 'utf8');
    let found: CanvasGrant | null = null;
    for (const [token, grant] of this.grants) {
      const held = Buffer.from(token, 'utf8');
      if (held.length === given.length && timingSafeEqual(held, given)) found = grant;
    }
    return found;
  }

  get size(): number {
    return this.grants.size;
  }
}
