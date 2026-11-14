// Fetching what an image host serves, with the care a stranger's file needs.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** Identifies this client and nothing else: no name, no address, no version of the product's user. */
export const CLIENT_NAME = 'conduit-pictures/0.1';

function privateAddress(address: string): boolean {
  const v4 = address.match(/^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = address.toLowerCase();
  return v6 === '::' || v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

/** Throws unless `url` is https, on the default port, and names only public addresses. */
export async function assertPublicHttps(url: URL): Promise<void> {
  if (url.protocol !== 'https:') throw new Error('not https');
  if (url.port !== '' && url.port !== '443') throw new Error('unusual port');
  if (url.username !== '' || url.password !== '') throw new Error('credentials in url');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('local host');
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addresses.length === 0 || addresses.some((a) => privateAddress(a.address))) throw new Error('not a public address');
}

export interface Limited {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

/** GET with at most three redirects, each checked afresh, a deadline, and a cap on the bytes that is enforced as they arrive. */
export async function getLimited(start: string, maxBytes: number, accept: string, signal: AbortSignal): Promise<Limited> {
  let url = new URL(start);
  for (let hop = 0; hop <= 3; hop++) {
    await assertPublicHttps(url);
    const response = await fetch(url, { redirect: 'manual', signal, headers: { 'user-agent': CLIENT_NAME, accept } });
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get('location');
      await response.body?.cancel();
      if (next === null) throw new Error('redirect with no location');
      url = new URL(next, url);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`http ${response.status}`);
    }
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > maxBytes) {
      await response.body?.cancel();
      throw new Error('too large');
    }
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('no body');
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('too large');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    return { bytes, contentType: response.headers.get('content-type') ?? '' };
  }
  throw new Error('too many redirects');
}
