// Pictures kept on disk, outside the repository. A picture is two files: `<key>.jpg` and `<key>.json` (its credit and size).

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Picture, PictureCredit } from '../domain/pictures';
import { aspectWord } from '../domain/pictures';
import { sniff } from './image';

/** The same words in a box of the same shape are the same picture. */
export function pictureKey(words: string, aspect: number | null): string {
  return createHash('sha256').update(`${words}\n${aspectWord(aspect) ?? 'any'}`).digest('hex').slice(0, 24);
}

export const KEY_PATTERN = /^[0-9a-f]{24}$/;

export interface PictureStore {
  read(key: string): Promise<Picture | null>;
  write(picture: Picture): Promise<void>;
}

interface Meta {
  readonly credit: PictureCredit;
  readonly width: number;
  readonly height: number;
}

export function createDiskStore(dir: string): PictureStore {
  return {
    async read(key) {
      if (!KEY_PATTERN.test(key)) return null;
      try {
        const bytes = new Uint8Array(await readFile(join(dir, `${key}.jpg`)));
        const meta = JSON.parse(await readFile(join(dir, `${key}.json`), 'utf8')) as Meta;
        const seen = sniff(bytes);
        if (seen === null || seen.format !== 'jpeg' || !meta.credit) return null;
        return { key, mime: 'image/jpeg', bytes, width: seen.width, height: seen.height, credit: meta.credit };
      } catch {
        return null;
      }
    },
    async write(picture) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const meta: Meta = { credit: picture.credit, width: picture.width, height: picture.height };
      // The credit lands first and the picture last, through a rename, so a picture on disk always has its credit.
      await writeFile(join(dir, `${picture.key}.json`), JSON.stringify(meta));
      const temp = join(dir, `${picture.key}.jpg.part`);
      await writeFile(temp, picture.bytes, { mode: 0o600 });
      await rename(temp, join(dir, `${picture.key}.jpg`));
    },
  };
}
