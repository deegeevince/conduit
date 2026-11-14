// A PDF of pictures: one page for each, no library.
//
// A page is one JPEG, drawn full bleed in a page that is the picture's own shape. That is all a deck needs from a PDF
// (one slide a page, to print or to send), and it is a small, closed format: a catalogue, a page tree, and for each
// page a page object, a content stream that places its image, and the image itself with its DCT-encoded bytes left as
// they are. The cross-reference table is written with the true byte offset of every object.

export interface PdfSink {
  /** Adds a page: `jpeg` is a baseline or progressive JPEG file; the page is the shape of the picture the file says it is. */
  add(jpeg: Uint8Array): void;
  finish(): Blob;
}

/** One CSS pixel is 0.75 pt, so a 1280x720 stage is the 960x540 pt of a widescreen slide. */
const POINTS_PER_PIXEL = 0.75;

const encoder = new TextEncoder();

const text = (value: string): Uint8Array => encoder.encode(value);

const number = (value: number): string => String(Math.round(value * 100) / 100);

interface Page {
  readonly jpeg: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/** The size a JPEG file says it is, from its start-of-frame marker; null when it cannot be read. */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) {
      at += 1;
      continue;
    }
    const marker = bytes[at + 1] ?? 0;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    // markers without a length
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    const length = ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0);
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) return { height: ((bytes[at + 5] ?? 0) << 8) | (bytes[at + 6] ?? 0), width: ((bytes[at + 7] ?? 0) << 8) | (bytes[at + 8] ?? 0) };
    at += 2 + length;
  }
  return null;
}

export function createPdfSink(): PdfSink {
  const pages: Page[] = [];
  let finished = false;
  return {
    add(jpeg) {
      if (finished) throw new Error('the PDF is already finished');
      const said = jpegSize(jpeg);
      if (said === null) throw new Error('a page of the PDF is not a JPEG');
      pages.push({ jpeg, width: said.width, height: said.height });
    },
    finish() {
      finished = true;
      if (pages.length === 0) throw new Error('a PDF needs at least one page');
      // Object numbers: 1 catalogue, 2 page tree, then for page i: 3 + 3i the page, 4 + 3i its contents, 5 + 3i its image.
      const parts: Uint8Array[] = [];
      const offsets: number[] = [];
      let length = 0;
      const push = (bytes: Uint8Array): void => {
        parts.push(bytes);
        length += bytes.length;
      };
      const object = (id: number, body: readonly Uint8Array[]): void => {
        offsets[id] = length;
        push(text(`${id} 0 obj\n`));
        for (const piece of body) push(piece);
        push(text('\nendobj\n'));
      };
      push(text('%PDF-1.4\n%âãÏÓ\n'));
      object(1, [text('<< /Type /Catalog /Pages 2 0 R >>')]);
      object(2, [text(`<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${3 + 3 * i} 0 R`).join(' ')}] >>`)]);
      pages.forEach((page, i) => {
        const w = page.width * POINTS_PER_PIXEL;
        const h = page.height * POINTS_PER_PIXEL;
        const base = 3 + 3 * i;
        object(base, [text(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${number(w)} ${number(h)}] /Resources << /XObject << /Im0 ${base + 2} 0 R >> >> /Contents ${base + 1} 0 R >>`)]);
        const content = text(`q ${number(w)} 0 0 ${number(h)} 0 0 cm /Im0 Do Q`);
        object(base + 1, [text(`<< /Length ${content.length} >>\nstream\n`), content, text('\nendstream')]);
        object(base + 2, [text(`<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`), page.jpeg, text('\nendstream')]);
      });
      const count = 3 + 3 * pages.length;
      const table = length;
      push(text(`xref\n0 ${count}\n0000000000 65535 f \n`));
      for (let id = 1; id < count; id += 1) push(text(`${String(offsets[id] ?? 0).padStart(10, '0')} 00000 n \n`));
      push(text(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${table}\n%%EOF\n`));
      return new Blob(parts as BlobPart[], { type: 'application/pdf' });
    },
  };
}
