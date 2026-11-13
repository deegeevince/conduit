// A local stand-in for the OpenAI Images API, so that everything above the image port can be built and accepted
// without a key and without spending anything. Not part of the server.
// Usage: pnpm --filter @conduit/server exec tsx src/tools/image-stand-in.ts [--port 4390] [--delay N] [--fail] [--refuse]
//
// Answers POST /v1/images/generations (JSON) and POST /v1/images/edits (multipart) in the real API's shape,
// {"data":[{"b64_json":"..."}]}. The picture is made here with no model: the sketch it was sent, softened and
// recoloured, or with no sketch a flat gradient. It logs each request: endpoint, prompt, size, and whether an image
// was attached. Node built-ins only. Point the server at it with
// IMAGE_MODEL=openai OPENAI_API_KEY=stand-in OPENAI_BASE_URL=http://127.0.0.1:4390
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { deflateSync, inflateSync, crc32 } from 'node:zlib';

interface Raster {
  readonly width: number;
  readonly height: number;
  /** RGBA, 8 bits */
  readonly data: Uint8ClampedArray;
}

type Rgb = readonly [number, number, number];

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_BODY = 32 * 1024 * 1024;
const DEFAULT_PALETTE: readonly Rgb[] = [[34, 40, 58], [222, 128, 96], [244, 232, 208]];

function out(fields: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), source: 'image-stand-in', ...fields })}\n`);
}

function options(argv: readonly string[]): { port: number; delay: number; fail: boolean; refuse: boolean } {
  const result = { port: 4390, delay: 0, fail: false, refuse: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = Number(argv[i + 1]);
    if (flag === '--port' && Number.isInteger(next)) { result.port = next; i += 1; }
    else if (flag === '--delay' && Number.isFinite(next) && next >= 0) { result.delay = next; i += 1; }
    else if (flag === '--fail') result.fail = true;
    else if (flag === '--refuse') result.refuse = true;
  }
  return result;
}

function decodePng(bytes: Uint8Array): Raster | null {
  const buffer = Buffer.from(bytes);
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(SIGNATURE)) return null;
  let width = 0, height = 0, depth = 0, colour = 0, interlace = 0;
  let palette = Buffer.alloc(0);
  let alpha = Buffer.alloc(0);
  const parts: Buffer[] = [];
  let at = 8;
  while (at + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.toString('latin1', at + 4, at + 8);
    const chunk = buffer.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0); height = chunk.readUInt32BE(4);
      depth = chunk[8] ?? 0; colour = chunk[9] ?? 0; interlace = chunk[12] ?? 0;
    } else if (type === 'PLTE') palette = chunk;
    else if (type === 'tRNS') alpha = chunk;
    else if (type === 'IDAT') parts.push(chunk);
    else if (type === 'IEND') break;
    at += 12 + length;
  }
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number | undefined>)[colour];
  if (channels === undefined || interlace !== 0 || width < 1 || height < 1 || width * height > 16_000_000) return null;
  if (!(depth === 8 || depth === 16 || (colour === 3 && depth <= 8))) return null;
  const bitsPerPixel = channels * depth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  let raw: Buffer;
  try { raw = inflateSync(Buffer.concat(parts)); } catch { return null; }
  if (raw.length < (stride + 1) * height) return null;

  const lines = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)] ?? 0;
    const source = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= bpp ? lines[row + x - bpp] ?? 0 : 0;
      const up = y > 0 ? lines[row - stride + x] ?? 0 : 0;
      const upLeft = y > 0 && x >= bpp ? lines[row - stride + x - bpp] ?? 0 : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      } else if (filter !== 0) return null;
      lines[row + x] = ((raw[source + x] ?? 0) + predictor) & 255;
    }
  }

  const data = new Uint8ClampedArray(width * height * 4);
  const step = depth === 16 ? 2 : 1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      const base = y * stride;
      const sample = (channel: number): number => lines[base + (x * channels + channel) * step] ?? 0;
      if (colour === 3) {
        let index: number;
        if (depth === 8) index = lines[base + x] ?? 0;
        else {
          const bit = x * depth;
          index = ((lines[base + (bit >> 3)] ?? 0) >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
        }
        data[o] = palette[index * 3] ?? 0; data[o + 1] = palette[index * 3 + 1] ?? 0; data[o + 2] = palette[index * 3 + 2] ?? 0;
        data[o + 3] = alpha[index] ?? 255;
      } else if (colour === 0 || colour === 4) {
        const g = sample(0);
        data[o] = g; data[o + 1] = g; data[o + 2] = g; data[o + 3] = colour === 4 ? sample(1) : 255;
      } else {
        data[o] = sample(0); data[o + 1] = sample(1); data[o + 2] = sample(2); data[o + 3] = colour === 6 ? sample(3) : 255;
      }
    }
  }
  return { width, height, data };
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, tail]);
}

function encodePng(raster: Raster): Buffer {
  const { width, height, data } = raster;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      raw[row + 1 + x * 3] = data[i] ?? 0; raw[row + 2 + x * 3] = data[i + 1] ?? 0; raw[row + 3 + x * 3] = data[i + 2] ?? 0;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2;
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function paletteOf(prompt: string): Rgb[] {
  const found = [...prompt.matchAll(/#([0-9a-f]{6})\b/gi)].map((m): Rgb => {
    const hex = m[1] ?? '000000';
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  });
  return found.length > 0 ? found : [...DEFAULT_PALETTE];
}

function luma([r, g, b]: Rgb): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Dark to light through the palette, so luminance picks a colour from it. */
function ramp(colours: readonly Rgb[]): (t: number) => Rgb {
  const sorted = [...colours].sort((a, b) => luma(a) - luma(b));
  const first = sorted[0] ?? DEFAULT_PALETTE[0] as Rgb;
  if (sorted.length === 1) return () => first;
  return (t) => {
    const scaled = Math.min(0.9999, Math.max(0, t)) * (sorted.length - 1);
    const i = Math.floor(scaled);
    return mix(sorted[i] ?? first, sorted[i + 1] ?? first, scaled - i);
  };
}

function boxBlur(source: Raster, radius: number): Raster {
  const { width, height } = source;
  let from = source.data;
  for (const horizontal of [true, false, true, false]) {
    const to = new Uint8ClampedArray(from.length);
    const length = horizontal ? width : height;
    const lines = horizontal ? height : width;
    for (let line = 0; line < lines; line += 1) {
      const index = (k: number): number => (horizontal ? line * width + k : k * width + line) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        let sum = 0;
        for (let k = -radius; k <= radius; k += 1) sum += from[index(Math.min(length - 1, Math.max(0, k))) + channel] ?? 0;
        for (let k = 0; k < length; k += 1) {
          to[index(k) + channel] = sum / (2 * radius + 1);
          sum += (from[index(Math.min(length - 1, k + radius + 1)) + channel] ?? 0) - (from[index(Math.max(0, k - radius)) + channel] ?? 0);
        }
      }
    }
    from = to;
  }
  return { width, height, data: from };
}

/** A wash over the sketch: softened, its tones remapped into the palette, with the sketch's own colour kept faintly. */
function paintOver(sketch: Raster, colours: readonly Rgb[]): Raster {
  const soft = boxBlur(sketch, Math.max(2, Math.round(sketch.width / 120)));
  const toneOf = ramp(colours);
  const paper: Rgb = [255, 255, 255];
  const data = new Uint8ClampedArray(soft.data.length);
  for (let y = 0; y < soft.height; y += 1) {
    for (let x = 0; x < soft.width; x += 1) {
      const i = (y * soft.width + x) * 4;
      const covered = (soft.data[i + 3] ?? 255) / 255;
      const original = mix(paper, [soft.data[i] ?? 0, soft.data[i + 1] ?? 0, soft.data[i + 2] ?? 0], covered);
      const wash = (x / soft.width + y / soft.height) / 2;
      const grain = ((Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1) * 6;
      const toned = mix(toneOf(0.15 + 0.75 * (luma(original) / 255) + (wash - 0.5) * 0.2), original, 0.25);
      data[i] = toned[0] + grain; data[i + 1] = toned[1] + grain; data[i + 2] = toned[2] + grain; data[i + 3] = 255;
    }
  }
  return { width: soft.width, height: soft.height, data };
}

function gradient(width: number, height: number, colours: readonly Rgb[]): Raster {
  const toneOf = ramp(colours);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const tone = toneOf((x / width + y / height) / 2);
      data[i] = tone[0]; data[i + 1] = tone[1]; data[i + 2] = tone[2]; data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = [];
  let total = 0;
  for await (const part of request) {
    const piece = part as Buffer;
    total += piece.length;
    if (total > MAX_BODY) throw new Error('body too large');
    parts.push(piece);
  }
  return Buffer.concat(parts);
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  response.end(text);
}

interface Parsed {
  readonly prompt: string;
  readonly size: string;
  readonly sketch: Uint8Array | null;
}

async function parse(request: IncomingMessage, body: Buffer, edits: boolean): Promise<Parsed> {
  if (!edits) {
    const json: unknown = JSON.parse(body.toString('utf8'));
    const record = typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {};
    return { prompt: typeof record.prompt === 'string' ? record.prompt : '', size: typeof record.size === 'string' ? record.size : '1024x1024', sketch: null };
  }
  const form = await new Request('http://stand-in.invalid/', {
    method: 'POST',
    headers: { 'content-type': request.headers['content-type'] ?? '' },
    body,
  }).formData();
  const prompt = form.get('prompt');
  const size = form.get('size');
  const image = form.get('image');
  return {
    prompt: typeof prompt === 'string' ? prompt : '',
    size: typeof size === 'string' ? size : '1024x1024',
    sketch: image !== null && typeof image !== 'string' ? new Uint8Array(await image.arrayBuffer()) : null,
  };
}

const settings = options(process.argv.slice(2));

const server = createServer((request, response) => {
  void (async () => {
    const path = (request.url ?? '').split('?')[0];
    if (request.method !== 'POST' || (path !== '/v1/images/generations' && path !== '/v1/images/edits')) {
      send(response, 404, { error: { message: 'unknown route', type: 'invalid_request_error' } });
      return;
    }
    const edits = path === '/v1/images/edits';
    let finished = false;
    response.on('close', () => {
      if (!finished) out({ event: 'aborted', endpoint: path });
    });
    try {
      const parsed = await parse(request, await readBody(request), edits);
      const sketch = parsed.sketch === null ? null : decodePng(parsed.sketch);
      out({
        event: 'request',
        endpoint: path,
        prompt: parsed.prompt,
        size: parsed.size,
        image: parsed.sketch !== null,
        imageSize: sketch === null ? null : `${sketch.width}x${sketch.height}`,
        imageBytes: parsed.sketch?.length ?? 0,
        mode: settings.refuse ? 'refuse' : settings.fail ? 'fail' : sketch !== null ? 'sketch' : 'gradient',
      });
      if (settings.delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, settings.delay * 1000));
      if (response.destroyed) return;
      finished = true;
      if (settings.refuse) {
        send(response, 400, { error: { message: 'Your request was rejected by the safety system (stand-in).', type: 'image_generation_user_error', code: 'content_policy_violation' } });
        return;
      }
      if (settings.fail) {
        send(response, 500, { error: { message: 'The stand-in server had an error while processing your request.', type: 'server_error', code: null } });
        return;
      }
      const colours = paletteOf(parsed.prompt);
      let picture: Raster;
      if (sketch !== null) picture = paintOver(sketch, colours);
      else {
        const [w, h] = parsed.size.split('x').map((n) => Number(n));
        picture = gradient(Math.round((w ?? 1024) / 4), Math.round((h ?? 1024) / 4), colours);
      }
      const png = encodePng(picture);
      send(response, 200, {
        created: Math.floor(Date.now() / 1000),
        data: [{ b64_json: png.toString('base64') }],
        usage: { total_tokens: 0, input_tokens: 0, output_tokens: 0 },
      });
    } catch (error) {
      finished = true;
      out({ event: 'bad-request', endpoint: path, message: error instanceof Error ? error.message : String(error) });
      send(response, 400, { error: { message: 'could not read the request', type: 'invalid_request_error' } });
    }
  })();
});

server.listen(settings.port, '127.0.0.1', () => {
  out({ event: 'listening', port: settings.port, delay: settings.delay, fail: settings.fail, refuse: settings.refuse });
});
