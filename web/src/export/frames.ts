// A strip of stills as one file.

export interface ZipSink {
  add(name: string, bytes: Uint8Array): void;
  finish(): Blob;
}

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = (CRC_TABLE[(crc ^ (bytes[i] ?? 0)) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

interface Entry {
  readonly name: Uint8Array;
  readonly crc: number;
  readonly size: number;
  readonly offset: number;
}

const MAX_32 = 0xffffffff;

/** A zip written without compression (PNGs do not shrink): local headers, stored data, a central directory, CRC-32 computed here. No library. */
export function createZipSink(): ZipSink {
  const parts: BlobPart[] = [];
  const entries: Entry[] = [];
  const encoder = new TextEncoder();
  const stamp = new Date();
  const dosTime = ((stamp.getHours() << 11) | (stamp.getMinutes() << 5) | (stamp.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((Math.max(1980, stamp.getFullYear()) - 1980) << 9) | ((stamp.getMonth() + 1) << 5) | stamp.getDate()) & 0xffff;
  let offset = 0;
  let finished = false;

  const push = (bytes: Uint8Array): void => {
    parts.push(bytes as BlobPart);
    offset += bytes.length;
  };

  return {
    add(name, bytes) {
      if (finished) throw new Error('the zip is already finished');
      const nameBytes = encoder.encode(name);
      if (offset + bytes.length + nameBytes.length + 30 > MAX_32 || entries.length >= 0xfffe) throw new Error('too many frames for one zip file; export a shorter range');
      const crc = crc32(bytes);
      const header = new DataView(new ArrayBuffer(30));
      header.setUint32(0, 0x04034b50, true);
      header.setUint16(4, 20, true);
      header.setUint16(6, 0x0800, true);
      header.setUint16(8, 0, true);
      header.setUint16(10, dosTime, true);
      header.setUint16(12, dosDate, true);
      header.setUint32(14, crc, true);
      header.setUint32(18, bytes.length, true);
      header.setUint32(22, bytes.length, true);
      header.setUint16(26, nameBytes.length, true);
      header.setUint16(28, 0, true);
      entries.push({ name: nameBytes, crc, size: bytes.length, offset });
      push(new Uint8Array(header.buffer));
      push(nameBytes);
      // Held as a Blob so a long strip can live outside the page's heap.
      parts.push(new Blob([bytes as BlobPart]));
      offset += bytes.length;
    },
    finish() {
      finished = true;
      const directoryStart = offset;
      for (const entry of entries) {
        const record = new DataView(new ArrayBuffer(46));
        record.setUint32(0, 0x02014b50, true);
        record.setUint16(4, 20, true);
        record.setUint16(6, 20, true);
        record.setUint16(8, 0x0800, true);
        record.setUint16(10, 0, true);
        record.setUint16(12, dosTime, true);
        record.setUint16(14, dosDate, true);
        record.setUint32(16, entry.crc, true);
        record.setUint32(20, entry.size, true);
        record.setUint32(24, entry.size, true);
        record.setUint16(28, entry.name.length, true);
        record.setUint32(42, entry.offset, true);
        push(new Uint8Array(record.buffer));
        push(entry.name);
      }
      const end = new DataView(new ArrayBuffer(22));
      end.setUint32(0, 0x06054b50, true);
      end.setUint16(8, entries.length, true);
      end.setUint16(10, entries.length, true);
      end.setUint32(12, offset - directoryStart, true);
      end.setUint32(16, directoryStart, true);
      push(new Uint8Array(end.buffer));
      const blob = new Blob(parts, { type: 'application/zip' });
      parts.length = 0;
      return blob;
    },
  };
}
