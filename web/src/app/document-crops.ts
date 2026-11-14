// A question's own picture: the part of the photo it was read from (`crop=x,y,w,h` in whole percents, `from=` the photo), cut in the page and given to
// the lesson as a data: address (the sandbox may show nothing else). She cannot see the original sheet, so the lesson draws this above every
// question, always. A photo belongs to the session that took it, so a cut is also kept in this browser (small JPEGs) for the sessions that open the
// document again; where there is neither the photo nor a kept cut, the question's words stand alone.

import { API } from '@conduit/language';
import type { Document, NodeId } from '@conduit/language';

const MAX_SIDE = 900;

function load(url: string): Promise<HTMLImageElement | null> {
  return new Promise((done) => {
    const image = new Image();
    image.onload = () => done(image);
    image.onerror = () => done(null);
    image.src = url;
  });
}

/** The cut the server kept with the document, as a data: address; null when it has none (yet). */
async function serverCut(document: string, node: string): Promise<string | null> {
  try {
    const response = await fetch(API.documentCrop(document, node));
    if (!response.ok) return null;
    const blob = await response.blob();
    return await new Promise<string | null>((done) => {
      const reader = new FileReader();
      reader.onload = () => done(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => done(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

export interface Crops {
  /** the cuts there are now, by node; starts any that are missing and calls `changed` when one arrives */
  of(doc: Document): Readonly<Record<NodeId, string>>;
}

export function createCrops(photoUrl: (id: string) => string | null, changed: () => void): Crops {
  const have = new Map<string, string>();
  const trying = new Set<string>();
  /** when a cut was last asked for, so a document drawn again and again does not ask for every missing one every time */
  const asked = new Map<string, number>();
  const keyOf = (doc: Document, node: NodeId, c: { x: number; y: number; w: number; h: number; from?: string }): string => `conduit.crop.${doc.id}.${node}.${c.x},${c.y},${c.w},${c.h}.${c.from ?? ''}`;
  return {
    of(doc) {
      const out: Record<NodeId, string> = {};
      for (const node of Object.values(doc.nodes)) {
        const crop = node.crop;
        if (crop === undefined) continue;
        const key = keyOf(doc, node.id, crop);
        let url = have.get(key);
        if (url === undefined) {
          try {
            url = window.localStorage.getItem(key) ?? undefined;
          } catch {
            url = undefined;
          }
          if (url !== undefined) have.set(key, url);
        }
        if (url !== undefined) {
          out[node.id] = url;
          continue;
        }
        if (trying.has(key) || Date.now() - (asked.get(key) ?? 0) < 4000) continue;
        asked.set(key, Date.now());
        trying.add(key);
        void (async () => {
          const keep = (made: string): void => {
            have.set(key, made);
            try {
              window.localStorage.setItem(key, made);
            } catch {
              // a full or blocked store: the cut is still drawn this session
            }
            trying.delete(key);
            changed();
          };
          // the server's cut, kept with the document, is the same on every device; the page's own cut from the session's photo is the way until it is there
          const kept = await serverCut(doc.id, node.id);
          if (kept !== null) return keep(kept);
          const src = photoUrl(crop.from ?? 'u1');
          const image = src === null ? null : await load(src);
          if (image === null || image.naturalWidth === 0) {
            // not there yet (the server is cutting it): asked again the next time the document is drawn
            trying.delete(key);
            return;
          }
          const sx = (crop.x / 100) * image.naturalWidth;
          const sy = (crop.y / 100) * image.naturalHeight;
          const sw = Math.max(1, (crop.w / 100) * image.naturalWidth);
          const sh = Math.max(1, (crop.h / 100) * image.naturalHeight);
          const scale = Math.min(1, MAX_SIDE / Math.max(sw, sh));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(sw * scale));
          canvas.height = Math.max(1, Math.round(sh * scale));
          canvas.getContext('2d')?.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
          keep(canvas.toDataURL('image/jpeg', 0.85));
        })();
      }
      return out;
    },
  };
}
