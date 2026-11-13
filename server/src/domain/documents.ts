import type { DocumentFacts } from '@conduit/language';

export const DOCUMENT_LIMITS = {
  /** links read per turn; more are ignored */
  urlsPerTurn: 2,
  /** documents a conversation keeps; the oldest goes first */
  perSession: 4,
  /** bytes of PDF a conversation keeps */
  pdfBytesPerSession: 30 * 1024 * 1024,
  /** bytes accepted from one URL, after decompression */
  fetchBytes: 20 * 1024 * 1024,
  fetchTimeoutMs: 15_000,
  maxRedirects: 3,
} as const;

export type FetchOutcome = 'ok' | 'refused' | 'timeout' | 'too_large' | 'unsupported' | 'http_error' | 'redirects' | 'failed' | 'aborted' | 'disabled';

/** What one fetch did, for the session log. */
export interface FetchTrace {
  readonly url: string;
  readonly finalUrl: string | null;
  readonly status: number | null;
  readonly contentType: string | null;
  readonly bytes: number;
  readonly ms: number;
  readonly outcome: FetchOutcome;
}

export type ReadResult =
  | {
      readonly ok: true;
      readonly trace: FetchTrace;
      readonly kind: 'pdf' | 'text';
      readonly title: string | null;
      /** extracted text; null for a PDF, which goes to the model as it is */
      readonly text: string | null;
      readonly pdf: Uint8Array | null;
      readonly truncated: boolean;
    }
  | { readonly ok: false; readonly trace: FetchTrace; readonly why: string };

/**
 * Fetches a URL the user gave and turns it into something a brain can read.
 *
 * Contract: never throws; every failure is a `why` a person can read. Refuses
 * anything but public http(s) addresses, on every redirect. Stops when `signal` aborts.
 */
export interface DocumentReader {
  read(url: string, signal: AbortSignal): Promise<ReadResult>;
}

/** A document held for a conversation. Facts are what a brief says; `pdf` is the file itself. */
export interface HeldDocument {
  /** the address as the user wrote it, so the same link is not fetched twice */
  readonly requested: string | null;
  readonly facts: Omit<DocumentFacts, 'fresh'>;
  readonly pdf: Uint8Array | null;
}

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gi;

/** The http(s) links in a message, in order, without repeats, at most `urlsPerTurn`. */
export function findUrls(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    let url = match[0];
    for (;;) {
      const last = url.at(-1) ?? '';
      const count = (char: string): number => url.split(char).length - 1;
      const unbalanced = last === ')' ? count(')') > count('(') : last === ']' ? count(']') > count('[') : last === '}';
      if (/[.,;:!?'"]/.test(last) || unbalanced) url = url.slice(0, -1);
      else break;
    }
    if (URL.canParse(url) && !found.includes(url)) found.push(url);
    if (found.length >= DOCUMENT_LIMITS.urlsPerTurn) break;
  }
  return found;
}

export function hostOf(url: string): string {
  return URL.canParse(url) ? new URL(url).hostname.replace(/^www\./, '') : url.slice(0, 40);
}
