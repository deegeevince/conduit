// `pnpm art fill`: the shelf, filled ahead of time (PLAN-art.md, section 6; step 8). A subject the shelf lacks costs a child a minute or two of
// waiting the first time the brain draws it; this commissions the commonest ones in advance, through the studio's own code path (the same prompt,
// maker, converter, validation and sheet as a live miss), one at a time, and stops when the usage throttle says so or on Ctrl-C.
//
// The list is a text file: one subject a line, `subject` or `subject | pose`; `#` starts a comment.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../log';
import type { Throttle } from '../usage';
import { commissionOf, createStudio } from './studio';
import type { ArtPolicy, Commission, Maker, Studio } from './studio';
import { normaliseSubject, wantedIn } from './shelf';
import type { Shelf } from './shelf';
import type { Sheet } from './sheet';

export interface Want {
  /** the words as listed */
  readonly words: string;
  /** the shelf's name for the subject */
  readonly subject: string;
  readonly pose: string | null;
  readonly commission: Commission;
}

/** Reads the list. A line that names no subject is left out. */
export function parseList(text: string): Want[] {
  const out: Want[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (line === '') continue;
    const [words = '', detail = ''] = line.split('|').map((part) => part.trim());
    const subject = normaliseSubject(words);
    if (subject === '') continue;
    const want = wantedIn(detail);
    out.push({ words, subject, pose: want.pose, commission: commissionOf(subject, words, want, detail) });
  }
  return out;
}

/** Whether the shelf already holds what this entry would make: the subject, and its pose when one was listed. */
export function onShelf(shelf: Shelf, want: Want): boolean {
  const found = shelf.find(want.subject, { pose: want.pose, view: want.commission.view });
  return found !== null && found.sheets.length > 0 && found.subject === want.subject && (want.pose === null || found.poseMatch);
}

/** What a real commission of this kind costs and takes (arm B, Fable at high effort): the bake-off's figures. */
export const PER_DRAWING = { usdLow: 0.15, usdHigh: 0.5, secondsLow: 40, secondsHigh: 130 } as const;

export interface Projection {
  readonly listed: number;
  readonly onShelf: number;
  readonly toMake: readonly Want[];
  readonly usd: { readonly low: number; readonly high: number };
  readonly seconds: { readonly low: number; readonly high: number };
}

export function project(wants: readonly Want[], shelf: Shelf, max: number): Projection {
  const missing = wants.filter((want, at) => !onShelf(shelf, want) && wants.findIndex((other) => other.commission.key === want.commission.key) === at);
  const toMake = missing.slice(0, max);
  const n = toMake.length;
  return { listed: wants.length, onShelf: wants.length - missing.length, toMake, usd: { low: n * PER_DRAWING.usdLow, high: n * PER_DRAWING.usdHigh }, seconds: { low: n * PER_DRAWING.secondsLow, high: n * PER_DRAWING.secondsHigh } };
}

const minutes = (seconds: number): string => (seconds >= 3600 ? `${(seconds / 3600).toFixed(1)} h` : `${Math.round(seconds / 60)} min`);

export function describeProjection(p: Projection): string {
  const lines = [`${p.listed} listed, ${p.onShelf} already on the shelf, ${p.toMake.length} to commission`];
  for (const want of p.toMake) lines.push(`  ${want.commission.key}${want.words === want.subject ? '' : `  (${want.words})`}`);
  lines.push(`projected: ${minutes(p.seconds.low)} to ${minutes(p.seconds.high)} one at a time; $${p.usd.low.toFixed(2)} to $${p.usd.high.toFixed(2)} (cost-equivalent on the owner's own login, at about $${PER_DRAWING.usdLow.toFixed(2)} to $${PER_DRAWING.usdHigh.toFixed(2)} and ${PER_DRAWING.secondsLow} to ${PER_DRAWING.secondsHigh} s a drawing)`);
  return lines.join('\n');
}

/** The file a seed sheet is kept in: as `pnpm art import` names it (`fox-sitting-b.json`), with the view when it is not the side. */
export function seedName(sheet: Sheet): string {
  return `${[sheet.subject, sheet.pose, sheet.view === 'side' ? '' : sheet.view, sheet.made.arm.toLowerCase()].filter((part) => part !== '').join('-')}.json`;
}

/** A shelf that also writes each sheet it is given into the repository's seed folder, as the existing seeds are written. */
export function seedingShelf(inner: Shelf, seedDir: string, written: (file: string) => void): Shelf {
  return {
    find: (subject, want) => inner.find(subject, want),
    subjects: () => inner.subjects(),
    count: () => inner.count(),
    async write(sheet) {
      mkdirSync(seedDir, { recursive: true });
      const file = join(seedDir, seedName(sheet));
      writeFileSync(file, `${JSON.stringify(sheet, null, 1)}\n`);
      written(file);
      await inner.write(sheet);
    },
  };
}

export interface FillResult {
  readonly made: readonly { readonly key: string; readonly parts: number; readonly seconds: number; readonly usd: number | null }[];
  readonly failed: readonly { readonly key: string; readonly why: string }[];
  /** why it stopped before the end of the list, if it did */
  readonly stopped: string | null;
}

export interface FillDeps {
  readonly shelf: Shelf;
  readonly maker: Maker;
  readonly throttle: Throttle;
  readonly log: Logger;
  readonly now: () => number;
  readonly say: (text: string) => void;
  /** set by Ctrl-C: finish nothing new, abandon the drawing in hand, keep what is done */
  readonly interrupted: () => boolean;
  readonly onStudio?: (studio: Studio) => void;
}

/** Commissions each of `wants` in turn through the studio, waiting for each. Three failures in a row stop it. */
export async function fill(wants: readonly Want[], deps: FillDeps): Promise<FillResult> {
  const { shelf, maker, throttle, log, now, say } = deps;
  const policy: ArtPolicy = { maker: 'one', perHour: 100_000, callMs: 300_000, fakeMs: 0, eyesPort: 0, fakeStages: false };
  const studio = createStudio({ policy, shelf, maker, throttle, log, now });
  deps.onStudio?.(studio);
  const made: { key: string; parts: number; seconds: number; usd: number | null }[] = [];
  const failed: { key: string; why: string }[] = [];
  let stopped: string | null = null;
  let streak = 0;
  for (const [at, want] of wants.entries()) {
    if (deps.interrupted()) {
      stopped = 'interrupted';
      break;
    }
    const state = throttle.state(now());
    if (state === 'near' || state === 'over') {
      stopped = 'the usage throttle says near the cap: run it again later';
      break;
    }
    const key = want.commission.key;
    say(`[${at + 1}/${wants.length}] ${key} ...`);
    const result = await new Promise<{ ok: true; sheet: Sheet; ms: number; usd: number | null } | { ok: false; why: string }>((resolve) => {
      const accepted = studio.commission(want.commission, (event) => {
        if (event.kind === 'made') resolve({ ok: true, sheet: event.sheet, ms: event.ms, usd: event.usd });
        else if (event.kind === 'failed') resolve({ ok: false, why: event.why });
      });
      if (!accepted.ok) resolve({ ok: false, why: accepted.why });
    });
    if (result.ok) {
      streak = 0;
      made.push({ key, parts: result.sheet.parts.length, seconds: Math.round(result.ms / 100) / 10, usd: result.usd });
      say(`      made: ${result.sheet.parts.length} parts, ${(result.ms / 1000).toFixed(0)} s${result.usd === null ? '' : `, $${result.usd.toFixed(2)}`}`);
    } else {
      failed.push({ key, why: result.why });
      say(`      not made: ${result.why}`);
      if (deps.interrupted()) {
        stopped = 'interrupted';
        break;
      }
      streak += 1;
      if (streak >= 3) {
        stopped = 'three drawings in a row failed';
        break;
      }
    }
  }
  studio.stop();
  return { made, failed, stopped };
}
