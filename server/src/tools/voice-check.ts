// Is voice usable on this Mac, and the one step only the owner can do: allow Speech Recognition.
//
// Usage: pnpm voice-check                 builds the on-device helper if needed and says what state voice is in (asks for nothing)
//        pnpm voice-check --authorize     also asks macOS for permission: a dialog appears on this Mac's screen; click Allow (waits 2 minutes)
//        pnpm voice-check <audio file>    reads a recording (WAV, M4A, CAF, MP3, AIFF) and prints the words and which recogniser ran
//        [--locale en-US] [--data <dir>]
// Exit 0 when voice is ready (or the file was read), 1 when not. Nothing is sent anywhere; the audio is read where it is and not copied.
import { resolve } from 'node:path';
import { resolveDataPaths } from '../env';
import { withDataFlag } from '../data-dir';
import { createLogger } from '../log';
import { createAppleTranscriber } from '../voice/helper';
import { VOICE_LIMITS } from '@conduit/language';

const argv = process.argv.slice(2);
const data = resolveDataPaths(withDataFlag(argv, process.env));
const at = argv.indexOf('--locale');
const locale = at >= 0 ? (argv[at + 1] ?? null) : process.env['VOICE_LOCALE']?.trim() || null;
const file = argv.find((arg, i) => !arg.startsWith('--') && argv[i - 1] !== '--locale' && argv[i - 1] !== '--data' && argv[i - 1] !== '--from');
const transcriber = createAppleTranscriber({ cacheDir: data.voiceCache, workDir: `${data.voice}/work`, log: createLogger('info') });

async function main(): Promise<number> {
  if (argv.includes('--authorize')) {
    console.log('Asking macOS for Speech Recognition for "Conduit Voice". A dialog is on this Mac\'s screen: click Allow. Waiting up to 2 minutes...');
    const answer = await transcriber.authorize(locale, 120);
    console.log(JSON.stringify(answer));
    if (answer.ok !== true) {
      console.log(answer.message);
      return 1;
    }
  }
  const status = await transcriber.status(locale);
  console.log(JSON.stringify(status));
  if (file !== undefined) {
    const reading = await transcriber.read(resolve(process.env['INIT_CWD'] ?? '.', file), { locale, maxSeconds: VOICE_LIMITS.seconds });
    console.log(JSON.stringify(reading));
    return reading.ok ? 0 : 1;
  }
  if (status.permission === 'authorized' && status.onDevice === true && status.available === true) {
    console.log('Voice is ready: Speech Recognition is allowed and this language is recognised on the device.');
    return 0;
  }
  if (status.permission === 'not_determined') console.log('Not allowed yet. Run: pnpm voice-check --authorize   (then click Allow in the dialog on this Mac).');
  else if (status.permission === 'denied') console.log('Turned off. System Settings > Privacy & Security > Speech Recognition > switch on "Conduit Voice".');
  else if (status.onDevice !== true) console.log(`${status.locale ?? 'This language'} cannot be recognised on the device. Add it under System Settings > Keyboard > Dictation, or set VOICE_LOCALE.`);
  return 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
