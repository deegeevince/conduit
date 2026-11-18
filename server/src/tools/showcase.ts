// `pnpm showcase <what>`: the capability catalogue's tools. `reel` builds "What Conduit can do" as one film from the table and the pages; no model is called.
//
//   pnpm showcase reel [--out <dir>] [--only opening,ask,words,...,close] [--photo <file>] [--no-stills]
//   pnpm showcase reel --print            the whole reel as one .series text, in chapters (to stdout, and to <dir>/reel.series with --out)
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReel, printReel, reelPlan, stillsOf, summary, writeStills } from './showcase-reel';

const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};

async function reel(): Promise<number> {
  const photo = arg('--photo') ?? null;
  const plan = reelPlan({ photo });
  const dir = arg('--out') ?? join(tmpdir(), 'conduit-reel');
  if (process.argv.includes('--print')) {
    const text = printReel(plan);
    process.stdout.write(text);
    if (arg('--out') !== undefined) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'reel.series'), text);
    }
    return 0;
  }
  const only = arg('--only')?.split(',').map((part) => part.trim());
  const built = await buildReel(plan, dir, { ...(only === undefined ? {} : { only }), note: (text) => process.stdout.write(`${text}\n`) });
  for (const line of summary(built, plan)) process.stdout.write(`${line}\n`);
  if (!process.argv.includes('--no-stills')) {
    const stills = stillsOf(built);
    const sheets = await writeStills(built.file, stills, join(dir, 'stills'));
    process.stdout.write(`stills: ${stills.length} in ${join(dir, 'stills')}; contact sheets ${sheets.join(', ')}\n`);
  }
  return built.seconds >= 60 && built.seconds <= 90 ? 0 : 1;
}

const what = process.argv[2];
if (what === 'reel') {
  reel().then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`showcase reel: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      process.exit(2);
    },
  );
} else {
  process.stderr.write('usage: pnpm showcase reel [--out <dir>] [--only <sections>] [--photo <file>] [--print] [--no-stills]\n');
  process.exit(2);
}
