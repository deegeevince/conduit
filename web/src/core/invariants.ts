// The invariants, as rules over a census. Report-only: each returns violations and nothing acts on them.
// The witness is not the accused: it reads the painter's published views and plan and the resting picture, and shares no code with the
// layout or the timeline. Rules for later packages (taught is drawn, pure, shell, same score, budget) are not here.

import { evalExpr, hasValues, parseTemplate } from '@conduit/language';
import type { Rule, Severity, Violation } from '../../../language/src/loop';
import type { Box } from '../contracts/space';
import { audienceBar, targetFor } from './contracts';
import { INKED_KINDS, intersection, takeCensus } from './census';
import type { Census, CensusInput, Expected, Leaf } from './census';

/** The smallest text that reads, by screen: one table, the steward's to change. CSS pixels on the screen. */
export const LEGIBLE = { floor: { phone: 11, desk: 12 }, contrast: 4.5 } as const;
/** The lens, starting values: the smallest the body text may be fitted to, as a share of its size, by screen; and the most a person may zoom in. */
export const VIEW = { floor: { phone: 0.8, desk: 0.6 }, max: 4 } as const;
/** A finger needs this much, in points. */
export const TARGET = 44;
/** Ink below this share of a leaf's box is no ink. */
const NO_INK = 0.002;
/** Words over words: overlap beyond this share of the smaller box is a fault; a sliver is not. */
const OVERLAP = 0.12;
const WHOLE = 0.5;
/** A box that is somewhere else at rest than where play left it, by more than this, is a jump the eye sees (CSS pixels). */
const JUMP = 24;

const isPhone = (census: Census): boolean => census.screen.width <= 600;

function violation(census: Census, rule: Rule, severity: Severity, keys: readonly string[], detail: string, box: Box | null): Violation {
  return { rule, severity, at: census.at, keys: keys.slice(0, 4), detail, box: box === null ? null : { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) } };
}

const area = (box: Box): number => Math.max(0, box.width) * Math.max(0, box.height);
const label = (leaf: Leaf): string => `${leaf.id} (${leaf.kind}${leaf.text === '' ? '' : ` "${leaf.text.slice(0, 28)}"`})`;

/** present: every leaf the script holds has a box with area and, in the picture, ink that is not the ground. Only at rest, where it is promised. */
export function present(census: Census): Violation[] {
  const found: Violation[] = [];
  if (census.expected === null) return found;
  const byKey = new Map(census.leaves.map((leaf) => [leaf.key, leaf]));
  for (const held of census.expected) {
    if (!INKED_KINDS.includes(held.kind)) continue;
    if (held.kind === 'text' && held.text.trim() === '') continue;
    const name = `${held.id} (${held.kind}${held.text === '' ? '' : ` "${held.text.slice(0, 28)}"`})`;
    const leaf = byKey.get(held.key);
    if (leaf === undefined) {
      found.push(violation(census, 'present', 'fault', [held.key], `the script holds ${name}, and nothing of it is on stage`, null));
    } else if (leaf.opacity < WHOLE) {
      found.push(violation(census, 'present', 'fault', [held.key], `${name} is on stage at ${leaf.opacity.toFixed(2)} opacity at rest`, leaf.box));
    } else if (area(leaf.box) < 4) {
      found.push(violation(census, 'present', 'fault', [held.key], `${name} has no area (${Math.round(leaf.box.width)} by ${Math.round(leaf.box.height)})`, leaf.box));
    } else if (leaf.ink !== null && leaf.ink < NO_INK && area(leaf.box) >= 100) {
      found.push(violation(census, 'present', 'fault', [held.key], `${name} has a box and no ink in the picture (${(leaf.ink * 100).toFixed(2)}% of ${Math.round(leaf.box.width)} by ${Math.round(leaf.box.height)} is not the ground)`, leaf.box));
    }
  }
  return found;
}

/** inside: no box outside the screen, or outside the stage's own regions, bar a declared bleed (the far and background layers). */
export function inside(census: Census): Violation[] {
  const found: Violation[] = [];
  const screen: Box = { x: 0, y: 0, width: census.screen.width, height: census.screen.height };
  for (const leaf of census.leaves) {
    // art drawn by coordinates (shapes, pixel art) may run off the glass on purpose: the bleed the plan declares
    if (leaf.opacity < WHOLE || leaf.layer === 'far' || leaf.layer === 'bg' || leaf.kind === 'shape' || leaf.kind === 'sprite' || area(leaf.box) < 4) continue;
    const slack = 2;
    const out = Math.max(screen.x - leaf.box.x, screen.y - leaf.box.y, leaf.box.x + leaf.box.width - screen.width, leaf.box.y + leaf.box.height - screen.height);
    if (out > slack) found.push(violation(census, 'inside', 'fault', [leaf.key], `${label(leaf)} reaches ${Math.round(out)} px outside the screen`, leaf.box));
  }
  return found;
}

const WORDY: readonly string[] = ['text', 'control'];
const READ_BOXED: readonly string[] = ['text', 'control', 'node', 'structure'];

/** apart: no words over words (a control's label counts as words). Inside a canvas an overlap is the brain's: a note, not a fault. */
export function apart(census: Census): Violation[] {
  const found: Violation[] = [];
  const reading = census.leaves.filter((leaf) => leaf.opacity >= WHOLE && READ_BOXED.includes(leaf.kind) && (leaf.kind === 'node' || leaf.kind === 'structure' || leaf.text.trim() !== '' || leaf.kind === 'control') && area(leaf.box) >= 16);
  for (let i = 0; i < reading.length; i += 1) {
    for (let j = i + 1; j < reading.length; j += 1) {
      const a = reading[i];
      const b = reading[j];
      if (a === undefined || b === undefined) continue;
      // words over words, and a control over a table, a chart or a diagram (a structure's room is its own: a control's label may not stand in it)
      const wordsOnWords = WORDY.includes(a.kind) && WORDY.includes(b.kind);
      const controlOnStructure = (a.kind === 'control' && b.kind === 'structure') || (a.kind === 'structure' && b.kind === 'control');
      if (!wordsOnWords && !controlOnStructure) continue;
      const meet = intersection(a.box, b.box);
      if (meet === null) continue;
      const share = area(meet) / Math.min(area(a.box), area(b.box));
      if (share < OVERLAP) continue;
      const brains = a.inCanvas && b.inCanvas;
      found.push(violation(census, 'apart', brains ? 'note' : 'fault', [a.key, b.key], `${label(a)} and ${label(b)} overlap by ${Math.round(share * 100)}% of the smaller${brains ? ' (placed by coordinates in a canvas)' : ''}`, meet));
    }
  }
  return found;
}

/** legible: text at or above the floor for the screen, and 4.5 against what is behind it. */
export function legible(census: Census): Violation[] {
  const found: Violation[] = [];
  const floor = audienceBar(census.screen.audience ?? 'adult', isPhone(census)).floor;
  for (const leaf of census.leaves) {
    if (leaf.kind !== 'text' || leaf.text.trim() === '' || leaf.opacity < WHOLE || leaf.phase !== 'on') continue;
    if (leaf.fontPx > 0 && leaf.fontPx < floor) found.push(violation(census, 'legible', 'fault', [leaf.key], `${label(leaf)} is ${leaf.fontPx.toFixed(1)} px, under the ${floor} px floor`, leaf.box));
    if (leaf.contrast > 0 && leaf.contrast < LEGIBLE.contrast) found.push(violation(census, 'legible', 'fault', [leaf.key], `${label(leaf)} reads at ${leaf.contrast.toFixed(2)}:1 against what is behind it (needs ${LEGIBLE.contrast})`, leaf.box));
  }
  return found;
}

/**
 * reachable: every tappable region at least 44 points. A note, not a fault, until the census holds each leaf's hit region: the box here is the
 * words' own, and the painter may take a tap in a wider one.
 */
export function reachable(census: Census): Violation[] {
  const found: Violation[] = [];
  for (const leaf of census.leaves) {
    if (!leaf.tappable || leaf.opacity < WHOLE || leaf.phase !== 'on') continue;
    const short = Math.min(leaf.box.width, leaf.box.height);
    const target = targetFor(census.screen.audience ?? 'adult', census.screen.pointer);
    if (short < target) found.push(violation(census, 'reachable', 'note', [leaf.key], `${label(leaf)} can be tapped and is ${Math.round(short)} points across (a finger needs ${target})`, leaf.box));
  }
  return found;
}

/**
 * steady: nothing entering, leaving or struck at rest; and no jump: what was whole when play ended is still whole at rest, where it was.
 * `end` is the census of the last instant of play, `rest` the resting one.
 */
export function steady(rest: Census, end: Census | null): Violation[] {
  const found: Violation[] = [];
  for (const leaf of rest.leaves) {
    if (leaf.opacity >= WHOLE && leaf.phase !== 'on') found.push(violation(rest, 'steady', 'fault', [leaf.key], `${label(leaf)} is ${leaf.phase} at rest`, leaf.box));
  }
  for (const held of rest.expected ?? []) {
    if (held.struck && INKED_KINDS.includes(held.kind)) found.push(violation(rest, 'steady', 'fault', [held.key], `${held.id} (${held.kind} "${held.text.slice(0, 28)}") is carried struck through at rest`, null));
  }
  if (end !== null) {
    const there = new Map(rest.leaves.map((leaf) => [leaf.key, leaf]));
    for (const before of end.leaves) {
      if (before.opacity < WHOLE || !INKED_KINDS.includes(before.kind) || before.phase !== 'on') continue;
      // what a hand reads and works; art drawn in a group may be re-placed by its own layout without the eye taking it for a jump
      const read = before.kind !== 'shape' && before.kind !== 'sprite';
      const after = there.get(before.key);
      if (after === undefined || after.opacity < WHOLE) {
        found.push(violation(rest, 'steady', 'fault', [before.key], `${label(before)} was whole when play ended and is ${after === undefined ? 'gone' : `at ${after.opacity.toFixed(2)}`} at rest`, before.box));
      } else if (read && (Math.abs(after.box.x - before.box.x) > JUMP || Math.abs(after.box.y - before.box.y) > JUMP)) {
        found.push(violation(rest, 'steady', 'note', [before.key], `${label(before)} moved ${Math.round(Math.hypot(after.box.x - before.box.x, after.box.y - before.box.y))} px between the end of play and rest`, after.box));
      }
    }
  }
  return found;
}

function numbersIn(text: string): number[] {
  return [...text.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)].map((match) => Number((match[0] ?? '').replace(/,/g, ''))).filter((value) => Number.isFinite(value));
}

function domainOf(control: NonNullable<Expected['control']>): number[] {
  if (control.kind === 'toggle') return [0, 1];
  if (control.kind === 'pick') return control.options.map((_, index) => index + 1);
  if (control.kind !== 'slider') return [];
  const step = control.step !== null && control.step > 0 ? control.step : Math.max((control.max - control.min) / 20, 1e-6);
  const values: number[] = [];
  for (let value = control.min; value <= control.max + 1e-9 && values.length < 200; value += step) values.push(value);
  return values;
}

/**
 * spoiler, as today's frames can know it: the choices open on stage are the answers on offer. A readout the child can bring to one of
 * them (a `{expression}` of a slider she can slide, a toggle, a pick) gives the answer away before it is tried; so does a plain word of
 * the stage that is one. Blocking by rule. (The real rule, with accepted answers from `ask`, is WS3's; this is its shadow.)
 */
export function spoiler(census: Census): Violation[] {
  const found: Violation[] = [];
  if (census.expected === null) return found;
  const open = census.leaves.filter((leaf) => leaf.kind === 'text' && leaf.tappable && leaf.opacity >= WHOLE);
  const offered = open.flatMap((leaf) => numbersIn(leaf.text).map((value) => ({ value, leaf })));
  if (offered.length === 0) return found;
  const controls = census.expected.filter((held) => held.control !== null);
  const known = new Set(controls.map((held) => held.id));
  for (const held of census.expected) {
    if (held.kind !== 'text' || held.text === '' || open.some((leaf) => leaf.key === held.key)) continue;
    const parts = parseTemplate(held.text, (name) => known.has(name));
    if (hasValues(parts)) {
      const names = [...new Set(parts.flatMap((part) => (part.kind === 'value' ? [...(part.source.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])].filter((name) => known.has(name)) : [])))];
      const domains = names.map((name) => domainOf(controls.find((one) => one.id === name)?.control ?? { kind: 'none', min: 0, max: 0, step: null, options: [] }));
      let combos: Record<string, number>[] = [{}];
      names.forEach((name, index) => {
        combos = combos.flatMap((scope) => (domains[index] ?? []).map((value) => ({ ...scope, [name]: value }))).slice(0, 600);
      });
      let hit: string | null = null;
      for (const part of parts) {
        if (part.kind !== 'value' || hit !== null) continue;
        for (const scope of combos) {
          const value = evalExpr(part.expr, scope);
          const match = offered.find((one) => Number.isFinite(value) && Math.abs(one.value - value) < 1e-9);
          if (match !== undefined) {
            hit = `${part.source} reaches ${match.value} (at ${Object.entries(scope).map(([name, at]) => `${name}=${at}`).join(', ') || 'rest'}) while the choice "${match.leaf.text}" is open`;
            break;
          }
        }
      }
      if (hit !== null) found.push(violation(census, 'spoiler', 'blocking', [held.key], `${held.id} gives the answer away before it is tried: ${hit}`, census.leaves.find((leaf) => leaf.key === held.key)?.box ?? null));
    } else {
      const shown = numbersIn(held.text);
      const match = offered.find((one) => shown.includes(one.value));
      if (match !== undefined) found.push(violation(census, 'spoiler', 'blocking', [held.key], `${held.id} ("${held.text.slice(0, 40)}") holds ${match.value}, which is one of the open choices`, census.leaves.find((leaf) => leaf.key === held.key)?.box ?? null));
    }
  }
  return found;
}

/** Every rule that can be read at one moment of play: where nothing is promised yet, only the ones that hold while things move. */
export function checkPlay(census: Census): Violation[] {
  return [...inside(census), ...apart(census), ...legible(census), ...reachable(census)];
}

/** Every rule, at rest. `end` is the census at the last instant of play, for the jump check. */
export function checkRest(census: Census, end: Census | null): Violation[] {
  return [...present(census), ...inside(census), ...apart(census), ...legible(census), ...reachable(census), ...steady(census, end), ...spoiler(census)];
}

export interface WitnessInput {
  readonly rest: CensusInput;
  /** the census input at the last instant of play, and any ticks of play (every tenth second) */
  readonly end: CensusInput | null;
  readonly ticks: readonly CensusInput[];
}

/** The whole witness for one turn: what the hook on `report` will call. Pure. */
export function witness(input: WitnessInput): { readonly digest: string; readonly leaves: number; readonly violations: Violation[] } {
  const rest = takeCensus(input.rest);
  const end = input.end === null ? null : takeCensus(input.end);
  const ticks = input.ticks.map(takeCensus);
  const seen = new Set<string>();
  const violations = [...ticks.flatMap(checkPlay), ...checkRest(rest, end)].filter((one) => {
    const id = `${one.rule}|${one.at.kind}|${one.keys.join(',')}|${one.detail}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return { digest: rest.digest, leaves: rest.leaves.length, violations };
}
