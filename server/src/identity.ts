// Who is asking. The server sits behind `tailscale serve`, which connects to it from 127.0.0.1 for every tailnet user and says who that
// user is in headers (measured on this machine, 2026-11-14, and written into docs/runbook.md):
//
//   tailscale-user-login, tailscale-user-name, tailscale-user-profile-pic, tailscale-headers-info
//   x-forwarded-for, x-forwarded-host, x-forwarded-proto
//
// `serve` OVERWRITES any `Tailscale-User-*` header the client sent (a forged login sent through it arrived as the real one), so a header
// that comes through `serve` can be believed. A header on a request that did NOT come through `serve` cannot: anyone who can reach the
// loopback port can write one. So the rules are these, and they are the only place identity is decided:
//
//   - a request that is not from loopback is refused: nothing in front of this server connects from anywhere else;
//   - a request from loopback with none of `serve`'s marks (no forwarding header, no Tailscale header) is the owner at the keyboard: local;
//   - a request from loopback with any of them came through `serve`: it must carry a Tailscale login, and with `OWNER_LOGINS` set, one of
//     the owner's. No login (a tagged device, a Funnel request, a proxy that is not Tailscale) is refused.
//   - with `OWNER_LOGINS` unset nothing is refused on identity (the old behaviour); the login is still read and recorded.
//
// The owner's login is read from the header at run time. It is never written in a file of the repository.

import { AsyncLocalStorage } from 'node:async_hooks';

export interface Identity {
  /** the Tailscale login, lower-cased; null for the owner at the keyboard (loopback, no `serve` in between) */
  readonly login: string | null;
  /** the display name Tailscale gave, for `/api/whoami` only */
  readonly name: string | null;
  readonly via: 'local' | 'tailscale';
}

export const LOCAL: Identity = { login: null, name: null, via: 'local' };

/** What a login is called in the audit trail and the logs when there is none. */
export const LOCAL_LABEL = 'local';

export const labelOf = (identity: Identity): string => identity.login ?? LOCAL_LABEL;

const store = new AsyncLocalStorage<Identity>();

/** Runs `next` with `identity` as the one asking. Everything it starts (a turn's `run`, a permission's answer) can read it with `currentIdentity`. */
export function runAs<T>(identity: Identity, next: () => T): T {
  return store.run(identity, next);
}

/** Who is asking, in a call made from a request; the owner at the keyboard anywhere else (a timer, a boot). */
export function currentIdentity(): Identity {
  return store.getStore() ?? LOCAL;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export type Verdict =
  | { readonly ok: true; readonly identity: Identity }
  | { readonly ok: false; readonly why: string; readonly identity: Identity; readonly refusal: 'not-loopback' | 'no-login' | 'not-the-owner' };

/** Settles one request. `header` reads a request header by lower-case name; `owners` is `OWNER_LOGINS`, lower-cased and empty when unset. */
export function identify(header: (name: string) => string | undefined, remote: string | undefined, owners: ReadonlySet<string>): Verdict {
  const login = header('tailscale-user-login')?.trim().toLowerCase();
  const name = header('tailscale-user-name')?.trim();
  const forwarded = header('x-forwarded-for') !== undefined || header('x-forwarded-host') !== undefined || header('tailscale-headers-info') !== undefined || login !== undefined || name !== undefined;
  const who: Identity = { login: login === undefined || login === '' ? null : login, name: name === undefined || name === '' ? null : name, via: forwarded ? 'tailscale' : 'local' };
  if (remote === undefined || !LOOPBACK.has(remote)) return { ok: false, why: 'the request did not come from this machine', identity: who, refusal: 'not-loopback' };
  if (!forwarded) return { ok: true, identity: LOCAL };
  if (owners.size === 0) return { ok: true, identity: who };
  if (who.login === null) return { ok: false, why: 'the request carries no Tailscale login', identity: who, refusal: 'no-login' };
  if (!owners.has(who.login)) return { ok: false, why: 'this tailnet user is not the owner', identity: who, refusal: 'not-the-owner' };
  return { ok: true, identity: who };
}
