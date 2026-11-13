// The only module that touches WebCodecs or a muxer.

import { ArrayBufferTarget, Muxer as Mp4Muxer } from 'mp4-muxer';
import { ArrayBufferTarget as WebmTarget, Muxer as WebmMuxer } from 'webm-muxer';

export interface VideoSink {
  /** `timestamp` in seconds on the film's clock; frames must be added in order */
  add(source: CanvasImageSource, timestamp: number): Promise<void>;
  finish(): Promise<Blob>;
  abort(): void;
}

interface Choice {
  readonly format: 'webm' | 'mp4';
  readonly codec: string;
  readonly muxerCodec: string;
}

const CANDIDATES: readonly Choice[] = [
  { format: 'webm', codec: 'vp09.00.40.08', muxerCodec: 'V_VP9' },
  { format: 'webm', codec: 'vp8', muxerCodec: 'V_VP8' },
  { format: 'mp4', codec: 'avc1.640034', muxerCodec: 'avc' },
  { format: 'mp4', codec: 'avc1.4d0033', muxerCodec: 'avc' },
  { format: 'mp4', codec: 'avc1.42001f', muxerCodec: 'avc' },
];

const QUEUE_LIMIT = 4;

function bitrate(width: number, height: number): number {
  return Math.round(8_000_000 * ((width * height) / (1920 * 1080)));
}

function encoderConfig(choice: Choice, width: number, height: number, fps: number): VideoEncoderConfig {
  return {
    codec: choice.codec,
    width,
    height,
    bitrate: Math.max(500_000, bitrate(width, height)),
    framerate: fps,
    bitrateMode: 'variable',
    latencyMode: 'quality',
    ...(choice.format === 'mp4' ? { avc: { format: 'avc' as const } } : {}),
  };
}

async function supported(choice: Choice, width: number, height: number, fps: number): Promise<boolean> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') return false;
  try {
    const result = await VideoEncoder.isConfigSupported(encoderConfig(choice, width, height, fps));
    return result.supported === true;
  } catch {
    return false;
  }
}

async function choose(format: 'webm' | 'mp4', width: number, height: number, fps: number): Promise<Choice | null> {
  for (const choice of CANDIDATES) {
    if (choice.format === format && (await supported(choice, width, height, fps))) return choice;
  }
  return null;
}

/** What this browser can encode: VP9 in WebM, H.264 in MP4, asked of `VideoEncoder.isConfigSupported`, never assumed. */
export async function videoFormats(): Promise<readonly ('webm' | 'mp4')[]> {
  const found: ('webm' | 'mp4')[] = [];
  for (const format of ['webm', 'mp4'] as const) {
    if ((await choose(format, 1280, 720, 30)) !== null) found.push(format);
  }
  return found;
}

/**
 * A constant-frame-rate encoder. Every frame is given its exact timestamp
 * (`n / fps`), a key frame every two seconds, and a bit rate that keeps flat
 * drawings and type clean: 8 Mbit/s at 1080p scaled by area. Back-pressure is
 * honoured (`encodeQueueSize`) so a long film does not exhaust memory.
 */
export async function createVideoSink(format: 'webm' | 'mp4', width: number, height: number, fps: number): Promise<VideoSink> {
  const evenWidth = width - (width % 2);
  const evenHeight = height - (height % 2);
  const choice = await choose(format, evenWidth, evenHeight, fps);
  if (choice === null) throw new Error(`This browser cannot encode ${format === 'webm' ? 'WebM' : 'MP4'} video at ${evenWidth}x${evenHeight}.`);

  const webm = choice.format === 'webm' ? new WebmTarget() : null;
  const mp4 = choice.format === 'mp4' ? new ArrayBufferTarget() : null;
  const webmMuxer =
    webm === null ? null : new WebmMuxer({ target: webm, video: { codec: choice.muxerCodec, width: evenWidth, height: evenHeight, frameRate: fps }, firstTimestampBehavior: 'offset' });
  const mp4Muxer =
    mp4 === null ? null : new Mp4Muxer({ target: mp4, video: { codec: 'avc', width: evenWidth, height: evenHeight, frameRate: fps }, fastStart: 'in-memory', firstTimestampBehavior: 'offset' });

  let failure: Error | null = null;
  let aborted = false;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (aborted) return;
      try {
        if (webmMuxer !== null) webmMuxer.addVideoChunk(chunk, meta);
        else if (mp4Muxer !== null) mp4Muxer.addVideoChunk(chunk, meta);
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
      }
    },
    error: (error) => {
      failure = error;
    },
  });
  encoder.configure(encoderConfig(choice, evenWidth, evenHeight, fps));

  const keyEvery = Math.max(1, Math.round(fps * 2));
  const frameMicros = 1_000_000 / fps;
  let count = 0;

  const drain = async (limit: number): Promise<void> => {
    while (encoder.encodeQueueSize > limit && failure === null && !aborted) {
      await new Promise<void>((resolve) => {
        encoder.addEventListener('dequeue', () => resolve(), { once: true });
        setTimeout(resolve, 50);
      });
    }
  };

  return {
    async add(source, timestamp) {
      if (aborted) throw new DOMException('Export cancelled', 'AbortError');
      if (failure !== null) throw failure;
      // The frame must be taken before the first await: a WebGL canvas is only guaranteed to hold this picture until the task ends.
      const frame = new VideoFrame(source, { timestamp: Math.round(timestamp * 1_000_000), duration: Math.round(frameMicros) });
      try {
        encoder.encode(frame, { keyFrame: count % keyEvery === 0 });
      } finally {
        frame.close();
      }
      count += 1;
      await drain(QUEUE_LIMIT - 1);
      if (failure !== null) throw failure;
    },
    async finish() {
      await encoder.flush();
      if (failure !== null) throw failure;
      encoder.close();
      if (webmMuxer !== null && webm !== null) {
        webmMuxer.finalize();
        return new Blob([webm.buffer], { type: 'video/webm' });
      }
      if (mp4Muxer !== null && mp4 !== null) {
        mp4Muxer.finalize();
        return new Blob([mp4.buffer], { type: 'video/mp4' });
      }
      throw new Error('no muxer');
    },
    abort() {
      aborted = true;
      if (encoder.state !== 'closed') encoder.close();
    },
  };
}
