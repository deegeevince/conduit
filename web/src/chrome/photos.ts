import { SOURCE_LIMITS, UPLOAD_LIMITS } from '@conduit/language';
import type { TurnSource } from '@conduit/language';
import { PDF_BYTES, PdfProblem, isPdf, pdfCapNote, readPdf } from './pdf';

/** What the prompt bar needs from the app to take a photo: send it to the server, and show it back by its id. */
export interface PhotoPort {
  /** sends the photo; resolves with the id the server gave it, rejects with a sentence a person can read */
  upload(photo: File): Promise<string>;
  /** where the kept photo is (what the brain is shown), or null before there is a conversation */
  urlOf(id: string): string | null;
}

/** A photo the person has added and not yet sent. */
export interface Photo {
  readonly key: number;
  readonly name: string;
  /** the id the server gave it, once it has */
  id: string | null;
  state: 'sending' | 'ready' | 'failed';
  /** a picture of the file itself until the server's own can be shown (a HEIC cannot be shown by most browsers: it waits for the server's) */
  preview: string | null;
  /** a page of a PDF: which file, which page, and the words on it */
  readonly page?: { readonly file: string; readonly n: number; readonly text: string };
}

/** What the held photos that are pages of PDFs say, grouped by file, for `TurnInput.sources`: the text of each page and the picture it went as. */
export function sourcesOf(held: readonly Photo[]): TurnSource[] {
  const files = new Map<string, { n: number; text: string; image?: string }[]>();
  for (const photo of held) {
    if (photo.page === undefined || photo.state !== 'ready' || photo.id === null) continue;
    const pages = files.get(photo.page.file) ?? [];
    pages.push({ n: photo.page.n, text: photo.page.text, image: photo.id });
    files.set(photo.page.file, pages);
  }
  // one budget for all the words of all the pages, shared evenly (a page that needs less leaves its share to the others)
  const count = [...files.values()].reduce((sum, pages) => sum + pages.length, 0);
  let left: number = SOURCE_LIMITS.chars;
  let remaining = count;
  const out: TurnSource[] = [];
  for (const [name, pages] of [...files].slice(0, SOURCE_LIMITS.files)) {
    out.push({
      name,
      pages: pages.map((page) => {
        const share = Math.min(SOURCE_LIMITS.pageChars, Math.floor(left / Math.max(1, remaining)));
        remaining -= 1;
        const text = page.text.length > share ? `${page.text.slice(0, Math.max(0, share - 1))}…` : page.text;
        left -= text.length;
        return { ...page, text };
      }),
    });
  }
  return out;
}

export interface PhotoTray {
  /** the ids of the photos that are ready, in the order they were added */
  ids(): string[];
  /** true while any photo is still being sent */
  busy(): boolean;
  /** what is held, for putting back if the turn is not accepted */
  held(): readonly Photo[];
  /** empties the tray without forgetting the photos on the server; they went with the turn */
  clear(): void;
  /** puts photos that were not sent back */
  putBack(photos: readonly Photo[]): void;
  /** says something in the tray's own line (a refusal, a wait); '' clears it */
  say(text: string): void;
  add(files: readonly File[]): void;
  dispose(): void;
}

/** The limits, in the words a person reads: said by the tray when it holds photos and by every refusal. */
export const PHOTO_RULES = `Up to ${UPLOAD_LIMITS.perTurn} photos or PDF pages, JPEG, PNG, WebP, HEIC or PDF, ${UPLOAD_LIMITS.bytes / 1_000_000} MB each, a PDF up to ${PDF_BYTES / 1_000_000} MB.`;

const IMAGE_NAME = /\.(jpe?g|png|webp|heic|heif)$/i;

/** Whether a file looks like a photo the server might take; the server decides by the bytes. */
function plausible(file: File): boolean {
  if (file.type.startsWith('image/') || isPdf(file)) return true;
  return file.type === '' && IMAGE_NAME.test(file.name);
}

let counter = 0;

/**
 * The strip of thumbnails above the field: each photo is sent as soon as it is added (so a refusal comes at once, not after the words),
 * shows what the server kept, and has its own remove button. Paste and drop are heard on the whole page.
 */
export function mountPhotoTray(before: HTMLElement, port: PhotoPort, onChange: () => void): PhotoTray {
  const tray = document.createElement('div');
  tray.className = 'prompt__photos';
  tray.hidden = true;
  tray.innerHTML = `
    <ul class="photos" aria-label="Photos to send"></ul>
    <p class="photos__note" role="status"></p>`;
  before.before(tray);
  const list = tray.querySelector<HTMLUListElement>('.photos');
  const note = tray.querySelector<HTMLElement>('.photos__note');
  if (list === null || note === null) throw new Error('The photo tray could not be built.');

  const drop = document.createElement('div');
  drop.className = 'photos__drop';
  drop.hidden = true;
  drop.textContent = 'Drop photos or PDFs to add them';
  drop.setAttribute('aria-hidden', 'true');
  document.body.append(drop);

  const held: Photo[] = [];
  let said = '';
  /** PDFs being opened: the tray is busy until their pages are in it */
  let reading = 0;

  const show = (): void => {
    list.replaceChildren();
    held.forEach((photo, at) => {
      const item = document.createElement('li');
      item.className = `photo photo--${photo.state}${photo.page === undefined ? '' : ' photo--page'}`;
      const shown = photo.id === null ? photo.preview : (port.urlOf(photo.id) ?? photo.preview);
      if (shown !== null) {
        const image = document.createElement('img');
        image.className = 'photo__image';
        image.alt = `${photo.page === undefined ? `Photo ${at + 1}` : `Page ${photo.page.n} of ${photo.page.file}`}${photo.state === 'sending' ? ', sending' : photo.state === 'failed' ? ', not sent' : ''}`;
        image.src = shown;
        // a format this browser cannot draw (a HEIC): the box says what it is until the server's JPEG replaces it
        image.addEventListener('error', () => image.remove());
        item.append(image);
      }
      const label = document.createElement('span');
      label.className = 'photo__label';
      label.textContent = photo.state === 'sending' ? 'Sending' : photo.state === 'failed' ? 'Not sent' : '';
      item.append(label);
      if (photo.page !== undefined) {
        const tag = document.createElement('span');
        tag.className = 'photo__tag';
        tag.textContent = `p${photo.page.n}`;
        item.title = `${photo.page.file}, page ${photo.page.n}`;
        item.append(tag);
      }
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'photo__remove';
      remove.setAttribute('aria-label', `Remove photo ${at + 1}`);
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        const place = held.indexOf(photo);
        if (place >= 0) held.splice(place, 1);
        release(photo);
        show();
        onChange();
      });
      item.append(remove);
      list.append(item);
    });
    tray.hidden = held.length === 0 && said === '';
    note.textContent = said !== '' ? said : held.length > 0 ? PHOTO_RULES : '';
    note.classList.toggle('photos__note--problem', said !== '');
  };

  const release = (photo: Photo): void => {
    if (photo.preview !== null) URL.revokeObjectURL(photo.preview);
    photo.preview = null;
  };

  const say = (text: string): void => {
    said = text;
    show();
  };

  /** Sends one picture; false when the tray has no room for it (and says so). */
  const send = (file: File, page?: Photo['page']): boolean => {
    if (held.length >= UPLOAD_LIMITS.perTurn) {
      say(`That is ${UPLOAD_LIMITS.perTurn} photos already. ${PHOTO_RULES}`);
      return false;
    }
    if (file.size > UPLOAD_LIMITS.bytes) {
      say(`That photo is ${(file.size / 1_000_000).toFixed(1)} MB. ${PHOTO_RULES}`);
      return true;
    }
    counter += 1;
    const photo: Photo = { key: counter, name: file.name, id: null, state: 'sending', preview: URL.createObjectURL(file), ...(page === undefined ? {} : { page }) };
    held.push(photo);
    port.upload(file).then(
      (id) => {
        photo.id = id;
        photo.state = 'ready';
        show();
        onChange();
      },
      (cause: unknown) => {
        const place = held.indexOf(photo);
        if (place >= 0) held.splice(place, 1);
        release(photo);
        say(`${cause instanceof Error ? cause.message : 'The photo could not be sent.'}`);
        onChange();
      },
    );
    return true;
  };

  /** A PDF: its first pages are drawn and go as photos, with their words kept beside them. */
  const addPdf = async (file: File): Promise<void> => {
    if (file.size > PDF_BYTES) {
      say(`That PDF is ${(file.size / 1_000_000).toFixed(1)} MB. ${PHOTO_RULES}`);
      return;
    }
    reading += 1;
    say(`Reading ${file.name}…`);
    onChange();
    try {
      const read = await readPdf(file);
      const room = UPLOAD_LIMITS.perTurn - held.length;
      if (room <= 0) {
        say(`That is ${UPLOAD_LIMITS.perTurn} photos already. ${PHOTO_RULES}`);
        return;
      }
      for (const page of read.pages.slice(0, room)) send(page.image, { file: read.name, n: page.n, text: page.text });
      const taken = Math.min(room, read.pages.length);
      say(taken < read.pages.length ? `${read.name} has ${read.total} pages. There was room for the first ${taken}.` : read.total > read.pages.length ? pdfCapNote(read.name, read.total) : '');
    } catch (cause) {
      say(cause instanceof PdfProblem ? cause.message : 'That PDF could not be read.');
    } finally {
      reading -= 1;
      show();
      onChange();
    }
  };

  const add = (files: readonly File[]): void => {
    const photos = files.filter(plausible);
    if (photos.length < files.length) say(`That is not a photo or a PDF. ${PHOTO_RULES}`);
    else if (files.length > 0) said = '';
    for (const file of photos) {
      if (isPdf(file)) void addPdf(file);
      else if (!send(file)) break;
    }
    show();
    onChange();
  };

  const imagesIn = (list: FileList | null | undefined): File[] => (list === null || list === undefined ? [] : [...list].filter(plausible));

  const onPaste = (event: ClipboardEvent): void => {
    const files = imagesIn(event.clipboardData?.files);
    if (files.length === 0 || document.querySelector('dialog[open]') !== null) return;
    // words pasted along with the picture are the person's text: leave them to the field
    if ((event.clipboardData?.getData('text/plain') ?? '') !== '') return;
    event.preventDefault();
    add(files);
  };

  let depth = 0;
  const carriesFiles = (event: DragEvent): boolean => event.dataTransfer?.types.includes('Files') === true;
  const onDragEnter = (event: DragEvent): void => {
    if (!carriesFiles(event)) return;
    depth += 1;
    drop.hidden = false;
  };
  const onDragOver = (event: DragEvent): void => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = (event: DragEvent): void => {
    if (!carriesFiles(event)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) drop.hidden = true;
  };
  const onDrop = (event: DragEvent): void => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    depth = 0;
    drop.hidden = true;
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length > 0) add(files);
  };
  document.addEventListener('paste', onPaste);
  document.addEventListener('dragenter', onDragEnter);
  document.addEventListener('dragover', onDragOver);
  document.addEventListener('dragleave', onDragLeave);
  document.addEventListener('drop', onDrop);

  return {
    ids: () => held.flatMap((photo) => (photo.state === 'ready' && photo.id !== null ? [photo.id] : [])),
    busy: () => reading > 0 || held.some((photo) => photo.state === 'sending'),
    held: () => [...held],
    clear() {
      for (const photo of held) release(photo);
      held.length = 0;
      said = '';
      show();
    },
    putBack(photos) {
      held.splice(0, held.length, ...photos);
      show();
      onChange();
    },
    say,
    add,
    dispose() {
      document.removeEventListener('paste', onPaste);
      document.removeEventListener('dragenter', onDragEnter);
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('dragleave', onDragLeave);
      document.removeEventListener('drop', onDrop);
      for (const photo of held) release(photo);
      drop.remove();
      tray.remove();
    },
  };
}
