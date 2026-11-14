// How far the judge agrees with the owner. Not part of the server.
// Usage: pnpm taste          the agreement over every sheet in explore/taste/, and the answers where the two eyes differ
// The sheets are made on the taste page (/taste.html), which is not built yet (PLAN-v2.md, package Q).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agreementLine, agreementOf } from '@conduit/language';
import type { TasteSheet } from '@conduit/language';
import { loadEnv, processEnvironment } from '../env';

const env = loadEnv({ ...processEnvironment(), BRAIN: 'replay', LIBRARY: 'none' });
const dir = join(env.exploreDir, 'taste');
const sheets: TasteSheet[] = existsSync(dir)
  ? readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as TasteSheet)
  : [];
const found = agreementOf(sheets);
process.stdout.write(`${agreementLine(found)}\n`);
if (found !== null) {
  for (const [family, share] of Object.entries(found.byFamily)) process.stdout.write(`  ${family.padEnd(12)} ${Math.round(share * 100)}%\n`);
  for (const miss of found.missed) process.stdout.write(`  differs: ${miss.answer}  judge ${miss.judge}, owner ${miss.up ? 'up' : 'down'}${miss.word === '' ? '' : ` ("${miss.word}")`}\n`);
}
