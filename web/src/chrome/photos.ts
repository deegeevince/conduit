import { UPLOAD_LIMITS } from '@conduit/language';

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
export const PHOTO_RULES = `Up to ${UPLOAD_LIMITS.perTurn} photos, JPEG, PNG, WebP or HEIC, ${UPLOAD_LIMITS.bytes / 1_000_000} MB each.`;

const IMAGE_NAME = /\.(jpe?g|png|webp|heic|heif)$/i;

/** Whether a file looks like a photo the server might take; the server decides by the bytes. */
function plausible(file: File): boolean {
  if (file.type.startsWith('image/')) return true;
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
  drop.textContent = 'Drop photos to add them';
  drop.setAttribute('aria-hidden', 'true');
  document.body.append(drop);

  const held: Photo[] = [];
  let said = '';

  const show = (): void => {
    list.replaceChildren();
    held.forEach((photo, at) => {
      const item = document.createElement('li');
      item.className = `photo photo--${photo.state}`;
      const shown = photo.id === null ? photo.preview : (port.urlOf(photo.id) ?? photo.preview);
      if (shown !== null) {
        const image = document.createElement('img');
        image.className = 'photo__image';
        image.alt = `Photo ${at + 1}${photo.state === 'sending' ? ', sending' : photo.state === 'failed' ? ', not sent' : ''}`;
        image.src = shown;
        // a format this browser cannot draw (a HEIC): the box says what it is until the server's JPEG replaces it
        image.addEventListener('error', () => image.remove());
        item.append(image);
      }
      const label = document.createElement('span');
      label.className = 'photo__label';
      label.textContent = photo.state === 'sending' ? 'Sending' : photo.state === 'failed' ? 'Not sent' : '';
      item.append(label);
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

  const add = (files: readonly File[]): void => {
    const photos = files.filter(plausible);
    if (photos.length < files.length) say(`That is not a photo. ${PHOTO_RULES}`);
    else if (files.length > 0) said = '';
    for (const file of photos) {
      if (held.length >= UPLOAD_LIMITS.perTurn) {
        say(`That is ${UPLOAD_LIMITS.perTurn} photos already. ${PHOTO_RULES}`);
        break;
      }
      if (file.size > UPLOAD_LIMITS.bytes) {
        say(`That photo is ${(file.size / 1_000_000).toFixed(1)} MB. ${PHOTO_RULES}`);
        continue;
      }
      counter += 1;
      const photo: Photo = { key: counter, name: file.name, id: null, state: 'sending', preview: URL.createObjectURL(file) };
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
    busy: () => held.some((photo) => photo.state === 'sending'),
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
