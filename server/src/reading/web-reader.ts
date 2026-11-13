import { DOCUMENT_TEXT_CHARS } from '@conduit/language';
import type { DocumentReader, FetchOutcome, FetchTrace, ReadResult } from '../domain/documents';
import type { Logger } from '../log';
import { clampText, textOfHtml } from './html-text';
import { FetchFailure, safeFetch } from './safe-fetch';

const NOT_READABLE = 80;

function charsetOf(contentType: string | null, head: Buffer): string {
  const declared = /charset=["']?([\w-]+)/i.exec(contentType ?? '')?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(head.subarray(0, 2048).toString('latin1'))?.[1];
  return declared ?? 'utf-8';
}

function decode(body: Buffer, contentType: string | null): string {
  try {
    return new TextDecoder(charsetOf(contentType, body)).decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}

function looksLikeText(body: Buffer): boolean {
  return !body.subarray(0, 1024).includes(0);
}

type Kind = 'pdf' | 'html' | 'text' | null;

function kindOf(contentType: string | null, body: Buffer, url: string): Kind {
  const type = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (type === 'application/pdf' || body.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html';
  if (type.startsWith('text/') || type === 'application/json' || type === 'application/xml' || type === 'application/x-ndjson') return 'text';
  if ((type === '' || type === 'application/octet-stream') && looksLikeText(body)) return /\.(md|markdown|txt|csv|json)(\?|$)/i.test(url) ? 'text' : /<\s*(html|!doctype)/i.test(body.subarray(0, 512).toString('latin1')) ? 'html' : null;
  return null;
}

/** Reads links for the brain: a PDF whole, a page as its headings and paragraphs, text as it is. */
export function createDocumentReader(options: { readonly enabled: boolean; readonly log: Logger }): DocumentReader {
  const { log } = options;
  return {
    async read(url, signal): Promise<ReadResult> {
      const startedAt = Date.now();
      const trace = (outcome: FetchOutcome, extra: Partial<FetchTrace> = {}): FetchTrace => ({ url, finalUrl: null, status: null, contentType: null, bytes: 0, ms: Date.now() - startedAt, outcome, ...extra });
      if (!options.enabled) return { ok: false, trace: trace('disabled'), why: 'reading links is switched off on this server' };
      try {
        const fetched = await safeFetch(url, signal);
        const base = { finalUrl: fetched.finalUrl, status: fetched.status, contentType: fetched.contentType, bytes: fetched.body.length };
        const kind = kindOf(fetched.contentType, fetched.body, fetched.finalUrl);
        if (kind === null) {
          const type = (fetched.contentType ?? 'unknown type').split(';')[0] ?? 'unknown type';
          return { ok: false, trace: trace('unsupported', base), why: `it is a ${type} file, and only PDFs, web pages and text are read` };
        }
        if (kind === 'pdf') {
          return { ok: true, trace: trace('ok', base), kind: 'pdf', title: null, text: null, pdf: new Uint8Array(fetched.body), truncated: false };
        }
        const raw = decode(fetched.body, fetched.contentType);
        const page = kind === 'html' ? textOfHtml(raw) : { title: null, text: raw.trim() };
        if (page.text.length < NOT_READABLE) {
          return { ok: false, trace: trace('unsupported', base), why: 'the page has no readable text (it may be built by scripts, or sit behind a login)' };
        }
        const clamped = clampText(page.text, DOCUMENT_TEXT_CHARS);
        return { ok: true, trace: trace('ok', base), kind: 'text', title: page.title, text: clamped.text, pdf: null, truncated: clamped.truncated };
      } catch (error) {
        if (error instanceof FetchFailure) {
          return { ok: false, trace: trace(error.outcome, error.status === null ? {} : { status: error.status }), why: error.message };
        }
        log.warn('reading.failed', { url, error });
        return { ok: false, trace: trace('failed'), why: 'something went wrong while reading it' };
      }
    },
  };
}
