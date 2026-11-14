// The only module that touches WebCodecs or a muxer.

import { ArrayBufferTarget, Muxer as Mp4Muxer } from 'mp4-muxer';
import { ArrayBufferTarget as WebmTarget, Muxer as WebmMuxer } from 'webm-muxer';

/** A sound track, rendered beforehand: mono floats from the film's first second. It is fed to the encoder as the video goes, so the file is interleaved. */
export interface SoundTrack {
  readonly samples: Float32Array<ArrayBuffer>;
  readonly sampleRate: number;
}

export interface VideoSink {
  /** whether the sound track given to `createVideoSink` is in the file: false when there was none, or this browser cannot encode it */
  readonly hasSound: boolean;
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
/** Sound is encoded this many seconds ahead of the video frame being added, and in pieces of a second, so the two tracks arrive at the muxer together. */
const SOUND_AHEAD = 2;
const SOUND_PIECE = 1;

interface SoundChoice {
  readonly codec: string;
  readonly muxerCodec: 'A_OPUS' | 'aac';
}

/** Opus in a WebM, AAC in an MP4, asked of `AudioEncoder.isConfigSupported`; null when this browser has no way to encode either. */
async function chooseSound(format: 'webm' | 'mp4', sampleRate: number): Promise<SoundChoice | null> {
  if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') return null;
  const choice: SoundChoice = format === 'webm' ? { codec: 'opus', muxerCodec: 'A_OPUS' } : { codec: 'mp4a.40.2', muxerCodec: 'aac' };
  try {
    const result = await AudioEncoder.isConfigSupported({ codec: choice.codec, sampleRate, numberOfChannels: 1, bitrate: 96_000 });
    return result.supported === true ? choice : null;
  } catch {
    return null;
  }
}

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
export async function createVideoSink(format: 'webm' | 'mp4', width: number, height: number, fps: number, sound?: SoundTrack | null): Promise<VideoSink> {
  const evenWidth = width - (width % 2);
  const evenHeight = height - (height % 2);
  const choice = await choose(format, evenWidth, evenHeight, fps);
  if (choice === null) throw new Error(`This browser cannot encode ${format === 'webm' ? 'WebM' : 'MP4'} video at ${evenWidth}x${evenHeight}.`);

  const soundChoice = sound === undefined || sound === null ? null : await chooseSound(format, sound.sampleRate);
  const audio = soundChoice === null || sound === undefined || sound === null ? null : { choice: soundChoice, track: sound };
  const webm = choice.format === 'webm' ? new WebmTarget() : null;
  const mp4 = choice.format === 'mp4' ? new ArrayBufferTarget() : null;
  const webmMuxer =
    webm === null ? null : new WebmMuxer({ target: webm, video: { codec: choice.muxerCodec, width: evenWidth, height: evenHeight, frameRate: fps }, ...(audio === null ? {} : { audio: { codec: 'A_OPUS' as const, numberOfChannels: 1, sampleRate: audio.track.sampleRate } }), firstTimestampBehavior: 'offset' });
  const mp4Muxer =
    mp4 === null ? null : new Mp4Muxer({ target: mp4, video: { codec: 'avc', width: evenWidth, height: evenHeight, frameRate: fps }, ...(audio === null ? {} : { audio: { codec: 'aac' as const, numberOfChannels: 1, sampleRate: audio.track.sampleRate } }), fastStart: 'in-memory', firstTimestampBehavior: 'offset' });

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

  const soundEncoder =
    audio === null
      ? null
      : new AudioEncoder({
          output: (chunk, meta) => {
            if (aborted) return;
            try {
              if (webmMuxer !== null) webmMuxer.addAudioChunk(chunk, meta);
              else if (mp4Muxer !== null) mp4Muxer.addAudioChunk(chunk, meta);
            } catch (error) {
              failure = error instanceof Error ? error : new Error(String(error));
            }
          },
          error: (error) => {
            failure = error;
          },
        });
  if (soundEncoder !== null && audio !== null) soundEncoder.configure({ codec: audio.choice.codec, sampleRate: audio.track.sampleRate, numberOfChannels: 1, bitrate: 96_000 });
  let soundDone = 0;
  /** Hands the encoder the sound up to `seconds` into the film, a piece at a time. */
  const feedSound = (seconds: number): void => {
    if (soundEncoder === null || audio === null) return;
    const { samples, sampleRate } = audio.track;
    const piece = Math.round(SOUND_PIECE * sampleRate);
    const until = Math.min(samples.length, Math.floor(seconds * sampleRate));
    while (soundDone < until) {
      const end = Math.min(until, soundDone + piece, samples.length);
      if (end - soundDone < 1) break;
      const data = new AudioData({ format: 'f32-planar', sampleRate, numberOfFrames: end - soundDone, numberOfChannels: 1, timestamp: Math.round((soundDone / sampleRate) * 1_000_000), data: samples.subarray(soundDone, end) });
      try {
        soundEncoder.encode(data);
      } finally {
        data.close();
      }
      soundDone = end;
    }
  };

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
    hasSound: audio !== null,
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
      feedSound(timestamp + SOUND_AHEAD);
      await drain(QUEUE_LIMIT - 1);
      if (failure !== null) throw failure;
    },
    async finish() {
      feedSound(Number.POSITIVE_INFINITY);
      await encoder.flush();
      if (soundEncoder !== null) {
        await soundEncoder.flush();
        soundEncoder.close();
      }
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
      if (soundEncoder !== null && soundEncoder.state !== 'closed') soundEncoder.close();
    },
  };
}
