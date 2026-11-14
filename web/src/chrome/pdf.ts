// A PDF given to the composer: each page (the first PDF_PAGES) is drawn to a JPEG in the page and goes the photo way, and each page's text layer is read
// so the brain can quote exact words. PDF.js (Apache-2.0, pinned in web/package.json) is its own lazy chunk, loaded when the first PDF comes, and
// its worker is a file of this same origin (Vite gives it a hashed name). Nothing is fetched for a PDF: the bytes are handed over, and what the file
// refers to (links, remote images, fonts, other files) is never followed.
//
// What is switched off, and why: no XFA forms (`enableXfa: false`), no range or streamed
// fetching (`disableRange`, `disableStream`, `disableAutoFetch`), no worker-side fetch (`useWorkerFetch: false`). This PDF.js version has no `eval`/`new Function` path at all (its `isEvalSupported` option is gone; checked in the built files). PDF.js's own scripting engine is a
// separate sandbox that only its viewer starts (`pdf.sandbox.mjs`); this file never loads it, so a PDF's JavaScript has nothing to run in.

import { UPLOAD_LIMITS } from '@conduit/language';

/** The most pages of one PDF that are taken. */
export const PDF_PAGES = 10;
/** The longest side a page is drawn at, in pixels: readable text for the brain, well under what a photo is kept at. */
const PAGE_SIDE = 1800;

export interface PdfPage {
  readonly n: number;
  /** the page as a JPEG, named for the file and page */
  readonly image: File;
  readonly text: string;
}

export interface PdfRead {
  readonly name: string;
  /** how many pages the file has */
  readonly total: number;
  /** the pages that were taken, in order: the first `PDF_PAGES` */
  readonly pages: readonly PdfPage[];
}

/** Whether a file says it is a PDF (by type, or by name when the type is empty). */
export function isPdf(file: File): boolean {
  return file.type === 'application/pdf' || (file.type === '' && /\.pdf$/i.test(file.name));
}

/** A reason a person can read, for a PDF that could not be opened. */
export class PdfProblem extends Error {}

async function engine(): Promise<typeof import('pdfjs-dist')> {
  const [pdfjs, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return pdfjs;
}

/** The text of a page as lines: PDF.js says where a line ends. */
function lines(items: readonly unknown[]): string {
  let out = '';
  for (const item of items) {
    if (typeof item !== 'object' || item === null || !('str' in item)) continue;
    const { str, hasEOL } = item as { str: string; hasEOL?: boolean };
    out += str;
    if (hasEOL === true) out += '\n';
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Opens a PDF and draws its first pages. Resolves with the pages, rejects with a `PdfProblem` whose message is a sentence for the person.
 */
export async function readPdf(file: File): Promise<PdfRead> {
  const pdfjs = await engine();
  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjs.getDocument({
    data,
    enableXfa: false,
    disableRange: true,
    disableStream: true,
    disableAutoFetch: true,
    useWorkerFetch: false,
    useSystemFonts: true,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  });
  let doc;
  try {
    doc = await task.promise;
  } catch (cause) {
    const named = cause instanceof Error ? cause.name : '';
    if (named === 'PasswordException') throw new PdfProblem('That PDF is locked with a password, so it cannot be read.');
    throw new PdfProblem('That PDF could not be opened. It may be damaged.');
  }
  try {
    const stem = file.name.replace(/\.pdf$/i, '') || 'document';
    const pages: PdfPage[] = [];
    for (let n = 1; n <= Math.min(doc.numPages, PDF_PAGES); n += 1) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(3, PAGE_SIDE / Math.max(base.width, base.height)) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      await page.render({ canvas, viewport, background: '#ffffff' }).promise;
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88));
      canvas.width = 0;
      if (blob === null) throw new PdfProblem('A page of that PDF could not be drawn.');
      const text = lines((await page.getTextContent()).items);
      page.cleanup();
      pages.push({ n, image: new File([blob], `${stem} p${n}.jpg`, { type: 'image/jpeg' }), text });
    }
    return { name: file.name, total: doc.numPages, pages };
  } finally {
    await doc.destroy();
  }
}

/** The words for a PDF with more pages than are taken. */
export function pdfCapNote(name: string, total: number): string {
  return `${name} has ${total} pages. I took the first ${PDF_PAGES}; the rest were left out.`;
}

/** Whether a PDF is too large to open here. */
export const PDF_BYTES = UPLOAD_LIMITS.bytes * 3;
