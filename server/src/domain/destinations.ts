// Where agent mode may reach. A navigate, a fetch or any call that carries an address is refused in EVERY permit level when the address is
// on this machine or inside a private network: loopback, private and link-local ranges, shared (carrier-grade) space, `.local`, `.internal`,
// `.lan`, single-word hosts, and an IP number with no public route. A public name is resolved too, and refused when it points at one of those.
// The owner may allow particular hosts (never a range) in `<DATA_DIR>/private-hosts.allow`, one host per line, `#` for a comment. It does not
// exist by default.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PRIVATE_HOSTS_FILE = 'private-hosts.allow';

/** The hosts the owner has allowed, lower-cased; empty when there is no file. */
export function loadPrivateHostAllowList(dataDir: string): readonly string[] {
  const file = join(dataDir, PRIVATE_HOSTS_FILE);
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, 'utf8').split('\n').map((line) => line.replace(/#.*/, '').trim().toLowerCase()).filter((line) => line !== '');
  } catch {
    return [];
  }
}

function v4Parts(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return m === null ? null : m.slice(1).map(Number);
}

/** Why an IPv4 number has no public route, or null. */
function privateV4(host: string): string | null {
  const p = v4Parts(host);
  if (p === null) return null;
  const [a, b] = p as [number, number, number, number];
  if (a === 127) return 'a loopback address (this machine)';
  if (a === 0) return 'an unroutable address';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'a private network address';
  if (a === 169 && b === 254) return 'a link-local address';
  if (a === 100 && b >= 64 && b <= 127) return 'a shared private-network address';
  if (a === 192 && b === 0 && p[2] === 0) return 'a reserved address';
  if (a >= 224) return 'a reserved address';
  return null;
}

/** Why an IPv6 number (without brackets) has no public route, or null. */
function privateV6(raw: string): string | null {
  const host = raw.toLowerCase();
  if (host === '::1' || host === '::') return 'a loopback address (this machine)';
  const mapped = /^::ffff:(.+)$/.exec(host);
  if (mapped !== null) {
    const rest = mapped[1] as string;
    if (v4Parts(rest) !== null) return privateV4(rest) ?? null;
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
    if (hex !== null) {
      const hi = parseInt(hex[1] as string, 16);
      const lo = parseInt(hex[2] as string, 16);
      return privateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return 'an IPv4 address inside IPv6';
  }
  const first = parseInt(host.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00) return 'a private network address';
  if ((first & 0xffc0) === 0xfe80) return 'a link-local address';
  if ((first & 0xff00) === 0xff00) return 'a reserved address';
  return null;
}

/** The host of an address as written (`https://` assumed when there is no scheme), or null if it is not one. */
export function hostOf(raw: string): string | null {
  const text = raw.trim();
  if (text === '' || /^(?:back|forward)$/i.test(text)) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    return host === '' ? null : host;
  } catch {
    return null;
  }
}

const allowed = (host: string, allow: readonly string[]): boolean => allow.includes(host);

/** Why this host, by its name or number alone, may not be reached; null when nothing about the name itself says so. */
export function privateReason(host: string, allow: readonly string[] = []): string | null {
  if (allowed(host, allow)) return null;
  const kind = isIP(host);
  if (kind === 4) return privateV4(host);
  if (kind === 6) return privateV6(host);
  if (host === 'localhost' || host.endsWith('.localhost')) return 'localhost (this machine)';
  if (/\.(?:local|internal|lan|home|corp|intranet|localdomain)$/.test(host)) return 'a name that only exists on a private network';
  if (!host.includes('.')) return 'a single-word host, which can only be on a private network';
  return null;
}

const URL_KEYS = /^(?:url|urls|uri|href|link|address|target|endpoint|origin)$/i;

/** Every address a tool's input carries: values under address-like keys, and any string that is an http(s) address. */
export function addressesIn(input: Readonly<Record<string, unknown>>): string[] {
  const out: string[] = [];
  const visit = (value: unknown, key: string, depth: number): void => {
    if (depth > 3) return;
    if (typeof value === 'string') {
      if (URL_KEYS.test(key) || /^https?:\/\//i.test(value.trim())) out.push(value);
    } else if (Array.isArray(value)) value.forEach((entry) => visit(entry, key, depth + 1));
    else if (value !== null && typeof value === 'object') for (const [k, v] of Object.entries(value as Record<string, unknown>)) visit(v, k, depth + 1);
  };
  for (const [key, value] of Object.entries(input)) visit(value, key, 0);
  return out;
}

/** The plain reason a call is refused for where it goes (by the address as written), or null. Pure. */
export function deniedDestination(input: Readonly<Record<string, unknown>>, allow: readonly string[] = []): string | null {
  for (const address of addressesIn(input)) {
    const host = hostOf(address);
    if (host === null) continue;
    const why = privateReason(host, allow);
    if (why !== null) return `${host} is ${why}, and the brain may not open addresses on this machine or a private network`;
  }
  return null;
}

export type Resolver = (host: string) => Promise<readonly string[]>;
const systemResolver: Resolver = async (host) => (await lookup(host, { all: true })).map((entry) => entry.address);

/** The same refusal after resolving each public name: a name that points at a private number is refused. A name that does not resolve is left to fail on its own. */
export async function deniedAfterResolving(input: Readonly<Record<string, unknown>>, allow: readonly string[] = [], resolve: Resolver = systemResolver): Promise<string | null> {
  for (const address of addressesIn(input)) {
    const host = hostOf(address);
    if (host === null || isIP(host) !== 0 || allowed(host, allow)) continue;
    let numbers: readonly string[];
    try {
      numbers = await resolve(host);
    } catch {
      continue;
    }
    for (const number of numbers) {
      const why = privateReason(number, allow);
      if (why !== null) return `${host} points at ${number}, ${why}, and the brain may not open addresses on this machine or a private network`;
    }
  }
  return null;
}
