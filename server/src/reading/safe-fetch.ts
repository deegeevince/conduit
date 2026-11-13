// The only module that opens a connection to an address the user typed. The address is checked where the
// connection is made (the resolver hook), so a name that resolves to a private address is refused even if it
// pointed somewhere public a moment ago, and a redirect is checked exactly like a first request.

import { lookup as resolve } from 'node:dns';
import { request as httpRequest } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { LookupFunction } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { FetchOutcome } from '../domain/documents';
import { DOCUMENT_LIMITS } from '../domain/documents';

export class FetchFailure extends Error {
  readonly outcome: FetchOutcome;
  readonly status: number | null;

  constructor(outcome: FetchOutcome, message: string, status: number | null = null) {
    super(message);
    this.name = 'FetchFailure';
    this.outcome = outcome;
    this.status = status;
  }
}

export interface Fetched {
  readonly finalUrl: string;
  readonly status: number;
  readonly contentType: string | null;
  readonly body: Buffer;
}

const USER_AGENT = 'Mozilla/5.0 (compatible; ConduitReader/1.0)';

function v4Parts(address: string): number[] | null {
  const parts = address.split('.').map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null;
}

function publicV4(address: string): boolean {
  const p = v4Parts(address);
  if (p === null) return false;
  const [a = 0, b = 0, c = 0] = p;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function v6Groups(address: string): number[] | null {
  const bare = address.split('%')[0] ?? '';
  let text = bare;
  const tail = text.lastIndexOf(':');
  const embedded = text.slice(tail + 1);
  if (embedded.includes('.')) {
    const p = v4Parts(embedded);
    if (p === null) return null;
    text = `${text.slice(0, tail + 1)}${(((p[0] ?? 0) << 8) | (p[1] ?? 0)).toString(16)}:${(((p[2] ?? 0) << 8) | (p[3] ?? 0)).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] === '' ? [] : (halves[0] ?? '').split(':');
  const rest = halves.length === 2 ? (halves[1] === '' ? [] : (halves[1] ?? '').split(':')) : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array<string>(fill).fill('0'), ...rest].map((group) => Number.parseInt(group, 16));
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : null;
}

const quad = (high: number, low: number): string => `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;

function publicV6(address: string): boolean {
  const g = v6Groups(address);
  if (g === null) return false;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) return publicV4(quad(g6, g7));
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return false;
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return publicV4(quad(g6, g7));
  if (g0 === 0x2002) return publicV4(quad(g1, g2));
  if (g0 === 0x2001 && (g1 === 0 || g1 === 0xdb8)) return false;
  return (g0 & 0xe000) === 0x2000;
}

/** True only for an address on the public internet. Everything else, including every range this machine may reach privately (the tailnet's 100.64/10 among them), is refused. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? publicV4(address) : family === 6 ? publicV6(address) : false;
}

const refusal = (host: string): FetchFailure => new FetchFailure('refused', `refused: ${host} is not a public address, and this server only reads the public web`);

const guardedLookup: LookupFunction = (host, options, callback) => {
  resolve(host, { all: true, verbatim: true }, (error, addresses) => {
    if (error !== null) {
      callback(new FetchFailure('failed', `the name ${host} could not be found`), '', 4);
      return;
    }
    const first = addresses[0];
    if (first === undefined || addresses.some((found) => !isPublicAddress(found.address))) {
      callback(refusal(host), '', 4);
      return;
    }
    if (options.all === true) callback(null, addresses);
    else callback(null, first.address, first.family);
  });
};

const DECODERS = { gzip: createGunzip, 'x-gzip': createGunzip, deflate: createInflate, br: createBrotliDecompress } as const;

function once(url: URL, signal: AbortSignal): Promise<{ response: IncomingMessage; body: Promise<Buffer> }> {
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolveRequest, reject) => {
    const req = send(
      url,
      {
        method: 'GET',
        agent: false,
        signal,
        lookup: guardedLookup,
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/pdf,text/markdown,text/plain;q=0.9,*/*;q=0.1', 'accept-encoding': 'gzip, deflate, br' },
      },
      (response) => {
        const encoding = String(response.headers['content-encoding'] ?? '').trim().toLowerCase();
        const make = (DECODERS as Record<string, (() => NodeJS.ReadWriteStream) | undefined>)[encoding];
        const body = new Promise<Buffer>((done, fail) => {
          const source: NodeJS.ReadableStream = make === undefined ? response : response.pipe(make());
          const chunks: Buffer[] = [];
          let size = 0;
          source.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > DOCUMENT_LIMITS.fetchBytes) {
              response.destroy();
              fail(new FetchFailure('too_large', `too large: more than ${DOCUMENT_LIMITS.fetchBytes / 1024 / 1024} MB`));
              return;
            }
            chunks.push(chunk);
          });
          source.on('end', () => done(Buffer.concat(chunks)));
          source.on('error', (error) => fail(error));
          response.on('error', (error) => fail(error));
          response.on('close', () => {
            if (!response.complete) fail(new FetchFailure('failed', 'the connection closed before the whole page arrived'));
          });
        });
        body.catch(() => undefined);
        resolveRequest({ response, body });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * GET with the guards: http(s) only, public addresses only (re-checked on each of at most three redirects),
 * one deadline across everything, a byte cap on what is read after decompression.
 */
export async function safeFetch(start: string, outer: AbortSignal): Promise<Fetched> {
  const deadline = AbortSignal.timeout(DOCUMENT_LIMITS.fetchTimeoutMs);
  const signal = AbortSignal.any([outer, deadline]);
  let current = start;
  try {
    for (let hop = 0; ; hop += 1) {
      if (!URL.canParse(current)) throw new FetchFailure('failed', 'that is not a web address');
      const url = new URL(current);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new FetchFailure('refused', `refused: ${url.protocol} addresses are not read`);
      if (url.username !== '' || url.password !== '') throw new FetchFailure('refused', 'refused: addresses with a login in them are not read');
      const host = url.hostname.replace(/^\[|\]$/g, '');
      if (isIP(host) !== 0 && !isPublicAddress(host)) throw refusal(host);

      const { response, body } = await once(url, signal);
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location !== undefined) {
        response.destroy();
        if (hop >= DOCUMENT_LIMITS.maxRedirects) throw new FetchFailure('redirects', `it redirected more than ${DOCUMENT_LIMITS.maxRedirects} times`, status);
        current = new URL(location, url).href;
        continue;
      }
      if (status < 200 || status >= 300) {
        response.destroy();
        throw new FetchFailure('http_error', status === 404 ? 'not found (404)' : status === 403 || status === 401 ? `the site refused access (${status})` : `the site answered ${status}`, status);
      }
      const declared = Number(response.headers['content-length']);
      if (!response.headers['content-encoding'] && Number.isFinite(declared) && declared > DOCUMENT_LIMITS.fetchBytes) {
        response.destroy();
        throw new FetchFailure('too_large', `too large: ${Math.round(declared / 1024 / 1024)} MB, over the ${DOCUMENT_LIMITS.fetchBytes / 1024 / 1024} MB limit`, status);
      }
      const bytes = await body;
      const type = response.headers['content-type'];
      return { finalUrl: url.href, status, contentType: typeof type === 'string' ? type : null, body: bytes };
    }
  } catch (error) {
    if (error instanceof FetchFailure) throw error;
    if (deadline.aborted) throw new FetchFailure('timeout', `timed out after ${DOCUMENT_LIMITS.fetchTimeoutMs / 1000} s`);
    if (outer.aborted) throw new FetchFailure('aborted', 'the turn was interrupted');
    const cause = error instanceof Error ? ((error as NodeJS.ErrnoException).code ?? error.message) : String(error);
    throw new FetchFailure('failed', `could not connect (${cause})`);
  }
}
