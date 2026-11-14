// Fetch a few pictures for real and print their credits: `PICTURES_DIR=/tmp/x pnpm exec tsx src/pictures/samples.ts "mountain lake" "city skyline night:1.78"`.
// Words, then an optional `:aspect`. Makes one request to Openverse per argument, paced.

import { creditLine } from '../domain/pictures';
import { createLogger } from '../log';
import { createPictures, readPictureSettings } from './registry';

const { settings } = readPictureSettings((name) => (name === 'PICTURES' ? 'openverse' : process.env[name]), `${process.env['TMPDIR'] ?? '/tmp'}/conduit-pictures`);
const service = createPictures(settings, createLogger('debug'));
for (const arg of process.argv.slice(2)) {
  const [words = '', aspect] = arg.split(':');
  const picture = await service.find({ words, aspect: aspect === undefined ? null : Number(aspect) }, AbortSignal.timeout(90_000));
  console.log(picture === null ? `${arg}: none` : `${arg}: ${settings.cacheDir}/${picture.key}.jpg ${picture.width}x${picture.height} ${picture.bytes.length}B\n  ${creditLine(picture.credit)}\n  ${picture.credit.landingUrl}`);
}
