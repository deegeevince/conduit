// The recogniser: Apple's Speech framework, on the device, through a small helper built from `ops/transcribe/transcribe.swift`.
//
// The helper is compiled with `swiftc` the first time it is wanted (and again only when its source changes) into
// `<DATA_DIR>/cache/voice/<hash>/Conduit Voice.app`. It is a small app bundle, not a bare executable, for one reason: macOS shows the
// Speech Recognition permission dialog for the *responsible* app, and a program started by a terminal or by this server answers to that
// terminal or to `node`, neither of which says what it wants the microphone-adjacent permission for (the system then kills the helper).
// Started through LaunchServices (`open`), the helper is its own app with its own line in System Settings > Privacy & Security > Speech
// Recognition, "Conduit Voice". Its answer comes back in a file, because `open` has no stdout to give.
//
// Nothing is downloaded and nothing is installed: `swiftc` is Apple's (Xcode or the Command Line Tools). Without it, or off a Mac, voice is
// reported as unavailable, and docs/voice.md says how to use `whisper.cpp` instead (not built here).

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from '../errors';
import type { Logger } from '../log';
import type { HelperStatus, Reading, Transcriber } from '../domain/voice';

const SOURCE_DIR = fileURLToPath(new URL('../../../ops/transcribe/', import.meta.url));
const BUNDLE = 'Conduit Voice.app';

export interface HelperDeps {
  /** where the compiled helper is kept: `<DATA_DIR>/cache/voice` */
  readonly cacheDir: string;
  /** where each answer file is made, owner-only: `<DATA_DIR>/voice/work` */
  readonly workDir: string;
  readonly log: Logger;
  /**
   * `VOICE_COMMAND`: the owner's own recogniser in place of Apple's, speaking the helper's protocol (`status`, and `run <file> [--locale L] [--max S]`,
   * each printing one JSON line, or writing it to the file after `--out`). This is how `whisper.cpp` is used: a small script the owner writes
   * round their own install. Conduit never downloads or installs one.
   */
  readonly command?: string | null;
}

function run(file: string, args: readonly string[], timeoutMs: number): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], { timeout: timeoutMs, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      if (error !== null && (error as { code?: unknown }).code === 'ENOENT') return reject(error);
      const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : null;
      resolve({ code, stdout, stderr });
    });
  });
}

const unavailable = (message: string, cause?: unknown): AppError => new AppError('voice_unavailable', 503, message, { cause });

/** The recogniser, and the one thing only the owner's own tool does: ask macOS for permission (a dialog on this Mac's screen that they must click). */
export interface AppleTranscriber extends Transcriber {
  authorize(locale: string | null, waitSeconds: number): Promise<HelperStatus>;
}

export function createAppleTranscriber(deps: HelperDeps): AppleTranscriber {
  let building: Promise<string> | null = null;
  let broken: string | null = null;

  /** The app bundle, built if it is not there yet. Throws `voice_unavailable` with the reason when it cannot be. */
  async function bundle(): Promise<string> {
    if (process.platform !== 'darwin') throw unavailable('Voice notes are read with Apple\'s on-device speech recogniser, which only a Mac has.');
    if (broken !== null) throw unavailable(broken);
    building ??= build().catch((cause: unknown) => {
      building = null;
      throw cause;
    });
    return building;
  }

  async function build(): Promise<string> {
    const swift = await readFile(join(SOURCE_DIR, 'transcribe.swift'));
    const plist = await readFile(join(SOURCE_DIR, 'Info.plist'));
    const hash = createHash('sha256').update(swift).update(plist).digest('hex').slice(0, 12);
    const app = join(deps.cacheDir, hash, BUNDLE);
    const exe = join(app, 'Contents', 'MacOS', 'transcribe');
    try {
      await stat(exe);
      return app;
    } catch {
      // not built yet
    }
    // `xcrun swiftc` (not the path `xcrun --find` prints) so the compiler is given the SDK it needs.
    const found = await run('/usr/bin/xcrun', ['--find', 'swiftc'], 20_000).catch(() => null);
    if (found === null || found.code !== 0 || found.stdout.trim() === '') {
      broken = 'Swift is not installed on this Mac (swiftc was not found), so voice notes cannot be read here. Install the Command Line Tools with `xcode-select --install`, or see docs/voice.md for whisper.cpp.';
      throw unavailable(broken);
    }
    deps.log.info('voice.building', { note: 'compiling the on-device speech helper, once', hash });
    await mkdir(deps.cacheDir, { recursive: true, mode: 0o700 });
    const work = await mkdtemp(join(deps.cacheDir, 'build-'));
    try {
      const staged = join(work, BUNDLE);
      await mkdir(join(staged, 'Contents', 'MacOS'), { recursive: true });
      await cp(join(SOURCE_DIR, 'Info.plist'), join(staged, 'Contents', 'Info.plist'));
      const compiled = await run('/usr/bin/xcrun', ['swiftc', '-O', join(SOURCE_DIR, 'transcribe.swift'), '-o', join(staged, 'Contents', 'MacOS', 'transcribe')], 240_000);
      if (compiled.code !== 0) {
        deps.log.warn('voice.build_failed', { stderr: compiled.stderr.slice(0, 2000) });
        broken = 'The speech helper could not be compiled with Swift on this Mac (see the server log). See docs/voice.md for whisper.cpp.';
        throw unavailable(broken);
      }
      await run('/usr/bin/codesign', ['-s', '-', '-f', '--identifier', 'com.conduit.voice', staged], 60_000);
      await mkdir(join(deps.cacheDir, hash), { recursive: true, mode: 0o700 });
      await rm(app, { recursive: true, force: true });
      await rename(staged, app);
      deps.log.info('voice.built', { app });
      return app;
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  /** Starts the helper as its own app and waits for it to write its answer. */
  async function ask(args: readonly string[], timeoutMs: number): Promise<Record<string, unknown>> {
    if (deps.command !== undefined && deps.command !== null) return asked(deps.command, args, timeoutMs);
    const app = await bundle();
    await mkdir(deps.workDir, { recursive: true, mode: 0o700 });
    await chmod(deps.workDir, 0o700).catch(() => undefined);
    const dir = await mkdtemp(join(deps.workDir, 'ask-'));
    const out = join(dir, 'answer.json');
    try {
      const started = await run('/usr/bin/open', ['-W', '-n', '-a', app, '--args', ...args, '--out', out], timeoutMs).catch((cause: unknown) => {
        throw unavailable('The speech helper could not be started.', cause);
      });
      let text: string;
      try {
        text = await readFile(out, 'utf8');
      } catch {
        deps.log.warn('voice.helper_silent', { code: started.code, stderr: started.stderr.slice(0, 500) });
        throw unavailable('The speech helper stopped without an answer. Check System Settings > Privacy & Security > Speech Recognition, or run `pnpm voice-check`.');
      }
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null) throw unavailable('The speech helper gave an answer that could not be read.');
      return parsed as Record<string, unknown>;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** The owner's own command: one JSON line on its stdout. */
  async function asked(command: string, args: readonly string[], timeoutMs: number): Promise<Record<string, unknown>> {
    const result = await run(command, args, timeoutMs).catch((cause: unknown) => {
      throw unavailable('The voice command set in VOICE_COMMAND could not be started.', cause);
    });
    const line = result.stdout.trim().split('\n').filter((part) => part.startsWith('{')).pop();
    if (line === undefined) throw unavailable('The voice command set in VOICE_COMMAND gave no answer.');
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== 'object' || parsed === null) throw unavailable('The voice command gave an answer that could not be read.');
    return parsed as Record<string, unknown>;
  }

  const localeArgs = (locale: string | null): string[] => (locale === null ? [] : ['--locale', locale]);

  return {
    async status(locale): Promise<HelperStatus> {
      const answer = await ask(['status', ...localeArgs(locale)], 30_000);
      return answer as unknown as HelperStatus;
    },

    async authorize(locale, waitSeconds): Promise<HelperStatus> {
      return (await ask(['authorize', ...localeArgs(locale), '--wait', String(waitSeconds)], (waitSeconds + 60) * 1000)) as unknown as HelperStatus;
    },

    async read(file, options): Promise<Reading> {
      const answer = await ask(['run', file, ...localeArgs(options.locale), '--max', String(options.maxSeconds), '--wait', '40'], 10 * 60_000);
      if (answer['ok'] === true && typeof answer['text'] === 'string') {
        return { ok: true, text: answer['text'], seconds: Number(answer['seconds'] ?? 0), recogniser: 'on-device', locale: String(answer['locale'] ?? '') };
      }
      return { ok: false, code: String(answer['code'] ?? 'failed'), message: String(answer['message'] ?? 'The recording could not be read.') };
    },
  };
}
